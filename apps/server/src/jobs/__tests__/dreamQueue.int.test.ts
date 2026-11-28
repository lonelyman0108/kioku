import {
  CancelTaskResponse,
  ClearDreamQueueResponse,
  DREAM_QUEUE_LIMIT,
  InboxResponse,
  RebuildEmbeddingsResponse,
  RemoveQueuedDreamResponse,
  TriggerDreamResponse,
} from '@kioku/contracts'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import { embedEntryIds } from '../../embedding/worker'
import { EntryService } from '../../memory/service'
import {
  CHAT_LLM_SETTING_KEY,
  EMBEDDING_SETTING_KEY,
  recordDreamRun,
  saveModelEndpoint,
  updateDreamConfig,
} from '../../models/store'
import {
  consoleHeaders,
  createOwnerSession,
  createTestApp,
  entryInput,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'
import { FakeHttpError, startFakeOpenAi, type FakeOpenAiServer } from '../../testing/fakeOpenAi'
import { startJobs, type Jobs } from '../queue'

interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`)
}

async function clearPgBossJobs(database: Database): Promise<void> {
  await database.db.execute(sql`
    do $$
    begin
      if exists (
        select 1 from information_schema.tables
        where table_schema = 'pgboss' and table_name = 'job'
      ) then
        execute 'truncate table pgboss.job cascade';
      end if;
    end $$;
  `)
}

describe.skipIf(!testDatabaseUrl)('后台顺序整理队列、失败重试、熔断与向量独立通道', () => {
  let database: Database
  let fakeAi: FakeOpenAiServer
  let activeJobs: (Jobs & { stop: () => Promise<void> }) | null = null

  beforeAll(async () => {
    database = await openTestDatabase()
    fakeAi = await startFakeOpenAi()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    await clearPgBossJobs(database)
    fakeAi.requests.length = 0
  })

  afterEach(async () => {
    if (activeJobs) {
      await activeJobs.stop()
      activeJobs = null
    }
    await clearPgBossJobs(database)
  })

  afterAll(async () => {
    await fakeAi.close()
    await database.close()
  })

  async function bootStack(opts: { enableEmbedding?: boolean } = {}) {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })
    if (opts.enableEmbedding) {
      await saveModelEndpoint(database.db, masterKey, EMBEDDING_SETTING_KEY, {
        baseUrl: fakeAi.baseUrl,
        model: 'fake-embed-1024',
        apiKey: 'sk-embed',
        enabled: true,
      })
    }
    const jobs = await startJobs({
      connectionString: testDatabaseUrl!,
      db: database.db,
      masterKey,
      dreamPollingIntervalSeconds: 0.5,
    })
    activeJobs = jobs
    const app = createTestApp(database, { masterKey, jobs })
    const { cookie } = await createOwnerSession(database)
    const entrySvc = new EntryService(
      database.db,
      masterKey,
      new CredentialService(database.db, masterKey),
      null,
    )
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }
    return { masterKey, jobs, app, cookie, entrySvc, consoleScope }
  }

  it('支持 FIFO 顺序排队、签名去重、上限 5 项拦截、单项移出、清空队列与定时探测顺延', async () => {
    const { jobs, app, cookie, entrySvc, consoleScope } = await bootStack()

    const e1 = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '待规范记忆一（2026-10-01 记录）',
        content: '第一条测试记忆正文。',
        isPinned: true,
      }),
    )
    const e2 = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '待规范记忆二（2026-10-02 记录）',
        content: '第二条测试记忆正文。',
      }),
    )
    const e3 = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '待规范记忆三（2026-10-03 记录）',
        content: '第三条测试记忆正文。',
      }),
    )

    // 阻塞首个任务，以便确定性检验排队、去重、上限与移出/清空行为
    const firstEntered = createDeferred<void>()
    const releaseFirst = createDeferred<void>()
    let firstBlocked = true
    const observedChatModes: string[] = []

    fakeAi.setChatHandler(async (messages) => {
      const text = messages.map((m) => m.content).join('\n')
      if (firstBlocked) {
        firstBlocked = false
        firstEntered.resolve()
        await releaseFirst.promise
      }
      if (text.includes('needed')) {
        observedChatModes.push('tidy')
        return JSON.stringify({ needed: false })
      }
      observedChatModes.push('standard')
      return JSON.stringify({ suggestions: [] })
    })

    // 1) 启动第 1 项（增量整理）
    const r0 = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'standard' }),
        })
      ).json(),
    )
    expect(r0.started).toBe(true)
    expect(r0.status).toBe('started')
    expect(r0.position).toBe(0)
    expect(r0.jobId).toBeTruthy()
    await firstEntered.promise

    // 2) 运行中重复提交同签名任务必须被拒绝
    const dupActive = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'standard' }),
        })
      ).json(),
    )
    expect(dupActive.started).toBe(false)
    expect(dupActive.status).toBe('rejected')

    // 3) 依次排队 5 个不同签名的等待任务
    const queuedPayloads = [
      { mode: 'tidy', limit: 10, pinnedFirst: true },
      { mode: 'tidy', limit: 20, pinnedFirst: true },
      { mode: 'tidy', all: true, pinnedFirst: true },
      { mode: 'cross_memory', scope: 'full_corpus' },
      { mode: 'tidy', targetShortIds: [e1.entry.shortId] },
    ] as const

    const queuedIds: string[] = []
    for (let i = 0; i < queuedPayloads.length; i++) {
      const res = TriggerDreamResponse.parse(
        await (
          await app.request('/v1/console/dream/run', {
            method: 'POST',
            headers: consoleHeaders(cookie, true),
            body: JSON.stringify(queuedPayloads[i]),
          })
        ).json(),
      )
      expect(res.started).toBe(true)
      expect(res.status).toBe('queued')
      expect(res.position).toBe(i + 1)
      expect(res.jobId).toBeTruthy()
      queuedIds.push(res.jobId!)
    }

    // 4) 队列中重复签名（含短 ID 大小写归一化）必须拒绝
    const dupQueued = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [e1.entry.shortId.toUpperCase()] }),
        })
      ).json(),
    )
    expect(dupQueued.started).toBe(false)
    expect(dupQueued.status).toBe('rejected')

    // 5) 超过 5 项等待上限必须拒绝
    const overflow = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [e2.entry.shortId] }),
        })
      ).json(),
    )
    expect(overflow.started).toBe(false)
    expect(overflow.status).toBe('rejected')
    expect(overflow.reason).toContain(String(DREAM_QUEUE_LIMIT))

    // 6) 定时探测在手动任务运行/排队期间必须顺延、不得插队或污染队列
    await updateDreamConfig(database.db, {
      enabled: true,
      intervalHours: 1,
      tidy: { enabled: true, intervalHours: 1 },
    })
    expect(await jobs.triggerScheduledDreamProbe?.()).toBe(0)

    const inboxDuring = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    expect(inboxDuring.dreamState.running).toBe(true)
    expect(inboxDuring.dreamState.activeJobId).toBe(r0.jobId)
    expect(inboxDuring.dreamState.queueLimit).toBe(DREAM_QUEUE_LIMIT)
    expect(inboxDuring.dreamState.queued?.map((q) => q.id)).toEqual(queuedIds)

    // 7) 移出正在执行中的任务 ID 应返回 false；移出队列第 2 项应返回 true
    const rmActive = RemoveQueuedDreamResponse.parse(
      await (
        await app.request(`/v1/console/dream/queue/${r0.jobId}`, {
          method: 'DELETE',
          headers: consoleHeaders(cookie),
        })
      ).json(),
    )
    expect(rmActive.removed).toBe(false)

    const rmSecond = RemoveQueuedDreamResponse.parse(
      await (
        await app.request(`/v1/console/dream/queue/${queuedIds[1]}`, {
          method: 'DELETE',
          headers: consoleHeaders(cookie),
        })
      ).json(),
    )
    expect(rmSecond.removed).toBe(true)

    // 8) 清空剩余 4 项等待队列（不影响正在执行的 r0）
    const cleared = ClearDreamQueueResponse.parse(
      await (
        await app.request('/v1/console/dream/queue', {
          method: 'DELETE',
          headers: consoleHeaders(cookie),
        })
      ).json(),
    )
    expect(cleared.removed).toBe(4)

    // 9) 重新追加 2 项不同任务验证严格 FIFO 串行执行
    const q1 = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [e2.entry.shortId] }),
        })
      ).json(),
    )
    const q2 = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [e3.entry.shortId] }),
        })
      ).json(),
    )
    expect(q1.position).toBe(1)
    expect(q2.position).toBe(2)

    // 放行首个任务，等待整条 FIFO 队列全部串行完成
    releaseFirst.resolve()
    await waitFor(async () => {
      const snap = jobs.getDreamQueueSnapshot?.()
      if (snap?.running || (snap?.queued.length ?? 0) > 0) return false
      const inbox = InboxResponse.parse(
        await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
      )
      return inbox.dreamState.recentRuns.length >= 3
    })

    const inboxDone = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    // recentRuns 按完成时间倒序：q2 最新，其次 q1，最早 r0
    const runIdsChrono = [...inboxDone.dreamState.recentRuns].reverse().map((r) => r.id)
    expect(runIdsChrono).toEqual([r0.jobId, q1.jobId, q2.jobId])
    expect(inboxDone.dreamState.recentRuns.find((r) => r.id === q1.jobId)?.params).toEqual({
      targetShortIds: [e2.entry.shortId],
    })
    expect(observedChatModes[0]).toBe('standard')
    expect(observedChatModes.slice(1)).toEqual(['tidy', 'tidy'])
  })

  it('手动取消当前任务后自动续跑队列下一项，并支持对已取消项按原参数重新发起', async () => {
    const { jobs, app, cookie, entrySvc, consoleScope } = await bootStack()

    const e1 = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '取消后重跑目标（2026-10-05 记录）',
        content: '用于验证取消后自动推进下一项并支持重新发起。',
      }),
    )
    const e2 = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '排队继任目标（2026-10-06 记录）',
        content: '前序任务取消后必须自动运行此任务。',
      }),
    )

    const firstEntered = createDeferred<void>()
    let blockOnce = true
    fakeAi.setChatHandler(async (messages) => {
      const text = messages.map((m) => m.content).join('\n')
      if (blockOnce && text.includes(e1.entry.shortId)) {
        blockOnce = false
        firstEntered.resolve()
        await new Promise((resolve) => setTimeout(resolve, 4_000))
      }
      return JSON.stringify({ needed: false })
    })

    const first = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [e1.entry.shortId] }),
        })
      ).json(),
    )
    await firstEntered.promise

    const second = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [e2.entry.shortId] }),
        })
      ).json(),
    )
    expect(second.status).toBe('queued')

    // 手动取消首个任务
    const cancelled = CancelTaskResponse.parse(
      await (
        await app.request('/v1/console/dream/cancel', {
          method: 'POST',
          headers: consoleHeaders(cookie),
        })
      ).json(),
    )
    expect(cancelled.cancelled).toBe(true)

    // 等待第 2 项自动续跑完成
    await waitFor(async () => {
      const inbox = InboxResponse.parse(
        await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
      )
      return (
        !inbox.dreamState.running &&
        inbox.dreamState.recentRuns.some((r) => r.id === second.jobId && r.outcome === 'ok')
      )
    })

    const inboxAfterCancel = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    const cancelledRun = inboxAfterCancel.dreamState.recentRuns.find((r) => r.id === first.jobId)
    expect(cancelledRun?.outcome).toBe('cancelled')
    expect(cancelledRun?.params).toEqual({ targetShortIds: [e1.entry.shortId] })

    // 重新发起已取消项：按原 params 精确重跑并向原记录回写 retriedByRunId
    const rerun = TriggerDreamResponse.parse(
      await (
        await app.request(`/v1/console/dream/runs/${first.jobId}/retry`, {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ scope: 'full' }),
        })
      ).json(),
    )
    expect(rerun.started).toBe(true)
    expect(rerun.jobId).toBeTruthy()

    await waitFor(async () => {
      const snap = jobs.getDreamQueueSnapshot?.()
      if (snap?.running) return false
      const inbox = InboxResponse.parse(
        await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
      )
      return inbox.dreamState.recentRuns.some((r) => r.id === rerun.jobId && r.outcome === 'ok')
    })

    const inboxFinal = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    expect(inboxFinal.dreamState.recentRuns.find((r) => r.id === first.jobId)?.retriedByRunId).toBe(
      rerun.jobId,
    )
  })

  it('部分失败与普通失败支持子集重试、整次重试与无 params 历史兜底，并回写 retriedByRunId', async () => {
    const { jobs, app, cookie, entrySvc, consoleScope } = await bootStack()

    const eOk = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '规范成功记忆（2026-10-08 记录）',
        content: '正常可规范的测试记忆。',
      }),
    )
    const eFail = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '规范失败记忆（2026-10-09 记录）',
        content: '首轮刻意返回坏 JSON 制造部分失败。',
      }),
    )

    // 先写入两条历史记录：1 条 partial 含 failedItems，1 条无 params 的旧版 failed 记录
    await recordDreamRun(database.db, {
      id: 'legacy-failed-no-params',
      trigger: 'manual',
      mode: 'standard',
      outcome: 'failed',
      considered: 2,
      suggested: 0,
      error: '旧版网关超时',
      createdAt: '2026-11-27T01:00:00.000Z',
    })
    await recordDreamRun(database.db, {
      id: 'partial-tidy-run',
      trigger: 'manual',
      mode: 'tidy',
      outcome: 'partial',
      considered: 2,
      suggested: 1,
      error: `本批 2 条中 1 条失败：${eFail.entry.shortId}`,
      params: { limit: 10, pinnedFirst: true },
      failedItems: [
        {
          shortId: eFail.entry.shortId,
          title: eFail.entry.title,
          kind: 'tidy',
          reason: '输出格式校验失败',
        },
      ],
      createdAt: '2026-11-27T02:00:00.000Z',
    })

    const retriedPrompts: string[] = []
    fakeAi.setChatHandler((messages) => {
      const prompt = messages.map((m) => m.content).join('\n')
      retriedPrompts.push(prompt)
      if (prompt.includes('needed')) {
        return JSON.stringify({ needed: false })
      }
      return JSON.stringify({ suggestions: [] })
    })

    // 1) 部分失败按 failed_only 仅重试失败短 ID，且同时排队旧历史整次重试
    const retryPartial = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/runs/partial-tidy-run/retry', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ scope: 'failed_only' }),
        })
      ).json(),
    )
    expect(retryPartial.started).toBe(true)
    expect(retryPartial.jobId).toBeTruthy()

    const retryLegacy = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/runs/legacy-failed-no-params/retry', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ scope: 'full' }),
        })
      ).json(),
    )
    expect(retryLegacy.started).toBe(true)
    expect(retryLegacy.jobId).toBeTruthy()

    await waitFor(async () => {
      const snap = jobs.getDreamQueueSnapshot?.()
      if (snap?.running || (snap?.queued.length ?? 0) > 0) return false
      const inbox = InboxResponse.parse(
        await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
      )
      return (
        inbox.dreamState.recentRuns.some((r) => r.id === retryPartial.jobId) &&
        inbox.dreamState.recentRuns.some((r) => r.id === retryLegacy.jobId)
      )
    })

    const inboxAfter = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    // 验证仅重试失败项时只传了 eFail、未传 eOk
    const tidyPrompts = retriedPrompts.filter((p) => p.includes('needed'))
    expect(tidyPrompts.some((p) => p.includes(eFail.entry.shortId))).toBe(true)
    expect(tidyPrompts.some((p) => p.includes(eOk.entry.shortId))).toBe(false)

    // 原历史记录均已回写 retriedByRunId
    expect(
      inboxAfter.dreamState.recentRuns.find((r) => r.id === 'partial-tidy-run')?.retriedByRunId,
    ).toBe(retryPartial.jobId)
    expect(
      inboxAfter.dreamState.recentRuns.find((r) => r.id === 'legacy-failed-no-params')
        ?.retriedByRunId,
    ).toBe(retryLegacy.jobId)

    // 验证普通失败 / 部分失败不会熔断后续队列，下一项照常执行
    const firstNonFatalEntered = createDeferred<void>()
    const releaseNonFatal = createDeferred<void>()
    let blockedNonFatal = true
    fakeAi.setChatHandler(async (messages) => {
      const prompt = messages.map((m) => m.content).join('\n')
      if (prompt.includes(eFail.entry.shortId)) {
        if (blockedNonFatal) {
          blockedNonFatal = false
          firstNonFatalEntered.resolve()
          await releaseNonFatal.promise
        }
        return '{invalid json'
      }
      return JSON.stringify({ needed: false })
    })

    const badJob = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [eFail.entry.shortId] }),
        })
      ).json(),
    )
    await firstNonFatalEntered.promise

    const followUpJob = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [eOk.entry.shortId] }),
        })
      ).json(),
    )
    expect(followUpJob.status).toBe('queued')

    releaseNonFatal.resolve()
    await waitFor(async () => {
      const snap = jobs.getDreamQueueSnapshot?.()
      if (snap?.running || (snap?.queued.length ?? 0) > 0) return false
      const inbox = InboxResponse.parse(
        await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
      )
      return (
        inbox.dreamState.recentRuns.some((r) => r.id === badJob.jobId) &&
        inbox.dreamState.recentRuns.some((r) => r.id === followUpJob.jobId)
      )
    })

    const inboxContinued = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    expect(inboxContinued.dreamState.recentRuns.find((r) => r.id === badJob.jobId)?.outcome).toBe(
      'failed',
    )
    expect(
      inboxContinued.dreamState.recentRuns.find((r) => r.id === followUpJob.jobId)?.outcome,
    ).toBe('ok')
  })

  it('前序任务命中致命上游故障（auth / quota）时自动中止并取消剩余等待队列', async () => {
    const { jobs, app, cookie, entrySvc, consoleScope } = await bootStack()

    const e1 = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '鉴权熔断记忆（2026-10-10 记录）',
        content: '触发 401 鉴权失败后应立即清空等待队列。',
      }),
    )
    const e2 = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '后续排队记忆一（2026-10-11 记录）',
        content: '不应再调用上游模型。',
      }),
    )
    const e3 = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '后续排队记忆二（2026-10-12 记录）',
        content: '同样应被自动中止。',
      }),
    )

    const authEntered = createDeferred<void>()
    const releaseAuth = createDeferred<void>()
    let chatCalls = 0

    fakeAi.setChatHandler(async () => {
      chatCalls++
      if (chatCalls === 1) {
        authEntered.resolve()
        await releaseAuth.promise
      }
      throw new FakeHttpError(401, 'invalid api key')
    })

    const r1 = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [e1.entry.shortId] }),
        })
      ).json(),
    )
    await authEntered.promise

    const r2 = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [e2.entry.shortId] }),
        })
      ).json(),
    )
    const r3 = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [e3.entry.shortId] }),
        })
      ).json(),
    )
    expect(r2.status).toBe('queued')
    expect(r3.status).toBe('queued')

    releaseAuth.resolve()

    await waitFor(async () => {
      const snap = jobs.getDreamQueueSnapshot?.()
      if (snap?.running || (snap?.queued.length ?? 0) > 0) return false
      const inbox = InboxResponse.parse(
        await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
      )
      return inbox.dreamState.recentRuns.some((r) => r.id === r3.jobId)
    })

    // 确认仅调用过 1 次模型接口，后续 2 项均未调用上游并被记为 cancelled（附中止原因）
    expect(chatCalls).toBe(1)
    const inbox = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    expect(inbox.dreamState.queued).toEqual([])
    expect(inbox.dreamState.lastOutcome).toBe('failed')
    expect(inbox.dreamState.lastError).toContain('401')
    expect(inbox.dreamState.recentRuns.find((r) => r.id === r1.jobId)?.outcome).toBe('failed')
    const aborted2 = inbox.dreamState.recentRuns.find((r) => r.id === r2.jobId)
    const aborted3 = inbox.dreamState.recentRuns.find((r) => r.id === r3.jobId)
    expect(aborted2?.outcome).toBe('cancelled')
    expect(aborted2?.abortedReason).toContain('上游故障')
    expect(aborted3?.outcome).toBe('cancelled')
    expect(aborted3?.abortedReason).toContain('上游故障')

    // 同样验证 quota（402 额度不足）熔断中止后续排队项
    const quotaEntered = createDeferred<void>()
    const releaseQuota = createDeferred<void>()
    let quotaCalls = 0
    fakeAi.setChatHandler(async () => {
      quotaCalls++
      if (quotaCalls === 1) {
        quotaEntered.resolve()
        await releaseQuota.promise
      }
      throw new FakeHttpError(402, 'insufficient balance: quota exceeded')
    })

    const q1 = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [e1.entry.shortId] }),
        })
      ).json(),
    )
    await quotaEntered.promise

    const q2 = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'tidy', targetShortIds: [e2.entry.shortId] }),
        })
      ).json(),
    )
    expect(q2.status).toBe('queued')

    releaseQuota.resolve()
    await waitFor(async () => {
      const snap = jobs.getDreamQueueSnapshot?.()
      if (snap?.running || (snap?.queued.length ?? 0) > 0) return false
      const inboxQuota = InboxResponse.parse(
        await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
      )
      return inboxQuota.dreamState.recentRuns.some((r) => r.id === q2.jobId)
    })

    expect(quotaCalls).toBe(1)
    const inboxQuota = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    expect(inboxQuota.dreamState.recentRuns.find((r) => r.id === q1.jobId)?.outcome).toBe('failed')
    expect(inboxQuota.dreamState.recentRuns.find((r) => r.id === q2.jobId)?.outcome).toBe(
      'cancelled',
    )
  })

  it('向量索引补齐独立于整理队列并行执行，且 missing=0 时不空发后台任务', async () => {
    const { masterKey, jobs, app, cookie, entrySvc, consoleScope } = await bootStack({
      enableEmbedding: true,
    })

    const e1 = await entrySvc.create(
      consoleScope,
      entryInput({ title: '已向量化记忆', content: '已有向量，测试 missing=0 不空发。' }),
    )
    await embedEntryIds(database.db, masterKey, [e1.entry.id])

    // 缺失数为 0 时接口返回 queued: 0 且绝不启动补齐任务
    const zeroRes = RebuildEmbeddingsResponse.parse(
      await (
        await app.request('/v1/console/settings/embedding/backfill', {
          method: 'POST',
          headers: consoleHeaders(cookie),
        })
      ).json(),
    )
    expect(zeroRes.queued).toBe(0)
    expect(jobs.getEmbeddingBackfillState?.().running).toBe(false)
    expect(jobs.getEmbeddingBackfillState?.().recentRuns ?? []).toHaveLength(0)

    // 再创建一条缺向量记忆，并在整理任务阻塞期间并行发起向量补齐
    await entrySvc.create(
      consoleScope,
      entryInput({ title: '待补齐记忆', content: '应在整理阻塞期间并行完成向量补齐。' }),
    )

    const dreamEntered = createDeferred<void>()
    const releaseDream = createDeferred<void>()
    fakeAi.setChatHandler(async () => {
      dreamEntered.resolve()
      await releaseDream.promise
      return JSON.stringify({ suggestions: [] })
    })

    const dreamRes = TriggerDreamResponse.parse(
      await (
        await app.request('/v1/console/dream/run', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ mode: 'standard' }),
        })
      ).json(),
    )
    expect(dreamRes.started).toBe(true)
    await dreamEntered.promise

    const backfillRes = RebuildEmbeddingsResponse.parse(
      await (
        await app.request('/v1/console/settings/embedding/backfill', {
          method: 'POST',
          headers: consoleHeaders(cookie),
        })
      ).json(),
    )
    expect(backfillRes.queued).toBe(1)

    // 整理任务仍在阻塞期间，向量补齐必须独立跑完
    await waitFor(() => {
      const bf = jobs.getEmbeddingBackfillState?.()
      return Boolean(bf && !bf.running && bf.lastOutcome === 'ok' && bf.lastUpdatedCount === 1)
    })
    expect(jobs.getDreamQueueSnapshot?.().running).toBe(true)

    releaseDream.resolve()
    await waitFor(() => !jobs.getDreamQueueSnapshot?.().running)
  })

  it('定时探测在队列空闲时按需入队执行，且服务启动时经 findJobs 水合残留队列镜像', async () => {
    const { masterKey, jobs, entrySvc, consoleScope } = await bootStack()
    const e1 = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '定时探测记忆（2026-10-15 记录）',
        content: '用于验证独立定时探测在空闲时自动入队执行。',
      }),
    )
    const e2 = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '重启水合记忆（2026-10-16 记录）',
        content: '用于验证服务重启时从 pg-boss 恢复未执行队列镜像。',
      }),
    )

    fakeAi.setChatHandler((messages) => {
      const text = messages.map((m) => m.content).join('\n')
      return text.includes('needed')
        ? JSON.stringify({ needed: false })
        : JSON.stringify({ suggestions: [] })
    })

    await updateDreamConfig(database.db, {
      enabled: true,
      intervalHours: 1,
      tidy: { enabled: false, intervalHours: 72 },
      crossMemory: { enabled: false, intervalHours: 168 },
    })

    // 队列空闲时定时探测应入队 1 项 standard 并顺利执行
    const scheduledCount = await jobs.triggerScheduledDreamProbe?.()
    expect(scheduledCount).toBe(1)
    await waitFor(() => {
      const snap = jobs.getDreamQueueSnapshot?.()
      return Boolean(snap && !snap.running && snap.queued.length === 0)
    })

    // 停止旧实例，向 pg-boss 写入 2 条未开始的整理任务后重启 startJobs，验证启动即水合镜像
    await jobs.stop()
    activeJobs = null

    const { PgBoss } = await import('pg-boss')
    const { pgBossConnection } = await import('../queue')
    const seeder = new PgBoss({
      ...(await pgBossConnection(testDatabaseUrl!)),
      schema: 'pgboss',
    })
    await seeder.start()
    const seeded1 = await seeder.send(
      'dream',
      { trigger: 'manual', mode: 'tidy', targetShortIds: [e1.entry.shortId] },
      { singletonKey: 'dream' },
    )
    const seeded2 = await seeder.send(
      'dream',
      { trigger: 'manual', mode: 'tidy', targetShortIds: [e2.entry.shortId] },
      { singletonKey: 'dream' },
    )
    await seeder.stop({ graceful: false })
    expect(seeded1).toBeTruthy()
    expect(seeded2).toBeTruthy()

    const firstHydratedEntered = createDeferred<void>()
    const releaseHydrated = createDeferred<void>()
    let blockHydrated = true
    fakeAi.setChatHandler(async () => {
      if (blockHydrated) {
        blockHydrated = false
        firstHydratedEntered.resolve()
        await releaseHydrated.promise
      }
      return JSON.stringify({ needed: false })
    })

    const restarted = await startJobs({
      connectionString: testDatabaseUrl!,
      db: database.db,
      masterKey,
      dreamPollingIntervalSeconds: 0.5,
    })
    activeJobs = restarted

    const hydratedSnap = restarted.getDreamQueueSnapshot?.()
    expect(hydratedSnap?.running).toBe(true)
    expect(hydratedSnap?.activeJobId).toBe(seeded1)
    expect(hydratedSnap?.queued.map((q) => q.id)).toEqual([seeded2])

    await firstHydratedEntered.promise
    releaseHydrated.resolve()
    await waitFor(() => {
      const snap = restarted.getDreamQueueSnapshot?.()
      return Boolean(snap && !snap.running && snap.queued.length === 0)
    })
  })
})
