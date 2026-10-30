import { randomBytes } from 'node:crypto'

import type { EmbeddingSettingsView } from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database, type Tx } from '../../db/client'
import { memories, memoryEmbeddings, memoryGlossary, settings, spaces } from '../../db/schema'
import { startJobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { startFakeEmbeddingServer } from '../../testing/fakeEmbeddingServer'
import { bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { embeddingCoverage } from '../coverage'
import { loadEmbeddingError, recordEmbeddingError } from '../errors'
import { backfillJob, embedJobs } from '../jobs'
import { channelEmbedder, EmbedRejected, type Embedder } from '../provider'
import { staticEmbedderSource } from '../source'
import { backfillEmbeddings, embedMemories } from '../worker'

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
  // 接口拒绝带这段文字的请求：整个请求被拒（像正文超过了模型的长度上限）；state.rejecting 关掉之后照常。
  // calls 记下每次请求带的文本，被拒的也记
  const pickyEmbedder = (marker: string) => {
    const inner = fakeEmbedder()
    const state = { rejecting: true }
    const embedder: Embedder & { calls: string[][] } = {
      model: inner.model,
      calls: inner.calls,
      async embed(texts) {
        if (state.rejecting && texts.some((t) => t.includes(marker))) {
          inner.calls.push(texts)
          throw new EmbedRejected('嵌入接口返回 HTTP 413：input too long')
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
    embedBudgetMs?: number,
  ) => {
    const jobs = await startJobs({
      connectionString: testDatabaseUrl!,
      db: database.db,
      embedder: staticEmbedderSource(embedder),
      masterKey,
      ...(embedBudgetMs ? { embedBudgetMs } : {}),
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
      const written = await embedMemories(database.db, embedder, ws.spaceId, [id], {
        onSkipped: (ids) => skipped.push(ids),
      })
      expect(written).toBe(0)
    })
    expect(skipped).toEqual([[id]])
    expect(await embeddings()).toHaveLength(0)
    expect(await embedMemories(database.db, embedder, ws.spaceId, [id])).toBe(1)
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
        return embedMemories(database.db, embedder, ws.spaceId, [id], { onSkipped })
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
      expect(await embedMemories(database.db, embedder, ws.spaceId, [id])).toBe(1)
    }
    expect(await embeddedIds()).toEqual([keyShared, referenced, updating, lockedForUpdate].sort())
  })

  it('生成向量；正文不变时不重复请求，改了才重新生成', async () => {
    const embedder = fakeEmbedder()
    const id = await create({ uri: 'core://agent', content: '先读正文再信任', layer: 'base' })
    expect(await embedMemories(database.db, embedder, ws.spaceId, [id])).toBe(1)
    expect(await embedMemories(database.db, embedder, ws.spaceId, [id])).toBe(0)
    expect(embedder.calls).toHaveLength(1)
    expect(embedder.calls[0]![0]).toContain('core://agent')

    await app.request(
      '/v1/memories',
      jsonRequest('PATCH', { uri: 'core://agent', content: '新正文' }, bearer(key)),
    )
    expect(await embedMemories(database.db, embedder, ws.spaceId, [id])).toBe(1)
    const rows = await embeddings()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.embedding).toHaveLength(1024)
  })

  it('secret 不生成向量；删除后向量随之清除', async () => {
    const embedder = fakeEmbedder()
    const secret = await create({ uri: 'home://wifi', content: 'hunter2', sensitivity: 'secret' })
    expect(await embedMemories(database.db, embedder, ws.spaceId, [secret])).toBe(0)
    expect(embedder.calls).toHaveLength(0)

    const id = await create({ uri: 'core://x', content: 'x', layer: 'base' })
    await embedMemories(database.db, embedder, ws.spaceId, [id])
    await app.request('/v1/memories?uri=core%3A%2F%2Fx', { method: 'DELETE', headers: bearer(key) })
    await embedMemories(database.db, embedder, ws.spaceId, [id])
    expect(await embeddings()).toHaveLength(0)
  })

  it('过期的记忆不生成向量，过期之前生成的在下次处理时删掉，补齐的范围与覆盖率的口径一致；重新生效之后再生成', async () => {
    const embedder = fakeEmbedder()
    const id = await create({ uri: 'core://soon', content: '很快过期', layer: 'base' })
    expect(await embedMemories(database.db, embedder, ws.spaceId, [id])).toBe(1)
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
    expect(await embedMemories(database.db, embedder, ws.spaceId, [id])).toBe(1)
    expect(await coverage()).toEqual({ eligible: 1, embedded: 1 })
  })

  it('每小时的清理锁着一条记忆、正删它的向量时，向量任务照常做完别的，不在向量行上等锁', async () => {
    const embedder = fakeEmbedder()
    const a = await create({ uri: 'core://a', content: '照常生成', layer: 'base' })
    const b = await create({ uri: 'core://b', content: '已经过期', layer: 'base' })
    await withSpace(database.db, ws.spaceId, async (tx) => {
      await tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 60_000) })
        .where(eq(memories.id, b))
      // b 还留着一个已经不用的模型的向量：向量任务会顺手清掉别的模型的向量
      await tx.insert(memoryEmbeddings).values({
        spaceId: ws.spaceId,
        memoryId: b,
        model: 'old-model',
        contentHash: 'old',
        embedding: new Array<number>(1024).fill(0.01),
      })
    })
    // 像清理任务那样锁住 b、删着它的向量，先不提交
    let locked!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => (locked = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    const cleanup = database.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.space_id', ${ws.spaceId}, true)`)
      await tx.execute(sql`select 1 from memories where id = ${b} for no key update`)
      await tx.execute(sql`delete from memory_embeddings where memory_id = ${b}`)
      locked()
      await held
    })
    await ready
    // 等锁的话这几秒里做不完；出了死锁会直接报错
    const runs: Promise<unknown>[] = []
    const within = <T>(run: Promise<T>) => {
      runs.push(run)
      return Promise.race([run, new Promise((resolve) => setTimeout(() => resolve('等锁'), 3_000))])
    }
    try {
      // 补齐：a 照常写上，b 被锁着就不碰它的向量
      expect(await within(backfillEmbeddings(database.db, embedder))).toBe(1)
      // 只处理 b：没有要写的，只剩别的模型的向量要清，b 被锁着，同样不等
      expect(await within(embedMemories(database.db, embedder, ws.spaceId, [b]))).toBe(0)
    } finally {
      release()
      await cleanup
      await Promise.allSettled(runs)
    }
    expect((await embeddings()).map((e) => e.memoryId)).toEqual([a])
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
    // 坏的那条连着改过两次，有两项（第 1 与第 4 项）
    const targets = [target(good[0]!), target(bad), target(good[1]!), target(locked), target(bad)]
    const retried: string[][] = []
    const failed = await withSpace(database.db, ws.spaceId, async (tx) => {
      await tx.execute(sql`select id from memories where id = ${locked} for update`)
      // 传进去的是副本：结果按下标对回去，不靠对象是不是同一个
      const copies = targets.map((t) => ({ ...t }))
      return embedJobs(database.db, source, copies, (_space, ids) => retried.push(ids))
    })
    expect([...failed.keys()].sort()).toEqual([1, 4])
    expect(failed.get(1)!.message).toContain('HTTP 413')
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

  // 直接写一条策展记忆（可以指定 id，决定它在一批里的先后），另建的空间也能写
  const insertCurated = async (spaceId: string, path: string, content: string, id?: string) => {
    const [row] = await withSpace(database.db, spaceId, (tx) =>
      tx
        .insert(memories)
        .values({
          ...(id ? { id } : {}),
          spaceId,
          form: 'curated',
          layer: 'base',
          sensitivity: 'private',
          provenance: 'owner',
          domain: 'core',
          path,
          content,
        })
        .returning({ id: memories.id }),
    )
    return row!.id
  }
  const newSpace = async (name: string) =>
    (await database.db.insert(spaces).values({ name }).returning({ id: spaces.id }))[0]!.id

  it('有成功也有超长被拒的：逐条再试时先试短的，接口接受过文本之后被拒的只算那几条，正常的都生成向量', async () => {
    const server = await startFakeEmbeddingServer()
    try {
      server.rejectText('超长')
      const embedder = channelEmbedder('m', [
        { baseUrl: server.url('a'), model: 'm', apiKey: null },
      ])
      // 超长的 3 条 id 最小、按 id 排在最前面；逐条再试按长短来，先试的是正常的
      const long: string[] = []
      for (const n of [1, 2, 3]) {
        const id = `00000000-0000-4000-8000-00000000000${n}`
        const content = `超长的第 ${n} 条，${'很长的正文'.repeat(20)}`
        long.push(await insertCurated(ws.spaceId, `long${n}`, content, id))
      }
      const normal: string[] = []
      for (let i = 0; i < 10; i++) {
        normal.push(await insertCurated(ws.spaceId, `ok${i}`, `正常的第 ${i} 条`))
      }
      const failed: string[] = []
      const written = await embedMemories(database.db, embedder, ws.spaceId, [...long, ...normal], {
        onFailed: (id, message) => {
          expect(message).toContain('HTTP 413')
          failed.push(id)
        },
      })
      expect(written).toBe(10)
      expect(failed).toEqual(long)
      expect(await embeddedIds()).toEqual([...normal].sort())
      // 整批一次，之后逐条 13 次
      expect(server.requests).toHaveLength(14)
    } finally {
      await server.close()
    }
  })

  it('渠道每个请求都回 400（例如模型名写错了）：还没接受过任何文本时，连着 3 条失败就当作接口不可用', async () => {
    const server = await startFakeEmbeddingServer()
    try {
      server.fail('bad', 400)
      const source = staticEmbedderSource(
        channelEmbedder('m', [{ baseUrl: server.url('bad'), model: 'm', apiKey: null }]),
      )
      const targets = []
      for (let i = 0; i < 5; i++) {
        targets.push({
          spaceId: ws.spaceId,
          memoryId: await insertCurated(ws.spaceId, `n${i}`, `第 ${i} 条`),
        })
      }
      const failed = await embedJobs(database.db, source, targets, noRetry)
      expect(failed.size).toBe(5)
      // 整批一次，逐条 3 次就停，不是每条都请求
      expect(server.requests).toHaveLength(4)
      // 记成接口的错误，不是「有几条记忆生成不了向量」
      const error = (await loadEmbeddingError(database.db))!.message
      expect(error).toContain('HTTP 400')
      expect(error).not.toContain('条记忆生成不了向量')
    } finally {
      await server.close()
    }
  })

  it('后面一批碰上接口不可用：前面几批拿到的向量先写回再报错，下次只请求剩下的', async () => {
    const inner = fakeEmbedder()
    let requests = 0
    const embedder: Embedder = {
      model: inner.model,
      async embed(texts) {
        requests++
        if (requests === 1) return inner.embed(texts)
        throw new Error('嵌入接口返回 HTTP 503：down')
      },
    }
    // 40 条：第一次请求带 32 条，成功；之后接口挂了
    const ids: string[] = []
    for (let i = 0; i < 40; i++) ids.push(await insertCurated(ws.spaceId, `n${i}`, `第 ${i} 条`))
    await expect(embedMemories(database.db, embedder, ws.spaceId, ids)).rejects.toThrow('HTTP 503')
    expect(await embeddings()).toHaveLength(32)
  })

  it('被锁着另排了的不再算成处理时间用完、没生成的', async () => {
    const { embedder } = slowEmbedder(500)
    const locked = await insertCurated(ws.spaceId, 'locked', '锁着的一条')
    const other = await insertCurated(ws.spaceId, 'other', '另一条')
    const skipped: string[][] = []
    const deferred: string[][] = []
    await withSpace(database.db, ws.spaceId, async (tx) => {
      await tx.execute(sql`select id from memories where id = ${locked} for update`)
      await embedMemories(database.db, embedder, ws.spaceId, [locked, other], {
        signal: AbortSignal.timeout(100),
        onSkipped: (ids) => skipped.push(ids),
        onDeferred: (ids) => deferred.push(ids),
      })
    })
    expect(skipped).toEqual([[locked]])
    expect(deferred).toEqual([[other]])
  })

  it('同一条记忆传了几次只处理一次', async () => {
    const embedder = fakeEmbedder()
    const id = await insertCurated(ws.spaceId, 'a', '一条')
    expect(await embedMemories(database.db, embedder, ws.spaceId, [id, id, id])).toBe(1)
    expect(embedder.calls).toEqual([[expect.stringContaining('一条')]])
  })

  it('写入之后的向量任务一批里也只按 EMBEDDABLE 生成：过期的不请求、留下的向量删掉，抽取的记忆不生成', async () => {
    const embedder = fakeEmbedder()
    const live = await insertCurated(ws.spaceId, 'live', '有效的一条')
    const lapsed = await insertCurated(ws.spaceId, 'lapsed', '过期的一条')
    // 过期之前生成过向量；之后到期，没有写入
    expect(await embedMemories(database.db, embedder, ws.spaceId, [lapsed])).toBe(1)
    const [episode] = await withSpace(database.db, ws.spaceId, async (tx) => {
      await tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 60_000) })
        .where(eq(memories.id, lapsed))
      return tx
        .insert(memories)
        .values({
          spaceId: ws.spaceId,
          form: 'extracted',
          layer: 'episode',
          sensitivity: 'private',
          provenance: 'owner',
          content: '一段会话摘要',
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning({ id: memories.id })
    })
    embedder.calls.length = 0
    const targets = [live, lapsed, episode!.id].map((memoryId) => ({
      spaceId: ws.spaceId,
      memoryId,
    }))
    expect(
      (await embedJobs(database.db, staticEmbedderSource(embedder), targets, noRetry)).size,
    ).toBe(0)
    expect(embedder.calls).toEqual([[expect.stringContaining('有效的一条')]])
    expect(await embeddedIds()).toEqual([live])
  })

  // 每次请求要等 state.ms 毫秒才回；signal 断开时马上放弃。aborted 数被取消的请求
  const slowEmbedder = (ms: number) => {
    const vectors = fakeEmbedder()
    const state = { aborted: 0, ms }
    const calls: string[][] = []
    const embedder: Embedder & { calls: string[][] } = {
      model: vectors.model,
      calls,
      async embed(texts, options) {
        calls.push(texts)
        const signal = options?.signal
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer)
            state.aborted++
            reject(new Error('请求被取消'))
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          }, state.ms)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
        return vectors.embed(texts)
      },
    }
    return { embedder, state }
  }

  // 三个空间各一条，各要请求一次
  const threeSpaces = async () => {
    const spaceIds = [ws.spaceId, await newSpace('二'), await newSpace('三')]
    return Promise.all(
      spaceIds.map(async (spaceId) => ({
        spaceId,
        memoryId: await insertCurated(spaceId, 'a', `空间 ${spaceId} 的一条`),
      })),
    )
  }

  it('一批的处理时间用完了：正在请求的取消，还没请求的不再请求，另排新任务、原任务不算失败；拿到的照常写回', async () => {
    const { embedder, state } = slowEmbedder(250)
    const source = staticEmbedderSource(embedder)
    // 第一次请求做完，第二次做到一半时间就用完了，第三次不再请求
    const targets = await threeSpaces()
    const requeued: [string, string[]][] = []
    const started = Date.now()
    const failed = await embedJobs(
      database.db,
      source,
      targets,
      (spaceId, ids) => requeued.push([spaceId, ids]),
      { budget: AbortSignal.timeout(400) },
    )
    expect(Date.now() - started).toBeLessThan(1500)
    expect(embedder.calls).toHaveLength(2)
    expect(state.aborted).toBe(1)
    // 没生成的不算失败（不耗原任务的重试次数），另排了新任务
    expect(failed.size).toBe(0)
    expect(requeued).toEqual(targets.slice(1).map((t) => [t.spaceId, [t.memoryId]]))
    expect(await embeddedIds()).toEqual([targets[0]!.memoryId])
    expect((await loadEmbeddingError(database.db))?.message).toContain('处理时间用完了')

    // 新任务来的时候接口快了：剩下的都写上
    state.ms = 0
    expect((await embedJobs(database.db, source, targets.slice(1), noRetry)).size).toBe(0)
    for (const { spaceId, memoryId } of targets) {
      const rows = await withSpace(database.db, spaceId, (tx) =>
        tx.select().from(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, memoryId)),
      )
      expect(rows).toHaveLength(1)
    }
  })

  it('服务要停时没做完的：同样另排新任务，不记「接口太慢」的错误', async () => {
    const { embedder } = slowEmbedder(250)
    const targets = await threeSpaces()
    const stopping = new AbortController()
    setTimeout(() => stopping.abort(), 400)
    const requeued: string[][] = []
    const failed = await embedJobs(
      database.db,
      staticEmbedderSource(embedder),
      targets,
      (_space, ids) => requeued.push(ids),
      { budget: AbortSignal.timeout(60_000), stopping: stopping.signal },
    )
    expect(failed.size).toBe(0)
    expect(requeued).toEqual(targets.slice(1).map((t) => [t.memoryId]))
    expect(await loadEmbeddingError(database.db)).toBeNull()
  })

  it('后台任务里接口一直慢、每批都做不完：没做的另排新任务，原任务不耗重试次数，接口好了就都补上', async () => {
    const { embedder, state } = slowEmbedder(60_000)
    await withQueue(
      embedder,
      async (write) => {
        const ids: string[] = []
        for (let i = 0; i < 3; i++) ids.push(await write(`core://slow${i}`, `第 ${i} 条`))
        // 卡住的请求到了处理时间被取消，没做的另排新任务
        await until(() => state.aborted > 0, 10_000)
        expect(await embeddings()).toHaveLength(0)
        state.ms = 0
        await until(async () => (await embeddedIds()).length === ids.length, 30_000)
        // 每条都另排过新任务；等这些任务都做完（另排的可能比向量晚，接口好了之后原来排着的也会先写上），
        // 没有一个是靠重试做完的
        const listed = sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )
        const jobRows = () =>
          database.db.execute<{ id: string; state: string; retries: number }>(
            sql`select data->>'memoryId' as id, state::text as state, retry_count as retries
              from pgboss.job where name = 'embed-memory' and data->>'memoryId' in (${listed})`,
          )
        await until(async () => (await jobRows()).every((r) => r.state === 'completed'), 30_000)
        const rows = await jobRows()
        expect(rows.length).toBeGreaterThan(ids.length)
        expect(rows.every((r) => r.retries === 0)).toBe(true)
      },
      300,
    )
  }, 90_000)

  it('清掉记下的错误时出错只记日志：已经写好的不算失败，被锁着的照样另排', async () => {
    const embedder = fakeEmbedder()
    const id = await create({ uri: 'core://a', content: '好的一条', layer: 'base' })
    const locked = await create({ uri: 'core://locked', content: '锁着的一条', layer: 'base' })
    await recordEmbeddingError(database.db, embedder.model, '之前的错误')
    // 让删除那条错误记录时数据库报错
    await database.db.execute(
      sql.raw(`create or replace function kioku_test_no_delete() returns trigger language plpgsql as $$
      begin raise exception '删不掉'; end $$`),
    )
    await database.db.execute(
      sql.raw(
        'create trigger kioku_test_no_delete before delete on settings for each row execute function kioku_test_no_delete()',
      ),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const retried: string[][] = []
      const failed = await withSpace(database.db, ws.spaceId, async (tx) => {
        await tx.execute(sql`select id from memories where id = ${locked} for update`)
        return embedJobs(
          database.db,
          staticEmbedderSource(embedder),
          [
            { spaceId: ws.spaceId, memoryId: id },
            { spaceId: ws.spaceId, memoryId: locked },
          ],
          (_space, ids) => retried.push(ids),
        )
      })
      expect(failed.size).toBe(0)
      expect(retried).toEqual([[locked]])
      expect(await embeddedIds()).toEqual([id])
      expect(logged).toHaveBeenCalledWith('清掉向量的错误时出错', expect.anything())
    } finally {
      logged.mockRestore()
      await database.db.execute(sql.raw('drop trigger if exists kioku_test_no_delete on settings'))
      await database.db.execute(sql.raw('drop function if exists kioku_test_no_delete()'))
    }
  })

  it('补齐时记下或清掉错误出错也只记日志：补齐照常做完，不整个重跑', async () => {
    const { embedder } = pickyEmbedder('坏的')
    const source = staticEmbedderSource(embedder)
    await insertCurated(ws.spaceId, 'a', '好的一条')
    const bad = await insertCurated(ws.spaceId, 'bad', '坏的一条')
    // 让写入、删除那条错误记录时数据库都报错
    await database.db.execute(
      sql.raw(`create or replace function kioku_test_no_error_row() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          if old.key = 'embedding-error' then raise exception '删不掉'; end if;
          return old;
        end if;
        if new.key = 'embedding-error' then raise exception '写不进'; end if;
        return new;
      end $$`),
    )
    await database.db.execute(
      sql.raw(
        'create trigger kioku_test_no_error_row before insert or update or delete on settings for each row execute function kioku_test_no_error_row()',
      ),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 有一条被拒：要记下错误，写不进
      expect(await backfillJob(database.db, source, noRetry)).toBe(1)
      expect(logged).toHaveBeenCalledWith('记下向量的错误时出错', expect.anything())
      // 都补上了：要清掉错误，删不掉
      await database.db.execute(sql.raw('drop trigger kioku_test_no_error_row on settings'))
      await recordEmbeddingError(database.db, embedder.model, '之前的错误')
      await database.db.execute(
        sql.raw(
          'create trigger kioku_test_no_error_row before insert or update or delete on settings for each row execute function kioku_test_no_error_row()',
        ),
      )
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx.update(memories).set({ content: '改好了的一条' }).where(eq(memories.id, bad)),
      )
      expect(await backfillJob(database.db, source, noRetry)).toBe(1)
      expect(logged).toHaveBeenCalledWith('清掉向量的错误时出错', expect.anything())
    } finally {
      logged.mockRestore()
      await database.db.execute(
        sql.raw('drop trigger if exists kioku_test_no_error_row on settings'),
      )
      await database.db.execute(sql.raw('drop function if exists kioku_test_no_error_row()'))
    }
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
