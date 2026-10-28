import { fileURLToPath } from 'node:url'

import { sql } from 'drizzle-orm'

import { connect, type Database } from '../db/client'
import { runMigrations } from '../db/migrate'
import { settleRecallEvents } from '../recall/events'

// 集成测试共用：需要真实 PostgreSQL。本地用 docker-compose.dev.yml 起库后设置 KIOKU_TEST_DATABASE_URL；
// CI 里必须提供，没有就失败，避免集成测试被悄悄跳过。
export const testDatabaseUrl = process.env.KIOKU_TEST_DATABASE_URL
if (!testDatabaseUrl && process.env.CI) throw new Error('CI 环境缺少 KIOKU_TEST_DATABASE_URL')

const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url))

export async function openTestDatabase(): Promise<Database> {
  const database = connect(testDatabaseUrl!, { max: 2 })
  await runMigrations(database, migrationsFolder)
  return database
}

// 清空所有数据；内容表都挂在 spaces 或 accounts 下，级联即可。先等上一个用例还没写完的召回事件
export async function resetDatabase(database: Database): Promise<void> {
  await settleRecallEvents()
  await database.db.execute(sql`truncate spaces, accounts, login_attempts cascade`)
}
