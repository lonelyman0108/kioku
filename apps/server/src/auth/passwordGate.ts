// 密码校验（scrypt）是 CPU 和内存密集的操作：同时只跑少量几个，其余排队；
// 排队太长就直接拒绝，避免用大量登录请求耗尽 CPU 或拖垮其他接口
const MAX_CONCURRENT = 4
const MAX_QUEUE = 32

let running = 0
const queue: (() => void)[] = []

export class PasswordGateBusy extends Error {}

export async function withPasswordGate<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    if (queue.length >= MAX_QUEUE) throw new PasswordGateBusy('登录请求太多，请稍后再试')
    await new Promise<void>((resolve) => queue.push(resolve))
  } else {
    running++
  }
  try {
    return await fn()
  } finally {
    // 有排队的就把名额直接交给下一个，否则释放
    const next = queue.shift()
    if (next) next()
    else running--
  }
}
