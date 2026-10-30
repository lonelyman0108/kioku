import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  connect,
  pgErrorCode,
  SPACE_SCAN_PARALLEL,
  withSpace,
  type Database,
  type Db,
} from '../../db/client'
import { EMBEDDING_DIMENSIONS, memories, memoryEmbeddings, spaces } from '../../db/schema'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { countEmbeddable, embeddingCoverage } from '../coverage'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0.01)
const MODELS = ['m1', 'm2']
// 数覆盖率用的连接带上这个名字，等锁、取消查询都只看它们，不碰连着同一个库的别的连接
const APP_NAME = 'kioku-coverage-test'

describe.skipIf(!testDatabaseUrl)('实例的向量覆盖率', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })

  // 第 i 个空间（从 0 数）：i + 1 条应当有向量的记忆，其中前 i 条有 m1 的向量，i 为奇数时第一条还有 m2 的；
  // 另有不该有向量的几条（已删除、已过期、到期、正文为空、secret、抽取的），已删除的那条还留着 m1 的向量。
  // 返回各个空间合起来应当数出的数
  async function seed(count: number) {
    const created = await database.db
      .insert(spaces)
      .values(Array.from({ length: count }, (_, i) => ({ name: `空间 ${i}` })))
      .returning()
    const past = new Date(Date.now() - 60_000)
    for (const [i, space] of created.entries()) {
      await withSpace(database.db, space.id, async (tx) => {
        const curated = (path: string, extra: Partial<typeof memories.$inferInsert> = {}) => ({
          spaceId: space.id,
          form: 'curated' as const,
          layer: 'base' as const,
          sensitivity: 'private' as const,
          provenance: 'owner' as const,
          domain: 'core',
          path,
          content: `${path} 的正文`,
          ...extra,
        })
        const eligible = await tx
          .insert(memories)
          .values(Array.from({ length: i + 1 }, (_, k) => curated(`note-${k}`)))
          .returning({ id: memories.id })
        const [deleted] = await tx
          .insert(memories)
          .values([
            curated('deleted', { deletedAt: past }),
            curated('lapsed', { validTo: past }),
            curated('expired', { expiresAt: past }),
            curated('empty', { content: '' }),
            curated('secret', {
              sensitivity: 'secret',
              content: null,
              ciphertext: Buffer.from('ciphertext'),
              wrappedKey: Buffer.from('wrapped'),
            }),
            {
              spaceId: space.id,
              form: 'extracted' as const,
              layer: 'episode' as const,
              sensitivity: 'public' as const,
              provenance: 'untrusted' as const,
              content: '抽取的',
            },
          ])
          .returning({ id: memories.id })
        const embedding = (memoryId: string, model: string) => ({
          spaceId: space.id,
          memoryId,
          model,
          contentHash: 'h',
          embedding: vector,
        })
        await tx
          .insert(memoryEmbeddings)
          .values([
            ...eligible.slice(0, i).map((m) => embedding(m.id, 'm1')),
            ...(i % 2 ? [embedding(eligible[0]!.id, 'm2')] : []),
            embedding(deleted!.id, 'm1'),
          ])
      })
    }
    const each = Array.from({ length: count }, (_, i) => i)
    return {
      eligible: each.reduce((sum, i) => sum + i + 1, 0),
      m1: each.reduce((sum, i) => sum + i, 0),
      m2: each.filter((i) => i % 2).length,
    }
  }

  const coverage = async (db = database.db) => {
    const { eligible, embedded } = await embeddingCoverage(db, MODELS)
    return { eligible, m1: embedded.get('m1'), m2: embedded.get('m2') }
  }

  it('几个空间合起来的数和逐个空间数完再加起来一样，只算应当有向量的', async () => {
    expect(await coverage()).toEqual({ eligible: 0, m1: 0, m2: 0 })
    const expected = await seed(6)
    expect(expected).toEqual({ eligible: 21, m1: 15, m2: 3 })
    expect(await coverage()).toEqual(expected)

    // 逐个空间在各自的事务里数，再加起来
    const serial = { eligible: 0, m1: 0, m2: 0 }
    for (const { id } of await database.db.select({ id: spaces.id }).from(spaces)) {
      const counts = await withSpace(database.db, id, (tx) => countEmbeddable(tx, MODELS))
      serial.eligible += counts.eligible
      serial.m1 += counts.embedded[0]!
      serial.m2 += counts.embedded[1]!
    }
    expect(serial).toEqual(expected)
    // 不问模型时只数应当有向量的
    expect(await embeddingCoverage(database.db, [])).toEqual({
      eligible: expected.eligible,
      embedded: new Map(),
    })
  })

  // 另一条连接锁住向量表时调用 run 数：每个空间的计数都要读它，开始数就等在这把锁上。用的连接池比上限大得多，
  // 同时数几个只由上限决定。等在锁上的数到上限之后，在锁还没放开时调用 check
  async function countWhileLocked<T>(
    run: (db: Db) => Promise<T>,
    check: (lock: {
      waiting: () => Promise<number>
      holder: number
      settled: () => boolean
    }) => Promise<unknown>,
  ): Promise<T> {
    const url = new URL(testDatabaseUrl!)
    url.searchParams.set('application_name', APP_NAME)
    const wide = connect(url.toString(), { max: SPACE_SCAN_PARALLEL * 3 })
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    let pending: Promise<T> | undefined
    try {
      await side.begin(async (tx) => {
        await tx`lock table memory_embeddings in access exclusive mode`
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }]
        // 数覆盖率的连接有几条等在这把锁上
        const waiting = async () => {
          const [row] = await side<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where application_name = ${APP_NAME} and ${pid}::int = any(pg_blocking_pids(pid))`
          return row!.n
        }
        let settled = false
        pending = run(wide.db)
        pending.then(
          () => (settled = true),
          () => (settled = true),
        )
        for (let i = 0; (await waiting()) < SPACE_SCAN_PARALLEL; i++) {
          if (i >= 80) throw new Error('没有同时数到上限那么多个空间')
          await sleep(25)
        }
        await check({ waiting, holder: pid, settled: () => settled })
      })
      return await pending!
    } finally {
      await pending?.catch(() => {})
      await side.end()
      await wide.close()
    }
  }

  it('几个空间同时数，最多同时数上限那么多个', async () => {
    const expected = await seed(SPACE_SCAN_PARALLEL + 2)
    expect(
      await countWhileLocked(coverage, async ({ waiting }) => {
        // 再等一会儿：剩下的空间要等前面的数完才开始，等在锁上的不会更多
        await sleep(200)
        expect(await waiting()).toBe(SPACE_SCAN_PARALLEL)
      }),
    ).toEqual(expected)
  })

  it('几处同时数（例如开着几个设置页）也合起来算上限，各自的数照旧对', async () => {
    const expected = await seed(SPACE_SCAN_PARALLEL + 2)
    expect(
      await countWhileLocked(
        (db) => Promise.all([coverage(db), coverage(db), coverage(db)]),
        async ({ waiting }) => {
          await sleep(200)
          expect(await waiting()).toBe(SPACE_SCAN_PARALLEL)
        },
      ),
    ).toEqual([expected, expected, expected])
  })

  it('数到一半出错：不再开始别的空间，等已经开始的数完再报出这个错误', async () => {
    await seed(SPACE_SCAN_PARALLEL + 2)
    const failed = countWhileLocked(coverage, async ({ waiting, holder, settled }) => {
      // 取消其中一个空间正等着锁的查询
      await database.db.execute(sql`
        select pg_cancel_backend(pid) from pg_stat_activity
        where application_name = ${APP_NAME} and ${holder}::int = any(pg_blocking_pids(pid))
        limit 1`)
      for (let i = 0; (await waiting()) !== SPACE_SCAN_PARALLEL - 1; i++) {
        if (i >= 80) throw new Error('出错的那一路又开始数别的空间了')
        await sleep(25)
      }
      await sleep(200)
      expect(await waiting()).toBe(SPACE_SCAN_PARALLEL - 1)
      // 别的空间还在数，先不报错
      expect(settled()).toBe(false)
    })
    // 取消语句的错误码
    await expect(failed).rejects.toSatisfy((err) => pgErrorCode(err) === '57014')
  })
})
