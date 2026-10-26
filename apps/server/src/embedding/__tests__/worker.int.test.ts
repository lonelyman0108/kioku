import { randomBytes } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memories, memoryEmbeddings, settings } from '../../db/schema'
import { startJobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { staticEmbedderSource } from '../source'
import { backfillEmbeddings, embedMemory } from '../worker'

describe.skipIf(!testDatabaseUrl)('向量生成', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let key: string
  const masterKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    ws = await bootstrap(app)
    key = await ws.issueKey((await ws.createApp('agent')).id)
  })

  const create = async (body: Record<string, unknown>) => {
    const res = await app.request('/v1/memories', jsonRequest('POST', body, bearer(key)))
    return ((await res.json()) as { id: string }).id
  }
  const embeddings = () =>
    withSpace(database.db, ws.spaceId, (tx) => tx.select().from(memoryEmbeddings))

  it('生成向量；正文不变时不重复请求，改了才重新生成', async () => {
    const embedder = fakeEmbedder()
    const id = await create({ uri: 'core://agent', content: '先读正文再信任', layer: 'base' })
    expect(await embedMemory(database.db, embedder, ws.spaceId, id)).toBe(1)
    expect(await embedMemory(database.db, embedder, ws.spaceId, id)).toBe(0)
    expect(embedder.calls).toHaveLength(1)
    expect(embedder.calls[0]![0]).toContain('core://agent')

    await app.request(
      '/v1/memories',
      jsonRequest('PATCH', { uri: 'core://agent', content: '新正文' }, bearer(key)),
    )
    expect(await embedMemory(database.db, embedder, ws.spaceId, id)).toBe(1)
    const rows = await embeddings()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.embedding).toHaveLength(1024)
  })

  it('secret 不生成向量；删除后向量随之清除', async () => {
    const embedder = fakeEmbedder()
    const secret = await create({ uri: 'home://wifi', content: 'hunter2', sensitivity: 'secret' })
    expect(await embedMemory(database.db, embedder, ws.spaceId, secret)).toBe(0)
    expect(embedder.calls).toHaveLength(0)

    const id = await create({ uri: 'core://x', content: 'x', layer: 'base' })
    await embedMemory(database.db, embedder, ws.spaceId, id)
    await app.request('/v1/memories?uri=core%3A%2F%2Fx', { method: 'DELETE', headers: bearer(key) })
    await embedMemory(database.db, embedder, ws.spaceId, id)
    expect(await embeddings()).toHaveLength(0)
  })

  it('全量补齐覆盖所有记忆；换模型后旧向量被替换', async () => {
    for (const p of ['a', 'b', 'c']) await create({ uri: `core://${p}`, content: p, layer: 'base' })
    expect(await backfillEmbeddings(database.db, fakeEmbedder('m1'))).toBe(3)
    expect(await backfillEmbeddings(database.db, fakeEmbedder('m1'))).toBe(0)
    expect(await backfillEmbeddings(database.db, fakeEmbedder('m2'))).toBe(3)
    const rows = await embeddings()
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set(['m2']))
  })

  it('写入后由后台任务自动生成向量', async () => {
    const embedder = fakeEmbedder()
    const jobs = await startJobs({
      connectionString: testDatabaseUrl!,
      db: database.db,
      embedder: async () => embedder,
    })
    const withJobs = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(embedder),
      jobs,
    })
    try {
      await withJobs.request(
        '/v1/memories',
        jsonRequest('POST', { uri: 'core://auto', content: '自动', layer: 'base' }, bearer(key)),
      )
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && (await embeddings()).length === 0) {
        await new Promise((r) => setTimeout(r, 250))
      }
      expect(await embeddings()).toHaveLength(1)
    } finally {
      await jobs.stop()
    }
  }, 30_000)

  it('嵌入设置只有管理员能改，Key 加密保存', async () => {
    const put = await app.request(
      '/v1/settings/embedding',
      jsonRequest(
        'PUT',
        { baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: 'sk-very-secret' },
        { cookie: ws.cookie },
      ),
    )
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({
      configured: true,
      model: 'm',
      hasApiKey: true,
      dimensions: 1024,
    })
    const stored = await database.db.select().from(settings)
    expect(JSON.stringify(stored)).not.toContain('sk-very-secret')

    // 只改地址不带 Key 时沿用原来的 Key
    await app.request(
      '/v1/settings/embedding',
      jsonRequest(
        'PUT',
        { baseUrl: 'https://e2.example.com/v1', model: 'm' },
        { cookie: ws.cookie },
      ),
    )
    const view = await (
      await app.request('/v1/settings/embedding', { headers: { cookie: ws.cookie } })
    ).json()
    expect(view).toMatchObject({ baseUrl: 'https://e2.example.com/v1', hasApiKey: true })

    expect((await app.request('/v1/settings/embedding')).status).toBe(401)
  })

  it('全文检索列由数据库生成，secret 不进索引', async () => {
    await create({ uri: 'home://router', content: '路由器在书房', layer: 'private' })
    await create({ uri: 'home://wifi', content: '书房无线密码', sensitivity: 'secret' })
    const matched = await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .select({ path: memories.path })
        .from(memories)
        .where(sql`${memories.fts} @@ plainto_tsquery('kioku_zh', '书房')`),
    )
    expect(matched.map((r) => r.path)).toEqual(['router'])
  })
})
