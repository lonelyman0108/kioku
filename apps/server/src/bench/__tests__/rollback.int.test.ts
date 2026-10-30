import { randomBytes } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { connect, withSpace, type Database, type Db } from '../../db/client'
import { subjects } from '../../db/schema'
import type { Embedder } from '../../embedding/provider'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps } from '../../http/env'
import { semanticFor } from '../../memory/context'
import { MemoryError } from '../../memory/service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { bootstrap, type Workspace } from '../../testing/fixtures'
import { inRollback, prepareQueryVectors, type BenchLimits, type QueryVectors } from '../rollback'

const NO_VECTORS: QueryVectors = { model: null, vectors: new Map() }

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe.skipIf(!testDatabaseUrl)('回滚事务与串行化的代理', () => {
  let database: Database
  let other: Database
  let deps: Deps
  let ws: Workspace
  const limited = (limits: Partial<BenchLimits>): Deps => ({ ...deps, benchLimits: limits })
  const addSubject = (db: Db, displayName: string) =>
    withSpace(db, ws.spaceId, (tx) =>
      tx.insert(subjects).values({ spaceId: ws.spaceId, kind: 'person', displayName }),
    )
  const subjectNames = (db: Db) =>
    withSpace(db, ws.spaceId, async (tx) =>
      (await tx.select({ name: subjects.displayName }).from(subjects)).map((r) => r.name).sort(),
    )
  // 另一条连接拿着 settings 的表锁，直到调用返回的函数；plain 的读也会被它挡住
  const holdSettingsLock = async () => {
    const release = deferred()
    const held = deferred()
    const hold = other.db.transaction(async (tx) => {
      await tx.execute(sql`lock table settings in access exclusive mode`)
      held.resolve()
      await release.promise
    })
    await held.promise
    return async () => {
      release.resolve()
      await hold
    }
  }

  beforeAll(async () => {
    database = await openTestDatabase()
    other = connect(testDatabaseUrl!, { max: 2 })
    deps = {
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
    }
  })
  afterAll(async () => {
    await other?.close()
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(createApp(deps))
  })

  it('事务里写下的读得到，结束时全部回滚，结果照常返回', async () => {
    const seen = await inRollback(deps, NO_VECTORS, async (scoped) => {
      await addSubject(scoped.db, '甲')
      expect(scoped.jobs).toBeNull()
      return subjectNames(scoped.db)
    })
    expect(seen).toEqual(['甲'])
    expect(await subjectNames(database.db)).toEqual([])
  })

  it('并行的顶层事务排队，不交错；回调里的嵌套直接执行，不会自己等自己', async () => {
    const order: string[] = []
    await inRollback(deps, NO_VECTORS, async (scoped) => {
      await Promise.all(
        ['a', 'b', 'c'].map((name) =>
          scoped.db.transaction(async (tx) => {
            order.push(`${name} 开始`)
            await tx.execute(sql`select pg_sleep(0.02)`)
            order.push(`${name} 结束`)
          }),
        ),
      )
      const nested = await scoped.db.transaction(() =>
        scoped.db.transaction(() => scoped.db.transaction(async () => '嵌套走通')),
      )
      expect(nested).toBe('嵌套走通')
    })
    expect(order).toEqual(['a 开始', 'a 结束', 'b 开始', 'b 结束', 'c 开始', 'c 结束'])
  })

  it('出错只回滚出错的那个事务：同一步里已经结束的和并行的都保留，事务还能接着用', async () => {
    const seen = await inRollback(deps, NO_VECTORS, async (scoped) => {
      const results = await Promise.allSettled([
        addSubject(scoped.db, '先结束的'),
        withSpace(scoped.db, ws.spaceId, async (tx) => {
          await tx.insert(subjects).values({
            spaceId: ws.spaceId,
            kind: 'person',
            displayName: '出错的',
          })
          throw new Error('这个事务出错了')
        }),
        addSubject(scoped.db, '后结束的'),
      ])
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
      return subjectNames(scoped.db)
    })
    expect(seen).toEqual(['先结束的', '后结束的'].sort())
  })

  it('语句出错也只回滚那一层：出错之后事务还能接着用', async () => {
    await inRollback(deps, NO_VECTORS, async (scoped, run) => {
      await expect(
        scoped.db.transaction((tx) => tx.execute(sql`select 1 / 0`)),
      ).rejects.toMatchObject({ cause: { code: '22012' } })
      expect(await run.stopReason()).toBeNull()
      await addSubject(scoped.db, '还能写')
    })
  })

  it('根事务上的语句出错：整个运行中止，后面的事务都拒绝，回滚照常结束', async () => {
    await inRollback(deps, NO_VECTORS, async (scoped, run) => {
      await expect(scoped.db.execute(sql`select 1 / 0`)).rejects.toMatchObject({
        cause: { code: '22012' },
      })
      expect(await run.stopReason()).toBe('aborted')
      // 开 savepoint 这条语句由驱动直接发，错误不经 drizzle 包装
      await expect(addSubject(scoped.db, '写不进去')).rejects.toMatchObject({ code: '25P02' })
    })
    expect(await subjectNames(database.db)).toEqual([])
  })

  it('语句时限：超过就报错，能认出是语句超时', async () => {
    await inRollback(limited({ statementTimeoutMs: 50 }), NO_VECTORS, async (scoped, run) => {
      await expect(
        scoped.db.transaction((tx) => tx.execute(sql`select pg_sleep(4)`)),
      ).rejects.toMatchObject({ cause: { code: '57014' } })
      expect(run.takeDetail()).toBe('statement_timeout')
      expect(run.takeDetail()).toBeNull()
      expect(await run.stopReason()).toBeNull()
    })
  })

  it('等锁时限：别的连接占着表时报错，能认出是等锁超时', async () => {
    const release = await holdSettingsLock()
    try {
      const limits = { lockTimeoutMs: 50, statementTimeoutMs: 1000 }
      await inRollback(limited(limits), NO_VECTORS, async (scoped, run) => {
        await expect(
          scoped.db.transaction((tx) => tx.execute(sql`select count(*) from settings`)),
        ).rejects.toMatchObject({ cause: { code: '55P03' } })
        expect(run.takeDetail()).toBe('lock_timeout')
      })
    } finally {
      await release()
    }
  })

  it('总时长：到点之后拒绝新的顶层事务，已经开始的回调照常跑完', async () => {
    await inRollback(limited({ runMs: 80 }), NO_VECTORS, async (scoped, run) => {
      const finished = await scoped.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_sleep(0.1)`)
        // 已经在回调里的语句不受影响，正在跑的步骤靠语句时限收尾
        await tx.execute(sql`select 1`)
        return '跑完了'
      })
      expect(finished).toBe('跑完了')
      expect(await run.stopReason()).toBe('timeout')
      await expect(addSubject(scoped.db, '太晚了')).rejects.toThrow('超过了总时长')
      expect(run.takeDetail()).toBe('run_timeout')
    })
  })

  it('运行结束之后代理不再可用，还在跑的代码不会把语句发到归还的连接上', async () => {
    let leaked!: Deps
    await inRollback(deps, NO_VECTORS, async (scoped) => {
      leaked = scoped
    })
    expect(() => leaked.db.select()).toThrow('已经结束')
    await expect(leaked.db.transaction(async () => {})).rejects.toThrow('已经结束')
  })

  it('外层事务先失败（连接断开时就这样）、回调还在跑：先置状态，回调不能再发语句', async () => {
    const disconnected = deferred()
    const callback = deferred()
    const after = deferred<{ reason: unknown; error: unknown }>()
    // postgres.js 的 begin 把回调和连接关闭放在 Promise.race 里：连接断开时外层立刻 reject，回调不会停
    const flaky = new Proxy(database.db, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop)
        return (fn: Parameters<Db['transaction']>[0]) =>
          Promise.race([
            target.transaction(fn),
            disconnected.promise.then(() => {
              throw new Error('连接断开了')
            }),
          ])
      },
    })
    const running = inRollback({ ...deps, db: flaky }, NO_VECTORS, async (scoped, run) => {
      await callback.promise
      const reason = await run.stopReason()
      const error = await addSubject(scoped.db, '不该写').catch((err: unknown) => err)
      after.resolve({ reason, error })
    })
    disconnected.resolve()
    await expect(running).rejects.toThrow('连接断开了')
    callback.resolve()
    const { reason, error } = await after.promise
    expect(reason).toBe('aborted')
    expect(String(error)).toContain('已经结束')
    // 回调抛出 Rolled，底下的事务真的回滚，连接也还回去了
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await subjectNames(database.db)).toEqual([])
  })

  it('闸门：同时运行数到了上限直接 429，结束之后放开', async () => {
    const release = deferred()
    const started = [deferred(), deferred()]
    const runs = started.map((gate) =>
      inRollback(deps, NO_VECTORS, async () => {
        gate.resolve()
        await release.promise
      }),
    )
    await Promise.all(started.map((s) => s.promise))
    await expect(inRollback(deps, NO_VECTORS, async () => {})).rejects.toSatisfy(
      (err) => err instanceof MemoryError && err.status === 429,
    )
    release.resolve()
    await Promise.all(runs)
    await expect(inRollback(deps, NO_VECTORS, async () => '放开了')).resolves.toBe('放开了')
  })

  it('运行出错时也放开闸门，错误照常抛出', async () => {
    for (let i = 0; i < 4; i++) {
      await expect(
        inRollback(deps, NO_VECTORS, async () => {
          throw new Error('运行出错')
        }),
      ).rejects.toThrow('运行出错')
    }
    await expect(inRollback(deps, NO_VECTORS, async () => 1)).resolves.toBe(1)
  })

  describe('查询向量', () => {
    const withEmbedder = (embedder: Embedder | null): Deps => ({
      ...deps,
      embedder: staticEmbedderSource(embedder),
    })

    it('事务里只查这张表：查得到就用，查不到走现有的回退并标明，不再请求嵌入接口', async () => {
      const embedder = fakeEmbedder()
      const source = withEmbedder(embedder)
      const vectors = await prepareQueryVectors(source, [{ text: '  算好的查询 ' }], 1000)
      expect(embedder.calls).toEqual([['算好的查询']])
      await inRollback(source, vectors, async (scoped, run) => {
        const hit = await semanticFor(scoped, '算好的查询')
        expect(hit?.model).toBe(embedder.model)
        expect(hit?.vector).toEqual(vectors.vectors.get('算好的查询'))
        expect(run.takeVectorMissed()).toBe(false)

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const miss = await semanticFor(scoped, '运行时才知道的查询')
        warn.mockRestore()
        expect(miss).toBeNull()
        expect(run.takeVectorMissed()).toBe(true)
        expect(run.takeVectorMissed()).toBe(false)
      })
      expect(embedder.calls).toHaveLength(1)
    })

    it('实例没配嵌入模型时事务里也没有，不算没算好', async () => {
      const vectors = await prepareQueryVectors(withEmbedder(null), [{ text: '查询' }], 1000)
      expect(vectors.model).toBeNull()
      await inRollback(withEmbedder(null), vectors, async (scoped, run) => {
        expect(await semanticFor(scoped, '查询')).toBeNull()
        expect(run.takeVectorMissed()).toBe(false)
      })
    })

    it('同一个查询只算一次；接口出错的不进表，后面的接着算', async () => {
      const good = fakeEmbedder()
      const flaky: Embedder = {
        model: good.model,
        embed: async (texts, options) => {
          if (texts[0] === '会出错') throw new Error('接口出错')
          return good.embed(texts, options)
        },
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const vectors = await prepareQueryVectors(
        withEmbedder(flaky),
        [{ text: '第一个' }, { text: '会出错' }, { text: '第一个' }, { text: '第二个' }],
        1000,
      )
      warn.mockRestore()
      expect([...vectors.vectors.keys()]).toEqual(['第一个', '第二个'])
      expect(good.calls).toEqual([['第一个'], ['第二个']])
    })

    it('共用一个时间预算：接口卡住时到点就放弃后面的，单个查询也有自己的上限', async () => {
      const hanging: Embedder = { model: 'hang', embed: () => new Promise(() => {}) }
      const started = Date.now()
      const vectors = await prepareQueryVectors(
        withEmbedder(hanging),
        [{ text: '一', timeoutMs: 20 }, { text: '二' }, { text: '三' }],
        120,
      )
      const elapsed = Date.now() - started
      expect(vectors.vectors.size).toBe(0)
      expect(elapsed).toBeGreaterThanOrEqual(100)
      expect(elapsed).toBeLessThan(1000)
    })
  })

  it('等锁的写入等到时限才报错，等的时候确实被别的连接挡住', async () => {
    await addSubject(database.db, '被锁的')
    const release = deferred()
    const held = deferred()
    const hold = withSpace(other.db, ws.spaceId, async (tx) => {
      await tx.update(subjects).set({ displayName: '占着' }).where(eq(subjects.spaceId, ws.spaceId))
      held.resolve()
      await release.promise
    })
    await held.promise
    const blocked = inRollback(
      limited({ lockTimeoutMs: 1500 }),
      NO_VECTORS,
      async (scoped, run) => {
        const write = withSpace(scoped.db, ws.spaceId, (tx) =>
          tx.update(subjects).set({ displayName: '想改' }).where(eq(subjects.spaceId, ws.spaceId)),
        )
        await expect(write).rejects.toMatchObject({ cause: { code: '55P03' } })
        return run.takeDetail()
      },
    )
    let seen = false
    for (let i = 0; i < 100 && !seen; i++) {
      const [row] = await other.db.execute<{ blocked: boolean }>(sql`
        select exists (
          select 1 from pg_stat_activity
          where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0
        ) as blocked`)
      seen = row?.blocked === true
      if (!seen) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(seen).toBe(true)
    await expect(blocked).resolves.toBe('lock_timeout')
    release.resolve()
    await hold
  })
})
