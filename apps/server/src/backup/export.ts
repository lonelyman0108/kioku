import { sql, type SQL } from 'drizzle-orm'

import type { MasterKey } from '../crypto/keyring'
import type { Db, Tx } from '../db/client'
import { appliedMigrations, type AppliedMigrations } from '../db/migrate'
import { VERSION } from '../version'
import { backupKeyId, sealBackup } from './format'
import { BACKUP_TABLES, type BackupTable } from './tables'

// 备份的正文是 JSON Lines：第一行是文件头；之后每张表一段（按空间的表每个空间一段），段头一行
// {table, space, rows}，接着 rows 行记录，每行是一条记录的 to_jsonb（键是库里的列名）。
// 表按外键排好了顺序，恢复时照文件里的顺序写回
export const BACKUP_FORMAT = 'kioku-backup'
export const BACKUP_VERSION = 1

export interface BackupHeader {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: string
  // 做备份的 Kioku 版本，恢复时提示用
  kioku: string
  // 做备份时库里执行过的迁移：一共几个，最后一个的哈希与时间戳。恢复时先把新库迁移到同样的位置
  migrations: AppliedMigrations
}

export interface BackupSection {
  table: string
  space: string | null
  rows: number
}

export interface BackupSummary {
  createdAt: string
  keyId: string
  bytes: number
  // 每张表备份了多少行
  rows: Record<string, number>
}

// 每次从游标取多少行
const FETCH = 500

// 整份备份在一个可重复读的只读事务里读出：各表是同一时刻的快照，服务照常读写也不会读到写了一半的数据。
// 按空间的表在事务里逐个切换 app.space_id 读
export async function createBackup(
  db: Db,
  masterKey: MasterKey,
): Promise<{ file: Buffer; summary: BackupSummary }> {
  const createdAt = new Date().toISOString()
  const rows: Record<string, number> = {}
  const file = await db.transaction((tx) => sealBackup(masterKey, lines(tx, createdAt, rows)), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  })
  return { file, summary: { createdAt, keyId: backupKeyId(file), bytes: file.length, rows } }
}

async function* lines(
  tx: Tx,
  createdAt: string,
  counts: Record<string, number>,
): AsyncGenerator<string> {
  // bytea 一律按十六进制写出，不受服务器设置影响
  await tx.execute(sql`set local bytea_output = 'hex'`)
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    kioku: VERSION,
    migrations: await appliedMigrations(tx),
  }
  yield `${JSON.stringify(header)}\n`

  const spaceIds = (await tx.execute<{ id: string }>(sql`select id from spaces order by id`)).map(
    (r) => r.id,
  )
  for (const table of BACKUP_TABLES) {
    let total = 0
    for (const space of table.perSpace ? spaceIds : [null]) {
      if (space) await tx.execute(sql`select set_config('app.space_id', ${space}, true)`)
      const [count] = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table.name)}`,
      )
      const rows = count?.n ?? 0
      if (!rows) continue
      const section: BackupSection = { table: table.name, space, rows }
      yield `${JSON.stringify(section)}\n`
      await tx.execute(sql`declare backup_rows no scroll cursor for ${rowsQuery(table)}`)
      let read = 0
      for (;;) {
        const batch = await tx.execute<{ row: string }>(
          sql.raw(`fetch forward ${FETCH} from backup_rows`),
        )
        read += batch.length
        if (batch.length) yield batch.map((r) => `${r.row}\n`).join('')
        if (batch.length < FETCH) break
      }
      await tx.execute(sql`close backup_rows`)
      // 同一个快照里数出的行数和读出的应当一样；对不上时段头就错位了，宁可这份备份失败
      if (read !== rows) throw new Error(`${table.name} 读出 ${read} 行，段头记的是 ${rows} 行`)
      total += rows
    }
    counts[table.name] = total
  }
}

function rowsQuery(table: BackupTable): SQL {
  const name = sql.identifier(table.name)
  const row = sql`(to_jsonb(t)${sql.join(table.omitted.map((c) => sql` - ${c}::text`))})::text as row`
  if (!table.selfRef) return sql`select ${row} from ${name} t`
  // 从没有上级的行往下按层级排，上级总在前面（服务保证继承关系无环、在同一个空间里）
  const column = sql.identifier(table.selfRef.column)
  const key = sql.identifier(table.selfRef.references)
  return sql`with recursive depth(${key}, n) as (
      select ${key}, 0 from ${name} where ${column} is null
      union all
      select c.${key}, d.n + 1 from ${name} c join depth d on c.${column} = d.${key}
    )
    select ${row} from ${name} t left join depth d on d.${key} = t.${key} order by d.n nulls last`
}
