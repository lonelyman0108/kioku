import {
  LAYERS,
  REVIEW_LAYERS,
  SENSITIVITIES,
  type Layer,
  type Sensitivity,
} from '@kioku/contracts'
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm'

import type { Access, MemoryFacts, ReadOptions } from '../access/access'
import { sensitivityRank } from '../access/access'
import { memories } from '../db/schema'

// 启动上下文只收受信来源的这几个策展层（理由见 recall/boot.ts）
export const BOOT_LAYERS: Layer[] = ['base', 'persona', 'app', 'owner', 'private']

// 会进启动上下文的节点：受信来源的策展层里 priority 0 的，加上人格与应用层 priority ≤ 1 的。
// boot 按它挑选（再套读权限、继承覆盖与字数预算）；召回分析的「从没被召回」不算它们：
// 每次会话开始都注入，只是不记成召回
export const BOOT_ELIGIBLE = and(
  eq(memories.form, 'curated'),
  inArray(memories.layer, BOOT_LAYERS),
  ne(memories.provenance, 'untrusted'),
  or(
    eq(memories.priority, 0),
    and(inArray(memories.layer, ['persona', 'app']), lte(memories.priority, 1)),
  ),
)!

// 读权限要看的那几个字段从哪里取。记忆表上就是这些列；事件的前后快照（jsonb）里有同名字段，
// 用 snapshotColumns 取出来，这样历史也用同一套条件判断，不另写一份规则
export interface MemoryColumns {
  layer: SQLWrapper
  sensitivity: SQLWrapper
  originScope: SQLWrapper
  ownerAccountId: SQLWrapper
  personaId: SQLWrapper
  appId: SQLWrapper
  deletedAt: SQLWrapper
  validTo: SQLWrapper
  expiresAt: SQLWrapper
}

export const MEMORY_COLUMNS: MemoryColumns = {
  layer: memories.layer,
  sensitivity: memories.sensitivity,
  originScope: memories.originScope,
  ownerAccountId: memories.ownerAccountId,
  personaId: memories.personaId,
  appId: memories.appId,
  deletedAt: memories.deletedAt,
  validTo: memories.validTo,
  expiresAt: memories.expiresAt,
}

// 快照是写入事件时记下的整行（键名与 drizzle 的字段名相同），时间存成 ISO 字符串
export function snapshotColumns(snapshot: SQLWrapper): MemoryColumns {
  const text = (key: string) => sql`(${snapshot} ->> ${key})`
  const time = (key: string) => sql`(${snapshot} ->> ${key})::timestamptz`
  return {
    layer: text('layer'),
    sensitivity: text('sensitivity'),
    originScope: text('originScope'),
    ownerAccountId: text('ownerAccountId'),
    personaId: text('personaId'),
    appId: text('appId'),
    deletedAt: time('deletedAt'),
    validTo: time('validTo'),
    expiresAt: time('expiresAt'),
  }
}

// 快照转成 canRead 要的字段，给一致性测试比对 snapshotColumns 用，两者放在一起改。与 SQL 一侧的取值方式一致：
// 层或敏感级缺失、不认识的快照返回 null，当作看不到（SQL 里这些字段为 NULL 时条件不成立）；
// 缺来源作用域时记为空串，有作用域限制的访问照样读不到
export function snapshotFacts(snapshot: Record<string, unknown>): MemoryFacts | null {
  const text = (key: string) => (typeof snapshot[key] === 'string' ? snapshot[key] : null)
  const time = (key: string) => {
    const value = text(key)
    return value ? new Date(value) : null
  }
  const layer = text('layer') as Layer | null
  const sensitivity = text('sensitivity') as Sensitivity | null
  if (!layer || !LAYERS.includes(layer) || !sensitivity || !SENSITIVITIES.includes(sensitivity)) {
    return null
  }
  return {
    layer,
    sensitivity,
    originScope: text('originScope') ?? '',
    ownerAccountId: text('ownerAccountId'),
    personaId: text('personaId'),
    appId: text('appId'),
    deletedAt: time('deletedAt'),
    validTo: time('validTo'),
    expiresAt: time('expiresAt'),
  }
}

// canRead 的 SQL 版本，用在召回、搜索、列表与历史查询里。两边规则必须一致，
// filter.int.test.ts 用同一批数据逐条比对二者的结果（记忆表与事件快照都比）。
export function readableConditions(
  access: Access,
  options: ReadOptions,
  cols: MemoryColumns = MEMORY_COLUMNS,
): SQL {
  // 当前时间写成显式转换的参数：快照里的时间是表达式，不像列那样能替 Date 选好参数类型
  const now = sql`${(options.now ?? new Date()).toISOString()}::timestamptz`
  const conditions: (SQL | undefined)[] = options.management
    ? []
    : [
        isNull(cols.deletedAt),
        or(isNull(cols.validTo), gt(cols.validTo, now)),
        or(isNull(cols.expiresAt), gt(cols.expiresAt, now)),
      ]

  const layers = [...access.readLayers]
  conditions.push(layers.length ? inArray(cols.layer, layers) : sql`false`)

  const allowed: Sensitivity[] = SENSITIVITIES.filter(
    (s) => s !== 'secret' && sensitivityRank(s) <= sensitivityRank(access.maxSensitivity),
  )
  if ((options.explicit || options.management) && access.canReadSecret) allowed.push('secret')
  conditions.push(allowed.length ? inArray(cols.sensitivity, allowed) : sql`false`)

  if (access.originScopes) conditions.push(inArray(cols.originScope, [...access.originScopes]))

  conditions.push(
    or(
      notInArray(cols.layer, ['owner', 'private']),
      eq(cols.ownerAccountId, access.ownerAccountId),
    ),
    options.management
      ? undefined
      : options.personaIds.length
        ? or(ne(cols.layer, 'persona'), inArray(cols.personaId, [...options.personaIds]))
        : ne(cols.layer, 'persona'),
    access.appId === null ? undefined : or(ne(cols.layer, 'app'), eq(cols.appId, access.appId)),
  )
  return and(...conditions)!
}

// 待审队列里的：不可信来源写进对象层与情节层、现在有效、读得到的。列表与处理都按它
export function pendingReview(access: Access, personaIds: readonly string[]): SQL {
  return and(
    eq(memories.provenance, 'untrusted'),
    inArray(memories.layer, REVIEW_LAYERS),
    readableConditions(access, { personaIds }),
  )!
}
