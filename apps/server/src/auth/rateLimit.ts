import { inArray, lte, sql } from 'drizzle-orm'

import type { Db } from '../db/client'
import { loginAttempts } from '../db/schema'

// 登录失败限流，计数在数据库里原子递增，并发请求也逐个计数。分两级：
// - 同一用户名、同一客户端：15 分钟 5 次。攻击者只能锁住自己这一路，锁不住从别处登录的主人；
// - 同一用户名、所有客户端合计：15 分钟 50 次，挡住换着地址的分布式尝试。
// 拿不到客户端地址时（没有底层连接，例如测试）只能按用户名计数，上限回到 5 次
const WINDOW_SECONDS = 15 * 60
const PER_CLIENT_LIMIT = 5
const PER_USER_LIMIT = 50

// trustedDevice：请求带着这个账号有效的设备 Cookie，不计入、也不受「用户名合计」上限约束
function keysFor(username: string, client: string | null, trustedDevice = false) {
  const user = `u:${username.toLowerCase()}`
  if (client === null) return [{ key: user, limit: PER_CLIENT_LIMIT }]
  const perClient = { key: `${user}|c:${client}`, limit: PER_CLIENT_LIMIT }
  return trustedDevice ? [perClient] : [perClient, { key: user, limit: PER_USER_LIMIT }]
}

async function bump(db: Db, key: string): Promise<number> {
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
  return row?.count ?? Number.MAX_SAFE_INTEGER
}

// 在校验密码之前先占一次名额。返回 false 表示已经超限；登录成功后调用 clearAttempts 清零。
// 逐级计数，某一级已经超限就停下、不再累加更大范围的计数：否则一个已经被锁住的客户端
// 还能继续把「用户名合计」推到上限，连主人从别处登录也一起锁住
export async function reserveAttempt(
  db: Db,
  username: string,
  client: string | null,
  trustedDevice = false,
): Promise<boolean> {
  for (const { key, limit } of keysFor(username, client, trustedDevice)) {
    if ((await bump(db, key)) > limit) return false
  }
  return true
}

export async function clearAttempts(
  db: Db,
  username: string,
  client: string | null,
): Promise<void> {
  const keys = keysFor(username, client).map((k) => k.key)
  await db.delete(loginAttempts).where(inArray(loginAttempts.username, keys))
}

// 清掉已过期的计数；随机用户名刷出来的行过了窗口期就没有用了
export async function pruneAttempts(db: Db): Promise<void> {
  await db.delete(loginAttempts).where(lte(loginAttempts.resetAt, sql`now()`))
}
