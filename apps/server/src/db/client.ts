import { DrizzleQueryError, sql } from 'drizzle-orm'
import type { PgTransactionConfig } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { transactionMoment } from './moment'
import { microsOf } from './paging'
import * as schema from './schema'

export type Db = PostgresJsDatabase<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface Database {
  db: Db
  url: string
  close: () => Promise<void>
}

// postgres.js 连接选项统一在此定义：不发额外启动参数，兼容 PgBouncer 等连接池
export function postgresOptions(
  overrides: postgres.Options<Record<string, postgres.PostgresType>> = {},
): postgres.Options<Record<string, postgres.PostgresType>> {
  return { max: 10, onnotice: () => {}, ...overrides }
}

export function connect(url: string, options: { max?: number } = {}): Database {
  const client = postgres(url, postgresOptions(options.max ? { max: options.max } : {}))
  const db = drizzle(client, { schema, casing: 'snake_case' })
  return { db, url, close: () => client.end() }
}

const moments = new WeakMap<object, Date>()
const STATEMENT_MICROS = microsOf(sql`statement_timestamp()`)

// 开启事务并同步取一次数据库时间（截到毫秒），作为事务内有效期与更新时间判断的唯一时钟
export async function withTx<T>(
  db: Db | Tx,
  fn: (tx: Tx, now: Date) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ micros: string }>(
      sql`select ${STATEMENT_MICROS}::text as micros`,
    )
    const now = new Date(Number(BigInt(row!.micros) / 1000n))
    moments.set(tx, now)
    return transactionMoment.run(now, () => fn(tx, now))
  }, config)
}

// 获取当前数据库时间（截到毫秒），用于事务外的过期与清理判断
export async function databaseNow(db: Db | Tx): Promise<Date> {
  const [row] = await db.execute<{ micros: string }>(
    sql`select ${STATEMENT_MICROS}::text as micros`,
  )
  return new Date(Number(BigInt(row!.micros) / 1000n))
}

export function nowOf(tx: Tx): Date {
  const now = moments.get(tx)
  if (!now) throw new Error('nowOf 只能用在 withTx 开的事务里')
  return now
}

function pgError(err: unknown): { code?: unknown; constraint_name?: string; message?: string } {
  const pg = err instanceof DrizzleQueryError ? err.cause : err
  return (pg ?? {}) as { code?: unknown }
}

export function pgMessage(err: unknown): string | undefined {
  return pgError(err).message
}

export function pgErrorCode(err: unknown): string | undefined {
  const { code } = pgError(err)
  return typeof code === 'string' ? code : undefined
}

function connectionCause(err: unknown): { code?: unknown; message?: string } | undefined {
  if (!pgErrorCode(err)?.startsWith('CONNECTION_')) return undefined
  const pg = pgError(err) as { cause?: unknown }
  return (pg.cause ?? {}) as { code?: unknown; message?: string }
}

export function pgCauseCode(err: unknown): string | undefined {
  const code = connectionCause(err)?.code
  return typeof code === 'string' ? code : undefined
}

export function pgConstraint(err: unknown): string | undefined {
  return pgError(err).constraint_name
}

// 过滤 SQL 与参数避免在日志中泄露记忆正文或凭据，仅保留 SQLSTATE、约束名与说明
export function loggableError(err: unknown): unknown {
  if (!(err instanceof DrizzleQueryError || err instanceof postgres.PostgresError)) return err
  const pg = pgError(err)
  return { code: pg.code, constraint: pg.constraint_name, message: pg.message }
}

export function logInternalError(where: string, err: unknown): void {
  console.error(where, loggableError(err))
}

export function errorText(err: unknown): string {
  const lost = connectionCause(err)
  if (lost) return lost.message ? `数据库连接断开：${lost.message}` : '数据库连接断开'
  if (err instanceof DrizzleQueryError) return pgMessage(err) ?? '数据库出错'
  return err instanceof Error ? err.message : String(err)
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = pgError(err)
  if (pg.code !== '23505') return false
  return constraint ? pg.constraint_name === constraint : true
}
