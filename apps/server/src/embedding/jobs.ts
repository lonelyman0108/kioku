import type { Db } from '../db/client'
import { embeddingCoverage } from './coverage'
import { clearEmbeddingError, recordEmbeddingError } from './errors'
import { loadEmbeddingModels, switchEmbedding } from './settings'
import type { EmbedderSource } from './source'
import { backfillEmbeddings, embedMemories, EmbedUnavailable, pruneEmbeddings } from './worker'

// 向量相关的后台任务本身，由任务队列调用。出错时记下来给实例设置页看（记下与清掉本身出错只记日志，见 errors.ts），
// 再交给队列处理：写入之后的向量任务逐项返回失败的，别的直接抛出

// 写回时正被别的事务锁着、这次没处理的记忆另排一个新任务，稍后逐条再来。返回没排进去（入队失败）的那几条
export type Retry = (spaceId: string, ids: string[]) => Promise<string[]>

async function recording<T>(db: Db, model: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    await recordEmbeddingError(db, model, (err as Error).message)
    throw err
  }
}

// 接口只拒绝了个别记忆时，跳过它们、补完别的，最后把原因记下来
function failureLog() {
  let count = 0
  let last = ''
  return {
    onFailed: (_id: string, message: string) => {
      count++
      last = message
    },
    get count() {
      return count
    },
    message: () => `有 ${count} 条记忆生成不了向量，最近一条的原因：${last}`,
  }
}

// 一条写入之后要生成向量的记忆
export interface EmbedTarget {
  spaceId: string
  memoryId: string
}

export interface EmbedJobsSignals {
  // 这一批的处理时间
  budget?: AbortSignal | undefined
  // pg-boss 给这一批每个任务的中止信号（服务要停、任务过期时断开）。全都断开才停下：只有一个任务的断开不该让整批停下
  jobs?: AbortSignal[] | undefined
}

// 这些信号全都断开时才断开。用完调用 release，拿掉加在各个信号上的监听
function allAborted(signals: AbortSignal[]): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController()
  let left = signals.length
  const one = () => {
    if (--left === 0) controller.abort()
  }
  for (const s of signals) {
    if (s.aborted) one()
    else s.addEventListener('abort', one, { once: true })
  }
  return {
    signal: controller.signal,
    release: () => {
      for (const s of signals) s.removeEventListener('abort', one)
    },
  }
}

// 记忆写入之后生成向量，一次处理一批：同一个空间的一起读、合起来请求嵌入接口（每次最多 EMBED_BATCH 条）、一起写回。
// 换模型期间两个模型都生成，不然新模型永远补不齐；一个模型出错不挡另一个。
// 返回生成失败的是第几项（targets 的下标）与原因，调用方逐项交给队列按任务的重试次数（有退避）再试：
// 逐条再试时失败的只算那几条，别的照常写；一个空间接口不可用时（最短的几条都失败）算这个空间里还没写好的，
// 写库出错算这个空间的全部。处理时间用完了，还没生成的不再请求、算失败，已经拿到的照常写回，并记下这一批没做完。
// 服务要停时（pg-boss 在中止信号之前已经把这些任务记成失败、会重试）同样停下，但不记也不清错误、不另排新任务。
// 写回时正被别的事务锁着的，按记忆去重后交给 retry 另排一个新任务、原任务算完成（这一批里别的模型记下的失败也去掉）；
// 没排进去的算失败
export async function embedJobs(
  db: Db,
  source: EmbedderSource,
  targets: EmbedTarget[],
  retry: Retry,
  { budget, jobs }: EmbedJobsSignals = {},
): Promise<Map<number, Error>> {
  const stopping = jobs?.length ? allAborted(jobs) : undefined
  try {
    return await embedTargets(db, source, targets, retry, budget, stopping?.signal)
  } finally {
    // 这一批做完就拿掉加在各个任务信号上的监听，不留下闭包
    stopping?.release()
  }
}

async function embedTargets(
  db: Db,
  source: EmbedderSource,
  targets: EmbedTarget[],
  retry: Retry,
  budget: AbortSignal | undefined,
  stopping: AbortSignal | undefined,
): Promise<Map<number, Error>> {
  // 空间 → 记忆 → 要它的是哪几项（同一条记忆连着改了几次，会有几项）
  const groups = new Map<string, Map<string, number[]>>()
  targets.forEach((target, index) => {
    const items = groups.get(target.spaceId) ?? new Map<string, number[]>()
    items.set(target.memoryId, [...(items.get(target.memoryId) ?? []), index])
    groups.set(target.spaceId, items)
  })
  const failed = new Map<number, Error>()
  const indexes = (spaceId: string, memoryIds: Iterable<string>) =>
    [...memoryIds].flatMap((memoryId) => groups.get(spaceId)?.get(memoryId) ?? [])
  const fail = (spaceId: string, memoryIds: Iterable<string>, error: Error) => {
    for (const index of indexes(spaceId, memoryIds)) failed.set(index, error)
  }
  // 写回时被锁着、要另排一个新任务的记忆，按空间
  const later = new Map<string, Set<string>>()
  const postpone = (spaceId: string, memoryIds: Iterable<string>) => {
    const set = later.get(spaceId) ?? new Set<string>()
    for (const id of memoryIds) set.add(id)
    later.set(spaceId, set)
  }
  const signals = [budget, stopping].filter((s): s is AbortSignal => s !== undefined)
  const signal = signals.length ? AbortSignal.any(signals) : undefined
  // 没做完的记成哪种失败
  const unfinished = () =>
    new Error(stopping?.aborted ? '服务要停了，这一批没做完' : '这一批没在时间内做完，交给重试')

  const [active, next] = await Promise.all([source.get(), source.next()])
  for (const embedder of [active, next]) {
    if (!embedder) continue
    const failures = failureLog()
    let broken: Error | null = null
    let deferred = 0
    let written = 0
    for (const [spaceId, items] of groups) {
      if (signal?.aborted) {
        deferred += items.size
        fail(spaceId, items.keys(), unfinished())
        continue
      }
      try {
        written += await embedMemories(db, embedder, spaceId, [...items.keys()], {
          signal,
          onSkipped: (ids) => postpone(spaceId, ids),
          onFailed: (memoryId, message) => {
            failures.onFailed(memoryId, message)
            fail(spaceId, [memoryId], new Error(message))
          },
          onDeferred: (ids) => {
            deferred += ids.length
            fail(spaceId, ids, unfinished())
          },
        })
      } catch (err) {
        broken = err as Error
        // 接口不可用：已经写好的那几条算完成，只有还没生成的算失败
        fail(spaceId, err instanceof EmbedUnavailable ? err.unfinished : items.keys(), broken)
      }
    }
    // 服务要停时一律不记也不清：没做完的任务 pg-boss 已经记成失败、会重试，到时再记
    if (stopping?.aborted) continue
    // 记下这个模型这一批出的错给管理员看；都成功、写下了向量时清掉之前记下的
    if (broken) {
      await recordEmbeddingError(db, embedder.model, broken.message)
    } else if (failures.count) {
      await recordEmbeddingError(db, embedder.model, failures.message())
    } else if (deferred) {
      const message = `这一批没在时间内做完：有 ${deferred} 条还没生成向量，交给重试；嵌入接口可能太慢`
      await recordEmbeddingError(db, embedder.model, message)
    } else if (written) {
      await clearEmbeddingError(db, embedder.model)
    }
  }
  // 被锁着的另排新任务，等它排进去。排上了的原任务算完成：新任务两个模型都会再做一遍，这一批里别的模型记下的失败
  // （接口拒绝、时间用完）也去掉，不然既另排又重试；没排上的算失败。
  // 服务要停时不另排：这些任务 pg-boss 已经记成失败、会重试
  for (const [spaceId, ids] of later) {
    if (stopping?.aborted) {
      fail(spaceId, ids, unfinished())
      continue
    }
    const lost = new Set(await retry(spaceId, [...ids]))
    const queued = [...ids].filter((id) => !lost.has(id))
    for (const index of indexes(spaceId, queued)) failed.delete(index)
    fail(spaceId, lost, new Error('写回时被锁着，另排的新任务没排进去，交给重试'))
  }
  return failed
}

// 补齐正在用的模型的向量；没配置时返回 null
export async function backfillJob(
  db: Db,
  source: EmbedderSource,
  retry: Retry,
): Promise<number | null> {
  const active = await source.get()
  if (!active) return null
  const failures = failureLog()
  let lost = 0
  const total = await recording(db, active.model, () =>
    backfillEmbeddings(db, active, {
      // 被锁着的另排新任务，等它排进去；没排上的记下来，等下一次补齐
      onSkipped: async (spaceId, ids) => {
        lost += (await retry(spaceId, ids)).length
      },
      onFailed: failures.onFailed,
    }),
  )
  const problems: string[] = []
  if (failures.count) problems.push(failures.message())
  if (lost) problems.push(`有 ${lost} 条记忆写回时被锁着，另排的新任务没排进去，等下一次补齐`)
  if (problems.length) await recordEmbeddingError(db, active.model, problems.join('；'))
  else await clearEmbeddingError(db, active.model)
  return total
}

// idle：没在换模型；switched：补齐了、已经切过去（旧模型的向量该清了）；
// cancelled：补的时候被放弃或换成了别的模型，停下了（这期间写下的向量该清了）；
// changed：还是这个模型，但渠道改了，停下来让新排的任务用新的渠道接着补；
// again：还有缺的，但这一遍有进展（补上了一些，或者有被锁着跳过、另排的新任务已经排上的），过一会儿再补；
// stuck：补了一遍一条都没补上，也没有在等的，隔久一点再试
export type SwitchOutcome = 'idle' | 'switched' | 'cancelled' | 'changed' | 'again' | 'stuck'

// 补齐新模型的向量，召回在这期间一直用旧模型；补齐了就切过去。整个过程出的错都记下来给管理员看
export async function switchJob(
  db: Db,
  source: EmbedderSource,
  retry: Retry,
): Promise<SwitchOutcome> {
  const target = (await loadEmbeddingModels(db)).next
  if (!target) return 'idle'
  const snapshot = JSON.stringify(target)
  try {
    const next = await source.next()
    if (next?.model !== target.model) return 'changed'
    // 每补一页之前看一眼设置：被放弃、换成了别的模型或者渠道改了，就停下，不再用拿到手的渠道请求
    const unchanged = async () => JSON.stringify((await loadEmbeddingModels(db)).next) === snapshot
    let requeued = 0
    const failures = failureLog()
    const written = await backfillEmbeddings(db, next, {
      // 被锁着的另排新任务，等它排进去；排上了才算有进展，没排上的等下一遍补
      onSkipped: async (spaceId, ids) => {
        requeued += ids.length - (await retry(spaceId, ids)).length
      },
      onFailed: failures.onFailed,
      shouldContinue: unchanged,
    })
    if (!(await unchanged())) {
      const now = (await loadEmbeddingModels(db)).next
      return now?.model === target.model ? 'changed' : 'cancelled'
    }
    const { eligible, embedded } = await embeddingCoverage(db, [target.model])
    const done = embedded.get(target.model) ?? 0
    if (done >= eligible) {
      const previous = await switchEmbedding(db, target.model)
      // 刚好在这时被放弃或换成了别的模型：这次不切
      if (previous === null) return 'cancelled'
      source.invalidate()
      await clearEmbeddingError(db, target.model)
      console.log(`嵌入模型已从 ${previous} 换成 ${target.model}`)
      return 'switched'
    }
    if (failures.count) {
      await recordEmbeddingError(db, target.model, failures.message())
    } else if (written) {
      await clearEmbeddingError(db, target.model)
    }
    if (written || requeued) return 'again'
    if (!failures.count) {
      await recordEmbeddingError(
        db,
        target.model,
        `还有 ${eligible - done} 条记忆没有新模型的向量，补了一遍也没补上；过一会儿会再试，也可以现在就切换`,
      )
    }
    return 'stuck'
  } catch (err) {
    await recordEmbeddingError(db, target.model, (err as Error).message)
    throw err
  }
}

// 删掉既不是正在用、也不是正在换过去的模型的向量。按库里的设置算，不用缓存：刚切换或放弃之后缓存可能还是旧的
export async function pruneJob(db: Db): Promise<number> {
  const stored = await loadEmbeddingModels(db)
  return pruneEmbeddings(
    db,
    [stored.active, stored.next].flatMap((s) => (s ? [s.model] : [])),
  )
}
