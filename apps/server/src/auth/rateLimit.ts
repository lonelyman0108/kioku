// 登录失败限流：同一用户名在窗口期内尝试过多就暂时拒绝。单进程内存实现，重启即清零，
// 目的是挡住在线暴力尝试，不是精确计数。
const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 5
// 用随机用户名刷请求时表会一直长；满了就清过期项，仍满就淘汰最早的一成未锁定项。
// 已锁定的项永不提前淘汰，否则刷一批随机用户名就能把被锁账号的计数挤掉
const MAX_ENTRIES = 10_000
const EVICT_BATCH = MAX_ENTRIES / 10

const attempts = new Map<string, { count: number; resetAt: number }>()

function prune(now: number): void {
  if (attempts.size < MAX_ENTRIES) return
  for (const [key, entry] of attempts) if (entry.resetAt <= now) attempts.delete(key)
  if (attempts.size < MAX_ENTRIES) return
  let evicted = 0
  for (const [key, entry] of attempts) {
    if (evicted >= EVICT_BATCH) break
    if (entry.count >= MAX_ATTEMPTS) continue
    attempts.delete(key)
    evicted++
  }
}

// 在校验密码之前先占一次名额：并发请求也逐个计数，不会因为 scrypt 还没算完就全部放行。
// 返回 false 表示已经超限；登录成功后调用 clearAttempts 清零
export function reserveAttempt(key: string, now = Date.now()): boolean {
  prune(now)
  const entry = attempts.get(key)
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }
  if (entry.count >= MAX_ATTEMPTS) return false
  entry.count += 1
  return true
}

export function clearAttempts(key: string): void {
  attempts.delete(key)
}
