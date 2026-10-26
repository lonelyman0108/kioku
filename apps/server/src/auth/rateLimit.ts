// 登录失败限流：同一用户名在窗口期内失败过多就暂时拒绝。单进程内存实现，重启即清零，
// 目的是挡住在线暴力尝试，不是精确计数。
const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 5

const failures = new Map<string, { count: number; resetAt: number }>()

export function isLocked(key: string, now = Date.now()): boolean {
  const entry = failures.get(key)
  if (!entry || entry.resetAt <= now) return false
  return entry.count >= MAX_FAILURES
}

export function recordFailure(key: string, now = Date.now()): void {
  const entry = failures.get(key)
  if (!entry || entry.resetAt <= now) {
    failures.set(key, { count: 1, resetAt: now + WINDOW_MS })
  } else {
    entry.count += 1
  }
}

export function clearFailures(key: string): void {
  failures.delete(key)
}
