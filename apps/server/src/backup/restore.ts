import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { z } from 'zod'

import type { MasterKey } from '../crypto/keyring'
import type { Database, Tx } from '../db/client'
import { applyMigrations, lastMigration, lockMigrations } from '../db/migrate'
import { BACKUP_FORMAT, BACKUP_VERSION } from './export'
import { openBackup } from './format'

const Header = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  createdAt: z.string(),
  kioku: z.string(),
  migrations: z.object({ hash: z.string(), at: z.number().int() }),
})

const SectionHead = z.tuple([z.string().regex(/^[a-z_][a-z0-9_]*$/), z.guid().nullable()])

type Header = z.infer<typeof Header>

// 一段：哪张表、哪个空间，记录行在正文里的位置 [start, end) 与行数
interface Section {
  table: string
  space: string | null
  rows: number
  start: number
  end: number
}

const OPEN_BRACKET = 0x5b
const OPEN_BRACE = 0x7b

// 正文按行切开：每行在 [from, to) 里的起止位置。UTF-8 的多字节字符里不会出现换行符的字节
function* lineRanges(plain: Buffer, from = 0, to = plain.length): Generator<[number, number]> {
  for (let at = from; at < to;) {
    const newline = plain.indexOf(0x0a, at)
    const end = newline < 0 || newline >= to ? to : newline
    yield [at, end]
    at = end + 1
  }
}

const malformed = () => new Error('备份的内容不是预期的格式')

function parseLine<T>(plain: Buffer, [start, end]: [number, number], schema: z.ZodType<T>): T {
  let value: unknown
  try {
    value = JSON.parse(plain.toString('utf8', start, end))
  } catch {
    throw malformed()
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw malformed()
  return parsed.data
}

// 解开备份，读出文件头和各段的位置；记录行留在正文里，写回时再一批批取
export function readBackup(
  masterKey: MasterKey,
  file: Buffer,
): { header: Header; plain: Buffer; sections: Section[] } {
  const plain = openBackup(masterKey, file)
  const ranges = lineRanges(plain)
  const first = ranges.next()
  if (first.done) throw new Error('备份是空的')
  const raw = parseLine(plain, first.value, z.object({ format: z.string(), version: z.unknown() }))
  if (raw.format !== BACKUP_FORMAT) throw new Error('不是 Kioku 的备份')
  if (raw.version !== BACKUP_VERSION) {
    throw new Error(
      `备份的格式版本是 ${String(raw.version)}，这个版本的 Kioku 只认 ${BACKUP_VERSION}：用更新的版本恢复`,
    )
  }
  const header = parseLine(plain, first.value, Header)
  const sections: Section[] = []
  let current: Section | null = null
  for (let next = ranges.next(); !next.done; next = ranges.next()) {
    const [start, end] = next.value
    if (plain[start] === OPEN_BRACKET) {
      const [table, space] = parseLine(plain, next.value, SectionHead)
      current = { table, space, rows: 0, start: end + 1, end: end + 1 }
      sections.push(current)
    } else if (plain[start] === OPEN_BRACE && current) {
      current.rows++
      current.end = end
    } else {
      throw malformed()
    }
  }
  return { header, plain, sections }
}

export interface RestoreSummary {
  header: Header
  // 每张表写回了多少行
  rows: Record<string, number>
  // 备份来自较早的版本时，写回之后又执行了几个这个版本新增的迁移
  upgraded: number
}

// 把备份恢复到一个没有初始化的实例（没有账号和空间）。库是新建的空库时，先把迁移执行到做备份时的位置
// （单独提交：之后失败了，库还是空的、停在备份的位置，可以直接重试）；然后在一个事务里写回全部数据，
// 再执行这个版本新增的迁移：较早的备份也能用新版本恢复，数据走一遍和升级时一样的迁移，失败时一起撤销
export async function restoreBackup(
  database: Database,
  options: { migrationsFolder: string; masterKey: MasterKey; file: Buffer },
): Promise<RestoreSummary> {
  const { header, plain, sections } = readBackup(options.masterKey, options.file)
  const local = readMigrationFiles({ migrationsFolder: options.migrationsFolder })
  // 按时间戳在这个版本的迁移里找到备份时执行到的那一个，和 drizzle 判断执行到哪里的办法一样；
  // 哈希也要对上，库的结构才和备份时一样
  const positionOf = (at: number) => local.findIndex((m) => m.folderMillis === at) + 1
  const backup = header.migrations
  const position = positionOf(backup.at)
  if (!position && backup.at > local[local.length - 1]!.folderMillis) {
    throw new Error(
      `备份来自更新的版本（${header.kioku}），有这个版本没有的迁移：用不低于它的版本恢复`,
    )
  }
  if (!position || local[position - 1]!.hash !== backup.hash) {
    throw new Error(`备份的迁移与这个版本的对不上：用做备份的版本（${header.kioku}）恢复`)
  }

  const db = database.db
  if (!(await lastMigration(db))) {
    await db.transaction(async (tx) => {
      await lockMigrations(tx)
      // 拿到锁之前别的连接（例如同时启动的服务）可能已经迁移过了：那就不再执行，交给下面的核对
      if (!(await lastMigration(tx))) await applyMigrations(tx, local.slice(0, position))
    })
  }
  const rows = await db.transaction(async (tx) => {
    // 先拿到迁移的锁再核对库停在哪里：同时启动的服务要等这个事务结束才能迁移
    await lockMigrations(tx)
    const applied = await lastMigration(tx)
    if (!applied || applied.at !== backup.at || applied.hash !== backup.hash) {
      const at = applied ? positionOf(applied.at) : 0
      throw new Error(
        `这个库已经执行过迁移（到第 ${at || '?'} 个），备份是在第 ${position} 个时做的：恢复到一个新建的空库（恢复之前不要启动服务）`,
      )
    }
    const counts = await writeSections(tx, plain, sections)
    // 迁移按没有设置空间的连接执行，和服务启动时一样
    await tx.execute(sql`select set_config('app.space_id', '', true)`)
    await applyMigrations(tx, local.slice(position))
    return counts
  })
  return { header, rows, upgraded: local.length - position }
}

// 写回一段时每批最多多少行、多少字节
const BATCH_ROWS = 500
const BATCH_BYTES = 4 * 1024 * 1024

interface TableColumns {
  // 写回的列：数据库生成的列不写，由数据库重新算
  names: string[]
  // 自增列与它的序列：写回之后把序列推到最大值，之后新写的不撞号
  serials: { column: string; sequence: string }[]
}

// 表的列从库里读，不用这个版本的表定义：较早的备份写回时，库还停在备份时的结构
async function tableColumns(tx: Tx, table: string): Promise<TableColumns> {
  const rows = await tx.execute<{ name: string; sequence: string | null }>(sql`
    select a.attname as name, pg_get_serial_sequence(c.oid::regclass::text, a.attname) as sequence
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public' and c.relname = ${table} and c.relkind = 'r'
      and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    order by a.attnum`)
  if (!rows.length) throw new Error(`备份里的表 ${table} 在库里不存在`)
  return {
    names: rows.map((r) => r.name),
    serials: rows.flatMap((r) => (r.sequence ? [{ column: r.name, sequence: r.sequence }] : [])),
  }
}

// 库里的表都在 public 下。写明 schema：表名当作行类型用时（null::表名）不会被同名的内置类型抢先
const tableRef = (table: string) => sql`public.${sql.identifier(table)}`

async function writeSections(
  tx: Tx,
  plain: Buffer,
  sections: Section[],
): Promise<Record<string, number>> {
  const tables = [...new Set(sections.map((s) => s.table))]
  // 恢复期间别的连接（例如没停的服务）不能初始化这个实例
  await tx.execute(sql`lock table public.accounts, public.spaces in share mode`)
  const [existing] = await tx.execute<{ accounts: number; spaces: number }>(sql`
    select (select count(*) from public.accounts)::int as accounts,
      (select count(*) from public.spaces)::int as spaces`)
  if (existing!.accounts || existing!.spaces) {
    throw new Error(
      `这个实例已经初始化过（${existing!.accounts} 个账号、${existing!.spaces} 个空间）：只能恢复到没有账号和空间的新实例`,
    )
  }
  // 写回的是做备份时库里已有、已经通过检查的数据，表上的触发器不再执行：URI 互斥的检查每行一把咨询锁，
  // 上万条记忆放在一个事务里会占满锁表；触发器写下的派生数据本身也在备份里，再执行一遍会重复。外键照常检查。
  // 到事务结束前这些表别的连接也写不进来
  for (const table of tables) {
    await tx.execute(sql`alter table ${tableRef(table)} disable trigger user`)
  }
  const columns = new Map<string, TableColumns>()
  for (const table of tables) columns.set(table, await tableColumns(tx, table))
  // 没初始化的实例里，实例级的表只会有迁移或服务写下的默认值（例如开始记录召回的时间），以备份为准
  for (const table of new Set(sections.filter((s) => !s.space).map((s) => s.table))) {
    await tx.execute(sql`delete from ${tableRef(table)}`)
  }

  const counts: Record<string, number> = {}
  const maxima = new Map<string, bigint>()
  for (const section of sections) {
    const { names, serials } = columns.get(section.table)!
    const name = tableRef(section.table)
    const list = sql.join(
      names.map((c) => sql.identifier(c)),
      sql`, `,
    )
    await tx.execute(sql`select set_config('app.space_id', ${section.space ?? ''}, true)`)
    const insert = async (batch: string[]) => {
      const statement = sql`insert into ${name} (${list})
        select ${list} from jsonb_populate_recordset(null::${name}, ${`[${batch.join(',')}]`}::jsonb)`
      if (!serials.length) {
        await tx.execute(statement)
        return
      }
      const [row] = await tx.execute<{ maxima: (string | null)[] }>(sql`
        with inserted as (${statement} returning ${sql.join(
          serials.map((s) => sql.identifier(s.column)),
          sql`, `,
        )})
        select array[${sql.join(
          serials.map((s) => sql`max(${sql.identifier(s.column)})::text`),
          sql`, `,
        )}] as maxima from inserted`)
      serials.forEach((s, i) => {
        const value = row!.maxima[i]
        if (value === null || value === undefined) return
        const max = BigInt(value)
        if (max > (maxima.get(s.sequence) ?? 0n)) maxima.set(s.sequence, max)
      })
    }
    let batch: string[] = []
    let bytes = 0
    for (const [start, end] of lineRanges(plain, section.start, section.end)) {
      batch.push(plain.toString('utf8', start, end))
      bytes += end - start
      if (batch.length >= BATCH_ROWS || bytes >= BATCH_BYTES) {
        await insert(batch)
        batch = []
        bytes = 0
      }
    }
    if (batch.length) await insert(batch)
    counts[section.table] = (counts[section.table] ?? 0) + section.rows
  }
  for (const [sequence, max] of maxima) {
    await tx.execute(sql`select setval(${sequence}::regclass, ${max.toString()}::bigint)`)
  }
  for (const table of tables) {
    await tx.execute(sql`alter table ${tableRef(table)} enable trigger user`)
  }
  return counts
}
