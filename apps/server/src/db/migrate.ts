import { sql } from 'drizzle-orm'
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { postgresOptions, type Database, type Db, type Tx } from './client'

const MIGRATE_LOCK = 'kioku.migrate'

const PRE_BASELINE_DATABASE =
  '数据库是旧架构的结构，不兼容当前版本，无法直接迁移：请清空或新建空库后再启动'

// 使用会话级咨询锁串行执行迁移，锁与迁移共用同一条连接
export async function runMigrations(database: Database, migrationsFolder: string): Promise<void> {
  const client = postgres(database.url, postgresOptions({ max: 1 }))
  try {
    await client`select pg_advisory_lock(hashtext(${MIGRATE_LOCK}))`
    await assertKnownMigrations(client, readMigrationFiles({ migrationsFolder }))
    await migrate(drizzle(client, { casing: 'snake_case' }), { migrationsFolder })
  } finally {
    await client.end()
  }
}

export class MigrationStateError extends Error {
  constructor(
    readonly state: 'pre_baseline' | 'newer',
    unknown = 0,
  ) {
    super(
      state === 'pre_baseline'
        ? PRE_BASELINE_DATABASE
        : `数据库里有这个版本没有的迁移（${unknown} 个）：库来自更新的版本，或迁移文件已被修改`,
    )
  }
}

type MigrationState =
  { state: 'none' | 'known' } | { state: 'pre_baseline' | 'newer'; unknown: number }

export async function migrationState(
  client: postgres.Sql | postgres.TransactionSql,
  migrationsFolder: string,
): Promise<MigrationState['state']> {
  return (await classifyMigrations(client, readMigrationFiles({ migrationsFolder }))).state
}

async function classifyMigrations(
  client: postgres.Sql | postgres.TransactionSql,
  local: readonly MigrationMeta[],
): Promise<MigrationState> {
  const [table] = await client<{ exists: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as exists`
  if (!table?.exists) return { state: 'none' }
  const hashes = new Set(local.map((m) => m.hash))
  const unknown = (
    await client<{ hash: string; at: string }[]>`
      select hash, created_at::text as at from drizzle.__drizzle_migrations`
  ).filter((m) => !hashes.has(m.hash))
  if (!unknown.length) return { state: 'known' }
  const baseline = local[0]?.folderMillis ?? 0
  const state = unknown.some((m) => Number(m.at) < baseline) ? 'pre_baseline' : 'newer'
  return { state, unknown: unknown.length }
}

async function assertKnownMigrations(
  client: postgres.Sql,
  local: readonly MigrationMeta[],
): Promise<void> {
  const result = await classifyMigrations(client, local)
  if (result.state === 'pre_baseline' || result.state === 'newer') {
    throw new MigrationStateError(result.state, result.unknown)
  }
}

export async function pendingMigrations(db: Db, migrationsFolder: string): Promise<number | null> {
  const local = readMigrationFiles({ migrationsFolder })
  const last = await lastMigration(db)
  if (!last) return local.length
  const position = local.findIndex((m) => m.folderMillis === last.at) + 1
  return position ? local.length - position : null
}

export async function lastMigration(db: Db | Tx): Promise<{ hash: string; at: number } | null> {
  const [table] = await db.execute<{ exists: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`,
  )
  if (!table?.exists) return null
  const [row] = await db.execute<{ hash: string; at: string }>(sql`
    select hash, created_at::text as at from drizzle.__drizzle_migrations
    order by created_at desc limit 1`)
  return row ? { hash: row.hash, at: Number(row.at) } : null
}
