import { randomBytes } from 'node:crypto'

import { asc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { detectWithPrivacyModel, loadPrivacyModelConfig } from '../../credential/privacy'
import { withSpace, type Database } from '../../db/client'
import { conversationTurns, dreamRuns, extractionRuns, memories, settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { type BufferedSession } from '../../extraction/buffer'
import { dreamSpace } from '../../extraction/dream'
import { processSession } from '../../extraction/worker'
import type { Jobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { startFakeChatServer, type FakeChatServer } from '../../testing/fakeChatServer'
import { bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import {
  createModelProvider,
  saveDreamBinding,
  saveExtractionBinding,
  savePrivacyBinding,
} from '../store'

describe.skipIf(!testDatabaseUrl)('模型消费者（抽取、整理、隐私识别）Fallback 与绑定行为', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let appId: string
  let key: string
  const masterKey = randomBytes(32)
  const servers: FakeChatServer[] = []
  const jobs: Jobs = {
    enqueueEmbed() {},
    enqueueBackfill: async () => true,
    enqueueSwitch: async () => true,
    enqueuePrune: async () => true,
    enqueueBackup: async () => null,
    backupRun: async () => null,
    enqueueExtraction: async () => {},
    enqueueCleanup: async () => true,
    enqueueDream: async () => null,
    dreamRun: async () => null,
  }

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs,
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()))
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    ws = await bootstrap(app)
    appId = (await ws.createApp('qq-bot', { runtimeFamily: 'astrbot' })).id
    key = await ws.issueKey(appId)
  })

  async function addChatProvider(name: string, baseUrl: string, model: string, apiKey: string) {
    const { provider } = await createModelProvider(database.db, masterKey, {
      name,
      format: 'openai-chat',
      baseUrl,
      apiKey,
      profiles: [
        {
          kind: 'chat',
          label: model,
          model,
          thinking: 'default',
          thinkingStyle: 'auto',
          maxTokens: null,
        },
      ],
    })
    return provider.profiles[0]!.id
  }

  async function enqueueTurn(userText = '我叫林晓，住在杭州市西湖区') {
    const res = await app.request(
      '/v1/lifecycle/event',
      jsonRequest(
        'POST',
        {
          event: 'turn.end',
          sessionId: 's',
          context: {
            chatType: 'direct',
            platform: 'qq',
            sender: { id: '1001', name: '林晓' },
          },
          user: userText,
          reply: '好的',
        },
        bearer(key),
      ),
    )
    expect(res.status).toBe(200)
    const turns = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(conversationTurns).orderBy(asc(conversationTurns.id)),
    )
    const target: BufferedSession = { spaceId: ws.spaceId, appId, scope: turns[0]!.scope }
    return target
  }

  it('抽取主顺位返回 500 时自动切换到备用顺位，并在抽取记录里记下实际命中的模型', async () => {
    const primary = await startFakeChatServer(() => ({ raw: '{"error":"boom"}', status: 500 }))
    const backup = await startFakeChatServer(() =>
      JSON.stringify({
        facts: [{ op: 'add', subject: 'S1', content: '喜欢喝乌龙茶', quote: '我喜欢喝乌龙茶' }], // lint-comments: allow
        episode: '聊了喜欢的茶',
      }),
    )
    servers.push(primary, backup)

    const p1 = await addChatProvider('主服务商', primary.url, 'primary-extract', 'sk-1')
    const p2 = await addChatProvider('备服务商', backup.url, 'backup-extract', 'sk-2')
    await saveExtractionBinding(database.db, { profileIds: [p1, p2] })

    const target = await enqueueTurn('我喜欢喝乌龙茶')
    await processSession(database.db, masterKey, target)

    expect(primary.requests).toHaveLength(1)
    expect(backup.requests).toHaveLength(1)

    const runs = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(extractionRuns).orderBy(asc(extractionRuns.id)),
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]?.model).toBe('backup-extract')
    expect(runs[0]?.error).toBeNull()
  })

  it('抽取主顺位正常返回非 JSON 内容时视为业务输出解析失败，不再切换到备用顺位', async () => {
    const primary = await startFakeChatServer(() => 'not valid json output')
    const backup = await startFakeChatServer(() =>
      JSON.stringify({ facts: [], episode: '不应触发' }),
    )
    servers.push(primary, backup)

    const p1 = await addChatProvider('主服务商', primary.url, 'primary-bad-output', 'sk-1')
    const p2 = await addChatProvider('备服务商', backup.url, 'backup-unused', 'sk-2')
    await saveExtractionBinding(database.db, { profileIds: [p1, p2] })

    const target = await enqueueTurn('今天天气不错')
    await processSession(database.db, masterKey, target)

    expect(primary.requests).toHaveLength(1)
    expect(backup.requests).toHaveLength(0)

    const runs = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(extractionRuns).orderBy(asc(extractionRuns.id)),
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]?.model).toBe('primary-bad-output')
    expect(runs[0]?.error).toBeTruthy()
  })

  it('Dream 默认跟随抽取链路，切换为自定义链路后使用自己的备用链并记录命中模型', async () => {
    const extractPrimary = await startFakeChatServer(() => ({
      raw: '{"error":"down"}',
      status: 502,
    }))
    const extractFallback = await startFakeChatServer(() => JSON.stringify({ suggestions: [] }))
    const dreamCustom = await startFakeChatServer(() => JSON.stringify({ suggestions: [] }))
    servers.push(extractPrimary, extractFallback, dreamCustom)

    const ep1 = await addChatProvider('抽取主', extractPrimary.url, 'ext-p', 'sk-e1')
    const ep2 = await addChatProvider('抽取备', extractFallback.url, 'ext-fb', 'sk-e2')
    const dp = await addChatProvider('整理专用', dreamCustom.url, 'dream-only', 'sk-d1')
    await saveExtractionBinding(database.db, { profileIds: [ep1, ep2] })

    // 写入几条同范围的记忆以触发 Dream
    for (let i = 0; i < 3; i++) {
      const res = await app.request(
        '/v1/memories',
        jsonRequest(
          'POST',
          { uri: `core://note-${i}`, content: `整理待评估记录 ${i}` },
          bearer(key),
        ),
      )
      expect(res.status).toBe(201)
    }

    const inheritOutcome = await dreamSpace(database.db, masterKey, {
      spaceId: ws.spaceId,
      runId: '11111111-1111-1111-1111-111111111111',
      trigger: 'manual',
    })
    expect(inheritOutcome).toEqual({ outcome: 'done', reason: null })
    expect(extractPrimary.requests).toHaveLength(1)
    expect(extractFallback.requests).toHaveLength(1)
    expect(dreamCustom.requests).toHaveLength(0)

    let dRuns = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(dreamRuns).orderBy(asc(dreamRuns.createdAt)),
    )
    expect(dRuns.some((r) => r.model === 'ext-fb')).toBe(true)

    // 再新增一条记忆并切换为自定义整理模型
    await saveDreamBinding(database.db, { mode: 'custom', profileIds: [dp] })
    const res4 = await app.request(
      '/v1/memories',
      jsonRequest(
        'POST',
        { uri: 'core://note-next', content: '新增记忆触发第二次整理' },
        bearer(key),
      ),
    )
    expect(res4.status).toBe(201)

    const customOutcome = await dreamSpace(database.db, masterKey, {
      spaceId: ws.spaceId,
      runId: '22222222-2222-2222-2222-222222222222',
      trigger: 'manual',
    })
    expect(customOutcome).toEqual({ outcome: 'done', reason: null })
    expect(dreamCustom.requests).toHaveLength(1)

    dRuns = await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .select()
        .from(dreamRuns)
        .where(eq(dreamRuns.runId, '22222222-2222-2222-2222-222222222222')),
    )
    expect(dRuns.some((r) => r.model === 'dream-only')).toBe(true)
    expect(
      await withSpace(database.db, ws.spaceId, (tx) => tx.select().from(memories)),
    ).toHaveLength(4)
  })

  it('隐私识别启用已配置对话模型模式时支持顺位 Fallback，并响应外部 AbortSignal 取消而不重试备用顺位', async () => {
    const primary = await startFakeChatServer(() => ({
      raw: '{"error":"unavailable"}',
      status: 503,
    }))
    const backup = await startFakeChatServer(() =>
      JSON.stringify({
        entities: [{ text: '张敏', label: 'person', score: 0.95 }],
      }),
    )
    const hanging = await startFakeChatServer(() => ({ hang: true }))
    const unusedBackup = await startFakeChatServer(() => JSON.stringify({ entities: [] }))
    servers.push(primary, backup, hanging, unusedBackup)

    const p1 = await addChatProvider('隐私主', primary.url, 'priv-p', 'sk-p1')
    const p2 = await addChatProvider('隐私备', backup.url, 'priv-fb', 'sk-p2')
    await savePrivacyBinding(database.db, masterKey, {
      mode: 'model',
      profileIds: [p1, p2],
      minScore: 0.6,
    })

    const cfg = await loadPrivacyModelConfig(database.db, masterKey)
    expect(cfg?.mode).toBe('model')
    const spans = await detectWithPrivacyModel(cfg!, '联系张敏处理合同')
    expect(spans).toEqual([{ start: 2, end: 4, kind: 'person' }])
    expect(primary.requests).toHaveLength(1)
    expect(backup.requests).toHaveLength(1)

    const h1 = await addChatProvider('挂起主', hanging.url, 'priv-hang', 'sk-h1')
    const h2 = await addChatProvider('备用未触发', unusedBackup.url, 'priv-unused', 'sk-h2')
    await savePrivacyBinding(database.db, masterKey, {
      mode: 'model',
      profileIds: [h1, h2],
      minScore: 0.6,
    })
    const cfgHang = await loadPrivacyModelConfig(database.db, masterKey)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    await expect(
      detectWithPrivacyModel(cfgHang!, '任意文本', { signal: ac.signal, timeoutMs: 5000 }),
    ).rejects.toThrow()
    expect(unusedBackup.requests).toHaveLength(0)
  })
})
