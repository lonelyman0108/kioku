import type { MasterKeyStatus } from '@kioku/contracts'

type Remaining = MasterKeyStatus['remaining']

// 要加起来的各类加密数据。契约里多出一类而这里没列时编译不过
const REMAINING_FIELDS: Record<keyof Remaining, true> = {
  memories: true,
  credentials: true,
  vaultConnections: true,
  settings: true,
}

// 还是旧主密钥包装的数据合计多少条
export function remainingTotal(remaining: Remaining | undefined): number {
  if (!remaining) return 0
  return (Object.keys(REMAINING_FIELDS) as (keyof Remaining)[]).reduce(
    (sum, field) => sum + remaining[field],
    0,
  )
}
