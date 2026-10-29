import type { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { sql, type SQL } from 'drizzle-orm'

import { encryptionKey, type MasterKey } from '../crypto/keyring'
import type { Db, Tx } from '../db/client'
import { lastMigration } from '../db/migrate'
import { VERSION } from '../version'
import { sealBackup } from './format'
import { BACKUP_TABLES, type BackupTable } from './tables'

// 备份的正文是 JSON Lines：第一行是文件头；之后每张表一段（按空间的表每个空间一段），段头是一个数组
// [表名, 空间 id 或 null]，接着每行一条记录的 to_jsonb（键是库里的列名）。段头以 [ 开头、记录以 { 开头，
// 读的时候看第一个字符就分得开。表按外键排好了顺序，恢复时照文件里的顺序写回。实例级的表没有记录也写段头：
// 恢复时以备份为准清掉新库里迁移写下的默认值；按空间的表没有记录的不占一段
export const BACKUP_FORMAT = 'kioku-backup'
export const BACKUP_VERSION = 1

export interface BackupHeader {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: string
  // 做备份的 Kioku 版本，恢复时提示用
  kioku: string
  // 做备份时库里执行到的迁移：最后一个的哈希与时间戳。恢复时先把新库迁移到同样的位置
  migrations: { hash: string; at: number }
}

export type BackupSectionHead = [table: string, space: string | null]

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
// 按空间的表在事务里逐个切换 app.space_id 读。边读边压缩、加密，直接写进 out
export async function createBackup(
  db: Db,
  masterKey: MasterKey,
  out: Writable,
): Promise<BackupSummary> {
  const createdAt = new Date().toISOString()
  const rows: Record<string, number> = {}
  let bytes = 0
  await db.transaction(
    async (tx) => {
      const source = lines(tx, createdAt, rows)
      try {
        await pipeline(
          sealBackup(masterKey, source),
          async function* (chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              bytes += chunk.length
              yield chunk
            }
          },
          out,
        )
      } finally {
        // 写出出错时（例如磁盘满了）管道先失败，读正文的查询可能还在跑：等它停下再结束事务，
        // 不在事务结束之后还往这条连接上发查询
        await source.return(undefined).catch(() => {})
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
  return { createdAt, keyId: encryptionKey(masterKey).id, bytes, rows }
}

async function* lines(
  tx: Tx,
  createdAt: string,
  counts: Record<string, number>,
): AsyncGenerator<string> {
  // bytea 一律按十六进制写出，不受服务器设置影响
  await tx.execute(sql`set local bytea_output = 'hex'`)
  const migrations = await lastMigration(tx)
  if (!migrations) throw new Error('库里没有迁移记录')
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    kioku: VERSION,
    migrations,
  }
  yield `${JSON.stringify(header)}\n`

  const spaceIds = (await tx.execute<{ id: string }>(sql`select id from spaces order by id`)).map(
    (r) => r.id,
  )
  for (const table of BACKUP_TABLES) {
    let total = 0
    for (const space of table.perSpace ? spaceIds : [null]) {
      if (space) await tx.execute(sql`select set_config('app.space_id', ${space}, true)`)
      await tx.execute(sql`declare backup_rows no scroll cursor for ${rowsQuery(table)}`)
      // 段头跟着第一批记录写出；实例级的表没有记录也写
      let head = `${JSON.stringify([table.name, space] satisfies BackupSectionHead)}\n`
      for (;;) {
        const batch = await tx.execute<{ row: string }>(
          sql.raw(`fetch forward ${FETCH} from backup_rows`),
        )
        if (batch.length || (head && !space)) {
          yield head + batch.map((r) => `${r.row}\n`).join('')
          head = ''
          total += batch.length
        }
        if (batch.length < FETCH) break
      }
      await tx.execute(sql`close backup_rows`)
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
