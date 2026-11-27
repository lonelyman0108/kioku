import {
  ApplySuggestionResponse,
  EntryDetailResponse,
  InboxResponse,
  SingleCrossCheckResponse,
  SingleTidyApplyResponse,
  SingleTidyPreviewResponse,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import {
  apiKeys,
  dreamSuggestions,
  EMBEDDING_DIMENSIONS,
  entries,
  entryEmbeddings,
  turnBuffer,
} from '../../db/schema'
import type { Deps, KeyPrincipal } from '../../http/env'
import { EntryService } from '../../memory/service'
import { CHAT_LLM_SETTING_KEY, saveModelEndpoint } from '../../models/store'
import {
  consoleHeaders,
  createOwnerSession,
  createTestApp,
  entryInput,
  issueTestApiKey,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'
import { FakeHttpError, startFakeOpenAi, type FakeOpenAiServer } from '../../testing/fakeOpenAi'
import { bufferTurn } from '../buffer'
import { loadFrequentTopics, loadInbox, runDream } from '../dream'
import { extractEpisodeBatch } from '../extract'

describe.skipIf(!testDatabaseUrl)('对话缓冲抽取与 4 类 Dream 整理建议闭环', () => {
  let database: Database
  let fakeAi: FakeOpenAiServer

  beforeAll(async () => {
    database = await openTestDatabase()
    fakeAi = await startFakeOpenAi()
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await fakeAi.close()
    await database.close()
  })

  it('turn.end 跳过 cron/subagent，空维度落盘为空串并抽取 14 天有效会话摘要', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    fakeAi.setChatHandler(() =>
      JSON.stringify({
        title: '修复部署流水线',
        summary: '将镜像构建上下文改为 git archive 避免读入半成品产物。',
      }),
    )

    const key = await issueTestApiKey(database, {
      envs: ['mac'],
      allowedRealms: ['work'],
      canWrite: true,
    })
    const keyPrincipal: KeyPrincipal = {
      kind: 'key',
      keyId: key.id,
      name: 'Test Key',
      prefix: key.prefix,
      runtimeFamily: 'claudecode',
      envs: ['mac'],
      allowedRealms: ['work'],
      canWrite: true,
      canResolveCredentials: false,
    }
    const enqueued: { deviceKey: string; projectSlug: string; delay: number }[] = []
    const deps: Deps = {
      db: database.db,
      cookieSecure: false,
      masterKey,
      jobs: {
        enqueueEmbed: () => {},
        enqueueBackfill: async () => true,
        enqueueExtraction: async (target, delay) => {
          enqueued.push({ ...target, delay })
        },
        enqueueDream: async () => 'run-1',
        isDreamRunning: async () => false,
        enqueueCleanup: async () => true,
      },
    }

    // cron / subagent 跳过不缓冲
    expect(
      await bufferTurn(deps, keyPrincipal, {
        event: 'turn.end',
        sessionId: 's-cron',
        user: '定时任务',
        reply: '完成',
        context: { chatType: 'cron' },
      }),
    ).toBe(false)
    expect(
      await bufferTurn(deps, keyPrincipal, {
        event: 'turn.end',
        sessionId: 's-sub',
        user: '子代理',
        reply: '完成',
        context: { chatType: 'subagent' },
      }),
    ).toBe(false)

    // 正常轮次（不传 deviceKey 与 project）落盘为 '' 而非 null
    expect(
      await bufferTurn(deps, keyPrincipal, {
        event: 'turn.end',
        sessionId: 's-1',
        user: 'Docker build 读到了临时文件怎么办？',
        reply: '使用 git archive 打包已跟踪文件再传给 docker build。',
      }),
    ).toBe(true)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.deviceKey).toBe('')
    expect(enqueued[0]?.projectSlug).toBe('')

    const bufferedRows = await database.db.select().from(turnBuffer)
    expect(bufferedRows).toHaveLength(1)
    expect(bufferedRows[0]?.deviceKey).toBe('')
    expect(bufferedRows[0]?.projectSlug).toBe('')

    const entrySvc = new EntryService(
      database.db,
      masterKey,
      new CredentialService(database.db, masterKey),
      null,
    )
    const outcome = await extractEpisodeBatch(database.db, masterKey, entrySvc, {
      deviceKey: '',
      projectSlug: '',
    })
    expect(outcome.turns).toBe(1)
    expect(outcome.createdShortId).toMatch(/^m-/)

    // 缓冲已被清空，写入的 episode 带约 14 天 valid_to 且 device_key/project_slug 为 ''
    expect(await database.db.select().from(turnBuffer)).toHaveLength(0)
    const [ep] = await database.db.select().from(entries)
    expect(ep?.kind).toBe('episode')
    expect(ep?.deviceKey).toBe('')
    expect(ep?.projectSlug).toBe('')
    expect(ep?.validTo).not.toBeNull()
    const ttlDays = (ep!.validTo!.getTime() - ep!.createdAt.getTime()) / 86_400_000
    expect(ttlDays).toBeGreaterThan(13)
    expect(ttlDays).toBeLessThan(15)
    expect(ep?.realms).toEqual(['work'])
    expect(ep?.envs).toEqual(['mac'])
  })

  it('去抖窗口内原访问密钥被轮换或吊销时，抽取出的会话摘要仍保留原场域隔离而不降级为通用词条', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    fakeAi.setChatHandler(() =>
      JSON.stringify({
        title: '工作区内部排错',
        summary: '定位了内部集群证书过期原因。',
      }),
    )

    const workKey = await issueTestApiKey(database, {
      envs: ['linux'],
      allowedRealms: ['work'],
      canWrite: true,
    })
    const workPrincipal: KeyPrincipal = {
      kind: 'key',
      keyId: workKey.id,
      name: 'Work Key',
      prefix: workKey.prefix,
      runtimeFamily: 'claudecode',
      envs: ['linux'],
      allowedRealms: ['work'],
      canWrite: true,
      canResolveCredentials: false,
    }
    const deps: Deps = {
      db: database.db,
      cookieSecure: false,
      masterKey,
      jobs: null,
    }

    expect(
      await bufferTurn(deps, workPrincipal, {
        event: 'turn.end',
        sessionId: 's-rot',
        deviceKey: 'office-box',
        project: { repoName: 'internal-ops' },
        user: '集群证书为什么告警？',
        reply: '内部 CA 证书昨天到期。',
      }),
    ).toBe(true)

    // 模拟在 10 分钟去抖窗口内该密钥被轮换/吊销
    await database.db
      .update(apiKeys)
      .set({ revokedAt: sql`now()` })
      .where(eq(apiKeys.id, workKey.id))

    const entrySvc = new EntryService(
      database.db,
      masterKey,
      new CredentialService(database.db, masterKey),
      null,
    )
    const outcome = await extractEpisodeBatch(database.db, masterKey, entrySvc, {
      deviceKey: 'office-box',
      projectSlug: 'internal-ops',
    })
    expect(outcome.createdShortId).toMatch(/^m-/)

    const [ep] = await database.db.select().from(entries)
    expect(ep?.realms).toEqual(['work'])
    expect(ep?.envs).toEqual(['linux'])

    // personal 场域密钥绝对不可见此条工作摘要
    const personalKey = await issueTestApiKey(database, { allowedRealms: ['personal'] })
    const personalScope: KeyPrincipal = {
      kind: 'key',
      keyId: personalKey.id,
      name: 'Personal Key',
      prefix: personalKey.prefix,
      runtimeFamily: 'claudecode',
      envs: [],
      allowedRealms: ['personal'],
      canWrite: true,
      canResolveCredentials: false,
    }
    await expect(entrySvc.get(personalScope, ep!.shortId)).rejects.toThrow()
  })

  it('runDream 生成全部 4 类整理建议并按指纹去重，控制台可应用（含编辑覆盖与版本冲突检测）与忽略', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const ep = await entrySvc.writeEpisode({
      title: '排错过程摘要',
      content: '排查得出 Redis 连接池上限应设为 20。',
      deviceKey: 'dev-1',
      projectSlug: 'kioku',
      ttlDays: 7,
    })
    const dupA = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '代码规范 A',
        content: '统一使用 pnpm 管理依赖。',
        projects: ['kioku'],
      }),
    )
    const dupB = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '代码规范 B',
        content: '仓库统一使用 pnpm 安装包，不用 npm。',
        projects: ['kioku'],
      }),
    )
    const stale = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '已废弃工具备忘',
        content: '旧版构建脚本已下线。',
      }),
    )
    const toUpdate = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '部署端口清单',
        content: '后端监听 18920。',
      }),
    )
    const toDismiss = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '待忽略目标',
        content: '内容保持不变。',
      }),
    )

    fakeAi.setChatHandler(() =>
      JSON.stringify({
        suggestions: [
          {
            kind: 'distill_episode',
            target_short_ids: [ep.shortId],
            title: 'Redis 连接池配置结论',
            content: '生产环境 Redis 连接池上限统一设为 20。',
            topics: ['redis'],
            reason: '会话摘要包含可复用的长期配置结论',
          },
          {
            kind: 'merge_duplicates',
            target_short_ids: [dupA.entry.shortId, dupB.entry.shortId],
            keep_short_id: dupA.entry.shortId,
            title: '包管理器规范',
            content: '统一使用 pnpm 管理依赖，禁止混用 npm。',
            reason: '两条词条表述同一条依赖管理规范',
          },
          {
            kind: 'mark_stale',
            target_short_ids: [stale.entry.shortId],
            reason: '旧版脚本已下线，不再需要保留',
          },
          {
            kind: 'update',
            target_short_ids: [toUpdate.entry.shortId],
            title: '部署端口清单',
            content: '后端监听 18920，前端开发端口 5173。',
            reason: '补全前端开发端口',
          },
          {
            kind: 'mark_stale',
            target_short_ids: [toDismiss.entry.shortId],
            reason: '测试忽略路径',
          },
        ],
      }),
    )

    // 第一次运行 Dream：产生 5 条建议
    const run1 = await runDream(database.db, masterKey, { runId: 'run-1', trigger: 'manual' })
    expect(run1.outcome).toBe('ok')
    expect(run1.suggested).toBe(5)

    // 紧接着再跑一次：所有词条版本都已标记 dreamCheckedVersion，应跳过且不产生重复建议
    const run2 = await runDream(database.db, masterKey, { runId: 'run-2', trigger: 'manual' })
    expect(run2.outcome).toBe('skipped')
    expect(run2.suggested).toBe(0)

    const inbox = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    expect(inbox.pendingCount).toBe(5)
    expect(inbox.dreamState.recentRuns).toHaveLength(2)

    const byKind = (kind: string, idx = 0) => inbox.items.filter((i) => i.kind === kind)[idx]!

    // 1) 应用 distill_episode（附带编辑覆盖 title）
    const distillRes = await app.request(
      `/v1/console/inbox/${byKind('distill_episode').id}/apply`,
      {
        method: 'POST',
        headers: consoleHeaders(cookie, true),
        body: JSON.stringify({ title: 'Redis 连接池最终规范' }),
      },
    )
    expect(distillRes.status).toBe(200)
    const distillOut = ApplySuggestionResponse.parse(await distillRes.json())
    expect(distillOut.entry?.title).toBe('Redis 连接池最终规范')

    // 2) 应用 merge_duplicates：保留 dupA，软删 dupB
    const mergeRes = await app.request(`/v1/console/inbox/${byKind('merge_duplicates').id}/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({}),
    })
    expect(mergeRes.status).toBe(200)
    expect(ApplySuggestionResponse.parse(await mergeRes.json()).entry?.shortId).toBe(
      dupA.entry.shortId,
    )
    const dupBAfter = (await (
      await app.request(`/v1/console/entries/${dupB.entry.shortId}`, { headers: { cookie } })
    ).json()) as { entry: { deletedAt: string | null } }
    expect(dupBAfter.entry.deletedAt).not.toBeNull()

    // 3) 应用 mark_stale：软删除 stale
    const markStaleSuggestion = inbox.items.find(
      (i) => i.kind === 'mark_stale' && i.entries[0]?.shortId === stale.entry.shortId,
    )!
    const staleRes = await app.request(`/v1/console/inbox/${markStaleSuggestion.id}/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({}),
    })
    expect(staleRes.status).toBe(200)
    expect(ApplySuggestionResponse.parse(await staleRes.json()).entry).toBeNull()

    // 4) 先手动修改 toUpdate 使其版本前进，再应用 update 建议必须返回 409 冲突
    await entrySvc.update(consoleScope, toUpdate.entry.shortId, { content: '用户已手动更新' })
    const conflictRes = await app.request(`/v1/console/inbox/${byKind('update').id}/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({}),
    })
    expect(conflictRes.status).toBe(409)

    // 5) 忽略待忽略建议
    const dismissSuggestion = inbox.items.find(
      (i) => i.kind === 'mark_stale' && i.entries[0]?.shortId === toDismiss.entry.shortId,
    )!
    const dismissRes = await app.request(`/v1/console/inbox/${dismissSuggestion.id}/dismiss`, {
      method: 'POST',
      headers: consoleHeaders(cookie),
    })
    expect(dismissRes.status).toBe(204)

    const inboxAfter = await loadInbox(database.db, false)
    // 只剩冲突未应用的那条 update 仍在 pending
    expect(inboxAfter.pendingCount).toBe(1)
  })

  it('Dream tidy 模式按完整正文规范脏标题并归档历史说明，同时拦截丢失双链或凭据的草案', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const refEntry = await entrySvc.create(
      consoleScope,
      entryInput({ title: '关联参考文档', content: '基础说明。' }),
    )
    const tailMarker = '尾部关键约束-完整传入不得截断'
    const dirtyEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '主机部署架构（2026-09-12 迁移；2026-10-21 切换编排）',
        content: [
          '## 现状',
          `主节点运行核心服务，凭据使用 {{cred:ops-token}}，详见 [[${refEntry.entry.shortId}]]。`,
          '常规说明段落。'.repeat(180),
          '## 更新日志',
          '- 2026-09-12 完成初次迁移',
          '- 2026-10-21 切换编排工具',
          `- ${tailMarker}`,
        ].join('\n'),
        isPinned: true,
      }),
    )

    // 先验证完整性守卫：丢失凭据占位符的草案必须被拦截并记为失败，不入待处理且不标已检
    fakeAi.setChatHandler(() =>
      JSON.stringify({
        needed: true,
        title: '主机部署架构',
        summary: '主节点运行核心服务。',
        content: `主节点运行核心服务，详见 [[${refEntry.entry.shortId}]]。`,
        change_summary: '精简历史',
        archived_notes: [],
        reason: '测试拦截丢凭据',
      }),
    )
    const blockedRun = await runDream(database.db, masterKey, {
      runId: 'tidy-blocked',
      trigger: 'manual',
      mode: 'tidy',
      limit: 5,
    })
    expect(blockedRun.suggested).toBe(0)
    expect(blockedRun.outcome).toBe('failed')
    expect(blockedRun.error).toContain('双链或凭据')

    // 正常草案：验证长文未截断传入模型、保留全部双链与凭据、并产出 archived_notes
    let sawTail = false
    fakeAi.setChatHandler((messages) => {
      if (messages.some((m) => m.content.includes(tailMarker))) sawTail = true
      return JSON.stringify({
        needed: true,
        title: '主机部署架构',
        summary: '主节点运行核心服务，统一经编排工具部署。',
        content: `## 现行架构\n- 主节点运行核心服务，凭据使用 {{cred:ops-token}}，详见 [[${refEntry.entry.shortId}|参考文档]]。`,
        change_summary: '规范标题并剥离历史迁移流水',
        archived_notes: [
          { occurred_at: '2026-09-12', note: '完成初次迁移，曾使用 {{cred:ops-token}} 测试' },
          { occurred_at: '2026-10-21', note: '切换编排工具' },
        ],
        reason: '标题含日期日志且正文夹带旧更新记录',
      })
    })
    const tidyRun = await runDream(database.db, masterKey, {
      runId: 'tidy-ok',
      trigger: 'manual',
      mode: 'tidy',
      limit: 5,
    })
    expect(sawTail).toBe(true)
    expect(tidyRun.outcome).toBe('ok')
    expect(tidyRun.suggested).toBe(1)

    const inbox = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    const tidyCard = inbox.items.find((i) => i.kind === 'tidy')!
    expect(tidyCard.proposedTitle).toBe('主机部署架构')
    expect(tidyCard.proposedSummary).toContain('主节点运行核心服务')
    expect(tidyCard.archivedNotes).toHaveLength(2)

    const applyRes = await app.request(`/v1/console/inbox/${tidyCard.id}/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({}),
    })
    expect(applyRes.status).toBe(200)
    const applied = ApplySuggestionResponse.parse(await applyRes.json())
    expect(applied.entry?.previousVersion).toBe(1)
    expect(applied.entry?.version).toBe(2)

    const history = await entrySvc.history(consoleScope, dirtyEntry.entry.shortId)
    expect(history.items.filter((i) => i.eventType === 'archive_note')).toHaveLength(2)
    expect(history.items.some((i) => i.changeSummary?.includes('{{cred:'))).toBe(false)
    expect(history.items[0]?.changeSummary).toBe('规范标题并剥离历史迁移流水')

    // 模型判 needed:false 的词条记录已检版本，二次触发不再重复调用或饿死队列
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: '无需调整的超长标题样例用于触发检测（2026-06-01 记录）',
        content: '简短说明。',
      }),
    )
    let calls = 0
    fakeAi.setChatHandler(() => {
      calls++
      return JSON.stringify({ needed: false })
    })
    const firstCheck = await runDream(database.db, masterKey, {
      runId: 'tidy-noop-1',
      trigger: 'manual',
      mode: 'tidy',
      limit: 5,
    })
    expect(firstCheck.considered).toBe(1)
    expect(calls).toBe(1)
    const secondCheck = await runDream(database.db, masterKey, {
      runId: 'tidy-noop-2',
      trigger: 'manual',
      mode: 'tidy',
      limit: 5,
    })
    expect(secondCheck.considered).toBe(0)
    expect(calls).toBe(1)
  })

  it('Dream tidy 模式支持 3 路受控并发、全量批次、单条失败容错与进度回调，且返回待规范存量计数', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const createdShorts: string[] = []
    for (let i = 0; i < 6; i++) {
      const res = await entrySvc.create(
        consoleScope,
        entryInput({
          title: `待规范条目 ${i + 1}（2026-10-0${i + 1} 记录）`,
          content: `第 ${i + 1} 条测试正文内容。`,
          isPinned: i < 2,
        }),
      )
      createdShorts.push(res.entry.shortId)
    }

    const failShortId = createdShorts[2]!
    const noopShortId = createdShorts[3]!

    const inboxBefore = await loadInbox(database.db, false)
    expect(inboxBefore.tidyPendingCount).toBe(6)

    let inFlight = 0
    let maxInFlight = 0
    fakeAi.setChatHandler(async (messages) => {
      inFlight++
      if (inFlight > maxInFlight) maxInFlight = inFlight
      await new Promise((r) => setTimeout(r, 35))
      const userPrompt = messages.find((m) => m.role === 'user')?.content ?? ''
      try {
        if (userPrompt.includes(`[${failShortId}]`)) {
          throw new Error('upstream boom')
        }
        if (userPrompt.includes(`[${noopShortId}]`)) {
          return JSON.stringify({ needed: false })
        }
        return JSON.stringify({
          needed: true,
          title: '规范化主题名',
          summary: '清晰现行概要。',
          content: '精简后的常青正文。',
          change_summary: '规范标题与正文',
          archived_notes: [],
          reason: '去除标题日期',
        })
      } finally {
        inFlight--
      }
    })

    const progressEvents: {
      processed: number
      total: number
      suggested: number
      failed: number
    }[] = []
    const run = await runDream(database.db, masterKey, {
      runId: 'tidy-all-resilient',
      trigger: 'manual',
      mode: 'tidy',
      all: true,
      retryBaseMs: 5,
      onProgress: (p) => progressEvents.push({ ...p }),
    })

    // 3 路受控并发生效，且不会超发
    expect(maxInFlight).toBeGreaterThanOrEqual(2)
    expect(maxInFlight).toBeLessThanOrEqual(3)

    // 6 条中 1 条失败、1 条无需调整、4 条生成建议：整批不停机，标记部分完成并指名失败短 ID
    expect(run.outcome).toBe('partial')
    expect(run.considered).toBe(6)
    expect(run.suggested).toBe(4)
    expect(run.error).toContain(failShortId)
    expect(run.failedItems).toHaveLength(1)
    expect(run.failedItems[0]?.shortId).toBe(failShortId)
    expect(run.retriedCount).toBe(2)
    expect(progressEvents.at(-1)).toEqual({
      mode: 'tidy',
      processed: 6,
      total: 6,
      suggested: 4,
      failed: 1,
    })

    // 4 条已入队待处理 + 1 条 not_needed 已持久化已检版本，仅剩失败的那 1 条仍在待规范存量里
    const inboxAfter = await loadInbox(database.db, false)
    expect(inboxAfter.pendingCount).toBe(4)
    expect(inboxAfter.tidyPendingCount).toBe(1)
    expect(inboxAfter.dreamState.lastOutcome).toBe('partial')
    expect(inboxAfter.dreamState.recentRuns[0]?.failedItems?.[0]?.shortId).toBe(failShortId)

    // 使用 targetShortIds 仅重试失败项，成功后失败列表清空
    fakeAi.setChatHandler(() =>
      JSON.stringify({
        needed: true,
        title: '重试修复后标题',
        summary: '重试成功概要。',
        content: '重试成功正文。',
        change_summary: '规范标题',
        archived_notes: [],
        reason: '重试规范',
      }),
    )
    const retryRun = await runDream(database.db, masterKey, {
      runId: 'tidy-retry-failed',
      trigger: 'manual',
      mode: 'tidy',
      targetShortIds: [failShortId],
    })
    expect(retryRun.outcome).toBe('ok')
    expect(retryRun.considered).toBe(1)
    expect(retryRun.suggested).toBe(1)
    expect(retryRun.failedItems).toHaveLength(0)
  })

  it('修复静默吞错：standard 坏 JSON 不推进水位、extract 坏 JSON 不删 turn_buffer，且支持 1 次语义纠错', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
      reasoningEffort: 'low',
      taskReasoningEffort: { fast: 'off', organize: 'high' },
    })

    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    // 1. extract 持续输出坏 JSON 时抛错且绝对保留 turn_buffer，同时使用 fast 思考等级覆盖
    const key = await issueTestApiKey(database, { canWrite: true })
    await database.db.insert(turnBuffer).values({
      keyId: key.id,
      sessionId: 's-bad',
      deviceKey: 'dev-bad',
      projectSlug: 'proj-bad',
      userText: '关键结论待抽取',
      replyText: '已记录关键配置',
    })
    const seenEfforts: unknown[] = []
    fakeAi.setChatHandler((_msgs, body) => {
      seenEfforts.push(body.reasoning_effort)
      return 'not a json at all'
    })

    await expect(
      extractEpisodeBatch(database.db, masterKey, entrySvc, {
        deviceKey: 'dev-bad',
        projectSlug: 'proj-bad',
      }),
    ).rejects.toThrow('会话摘要模型输出无效')
    // 初次 + 1 次纠错均用 fast=off（none），且 turn_buffer 完好保留
    expect(seenEfforts).toEqual(['none', 'none'])
    expect(await database.db.select().from(turnBuffer)).toHaveLength(1)

    // 2. standard 模式坏 JSON 不推进 dreamCheckedVersion，并记录 failedItems；随后修复响应再次运行可正常审阅
    const created = await entrySvc.create(
      consoleScope,
      entryInput({ title: '待常规整理词条', content: '原始正文内容。' }),
    )
    const orgEfforts: unknown[] = []
    fakeAi.setChatHandler((_msgs, body) => {
      orgEfforts.push(body.reasoning_effort)
      return '{broken json'
    })

    const badRun = await runDream(database.db, masterKey, {
      runId: 'std-bad-json',
      trigger: 'manual',
      mode: 'standard',
      retryBaseMs: 5,
    })
    expect(orgEfforts).toEqual(['high', 'high'])
    expect(badRun.outcome).toBe('failed')
    expect(badRun.failedItems).toHaveLength(1)
    expect(badRun.failedItems[0]?.shortId).toBe(created.entry.shortId)
    expect(badRun.retriedCount).toBe(1)

    const [rowAfterBad] = await database.db
      .select({ dreamCheckedVersion: entries.dreamCheckedVersion, version: entries.version })
      .from(entries)
      .where(eq(entries.id, created.entry.id))
    expect(rowAfterBad?.dreamCheckedVersion).toBe(0)

    // 下次模型恢复合法 JSON 时，未推进水位的词条会自动被重新审阅并推进水位
    fakeAi.setChatHandler(() => JSON.stringify({ suggestions: [] }))
    const okRun = await runDream(database.db, masterKey, {
      runId: 'std-recovered',
      trigger: 'manual',
      mode: 'standard',
    })
    expect(okRun.outcome).toBe('ok')
    expect(okRun.considered).toBe(1)
    const [rowAfterOk] = await database.db
      .select({ dreamCheckedVersion: entries.dreamCheckedVersion, version: entries.version })
      .from(entries)
      .where(eq(entries.id, created.entry.id))
    expect(rowAfterOk?.dreamCheckedVersion).toBe(rowAfterOk?.version)
  })

  it('tidy 支持完整性丢链 1 次定向纠错、429 降并发共享退避，以及 401 鉴权错整批熔断', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    // 1. 首次草案丢凭据占位符，纠错提示列出具体占位符后第 2 次补回并成功入队
    const repairEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '需要纠错的词条（2026-10-01）',
        content: '生产使用 {{cred:prod-secret}} 访问接口。',
      }),
    )
    let repairCalls = 0
    let sawMissingHint = false
    fakeAi.setChatHandler((messages) => {
      repairCalls++
      if (repairCalls === 1) {
        return JSON.stringify({
          needed: true,
          title: '接口访问配置',
          summary: '使用凭据访问接口。',
          content: '生产使用托管凭据访问接口。',
          change_summary: '规范标题',
          archived_notes: [],
          reason: '去日期',
        })
      }
      if (
        messages.some(
          (m) => m.content.includes('{{cred:prod-secret}}') && m.content.includes('遗漏'),
        )
      ) {
        sawMissingHint = true
      }
      return JSON.stringify({
        needed: true,
        title: '接口访问配置',
        summary: '使用凭据访问接口。',
        content: '生产使用 {{cred:prod-secret}} 访问接口。',
        change_summary: '规范标题',
        archived_notes: [],
        reason: '去日期',
      })
    })
    const repairRun = await runDream(database.db, masterKey, {
      runId: 'tidy-semantic-repair',
      trigger: 'manual',
      mode: 'tidy',
      targetShortIds: [repairEntry.entry.shortId],
    })
    expect(repairRun.outcome).toBe('ok')
    expect(repairRun.suggested).toBe(1)
    expect(repairRun.retriedCount).toBe(1)
    expect(sawMissingHint).toBe(true)

    // 2. 401 鉴权错触发整批熔断，剩余词条不再继续发送请求
    const authTargets: string[] = []
    for (let i = 0; i < 6; i++) {
      const e = await entrySvc.create(
        consoleScope,
        entryInput({
          title: `熔断测试 ${i + 1}（2026-10-0${i + 1}）`,
          content: '测试正文。',
        }),
      )
      authTargets.push(e.entry.shortId)
    }
    let authCalls = 0
    fakeAi.setChatHandler(() => {
      authCalls++
      throw new FakeHttpError(401, 'invalid api key')
    })
    const authRun = await runDream(database.db, masterKey, {
      runId: 'tidy-auth-abort',
      trigger: 'manual',
      mode: 'tidy',
      targetShortIds: authTargets,
      concurrency: 1,
      retryBaseMs: 5,
    })
    expect(authCalls).toBe(1)
    expect(authRun.outcome).toBe('failed')
    expect(authRun.abortedReason).toContain('401')
    expect(authRun.considered).toBe(1)

    // 3. tidy 遇到缺 needed 字段的空 JSON `{}` 应触发纠错而非误判 not_needed 跳过
    const schemaEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '缺字段校验词条（2026-10-09）',
        content: '保留核心配置。',
      }),
    )
    let schemaCalls = 0
    fakeAi.setChatHandler(() => {
      schemaCalls++
      return schemaCalls === 1
        ? '{}'
        : JSON.stringify({
            needed: true,
            title: '核心配置说明',
            summary: '保留核心配置。',
            content: '保留核心配置。',
            change_summary: '去除标题日期',
            archived_notes: [],
            reason: '去除标题日期',
          })
    })
    const schemaRun = await runDream(database.db, masterKey, {
      runId: 'tidy-schema-repair',
      trigger: 'manual',
      mode: 'tidy',
      targetShortIds: [schemaEntry.entry.shortId],
    })
    expect(schemaCalls).toBe(2)
    expect(schemaRun.outcome).toBe('ok')
    expect(schemaRun.suggested).toBe(1)

    // 4. 429 触发共享冷却并真正将后续并发降至 1
    let rlCalls = 0
    let inFlightPostCooldown = 0
    let maxInFlightPostCooldown = 0
    let rlTriggeredAt = 0
    fakeAi.setChatHandler(async () => {
      rlCalls++
      if (rlCalls === 1) {
        rlTriggeredAt = Date.now()
        throw new FakeHttpError(429, 'rate limit', { 'retry-after': '0.06' })
      }
      const afterCooldown = rlTriggeredAt > 0 && Date.now() - rlTriggeredAt >= 55
      if (afterCooldown) {
        inFlightPostCooldown++
        if (inFlightPostCooldown > maxInFlightPostCooldown) {
          maxInFlightPostCooldown = inFlightPostCooldown
        }
      }
      await new Promise((r) => setTimeout(r, 25))
      if (afterCooldown) inFlightPostCooldown--
      return JSON.stringify({ needed: false })
    })
    const rlRun = await runDream(database.db, masterKey, {
      runId: 'tidy-429-throttle',
      trigger: 'manual',
      mode: 'tidy',
      targetShortIds: authTargets,
      concurrency: 3,
      retryBaseMs: 5,
      cooldownFallbackMs: 60,
    })
    expect(rlRun.outcome).toBe('ok')
    expect(rlRun.retriedCount).toBeGreaterThanOrEqual(1)
    expect(maxInFlightPostCooldown).toBe(1)
  })

  it('待规范计数不会将长目录常驻或无卫生问题的长全文常驻误计为待规范', async () => {
    const masterKey = testMasterKey()
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const longCleanBody = '稳定的架构设计与接口约束说明。'.repeat(110)
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: '分层网络参考手册',
        summary: '说明网关分层拓扑与排查入口。',
        content: longCleanBody,
        bootMode: 'index',
      }),
    )
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: '项目构建约束',
        summary: '说明项目构建命令与检查项。',
        content: longCleanBody,
        bootMode: 'full',
        projects: ['alpha-app'],
      }),
    )

    const inboxClean = await loadInbox(database.db, false)
    expect(inboxClean.tidyPendingCount).toBe(0)

    // 缺少现行概要的目录常驻仍应被计入待规范，便于自动补齐概要
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: '缺少概要的目录手册',
        content: '简明操作说明。',
        bootMode: 'index',
      }),
    )
    const inboxMissingSummary = await loadInbox(database.db, false)
    expect(inboxMissingSummary.tidyPendingCount).toBe(1)

    // 主题标签超过 8 个时写入应给出客观提醒，并自动计入批量待规范存量
    const overTopics = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '主题膨胀词条',
        summary: '已有概要。',
        content: '简明正文。',
        topics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'],
      }),
    )
    expect(overTopics.warnings?.map((w) => w.code)).toContain('topics_too_many')
    const inboxOverTopics = await loadInbox(database.db, false)
    expect(inboxOverTopics.tidyPendingCount).toBe(2)

    // 额外写入两条带共享高频主题 docker 的词条，验证批量 tidy 透传高频词表并收敛 topics 与 disclosure 后不再反复排队
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: '容器镜像拉取规范',
        summary: '拉取镜像使用固定版本标签。',
        content: '固定镜像版本标签。',
        topics: ['docker'],
      }),
    )
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: '容器日志落盘策略',
        summary: '限制容器日志大小防止占满磁盘。',
        content: '配置 json-file 滚动上限。',
        topics: ['docker'],
      }),
    )

    // 已过期词条的主题不得计入高频主题参考（批量 SQL 与单条预览口径一致）
    const expiredA = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '过期主题样本甲',
        summary: '临时记录。',
        content: '过期正文。',
        topics: ['expired-only'],
        validTo: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    )
    const expiredB = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '过期主题样本乙',
        summary: '临时记录。',
        content: '过期正文。',
        topics: ['expired-only'],
        validTo: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    )
    await database.db
      .update(entries)
      .set({ validTo: sql`now() - interval '1 hour'` })
      .where(sql`${entries.id} in (${expiredA.entry.id}, ${expiredB.entry.id})`)
    expect(await loadFrequentTopics(database.db)).toEqual(['docker'])

    let seenFrequentTopicsHint = false
    let sawExpiredTopic = false
    fakeAi.setChatHandler((messages) => {
      const userText = messages[1]?.content ?? ''
      if (userText.includes('库内高频主题参考') && userText.includes('docker')) {
        seenFrequentTopicsHint = true
      }
      if (userText.includes('expired-only')) {
        sawExpiredTopic = true
      }
      return JSON.stringify({
        needed: true,
        title: '主题膨胀词条',
        summary: '已有概要。',
        content: '简明正文。',
        topics: ['docker', 'ops'],
        disclosure: '排查容器与日常运维配置时查阅',
        change_summary: '收敛主题并补充触发场景',
        archived_notes: [],
        reason: '将 9 个零散主题收敛为 2 个稳定标签并补齐触发场景',
      })
    })

    const tidyRun = await runDream(database.db, masterKey, {
      runId: 'tidy-topics-converge',
      trigger: 'manual',
      mode: 'tidy',
      targetShortIds: [overTopics.entry.shortId],
    })
    expect(tidyRun.outcome).toBe('ok')
    expect(tidyRun.suggested).toBe(1)
    expect(seenFrequentTopicsHint).toBe(true)
    expect(sawExpiredTopic).toBe(false)

    const inboxWithTidy = await loadInbox(database.db, false)
    const tidyCard = inboxWithTidy.items.find(
      (i) => i.kind === 'tidy' && i.entries[0]?.shortId === overTopics.entry.shortId,
    )!
    expect(tidyCard.proposedTopics).toEqual(['docker', 'ops'])
    expect(tidyCard.proposedDisclosure).toBe('排查容器与日常运维配置时查阅')

    await entrySvc.applySuggestion(tidyCard.id, {})
    const afterTidy = await entrySvc.get(consoleScope, overTopics.entry.shortId)
    expect(afterTidy.entry.topics).toEqual(['docker', 'ops'])
    expect(afterTidy.entry.disclosure).toBe('排查容器与日常运维配置时查阅')
    // 主题已收敛至 2 个，应用后不再重新落回待规范队列
    const inboxAfterApply = await loadInbox(database.db, false)
    expect(inboxAfterApply.tidyPendingCount).toBe(1)

    // 另一条 topics > 8 但模型判定 needed: false 时应推进 tidyChecked 水位，不反复排队
    const keepManyTopics = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '保留多主题词条',
        summary: '已有概要。',
        content: '简明正文。',
        topics: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'],
      }),
    )
    expect((await loadInbox(database.db, false)).tidyPendingCount).toBe(2)
    fakeAi.setChatHandler(() => JSON.stringify({ needed: false }))
    const noNeedRun = await runDream(database.db, masterKey, {
      runId: 'tidy-topics-not-needed',
      trigger: 'manual',
      mode: 'tidy',
      targetShortIds: [keepManyTopics.entry.shortId],
    })
    expect(noNeedRun.outcome).toBe('ok')
    expect(noNeedRun.suggested).toBe(0)
    expect((await loadInbox(database.db, false)).tidyPendingCount).toBe(1)

    // 单条快速规范预览排除过期主题，且暂存至待处理与直接应用均透传 topics 与 disclosure
    let singlePreviewSawExpired = false
    fakeAi.setChatHandler((messages) => {
      if ((messages[1]?.content ?? '').includes('expired-only')) {
        singlePreviewSawExpired = true
      }
      return JSON.stringify({
        needed: true,
        title: afterTidy.entry.title,
        summary: afterTidy.entry.summary,
        content: afterTidy.entry.content,
        topics: ['docker'],
        disclosure: '调整容器运维配置时参考',
        change_summary: '精简主题并调整触发场景',
        archived_notes: [],
        reason: '进一步收敛主题',
      })
    })
    const singlePreview = await entrySvc.previewSingleTidy(overTopics.entry.shortId)
    expect(singlePreviewSawExpired).toBe(false)
    expect(singlePreview.before.topics).toEqual(['docker', 'ops'])
    expect(singlePreview.before.disclosure).toBe('排查容器与日常运维配置时查阅')
    expect(singlePreview.proposed.topics).toEqual(['docker'])
    expect(singlePreview.proposed.disclosure).toBe('调整容器运维配置时参考')

    const staged = await entrySvc.applySingleTidy(consoleScope, overTopics.entry.shortId, {
      expectedVersion: afterTidy.entry.version,
      title: afterTidy.entry.title,
      summary: afterTidy.entry.summary ?? null,
      content: afterTidy.entry.content,
      topics: ['docker'],
      disclosure: '调整容器运维配置时参考',
      stageToInbox: true,
    })
    expect(staged.stagedSuggestionId).toBeTruthy()
    // 从待处理应用暂存卡片，验证暂存的 topics 与 disclosure 真实生效
    await entrySvc.applySuggestion(staged.stagedSuggestionId!, {})
    const afterStagedApply = await entrySvc.get(consoleScope, overTopics.entry.shortId)
    expect(afterStagedApply.entry.topics).toEqual(['docker'])
    expect(afterStagedApply.entry.disclosure).toBe('调整容器运维配置时参考')

    // 直接应用单条规范省略 topics 时保持原值
    const singleApplied = await entrySvc.applySingleTidy(consoleScope, overTopics.entry.shortId, {
      expectedVersion: afterStagedApply.entry.version,
      title: afterStagedApply.entry.title,
      summary: afterStagedApply.entry.summary ?? null,
      content: afterStagedApply.entry.content,
      disclosure: '排查容器运行时参数时参考',
    })
    expect(singleApplied.entry?.entry.topics).toEqual(['docker'])
    expect(singleApplied.entry?.entry.disclosure).toBe('排查容器运行时参数时参考')

    // distill_episode 显式传 projects: []、envs: [] 与 proposed_boot_mode: 'full' 应真实生效，且 realms: [] 保持 fail-closed
    const ep = await entrySvc.writeEpisode({
      title: '多项目提交习惯讨论',
      content: '在多个仓库中均强调按职责拆分 PR，合并后清理工作区与本地分支。',
      envs: ['mac'],
      realms: ['work'],
      projects: ['kioku'],
      deviceKey: 'dev-mac',
      projectSlug: 'kioku',
    })
    fakeAi.setChatHandler(() =>
      JSON.stringify({
        suggestions: [
          {
            kind: 'distill_episode',
            target_short_ids: [ep.shortId],
            title: '提交拆 PR 习惯',
            summary: '按职责拆分 PR，合并后清理工作区与分支。',
            content: '所有代码改动优先拆分小 PR 提交，合并后及时删除本地分支与临时工作区。',
            topics: ['git'],
            envs: [],
            projects: [],
            realms: [],
            proposed_boot_mode: 'full',
            reason: '跨项目高频工作流习惯',
          },
        ],
      }),
    )
    const distillRun = await runDream(database.db, masterKey, {
      runId: 'distill-widen-and-boot',
      trigger: 'manual',
      mode: 'standard',
      targetShortIds: [ep.shortId],
    })
    expect(distillRun.suggested).toBe(1)
    const inboxDistill = await loadInbox(database.db, false)
    const distillCard = inboxDistill.items.find(
      (i) => i.kind === 'distill_episode' && i.entries[0]?.shortId === ep.shortId,
    )!
    expect(distillCard.proposedProjects).toEqual([])
    expect(distillCard.proposedEnvs).toEqual([])
    expect(distillCard.proposedRealms).toBeNull()
    expect(distillCard.proposedBootMode).toBe('full')

    const appliedDistill = await entrySvc.applySuggestion(distillCard.id, {})
    const distilledDetail = await entrySvc.get(consoleScope, appliedDistill.entry!.shortId)
    expect(distilledDetail.entry.projects).toEqual([])
    expect(distilledDetail.entry.envs).toEqual([])
    expect(distilledDetail.entry.realms).toEqual(['work'])
    expect(distilledDetail.entry.bootMode).toBe('full')
    expect(distilledDetail.entry.isPinned).toBe(true)
    expect(distilledDetail.entry.topics).toEqual(['git'])
  })

  it('跨记忆查重簇与增量整理严格拒绝合并 envs、projects 或 runtimes 互斥的高相似词条（含传递桥接防护）', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const basisVec = (slot: number): number[] => {
      const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
      vec[slot] = 1
      return vec
    }

    // 组 1：globalGit(envs=[]) + homeGit(envs=['home']) + officeGit(envs=['company']) 同向量（cos=1.0）
    // 期望：正对照触发簇审阅（globalGit 可与其中一方成簇），但严禁将 homeGit 与 officeGit 经由 globalGit 传递聚入同一簇
    const globalGit = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '通用 Git 提交规范',
        content: '提交前执行本地检查并保持提交记录清晰。',
        envs: [],
      }),
    )
    const homeGit = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Git 提交流程规范',
        content: '提交代码前必须按职责拆分 PR，合并后清理工作区与本地分支。',
        envs: ['home'],
      }),
    )
    const officeGit = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Git 提交流程规范',
        content: '提交代码前不提 PR，直接提交到目标开发分支并触发构建。',
        envs: ['company'],
      }),
    )
    // 组 2：互斥项目（cos=1.0）
    const projA = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '仓库构建命令',
        content: '本地统一执行标准构建命令并校验产物。',
        projects: ['repo-alpha'],
      }),
    )
    const projB = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '仓库构建命令',
        content: '本地统一执行标准构建命令并校验产物。',
        projects: ['repo-beta'],
      }),
    )
    // 组 3：互斥客户端（cos=1.0）
    const claudeRule = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '客户端工作流约束',
        content: '在编码前先说明修改范围。',
        runtimes: ['claudecode'],
      }),
    )
    const codexRule = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '客户端工作流约束',
        content: '在编码前先说明修改范围。',
        runtimes: ['codex'],
      }),
    )

    await database.db.insert(entryEmbeddings).values([
      { entryId: globalGit.entry.id, model: 'test-emb', contentHash: 'g1', embedding: basisVec(0) },
      { entryId: homeGit.entry.id, model: 'test-emb', contentHash: 'h1', embedding: basisVec(0) },
      { entryId: officeGit.entry.id, model: 'test-emb', contentHash: 'o1', embedding: basisVec(0) },
      { entryId: projA.entry.id, model: 'test-emb', contentHash: 'p1', embedding: basisVec(1) },
      { entryId: projB.entry.id, model: 'test-emb', contentHash: 'p2', embedding: basisVec(1) },
      {
        entryId: claudeRule.entry.id,
        model: 'test-emb',
        contentHash: 'r1',
        embedding: basisVec(2),
      },
      { entryId: codexRule.entry.id, model: 'test-emb', contentHash: 'r2', embedding: basisVec(2) },
    ])

    const clusterUserPrompts: string[] = []
    fakeAi.setChatHandler((messages) => {
      const sys = messages[0]?.content ?? ''
      if (sys.includes('跨记忆查重与冲突审阅助手')) {
        clusterUserPrompts.push(messages[1]?.content ?? '')
      }
      return JSON.stringify({ suggestions: [] })
    })

    await runDream(database.db, masterKey, {
      runId: 'cross-disjoint-guard',
      trigger: 'manual',
      mode: 'cross_memory',
    })

    // 正对照：globalGit 与单方 envs 兼容，必然触发至少 1 次簇审阅
    expect(clusterUserPrompts.length).toBeGreaterThanOrEqual(1)
    for (const body of clusterUserPrompts) {
      // 严禁把互斥 envs / projects / runtimes 塞进同一个查重簇
      expect(body.includes(homeGit.entry.shortId) && body.includes(officeGit.entry.shortId)).toBe(
        false,
      )
      expect(body.includes(projA.entry.shortId) && body.includes(projB.entry.shortId)).toBe(false)
      expect(
        body.includes(claudeRule.entry.shortId) && body.includes(codexRule.entry.shortId),
      ).toBe(false)
    }

    // 增量整理（standard）即使模型强行产出跨互斥 envs 的 merge_duplicates 提案，也必须在校验层丢弃
    fakeAi.setChatHandler(() =>
      JSON.stringify({
        suggestions: [
          {
            kind: 'merge_duplicates',
            entry_short_ids: [homeGit.entry.shortId, officeGit.entry.shortId],
            keep_short_id: homeGit.entry.shortId,
            title: '误合并 Git 规范',
            content: '试图合并互斥环境词条。',
            reason: '误判重复',
          },
        ],
      }),
    )
    const stdRes = await runDream(database.db, masterKey, {
      runId: 'standard-disjoint-guard',
      trigger: 'manual',
      mode: 'standard',
      targetShortIds: [homeGit.entry.shortId, officeGit.entry.shortId],
    })
    expect(stdRes.suggested).toBe(0)
  })

  it('跨记忆四阶段整理覆盖长文查重、反链自动重定向、场域硬边界、补全双链、会话对账与启动降级', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const unitVec = (a: number, b: number, c = 0): number[] => {
      const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
      const norm = Math.hypot(a, b, c) || 1
      vec[0] = a / norm
      vec[1] = b / norm
      vec[2] = c / norm
      return vec
    }

    const tailMarker = '长文尾部关键细节-不得在查重时被截断'
    const dupLongA = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '网关部署规范 A',
        content: `使用 {{cred:ops-a}} 登录网关节点。\n${'标准部署说明段落。'.repeat(210)}`,
        realms: ['work'],
        topics: ['gateway'],
        bootMode: 'index',
        summary: '网关部署核心说明。',
      }),
    )
    const dupLongB = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '网关部署规范 B',
        content: `使用 {{cred:ops-b}} 发布网关。\n${'标准部署说明段落。'.repeat(210)}\n${tailMarker}`,
        realms: ['work'],
        topics: ['docker'],
        bootMode: 'full',
      }),
    )
    // 同向量但不同场域：禁止与 work 词条合并，也不允许被通用词条引用
    const personalClone = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '个人网关笔记',
        content: '个人环境家庭网关配置。',
        realms: ['personal'],
      }),
    )
    // 引用 dupLongB 的外部记忆（含行内代码保护）
    const refDoc = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '发布检查清单',
        content: `部署前先核对 [[${dupLongB.entry.shortId}|旧网关规范]]，示例代码 \`[[${dupLongB.entry.shortId}]]\` 保持原样。`,
        realms: ['work'],
      }),
    )
    // 通用词条对：用于验证 0.70-0.84 补全双链及场域流向过滤
    const uniEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '数据库备份手册',
        content: '## 备份步骤\n每日凌晨执行全量备份。',
        topics: ['postgres'],
      }),
    )
    const linkTarget = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '数据库恢复演练指南',
        summary: '说明从归档恢复实例的步骤。',
        content: '演练恢复流程与校验脚本。',
        topics: ['postgres'],
      }),
    )
    // 超长全局全文常驻词条：触发启动加载降级巡检
    const oversizedFull = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '超大参考词典',
        content: '详细历史参考资料与对照表。'.repeat(220),
        bootMode: 'full',
      }),
    )
    // 同项目会话摘要 + 正式词条：触发会话反向对账
    const formalTarget = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '缓存端口配置',
        content: '当前缓存服务运行在 6379 端口。',
        projects: ['alpha-app'],
      }),
    )
    await entrySvc.writeEpisode({
      title: '缓存端口变更记录',
      content: '已将 alpha-app 缓存端口迁移至 6380。',
      deviceKey: 'dev-1',
      projectSlug: 'alpha-app',
      ttlDays: 7,
    })

    // 写入 1024 维向量：dupLongA/dupLongB/personalClone 余弦=1.0；uniEntry/linkTarget 余弦≈0.78
    const insertVec = async (entryId: string, vec: number[]) => {
      await database.db.insert(entryEmbeddings).values({
        entryId,
        model: 'fake-embed',
        contentHash: `hash-${entryId}`,
        embedding: vec,
      })
    }
    await insertVec(dupLongA.entry.id, unitVec(1, 0, 0))
    await insertVec(dupLongB.entry.id, unitVec(1, 0, 0))
    await insertVec(personalClone.entry.id, unitVec(1, 0, 0))
    await insertVec(uniEntry.entry.id, unitVec(0, 1, 0))
    await insertVec(linkTarget.entry.id, unitVec(0, 0.78, Math.sqrt(1 - 0.78 * 0.78)))

    let sawClusterFullTail = false
    let clusterIncludedPersonal = false
    fakeAi.setChatHandler((messages) => {
      const userText = messages.find((m) => m.role === 'user')?.content ?? ''
      if (userText.includes('## 高相似记忆簇')) {
        if (userText.includes(tailMarker)) sawClusterFullTail = true
        if (userText.includes(personalClone.entry.shortId)) clusterIncludedPersonal = true
        return JSON.stringify({
          suggestions: [
            {
              kind: 'merge_duplicates',
              target_short_ids: [dupLongA.entry.shortId, dupLongB.entry.shortId],
              keep_short_id: dupLongA.entry.shortId,
              title: '网关部署统一规范',
              summary: '合并网关登录与发布流程。',
              content:
                '统一部署规范：登录使用 {{cred:ops-a}}，发布使用 {{cred:ops-b}}，详见变更记录。',
              reason: '两条工作场域网关部署文档高度重合，合并避免双份漂移',
            },
          ],
        })
      }
      if (
        userText.includes('## 尚未互链的相关候选记忆') &&
        userText.includes(uniEntry.entry.shortId)
      ) {
        return JSON.stringify({
          suggestions: [
            {
              kind: 'link_entries',
              target_short_ids: [uniEntry.entry.shortId],
              proposed_links: [
                {
                  target_short_id: linkTarget.entry.shortId,
                  relation: '配套恢复演练',
                  reason: '备份与恢复互为前置后置文档',
                },
                {
                  // 故意塞入一条窄场域目标，校验服务端场域流向守卫会将其拦截丢弃
                  target_short_id: dupLongA.entry.shortId,
                  relation: '非法越权引用',
                  reason: '测试过滤',
                },
              ],
              reason: '补全备份与恢复手册的双链关联',
            },
          ],
        })
      }
      if (userText.includes('## 近期会话摘要（待对账）')) {
        return JSON.stringify({
          suggestions: [
            {
              kind: 'update',
              target_short_ids: [formalTarget.entry.shortId],
              title: '缓存端口配置',
              content: '当前缓存服务运行在 6380 端口。',
              change_summary: '依据近期会话同步端口变更',
              reason: '会话摘要显示缓存端口已改为 6380',
            },
          ],
        })
      }
      if (userText.includes('## 待审阅的全文常驻记忆')) {
        return JSON.stringify({
          suggestions: [
            {
              kind: 'adjust_boot_mode',
              target_short_ids: [oversizedFull.entry.shortId],
              proposed_boot_mode: 'index',
              summary: '大型历史参考词典，按需查阅。',
              reason: '全局全文常驻篇幅过大，建议改为目录常驻',
            },
          ],
        })
      }
      return JSON.stringify({ suggestions: [] })
    })

    const run = await runDream(database.db, masterKey, {
      runId: 'cross-full-1',
      trigger: 'manual',
      mode: 'cross_memory',
      scope: 'full_corpus',
    })
    expect(run.outcome).toBe('ok')
    expect(sawClusterFullTail).toBe(true)
    expect(clusterIncludedPersonal).toBe(false)
    expect(run.suggested).toBeGreaterThanOrEqual(4)

    const inbox = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )

    // 1) 验证 merge_duplicates 展示反链数、拦截丢凭据编辑、应用后继承最高 bootMode 并自动重定向反链
    const mergeCard = inbox.items.find((i) => i.kind === 'merge_duplicates')!
    expect(mergeCard).toBeTruthy()
    expect(mergeCard.affectedBacklinkCount).toBe(1)

    // 服务端完整性守卫：若合并结果遗漏了被合并词条 dupLongB 的 {{cred:ops-b}}，必须拒收 400
    const badMergeRes = await app.request(`/v1/console/inbox/${mergeCard.id}/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        content: '只保留了 {{cred:ops-a}}，遗漏了另一条凭据。',
      }),
    })
    expect(badMergeRes.status).toBe(400)

    const okMergeRes = await app.request(`/v1/console/inbox/${mergeCard.id}/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({}),
    })
    expect(okMergeRes.status).toBe(200)
    const mergeOut = ApplySuggestionResponse.parse(await okMergeRes.json())
    expect(mergeOut.redirectedBacklinkCount).toBe(1)

    const keptAfter = EntryDetailResponse.parse(
      await (
        await app.request(`/v1/console/entries/${dupLongA.entry.shortId}`, { headers: { cookie } })
      ).json(),
    )
    expect(keptAfter.entry.bootMode).toBe('full')
    expect(keptAfter.entry.topics).toEqual(expect.arrayContaining(['gateway', 'docker']))

    const refAfter = EntryDetailResponse.parse(
      await (
        await app.request(`/v1/console/entries/${refDoc.entry.shortId}`, { headers: { cookie } })
      ).json(),
    )
    expect(refAfter.entry.version).toBe(2)
    expect(refAfter.entry.content).toContain(`[[${dupLongA.entry.shortId}|旧网关规范]]`)
    expect(refAfter.entry.content).toContain(`\`[[${dupLongB.entry.shortId}]]\``)
    expect(refAfter.outboundLinks.map((l) => l.shortId)).toEqual([dupLongA.entry.shortId])

    // 2) 验证 link_entries 已过滤非法窄场域引用，且确定性追加到正文并同步 entry_links
    const linkCard = inbox.items.find((i) => i.kind === 'link_entries')!
    expect(linkCard).toBeTruthy()
    expect(linkCard.proposedLinks).toHaveLength(1)
    expect(linkCard.proposedLinks?.[0]?.targetShortId).toBe(linkTarget.entry.shortId)

    const linkApplyRes = await app.request(`/v1/console/inbox/${linkCard.id}/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({}),
    })
    expect(linkApplyRes.status).toBe(200)
    const uniAfter = EntryDetailResponse.parse(
      await (
        await app.request(`/v1/console/entries/${uniEntry.entry.shortId}`, { headers: { cookie } })
      ).json(),
    )
    expect(uniAfter.entry.content).toContain(`[[${linkTarget.entry.shortId}|配套恢复演练]]`)
    expect(uniAfter.outboundLinks.map((l) => l.shortId)).toContain(linkTarget.entry.shortId)

    // 3) 验证 adjust_boot_mode 更新为目录常驻并写回现行概要
    const bootCard = inbox.items.find((i) => i.kind === 'adjust_boot_mode')!
    expect(bootCard).toBeTruthy()
    expect(bootCard.proposedBootMode).toBe('index')
    const bootApplyRes = await app.request(`/v1/console/inbox/${bootCard.id}/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({}),
    })
    expect(bootApplyRes.status).toBe(200)
    const oversizedAfter = EntryDetailResponse.parse(
      await (
        await app.request(`/v1/console/entries/${oversizedFull.entry.shortId}`, {
          headers: { cookie },
        })
      ).json(),
    )
    expect(oversizedAfter.entry.bootMode).toBe('index')
    expect(oversizedAfter.entry.isPinned).toBe(true)
    expect(oversizedAfter.entry.summary).toBe('大型历史参考词典，按需查阅。')

    // 4) 验证会话反向对账产出了 formalTarget 的 update 建议
    expect(
      inbox.items.some(
        (i) =>
          i.kind === 'update' && i.entries.some((e) => e.shortId === formalTarget.entry.shortId),
      ),
    ).toBe(true)
  })

  it('编辑页单条主动规范整理支持 SSE 与 JSON 预览、乐观锁 409、转存待处理与直接应用', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const ref = await entrySvc.create(
      consoleScope,
      entryInput({ title: '关联规范', content: '基础规范说明。' }),
    )
    const target = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '单条整理目标（2026-10-08 变更）',
        content: [
          '# 单条整理目标（2026-10-08 变更）',
          '',
          `服务依赖 {{cred:svc-key}} 与 [[${ref.entry.shortId}]]。`,
          '',
          'Glossary keywords: deploy, service',
        ].join('\n'),
      }),
    )

    fakeAi.setChatHandler(() =>
      JSON.stringify({
        needed: true,
        title: '单条整理目标',
        summary: '记录核心服务依赖与凭据引用。',
        content: `## 服务依赖\n- 凭据：{{cred:svc-key}}\n- 规范：[[${ref.entry.shortId}|关联规范]]`,
        change_summary: '规范标题并去除冗余片段',
        archived_notes: [{ occurred_at: '2026-10-08', note: '完成旧版依赖迁移' }],
        reason: '标题带日期且正文含冗余标题行与词汇表尾注',
      }),
    )

    // 1) SSE 模式预览：返回 stage + result 事件并包含确定性预清洗项
    const sseRes = await app.request(`/v1/console/entries/${target.entry.shortId}/tidy/preview`, {
      method: 'POST',
      headers: { ...consoleHeaders(cookie), accept: 'text/event-stream' },
    })
    expect(sseRes.status).toBe(200)
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream')
    const sseText = await sseRes.text()
    expect(sseText).toContain('event: stage')
    expect(sseText).toContain('event: result')
    const resultBlock = sseText.split('\n\n').find((chunk) => chunk.includes('event: result'))
    const resultJson = resultBlock
      ?.split('\n')
      .find((line) => line.startsWith('data:'))
      ?.slice(5)
      .trim()
    const ssePreview = SingleTidyPreviewResponse.parse(JSON.parse(resultJson!))
    expect(ssePreview.needed).toBe(true)
    expect(ssePreview.preCleanedFixes).toEqual(
      expect.arrayContaining(['strip_duplicate_heading', 'strip_legacy_glossary']),
    )
    expect(ssePreview.integrity.intact).toBe(true)

    // 2) JSON 模式预览
    const jsonRes = await app.request(`/v1/console/entries/${target.entry.shortId}/tidy/preview`, {
      method: 'POST',
      headers: consoleHeaders(cookie),
    })
    expect(jsonRes.status).toBe(200)
    const jsonPreview = SingleTidyPreviewResponse.parse(await jsonRes.json())
    expect(jsonPreview.proposed.title).toBe('单条整理目标')

    // 3) 转存待处理逃生舱：不改原词条版本，写入 pending 建议并反映在详情 pendingSuggestionCount
    const stageRes = await app.request(`/v1/console/entries/${target.entry.shortId}/tidy/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        expectedVersion: jsonPreview.baseVersion,
        title: jsonPreview.proposed.title,
        summary: jsonPreview.proposed.summary,
        content: jsonPreview.proposed.content,
        changeSummary: jsonPreview.proposed.changeSummary,
        archivedNotes: jsonPreview.proposed.archivedNotes,
        stageToInbox: true,
        reason: jsonPreview.reason,
      }),
    })
    expect(stageRes.status).toBe(200)
    const staged = SingleTidyApplyResponse.parse(await stageRes.json())
    expect(staged.stagedSuggestionId).toBeTruthy()
    expect(staged.entry).toBeNull()

    const detailWithPending = EntryDetailResponse.parse(
      await (
        await app.request(`/v1/console/entries/${target.entry.shortId}`, { headers: { cookie } })
      ).json(),
    )
    expect(detailWithPending.entry.version).toBe(1)
    expect(detailWithPending.pendingSuggestionCount).toBe(1)

    // 4) 乐观锁校验：版本不匹配返回 409
    const staleApply = await app.request(`/v1/console/entries/${target.entry.shortId}/tidy/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        expectedVersion: 99,
        title: jsonPreview.proposed.title,
        summary: jsonPreview.proposed.summary,
        content: jsonPreview.proposed.content,
      }),
    })
    expect(staleApply.status).toBe(409)

    // 5) 直接应用并附带历史里程碑归档
    const directRes = await app.request(`/v1/console/entries/${target.entry.shortId}/tidy/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        expectedVersion: 1,
        title: jsonPreview.proposed.title,
        summary: jsonPreview.proposed.summary,
        content: jsonPreview.proposed.content,
        changeSummary: jsonPreview.proposed.changeSummary,
        archivedNotes: jsonPreview.proposed.archivedNotes,
        applyArchivedNotes: true,
      }),
    })
    expect(directRes.status).toBe(200)
    const directOut = SingleTidyApplyResponse.parse(await directRes.json())
    expect(directOut.stagedSuggestionId).toBeNull()
    expect(directOut.entry?.entry.version).toBe(2)
    expect(directOut.entry?.entry.title).toBe('单条整理目标')

    const history = await entrySvc.history(consoleScope, target.entry.shortId)
    expect(history.items.some((i) => i.eventType === 'archive_note')).toBe(true)
  })

  it('单条查重与关联端点以当前记忆为锚点并返回可即时审核的建议', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const anchor = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '容器构建加速方案',
        content: '通过缓存层目录显著提升镜像构建速度。',
        topics: ['docker'],
      }),
    )
    const neighbor = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'Docker 构建缓存指南',
        content: '利用 BuildKit 挂载目录缓存包管理器下载。',
        topics: ['docker'],
      }),
    )

    const vecA = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
    const vecB = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
    vecA[0] = 1
    vecB[0] = 0.78
    vecB[1] = Math.sqrt(1 - 0.78 * 0.78)
    await database.db.insert(entryEmbeddings).values([
      { entryId: anchor.entry.id, model: 'fake-embed', contentHash: 'h-a', embedding: vecA },
      { entryId: neighbor.entry.id, model: 'fake-embed', contentHash: 'h-b', embedding: vecB },
    ])

    fakeAi.setChatHandler(() =>
      JSON.stringify({
        suggestions: [
          {
            kind: 'link_entries',
            target_short_ids: [anchor.entry.shortId],
            proposed_links: [
              {
                target_short_id: neighbor.entry.shortId,
                relation: '补充缓存配置',
                reason: '互补的容器构建加速文档',
              },
            ],
            reason: '关联互补的容器缓存指南',
          },
        ],
      }),
    )

    const res = await app.request(`/v1/console/entries/${anchor.entry.shortId}/cross-check`, {
      method: 'POST',
      headers: consoleHeaders(cookie),
    })
    expect(res.status).toBe(200)
    const body = SingleCrossCheckResponse.parse(await res.json())
    expect(body.shortId).toBe(anchor.entry.shortId)
    expect(body.consideredNeighbors).toBeGreaterThanOrEqual(1)
    expect(body.createdCount).toBe(1)
    expect(body.suggestions).toHaveLength(1)
    expect(body.suggestions[0]?.kind).toBe('link_entries')
    expect(body.suggestions[0]?.proposedLinks?.[0]?.targetShortId).toBe(neighbor.entry.shortId)
  })

  it('审查回归：阻断模型空 realms 放宽场域、截断词条整篇覆写、跨场域合并事务防线，并支持 adjust_boot_mode 编辑覆盖与同版本重复暂存', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    const app = createTestApp(database, { masterKey })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const workEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '工作场域内部规范',
        content: '内部网关地址 127.0.0.1，仅限工作场域。',
        realms: ['work'],
        topics: ['gateway'],
        bootMode: 'full',
      }),
    )
    const personalEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '个人场域备忘',
        content: '家庭网络说明。',
        realms: ['personal'],
      }),
    )

    // 1) 模型对 work 词条输出 realms: [] 与 topics: [] 时，严禁放宽为通用或清空原标签
    fakeAi.setChatHandler(() =>
      JSON.stringify({
        suggestions: [
          {
            kind: 'update',
            target_short_ids: [workEntry.entry.shortId],
            title: '工作场域内部规范',
            content: '内部网关地址 127.0.0.1，端口 8080。',
            realms: [],
            topics: [],
            reason: '补充端口说明',
          },
          {
            kind: 'adjust_boot_mode',
            target_short_ids: [workEntry.entry.shortId],
            proposed_boot_mode: 'index',
            summary: '工作场域网关端口与访问规范。',
            reason: '降级为目录常驻',
          },
        ],
      }),
    )
    const run = await runDream(database.db, masterKey, {
      runId: 'sec-realm-guard',
      trigger: 'manual',
      mode: 'standard',
    })
    expect(run.suggested).toBe(2)

    const inbox = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    const updateCard = inbox.items.find((i) => i.kind === 'update')!
    expect(updateCard.proposedRealms).toBeNull()
    expect(updateCard.proposedTopics).toBeNull()

    const applyUpdateRes = await app.request(`/v1/console/inbox/${updateCard.id}/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({}),
    })
    expect(applyUpdateRes.status).toBe(200)
    const afterUpdate = EntryDetailResponse.parse(
      await (
        await app.request(`/v1/console/entries/${workEntry.entry.shortId}`, {
          headers: { cookie },
        })
      ).json(),
    )
    expect(afterUpdate.entry.realms).toEqual(['work'])
    expect(afterUpdate.entry.topics).toEqual(['gateway'])

    // 2) adjust_boot_mode 编辑后应用支持保留用户补充的场景范围（projects）而非静默丢弃
    const bootEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '待限定范围常驻规范',
        content: '仅适用于 sample-app 项目的构建命令。',
        bootMode: 'full',
      }),
    )
    fakeAi.setChatHandler(() =>
      JSON.stringify({
        suggestions: [
          {
            kind: 'adjust_boot_mode',
            target_short_ids: [bootEntry.entry.shortId],
            proposed_boot_mode: 'index',
            summary: 'sample-app 构建命令摘要。',
            reason: '篇幅偏长建议降级',
          },
        ],
      }),
    )
    await runDream(database.db, masterKey, {
      runId: 'boot-edit-override',
      trigger: 'manual',
      mode: 'standard',
    })
    const inbox2 = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    const bootCard = inbox2.items.find(
      (i) => i.kind === 'adjust_boot_mode' && i.entries[0]?.shortId === bootEntry.entry.shortId,
    )!
    const editBootRes = await app.request(`/v1/console/inbox/${bootCard.id}/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        bootMode: 'full',
        projects: ['sample-app'],
        summary: 'sample-app 专属构建规范。',
      }),
    })
    expect(editBootRes.status).toBe(200)
    const afterBootEdit = EntryDetailResponse.parse(
      await (
        await app.request(`/v1/console/entries/${bootEntry.entry.shortId}`, {
          headers: { cookie },
        })
      ).json(),
    )
    expect(afterBootEdit.entry.bootMode).toBe('full')
    expect(afterBootEdit.entry.projects).toEqual(['sample-app'])
    expect(afterBootEdit.entry.summary).toBe('sample-app 专属构建规范。')

    // 3) 事务内防线：即使库里存在脏跨场域 merge_duplicates 建议，apply 也必须以 400 拒绝
    const [dirtyMerge] = await database.db
      .insert(dreamSuggestions)
      .values({
        kind: 'merge_duplicates',
        entryIds: [workEntry.entry.id, personalEntry.entry.id],
        entryVersions: [afterUpdate.entry.version, personalEntry.entry.version],
        keepId: workEntry.entry.id,
        proposedTitle: '非法跨场域合并',
        proposedContent: '内部网关地址 127.0.0.1，端口 8080。家庭网络说明。',
        reason: '脏数据测试',
        fingerprint: 'dirty-cross-realm-merge-test',
        status: 'pending',
      })
      .returning({ id: dreamSuggestions.id })
    const dirtyRes = await app.request(`/v1/console/inbox/${dirtyMerge!.id}/apply`, {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({}),
    })
    expect(dirtyRes.status).toBe(400)

    // 4) 同版本连续两次 stageToInbox 平滑覆盖复用同一指纹，不会触发 500 或产生重复卡片
    const stagePayload = {
      expectedVersion: bootEntry.entry.version + 1,
      title: 'sample-app 构建命令',
      summary: '第一次暂存概要',
      content: '仅适用于 sample-app 项目的构建命令。',
      stageToInbox: true,
    }
    const stage1 = SingleTidyApplyResponse.parse(
      await (
        await app.request(`/v1/console/entries/${bootEntry.entry.shortId}/tidy/apply`, {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify(stagePayload),
        })
      ).json(),
    )
    const stage2 = SingleTidyApplyResponse.parse(
      await (
        await app.request(`/v1/console/entries/${bootEntry.entry.shortId}/tidy/apply`, {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({ ...stagePayload, summary: '第二次暂存更新概要' }),
        })
      ).json(),
    )
    expect(stage2.stagedSuggestionId).toBe(stage1.stagedSuggestionId)
  })

  it('手动取消整理任务时立即中止并记录为 cancelled，保留已生成建议且支持取消接口', async () => {
    const masterKey = testMasterKey()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const first = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '取消测试词条一（2026-10-01）',
        content: '第一条待规范正文内容。',
      }),
    )
    const second = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '取消测试词条二（2026-10-02）',
        content: '第二条待规范正文内容。',
      }),
    )

    const third = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '取消测试词条三（2026-10-03）',
        content: '第三条待规范正文内容。',
      }),
    )

    const controller = new AbortController()
    let calls = 0
    fakeAi.setChatHandler(() => {
      calls++
      if (calls === 1) {
        return JSON.stringify({
          needed: true,
          title: '取消测试词条一',
          summary: '第一条概要。',
          content: '第一条待规范正文内容。',
          change_summary: '规范标题',
          archived_notes: [],
          reason: '去日期',
        })
      }
      if (calls === 2) {
        controller.abort('user_cancelled')
        return JSON.stringify({ needed: false, reason: '已中止' })
      }
      throw new Error('取消后不应继续调用模型')
    })

    const res = await runDream(database.db, masterKey, {
      runId: 'tidy-manual-cancel',
      trigger: 'manual',
      mode: 'tidy',
      targetShortIds: [first.entry.shortId, second.entry.shortId, third.entry.shortId],
      concurrency: 1,
      signal: controller.signal,
    })

    expect(calls).toBe(2)
    expect(res.outcome).toBe('cancelled')
    expect(res.error).toBeNull()
    expect(res.abortedReason).toBe('已手动取消')
    expect(res.suggested).toBe(1)
    expect(res.failedItems).toEqual([])

    let dreamCancelled = false
    let backfillCancelled = false
    const app = createTestApp(database, {
      masterKey,
      jobs: {
        enqueueEmbed: () => undefined,
        enqueueBackfill: async () => true,
        getEmbeddingBackfillState: () => ({
          running: true,
          processed: 3,
          total: 10,
          model: 'fake-embed',
          lastFinishedAt: null,
          lastOutcome: null,
          lastUpdatedCount: 0,
          lastError: null,
        }),
        cancelEmbeddingBackfill: async () => {
          backfillCancelled = true
          return true
        },
        enqueueExtraction: async () => undefined,
        enqueueDream: async () => 'job-1',
        isDreamRunning: async () => false,
        cancelDream: async () => {
          dreamCancelled = true
          return true
        },
        enqueueCleanup: async () => true,
      },
    })
    const { cookie } = await createOwnerSession(database)

    const inbox = InboxResponse.parse(
      await (await app.request('/v1/console/inbox', { headers: { cookie } })).json(),
    )
    expect(inbox.dreamState.lastOutcome).toBe('cancelled')
    expect(inbox.pendingCount).toBe(1)
    expect(inbox.embeddingBackfill?.running).toBe(true)
    expect(inbox.embeddingBackfill?.processed).toBe(3)
    expect(inbox.embeddingBackfill?.total).toBe(10)

    const cancelDreamRes = await app.request('/v1/console/dream/cancel', {
      method: 'POST',
      headers: consoleHeaders(cookie),
    })
    expect(cancelDreamRes.status).toBe(200)
    expect(await cancelDreamRes.json()).toEqual({ cancelled: true })
    expect(dreamCancelled).toBe(true)

    const cancelBackfillRes = await app.request('/v1/console/settings/embedding/backfill/cancel', {
      method: 'POST',
      headers: consoleHeaders(cookie),
    })
    expect(cancelBackfillRes.status).toBe(200)
    expect(await cancelBackfillRes.json()).toEqual({ cancelled: true })
    expect(backfillCancelled).toBe(true)
  })
})
