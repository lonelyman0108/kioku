import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

import { normalizeSetupCode } from '../config'

// 初始化码：还没有任何账号时，填数据库与建第一个管理员两步都要带它。码打印在服务的启动日志里，
// 能看到日志的才是部署的人；初始化页对外开着时，别人打开页面也做不了初始化。
// 设了 KIOKU_SETUP_CODE 时用它（至少 16 个字符，见 config.ts），否则每次启动随机生成一个；有了账号就作废。
//
// 防猜靠码本身的强度：随机生成的有 130 位熵，猜中的概率可以不计。码错的计数只按客户端（IPv6 按 /64，
// 和登录同一个分桶），同一客户端 15 分钟 5 次，挡住单个来源刷请求。不设全实例合计的上限：
// 合计上限谁都能刷满，部署的人就被锁在自己的初始化页外面。
// 计数放在内存里：填数据库那一步还没有库可写。先计数再比对，超限的请求不比对；比对成功清掉本客户端的计数。
// 重启后计数清零（随机的码也换了新的）
const WINDOW_MS = 15 * 60_000
const PER_CLIENT_LIMIT = 5
// 按客户端记的条目最多这么多，满了丢掉最早记下的：每个来源只有 5 次，码又猜不中，丢掉旧条目不影响防猜
const MAX_CLIENTS = 10_000

// 去掉容易认错的 0 O 1 I：26 位、每位 32 种，共 130 位随机，按四位一组显示
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 26

export function generateSetupCode(): string {
  const chars = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]!)
  return chars.join('').replace(/(.{4})(?=.)/g, '$1-')
}

// 定长比较：两边先规整写法再取摘要，长度不同也不会提前返回
function digest(value: string): Buffer {
  return createHash('sha256').update(normalizeSetupCode(value)).digest()
}

interface Counter {
  count: number
  resetAt: number
}

export type SetupCodeResult = 'ok' | 'wrong' | 'limited' | 'closed'

export class SetupGate {
  #code: string | null = null
  #digest: Buffer | null = null
  readonly #fixed: string | null
  readonly #clients = new Map<string, Counter>()
  readonly #now: () => number

  // fixed：KIOKU_SETUP_CODE；不设时 open() 随机生成
  constructor(fixed: string | null, now: () => number = Date.now) {
    this.#fixed = fixed
    this.#now = now
  }

  // 需要初始化时打开：返回这次的码，由调用方打印到日志。已经开着时返回同一个码
  open(): string {
    if (!this.#code) {
      this.#code = this.#fixed ?? generateSetupCode()
      this.#digest = digest(this.#code)
    }
    return this.#code
  }

  // 有了账号：码作废，之后的核对一律是 closed
  close(): void {
    this.#code = null
    this.#digest = null
  }

  get isOpen(): boolean {
    return this.#digest !== null
  }

  // 核对请求带的码。client 是客户端的分桶（clientIdentity 的 key；拿不到地址时为 null，共用一个计数）
  verify(input: string, client: string | null): SetupCodeResult {
    if (!this.#digest) return 'closed'
    const now = this.#now()
    const key = client ?? ''
    const own = this.#counter(key, now)
    if (own.count >= PER_CLIENT_LIMIT) return 'limited'
    own.count++
    if (timingSafeEqual(digest(input), this.#digest)) {
      this.#clients.delete(key)
      return 'ok'
    }
    return 'wrong'
  }

  #counter(key: string, now: number): Counter {
    let counter = this.#clients.get(key)
    if (counter && counter.resetAt <= now) {
      this.#clients.delete(key)
      counter = undefined
    }
    if (!counter) {
      if (this.#clients.size >= MAX_CLIENTS) {
        for (const [k, c] of this.#clients) if (c.resetAt <= now) this.#clients.delete(k)
        // 还是满的：丢掉最早记下的（Map 按插入顺序）
        if (this.#clients.size >= MAX_CLIENTS) {
          this.#clients.delete(this.#clients.keys().next().value!)
        }
      }
      counter = { count: 0, resetAt: now + WINDOW_MS }
      this.#clients.set(key, counter)
    }
    return counter
  }
}
