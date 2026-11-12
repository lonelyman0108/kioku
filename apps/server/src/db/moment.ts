import { AsyncLocalStorage } from 'node:async_hooks'

// 当前所在的 withSpace 事务开头取的数据库时间（见 db/client.ts 的 withSpace）。有效期只用数据库的钟：
// 判断有效期的 SQL 片段（momentSql）与 JS 判断（canRead）没有显式拿到时刻时，默认用它，同一个事务里
// 几条语句、SQL 与 JS 就是同一个时刻，不会漏传。这个文件只依赖 node 自带的模块：access 与 filter 都引用它
export const transactionMoment = new AsyncLocalStorage<Date>()

// 不在 withSpace 事务里时为 undefined
export function currentMoment(): Date | undefined {
  return transactionMoment.getStore()
}
