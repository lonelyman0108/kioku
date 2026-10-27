import { SENSITIVITIES, type Layer, type Sensitivity } from '@kioku/contracts'
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
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

// 快照转成 canRead 要的字段，给只拿到单个快照的地方与一致性测试用
export function snapshotFacts(snapshot: Record<string, unknown>): MemoryFacts {
  const text = (key: string) => (typeof snapshot[key] === 'string' ? snapshot[key] : null)
  const time = (key: string) => {
    const value = text(key)
    return value ? new Date(value) : null
  }
  return {
    layer: snapshot.layer as Layer,
    sensitivity: snapshot.sensitivity as Sensitivity,
    originScope: text('originScope') ?? 'global',
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
