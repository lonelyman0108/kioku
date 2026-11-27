import { LifecycleEventResponse } from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import { turnBuffer } from '../../db/schema'
import { EntryService } from '../../memory/service'
import { CHAT_LLM_SETTING_KEY, saveModelEndpoint } from '../../models/store'
import {
  createTestApp,
  entryInput,
  issueTestApiKey,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'
import { HOST_CONTEXT_LIMIT, hostOutput } from '../lifecycle'

describe('hostOutput 宿主输出格式兼容', () => {
  it('按运行时返回与已部署插件一致的 hostOutput 结构，并为主流客户端配置上下文上限', () => {
    expect(HOST_CONTEXT_LIMIT).toMatchObject({
      claudecode: 9_500,
      codex: 9_500,
      agy: 11_000,
      gemini: 11_000,
      opencode: 11_000,
      pi: 11_000,
    })
    expect(hostOutput('claudecode', 'session.start', 'ctx')).toEqual({
      mode: 'stdout_json',
      value: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } },
    })
    expect(hostOutput('claudecode', 'prompt.submit', 'ctx')).toEqual({
      mode: 'stdout_text',
      value: 'ctx',
    })
    expect(hostOutput('codex', 'prompt.submit', 'ctx')).toEqual({
      mode: 'stdout_json',
      value: {
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'ctx' },
      },
    })
    expect(hostOutput('gemini', 'prompt.submit', 'ctx')).toEqual({
      mode: 'stdout_json',
      value: { hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: 'ctx' } },
    })
    expect(hostOutput('agy', 'session.start', 'ctx')).toEqual({
      mode: 'stdout_json',
      value: { injectSteps: [{ systemMessage: { systemMessage: 'ctx' } }] },
    })
    expect(hostOutput('opencode', 'session.start', 'ctx')).toEqual({
      mode: 'return_value',
      value: { context: 'ctx' },
    })
    expect(hostOutput('claudecode', 'prompt.submit', '   ')).toEqual({
      mode: 'none',
      value: null,
    })
  })
})

describe.skipIf(!testDatabaseUrl)('生命周期事件接口 /v1/lifecycle/event', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await database.close()
  })

  it('完整处理 session.start、prompt.submit 与 turn.end，并静默兼容旧版 context 字段', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const entrySvc = new EntryService(
      database.db,
      masterKey,
      new CredentialService(database.db, masterKey),
      null,
    )
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const pinned = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '代码风格',
        content: '使用 TypeScript 严格模式与 pnpm。',
        isPinned: true,
        envs: ['mac'],
      }),
    )
    const recallTarget = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'pgvector 索引构建参数',
        content: 'HNSW 索引采用 vector_cosine_ops 算子。',
        disclosure: '排查向量检索性能或重建索引时参考',
        envs: ['mac'],
      }),
    )

    const key = await issueTestApiKey(database, {
      runtimeFamily: 'claudecode',
      envs: ['mac'],
      canWrite: true,
    })

    // 1. session.start 返回常驻记忆与指南（含旧插件附带的多余 context 字段不报错）
    const startRes = await app.request('/v1/lifecycle/event', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        event: 'session.start',
        sessionId: 'sess-1',
        deviceKey: 'dev-mac',
        project: { repoName: 'kioku' },
        context: { chatType: 'direct', legacyExtraField: 'ignored' },
      }),
    })
    expect(startRes.status).toBe(200)
    const started = LifecycleEventResponse.parse(await startRes.json())
    expect(started.hostOutput.mode).toBe('stdout_json')
    expect(started.shortIds).toContain(pinned.entry.shortId)

    // 2. prompt.submit 召回关联记忆
    const promptRes = await app.request('/v1/lifecycle/event', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        event: 'prompt.submit',
        sessionId: 'sess-1',
        prompt: 'pgvector HNSW 索引参数怎么配？',
      }),
    })
    expect(promptRes.status).toBe(200)
    const prompted = LifecycleEventResponse.parse(await promptRes.json())
    expect(prompted.hostOutput.mode).toBe('stdout_text')
    expect(prompted.shortIds).toContain(recallTarget.entry.shortId)
    expect(String(prompted.hostOutput.value)).toContain('<recall session_id="sess-1">')
    expect(String(prompted.hostOutput.value)).toContain('pgvector 索引构建参数')

    // 3. turn.end 启用对话模型后写入缓冲表
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      enabled: true,
    })
    const turnRes = await app.request('/v1/lifecycle/event', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        event: 'turn.end',
        sessionId: 'sess-1',
        deviceKey: 'dev-mac',
        project: { dirName: '/work/kioku' },
        user: '我们决定了什么？',
        reply: '统一采用扁平记忆结构。',
      }),
    })
    expect(turnRes.status).toBe(200)
    const turned = LifecycleEventResponse.parse(await turnRes.json())
    expect(turned.hostOutput).toEqual({ mode: 'none', value: null })
    expect(await database.db.select().from(turnBuffer)).toHaveLength(1)
  })

  it('session.start 支持自定义 runtime 覆盖、过滤跨项目近期记录并将本项目非常驻词条优先补入相关目录', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const entrySvc = new EntryService(
      database.db,
      masterKey,
      new CredentialService(database.db, masterKey),
      null,
    )
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const zcodePinned = await entrySvc.create(
      consoleScope,
      entryInput({
        title: 'ZCode 专属约定',
        content: '仅在 zcode 会话生效。',
        bootMode: 'full',
        runtimes: ['zcode'],
      }),
    )
    const indexManual = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '网络分层参考手册',
        summary: '主路由与分流规则速查。',
        content: '长篇参考内容。',
        bootMode: 'index',
      }),
    )
    const projUnpinned = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '核心模块接口清单',
        summary: '列出本仓库对外接口约定。',
        content: '详细接口说明，正文不重复项目名。',
        projects: ['demo-proj'],
      }),
    )
    await entrySvc.create(
      consoleScope,
      entryInput({
        title: '其他项目排错记录',
        content: '不应泄露到当前项目的近期更新。',
        projects: ['unrelated-proj'],
      }),
    )

    const key = await issueTestApiKey(database, {
      runtimeFamily: 'generic',
      envs: ['mac'],
      canWrite: true,
    })

    const res = await app.request('/v1/lifecycle/event', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        event: 'session.start',
        sessionId: 'sess-zcode',
        runtime: 'zcode',
        project: { repoName: 'org/demo-proj', dirName: '/work/demo-proj-wt' },
      }),
    })
    expect(res.status).toBe(200)
    const body = LifecycleEventResponse.parse(await res.json())
    const text = String((body.hostOutput.value as { context?: string }).context ?? '')
    expect(body.shortIds).toContain(zcodePinned.entry.shortId)
    expect(body.shortIds).toContain(projUnpinned.entry.shortId)
    expect(text).toContain('ZCode 专属约定')
    expect(text).toContain('网络分层参考手册')
    expect(text).toContain('## 当前项目相关记忆')
    expect(text).toContain('核心模块接口清单')
    expect(text).toContain('列出本仓库对外接口约定。')
    expect(text).not.toContain('其他项目排错记录')
    // 目录常驻项与已入选当前项目相关的条目不重复出现在「近期更新的记忆」
    const recentIdx = text.indexOf('## 近期更新的记忆')
    if (recentIdx >= 0) {
      expect(text.slice(recentIdx)).not.toContain(indexManual.entry.shortId)
      expect(text.slice(recentIdx)).not.toContain(projUnpinned.entry.shortId)
    }

    // claudecode 密钥覆盖为自定义 runtime 时，仍回退沿用 claudecode 宿主上限，且目录用量不超过目录预算
    const claudeKey = await issueTestApiKey(database, {
      runtimeFamily: 'claudecode',
      envs: ['mac'],
      canWrite: true,
    })
    const preview = await entrySvc.previewBoot({
      keyId: claudeKey.id,
      runtime: 'zcode',
      project: 'demo-proj',
    })
    expect(preview.runtimeFamily).toBe('zcode')
    expect(preview.hostLimit).toBe(9_500)
    expect(preview.usedCatalogChars).toBeLessThanOrEqual(preview.catalogBudget)
  })
})
