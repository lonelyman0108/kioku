import { AsyncLocalStorage } from 'node:async_hooks'

import { DrizzleQueryError, sql } from 'drizzle-orm'
import type { PgTransactionConfig } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

export type Db = PostgresJsDatabase<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface Database {
  db: Db
  url: string
  close: () => Promise<void>
}

export function connect(url: string, options: { max?: number } = {}): Database {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} })
  const db = drizzle(client, { schema, casing: 'snake_case' })
  return { db, url, close: () => client.end() }
}

// 内容表只能在这里面访问：事务内声明当前空间，RLS 据此过滤；事务结束后设置自动失效，不会串到连接池里的下一个请求。
// config 是事务的选项，例如导出时要一个可重复读的只读事务
export function withSpace<T>(
  db: Db,
  spaceId: string,
  fn: (tx: Tx) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.space_id', ${spaceId}, true)`)
    return fn(tx)
  }, config)
}

// 跨空间统计（实例的向量覆盖率、主密钥卡片的计数）整个进程里最多同时开几个空间的事务（服务只有一个连接池）：
// 每个事务占一条连接，几处统计、几个页面同时数也合起来算。某个空间等锁卡住时最多卡住这几条，别的请求照常有连接用
export const SPACE_SCAN_PARALLEL = 4
const scanSlots = { free: SPACE_SCAN_PARALLEL, waiting: [] as (() => void)[] }
// 正在 eachSpace 的 fn 里
const scanning = new AsyncLocalStorage<true>()

// 对每个空间在它自己的事务里调用 fn（内容表开了 RLS，一个事务只看得到一个空间），几个空间同时数，不逐个排队。
// 每数一个空间取一次名额、数完还回去，几处同时数时轮流用，谁也不用等别人整个数完。
// 有一个空间出错就不再开始别的，等已经开始的都结束再抛出这个错误：返回或抛出之后不会还有空间的事务没结束。
// 连接断开是例外：withSpace 立刻 reject，那个事务已经没了，fn 还在跑，到它的下一条语句报错才停（时间很短），
// 所以这时返回或抛出之后 fn 可能还没跑完。
// fn 里再调 eachSpace 直接报错：外层占着名额等里层，名额会被占满、互相等住
export async function eachSpace(db: Db, fn: (tx: Tx) => Promise<void>): Promise<void> {
  if (scanning.getStore()) throw new Error('eachSpace 不能嵌套调用')
  const all = await db.select({ id: schema.spaces.id }).from(schema.spaces)
  let next = 0
  let failure: { error: unknown } | undefined
  const worker = async () => {
    while (!failure && next < all.length) {
      const { id } = all[next++]!
      if (scanSlots.free) scanSlots.free--
      else await new Promise<void>((resolve) => scanSlots.waiting.push(resolve))
      try {
        if (!failure) await scanning.run(true, () => withSpace(db, id, fn))
      } catch (error) {
        failure ??= { error }
      } finally {
        // 名额直接交给排着队的下一个
        const waiter = scanSlots.waiting.shift()
        if (waiter) waiter()
        else scanSlots.free++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SPACE_SCAN_PARALLEL, all.length) }, worker))
  if (failure) throw failure.error
}

// 数据库报的错：drizzle 把驱动的错误包在 cause 里，只解开这一种。驱动直接抛的错误不解开：
// 连接错误（CONNECTION_CLOSED）自带 cause（57P01、ECONNRESET 这些），解开就成了另一个错误，同一次断连会记成不同的 code。
// drizzle 的错误没有 cause 时什么也不给：它的 message 带着 SQL 与全部参数
function pgError(err: unknown): { code?: string; constraint_name?: string; message?: string } {
  const pg = err instanceof DrizzleQueryError ? err.cause : err
  return (pg ?? {}) as { code?: string }
}

// 数据库给的错误说明（例如哪个值超出了范围），没有时为 undefined
export function pgMessage(err: unknown): string | undefined {
  return pgError(err).message
}

// 数据库报错的 SQLSTATE
export function pgErrorCode(err: unknown): string | undefined {
  return pgError(err).code
}

// 违反的是哪一条约束（唯一、外键、检查约束），数据库没给出时为 undefined
export function pgConstraint(err: unknown): string | undefined {
  return pgError(err).constraint_name
}

// 能写进日志的错误：drizzle 错误的 message 带着 SQL 与全部参数（正文、提示语、密文都可能在里面），不能整个打出来，
// 只留 SQLSTATE、约束名与说明。别的错误原样，堆栈和 cause 都还在，否则查不出是哪里
export function loggableError(err: unknown): unknown {
  if (!(err instanceof DrizzleQueryError)) return err
  const pg = err.cause as { code?: string; constraint_name?: string; message?: string } | undefined
  return { code: pg?.code, constraint: pg?.constraint_name, message: pg?.message }
}

export function logInternalError(where: string, err: unknown): void {
  console.error(where, loggableError(err))
}

// 能记进「最近的错误」、给人看的文字：drizzle 错误的 message 带着 SQL 与全部参数（正文、密文都可能在里面），
// 只给数据库报的说明，没有说明时也不退回 message。别的错误给它自己的 message
export function errorText(err: unknown): string {
  if (err instanceof DrizzleQueryError) return err.cause?.message ?? '数据库出错'
  return err instanceof Error ? err.message : String(err)
}

// 违反了指定的唯一约束
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pg = pgError(err)
  return pg.code === '23505' && pg.constraint_name === constraint
}

// 超级用户和 BYPASSRLS 角色会绕过行级安全，空间隔离就形同虚设，所以直接拒绝启动
export async function assertRuntimeRole(db: Db): Promise<void> {
  const rows = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    sql`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
  )
  const role = rows[0]
  if (!role) throw new Error('无法读取当前数据库角色')
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `数据库角色 ${role.rolname} 是超级用户或带 BYPASSRLS，会绕过空间隔离；请改用普通角色连接（见 docker/postgres/init）`,
    )
  }
}
