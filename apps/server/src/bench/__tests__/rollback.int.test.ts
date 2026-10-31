import { randomBytes } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { connect, withSpace, type Database, type Db, type Tx } from '../../db/client'
import { settings, subjects } from '../../db/schema'
import type { Embedder } from '../../embedding/provider'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps } from '../../http/env'
import { semanticFor } from '../../memory/context'
import { MemoryError } from '../../memory/service'
import {
  backendOf,
  killDuring,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
} from '../../testing/db'
import { deferred } from '../../testing/deferred'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { bootstrap, type Workspace } from '../../testing/fixtures'
import {
  inRollback,
  prepareQueryVectors,
  RollbackRun,
  type BenchLimits,
  type QueryVectors,
} from '../rollback'

const NO_VECTORS: QueryVectors = { model: null, vectors: new Map() }

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

  describe('app.space_id', () => {
    it('每个顶层事务结束后清掉：根事务上不经 withSpace 查内容表返回空，和真实一样', async () => {
      await addSubject(database.db, '已有的')
      // 真实路径：withSpace 结束之后设置就失效了
      await expect(database.db.select().from(subjects)).resolves.toEqual([])
      await inRollback(deps, NO_VECTORS, async (scoped) => {
        await addSubject(scoped.db, '这次写的')
        await expect(scoped.db.select().from(subjects)).resolves.toEqual([])
        // withSpace 里照常读得到
        expect(await subjectNames(scoped.db)).toEqual(['已有的', '这次写的'].sort())
        await expect(scoped.db.select().from(subjects)).resolves.toEqual([])
      })
    })

    it('出错回滚的顶层事务之后也是空的，事务还能接着用', async () => {
      await addSubject(database.db, '已有的')
      await inRollback(deps, NO_VECTORS, async (scoped, run) => {
        await expect(
          withSpace(scoped.db, ws.spaceId, async () => {
            throw new Error('这个事务出错了')
          }),
        ).rejects.toThrow('这个事务出错了')
        await expect(scoped.db.select().from(subjects)).resolves.toEqual([])
        expect(await run.stopReason()).toBeNull()
        expect(await subjectNames(scoped.db)).toEqual(['已有的'])
      })
    })

    it('嵌套的事务结束时不清：外层的 withSpace 还在里面', async () => {
      await addSubject(database.db, '已有的')
      await inRollback(deps, NO_VECTORS, async (scoped) => {
        const seen = await withSpace(scoped.db, ws.spaceId, async (tx) => {
          await scoped.db.transaction(async () => {})
          return (await tx.select({ name: subjects.displayName }).from(subjects)).map((r) => r.name)
        })
        expect(seen).toEqual(['已有的'])
      })
    })

    it('清不掉（根事务已经中止）不影响这个事务的结果', async () => {
      await inRollback(deps, NO_VECTORS, async (scoped, run) => {
        const result = await scoped.db.transaction(async () => {
          await expect(scoped.db.execute(sql`select 1 / 0`)).rejects.toMatchObject({
            cause: { code: '22012' },
          })
          return '这个事务的结果'
        })
        expect(result).toBe('这个事务的结果')
        expect(run.takeDetail()).toBeNull()
        expect(await run.stopReason()).toBe('aborted')
      })
    })

    it('运行关闭之后不发这一句：根事务已经结束或者正在回滚', async () => {
      const sent: unknown[] = []
      const fake = {
        transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(fake),
        execute: async (query: unknown) => void sent.push(query),
      }
      const run = new RollbackRun({
        parallel: 1,
        statementTimeoutMs: 1,
        lockTimeoutMs: 1,
        runMs: 60_000,
        embedBudgetMs: 1,
      })
      const db = run.attach(fake as unknown as Tx)
      await db.transaction(async () => {})
      expect(sent).toHaveLength(1)
      await db.transaction(async () => run.close())
      expect(sent).toHaveLength(1)
    })
  })

  it('语句时限：超过就报错，能认出是语句超时', async () => {
    await inRollback(limited({ statementTimeoutMs: 300 }), NO_VECTORS, async (scoped, run) => {
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
    await inRollback(limited({ runMs: 300 }), NO_VECTORS, async (scoped, run) => {
      const finished = await scoped.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_sleep(0.35)`)
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

  it('运行结束之后代理不再可用，还在跑的代码发不出语句', async () => {
    let leaked!: Deps
    await inRollback(deps, NO_VECTORS, async (scoped) => {
      leaked = scoped
    })
    expect(() => leaked.db.select()).toThrow('已经结束')
    await expect(leaked.db.transaction(async () => {})).rejects.toThrow('已经结束')
  })

  // 试着用一下句柄，返回拒绝的原因；发出去了就返回固定文字
  const attempt = async (use: () => unknown) => {
    try {
      await use()
      return '发出去了'
    } catch (err) {
      return String(err)
    }
  }
  const SOMEONE = { kind: 'person', displayName: '不该写' } as const

  it('运行关闭之后内层的事务句柄也不能再用：任何属性访问都拒绝，里面再开的事务也一样', async () => {
    const outcomes = await inRollback(deps, NO_VECTORS, async (scoped, run) =>
      withSpace(scoped.db, ws.spaceId, (tx) =>
        tx.transaction((inner) =>
          inner.transaction(async (deep) => {
            // 关闭之前都照常能用，隔着几层也一样
            await tx.execute(sql`select 1`)
            await deep.insert(subjects).values({ spaceId: ws.spaceId, ...SOMEONE })
            await expect(deep.select().from(subjects)).resolves.toHaveLength(1)

            run.close()
            const handles: Tx[] = [tx, inner, deep]
            return Promise.all(
              handles.flatMap((handle) => [
                attempt(() => handle.execute(sql`select 1`)),
                attempt(() => handle.select().from(subjects)),
                attempt(() => handle.insert(subjects).values({ spaceId: ws.spaceId, ...SOMEONE })),
                attempt(() => handle.transaction(async () => {})),
                attempt(() => withSpace(handle as unknown as Db, ws.spaceId, async () => {})),
              ]),
            )
          }),
        ),
      ),
    )
    expect(outcomes).toHaveLength(15)
    for (const outcome of outcomes) expect(outcome).toContain('已经结束')
    expect(await subjectNames(database.db)).toEqual([])
  })

  // 回调结束到 ROLLBACK 做完、连接归还之前，驱动还放行句柄上的语句：排在 ROLLBACK 后面，落在事务外，直接提交。
  // setImmediate 在 ROLLBACK 发出之后、它的响应读回来之前执行，正好落在这一小段
  describe('回滚做完之前发出的写入', () => {
    const STRAY = 'bench-stray-write'
    const strayRows = () => database.db.select().from(settings).where(eq(settings.key, STRAY))
    afterEach(() => database.db.delete(settings).where(eq(settings.key, STRAY)))

    const strayWrite = (db: Db) =>
      new Promise<string>((resolve) => {
        setImmediate(() => {
          void attempt(() => db.insert(settings).values({ key: STRAY, value: {} })).then(resolve)
        })
      })

    it('代理挡得住：运行结束时先置状态，写不进去', async () => {
      let outcome!: Promise<string>
      await inRollback(deps, NO_VECTORS, async (scoped) => {
        await scoped.db.execute(sql`select 1`)
        outcome = strayWrite(scoped.db)
      })
      expect(await outcome).toContain('已经结束')
      await expect(strayRows()).resolves.toEqual([])
    })

    it('运行抛错时也一样：先置状态再回滚，写不进去', async () => {
      let outcome!: Promise<string>
      await expect(
        inRollback(deps, NO_VECTORS, async (scoped) => {
          await scoped.db.execute(sql`select 1`)
          outcome = strayWrite(scoped.db)
          throw new Error('运行出错')
        }),
      ).rejects.toThrow('运行出错')
      expect(await outcome).toContain('已经结束')
      await expect(strayRows()).resolves.toEqual([])
    })
  })

  // postgres.js 的 begin 把回调和连接关闭放在 Promise.race 里：连接断开时外层立刻 reject，回调不会停
  it('连接断开时回调已经在事务里：外层马上 reject，内层的 tx 也不能再发语句', async () => {
    const entered = deferred<number>()
    const callback = deferred()
    const after = deferred<string[]>()
    const running = inRollback(deps, NO_VECTORS, (scoped) =>
      withSpace(scoped.db, ws.spaceId, async (tx) => {
        entered.resolve(await backendOf(tx))
        await callback.promise
        after.resolve([
          await attempt(() => tx.insert(subjects).values({ spaceId: ws.spaceId, ...SOMEONE })),
          await attempt(() => tx.transaction(async () => {})),
        ])
      }),
    )
    expect(await killDuring(other.db, await entered.promise, running)).toMatchObject({
      code: 'CONNECTION_CLOSED',
    })
    callback.resolve()
    for (const outcome of await after.promise) expect(outcome).toContain('已经结束')
  })

  it('连接断开、回调还在跑：先置状态，回调不能再发语句', async () => {
    const entered = deferred<number>()
    const callback = deferred()
    const after = deferred<{ reason: unknown; error: unknown }>()
    const running = inRollback(deps, NO_VECTORS, async (scoped, run) => {
      entered.resolve(await backendOf(scoped.db))
      await callback.promise
      const reason = await run.stopReason()
      const error = await addSubject(scoped.db, '不该写').catch((err: unknown) => err)
      after.resolve({ reason, error })
    })
    expect(await killDuring(other.db, await entered.promise, running)).toMatchObject({
      code: 'CONNECTION_CLOSED',
    })
    callback.resolve()
    const { reason, error } = await after.promise
    expect(reason).toBe('aborted')
    expect(String(error)).toContain('已经结束')
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
