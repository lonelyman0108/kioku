import type { MasterKeyStatus } from '@kioku/contracts'

// 还是旧主密钥包装的数据合计多少条：各类加在一起，多一类加密数据时不用改这里
export function remainingTotal(remaining: MasterKeyStatus['remaining'] | undefined): number {
  return remaining ? Object.values(remaining).reduce((sum, n) => sum + n, 0) : 0
}
