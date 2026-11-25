// 内存登录与密码校验失败限流：单进程单人实例下避免数据库行锁死锁，同时保留按客户端与按用户名合计两级窗口。
// 带有效设备 Cookie 的受信设备越过用户名合计上限，仍受本客户端上限约束。
// 采用「校验前原子预扣、并发闸门繁忙时退还、校验通过时清零本客户端并退还合计」的顺序，避免并发请求绕过上限。

const WINDOW_MS = 15 * 60 * 1000
const CLIENT_LIMIT = 10
const TOTAL_LIMIT = 30
const MAX_BUCKETS = 10_000

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

const clientKey = (username: string, client: string) => `c:${client}:${username}`
const totalKey = (username: string) => `t:${username}`

function pruneExpired(now: number): void {
  if (buckets.size < MAX_BUCKETS) return
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k)
  }
  while (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next().value
    if (oldest === undefined) break
    buckets.delete(oldest)
  }
}

function activeBucket(key: string, now: number): Bucket | null {
  const b = buckets.get(key)
  if (!b) return null
  if (b.resetAt <= now) {
    buckets.delete(key)
    return null
  }
  return b
}

function bump(key: string, now: number): void {
  const current = activeBucket(key, now)
  if (current) {
    current.count += 1
    return
  }
  pruneExpired(now)
  buckets.set(key, { count: 1, resetAt: now + WINDOW_MS })
}

function decrement(key: string, now: number): void {
  const current = activeBucket(key, now)
  if (!current) return
  current.count -= 1
  if (current.count <= 0) buckets.delete(key)
}

export interface LoginLimitCheck {
  limited: boolean
  retryAfterSeconds: number
}

// 原子检查并预扣一次校验名额：超限时直接拒绝且不再递增；放行时同步递增，防止并发请求击穿窗口上限
export function reserveLoginAttempt(
  username: string,
  client: string,
  options: { trustedDevice?: boolean; now?: number } = {},
): LoginLimitCheck {
  const now = options.now ?? Date.now()
  const c = activeBucket(clientKey(username, client), now)
  if (c && c.count >= CLIENT_LIMIT) {
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((c.resetAt - now) / 1000)) }
  }
  if (!options.trustedDevice) {
    const t = activeBucket(totalKey(username), now)
    if (t && t.count >= TOTAL_LIMIT) {
      return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((t.resetAt - now) / 1000)) }
    }
  }
  bump(clientKey(username, client), now)
  bump(totalKey(username), now)
  return { limited: false, retryAfterSeconds: 0 }
}

// 并发闸门拒绝（未真正执行密码校验）时退还预扣名额
export function refundLoginAttempt(username: string, client: string, now = Date.now()): void {
  decrement(clientKey(username, client), now)
  decrement(totalKey(username), now)
}

// 校验成功：清零本客户端计数，并退还本次预扣到用户名合计窗口的 1 次计数
export function clearLoginFailures(username: string, client: string, now = Date.now()): void {
  buckets.delete(clientKey(username, client))
  decrement(totalKey(username), now)
}

export function resetLoginLimitsForTest(): void {
  buckets.clear()
}
