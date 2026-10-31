import { AsyncLocalStorage } from 'node:async_hooks'

import type { BenchInternalDetail } from '@kioku/contracts'
import { sql } from 'drizzle-orm'

import { loggableError, pgErrorCode, type Db, type Tx } from '../db/client'
import type { Embedder } from '../embedding/provider'
import type { EmbedderSource } from '../embedding/source'
import type { Deps } from '../http/env'
import { semanticFor } from '../memory/context'
import { MemoryError } from '../memory/service'
import { normalizeQuery } from '../recall/recall'

// 回滚模式：一次运行的全部步骤放进一个事务，结束时回滚。约束、触发器与 RLS 都真实生效，后面的步骤读得到前面的写入。
// 做法是把 Deps.db 换成这个事务的代理、jobs 置空，接入方的路径不用改：
// - 同一条连接上不能并行开 savepoint，所以顶层的嵌套事务互相排队，已经在事务回调里的直接嵌套；
// - 每个 withSpace 是一层 savepoint，和真实的事务边界一一对应：出错只回滚出错的那个事务，同一步里已经结束的保留；
// - app.space_id 留在根事务里（savepoint 结束时不复原），每个顶层事务结束后清掉，和真实一样随事务失效；
// - 直接写在 deps.db 上的语句落在根事务上，出错会中止整个运行，后面的步骤记为没有执行；
// - 事务开着时不发外部请求（前面步骤的行锁和 URI 咨询锁都没放）：查询向量事先算好，事务里只查这张表；
// - postgres.js 的 savepoint 成功时不 release，一次运行的 savepoint 累积到回滚为止，靠步骤数与总时长的上限兜着。
// 时限只做合作式：步骤之间检查，正在跑的步骤靠语句时限收尾，等它结束才回滚。不用 Promise.race 提前结束事务：
// 驱动要等回调结束才发 ROLLBACK，放弃等待只是让事务和回调在后台继续开着。也不用 idle_in_transaction_session_timeout：
// 它靠断开连接结束事务，等于把每次超时都变成一次连接断开，回调照样还在跑

export interface BenchLimits {
  // 同时运行数：运行占一条连接，要小于连接池（生产 10 条）
  parallel: number
  statementTimeoutMs: number
  lockTimeoutMs: number
  // 事务开着的总时长，不含事务外算查询向量的时间
  runMs: number
  // 事务外算查询向量的总预算
  embedBudgetMs: number
}

const BENCH_LIMITS: BenchLimits = {
  parallel: 2,
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 3_000,
  runMs: 30_000,
  embedBudgetMs: 10_000,
}

export const benchLimits = (deps: Deps): BenchLimits => ({ ...BENCH_LIMITS, ...deps.benchLimits })

let running = 0

function enterGate(limit: number): () => void {
  if (running >= limit) throw new MemoryError(429, '测试台同时运行的回滚过多，请稍后重试')
  running++
  return () => {
    running--
  }
}

// 等锁超时与语句超时：只有回滚模式有这两个时限，附在内部错误上说明是哪一种
const TIMEOUT_CODES: Record<string, BenchInternalDetail> = {
  '55P03': 'lock_timeout',
  '57014': 'statement_timeout',
}

// 运行已经结束，或者超过了总时长：代理不再开始新的事务；运行结束之后事务句柄也不能再用
class RunStopped extends Error {
  constructor(readonly detail: BenchInternalDetail) {
    super(detail === 'run_timeout' ? '测试台的运行超过了总时长' : '测试台的运行已经结束')
  }
}

export type StopReason = 'aborted' | 'timeout'

// 一次回滚运行的状态与事务的代理
export class RollbackRun {
  private root: Tx | null = null
  private closed = false
  private aborted = false
  private deadline = Number.POSITIVE_INFINITY
  private detail: BenchInternalDetail | null = null
  private vectorMissed = false

  constructor(private readonly limits: BenchLimits) {}

  // 把根事务包成 Db：顶层的 transaction 排队，回调里的直接嵌套（否则自己等自己）；别的方法落在根事务上
  attach(tx: Tx): Db {
    const root = this.guard(tx)
    this.root = root
    this.deadline = Date.now() + this.limits.runMs
    const holding = new AsyncLocalStorage<true>()
    let tail: Promise<unknown> = Promise.resolve()
    const transaction = (fn: (inner: Tx) => Promise<unknown>) => {
      if (this.closed) return Promise.reject(new RunStopped('aborted'))
      if (holding.getStore()) return root.transaction(fn)
      const turn = tail
        .then(async () => {
          this.assertRunning()
          try {
            return await holding.run(true, () => root.transaction(fn))
          } finally {
            await this.clearSpace()
          }
        })
        .catch((err: unknown) => {
          this.note(err)
          throw err
        })
      tail = turn.catch(() => {})
      return turn
    }
    return new Proxy(root, {
      get: (target, prop) => (prop === 'transaction' ? transaction : Reflect.get(target, prop)),
    }) as unknown as Db
  }

  // 事务句柄：运行结束之后任何属性访问都抛错，里面再开的事务也一样包上。
  // 连接归还之后、连接断开之后驱动自己会拒绝句柄上的语句（UNSAFE_TRANSACTION、CONNECTION_CLOSED），不会落到别的连接上；
  // 但回调结束到 ROLLBACK 做完、连接归还之前这一小段驱动还放行：语句排在 ROLLBACK 后面，落在事务外，写入直接提交，
  // 逃出了回滚，只有这里挡得住。连接断开时外层事务先 reject、回调还在跑，也靠它让后面的步骤马上停下，不必逐条失败
  private guard(tx: Tx): Tx {
    return new Proxy(tx, {
      get: (target, prop) => {
        if (this.closed) throw new RunStopped('aborted')
        if (prop === 'transaction') {
          return (fn: (inner: Tx) => Promise<unknown>) =>
            target.transaction((inner) => fn(this.guard(inner)))
        }
        const value = Reflect.get(target, prop) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  // 根事务上不经 withSpace 的语句和真实一样读不到内容表：RLS 策略用 nullif，空串等于没设置。
  // 只在事务还活着时发，失败不影响这个事务的结果：根事务上的语句出错就是根事务中止了，后面的步骤由 stopReason 停下
  private async clearSpace(): Promise<void> {
    if (this.aborted) return
    try {
      await this.root?.execute(sql`select set_config('app.space_id', '', true)`)
    } catch {
      this.aborted = true
    }
  }

  private assertRunning(): void {
    if (this.closed) throw new RunStopped('aborted')
    if (Date.now() >= this.deadline) throw new RunStopped('run_timeout')
  }

  // 记下这一步内部错误的具体原因：工具把错误换成了固定文字，这里在事务外面看得到
  note(err: unknown): void {
    if (err instanceof RunStopped) this.detail ??= err.detail
    else this.detail ??= TIMEOUT_CODES[pgErrorCode(err) ?? ''] ?? null
  }

  takeDetail(): BenchInternalDetail | null {
    const detail = this.detail
    this.detail = null
    return detail
  }

  noteVectorMissed(): void {
    this.vectorMissed = true
  }

  takeVectorMissed(): boolean {
    const missed = this.vectorMissed
    this.vectorMissed = false
    return missed
  }

  close(): void {
    this.closed = true
  }

  // 后面的步骤还能不能执行。根事务中止之后每条语句都报错，所以直接在根事务上试一条：
  // 直接写在 deps.db 上的语句出错时，步骤里的代码可能把错误吞掉，别的地方看不出来
  async stopReason(): Promise<StopReason | null> {
    if (this.closed || this.aborted || !this.root) return 'aborted'
    try {
      await this.root.execute(sql`select 1`)
    } catch {
      this.aborted = true
      return 'aborted'
    }
    return Date.now() >= this.deadline ? 'timeout' : null
  }
}

class Rolled extends Error {}

// 在一个最后回滚的事务里执行 fn。fn 拿到的 deps 指向这个事务，后台任务置空，向量只查 vectors
export async function inRollback<T>(
  deps: Deps,
  vectors: QueryVectors,
  fn: (scoped: Deps, run: RollbackRun) => Promise<T>,
): Promise<T> {
  const limits = benchLimits(deps)
  const leave = enterGate(limits.parallel)
  const run = new RollbackRun(limits)
  const result: { value?: T } = {}
  try {
    await deps.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local statement_timeout = ${limits.statementTimeoutMs}`))
      await tx.execute(sql.raw(`set local lock_timeout = ${limits.lockTimeoutMs}`))
      const scoped: Deps = {
        ...deps,
        db: run.attach(tx),
        jobs: null,
        embedder: vectorTableSource(vectors, run),
      }
      try {
        result.value = await fn(scoped, run)
      } finally {
        // 先关再回滚，fn 抛错时也一样：回滚做完之前发出的语句会落在事务外（见 guard）
        run.close()
      }
      throw new Rolled()
    })
  } catch (err) {
    // 连接断开时外层先 reject、回调还在跑：先置状态让它停下，后面的步骤不再逐条发语句
    run.close()
    if (!(err instanceof Rolled)) throw err
  } finally {
    // 连接断开时放开闸门的时候回调可能还没跑完：运行已经关了，它的下一条语句会报错，很快就停
    leave()
  }
  return result.value as T
}

// 这次运行事先算好的查询向量：查询（已经规整过）→ 向量。model 为 null 表示实例没配嵌入模型
export interface QueryVectors {
  model: string | null
  vectors: ReadonlyMap<string, number[]>
}

export interface BenchQuery {
  text: string
  // 这个查询在真实路径上等嵌入接口的上限；不给时只受总预算限制
  timeoutMs?: number
}

// 开事务之前算好这次运行里字面量的查询，共用一个时间预算：用的是和真实召回同一段代码，
// 算不出来（接口出错或超时）的不进表，事务里查不到就只走全文与关键词
export async function prepareQueryVectors(
  deps: Deps,
  queries: readonly BenchQuery[],
  budgetMs: number,
): Promise<QueryVectors> {
  // 顺带预热：嵌入设置的缓存为空时要读库，事务开着时这要第二条连接
  const embedder = await deps.embedder.get().catch((err: unknown) => {
    console.warn('读取嵌入设置失败，这次运行不使用向量', loggableError(err))
    return null
  })
  const vectors = new Map<string, number[]>()
  if (!embedder) return { model: null, vectors }
  const deadline = Date.now() + budgetMs
  for (const { text, timeoutMs } of queries) {
    const query = normalizeQuery(text)
    if (!query || vectors.has(query)) continue
    const left = deadline - Date.now()
    if (left <= 0) break
    const found = await semanticFor(deps, query, Math.min(timeoutMs ?? left, left))
    if (found) vectors.set(query, found.vector)
  }
  return { model: embedder.model, vectors }
}

// 事务里用的嵌入来源：只查这张表。查不到时抛错，现有的回退（embedQuery 接住，只走全文与关键词）照常生效
function vectorTableSource(table: QueryVectors, run: RollbackRun): EmbedderSource {
  const embedder: Embedder | null =
    table.model === null
      ? null
      : {
          model: table.model,
          embed: async (texts) =>
            texts.map((text) => {
              const vector = table.vectors.get(text)
              if (!vector) {
                run.noteVectorMissed()
                throw new Error('这个查询的向量没有事先算好')
              }
              return vector
            }),
        }
  return { get: async () => embedder, next: async () => null, invalidate() {} }
}
