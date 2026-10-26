import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import type { Database, Db } from './client'

// 多个实例同时启动时用会话级咨询锁串行执行迁移。锁和迁移必须在同一条连接上，
// 所以单独开一个只有一条连接的客户端，用完即关。
export async function runMigrations(database: Database, migrationsFolder: string): Promise<void> {
  const client = postgres(database.url, { max: 1, onnotice: () => {} })
  try {
    await client`select pg_advisory_lock(hashtext('kioku.migrate'))`
    await migrate(drizzle(client, { casing: 'snake_case' }), { migrationsFolder })
  } finally {
    await client.end()
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
  const [table] = await db.execute<{ exists: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`,
  )
  if (!table?.exists) return journal.entries.length
  const [row] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
  )
  return journal.entries.length - (row?.n ?? 0)
}
