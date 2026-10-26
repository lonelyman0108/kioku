import { lte, sql } from 'drizzle-orm'

import type { Db } from '../db/client'
import { loginAttempts } from '../db/schema'

// 登录失败限流：同一用户名在窗口期内最多尝试 5 次。计数在数据库里原子递增，
// 并发请求也逐个计数；放行后才去做耗时的密码校验
const WINDOW_SECONDS = 15 * 60
const MAX_ATTEMPTS = 5

// 在校验密码之前先占一次名额。返回 false 表示已经超限；登录成功后调用 clearAttempts 清零
export async function reserveAttempt(db: Db, username: string): Promise<boolean> {
  const key = username.toLowerCase()
  const [row] = await db
    .insert(loginAttempts)
    .values({
      username: key,
      count: 1,
      resetAt: sql`now() + make_interval(secs => ${WINDOW_SECONDS})`,
    })
    .onConflictDoUpdate({
      target: loginAttempts.username,
      set: {
        count: sql`case when ${loginAttempts.resetAt} <= now() then 1 else ${loginAttempts.count} + 1 end`,
        resetAt: sql`case when ${loginAttempts.resetAt} <= now() then now() + make_interval(secs => ${WINDOW_SECONDS}) else ${loginAttempts.resetAt} end`,
      },
    })
    .returning({ count: loginAttempts.count })
  return (row?.count ?? MAX_ATTEMPTS + 1) <= MAX_ATTEMPTS
}

export async function clearAttempts(db: Db, username: string): Promise<void> {
  await db.delete(loginAttempts).where(sql`${loginAttempts.username} = ${username.toLowerCase()}`)
}

// 清掉已过期的计数；随机用户名刷出来的行过了窗口期就没有用了
export async function pruneAttempts(db: Db): Promise<void> {
  await db.delete(loginAttempts).where(lte(loginAttempts.resetAt, sql`now()`))
}
