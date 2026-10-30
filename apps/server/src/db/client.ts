import { sql } from 'drizzle-orm'
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

// 跨空间统计（实例的向量覆盖率、主密钥卡片的计数）整个进程里最多同时开几个空间的事务：每个事务占一条连接，
// 几处统计、几个页面同时数也合起来算，连接池里留出给别的请求用的
export const SPACE_SCAN_PARALLEL = 4
let scanning = 0
const scanQueue: (() => void)[] = []

// 对每个空间在它自己的事务里调用 fn（内容表开了 RLS，一个事务只看得到一个空间），几个空间同时数，不逐个排队。
// 有一个空间出错就不再开始别的，等已经开始的都结束再抛出这个错误：返回或抛出之后不会还有空间的事务没结束。
// fn 里不要再调 eachSpace：外层占着名额等里层，名额会被占满、互相等住
export async function eachSpace(db: Db, fn: (tx: Tx) => Promise<void>): Promise<void> {
  const all = await db.select({ id: schema.spaces.id }).from(schema.spaces)
  let failure: { error: unknown } | undefined
  await Promise.all(
    all.map(async ({ id }) => {
      if (scanning < SPACE_SCAN_PARALLEL) scanning++
      else await new Promise<void>((resolve) => scanQueue.push(resolve))
      try {
        if (!failure) await withSpace(db, id, fn)
      } catch (error) {
        failure ??= { error }
      } finally {
        // 名额直接交给排着队的下一个
        const next = scanQueue.shift()
        if (next) next()
        else scanning--
      }
    }),
  )
  if (failure) throw failure.error
}

// 数据库报的错：drizzle 把驱动的错误包在 cause 里
function pgError(err: unknown): { code?: string; constraint_name?: string; message?: string } {
  return ((err as { cause?: unknown })?.cause ?? err) as { code?: string }
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
