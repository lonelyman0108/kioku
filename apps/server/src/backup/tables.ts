import { is } from 'drizzle-orm'
import { toSnakeCase } from 'drizzle-orm/casing'
import { getTableConfig, PgTable, type PgColumn } from 'drizzle-orm/pg-core'

import * as schema from '../db/schema'
import { RLS_TABLES } from '../db/schema'

// 备份里有哪些表、按什么顺序写回。表的清单从 drizzle 的表定义里取，新加的表自动进备份，
// 不该进的在这里排除：会话与登录计数（恢复后重新登录）、对话缓冲（抽取完就删的临时数据）、
// 向量（恢复后按设置重新生成，换了模型也不用改备份）

const EXCLUDED = new Set(['sessions', 'login_attempts', 'conversation_turns', 'memory_embeddings'])

export interface BackupTable {
  name: string
  // 受行级安全约束的表要按空间读
  perSpace: boolean
  // 数据库生成的列（全文检索）不进备份，写回时由数据库重新算
  omitted: string[]
  // 指向同一张表的外键（例如人格的继承）：导出时被指向的行排在前面，按文件里的顺序写回就不违反外键
  selfRef: { column: string; references: string } | null
}

// 库里的列名：连接上配了 snake_case，没有显式写列名的按属性名转换（db/client.ts）
const columnName = (c: PgColumn) => (c.keyAsName ? toSnakeCase(c.name) : c.name)

function describe(table: PgTable): { table: BackupTable; dependsOn: string[] } {
  const config = getTableConfig(table)
  const dependsOn = new Set<string>()
  let selfRef: BackupTable['selfRef'] = null
  for (const fk of config.foreignKeys) {
    const ref = fk.reference()
    const target = getTableConfig(ref.foreignTable).name
    if (target !== config.name) dependsOn.add(target)
    else if (ref.columns.length === 1 && !selfRef) {
      selfRef = {
        column: columnName(ref.columns[0]!),
        references: columnName(ref.foreignColumns[0]!),
      }
    } else throw new Error(`${config.name} 指向自己的外键不止一列，备份还不支持`)
  }
  return {
    table: {
      name: config.name,
      perSpace: (RLS_TABLES as readonly string[]).includes(config.name),
      omitted: config.columns.filter((c) => c.generated).map(columnName),
      selfRef,
    },
    dependsOn: [...dependsOn],
  }
}

// 按外键排好的顺序：被指向的表在前。同一层里按表名排，顺序固定。
// 备份里的表不能指向不进备份的表，否则写回时外键对不上
function ordered(): BackupTable[] {
  const all = (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => is(value, PgTable))
    .map(describe)
    .filter(({ table }) => !EXCLUDED.has(table.name))
  for (const { table, dependsOn } of all) {
    const missing = dependsOn.filter((d) => EXCLUDED.has(d))
    if (missing.length) throw new Error(`${table.name} 指向不进备份的表 ${missing.join('、')}`)
  }
  const pending = new Map(
    all.map(({ table, dependsOn }) => [table.name, { table, waiting: new Set(dependsOn) }]),
  )
  const result: BackupTable[] = []
  while (pending.size) {
    const ready = [...pending.values()]
      .filter((p) => !p.waiting.size)
      .sort((a, b) => a.table.name.localeCompare(b.table.name))
    if (!ready.length) throw new Error(`表之间的外键有环：${[...pending.keys()].join('、')}`)
    for (const { table } of ready) {
      result.push(table)
      pending.delete(table.name)
      for (const p of pending.values()) p.waiting.delete(table.name)
    }
  }
  return result
}

export const BACKUP_TABLES = ordered()
