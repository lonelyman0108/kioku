import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import type { Database } from './client'

// 多个实例同时启动时用会话级咨询锁串行执行迁移；锁要和迁移在同一条连接上，所以单独借出一条
export async function runMigrations(database: Database, migrationsFolder: string): Promise<void> {
  const conn = await database.client.reserve()
  try {
    await conn`select pg_advisory_lock(hashtext('kioku.migrate'))`
    await migrate(drizzle(conn, { casing: 'snake_case' }), { migrationsFolder })
  } finally {
    await conn`select pg_advisory_unlock(hashtext('kioku.migrate'))`.catch(() => {})
    conn.release()
  }
}
