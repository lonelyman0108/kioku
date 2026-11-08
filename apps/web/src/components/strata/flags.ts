import {
  CREDENTIAL_EXPIRY_NAMES,
  CREDENTIAL_ROTATION_NAME,
  type ConsoleCredential,
  type CredentialExpiry,
} from '@kioku/contracts'

import { icons } from '../../icons'

// 状态标签（FlagTag）有哪几种。调用处传状态，不传文字：文字与图标都从这里取，改了说法图标不会跟着丢
export type FlagStatus =
  | 'expired'
  | 'deleted'
  | 'bench'
  | 'left'
  | 'unsaved'
  | 'revoked'
  | 'expiring'
  | 'credentialExpired'
  | 'rotation'
  | 'accountActive'
  | 'pendingPassword'
  | 'pendingReset'
  | 'accountDisabled'
  | 'currentDevice'

// 每种状态的文字与图标。图标只作辅助，文字照样写全；同一个状态到处是同一个图标（未保存和保存条一致）。
// 现在的调用处：已删除、快到期、已到期、需要轮换、测试台在凭据（列表、待处理、详情）；已过期在已删除的记忆；
// 未保存在记忆详情；已吊销在访问密钥列表。超出可见范围给变更记录（ActivityEntry、RecentChange）用，
// 变更记录改用状态标签时，已过期、已删除、测试台也从这里取
// warning：要留意的状态（已过期、未保存）文字用告警色，和原来这两处的写法一致；其余是墨色
export const FLAGS: Record<FlagStatus, { label: string; icon: string; warning?: boolean }> = {
  expired: { label: '已过期', icon: icons.expired, warning: true },
  deleted: { label: '已删除', icon: icons.remove },
  bench: { label: '测试台', icon: icons.bench },
  left: { label: '超出可见范围', icon: icons.left },
  unsaved: { label: '未保存', icon: icons.unsaved, warning: true },
  revoked: { label: '已吊销', icon: icons.revoked },
  expiring: { label: CREDENTIAL_EXPIRY_NAMES.expiring, icon: icons.expired },
  credentialExpired: { label: CREDENTIAL_EXPIRY_NAMES.expired, icon: icons.credentialExpired },
  rotation: { label: CREDENTIAL_ROTATION_NAME, icon: icons.refresh },
  // 实例的账号列表与登录设备
  accountActive: { label: '正常', icon: icons.accountActive },
  pendingPassword: { label: '待设置密码', icon: icons.pendingPassword, warning: true },
  pendingReset: { label: '待重置密码', icon: icons.pendingPassword },
  accountDisabled: { label: '已停用', icon: icons.accountDisabled },
  currentDevice: { label: '当前设备', icon: icons.currentDevice },
}

// 凭据到期的两种状态
export const expiryStatus = (expiry: CredentialExpiry): FlagStatus =>
  expiry === 'expiring' ? 'expiring' : 'credentialExpired'

// 凭据要处理的状态：快到期或已到期、需要轮换。判断只有这一份，vault.ts 的 credentialFlags 由它取文字
export function credentialFlagStatuses(
  c: Pick<ConsoleCredential, 'expiry' | 'rotationRequestedAt'>,
): FlagStatus[] {
  const flags: FlagStatus[] = []
  if (c.expiry) flags.push(expiryStatus(c.expiry))
  if (c.rotationRequestedAt) flags.push('rotation')
  return flags
}
