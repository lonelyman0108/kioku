import {
  whenSignature,
  type ActivityField,
  type ActivityFieldChange,
  type EntrySnapshot,
} from '@kioku/contracts'
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'

import { apiKeys, entryEvents } from '../db/schema'

function variantMap(snapshot: EntrySnapshot): Map<string, string | null> {
  const map = new Map<string, string | null>()
  for (const v of snapshot.variants) {
    map.set(whenSignature(v.when), v.content)
  }
  return map
}

function variantSignaturesKey(snapshot: EntrySnapshot): string {
  return snapshot.variants
    .map((v) => whenSignature(v.when))
    .sort()
    .join('\n')
}

// 前后两版之间改了哪些字段；SQL 版为 changedFieldsSql，两份规则逐字段对齐
export function changedFields(
  before: EntrySnapshot | null,
  after: EntrySnapshot | null,
): ActivityField[] {
  if (!before || !after) return []
  const changes: ActivityField[] = []
  if ((before.title ?? null) !== (after.title ?? null)) changes.push('title')
  if (before.sensitivity !== after.sensitivity) changes.push('sensitivity')
  if (before.priority !== after.priority) changes.push('priority')
  if ((before.disclosure ?? null) !== (after.disclosure ?? null)) changes.push('disclosure')
  if (before.topics.join('\n') !== after.topics.join('\n')) changes.push('topics')
  if (before.glossary.join('\n') !== after.glossary.join('\n')) changes.push('glossary')
  if (variantSignaturesKey(before) !== variantSignaturesKey(after)) changes.push('variants')

  const beforeMap = variantMap(before)
  const contentChanged = after.variants.some((v) => {
    const sig = whenSignature(v.when)
    if (!beforeMap.has(sig)) return false
    const prev = beforeMap.get(sig)!
    return prev !== v.content && (prev !== null || v.content !== null)
  })
  if (contentChanged) changes.push('content')

  if ((before.validTo ?? null) !== (after.validTo ?? null)) changes.push('validTo')
  return changes
}

// 快照里取一个字符串字段，不是字符串的当作没有（和 toSnapshot 一样）
export const text = (snapshot: SQLWrapper, key: string) =>
  sql`(case when jsonb_typeof(${snapshot} -> ${sql.raw(`'${key}'`)}) = 'string' then ${snapshot} ->> ${sql.raw(`'${key}'`)} end)`

const priorityOf = (s: SQLWrapper) =>
  sql`(case when jsonb_typeof(${s} -> 'priority') = 'number' then (${s} -> 'priority')::numeric else 0 end)`

// 字符串列表（topics、glossary）：只留字符串，按数组先后用换行连起来对比
const stringListOf = (s: SQLWrapper, key: string) =>
  sql`coalesce((select string_agg(g.value #>> '{}', E'\\n' order by g.ord) from jsonb_array_elements(case when jsonb_typeof(${s} -> ${sql.raw(`'${key}'`)}) = 'array' then ${s} -> ${sql.raw(`'${key}'`)} end) with ordinality as g(value, ord) where jsonb_typeof(g.value) = 'string'), '')`

const variantSigExpr = (v: SQLWrapper) =>
  sql`coalesce(nullif(case when jsonb_typeof(${v} -> 'whenSignature') = 'string' then ${v} ->> 'whenSignature' end, ''), (${v} -> 'when')::text, '{}')`

const variantSigsOf = (s: SQLWrapper) =>
  sql`coalesce((select string_agg(t.sig, E'\\n' order by t.sig) from (select ${variantSigExpr(sql`v.value`)} as sig from jsonb_array_elements(case when jsonb_typeof(${s} -> 'variants') = 'array' then ${s} -> 'variants' end) as v(value)) t), '')`

const variantsContentChangedSql = (before: SQLWrapper, after: SQLWrapper) =>
  sql`exists (
    select 1
    from jsonb_array_elements(case when jsonb_typeof(${before} -> 'variants') = 'array' then ${before} -> 'variants' end) as bv(value),
         jsonb_array_elements(case when jsonb_typeof(${after} -> 'variants') = 'array' then ${after} -> 'variants' end) as av(value)
    where ${variantSigExpr(sql`bv.value`)} = ${variantSigExpr(sql`av.value`)}
      and ${text(sql`bv.value`, 'content')} is distinct from ${text(sql`av.value`, 'content')}
  )`

// changedFields 的 SQL 版：两个快照都是对象时，按同样的顺序列出改了的字段，否则为空数组
export function changedFieldsSql(before: SQLWrapper, after: SQLWrapper): SQL<string[]> {
  const pairs: [ActivityField, SQL][] = [
    ['title', sql`(${text(before, 'title')} is distinct from ${text(after, 'title')})`],
    [
      'sensitivity',
      sql`(${text(before, 'sensitivity')} is distinct from ${text(after, 'sensitivity')})`,
    ],
    ['priority', sql`(${priorityOf(before)} <> ${priorityOf(after)})`],
    [
      'disclosure',
      sql`(${text(before, 'disclosure')} is distinct from ${text(after, 'disclosure')})`,
    ],
    ['topics', sql`(${stringListOf(before, 'topics')} <> ${stringListOf(after, 'topics')})`],
    ['glossary', sql`(${stringListOf(before, 'glossary')} <> ${stringListOf(after, 'glossary')})`],
    ['variants', sql`(${variantSigsOf(before)} <> ${variantSigsOf(after)})`],
    ['content', variantsContentChangedSql(before, after)],
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

// 操作者的标识（见 contracts 的 ActivityActorKey）：测试台优先，其次访问密钥所属的接入实例，再次成员。
// 要和 api_keys 连起来用（left join，访问密钥删掉时 client_id 为空）
export const ACTOR_KEY = sql<string>`(case
  when jsonb_typeof(${entryEvents.context} #> '{bench,run}') = 'string' and jsonb_typeof(${entryEvents.context} #> '{bench,account}') = 'string' then 'bench'
  when ${entryEvents.actorKeyId} is not null then (case when ${apiKeys.clientId} is not null then 'client:' || ${apiKeys.clientId}::text else 'unknown' end)
  when ${entryEvents.actorAccountId} is not null then 'account:' || ${entryEvents.actorAccountId}::text
  else 'unknown'
end)`

// 两版正文之间大约增删了几行：按行做多重集合的差，O(n + m) 复杂度
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

// 各字段的前后变更明细，按 fields 的顺序输出
export function fieldChanges(
  before: EntrySnapshot,
  after: EntrySnapshot,
  fields: readonly ActivityField[],
): ActivityFieldChange[] {
  const beforeMap = variantMap(before)
  const afterMap = variantMap(after)
  return fields.map((field): ActivityFieldChange => {
    switch (field) {
      case 'content': {
        const secret = before.sensitivity === 'secret' || after.sensitivity === 'secret'
        if (secret) return { field, added: null, removed: null }
        let added = 0
        let removed = 0
        for (const [sig, afterText] of afterMap) {
          if (!beforeMap.has(sig)) continue
          const beforeText = beforeMap.get(sig)!
          if (beforeText === null || afterText === null)
            return { field, added: null, removed: null }
          if (beforeText !== afterText) {
            const diff = lineChanges(beforeText, afterText)
            added += diff.added
            removed += diff.removed
          }
        }
        return { field, added, removed }
      }
      case 'variants': {
        let added = 0
        let removed = 0
        let modified = 0
        for (const [sig, afterText] of afterMap) {
          if (!beforeMap.has(sig)) added++
          else if (beforeMap.get(sig)! !== afterText) modified++
        }
        for (const sig of beforeMap.keys()) {
          if (!afterMap.has(sig)) removed++
        }
        return { field, added, removed, modified }
      }
      case 'topics':
        return {
          field,
          added: after.topics.filter((k) => !before.topics.includes(k)),
          removed: before.topics.filter((k) => !after.topics.includes(k)),
        }
      case 'glossary':
        return {
          field,
          added: after.glossary.filter((k) => !before.glossary.includes(k)),
          removed: before.glossary.filter((k) => !after.glossary.includes(k)),
        }
      case 'priority':
        return { field, before: before.priority, after: after.priority }
      case 'sensitivity':
        return { field, before: before.sensitivity, after: after.sensitivity }
      case 'title':
      case 'disclosure':
      case 'validTo':
        return { field, before: before[field], after: after[field] }
    }
  })
}

let timeZones: ReadonlySet<string> | null = null
export async function knownTimeZone(
  tx: { execute: (query: SQL) => PromiseLike<unknown> },
  tz: string,
): Promise<boolean> {
  if (!timeZones) {
    const rows = (await tx.execute(sql`select name from pg_timezone_names`)) as { name: string }[]
    timeZones = new Set(rows.map((r) => r.name))
  }
  return timeZones.has(tz)
}
