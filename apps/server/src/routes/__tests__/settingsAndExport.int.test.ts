import {
  ModelsSettingsResponse,
  RebuildEmbeddingsResponse,
  TestModelResponse,
} from '@kioku/contracts'
import { count, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import { deviceGrants, entries, entryEmbeddings, sessions } from '../../db/schema'
import { embedEntryIds } from '../../embedding/worker'
import { cleanupExpired } from '../../jobs/cleanup'
import { EntryService } from '../../memory/service'
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
import { startFakeOpenAi, type FakeOpenAiServer } from '../../testing/fakeOpenAi'

describe.skipIf(!testDatabaseUrl)('模型设置、向量回填、数据导出与过期清理', () => {
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

  it('保存与测试模型配置、切换嵌入模型时清空旧向量并触发回填、导出永不泄露原始凭据', async () => {
    const masterKey = testMasterKey()
    let backfillCalls = 0
    const app = createTestApp(database, {
      masterKey,
      jobs: {
        enqueueEmbed: () => {},
        enqueueBackfill: async () => {
          backfillCalls++
          return true
        },
        enqueueExtraction: async () => {},
        enqueueDream: async () => 'run-1',
        isDreamRunning: async () => false,
        enqueueCleanup: async () => true,
      },
    })
    const { cookie } = await createOwnerSession(database)
    const credSvc = new CredentialService(database.db, masterKey)
    const entrySvc = new EntryService(database.db, masterKey, credSvc, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    // 写入一条记忆与一条敏感凭据
    const created = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '架构备忘',
        content: '使用 {{cred:aws-key}} 访问对象存储。',
        isPinned: true,
        topics: ['storage'],
      }),
    )
    await credSvc.create({
      slug: 'aws-key',
      label: 'AWS Key',
      value: 'AKIA_SUPER_SECRET_NEVER_EXPORT',
      allowedRealms: ['work'],
    })

    // 1. PUT 保存嵌入与对话模型（验证 API Key 加密落库、返回仅 hasApiKey=true）
    const put1 = await app.request('/v1/console/settings/models', {
      method: 'PUT',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        embedding: {
          baseUrl: fakeAi.baseUrl,
          model: 'embed-model-a',
          apiKey: 'sk-embed-secret',
          enabled: true,
        },
        chatLlm: {
          baseUrl: fakeAi.baseUrl,
          model: 'chat-model-a',
          apiKey: 'sk-chat-secret',
          enabled: true,
          reasoningEffort: 'medium',
          taskReasoningEffort: { fast: 'off', organize: 'high' },
        },
        dream: { enabled: true, intervalHours: 12 },
      }),
    })
    expect(put1.status).toBe(200)
    const body1 = ModelsSettingsResponse.parse(await put1.json())
    expect(body1.embedding?.hasApiKey).toBe(true)
    expect(body1.chatLlm?.hasApiKey).toBe(true)
    expect(body1.chatLlm?.reasoningEffort).toBe('medium')
    expect(body1.chatLlm?.taskReasoningEffort).toEqual({ fast: 'off', organize: 'high' })
    expect(body1.dream).toEqual({ enabled: true, intervalHours: 12 })
    expect(backfillCalls).toBe(1)

    // 计算当前模型向量并验证覆盖度
    await embedEntryIds(database.db, masterKey, [created.entry.id])
    const getAfterEmbed = ModelsSettingsResponse.parse(
      await (await app.request('/v1/console/settings/models', { headers: { cookie } })).json(),
    )
    expect(getAfterEmbed.embeddingCoverage).toEqual({
      total: 1,
      embedded: 1,
      model: 'embed-model-a',
    })

    // 2. 测试模型连通性（复用已保存的加密 API Key）
    const testEmbed = await app.request('/v1/console/settings/models/test', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        kind: 'embedding',
        baseUrl: fakeAi.baseUrl,
        model: 'embed-model-a',
        useSavedKey: true,
      }),
    })
    expect(testEmbed.status).toBe(200)
    const testEmbedBody = TestModelResponse.parse(await testEmbed.json())
    expect(testEmbedBody.ok).toBe(true)
    expect(testEmbedBody.dimensions).toBe(1024)

    const testChat = await app.request('/v1/console/settings/models/test', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        kind: 'chat_llm',
        baseUrl: fakeAi.baseUrl,
        model: 'chat-model-a',
        useSavedKey: true,
        reasoningEffort: 'high',
      }),
    })
    expect(testChat.status).toBe(200)
    expect(TestModelResponse.parse(await testChat.json()).ok).toBe(true)
    const lastChatReq = fakeAi.requests.filter((r) => r.path.endsWith('/chat/completions')).at(-1)
    expect((lastChatReq?.body as Record<string, unknown>)?.reasoning_effort).toBe('high')

    // 清除按任务覆盖
    const clearOverride = await app.request('/v1/console/settings/models', {
      method: 'PUT',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        chatLlm: {
          baseUrl: fakeAi.baseUrl,
          model: 'chat-model-a',
          enabled: true,
          reasoningEffort: 'default',
          taskReasoningEffort: null,
        },
      }),
    })
    expect(clearOverride.status).toBe(200)
    const clearedBody = ModelsSettingsResponse.parse(await clearOverride.json())
    expect(clearedBody.chatLlm?.reasoningEffort).toBe('default')
    expect(clearedBody.chatLlm?.taskReasoningEffort).toBeUndefined()

    // 3. 切换嵌入模型名：必须清空旧向量并再次触发回填
    const put2 = await app.request('/v1/console/settings/models', {
      method: 'PUT',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        embedding: {
          baseUrl: fakeAi.baseUrl,
          model: 'embed-model-b',
          enabled: true,
        },
      }),
    })
    expect(put2.status).toBe(200)
    const [embCount] = await database.db.select({ n: count() }).from(entryEmbeddings)
    expect(embCount?.n).toBe(0)
    expect(backfillCalls).toBe(2)

    // 手动触发向量回填
    const backfillRes = await app.request('/v1/console/settings/embedding/backfill', {
      method: 'POST',
      headers: consoleHeaders(cookie),
    })
    expect(backfillRes.status).toBe(200)
    expect(RebuildEmbeddingsResponse.parse(await backfillRes.json()).queued).toBe(1)

    // 4. 导出 JSON 与 Markdown：包含记忆与占位符，绝对不包含真实凭据明文
    const jsonExport = await app.request('/v1/console/export?format=json', {
      headers: { cookie },
    })
    expect(jsonExport.status).toBe(200)
    const jsonText = await jsonExport.text()
    expect(jsonText).toContain(created.entry.shortId)
    expect(jsonText).toContain('{{cred:aws-key}}')
    expect(jsonText).not.toContain('AKIA_SUPER_SECRET_NEVER_EXPORT')

    const mdExport = await app.request('/v1/console/export?format=markdown', {
      headers: { cookie },
    })
    expect(mdExport.status).toBe(200)
    const mdText = await mdExport.text()
    expect(mdText).toContain('架构备忘')
    expect(mdText).not.toContain('AKIA_SUPER_SECRET_NEVER_EXPORT')
  })

  it('cleanupExpired 清理过期会话、过期设备授权与超期回收站词条，保留有效记录', async () => {
    const { accountId } = await createOwnerSession(database)
    const past = new Date(Date.now() - 35 * 86_400_000)

    await database.db.insert(sessions).values({
      accountId,
      tokenHash: 'expired-session-hash',
      expiresAt: new Date(Date.now() - 60_000),
    })
    await database.db.insert(deviceGrants).values({
      deviceHash: 'expired-device-hash',
      userHash: 'expired-user-hash',
      runtimeFamily: 'claudecode',
      clientKey: 'ip:127.0.0.1',
      expiresAt: new Date(Date.now() - 60_000),
    })
    await database.db.insert(entries).values({
      shortId: 'm-abc222',
      kind: 'entry',
      title: '超期软删',
      content: '应被清理',
      deletedAt: past,
    })
    await database.db.insert(entries).values({
      shortId: 'm-def222',
      kind: 'entry',
      title: '正常词条',
      content: '应保留',
    })

    const cleaned = await cleanupExpired(database.db)
    expect(cleaned.sessions).toBe(1)
    expect(cleaned.deviceGrants).toBe(1)
    expect(cleaned.entries).toBe(1)

    const remaining = await database.db
      .select({ shortId: entries.shortId })
      .from(entries)
      .where(sql`true`)
    expect(remaining.map((r) => r.shortId)).toEqual(['m-def222'])
  })
})
