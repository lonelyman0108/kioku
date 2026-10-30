import { randomBytes } from 'node:crypto'

import type { EmbeddingSettingsView } from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database, type Tx } from '../../db/client'
import { memories, memoryEmbeddings, memoryGlossary, settings, spaces } from '../../db/schema'
import { startJobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { loadEmbeddingError } from '../errors'
import { embedJobs } from '../jobs'
import type { Embedder } from '../provider'
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
  const embeddedIds = async () => (await embeddings()).map((e) => e.memoryId).sort()
  const noRetry = () => {}
  // 等到条件成立，最多等 ms 毫秒
  const until = async (check: () => boolean | Promise<boolean>, ms: number) => {
    for (const started = Date.now(); !(await check());) {
      if (Date.now() - started > ms) throw new Error(`等了 ${ms} 毫秒，条件还不成立`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  // 接口不收带这段文字的请求：整个请求出错（像正文超过了模型的长度上限）；state.rejecting 关掉之后照常。
  // calls 记下每次请求带的文本，出错的也记
  const pickyEmbedder = (marker: string) => {
    const inner = fakeEmbedder()
    const state = { rejecting: true }
    const embedder: Embedder & { calls: string[][] } = {
      model: inner.model,
      calls: inner.calls,
      async embed(texts) {
        if (state.rejecting && texts.some((t) => t.includes(marker))) {
          inner.calls.push(texts)
          throw new Error('嵌入接口返回 HTTP 413：input too long')
        }
        return inner.embed(texts)
      },
    }
    return { embedder, state }
  }
  // 起真的后台任务（pg-boss），写入经过它排向量任务
  const withQueue = async (
    embedder: Embedder,
    body: (write: (uri: string, content: string) => Promise<string>) => Promise<void>,
  ) => {
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
      await body(async (uri, content) => {
        const res = await withJobs.request(
          '/v1/memories',
          jsonRequest('POST', { uri, content, layer: 'base' }, bearer(key)),
        )
        expect(res.status).toBe(201)
        return ((await res.json()) as { id: string }).id
      })
    } finally {
      await jobs.stop()
    }
  }

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

  it('别的事务只是往记忆上写外键（行上加 KEY SHARE）时照常写向量；正在改这一行时才跳过、之后重试', async () => {
    const embedder = fakeEmbedder()
    const skipped: string[][] = []
    const onSkipped = (ids: string[]) => skipped.push(ids)
    // 每种情况一条还没有向量的记忆：已经有最新的向量时不用锁行，测不出来
    const fresh = (path: string) =>
      create({ uri: `core://${path}`, content: `${path} 的正文`, layer: 'base' })
    // 另一个事务拿着这一行上的某种锁（还没提交）时生成向量
    const whileHolding = (hold: (tx: Tx) => Promise<unknown>, id: string) =>
      withSpace(database.db, ws.spaceId, async (tx) => {
        await hold(tx)
        return embedMemory(database.db, embedder, ws.spaceId, id, { onSkipped })
      })

    const keyShared = await fresh('key-share')
    expect(
      await whileHolding(
        (tx) => tx.execute(sql`select id from memories where id = ${keyShared} for key share`),
        keyShared,
      ),
    ).toBe(1)
    // 往关键词表写一条指向它的外键，还没提交
    const referenced = await fresh('referenced')
    expect(
      await whileHolding(
        (tx) =>
          tx
            .insert(memoryGlossary)
            .values({ spaceId: ws.spaceId, memoryId: referenced, keyword: '外键' }),
        referenced,
      ),
    ).toBe(1)
    expect(skipped).toEqual([])

    // 正在改这一行（UPDATE 还没提交）或者锁住了要改：跳过，交给调用方重试
    const updating = await fresh('updating')
    expect(
      await whileHolding(
        (tx) => tx.update(memories).set({ priority: 3 }).where(eq(memories.id, updating)),
        updating,
      ),
    ).toBe(0)
    const lockedForUpdate = await fresh('for-update')
    expect(
      await whileHolding(
        (tx) => tx.execute(sql`select id from memories where id = ${lockedForUpdate} for update`),
        lockedForUpdate,
      ),
    ).toBe(0)
    expect(skipped).toEqual([[updating], [lockedForUpdate]])
    // 锁放开之后重试：写上
    for (const id of [updating, lockedForUpdate]) {
      expect(await embedMemory(database.db, embedder, ws.spaceId, id)).toBe(1)
    }
    expect(await embeddedIds()).toEqual([keyShared, referenced, updating, lockedForUpdate].sort())
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

  it('连着写几十条：后台任务一次取一批、合起来请求嵌入接口，写完几秒内都有向量', async () => {
    const embedder = fakeEmbedder()
    const count = 60
    await withQueue(embedder, async (write) => {
      for (let i = 0; i < count; i++) await write(`core://n${i}`, `第 ${i} 条`)
      // 逐个任务处理时每条都要等一次轮询（约 2 秒），六十条要两分钟
      await until(async () => (await embeddings()).length === count, 15_000)
    })
    // 一次请求带了好几条，请求的次数比记忆的条数少得多
    expect(Math.max(...embedder.calls.map((c) => c.length))).toBeGreaterThan(1)
    expect(embedder.calls.length).toBeLessThan(count / 2)
  }, 60_000)

  it('后台任务里接口不收的那一条按任务的重试次数自己再试，不连累别的', async () => {
    const { embedder, state } = pickyEmbedder('坏的')
    await withQueue(embedder, async (write) => {
      const bad = await write('core://bad', '坏的一条')
      const good: string[] = []
      for (let i = 0; i < 5; i++) good.push(await write(`core://ok${i}`, `好的第 ${i} 条`))
      await until(async () => (await embeddings()).length === good.length, 15_000)
      expect(await embeddedIds()).toEqual([...good].sort())
      // 失败的任务由队列隔一会儿重试：接口又收到了这一条
      const tries = () => embedder.calls.filter((c) => c.some((t) => t.includes('坏的'))).length
      const before = tries()
      await until(() => tries() > before, 15_000)
      state.rejecting = false
      await until(async () => (await embeddedIds()).includes(bad), 20_000)
    })
  }, 60_000)

  it('一批里接口不收的那一条只算它失败，别的照常写；被锁着的不算失败，另排重试', async () => {
    const { embedder, state } = pickyEmbedder('坏的')
    const source = staticEmbedderSource(embedder)
    const good = [
      await create({ uri: 'core://a', content: '好的一条', layer: 'base' }),
      await create({ uri: 'core://b', content: '好的另一条', layer: 'base' }),
    ]
    const bad = await create({ uri: 'core://bad', content: '坏的一条', layer: 'base' })
    const locked = await create({ uri: 'core://locked', content: '锁着的一条', layer: 'base' })
    const target = (memoryId: string) => ({ spaceId: ws.spaceId, memoryId })
    // 坏的那条连着改过两次，有两项
    const targets = [target(good[0]!), target(bad), target(good[1]!), target(locked), target(bad)]
    const retried: string[][] = []
    const failed = await withSpace(database.db, ws.spaceId, async (tx) => {
      await tx.execute(sql`select id from memories where id = ${locked} for update`)
      return embedJobs(database.db, source, targets, (_space, ids) => retried.push(ids))
    })
    expect([...failed.keys()]).toEqual([targets[1], targets[4]])
    expect(failed.get(targets[1]!)!.message).toContain('HTTP 413')
    expect(retried).toEqual([[locked]])
    expect(await embeddedIds()).toEqual([...good].sort())
    // 四条合起来请求了一次，被拒之后逐条再试
    expect(embedder.calls[0]).toHaveLength(4)
    expect((await loadEmbeddingError(database.db))?.message).toContain('有 1 条记忆生成不了向量')

    // 重试的时候接口收了：写上，之前记下的错误清掉
    state.rejecting = false
    expect(
      (await embedJobs(database.db, source, [target(bad), target(locked)], noRetry)).size,
    ).toBe(0)
    expect(await embeddedIds()).toEqual([...good, bad, locked].sort())
    expect(await loadEmbeddingError(database.db)).toBeNull()
  })

  it('一批里有几个空间的记忆：按空间分开读写，同一个空间的合起来请求一次', async () => {
    const embedder = fakeEmbedder()
    const here = [
      await create({ uri: 'core://a', content: '这个空间的一条', layer: 'base' }),
      await create({ uri: 'core://b', content: '这个空间的另一条', layer: 'base' }),
    ]
    const [other] = await database.db.insert(spaces).values({ name: '另一个' }).returning()
    const [there] = await withSpace(database.db, other!.id, (tx) =>
      tx
        .insert(memories)
        .values({
          spaceId: other!.id,
          form: 'curated',
          layer: 'base',
          sensitivity: 'private',
          provenance: 'owner',
          domain: 'core',
          path: 'a',
          content: '另一个空间的一条',
        })
        .returning(),
    )
    const failed = await embedJobs(
      database.db,
      staticEmbedderSource(embedder),
      [
        { spaceId: ws.spaceId, memoryId: here[0]! },
        { spaceId: other!.id, memoryId: there!.id },
        { spaceId: ws.spaceId, memoryId: here[1]! },
      ],
      noRetry,
    )
    expect(failed.size).toBe(0)
    expect(embedder.calls.map((c) => c.length).sort()).toEqual([1, 2])
    expect(await embeddedIds()).toEqual([...here].sort())
    const thereEmbeddings = await withSpace(database.db, other!.id, (tx) =>
      tx.select().from(memoryEmbeddings),
    )
    expect(thereEmbeddings.map((e) => e.memoryId)).toEqual([there!.id])
  })

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
