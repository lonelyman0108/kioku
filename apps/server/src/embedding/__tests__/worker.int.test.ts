import { randomBytes } from 'node:crypto'

import type { EmbeddingSettingsView } from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memories, memoryEmbeddings, settings } from '../../db/schema'
import { startJobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { embeddingCoverage } from '../coverage'
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

  it('写回时记忆正被别的事务锁着就跳过、交给调用方重试，不等锁', async () => {
    const embedder = fakeEmbedder()
    const id = await create({ uri: 'core://agent', content: '先读正文再信任', layer: 'base' })
    const skipped: string[][] = []
    await withSpace(database.db, ws.spaceId, async (tx) => {
      await tx.execute(sql`select id from memories where id = ${id} for update`)
      const written = await embedMemory(database.db, embedder, ws.spaceId, id, {
        onSkipped: (ids) => skipped.push(ids),
      })
      expect(written).toBe(0)
    })
    expect(skipped).toEqual([[id]])
    expect(await embeddings()).toHaveLength(0)
    expect(await embedMemory(database.db, embedder, ws.spaceId, id)).toBe(1)
  })

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

  it('过期的记忆不生成向量，过期之前生成的在下次处理时删掉，补齐的范围与覆盖率的口径一致；重新生效之后再生成', async () => {
    const embedder = fakeEmbedder()
    const id = await create({ uri: 'core://soon', content: '很快过期', layer: 'base' })
    expect(await embedMemory(database.db, embedder, ws.spaceId, id)).toBe(1)
    const validTo = (at: Date | null) =>
      withSpace(database.db, ws.spaceId, (tx) =>
        tx.update(memories).set({ validTo: at }).where(eq(memories.id, id)),
      )
    const coverage = async () => {
      const { eligible, embedded } = await embeddingCoverage(database.db, [embedder.model])
      return { eligible, embedded: embedded.get(embedder.model) }
    }
    expect(await coverage()).toEqual({ eligible: 1, embedded: 1 })

    await validTo(new Date(Date.now() - 60_000))
    expect(await coverage()).toEqual({ eligible: 0, embedded: 0 })
    // 补齐时不为它请求接口，留下的向量删掉
    expect(await backfillEmbeddings(database.db, embedder)).toBe(0)
    expect(embedder.calls).toHaveLength(1)
    expect(await embeddings()).toHaveLength(0)

    await validTo(null)
    expect(await coverage()).toEqual({ eligible: 1, embedded: 0 })
    expect(await embedMemory(database.db, embedder, ws.spaceId, id)).toBe(1)
    expect(await coverage()).toEqual({ eligible: 1, embedded: 1 })
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
      embedder: staticEmbedderSource(embedder),
      masterKey,
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
        {
          model: 'm',
          channels: [{ baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: 'sk-very-secret' }],
        },
        { cookie: ws.cookie },
      ),
    )
    expect(put.status).toBe(200)
    const saved = (await put.json()) as EmbeddingSettingsView
    expect(saved).toMatchObject({
      dimensions: 1024,
      active: { model: 'm', channels: [{ model: 'm', hasApiKey: true }] },
      next: null,
    })
    const stored = await database.db.select().from(settings)
    expect(JSON.stringify(stored)).not.toContain('sk-very-secret')

    // 同一主机只改路径、不带 Key 时沿用原来的 Key
    await app.request(
      '/v1/settings/embedding',
      jsonRequest(
        'PUT',
        {
          model: 'm',
          channels: [
            { id: saved.active!.channels[0]!.id, baseUrl: 'https://e.example.com/v2', model: 'm' },
          ],
        },
        { cookie: ws.cookie },
      ),
    )
    const view = await (
      await app.request('/v1/settings/embedding', { headers: { cookie: ws.cookie } })
    ).json()
    expect(view).toMatchObject({
      active: { channels: [{ baseUrl: 'https://e.example.com/v2', hasApiKey: true }] },
    })

    expect((await app.request('/v1/settings/embedding')).status).toBe(401)
  })

  it('全文检索列由数据库生成，secret 不进索引', async () => {
    await create({ uri: 'home://router', content: '路由器在机房', layer: 'private' })
    await create({ uri: 'home://wifi', content: '机房无线密码', sensitivity: 'secret' })
    const matched = await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .select({ path: memories.path })
        .from(memories)
        .where(sql`${memories.fts} @@ plainto_tsquery('kioku_zh', '机房')`),
    )
    expect(matched.map((r) => r.path)).toEqual(['router'])
  })
})
