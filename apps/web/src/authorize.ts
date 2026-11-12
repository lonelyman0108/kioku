import {
  DeviceUserCode,
  RUNTIME_FAMILY_NAMES,
  Slug,
  formatDeviceUserCode,
  type AppInfo,
  type DeviceGrantApprove,
  type DeviceGrantInfo,
  type DeviceGrantItem,
  type KeyScopes,
  type RuntimeFamily,
  type SpaceSummary,
} from '@kioku/contracts'

import { ApiError } from './api/client'
import { ownedApps } from './benchSession'
import { keyPresets, matchPreset, presetScopes, tightenScopes } from './components/keyPresets'

// 浏览器授权确认页的判断与说法：确认码的规整、能选哪些空间与应用、默认值、报错怎么处理。
// 一次申请可以有几个平台，每个平台一行，各自选应用与访问密钥名

// 确认码规整成 8 个大写字母（大小写、空格、连字符都不计较），规则只有契约的 DeviceUserCode 一份；不合规时为 null
export function normalizeUserCode(input: string): string | null {
  const parsed = DeviceUserCode.safeParse(input)
  return parsed.success ? parsed.data : null
}

// 显示用的写法：四个一组，和终端里的一样
export const displayUserCode = (code: string) => formatDeviceUserCode(code)

export const USER_CODE_PROBLEM = '确认码是 8 个字母，照终端里显示的输入。'
export const GRANT_GONE = '确认码不对或已过期'

// 能签发访问密钥的空间：当前账号是所有者或编辑者的
export const issuableSpaces = (spaces: readonly SpaceSummary[]): SpaceSummary[] =>
  spaces.filter((space) => space.role === 'owner' || space.role === 'editor')

// 默认选哪个空间：最近访问的那个能签发就用它，否则第一个能签发的
export function defaultSpaceId(
  spaces: readonly SpaceSummary[],
  lastId: string | null | undefined,
): string | null {
  const usable = issuableSpaces(spaces)
  return (usable.find((space) => space.id === lastId) ?? usable[0])?.id ?? null
}

// 能直接选的应用：当前账号自己是所有者、运行时和这个平台一致的
export const grantApps = (
  apps: readonly AppInfo[],
  accountId: string | undefined,
  runtimeFamily: RuntimeFamily,
): AppInfo[] => ownedApps(apps, accountId).filter((app) => app.runtimeFamily === runtimeFamily)

// 选「新建应用」时 appChoice 的值；应用的 id 是 uuid，不会相同
export const NEW_APP = 'new'

// 各运行时的产品名：平台名，也用作新建应用的默认名称。只有契约里一份
export const runtimeNames = RUNTIME_FAMILY_NAMES

const NAME_MAX = 64
// 名称按码点算长度，和契约的上限一致
export const nameProblem = (name: string): string | null => {
  const length = Array.from(name.trim()).length
  return length >= 1 && length <= NAME_MAX ? null : `请填写 1 到 ${NAME_MAX} 个字符。`
}

// 新建应用的默认名称：「平台名 · 机器名」，没有机器名时只用平台名。
// 超出名称上限时截短机器名、保留平台名，按码点截，不切开代理对
export function defaultAppName(runtimeFamily: RuntimeFamily, machine: string | null): string {
  const platform = runtimeNames[runtimeFamily]
  const name = machine?.trim()
  if (!name) return platform
  const prefix = `${platform} · `
  const room = NAME_MAX - Array.from(prefix).length
  return `${prefix}${Array.from(name).slice(0, room).join('').trimEnd()}`
}

// 一个平台默认用哪个应用：当前账号自己的、运行时一致的应用里，名称等于默认名称的那个（同一台机器上次授权建的），
// 没有就取第一个；一个都没有才新建。重新授权同一台机器时不多出重复的应用
export function defaultAppChoice(
  own: readonly Pick<AppInfo, 'id' | 'name'>[],
  runtimeFamily: RuntimeFamily,
  machine: string | null,
): string {
  const name = defaultAppName(runtimeFamily, machine)
  return (own.find((app) => app.name === name) ?? own[0])?.id ?? NEW_APP
}

const SLUG_MAX = 63
// 由名称生成标识：小写字母与数字之外的都换成连字符；什么都不剩时用运行时的名字
export function slugFrom(name: string, runtimeFamily: RuntimeFamily): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '')
  return slug || runtimeFamily
}

// 已被占用时往后加序号，总长不超过契约的上限
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const slug = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.has(slug)) return slug
  }
}

// 标识的问题：格式照契约的 Slug，空间里已有的标识不能再用（服务端以唯一约束为准，回 409）
export function appSlugProblem(slug: string, taken: readonly string[]): string | null {
  if (!Slug.safeParse(slug).success) return '小写字母、数字和连字符，以字母或数字开头。'
  if (taken.includes(slug)) return `标识 ${slug} 已被占用`
  return null
}

// 同一次确认里两个平台新建的应用用了同一个标识
export const DUPLICATE_SLUG = '与另一个平台的标识重复'

// 各行新建应用的标识：不新建的为 null；手填的原样用，并先全部预留出来，
// 没填的再按行的顺序由名称生成，依次避开空间里已有的、手填的与前面几行用掉的
export interface SlugRow {
  isNew: boolean
  typed: string | null
  runtimeFamily: RuntimeFamily
  appName: string
}
export function newAppSlugs(rows: readonly SlugRow[], taken: readonly string[]): (string | null)[] {
  const used = new Set(taken)
  for (const row of rows) if (row.isNew && row.typed !== null) used.add(row.typed)
  return rows.map((row) => {
    if (!row.isNew) return null
    if (row.typed !== null) return row.typed
    const slug = uniqueSlug(slugFrom(row.appName, row.runtimeFamily), used)
    used.add(slug)
    return slug
  })
}

// 访问密钥的默认名称：机器名，没有就用平台名
export const defaultKeyName = (machine: string | null, runtimeFamily: RuntimeFamily) =>
  machine?.trim() || runtimeNames[runtimeFamily]

// 默认的签发范围：本机编码 Agent 的模板去掉凭据能力，最高到私密，不含机密级与跨人格写入。
// 要凭据或机密级由确认人自己在表格里改
export function defaultGrantScopes(isSpaceOwner: boolean): KeyScopes {
  return tightenScopes(
    { ...presetScopes(keyPresets[0]!, isSpaceOwner), credentials: 'none' },
    isSpaceOwner,
  )
}
export const defaultGrantPreset = (isSpaceOwner: boolean) =>
  matchPreset(defaultGrantScopes(isSpaceOwner), isSpaceOwner)

export const isGrantExpired = (info: Pick<DeviceGrantInfo, 'expiresAt'>, now: Date) =>
  new Date(info.expiresAt).getTime() <= now.getTime()

// 确认页上一个平台的选择
export interface PlatformChoice {
  runtimeFamily: RuntimeFamily
  // 勾掉的平台不签发
  selected: boolean
  // 已有应用的 id，或 NEW_APP
  appChoice: string
  newApp: { slug: string; name: string }
  keyName: string
  scopes: KeyScopes
}

// 至少要勾一个平台
export const NOTHING_SELECTED = '至少选择一个平台'
export const nothingSelected = (choices: readonly Pick<PlatformChoice, 'selected'>[]) =>
  !choices.some((choice) => choice.selected)

export function approveItem(choice: PlatformChoice): DeviceGrantItem {
  if (!choice.selected) return { runtimeFamily: choice.runtimeFamily, skip: true }
  return {
    runtimeFamily: choice.runtimeFamily,
    app:
      choice.appChoice === NEW_APP
        ? { slug: choice.newApp.slug, name: choice.newApp.name.trim() }
        : { id: choice.appChoice },
    keyName: choice.keyName.trim(),
    scopes: choice.scopes,
  }
}

// 每个平台一项，顺序和申请的一样；勾掉的写成跳过
export const approveBody = (
  userCode: string,
  spaceId: string,
  choices: readonly PlatformChoice[],
): DeviceGrantApprove => ({ userCode, spaceId, items: choices.map(approveItem) })

// 确认、拒绝失败之后怎么办：
// - gone：404。拒绝时就是确认码不对或已过期，回第一步；确认时还可能是应用不存在，
//   页面按确认码再查一次，查不到才回第一步，查得到就留在这一步显示服务端的说明
// - slug：409。新建应用时是标识被占用，写在那个平台的标识一栏；选已有应用时是它的运行时与申请的不一致，显示说明
// - message：403 与其余的失败，原样显示服务端给的文字
// 只关于某一个平台的失败带着它的运行时，页面据此标到那一行
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

// 按确认码查申请失败时的说明：404 写确认码不对或已过期，别的用服务端给的文字
export const lookupFailure = (err: unknown): string =>
  err instanceof ApiError ? (err.status === 404 ? GRANT_GONE : err.message) : '申请读取失败'
