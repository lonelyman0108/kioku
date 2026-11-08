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

// 两版正文之间大约增删了几行，表格里的「正文 +a −r」用。按行做多重集合的差：新增是改后比改前多出来的行，
// 删除反过来，不管行的先后。只是近似：行挪了位置不算改动，同一行删掉又在别处加回来也不算；准确的按行对比
// 在详情里由界面对这一条做（diff.ts）。不做最长公共子序列：那是 O(n·m)，列表一页最多 200 条、概览也算，
// 任何成员写一段很长的正文就能把整个进程（登录、召回、MCP）卡住；这里是 O(n + m)
export function lineChanges(before: string, after: string): { added: number; removed: number } {
  const counts = new Map<string, number>()
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of after.split('\n')) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added++
  }
  let removed = 0
  for (const left of counts.values()) removed += left
  return { added, removed }
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
