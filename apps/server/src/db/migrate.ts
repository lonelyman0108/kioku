import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import type { Database, Db, Tx } from './client'

// 执行迁移的咨询锁：服务启动时的迁移与恢复备份时的迁移用同一把，互相排队
const MIGRATE_LOCK = 'kioku.migrate'

// 多个实例同时启动时用会话级咨询锁串行执行迁移。锁和迁移必须在同一条连接上，
// 所以单独开一个只有一条连接的客户端，用完即关。
export async function runMigrations(database: Database, migrationsFolder: string): Promise<void> {
  const client = postgres(database.url, { max: 1, onnotice: () => {} })
  try {
    await client`select pg_advisory_lock(hashtext(${MIGRATE_LOCK}))`
    await migrate(drizzle(client, { casing: 'snake_case' }), { migrationsFolder })
  } finally {
    await client.end()
  }
}

// 在调用方的事务里拿住迁移的锁：到事务结束前，别的连接（例如正在启动的服务）都执行不了迁移
export async function lockMigrations(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${MIGRATE_LOCK}))`)
}

// 在调用方的事务里执行给出的迁移。做法和 drizzle 的迁移器一样：逐段执行语句，
// 再在 drizzle.__drizzle_migrations 里记下哈希与时间戳。恢复备份时用，迁移与写回的数据同进同退
export async function applyMigrations(tx: Tx, migrations: MigrationMeta[]): Promise<void> {
  await lockMigrations(tx)
  await tx.execute(sql`create schema if not exists drizzle`)
  await tx.execute(sql`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key, hash text not null, created_at bigint
    )`)
  for (const migration of migrations) {
    for (const statement of migration.sql) await tx.execute(sql.raw(statement))
    await tx.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${migration.hash}, ${migration.folderMillis})`,
    )
  }
}

// 还有几个迁移没在这个库上执行。命令行工具据此拒绝在结构不对的库上写入，
// 迁移只交给服务启动时执行：工具与服务版本不一致时，不能让工具替库升级
export async function pendingMigrations(db: Db, migrationsFolder: string): Promise<number> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as {
    entries: unknown[]
  }
  return journal.entries.length - (await appliedMigrations(db)).count
}

// 库里已经执行过的迁移：一共几个，以及最后一个（按时间戳）的哈希与时间戳。drizzle 记的哈希是迁移文件内容的 sha256，
// 判断哪些迁移还没执行只看最后一个的时间戳
export interface AppliedMigrations {
  count: number
  last: { hash: string; at: number } | null
}

export async function appliedMigrations(db: Db | Tx): Promise<AppliedMigrations> {
  const [table] = await db.execute<{ exists: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`,
  )
  if (!table?.exists) return { count: 0, last: null }
  const [row] = await db.execute<{ count: number; hash: string | null; at: string | null }>(sql`
    select count(*)::int as count, (array_agg(hash order by created_at desc))[1] as hash,
      max(created_at)::text as at
    from drizzle.__drizzle_migrations`)
  return {
    count: row?.count ?? 0,
    last: row?.hash && row.at ? { hash: row.hash, at: Number(row.at) } : null,
  }
}
