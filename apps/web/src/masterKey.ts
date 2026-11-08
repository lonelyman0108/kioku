import type { MasterKeyStatus } from '@kioku/contracts'

type Remaining = MasterKeyStatus['remaining']

// 要加起来的各类加密数据，以及轮换进度表里每一行的名字，按这个顺序列。契约里多出一类而这里没列时编译不过
export const REMAINING_LABELS: Record<keyof Remaining, string> = {
  memories: '机密记忆',
  credentials: '托管的凭据',
  vaultConnections: '密码库连接',
  settings: '实例设置中的密钥',
}

const REMAINING_FIELDS = Object.keys(REMAINING_LABELS) as (keyof Remaining)[]

// 还是旧主密钥包装的数据合计多少条
export function remainingTotal(remaining: Remaining | undefined): number {
  if (!remaining) return 0
  return REMAINING_FIELDS.reduce((sum, field) => sum + remaining[field], 0)
}

// 轮换进度表的行：每一类还剩多少条
export function remainingRows(
  remaining: Remaining,
): { key: string; label: string; count: number }[] {
  return REMAINING_FIELDS.map((field) => ({
    key: field,
    label: REMAINING_LABELS[field],
    count: remaining[field],
  }))
}
