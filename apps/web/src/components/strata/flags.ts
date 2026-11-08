import { CREDENTIAL_EXPIRY_NAMES, CREDENTIAL_ROTATION_NAME } from '@kioku/contracts'

import { icons } from '../../icons'

// 状态标签（FlagTag）的图标，按标签上的文字取，同一个状态到处是同一个图标。图标只作辅助，文字照样写全
export const flagIcons: Record<string, string> = {
  已过期: icons.expired,
  已删除: icons.remove,
  测试台: icons.bench,
  超出可见范围: icons.left,
  未保存: icons.error,
  已吊销: icons.revoked,
  [CREDENTIAL_EXPIRY_NAMES.expiring]: icons.expired,
  [CREDENTIAL_EXPIRY_NAMES.expired]: icons.credentialExpired,
  [CREDENTIAL_ROTATION_NAME]: icons.refresh,
}

export const flagIcon = (text: string): string | undefined => flagIcons[text]
