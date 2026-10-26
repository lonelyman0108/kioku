// 密码校验（scrypt）是 CPU 和内存密集的操作：全局同时只跑少量几个，其余排队，排队太长就直接拒绝，
// 避免用大量登录请求耗尽 CPU。另外每个客户端（按 IP）同时最多占 2 个名额，
// 单个来源刷请求只能挤占自己的份额，不会让所有人都登录不了
const MAX_CONCURRENT = 4
const MAX_QUEUE = 32
const PER_CLIENT = 2

let running = 0
const queue: (() => void)[] = []
const perClient = new Map<string, number>()

export class PasswordGateBusy extends Error {}

// client 为 null 表示拿不到客户端地址（没有底层连接，例如测试）：此时只用全局闸门
export async function withPasswordGate<T>(client: string | null, fn: () => Promise<T>): Promise<T> {
  const key = client ?? ''
  const mine = client === null ? 0 : (perClient.get(key) ?? 0)
  if (mine >= PER_CLIENT) throw new PasswordGateBusy('登录请求太多，请稍后再试')
  if (running >= MAX_CONCURRENT && queue.length >= MAX_QUEUE) {
    throw new PasswordGateBusy('登录请求太多，请稍后再试')
  }
  if (client !== null) perClient.set(key, mine + 1)
  try {
    if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => queue.push(resolve))
    else running++
    try {
      return await fn()
    } finally {
      // 有排队的就把名额直接交给下一个，否则释放
      const next = queue.shift()
      if (next) next()
      else running--
    }
  } finally {
    if (client !== null) {
      const left = (perClient.get(key) ?? 1) - 1
      if (left > 0) perClient.set(key, left)
      else perClient.delete(key)
    }
  }
}
