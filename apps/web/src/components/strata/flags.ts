import {
  CREDENTIAL_EXPIRY_NAMES,
  CREDENTIAL_ROTATION_NAME,
  type ConsoleCredential,
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

// 每种状态的文字与图标。图标只作辅助，文字照样写全；同一个状态到处是同一个图标（未保存和保存条一致）
export const FLAGS: Record<FlagStatus, { label: string; icon: string }> = {
  expired: { label: '已过期', icon: icons.expired },
  deleted: { label: '已删除', icon: icons.remove },
  bench: { label: '测试台', icon: icons.bench },
  left: { label: '超出可见范围', icon: icons.left },
  unsaved: { label: '未保存', icon: icons.unsaved },
  revoked: { label: '已吊销', icon: icons.revoked },
  expiring: { label: CREDENTIAL_EXPIRY_NAMES.expiring, icon: icons.expired },
  credentialExpired: { label: CREDENTIAL_EXPIRY_NAMES.expired, icon: icons.credentialExpired },
  rotation: { label: CREDENTIAL_ROTATION_NAME, icon: icons.refresh },
}

// 凭据要处理的状态：快到期或已到期、需要轮换。顺序和 vault.ts 的 credentialFlags 一样
export function credentialFlagStatuses(
  c: Pick<ConsoleCredential, 'expiry' | 'rotationRequestedAt'>,
): FlagStatus[] {
  const flags: FlagStatus[] = []
  if (c.expiry === 'expiring') flags.push('expiring')
  if (c.expiry === 'expired') flags.push('credentialExpired')
  if (c.rotationRequestedAt) flags.push('rotation')
  return flags
}
