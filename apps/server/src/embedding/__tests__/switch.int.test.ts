import { randomBytes } from 'node:crypto'

import type {
  EmbeddingSettingsView,
  EmbeddingStatus,
  EmbeddingTestResult,
  RecallResponse,
} from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memoryEmbeddings, settings } from '../../db/schema'
import type { Jobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  startFakeEmbeddingServer,
  type FakeEmbeddingServer,
} from '../../testing/fakeEmbeddingServer'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { backfillJob, embedJob, pruneJob, switchJob } from '../jobs'
import { settingsEmbedderSource } from '../source'

describe.skipIf(!testDatabaseUrl)('嵌入渠道与换模型', () => {
  let database: Database
  let server: FakeEmbeddingServer
  let app: ReturnType<typeof createApp>
  let source: ReturnType<typeof settingsEmbedderSource>
  let ws: Workspace
  let key: string
  const masterKey = randomBytes(32)
  // 路由排的任务只记下来，测试里直接调用任务本身
  const queued: string[] = []
  const jobs: Jobs = {
    enqueueEmbed() {},
    enqueueExtraction: async () => {},
    enqueueBackfill: async () => (queued.push('backfill'), true),
    enqueueSwitch: async () => (queued.push('switch'), true),
    enqueuePrune: async () => (queued.push('prune'), true),
  }
  const noRetry = () => {}

  beforeAll(async () => {
    database = await openTestDatabase()
    server = await startFakeEmbeddingServer()
    source = settingsEmbedderSource(database.db, masterKey)
    app = createApp({ db: database.db, cookieSecure: false, masterKey, embedder: source, jobs })
  })
  afterAll(async () => {
    await server?.close()
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    source.invalidate()
    queued.length = 0
    server.requests.length = 0
    for (const name of ['a', 'b', 'c', 'd', 'down', 'broken']) server.fail(name, undefined)
    ws = await bootstrap(app)
    key = await ws.issueKey((await ws.createApp('agent')).id)
  })

  const call = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(
      `/v1/settings/embedding${path}`,
      body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const put = async (path: string, body: unknown) => {
    const res = await call('PUT', path, body)
    expect(res.status).toBe(200)
    return (await res.json()) as EmbeddingSettingsView
  }
  const view = async () => (await (await call('GET', '')).json()) as EmbeddingSettingsView
  const status = async () => (await (await call('GET', '/status')).json()) as EmbeddingStatus
  const channel = (name: string, model: string, extra: Record<string, unknown> = {}) => ({
    baseUrl: server.url(name),
    model,
    ...extra,
  })
  const create = async (content: string) => {
    const res = await app.request(
      '/v1/memories',
      jsonRequest(
        'POST',
        { uri: `core://${randomBytes(4).toString('hex')}`, content, layer: 'base' },
        bearer(key),
      ),
    )
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }
  const vectors = () =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .select({ memoryId: memoryEmbeddings.memoryId, model: memoryEmbeddings.model })
        .from(memoryEmbeddings),
    )
  const modelsOf = async (memoryId?: string) =>
    (await vectors())
      .filter((v) => !memoryId || v.memoryId === memoryId)
      .map((v) => v.model)
      .sort()
  const semanticHits = async (query: string) => {
    const res = await app.request('/v1/recall', jsonRequest('POST', { query }, bearer(key)))
    const body = (await res.json()) as RecallResponse
    return body.candidates.filter((c) => c.via.includes('semantic')).length
  }

  it('只有一个接口时的旧设置读出来是一个渠道，向量照旧记在原来的模型名下', async () => {
    await database.db.insert(settings).values({
      key: 'embedding',
      value: { baseUrl: server.url('a'), model: 'old-model', apiKey: null },
    })
    expect(await view()).toEqual({
      dimensions: 1024,
      active: {
        model: 'old-model',
        channels: [{ id: 'c1', baseUrl: server.url('a'), model: 'old-model', hasApiKey: false }],
      },
      next: null,
    })
    const id = await create('第一条')
    await embedJob(database.db, source, ws.spaceId, id, noRetry)
    expect(await modelsOf(id)).toEqual(['old-model'])
  })

  it('渠道按顺序回退：出错换下一个，请求本身有问题时不换；最近的错误记下来', async () => {
    await put('', { model: 'm1', channels: [channel('down', 'm1'), channel('b', 'm1')] })
    server.fail('down', 503)
    const first = await create('第一条')
    await embedJob(database.db, source, ws.spaceId, first, noRetry)
    expect(await modelsOf(first)).toEqual(['m1'])
    expect(server.requests.map((r) => r.channel)).toEqual(['down', 'b'])

    server.requests.length = 0
    server.fail('down', 400)
    const second = await create('第二条')
    await expect(embedJob(database.db, source, ws.spaceId, second, noRetry)).rejects.toThrow(
      'HTTP 400',
    )
    expect(server.requests.map((r) => r.channel)).toEqual(['down'])
    expect((await status()).lastError).toMatchObject({
      model: 'm1',
      message: expect.stringContaining('HTTP 400'),
    })

    // 连接断开也换下一个；生成成功后错误清掉
    server.fail('down', null)
    await embedJob(database.db, source, ws.spaceId, second, noRetry)
    expect(await modelsOf(second)).toEqual(['m1'])
    expect((await status()).lastError).toBeNull()
  })

  it('换模型：补齐之前召回用旧模型，新写入的两个模型都生成，补齐后切过去、旧向量清掉', async () => {
    await put('', { model: 'm1', channels: [channel('a', 'm1')] })
    await create('读书会每周五开始')
    await create('路由器在机房')
    await backfillJob(database.db, source, noRetry)
    expect(await modelsOf()).toEqual(['m1', 'm1'])

    const saved = await put('/next', { model: 'm2', channels: [channel('a', 'remote-m2')] })
    expect(saved).toMatchObject({ active: { model: 'm1' }, next: { model: 'm2' } })
    expect(queued).toContain('switch')
    expect((await source.get())?.model).toBe('m1')
    expect(await semanticHits('读书会')).toBeGreaterThan(0)

    const fresh = await create('新写入的一条')
    await embedJob(database.db, source, ws.spaceId, fresh, noRetry)
    expect(await modelsOf(fresh)).toEqual(['m1', 'm2'])
    expect(await status()).toMatchObject({
      eligible: 3,
      active: { model: 'm1', embedded: 3 },
      next: { model: 'm2', embedded: 1 },
    })

    expect(await switchJob(database.db, source, noRetry)).toBe('switched')
    expect(await view()).toMatchObject({ active: { model: 'm2' }, next: null })
    expect((await source.get())?.model).toBe('m2')
    // 新模型请求时用的是渠道里的模型名，向量记在模型标识下
    expect(server.requests.some((r) => r.model === 'remote-m2')).toBe(true)
    expect(await pruneJob(database.db)).toBe(3)
    expect(await modelsOf()).toEqual(['m2', 'm2', 'm2'])
    expect(await semanticHits('读书会')).toBeGreaterThan(0)
    // 已经换完：再跑一次什么都不做
    expect(await switchJob(database.db, source, noRetry)).toBe('idle')
  })

  it('放弃换模型：删掉新模型已经生成的向量，旧的留着', async () => {
    await put('', { model: 'm1', channels: [channel('a', 'm1')] })
    const id = await create('第一条')
    await put('/next', { model: 'm2', channels: [channel('a', 'm2')] })
    await embedJob(database.db, source, ws.spaceId, id, noRetry)
    expect(await modelsOf(id)).toEqual(['m1', 'm2'])

    expect((await call('DELETE', '/next')).status).toBe(204)
    expect(queued).toContain('prune')
    expect(await pruneJob(database.db)).toBe(1)
    expect(await modelsOf(id)).toEqual(['m1'])
    expect(await view()).toMatchObject({ active: { model: 'm1' }, next: null })
    expect((await call('DELETE', '/next')).status).toBe(404)
  })

  it('新模型补不上时记下原因，管理员可以现在就切换', async () => {
    await put('', { model: 'm1', channels: [channel('a', 'm1')] })
    await create('第一条')
    await create('第二条')
    await backfillJob(database.db, source, noRetry)
    await put('/next', { model: 'm2', channels: [channel('broken', 'm2')] })
    server.fail('broken', 503)
    await expect(switchJob(database.db, source, noRetry)).rejects.toThrow('HTTP 503')
    expect(await status()).toMatchObject({
      next: { model: 'm2', embedded: 0 },
      lastError: { model: 'm2', message: expect.stringContaining('HTTP 503') },
    })

    queued.length = 0
    const switched = await call('POST', '/switch', {})
    expect(switched.status).toBe(200)
    expect(queued.sort()).toEqual(['backfill', 'prune'])
    expect(await switched.json()).toMatchObject({ active: { model: 'm2' }, next: null })
    expect(await pruneJob(database.db)).toBe(2)
    expect(await status()).toMatchObject({ active: { model: 'm2', embedded: 0 }, next: null })
    expect((await call('POST', '/switch', {})).status).toBe(400)
  })

  it('设置的限制：换模型标识走换模型；换模型时照抄渠道，同一主机沿用 Key；换成别的新模型时清掉原来那个的向量', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    expect(
      (await call('PUT', '/next', { model: 'm2', channels: [channel('a', 'm2')] })).status,
    ).toBe(400)
    const active = await put('', {
      model: 'm1',
      channels: [channel('a', 'm1', { apiKey: 'sk-1' })],
    })
    const id = active.active!.channels[0]!.id
    expect((await call('PUT', '', { model: 'm2', channels: [channel('a', 'm2')] })).status).toBe(
      400,
    )
    expect(
      (await call('PUT', '/next', { model: 'm1', channels: [channel('a', 'm1')] })).status,
    ).toBe(400)
    expect(
      (
        await call('PUT', '', {
          model: 'm1',
          channels: [channel('a', 'm1', { id }), channel('b', 'm1', { id })],
        })
      ).status,
    ).toBe(400)

    const next = await put('/next', {
      model: 'm2',
      channels: [{ id, baseUrl: server.url('a'), model: 'm2' }],
    })
    expect(next.next!.channels[0]).toMatchObject({ hasApiKey: true })
    expect(next.next!.channels[0]!.id).not.toBe(id)
    expect(
      (
        await call('PUT', '/next', {
          model: 'm2',
          channels: [{ id, baseUrl: 'https://other.example.net/v1', model: 'm2' }],
        })
      ).status,
    ).toBe(400)

    queued.length = 0
    await put('/next', { model: 'm3', channels: [channel('a', 'm3')] })
    expect(queued).toEqual(['prune', 'switch'])

    for (const [method, path] of [
      ['PUT', '/next'],
      ['DELETE', '/next'],
      ['POST', '/switch'],
    ] as const) {
      const body = method === 'PUT' ? { model: 'm4', channels: [channel('a', 'm4')] } : undefined
      expect((await call(method, path, body, editor.cookie)).status).toBe(403)
    }
  })

  it('连通性测试逐个渠道：维度不对算失败，不是同一个模型时相似度低', async () => {
    await put('', {
      model: 'm1',
      channels: [
        channel('a', 'm1'),
        channel('b', 'm1'),
        channel('c', 'another'),
        channel('d', 'm1'),
      ],
    })
    server.dimensions('d', 768)
    const res = await call('POST', '/test', {})
    expect(res.status).toBe(200)
    const result = (await res.json()) as EmbeddingTestResult
    expect(result.next).toBeNull()
    const [a, b, c, d] = result.active!
    expect(a).toMatchObject({ ok: true, similarity: null })
    expect(b).toMatchObject({ ok: true, similarity: 1 })
    expect(c!.ok).toBe(true)
    expect(c!.similarity).toBeLessThan(0.99)
    expect(d).toMatchObject({ ok: false, error: expect.stringContaining('维度是 768') })
  })
})
