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
import { startFakeOpenAi, type FakeOpenAiServer } from '../../testing/fakeOpenAi'
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

    // 先验证完整性守卫：丢失凭据占位符的草案必须被静默丢弃
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
})
