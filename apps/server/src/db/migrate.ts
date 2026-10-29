import { readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import type { Database, Db, Tx } from './client'

// 多个实例同时启动时用会话级咨询锁串行执行迁移。锁和迁移必须在同一条连接上，
// 所以单独开一个只有一条连接的客户端，用完即关。给了 upTo 时只执行前 upTo 个（恢复备份时用）
export async function runMigrations(
  database: Database,
  migrationsFolder: string,
  upTo?: number,
): Promise<void> {
  const folder =
    upTo === undefined ? migrationsFolder : await migrationsPrefix(migrationsFolder, upTo)
  const client = postgres(database.url, { max: 1, onnotice: () => {} })
  try {
    await client`select pg_advisory_lock(hashtext('kioku.migrate'))`
    await migrate(drizzle(client, { casing: 'snake_case' }), { migrationsFolder: folder })
  } finally {
    await client.end()
    if (folder !== migrationsFolder) await rm(folder, { recursive: true, force: true })
  }
}

interface Journal {
  entries: { tag: string }[]
}

const readJournal = (migrationsFolder: string) =>
  JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as Journal

// 只含前 count 个迁移的临时目录：迁移文件原样复制（drizzle 按文件内容的哈希核对），目录清单截短
export async function migrationsPrefix(migrationsFolder: string, count: number): Promise<string> {
  const journal = readJournal(migrationsFolder)
  const entries = journal.entries.slice(0, count)
  const folder = await mkdtemp(join(tmpdir(), 'kioku-migrations-'))
  await mkdir(join(folder, 'meta'))
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  for (const { tag } of entries) {
    await copyFile(join(migrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`))
  }
  return folder
}

// 还有几个迁移没在这个库上执行。命令行工具据此拒绝在结构不对的库上写入，
// 迁移只交给服务启动时执行：工具与服务版本不一致时，不能让工具替库升级
export async function pendingMigrations(db: Db, migrationsFolder: string): Promise<number> {
  const total = readJournal(migrationsFolder).entries.length
  return total - (await appliedMigrations(db)).count
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
