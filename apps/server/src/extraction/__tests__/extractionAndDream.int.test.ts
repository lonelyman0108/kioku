import { ApplySuggestionResponse, InboxResponse } from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import { apiKeys, entries, turnBuffer } from '../../db/schema'
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
import { loadInbox, runDream } from '../dream'
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
})
