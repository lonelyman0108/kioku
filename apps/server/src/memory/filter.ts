import {
  ENTRY_KINDS,
  REVIEW_KINDS,
  SENSITIVITIES,
  bootEligible,
  type EntryKind,
  type Sensitivity,
  type SubjectKind,
} from '@kioku/contracts'
import { and, eq, gt, inArray, isNull, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'

import type { Access, EntryFacts, ReadOptions } from '../access/access'
import { sensitivityRank } from '../access/access'
import { checkStaticRealmLock } from '../access/realms'
import { currentMoment } from '../db/moment'
import { entries } from '../db/schema'

// 判断有效期用的「现在」，只用数据库的钟：给了 at 就是它；不给时是所在的 withCircles 事务开头取的数据库时间
export function momentSql(at?: Date): SQL {
  const now = at ?? currentMoment()
  return now ? sql`${now.toISOString()}::timestamptz` : sql`statement_timestamp()`
}

export function stillValid(at?: Date): SQL {
  const now = momentSql(at)
  return sql`((${entries.validTo} is null or ${entries.validTo} > ${now}) and (${entries.expiresAt} is null or ${entries.expiresAt} > ${now}))`
}

export const STILL_VALID = stillValid()

export { bootEligible }

// 会进启动加载的词条：受信来源的正式词条，且 priority = 0
export const BOOT_ELIGIBLE = and(
  eq(entries.kind, 'entry'),
  ne(entries.provenance, 'untrusted'),
  eq(entries.priority, 0),
)!

// 非机密的启动加载候选
export const BOOT_CANDIDATE = and(BOOT_ELIGIBLE, ne(entries.sensitivity, 'secret'))!

// 读权限要看的列：头表上就是这些列；事件快照（jsonb）经 snapshotColumns 取出同一套字段
export interface EntryColumns {
  circleId: SQLWrapper
  kind: SQLWrapper
  sensitivity: SQLWrapper
  originScope: SQLWrapper
  clientId: SQLWrapper
  ownerAccountId: SQLWrapper
  subjectKind: SQLWrapper
  realms: SQLWrapper
  deletedAt: SQLWrapper
  validTo: SQLWrapper
  expiresAt: SQLWrapper
}

export const ENTRY_COLUMNS: EntryColumns = {
  circleId: entries.circleId,
  kind: entries.kind,
  sensitivity: entries.sensitivity,
  originScope: entries.originScope,
  clientId: entries.clientId,
  ownerAccountId: entries.ownerAccountId,
  subjectKind: entries.subjectKind,
  realms: entries.realms,
  deletedAt: entries.deletedAt,
  validTo: entries.validTo,
  expiresAt: entries.expiresAt,
}

// 快照中的圈级与字段均由 jsonb 抽取，与 snapshotFacts 保持一致
export function snapshotColumns(snapshot: SQLWrapper): EntryColumns {
  const textCol = (key: string) =>
    sql`case when jsonb_typeof(${snapshot} -> ${key}) = 'string' then ${snapshot} ->> ${key} else null end`
  const timeCol = (key: string) =>
    sql`case when jsonb_typeof(${snapshot} -> ${key}) = 'string' and (${snapshot} ->> ${key}) <> '' then (${snapshot} ->> ${key})::timestamptz else null end`
  const arrayCol = (key: string) =>
    sql`case when jsonb_typeof(${snapshot} -> ${key}) = 'array' then array(select e #>> '{}' from jsonb_array_elements(${snapshot} -> ${key}) e where jsonb_typeof(e) = 'string') else '{}'::text[] end`
  return {
    circleId: textCol('circleId'),
    kind: textCol('kind'),
    sensitivity: textCol('sensitivity'),
    originScope: textCol('originScope'),
    clientId: textCol('clientId'),
    ownerAccountId: textCol('ownerAccountId'),
    subjectKind: textCol('subjectKind'),
    realms: arrayCol('realms'),
    deletedAt: timeCol('deletedAt'),
    validTo: timeCol('validTo'),
    expiresAt: timeCol('expiresAt'),
  }
}

export function snapshotFacts(snapshot: Record<string, unknown> | null): EntryFacts | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const textVal = (key: string) => (typeof snapshot[key] === 'string' ? snapshot[key] : null)
  const timeVal = (key: string) => {
    const value = textVal(key)
    return value ? new Date(value) : null
  }
  const circleId = textVal('circleId')
  const kind = textVal('kind') as EntryKind | null
  const sensitivity = textVal('sensitivity') as Sensitivity | null
  if (
    !circleId ||
    !kind ||
    !ENTRY_KINDS.includes(kind) ||
    !sensitivity ||
    !SENSITIVITIES.includes(sensitivity)
  ) {
    return null
  }
  const rawRealms = snapshot.realms
  const realms = Array.isArray(rawRealms)
    ? rawRealms.filter((r): r is string => typeof r === 'string')
    : []
  return {
    circleId,
    kind,
    sensitivity,
    originScope: textVal('originScope') ?? '',
    clientId: textVal('clientId'),
    ownerAccountId: textVal('ownerAccountId'),
    subjectKind: textVal('subjectKind') as SubjectKind | null,
    realms,
    deletedAt: timeVal('deletedAt'),
    validTo: timeVal('validTo'),
    expiresAt: timeVal('expiresAt'),
  }
}

function textArraySql(values: readonly string[]): SQL {
  if (!values.length) return sql`'{}'::text[]`
  return sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`
}

// 静态双向安全场域锁的 SQL 版本：仅认密钥 allowedRealms 与静态 context_facets 展开场域，与 checkStaticRealmLock 逐分支等价
function staticRealmLockSql(realmsCol: SQLWrapper, access: Access): SQL {
  const hasAllowedLock = access.allowedRealms !== null
  const hasContextLock = access.staticContextRealms.size > 0
  if (!hasAllowedLock && !hasContextLock) return sql`true`

  const cleaned = sql`array(select lower(trim(r)) from unnest(coalesce(${realmsCol}, '{}'::text[])) r where trim(r) <> '')`
  const checks: SQL[] = []
  if (hasAllowedLock) {
    if (access.allowedRealms!.size === 0) {
      checks.push(sql`false`)
    } else {
      checks.push(sql`${cleaned} && ${textArraySql([...access.allowedRealms!])}`)
    }
  }
  if (hasContextLock) {
    checks.push(sql`${cleaned} && ${textArraySql([...access.staticContextRealms])}`)
  }
  const nonEmptyMatch = and(...checks)!
  const emptyFallbackPasses = checkStaticRealmLock(
    [],
    access.primaryCircleRealms,
    access.allowedRealms,
    access.staticContextRealms,
  )
  return sql`case when coalesce(cardinality(${cleaned}), 0) > 0 then (${nonEmptyMatch}) else ${emptyFallbackPasses ? sql`true` : sql`false`} end`
}

// canRead / readDenial 的 SQL 版本，filter.int.test.ts 逐条比对二者一致性
export function readableConditions(
  access: Access,
  options: ReadOptions = {},
  cols: EntryColumns = ENTRY_COLUMNS,
): SQL {
  const now = momentSql(options.now)
  const conditions: SQL[] = options.management
    ? []
    : [
        isNull(cols.deletedAt),
        or(isNull(cols.validTo), gt(cols.validTo, now))!,
        or(isNull(cols.expiresAt), gt(cols.expiresAt, now))!,
      ]

  const circleClauses: SQL[] = []
  for (const circle of access.circles.values()) {
    const readKinds = [...circle.readKinds]
    if (!readKinds.length) continue

    const nonSecret = SENSITIVITIES.filter(
      (s) => s !== 'secret' && sensitivityRank(s) <= sensitivityRank(circle.maxSensitivity),
    )
    const sensClauses: SQL[] = []
    if (nonSecret.length) sensClauses.push(inArray(cols.sensitivity, nonSecret))
    if (circle.isPrimary && (options.explicit || options.management) && circle.canReadSecret) {
      sensClauses.push(
        and(eq(cols.sensitivity, 'secret'), staticRealmLockSql(cols.realms, access))!,
      )
    }
    if (!sensClauses.length) continue

    circleClauses.push(
      and(
        eq(cols.circleId, circle.circleId),
        inArray(cols.kind, readKinds),
        sensClauses.length === 1 ? sensClauses[0]! : or(...sensClauses)!,
      )!,
    )
  }
  conditions.push(circleClauses.length ? or(...circleClauses)! : sql`false`)

  conditions.push(or(isNull(cols.ownerAccountId), eq(cols.ownerAccountId, access.ownerAccountId))!)

  if (access.forbidOwnerBoundEpisodes) {
    conditions.push(or(ne(cols.kind, 'episode'), isNull(cols.ownerAccountId))!)
  }

  if (access.baseOriginScopes !== null) {
    const baseOrigins = [...access.baseOriginScopes]
    const originOptions: SQL[] = []
    if (baseOrigins.length) originOptions.push(inArray(cols.originScope, baseOrigins))
    if (access.clientId !== null && access.crossGroupPersonScopes.size > 0) {
      originOptions.push(
        and(
          eq(cols.circleId, access.primaryCircleId),
          eq(cols.kind, 'fact'),
          eq(cols.subjectKind, 'person'),
          inArray(cols.originScope, [...access.crossGroupPersonScopes]),
          or(isNull(cols.clientId), eq(cols.clientId, access.clientId)),
        )!,
      )
    }
    conditions.push(originOptions.length ? or(...originOptions)! : sql`false`)
  }

  return and(...conditions)!
}

// 待确认内容队列：不可信来源写下的事实与会话摘要中当前有效、读得到的记录
export function pendingReview(access: Access, now?: Date): SQL {
  return and(
    eq(entries.provenance, 'untrusted'),
    inArray(entries.kind, [...REVIEW_KINDS]),
    readableConditions(access, { ...(now ? { now } : {}) }),
  )!
}
