import { Password, WrongCurrentPassword, type AdminAccount } from '@kioku/contracts'

import { ApiError } from './api/client'
import { FLAGS, type FlagStatus } from './components/strata/flags'

// 设置密码链接的完整地址：令牌只在生成时给这一次，界面拼成 /password/<令牌>
export const passwordLinkUrl = (token: string, origin: string = location.origin) =>
  `${origin}/password/${encodeURIComponent(token)}`

export const LINK_ONCE_TEXT = '24 小时内有效，只能用一次。'

// 登录设备一栏：从 User-Agent 粗略认出浏览器与系统。认不出时写原文的开头，没有时写「未知设备」
const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Version\/[\d.]+.*Safari\//, 'Safari'],
]
const SYSTEMS: [RegExp, string][] = [
  [/iPad/, 'iPadOS'],
  [/iPhone|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
]
const RAW_HEAD = 40

export function deviceName(userAgent: string | null): string {
  if (!userAgent) return '未知设备'
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1]
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1]
  if (browser || system) return [browser, system].filter(Boolean).join(' · ')
  const points = Array.from(userAgent)
  return points.length > RAW_HEAD ? `${points.slice(0, RAW_HEAD).join('')}…` : userAgent
}

// 链接还有多久过期：按整小时往上取，不到一小时写分钟
export function expiresIn(iso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.ceil((new Date(iso).getTime() - now.getTime()) / 60_000))
  if (minutes < 60) return `${minutes} 分钟后过期`
  return `${Math.ceil(minutes / 60)} 小时后过期`
}

// 账号列表里的状态：停用优先；没设过密码的是待设置密码（链接过期了照样写出来）；
// 设过密码、又有没用的重置链接时另加一个标签
export interface AccountState {
  status: FlagStatus
  detail: string | null
}
export function accountStates(account: AdminAccount, now: Date = new Date()): AccountState[] {
  if (account.disabledAt) return [{ status: 'accountDisabled', detail: null }]
  const link = account.pendingLink
  if (!account.passwordSet) {
    return [
      {
        status: 'pendingPassword',
        detail: link ? expiresIn(link.expiresAt, now) : '链接已过期',
      },
    ]
  }
  const states: AccountState[] = [{ status: 'accountActive', detail: null }]
  if (link) states.push({ status: 'pendingReset', detail: expiresIn(link.expiresAt, now) })
  return states
}

export const accountStateText = (state: AccountState) =>
  state.detail ? `${FLAGS[state.status].label} · ${state.detail}` : FLAGS[state.status].label

// 当前账号这一行：停用与管理员身份都不能改，写出原因
export const SELF_LOCKED_REASON = '无法修改当前账号的停用状态与管理员身份'

// 改密码失败的说明：当前密码不对、新密码不合规、尝试太多、别处刚改过分开说。
// 400 有两种：错误体带 code 的是当前密码不对；其余是请求校验没过，服务端的说明开头是字段名，不直接显示
export function changePasswordError(err: unknown): string {
  if (!(err instanceof ApiError)) return '修改失败'
  if (err.status === 400) {
    return WrongCurrentPassword.safeParse(err.payload).success ? '当前密码错误' : '新密码不符合要求'
  }
  if (err.status === 429) return '尝试次数过多，请稍后重试'
  if (err.status === 409) return '密码刚在别处修改过，请刷新页面后重试'
  return err.message
}

// 新密码与再输一次：规则只用契约的 Password（长度的算法、上限都和服务端一致），这里先拦下，说明更直接
export function newPasswordProblem(password: string, repeat: string): string | null {
  if (!password) return null
  const parsed = Password.safeParse(password)
  if (!parsed.success) return parsed.error.issues[0]?.message ?? '密码不符合要求'
  if (repeat && repeat !== password) return '两次输入的密码不一致'
  return null
}
export const newPasswordReady = (password: string, repeat: string) =>
  Boolean(password) && password === repeat && newPasswordProblem(password, repeat) === null

// 设置密码页：读链接的结果分三种。无效、过期、用过的服务端都回 404
export type LinkPageState = 'loading' | 'ready' | 'invalid' | 'failed'
export function linkLoadState(err: unknown): LinkPageState {
  return err instanceof ApiError && err.status === 404 ? 'invalid' : 'failed'
}

// 设置密码失败：链接失效、尝试太多分开说
export function setPasswordError(err: unknown): { text: string; invalid: boolean } {
  if (err instanceof ApiError && err.status === 404)
    return { text: '链接无效或已过期', invalid: true }
  if (err instanceof ApiError && err.status === 429)
    return { text: '尝试次数过多，请稍后重试', invalid: false }
  return { text: err instanceof ApiError ? err.message : '设置失败', invalid: false }
}

// 停用之后没有可用所有者的空间：他是这些空间里唯一没停用的所有者。字段由服务端的账号列表给出
export function soleOwnerSpaces(account: AdminAccount): string[] {
  return account.spaces.filter((s) => s.soleActiveOwner).map((s) => s.name)
}
export const SOLE_OWNER_TEXT =
  '停用后这些空间没有可用的所有者，无法管理成员与设置；重新启用后恢复。'

// 请求成功了、弹窗却已经关掉时的说明：结果与下一步。链接只显示一次，丢掉之后只能重新生成
export function droppedLinkNotice(kind: 'create' | 'regenerate', displayName: string): string {
  return kind === 'create'
    ? `已新建 ${displayName}，设置密码链接未显示，请在列表里重新生成`
    : `已为 ${displayName} 重新生成链接，之前的链接失效；新链接未显示，请再生成一次`
}

// 只认最近一次请求的结果：弹窗关掉、重新打开或换了目标之后，之前发出的请求回来时丢弃。
// 设置密码链接靠它：取消之后才回来的令牌不能留到下一次、显示在别的账号名下
export function latestRequest() {
  let current = 0
  return {
    // 发请求时取一个序号
    begin: () => ++current,
    // 关掉、打开弹窗或换目标时调用：之前的序号都作废
    reset: () => {
      current++
    },
    isCurrent: (ticket: number) => ticket === current,
  }
}
