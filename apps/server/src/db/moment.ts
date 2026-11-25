import { AsyncLocalStorage } from 'node:async_hooks'

// 当前事务开头取的数据库时间（见 db/client.ts 的 withTx），使同一事务内 SQL 与 JS 使用同一时钟
export const transactionMoment = new AsyncLocalStorage<Date>()

export function currentMoment(): Date | undefined {
  return transactionMoment.getStore()
}
