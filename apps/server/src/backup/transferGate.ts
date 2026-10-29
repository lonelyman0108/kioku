import { MemoryError } from '../memory/service'

// 空间的导出、检查与导入：整个操作占一个名额，做完才放。这几样都要大块内存（上传的文件最多 32 MB、
// 口令派生上百 MiB、解压最多 128 MiB 再逐行解析、导出的文件攒在内存里直到发完），又是很少用的管理操作：
// 同时只做一个，其余排队；排队的有上限，每个账号同时最多占一个名额（排着或正在做）。满了直接拒绝（429）：
// 排队不设上限的话，任何一个空间 owner 连着点导出，就能让所有人的导出、导入都卡住。
// 排着队的请求断开了（客户端超时、关掉页面），就从队列里移除、放掉名额，不等轮到它再白做一次
const RUNNING = 1
const QUEUE = 4
const PER_ACCOUNT = 1
export const TRANSFER_BUSY = '导出导入正忙，稍后再试'

let running = 0
// 排着的请求：轮到它时调用
const queue: (() => void)[] = []
const perAccount = new Map<string, number>()

// 排着队的请求数（测试与排查用）
export const queuedTransfers = () => queue.length

function leave(account: string): void {
  const left = (perAccount.get(account) ?? 1) - 1
  if (left > 0) perAccount.set(account, left)
  else perAccount.delete(account)
}

// 请求已经断开：响应没人收，状态码只是给日志看的
const cancelled = () => new MemoryError(400, '请求已经断开，不再排队')

// 拿一个名额，返回放掉它的函数（调几次都只放一次）。满了抛 429；排队时 signal 断开就从队列里移除并抛错
export async function acquireTransferSlot(
  account: string,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) throw cancelled()
  const mine = perAccount.get(account) ?? 0
  if (mine >= PER_ACCOUNT) throw new MemoryError(429, TRANSFER_BUSY)
  if (running >= RUNNING && queue.length >= QUEUE) throw new MemoryError(429, TRANSFER_BUSY)
  perAccount.set(account, mine + 1)
  if (running < RUNNING) {
    running++
  } else {
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const at = queue.indexOf(start)
          if (at < 0) return
          queue.splice(at, 1)
          reject(cancelled())
        }
        function start() {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        queue.push(start)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    } catch (err) {
      leave(account)
      throw err
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    // 有排队的就把名额直接交给下一个，否则释放
    const next = queue.shift()
    if (next) next()
    else running--
    leave(account)
  }
}
