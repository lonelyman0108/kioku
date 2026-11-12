import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

import { normalizeSetupCode } from '../config'

// 初始化码：还没有任何账号时，填数据库与建第一个管理员两步都要带它。码打印在服务的启动日志里，
// 能看到日志的才是部署的人；初始化页对外开着时，别人打开页面也做不了初始化。
// 设了 KIOKU_SETUP_CODE 时用它，否则每次启动随机生成一个；有了账号就作废。
//
// 码错的计数放在内存里：填数据库那一步还没有库可写。分两级，和登录的思路一样：
// 同一客户端 15 分钟 5 次；所有客户端合计 15 分钟 50 次，挡住换着地址的尝试。
// 先计数再比对，超限的请求不比对；比对成功清掉本客户端的计数，并退回这次在合计里占的名额。
// 合计只因失败增长，所以按客户端记的条目最多 50 个，不用另设上限。重启后计数清零（随机的码也换了新的）
const WINDOW_MS = 15 * 60_000
const PER_CLIENT_LIMIT = 5
const TOTAL_LIMIT = 50

// 去掉容易认错的 0 O 1 I：16 位、每位 32 种，约 80 位随机，按四位一组显示
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateSetupCode(): string {
  const chars = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]!)
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
  #total: Counter = { count: 0, resetAt: 0 }
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

  // 核对请求带的码。client 是客户端的标识（拿不到地址时为 null，共用一个计数）
  verify(input: string, client: string | null): SetupCodeResult {
    if (!this.#digest) return 'closed'
    const now = this.#now()
    const key = client ?? ''
    // 先看本客户端，再看合计；合计超限时不新建本客户端的条目，条目数才有上限
    const existing = this.#clients.get(key)
    if (existing && this.#fresh(existing, now).count >= PER_CLIENT_LIMIT) return 'limited'
    if (this.#fresh(this.#total, now).count >= TOTAL_LIMIT) return 'limited'
    const own = existing ?? this.#counter(key, now)
    own.count++
    this.#total.count++
    if (timingSafeEqual(digest(input), this.#digest)) {
      this.#clients.delete(key)
      this.#total.count--
      return 'ok'
    }
    return 'wrong'
  }

  #fresh(counter: Counter, now: number): Counter {
    if (counter.resetAt <= now) {
      counter.count = 0
      counter.resetAt = now + WINDOW_MS
    }
    return counter
  }

  #counter(key: string, now: number): Counter {
    let counter = this.#clients.get(key)
    if (!counter) {
      // 顺带清掉过了窗口期的
      for (const [k, c] of this.#clients) if (c.resetAt <= now) this.#clients.delete(k)
      counter = { count: 0, resetAt: now + WINDOW_MS }
      this.#clients.set(key, counter)
    }
    return this.#fresh(counter, now)
  }
}
