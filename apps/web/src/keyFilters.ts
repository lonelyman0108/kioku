import { normalizeSlugList, type ApiKeyView } from '@kioku/contracts'

import { envDisplayName } from './labels'
import { runtimeName } from './runtimes'

export const KEY_FILTER_ALL = '__all__'
export const KEY_REALM_UNRESTRICTED = '__unrestricted__'
export const KEY_REALM_GENERIC = '__generic__'

export type KeyPermissionFilter = 'all' | 'credentials' | 'readonly'

export interface KeyFilterState {
  runtime: string
  env: string
  realm: string
  permission: KeyPermissionFilter
  q: string
}

export interface KeyFilterOption {
  value: string
  label: string
  count: number
}

export function createDefaultKeyFilter(): KeyFilterState {
  return {
    runtime: KEY_FILTER_ALL,
    env: KEY_FILTER_ALL,
    realm: KEY_FILTER_ALL,
    permission: 'all',
    q: '',
  }
}

export function hasActiveKeyFilter(filter: KeyFilterState): boolean {
  return (
    filter.runtime !== KEY_FILTER_ALL ||
    filter.env !== KEY_FILTER_ALL ||
    filter.realm !== KEY_FILTER_ALL ||
    filter.permission !== 'all' ||
    filter.q.trim().length > 0
  )
}

export function filterActiveKeys(
  keys: readonly ApiKeyView[],
  filter: KeyFilterState,
): ApiKeyView[] {
  const q = filter.q.trim().toLowerCase()
  return keys.filter((item) => {
    if (filter.runtime !== KEY_FILTER_ALL && item.runtimeFamily !== filter.runtime) {
      return false
    }
    if (filter.env !== KEY_FILTER_ALL && !item.envs.includes(filter.env)) {
      return false
    }
    if (filter.realm === KEY_REALM_UNRESTRICTED) {
      if (item.allowedRealms !== null) return false
    } else if (filter.realm === KEY_REALM_GENERIC) {
      if (item.allowedRealms === null || item.allowedRealms.length > 0) return false
    } else if (filter.realm !== KEY_FILTER_ALL) {
      if (!item.allowedRealms?.includes(filter.realm)) return false
    }
    if (filter.permission === 'credentials' && !item.canResolveCredentials) {
      return false
    }
    if (filter.permission === 'readonly' && item.canWrite) {
      return false
    }
    if (q) {
      const hay = `${item.name} ${item.prefix}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

export function buildKeyFilterOptions(keys: readonly ApiKeyView[]): {
  runtimes: KeyFilterOption[]
  envs: KeyFilterOption[]
  realms: KeyFilterOption[]
  permissions: KeyFilterOption[]
} {
  const runtimeCounts = new Map<string, number>()
  const envCounts = new Map<string, number>()
  const realmCounts = new Map<string, number>()
  let unrestrictedCount = 0
  let genericCount = 0
  let credentialCount = 0
  let readonlyCount = 0

  for (const item of keys) {
    runtimeCounts.set(item.runtimeFamily, (runtimeCounts.get(item.runtimeFamily) ?? 0) + 1)
    for (const env of new Set(item.envs)) {
      envCounts.set(env, (envCounts.get(env) ?? 0) + 1)
    }
    if (item.allowedRealms === null) {
      unrestrictedCount++
    } else if (item.allowedRealms.length === 0) {
      genericCount++
    } else {
      for (const realm of new Set(item.allowedRealms)) {
        realmCounts.set(realm, (realmCounts.get(realm) ?? 0) + 1)
      }
    }
    if (item.canResolveCredentials) credentialCount++
    if (!item.canWrite) readonlyCount++
  }

  const runtimes: KeyFilterOption[] = [
    { value: KEY_FILTER_ALL, label: `全部客户端（${keys.length}）`, count: keys.length },
    ...[...runtimeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({
        value,
        label: `${runtimeName(value)}（${count}）`,
        count,
      })),
  ]

  const envs: KeyFilterOption[] = [
    { value: KEY_FILTER_ALL, label: '全部环境', count: keys.length },
    ...[...envCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({
        value,
        label: `${envDisplayName(value)}（${count}）`,
        count,
      })),
  ]

  const realms: KeyFilterOption[] = [
    { value: KEY_FILTER_ALL, label: '全部场域', count: keys.length },
    {
      value: KEY_REALM_UNRESTRICTED,
      label: unrestrictedCount > 0 ? `不限场域（${unrestrictedCount}）` : '不限场域',
      count: unrestrictedCount,
    },
    {
      value: KEY_REALM_GENERIC,
      label: genericCount > 0 ? `仅通用（${genericCount}）` : '仅通用',
      count: genericCount,
    },
    ...[...realmCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({
        value,
        label: `${value}（${count}）`,
        count,
      })),
  ]

  const permissions: KeyFilterOption[] = [
    { value: 'all', label: '全部权限', count: keys.length },
    {
      value: 'credentials',
      label: credentialCount > 0 ? `可解析凭据（${credentialCount}）` : '可解析凭据',
      count: credentialCount,
    },
    {
      value: 'readonly',
      label: readonlyCount > 0 ? `只读（${readonlyCount}）` : '只读',
      count: readonlyCount,
    },
  ]

  return { runtimes, envs, realms, permissions }
}

// 与服务端凭据边界规则保持一致（失败即拒绝）：限定场域密钥不能访问未限定场域的凭据
export function countMatchingCredentials(
  scope: { canResolveCredentials: boolean; allowedRealms: readonly string[] | null },
  credentials: readonly { allowedRealms: readonly string[] | null }[],
): number {
  if (!scope.canResolveCredentials) return 0
  if (scope.allowedRealms === null) return credentials.length
  const allowed = normalizeSlugList(scope.allowedRealms)
  if (!allowed.length) return 0
  const allowedSet = new Set(allowed)
  return credentials.filter(
    (cred) =>
      Boolean(cred.allowedRealms?.length) &&
      cred.allowedRealms!.some((r) => allowedSet.has(r.trim().toLowerCase())),
  ).length
}
