import type { ActivityField, ActivityFieldChange, MemorySnapshot } from '@kioku/contracts'
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'

import { apiKeys, memoryEvents } from '../db/schema'

// 前后两版之间改了哪些字段；正文两边都没有（secret）时看不出改没改，不算。
// SQL 版是 changedFieldsSql，两份按同一条规则写，activity.int.test.ts 逐条比对
export function changedFields(
  before: MemorySnapshot | null,
  after: MemorySnapshot | null,
): ActivityField[] {
  if (!before || !after) return []
  const changes: ActivityField[] = []
  if (before.uri !== after.uri) changes.push('uri')
  if (before.title !== after.title) changes.push('title')
  if (before.layer !== after.layer) changes.push('layer')
  if (before.sensitivity !== after.sensitivity) changes.push('sensitivity')
  if (before.priority !== after.priority) changes.push('priority')
  if (before.disclosure !== after.disclosure) changes.push('disclosure')
  if (before.glossary.join('\n') !== after.glossary.join('\n')) changes.push('glossary')
  if (before.content !== after.content && (before.content !== null || after.content !== null)) {
    changes.push('content')
  }
  if (before.validTo !== after.validTo) changes.push('validTo')
  return changes
}

// 快照里取一个字符串字段，不是字符串的当作没有（和 toSnapshot 一样）。键名是代码里的常量
export const text = (snapshot: SQLWrapper, key: string) =>
  sql`(case when jsonb_typeof(${snapshot} -> ${sql.raw(`'${key}'`)}) = 'string' then ${snapshot} ->> ${sql.raw(`'${key}'`)} end)`

export const uriOf = (s: SQLWrapper) =>
  sql`(coalesce(${text(s, 'domain')}, '') || '://' || coalesce(${text(s, 'path')}, ''))`

const priorityOf = (s: SQLWrapper) =>
  sql`(case when jsonb_typeof(${s} -> 'priority') = 'number' then (${s} -> 'priority')::numeric else 0 end)`

// 关键词按 stringList 的规则：只留字符串，按顺序用换行连起来比
const glossaryOf = (s: SQLWrapper) =>
  sql`coalesce((select string_agg(g.value #>> '{}', E'\\n' order by g.ord) from jsonb_array_elements(case when jsonb_typeof(${s} -> 'glossary') = 'array' then ${s} -> 'glossary' end) with ordinality as g(value, ord) where jsonb_typeof(g.value) = 'string'), '')`

// changedFields 的 SQL 版：两个快照都是对象时，按同样的顺序列出改了的字段，否则为空数组
export function changedFieldsSql(before: SQLWrapper, after: SQLWrapper): SQL<string[]> {
  const pairs: [ActivityField, SQL][] = [
    ['uri', sql`(${uriOf(before)} <> ${uriOf(after)})`],
    ['title', sql`(${text(before, 'title')} is distinct from ${text(after, 'title')})`],
    ['layer', sql`((${before} ->> 'layer') is distinct from (${after} ->> 'layer'))`],
    [
      'sensitivity',
      sql`((${before} ->> 'sensitivity') is distinct from (${after} ->> 'sensitivity'))`,
    ],
    ['priority', sql`(${priorityOf(before)} <> ${priorityOf(after)})`],
    [
      'disclosure',
      sql`(${text(before, 'disclosure')} is distinct from ${text(after, 'disclosure')})`,
    ],
    ['glossary', sql`(${glossaryOf(before)} <> ${glossaryOf(after)})`],
    ['content', sql`(${text(before, 'content')} is distinct from ${text(after, 'content')})`],
    ['validTo', sql`(${text(before, 'validTo')} is distinct from ${text(after, 'validTo')})`],
  ]
  const items = sql.join(
    pairs.map(([field, changed]) => sql`case when ${changed} then ${sql.raw(`'${field}'`)} end`),
    sql`, `,
  )
  return sql<
    string[]
  >`(case when jsonb_typeof(${before}) = 'object' and jsonb_typeof(${after}) = 'object' then array_remove(array[${items}]::text[], null) else '{}'::text[] end)`
}

// 操作者的标识（见 contracts 的 ActivityActorKey）：测试台优先，其次访问密钥所在的应用，再次成员。
// 要和 api_keys 连起来用（left join，访问密钥删掉时 app_id 为空）
export const ACTOR_KEY = sql<string>`(case
  when jsonb_typeof(${memoryEvents.context} #> '{bench,run}') = 'string' and jsonb_typeof(${memoryEvents.context} #> '{bench,account}') = 'string' then 'bench'
  when ${memoryEvents.actorKeyId} is not null then (case when ${apiKeys.appId} is not null then 'app:' || ${apiKeys.appId}::text else 'unknown' end)
  when ${memoryEvents.actorAccountId} is not null then 'account:' || ${memoryEvents.actorAccountId}::text
  else 'unknown'
end)`

// 正文按行对比时，公共前后缀以外的部分超过这么多「行 × 行」就不再对齐，整段算删掉再加上（和界面的 diff.ts 一样）
const MAX_CELLS = 1_000_000

// 两版正文之间增删了几行：去掉公共前后缀，中间部分按最长公共子序列对齐，和界面上的对比一致
export function lineChanges(before: string, after: string): { added: number; removed: number } {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  if (!n || !m || n * m > MAX_CELLS) return { added: m, removed: n }
  // 只要长度，按行滚动两行数组
  let prev = new Uint32Array(m + 1)
  let next = new Uint32Array(m + 1)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      next[j] = a[start + i] === b[start + j] ? prev[j + 1]! + 1 : Math.max(prev[j]!, next[j + 1]!)
    }
    ;[prev, next] = [next, prev]
  }
  const common = prev[0]!
  return { added: m - common, removed: n - common }
}

// 各字段的前后值，按 fields 的顺序。正文只给增删的行数，有一边没有正文（机密）时不给；关键词给增删的词
export function fieldChanges(
  before: MemorySnapshot,
  after: MemorySnapshot,
  fields: readonly ActivityField[],
): ActivityFieldChange[] {
  return fields.map((field): ActivityFieldChange => {
    switch (field) {
      case 'content': {
        const secret = before.sensitivity === 'secret' || after.sensitivity === 'secret'
        if (secret || before.content === null || after.content === null) {
          return { field, added: null, removed: null }
        }
        return { field, ...lineChanges(before.content, after.content) }
      }
      case 'glossary':
        return {
          field,
          added: after.glossary.filter((k) => !before.glossary.includes(k)),
          removed: before.glossary.filter((k) => !after.glossary.includes(k)),
        }
      case 'priority':
        return { field, before: before.priority, after: after.priority }
      case 'layer':
        return { field, before: before.layer, after: after.layer }
      case 'sensitivity':
        return { field, before: before.sensitivity, after: after.sensitivity }
      default:
        return { field, before: before[field], after: after[field] }
    }
  })
}
