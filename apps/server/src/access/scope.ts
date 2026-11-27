import { extractProjectSlugs, normalizeSlugList, type LifecycleProject } from '@kioku/contracts'
import { and, isNull, or, gt, sql, type SQL } from 'drizzle-orm'

import { currentMoment } from '../db/moment'
import { credentials, entries } from '../db/schema'
import type { ConsolePrincipal, KeyPrincipal } from '../http/env'
import { MemoryError } from '../memory/errors'

export type AccessScope = ConsolePrincipal | KeyPrincipal

export interface SceneFocus {
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
}

export interface FocusOverrides {
  env?: string | undefined
  realm?: string | undefined
  project?: string | LifecycleProject | undefined
  runtime?: string | undefined
}

const AGENT_RUNTIMES = new Set([
  'claudecode',
  'codex',
  'gemini',
  'agy',
  'openclaw',
  'hermes',
  'opencode',
  'pi',
  'dsh',
  'zcode',
])

export function momentSql(at?: Date): SQL {
  const now = at ?? currentMoment()
  return now ? sql`${now.toISOString()}::timestamptz` : sql`statement_timestamp()`
}

export function textArraySql(values: readonly string[]): SQL {
  if (!values.length) return sql`'{}'::text[]`
  return sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`
}

export function stillValidSql(at?: Date): SQL {
  const now = momentSql(at)
  return or(isNull(entries.validTo), gt(entries.validTo, now))!
}

export function activeEntrySql(at?: Date): SQL {
  return and(isNull(entries.deletedAt), stillValidSql(at))!
}

// 静态场域硬边界（词条）：不限场域的密钥放行全部；限定场域时仅放行无场域通用词条或与允许场域有交集的词条
export function entryRealmConditionSql(scope: AccessScope): SQL {
  if (scope.kind === 'console' || scope.allowedRealms === null) return sql`true`
  const allowed = normalizeSlugList(scope.allowedRealms)
  if (!allowed.length) return sql`cardinality(${entries.realms}) = 0`
  return sql`(cardinality(${entries.realms}) = 0 or ${entries.realms} && ${textArraySql(allowed)})`
}

export function readableEntrySql(
  scope: AccessScope,
  options: { includeDeleted?: boolean; includeExpired?: boolean; now?: Date } = {},
): SQL {
  const parts: SQL[] = [entryRealmConditionSql(scope)]
  if (!options.includeDeleted) parts.push(isNull(entries.deletedAt))
  if (!options.includeExpired) parts.push(stillValidSql(options.now))
  return and(...parts)!
}

export function canReadEntry(
  scope: AccessScope,
  entry: { realms: readonly string[]; deletedAt: Date | null; validTo: Date | null },
  options: { includeDeleted?: boolean; includeExpired?: boolean; now?: Date } = {},
): boolean {
  const now = options.now ?? currentMoment() ?? new Date()
  if (!options.includeDeleted && entry.deletedAt !== null) return false
  if (!options.includeExpired && entry.validTo !== null && entry.validTo <= now) return false
  if (scope.kind === 'console' || scope.allowedRealms === null) return true
  if (entry.realms.length === 0) return true
  const allowed = new Set(normalizeSlugList(scope.allowedRealms))
  return entry.realms.some((r) => allowed.has(r.trim().toLowerCase()))
}

// 在允许场域硬边界内按 focusRealms 聚焦默认场域：不限场域时用 focus，仅通用密钥（[]）始终返回 []
export function resolveAllowedRealmsWithFocus(
  allowedRealms: readonly string[] | null | undefined,
  focusRealms: readonly string[] | null | undefined,
): string[] {
  const allowed =
    allowedRealms !== null && allowedRealms !== undefined ? normalizeSlugList(allowedRealms) : null
  const focused = focusRealms?.length ? normalizeSlugList(focusRealms) : []
  if (allowed === null) return focused
  if (allowed.length === 0) return []
  if (focused.length > 0) {
    const allowedSet = new Set(allowed)
    const intersection = focused.filter((r) => allowedSet.has(r))
    if (intersection.length > 0) return intersection
  }
  return allowed
}

// 计算密钥在允许场域约束下的有效默认场域（不限场域时若配置了 focusRealms 则返回聚焦场域，否则为空）
export function resolveKeyDefaultRealms(scope: KeyPrincipal): string[] {
  return resolveAllowedRealmsWithFocus(scope.allowedRealms, scope.focusRealms)
}

// 新建词条时解析落库场域：限定非空 allowedRealms 的密钥缺省未传 realms 时自动继承有效默认场域，避免误写穿为全局词条
export function resolveCreateRealms(
  scope: AccessScope,
  inputRealms: readonly string[] | undefined,
): string[] {
  if (inputRealms !== undefined) return normalizeSlugList(inputRealms)
  if (scope.kind === 'key' && scope.allowedRealms !== null) {
    const allowed = normalizeSlugList(scope.allowedRealms)
    if (allowed.length > 0) return resolveKeyDefaultRealms(scope)
  }
  return []
}

export function assertEntryWriteAllowed(scope: AccessScope, realms: readonly string[]): void {
  if (scope.kind === 'console') return
  if (!scope.canWrite) throw new MemoryError(403, '该访问密钥没有写入权限')
  if (scope.allowedRealms === null) return
  const allowed = normalizeSlugList(scope.allowedRealms)
  const normalized = normalizeSlugList(realms)
  if (allowed.length === 0) {
    if (normalized.length > 0) {
      throw new MemoryError(403, `场域 ${normalized[0]} 超出该访问密钥允许的范围`)
    }
    return
  }
  if (normalized.length === 0) {
    throw new MemoryError(403, '限定场域的访问密钥不能写入或修改为无场域全局词条')
  }
  const allowedSet = new Set(allowed)
  for (const realm of normalized) {
    if (!allowedSet.has(realm)) {
      throw new MemoryError(403, `场域 ${realm} 超出该访问密钥允许的范围`)
    }
  }
}

// 静态场域硬边界（凭据，失败即拒绝）：限定场域的密钥不可读取未限定场域的凭据，且双方场域必须有交集
export function credentialRealmConditionSql(scope: AccessScope): SQL {
  if (scope.kind === 'console') return sql`true`
  if (!scope.canResolveCredentials) return sql`false`
  if (scope.allowedRealms === null) return sql`true`
  const allowed = normalizeSlugList(scope.allowedRealms)
  if (!allowed.length) return sql`false`
  return sql`(coalesce(cardinality(${credentials.allowedRealms}), 0) > 0 and ${credentials.allowedRealms} && ${textArraySql(allowed)})`
}

export function canAccessCredential(
  scope: AccessScope,
  cred: { allowedRealms: readonly string[] | null },
): boolean {
  if (scope.kind === 'console') return true
  if (!scope.canResolveCredentials) return false
  if (scope.allowedRealms === null) return true
  if (!cred.allowedRealms?.length) return false
  const allowed = new Set(normalizeSlugList(scope.allowedRealms))
  return cred.allowedRealms.some((r) => allowed.has(r.trim().toLowerCase()))
}

export function synthesizeFocus(scope: AccessScope, overrides: FocusOverrides = {}): SceneFocus {
  const envs = overrides.env
    ? normalizeSlugList([overrides.env])
    : scope.kind === 'key'
      ? normalizeSlugList(scope.envs)
      : []

  let realms: string[] = []
  const requestedRealms = overrides.realm ? normalizeSlugList([overrides.realm]) : []
  if (scope.kind === 'key') {
    const allowed = scope.allowedRealms !== null ? normalizeSlugList(scope.allowedRealms) : null
    const defaultRealms = resolveKeyDefaultRealms(scope)
    if (requestedRealms.length) {
      if (allowed === null) {
        realms = requestedRealms
      } else {
        const allowedSet = new Set(allowed)
        const intersection = requestedRealms.filter((r) => allowedSet.has(r))
        realms = intersection.length ? intersection : defaultRealms
      }
    } else {
      realms = defaultRealms
    }
  } else if (requestedRealms.length) {
    realms = requestedRealms
  }

  const runtimes = overrides.runtime
    ? normalizeSlugList([overrides.runtime])
    : scope.kind === 'key' && AGENT_RUNTIMES.has(scope.runtimeFamily)
      ? [scope.runtimeFamily]
      : []
  const projects = extractProjectSlugs(overrides.project)
  return { envs, realms, projects, runtimes }
}

export function hasOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || !b.length) return false
  const set = new Set(b)
  return a.some((item) => set.has(item))
}

// 独占维度（环境、场域、客户端）均非空且无交集时判定为互斥冲突
export function hasExclusiveSceneConflict(
  entry: { envs: readonly string[]; realms: readonly string[]; runtimes: readonly string[] },
  focus: SceneFocus,
): boolean {
  if (entry.envs.length && focus.envs.length && !hasOverlap(entry.envs, focus.envs)) return true
  if (entry.realms.length && focus.realms.length && !hasOverlap(entry.realms, focus.realms)) {
    return true
  }
  if (
    entry.runtimes.length &&
    focus.runtimes.length &&
    !hasOverlap(entry.runtimes, focus.runtimes)
  ) {
    return true
  }
  return false
}

export function actorLabel(scope: AccessScope): string {
  return scope.kind === 'console' ? 'console' : `key:${scope.prefix}`
}
