import {
  DeviceUserCode,
  RUNTIME_FAMILY_NAMES,
  Slug,
  formatDeviceUserCode,
  normalizeWhen,
  type CircleSummary,
  type ClientInfo,
  type DeviceGrantApprove,
  type DeviceGrantInfo,
  type DeviceGrantItem,
  type LensKeyScopes,
  type LinkedCircleGrant,
  type RuntimeFamily,
  type WhenCondition,
} from '@kioku/contracts'

import { ApiError } from './api/client'
import { ownedClients } from './apps'
import { keyPresets, matchPreset, presetScopes, tightenScopes } from './components/keyPresets'

// 浏览器授权的确认页：确认码的规整、可选记忆圈与接入实例、默认值、关联客场圈与在场切面、报错怎么处理

export function normalizeUserCode(input: string): string | null {
  const parsed = DeviceUserCode.safeParse(input)
  return parsed.success ? parsed.data : null
}

export const displayUserCode = (code: string) => formatDeviceUserCode(code)

export const USER_CODE_PROBLEM = '确认码是 8 个字母，照终端里显示的输入。'
export const GRANT_GONE = '确认码不对或已过期'

// 能签发访问密钥的记忆圈：当前账号是所有者或编辑者的
export const issuableCircles = (circles: readonly CircleSummary[]): CircleSummary[] =>
  circles.filter((c) => c.role === 'owner' || c.role === 'editor')

// 默认选哪个记忆圈：最近访问的那个能签发就用它，否则第一个能签发的
export function defaultCircleId(
  circles: readonly CircleSummary[],
  lastId: string | null | undefined,
): string | null {
  const usable = issuableCircles(circles)
  return (usable.find((c) => c.id === lastId) ?? usable[0])?.id ?? null
}

// 能直接选的接入实例：当前账号自己是所有者、运行时和这个平台一致的
export const grantClients = (
  clients: readonly ClientInfo[],
  accountId: string | undefined,
  runtimeFamily: RuntimeFamily,
): ClientInfo[] => ownedClients(clients, accountId).filter((c) => c.runtimeFamily === runtimeFamily)

export const NEW_CLIENT = 'new'
export const runtimeNames = RUNTIME_FAMILY_NAMES

const NAME_MAX = 64
export const nameProblem = (name: string): string | null => {
  const length = Array.from(name.trim()).length
  return length >= 1 && length <= NAME_MAX ? null : `请填写 1 到 ${NAME_MAX} 个字符。`
}

// 新建接入实例的默认名称：「平台名 · 机器名」，没有机器名时只用平台名
export function defaultClientName(runtimeFamily: RuntimeFamily, machine: string | null): string {
  const platform = runtimeNames[runtimeFamily]
  const name = machine?.trim()
  if (!name) return platform
  const prefix = `${platform} · `
  const room = NAME_MAX - Array.from(prefix).length
  return `${prefix}${Array.from(name).slice(0, room).join('').trimEnd()}`
}

export function defaultClientChoice(
  own: readonly Pick<ClientInfo, 'id' | 'name'>[],
  runtimeFamily: RuntimeFamily,
  machine: string | null,
): string {
  const name = defaultClientName(runtimeFamily, machine)
  return (own.find((c) => c.name === name) ?? own[0])?.id ?? NEW_CLIENT
}

const SLUG_MAX = 63
export function slugFrom(name: string, runtimeFamily: RuntimeFamily): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '')
  return slug || runtimeFamily
}

export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const slug = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.has(slug)) return slug
  }
}

export function clientSlugProblem(slug: string, taken: readonly string[]): string | null {
  if (!Slug.safeParse(slug).success) return '小写字母、数字和连字符，以字母或数字开头。'
  if (taken.includes(slug)) return `标识 ${slug} 已被占用`
  return null
}

export const DUPLICATE_SLUG = '与另一个平台的标识重复'

export interface SlugRow {
  isNew: boolean
  typed: string | null
  runtimeFamily: RuntimeFamily
  clientName: string
}
export function newClientSlugs(
  rows: readonly SlugRow[],
  taken: readonly string[],
): (string | null)[] {
  const used = new Set(taken)
  for (const row of rows) if (row.isNew && row.typed !== null) used.add(row.typed)
  return rows.map((row) => {
    if (!row.isNew) return null
    if (row.typed !== null) return row.typed
    const slug = uniqueSlug(slugFrom(row.clientName, row.runtimeFamily), used)
    used.add(slug)
    return slug
  })
}

export const defaultKeyName = (machine: string | null, runtimeFamily: RuntimeFamily) =>
  machine?.trim() || runtimeNames[runtimeFamily]

export function defaultGrantScopes(isCircleOwner: boolean): LensKeyScopes {
  return tightenScopes(
    { ...presetScopes(keyPresets[0]!, isCircleOwner), credentials: 'none' },
    isCircleOwner,
  )
}
export const defaultGrantPreset = (isCircleOwner: boolean) =>
  matchPreset(defaultGrantScopes(isCircleOwner), isCircleOwner)

export const isGrantExpired = (info: Pick<DeviceGrantInfo, 'expiresAt'>, now: Date) =>
  new Date(info.expiresAt).getTime() <= now.getTime()

export interface PlatformChoice {
  runtimeFamily: RuntimeFamily
  selected: boolean
  clientChoice: string
  newClient: { slug: string; name: string }
  keyName: string
  scopes: LensKeyScopes
}

export const NOTHING_SELECTED = '至少选择一个平台'
export const nothingSelected = (choices: readonly Pick<PlatformChoice, 'selected'>[]) =>
  !choices.some((choice) => choice.selected)

export function approveItem(choice: PlatformChoice): DeviceGrantItem {
  if (!choice.selected) return { runtimeFamily: choice.runtimeFamily, skip: true }
  return {
    runtimeFamily: choice.runtimeFamily,
    client:
      choice.clientChoice === NEW_CLIENT
        ? { slug: choice.newClient.slug, name: choice.newClient.name.trim() }
        : { id: choice.clientChoice },
    keyName: choice.keyName.trim(),
    scopes: choice.scopes,
  }
}

export const approveBody = (
  userCode: string,
  circleId: string,
  choices: readonly PlatformChoice[],
  options: { linkedCircles?: readonly LinkedCircleGrant[]; contextFacets?: WhenCondition } = {},
): DeviceGrantApprove => ({
  userCode,
  circleId,
  linkedCircles: [...(options.linkedCircles ?? [])],
  contextFacets: normalizeWhen(options.contextFacets),
  items: choices.map(approveItem),
})

export interface GrantFailure {
  kind: 'gone' | 'slug' | 'message'
  text: string
  runtimeFamily?: RuntimeFamily
}
export function grantFailure(err: unknown, fallback: string): GrantFailure {
  if (!(err instanceof ApiError)) return { kind: 'message', text: fallback }
  const kind = err.status === 404 ? 'gone' : err.status === 409 ? 'slug' : 'message'
  const payload = err.payload as { runtimeFamily?: unknown } | null
  const runtimeFamily = payload?.runtimeFamily
  return typeof runtimeFamily === 'string' && Object.hasOwn(runtimeNames, runtimeFamily)
    ? { kind, text: err.message, runtimeFamily: runtimeFamily as RuntimeFamily }
    : { kind, text: err.message }
}

export const lookupFailure = (err: unknown): string =>
  err instanceof ApiError ? (err.status === 404 ? GRANT_GONE : err.message) : '申请读取失败'
