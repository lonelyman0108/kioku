import {
  DeviceUserCode,
  Slug,
  formatDeviceUserCode,
  type AppInfo,
  type DeviceGrantApprove,
  type DeviceGrantInfo,
  type KeyScopes,
  type RuntimeFamily,
  type SpaceSummary,
} from '@kioku/contracts'

import { ApiError } from './api/client'
import { ownedApps } from './benchSession'
import { keyPresets, matchPreset, presetScopes, tightenScopes } from './components/keyPresets'

// 浏览器授权确认页的判断与说法：确认码的规整、能选哪些空间与应用、默认值、报错怎么处理

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

// 能直接选的应用：当前账号自己是所有者、运行时和申请一致的
export const grantApps = (
  apps: readonly AppInfo[],
  accountId: string | undefined,
  runtimeFamily: RuntimeFamily,
): AppInfo[] => ownedApps(apps, accountId).filter((app) => app.runtimeFamily === runtimeFamily)

// 选「新建应用」时 appChoice 的值；应用的 id 是 uuid，不会相同
export const NEW_APP = 'new'

// 各运行时的产品名，用作新建应用与访问密钥的默认名称
export const runtimeNames: Record<RuntimeFamily, string> = {
  claudecode: 'Claude Code',
  codex: 'Codex',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  opencode: 'OpenCode',
  pi: 'Pi',
  astrbot: 'AstrBot',
  mcp: 'MCP',
  other: '其他客户端',
}

// 新建应用的默认标识：运行时的名字，已被占用时往后加序号
export function defaultAppSlug(runtimeFamily: RuntimeFamily, taken: readonly string[]): string {
  if (!taken.includes(runtimeFamily)) return runtimeFamily
  for (let n = 2; ; n++) {
    const slug = `${runtimeFamily}-${n}`
    if (!taken.includes(slug)) return slug
  }
}

// 标识的问题：格式照契约的 Slug，空间里已有的标识不能再用（服务端以唯一约束为准，回 409）
export function appSlugProblem(slug: string, taken: readonly string[]): string | null {
  if (!Slug.safeParse(slug).success) return '小写字母、数字和连字符，以字母或数字开头。'
  if (taken.includes(slug)) return `标识 ${slug} 已被占用`
  return null
}

const NAME_MAX = 64
// 名称按码点算长度，和契约的上限一致
export const nameProblem = (name: string): string | null => {
  const length = Array.from(name.trim()).length
  return length >= 1 && length <= NAME_MAX ? null : `请填写 1 到 ${NAME_MAX} 个字符。`
}

// 访问密钥的默认名称：命令行自报的名字，没有就用运行时的名字
export const defaultKeyName = (info: Pick<DeviceGrantInfo, 'clientName' | 'runtimeFamily'>) =>
  info.clientName?.trim() || runtimeNames[info.runtimeFamily]

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

export interface GrantChoice {
  userCode: string
  spaceId: string
  // 已有应用的 id，或 NEW_APP
  appChoice: string
  newApp: { slug: string; name: string }
  keyName: string
  scopes: KeyScopes
}

export function approveBody(choice: GrantChoice): DeviceGrantApprove {
  return {
    userCode: choice.userCode,
    spaceId: choice.spaceId,
    app:
      choice.appChoice === NEW_APP
        ? { slug: choice.newApp.slug, name: choice.newApp.name.trim() }
        : { id: choice.appChoice },
    keyName: choice.keyName.trim(),
    scopes: choice.scopes,
  }
}

// 确认、拒绝失败之后怎么办：
// - gone：404。拒绝时就是确认码不对或已过期，回第一步；确认时还可能是应用不存在，
//   页面按确认码再查一次，查不到才回第一步，查得到就留在这一步显示服务端的说明
// - slug：409。新建应用时是标识被占用，写在标识那一栏；选已有应用时是它的运行时与申请的不一致，显示说明
// - message：403 与其余的失败，原样显示服务端给的文字
export interface GrantFailure {
  kind: 'gone' | 'slug' | 'message'
  text: string
}
export function grantFailure(err: unknown, fallback: string): GrantFailure {
  if (!(err instanceof ApiError)) return { kind: 'message', text: fallback }
  if (err.status === 404) return { kind: 'gone', text: err.message }
  if (err.status === 409) return { kind: 'slug', text: err.message }
  return { kind: 'message', text: err.message }
}

// 按确认码查申请失败时的说明：404 写确认码不对或已过期，别的用服务端给的文字
export const lookupFailure = (err: unknown): string =>
  err instanceof ApiError ? (err.status === 404 ? GRANT_GONE : err.message) : '申请读取失败'
