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
import { hostOutput } from '../lifecycle'

describe('hostOutput 宿主输出格式兼容', () => {
  it('按运行时返回与已部署插件一致的 hostOutput 结构', () => {
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
})
