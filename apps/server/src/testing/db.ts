import { fileURLToPath } from 'node:url'

import { sql } from 'drizzle-orm'
import { pgTable, text, type PgTable } from 'drizzle-orm/pg-core'

import { connect, withSpace, type Database, type Db, type Tx } from '../db/client'
import { runMigrations } from '../db/migrate'
import { settings } from '../db/schema'
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

// 这条连接（事务句柄就是事务所在的连接）的后端进程号，杀连接时用
export async function backendOf(db: Db | Tx): Promise<number> {
  const [row] = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
  return row!.pid
}

// 杀掉这个后端，返回事务 reject 的错误；事务没有 reject 时抛错。先接住事务的 promise 再杀：
// kill 的响应回来之前事务可能已经 reject 了，那时还没人接就算未处理的 rejection
export async function killDuring(
  via: Db,
  pid: number,
  transaction: Promise<unknown>,
): Promise<unknown> {
  const rejection = transaction.then(
    () => {
      throw new Error('连接被杀了，事务却没有 reject')
    },
    (err: unknown) => err,
  )
  await via.execute(sql`select pg_terminate_backend(${pid})`)
  return rejection
}

// 读实例设置时数据库真的报错（改查一张不存在的表），别的查询照常，事务里也一样。drizzle 的错误信息带 SQL 与全部参数
const NO_SUCH_TABLE = pgTable('no_such_table', { key: text() })
export const settingsQueryFails = (db: Db): Db =>
  new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction') {
        return (run: (tx: Db) => Promise<unknown>) =>
          target.transaction((tx) => run(settingsQueryFails(tx as unknown as Db)))
      }
      if (prop !== 'select') return Reflect.get(target, prop)
      return (...args: []) =>
        new Proxy(target.select(...args), {
          get(builder, method) {
            if (method !== 'from') return Reflect.get(builder, method)
            return (table: PgTable) => builder.from(table === settings ? NO_SUCH_TABLE : table)
          },
        })
    },
  })

// 所有表的内容：回滚之后、不该写库的操作之后，要和之前逐行相同
export async function tableDigests(
  database: Database,
  spaceId: string,
): Promise<Record<string, string>> {
  const tables = await database.db.execute<{ name: string }>(sql`
    select table_name as name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)
  return withSpace(database.db, spaceId, async (tx) => {
    const out: Record<string, string> = {}
    for (const { name } of tables) {
      const [row] = await tx.execute<{ n: number; digest: string }>(
        sql.raw(`select count(*)::int as n,
          md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest
          from "${name}" t`),
      )
      out[name] = `${row!.n}:${row!.digest}`
    }
    return out
  })
}
