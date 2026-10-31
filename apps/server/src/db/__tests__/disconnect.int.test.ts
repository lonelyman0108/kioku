import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { backendOf, killDuring, openTestDatabase, testDatabaseUrl } from '../../testing/db'
import { deferred } from '../../testing/deferred'
import {
  connect,
  errorText,
  loggableError,
  pgErrorCode,
  withSpace,
  type Database,
  type Tx,
} from '../client'
import { settings } from '../schema'

// withSpace 只是声明当前空间，这里写的 settings 不是内容表，这个空间不必存在
const SPACE = '00000000-0000-4000-8000-000000000000'
const KEY = 'disconnect-test'
// 等后端执行语句最多等这么久，短于用例的时限：等不到时报这里的错，不是用例超时之后还在轮询
const RUNNING_WITHIN_MS = 4000

// 执行一下，返回抛出的错误；没抛错时返回 null
const failure = async (run: () => unknown): Promise<unknown> => {
  try {
    await run()
    return null
  } catch (err) {
    return err
  }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

// 事务进行中连接断开（数据库重启、网络断开、后端被杀）：语句和事务的 promise 都正常 reject，不能变成未捕获的异常，
// 那会让整个进程退出；之后连接池照常能用
describe.skipIf(!testDatabaseUrl)('事务进行中连接断开', () => {
  let database: Database
  let side: Database

  beforeAll(async () => {
    database = await openTestDatabase()
    side = connect(testDatabaseUrl!, { max: 1 })
  })
  afterAll(async () => {
    await side?.close()
    await database?.close()
  })

  // 每条用例结束时都查：没有未捕获的异常、没有没人接的 rejection。
  // 装了这两个监听器 vitest 就不再自己报，所以要在这里断言；驱动可能排到下一轮事件循环才写，多等两轮
  const unhandled: unknown[] = []
  const record = (err: unknown) => void unhandled.push(err)
  beforeEach(() => {
    unhandled.length = 0
    process.on('uncaughtException', record)
    process.on('unhandledRejection', record)
  })
  afterEach(async () => {
    await nextTurn()
    await nextTurn()
    process.off('uncaughtException', record)
    process.off('unhandledRejection', record)
    expect(unhandled).toEqual([])
  })

  // 等到这个后端真的在执行语句。后端不在了、或者到点还没等到，都报错说清楚，不一直占着 side 那条连接
  const untilRunning = async (pid: number, withinMs = RUNNING_WITHIN_MS) => {
    const deadline = Date.now() + withinMs
    while (Date.now() < deadline) {
      const [row] = await side.db.execute<{ state: string | null }>(
        sql`select state from pg_stat_activity where pid = ${pid}`,
      )
      if (!row) throw new Error(`后端 ${pid} 已经不在了，等不到它执行语句`)
      if (row.state === 'active') return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`等了 ${withinMs} 毫秒，后端 ${pid} 还没有开始执行语句`)
  }
  // 连接池照常能用：换了一条连接，事务也开得起来；被杀的事务写下的不在
  const expectRecovered = async (killed: number) => {
    expect(await backendOf(database.db)).not.toBe(killed)
    expect(await database.db.transaction(backendOf)).not.toBe(killed)
    await expect(database.db.select().from(settings).where(eq(settings.key, KEY))).resolves.toEqual(
      [],
    )
  }

  it('回调空闲时：事务马上 reject，回调后面的语句也 reject，不会挂起', async () => {
    const entered = deferred<number>()
    const resume = deferred()
    const after = deferred<unknown[]>()
    const running = withSpace(database.db, SPACE, async (tx) => {
      await tx.insert(settings).values({ key: KEY, value: {} })
      entered.resolve(await backendOf(tx))
      await resume.promise
      after.resolve([
        await failure(() => tx.execute(sql`select 1`)),
        await failure(() => tx.execute(sql`select ${1}::int`)),
        await failure(() => tx.insert(settings).values({ key: KEY, value: {} })),
        await failure(() => tx.transaction(async () => {})),
      ])
    })
    const pid = await entered.promise
    expect(await killDuring(side.db, pid, running)).toMatchObject({ code: 'CONNECTION_CLOSED' })
    resume.resolve()
    for (const err of await after.promise) expect(pgErrorCode(err)).toBe('CONNECTION_CLOSED')
    await expectRecovered(pid)
  })

  it('连接本身的错误，经不经 drizzle 包装都记成 CONNECTION_CLOSED，不解开它自带的 cause', async () => {
    const entered = deferred<number>()
    const resume = deferred()
    const wrapped = deferred<unknown>()
    const running = database.db.transaction(async (tx) => {
      entered.resolve(await backendOf(tx))
      await resume.promise
      wrapped.resolve(await failure(() => tx.execute(sql`select 1`)))
    })
    // 事务的 promise 是驱动直接给的，后端被杀时带着数据库说的原因
    const raw = await killDuring(side.db, await entered.promise, running)
    expect((raw as Error).cause).toMatchObject({ code: '57P01' })
    resume.resolve()
    const statement = await wrapped.promise
    expect(pgErrorCode(raw)).toBe('CONNECTION_CLOSED')
    expect(pgErrorCode(statement)).toBe('CONNECTION_CLOSED')
    expect(errorText(raw)).toBe(errorText(statement))
    // 不是数据库的错误原样进日志；drizzle 的错误只留 SQLSTATE 与说明。code 都一样
    expect(loggableError(raw)).toBe(raw)
    expect(loggableError(statement)).toMatchObject({ code: 'CONNECTION_CLOSED' })
  })

  it('语句执行中：这条语句报数据库给的原因，事务 reject', async () => {
    const entered = deferred<number>()
    const statement = deferred<unknown>()
    const running = database.db.transaction(async (tx) => {
      await tx.insert(settings).values({ key: KEY, value: {} })
      entered.resolve(await backendOf(tx))
      statement.resolve(await failure(() => tx.execute(sql`select pg_sleep(60)`)))
    })
    const pid = await entered.promise
    // 等不到也要杀：留着 pg_sleep(60) 的事务会占着连接，还会把这一行提交，连累后面的用例
    const notRunning = await untilRunning(pid).then(
      () => null,
      (err: unknown) => err,
    )
    const closed = await killDuring(side.db, pid, running)
    if (notRunning) throw notRunning
    expect(closed).toMatchObject({ code: 'CONNECTION_CLOSED' })
    expect(pgErrorCode(await statement.promise)).toBe('57P01')
    await expectRecovered(pid)
  })

  it('等后端执行语句有上限：后端不在了立刻报错，一直空闲时到点报错', async () => {
    await expect(untilRunning(2147483647)).rejects.toThrow('已经不在了')
    await expect(untilRunning(await backendOf(database.db), 30)).rejects.toThrow(
      '还没有开始执行语句',
    )
  })

  it('savepoint 打开时：里外的句柄都 reject，也开不了新的 savepoint', async () => {
    const entered = deferred<number>()
    const resume = deferred()
    const after = deferred<unknown[]>()
    const running = withSpace(database.db, SPACE, (outer) =>
      outer.transaction(async (inner) => {
        await inner.insert(settings).values({ key: KEY, value: {} })
        entered.resolve(await backendOf(inner))
        await resume.promise
        after.resolve([
          await failure(() => inner.execute(sql`select 1`)),
          await failure(() => outer.execute(sql`select 1`)),
          await failure(() => inner.transaction(async () => {})),
          await failure(() => outer.transaction(async () => {})),
        ])
      }),
    )
    const pid = await entered.promise
    expect(await killDuring(side.db, pid, running)).toMatchObject({ code: 'CONNECTION_CLOSED' })
    resume.resolve()
    for (const err of await after.promise) expect(pgErrorCode(err)).toBe('CONNECTION_CLOSED')
    await expectRecovered(pid)
  })

  // 回调结束之后驱动要决定发不发 COMMIT 或 ROLLBACK，连接断了就不能再往上写
  it.each([
    { ending: '不发语句就返回', statement: false, throws: false },
    { ending: '不发语句就抛错', statement: false, throws: true },
    { ending: '发一条语句再返回', statement: true, throws: false },
    { ending: '发一条语句再抛错', statement: true, throws: true },
  ])('回调空闲时被杀，之后$ending：驱动不再往断开的连接上写', async ({ statement, throws }) => {
    const entered = deferred<number>()
    const resume = deferred()
    const finished = deferred<unknown>()
    const running = database.db.transaction(async (tx) => {
      let rejected: unknown = null
      try {
        entered.resolve(await backendOf(tx))
        await resume.promise
        if (statement) rejected = await failure(() => tx.execute(sql`select 1`))
        if (throws) throw new Error('回调出错')
      } finally {
        finished.resolve(rejected)
      }
    })
    const pid = await entered.promise
    expect(await killDuring(side.db, pid, running)).toMatchObject({ code: 'CONNECTION_CLOSED' })
    resume.resolve()
    expect(pgErrorCode(await finished.promise)).toBe(statement ? 'CONNECTION_CLOSED' : undefined)
    await expectRecovered(pid)
  })

  it('事务结束之后句柄上的语句被驱动拒绝，不会落进这条连接上别的事务', async () => {
    // 只有一条连接的池子：第二个事务一定在同一条连接上
    let leaked!: Tx
    const first = await side.db.transaction(async (tx) => {
      leaked = tx
      return backendOf(tx)
    })
    expect(pgErrorCode(await failure(() => leaked.execute(sql`select 1`)))).toBe(
      'UNSAFE_TRANSACTION',
    )
    await side.db.transaction(async (tx) => {
      expect(await backendOf(tx)).toBe(first)
      expect(pgErrorCode(await failure(() => leaked.execute(sql`select 1`)))).toBe(
        'UNSAFE_TRANSACTION',
      )
    })
  })
})
