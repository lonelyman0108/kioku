// 条目修改时间的比较，客户端判断冲突与凭据服务判断「条目改过没有」共用这一份。
// 按 1 秒的容差比：Vaultwarden 用 MySQL 时把修改时间存成整秒（去掉或四舍五入小数），写入的响应却带着小数秒，
// 同一次写入前后读到的会差零点几秒；Vaultwarden 自己判断条目过期也留了 1 秒。
// 所以相差不到 1 秒的算同一个修改时间，晚 1 秒以上的才算更新。代价是 1 秒之内的另一次修改认不出来，和服务端一样
export const REVISION_TOLERANCE_MS = 1000

function parse(revision: string): number {
  return Date.parse(revision)
}

// 两个修改时间算不算同一个。解析不了时按原文比
export function sameRevision(a: string, b: string): boolean {
  const x = parse(a)
  const y = parse(b)
  if (Number.isNaN(x) || Number.isNaN(y)) return a === b
  return Math.abs(x - y) < REVISION_TOLERANCE_MS
}

// next 是不是比 prev 更新：晚 1 秒以上才算。解析不了时，原文不同就算更新
export function isNewerRevision(next: string, prev: string): boolean {
  const x = parse(next)
  const y = parse(prev)
  if (Number.isNaN(x) || Number.isNaN(y)) return next !== prev
  return x - y >= REVISION_TOLERANCE_MS
}
