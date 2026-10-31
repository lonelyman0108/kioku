import { DrizzleQueryError, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openTestDatabase, testDatabaseUrl } from '../../testing/db'
import { connect, pgErrorCode, withSpace, type Database, type Tx } from '../client'
import { settings } from '../schema'

// withSpace 只是声明当前空间，这里写的 settings 不是内容表，这个空间不必存在
const SPACE = '00000000-0000-4000-8000-000000000000'
const KEY = 'disconnect-test'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// 执行一下，返回抛出的错误；没抛错时返回 null
const failure = async (run: () => unknown): Promise<unknown> => {
  try {
    await run()
    return null
  } catch (err) {
    return err
  }
}

// 经 drizzle 发的语句，错误包在 cause 里；开 savepoint 这类语句由驱动直接发，错误不经包装
const codeOf = (err: unknown) =>
  err instanceof DrizzleQueryError
    ? (err.cause as { code?: string }).code
    : (err as { code?: string } | null)?.code

// 事务进行中连接断开（数据库重启、网络断开、后端被杀）：语句和事务的 promise 都正常 reject，不能变成未捕获的异常，
// 那会让整个进程退出（这里 vitest 也会判失败）；之后连接池照常能用
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

  const backendOf = async (tx: Tx) => {
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
    return row!.pid
  }
  const kill = (pid: number) => side.db.execute(sql`select pg_terminate_backend(${pid})`)
  // 等到这个后端真的在执行语句
  const untilRunning = async (pid: number) => {
    for (;;) {
      const [row] = await side.db.execute<{ state: string | null }>(
        sql`select state from pg_stat_activity where pid = ${pid}`,
      )
      if (row?.state === 'active') return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  // 连接池照常能用：换了一条连接，事务也开得起来；被杀的事务写下的不在
  const expectRecovered = async (killed: number) => {
    const [row] = await database.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
    expect(row!.pid).not.toBe(killed)
    const pid = await database.db.transaction(backendOf)
    expect(pid).not.toBe(killed)
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
    await kill(pid)
    await expect(running).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
    resume.resolve()
    for (const err of await after.promise) expect(codeOf(err)).toBe('CONNECTION_CLOSED')
    await expectRecovered(pid)
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
    await untilRunning(pid)
    await kill(pid)
    await expect(running).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
    expect(pgErrorCode(await statement.promise)).toBe('57P01')
    await expectRecovered(pid)
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
    await kill(pid)
    await expect(running).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
    resume.resolve()
    for (const err of await after.promise) expect(codeOf(err)).toBe('CONNECTION_CLOSED')
    await expectRecovered(pid)
  })

  it.each(['返回', '抛错'])(
    '回调空闲时被杀、之后不发语句就%s：驱动不再往断开的连接上写',
    async (how) => {
      const entered = deferred<number>()
      const resume = deferred()
      const running = database.db.transaction(async (tx) => {
        entered.resolve(await backendOf(tx))
        await resume.promise
        if (how === '抛错') throw new Error('回调出错')
      })
      const pid = await entered.promise
      await kill(pid)
      await expect(running).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
      resume.resolve()
      await expectRecovered(pid)
    },
  )

  it('事务结束之后句柄上的语句被驱动拒绝，不会落进这条连接上别的事务', async () => {
    // 只有一条连接的池子：第二个事务一定在同一条连接上
    let leaked!: Tx
    const first = await side.db.transaction(async (tx) => {
      leaked = tx
      return backendOf(tx)
    })
    expect(codeOf(await failure(() => leaked.execute(sql`select 1`)))).toBe('UNSAFE_TRANSACTION')
    await side.db.transaction(async (tx) => {
      expect(await backendOf(tx)).toBe(first)
      expect(codeOf(await failure(() => leaked.execute(sql`select 1`)))).toBe('UNSAFE_TRANSACTION')
    })
  })
})
