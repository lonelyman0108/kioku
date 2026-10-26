import { inArray, lte, sql } from 'drizzle-orm'

import type { Db } from '../db/client'
import { loginAttempts } from '../db/schema'

// 登录失败限流，计数在数据库里原子递增，并发请求也逐个计数。分两级：
// - 同一用户名、同一客户端：15 分钟 5 次。攻击者只能锁住自己这一路，锁不住从别处登录的主人；
// - 同一用户名、所有客户端合计：15 分钟 50 次，挡住换着地址的分布式尝试。
//   带着这个账号有效设备 Cookie 的请求不受合计上限约束（见 deviceCookie.ts）。
// 拿不到客户端地址时（没有底层连接，例如测试）只能按用户名计数，上限回到 5 次
const WINDOW_SECONDS = 15 * 60
const PER_CLIENT_LIMIT = 5
const PER_USER_LIMIT = 50

function userKey(username: string): string {
  return `u:${username.toLowerCase()}`
}

function clientCounter(username: string, client: string | null) {
  return client === null
    ? { key: userKey(username), limit: PER_CLIENT_LIMIT }
    : { key: `${userKey(username)}|c:${client}`, limit: PER_CLIENT_LIMIT }
}

function keysFor(username: string, client: string | null, trustedDevice: boolean) {
  const own = clientCounter(username, client)
  if (client === null || trustedDevice) return [own]
  return [own, { key: userKey(username), limit: PER_USER_LIMIT }]
}

async function bump(db: Db, key: string, delta: number): Promise<number> {
  const [row] = await db
    .insert(loginAttempts)
    .values({
      username: key,
      count: Math.max(delta, 0),
      resetAt: sql`now() + make_interval(secs => ${WINDOW_SECONDS})`,
    })
    .onConflictDoUpdate({
      target: loginAttempts.username,
      set: {
        count: sql`case when ${loginAttempts.resetAt} <= now() then ${Math.max(delta, 0)} else greatest(${loginAttempts.count} + ${delta}, 0) end`,
        resetAt: sql`case when ${loginAttempts.resetAt} <= now() then now() + make_interval(secs => ${WINDOW_SECONDS}) else ${loginAttempts.resetAt} end`,
      },
    })
    .returning({ count: loginAttempts.count })
  return row?.count ?? Number.MAX_SAFE_INTEGER
}

// 在校验密码之前先占一次名额，返回 false 表示已经超限。
// 逐级计数，某一级已经超限就停下、不再累加更大范围的计数：否则一个已经被锁住的客户端
// 还能继续把「用户名合计」推到上限，连主人从别处登录也一起锁住
export async function reserveAttempt(
  db: Db,
  username: string,
  client: string | null,
  trustedDevice: boolean,
): Promise<boolean> {
  for (const { key, limit } of keysFor(username, client, trustedDevice)) {
    if ((await bump(db, key, 1)) > limit) return false
  }
  return true
}

// 占了名额却没有真正校验密码（校验闸门繁忙）时退回
export async function refundAttempt(
  db: Db,
  username: string,
  client: string | null,
  trustedDevice: boolean,
): Promise<void> {
  for (const { key } of keysFor(username, client, trustedDevice)) await bump(db, key, -1)
}

// 登录成功只清掉本客户端的计数，不动「用户名合计」：否则主人每登录一次，分布式尝试的额度就重置一次
export async function clearClientAttempts(
  db: Db,
  username: string,
  client: string | null,
): Promise<void> {
  if (client === null) return
  await db
    .delete(loginAttempts)
    .where(inArray(loginAttempts.username, [clientCounter(username, client).key]))
}

// 清掉已过期的计数；随机用户名刷出来的行过了窗口期就没有用了
export async function pruneAttempts(db: Db): Promise<void> {
  await db.delete(loginAttempts).where(lte(loginAttempts.resetAt, sql`now()`))
}
