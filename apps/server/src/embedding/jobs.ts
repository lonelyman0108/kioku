import type { Db } from '../db/client'
import { embeddingCoverage } from './coverage'
import { clearEmbeddingError, recordEmbeddingError } from './errors'
import { loadEmbeddingModels, switchEmbedding } from './settings'
import type { EmbedderSource } from './source'
import { backfillEmbeddings, embedMemories, pruneEmbeddings, type EmbedRun } from './worker'

// 向量相关的后台任务本身，由任务队列调用。出错时记下来给实例设置页看（记下与清掉本身出错只记日志，见 errors.ts），
// 再交给队列处理：写入之后的向量任务逐项返回失败的，别的直接抛出

// 这次没处理、要另排一个新任务的记忆（写回时被别的事务锁着的，处理时间用完了还没生成的），稍后逐条再来
export type Retry = (spaceId: string, ids: string[]) => void

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
  // 服务要停了（pg-boss 给任务的中止信号，任务过期时也会断开）
  stopping?: AbortSignal | undefined
}

// 记忆写入之后生成向量，一次处理一批：同一个空间的一起读、合起来请求嵌入接口（每次最多 EMBED_BATCH 条）、一起写回。
// 换模型期间两个模型都生成，不然新模型永远补不齐；一个模型出错不挡另一个。
// 返回生成失败的是第几项（targets 的下标）与原因，调用方逐项交给队列重试：接口拒绝了其中几条时（例如正文超过模型的
// 长度上限）只算那几条，别的照常写；一个空间整批出错时（接口不可用、写库出错）算这个空间的全部。
// 处理时间用完了、服务要停时，还没生成的不再请求，已经拿到的照常写回。没生成的与写回时被别的事务锁着的一样：
// 按记忆去重后交给 retry 另排一个新任务，原任务算完成，不耗它的重试次数（不然接口一直慢时，重试用完就再也没有向量）。
// 服务要停时不记错误：那不是接口的问题
export async function embedJobs(
  db: Db,
  source: EmbedderSource,
  targets: EmbedTarget[],
  retry: Retry,
  { budget, stopping }: EmbedJobsSignals = {},
): Promise<Map<number, Error>> {
  // 空间 → 记忆 → 要它的是哪几项（同一条记忆连着改了几次，会有几项）
  const groups = new Map<string, Map<string, number[]>>()
  targets.forEach((target, index) => {
    const items = groups.get(target.spaceId) ?? new Map<string, number[]>()
    items.set(target.memoryId, [...(items.get(target.memoryId) ?? []), index])
    groups.set(target.spaceId, items)
  })
  const failed = new Map<number, Error>()
  const fail = (spaceId: string, memoryIds: Iterable<string>, error: Error) => {
    for (const memoryId of memoryIds) {
      for (const index of groups.get(spaceId)?.get(memoryId) ?? []) failed.set(index, error)
    }
  }
  // 要另排一个新任务的记忆，按空间
  const later = new Map<string, Set<string>>()
  const postpone = (spaceId: string, memoryIds: Iterable<string>) => {
    const set = later.get(spaceId) ?? new Set<string>()
    for (const id of memoryIds) set.add(id)
    later.set(spaceId, set)
  }
  const signals = [budget, stopping].filter((s): s is AbortSignal => s !== undefined)
  const signal = signals.length ? AbortSignal.any(signals) : undefined

  const [active, next] = await Promise.all([source.get(), source.next()])
  for (const embedder of [active, next]) {
    if (!embedder) continue
    // 这一批里这个模型的接口有没有接受过文本，几个空间共用
    const run: EmbedRun = { accepted: false }
    const failures = failureLog()
    let broken: Error | null = null
    let deferred = 0
    let written = 0
    for (const [spaceId, items] of groups) {
      if (signal?.aborted) {
        deferred += items.size
        postpone(spaceId, items.keys())
        continue
      }
      try {
        written += await embedMemories(db, embedder, spaceId, [...items.keys()], {
          signal,
          run,
          onSkipped: (ids) => postpone(spaceId, ids),
          onFailed: (memoryId, message) => {
            failures.onFailed(memoryId, message)
            fail(spaceId, [memoryId], new Error(message))
          },
          onDeferred: (ids) => {
            deferred += ids.length
            postpone(spaceId, ids)
          },
        })
      } catch (err) {
        broken = err as Error
        fail(spaceId, items.keys(), broken)
      }
    }
    // 记下这个模型这一批出的错给管理员看；都成功、写下了向量时清掉之前记下的。服务要停而没做完的不记也不清
    if (broken) {
      await recordEmbeddingError(db, embedder.model, broken.message)
    } else if (failures.count) {
      await recordEmbeddingError(db, embedder.model, failures.message())
    } else if (deferred) {
      if (!stopping?.aborted) {
        const message = `这一批的处理时间用完了，有 ${deferred} 条还没生成向量，已另排；嵌入接口可能太慢`
        await recordEmbeddingError(db, embedder.model, message)
      }
    } else if (written) {
      await clearEmbeddingError(db, embedder.model)
    }
  }
  // 另排了新任务的，原任务算完成
  for (const [spaceId, ids] of later) {
    for (const memoryId of ids) {
      for (const index of groups.get(spaceId)?.get(memoryId) ?? []) failed.delete(index)
    }
    retry(spaceId, [...ids])
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
  const total = await recording(db, active.model, () =>
    backfillEmbeddings(db, active, { onSkipped: retry, onFailed: failures.onFailed }),
  )
  if (failures.count) await recordEmbeddingError(db, active.model, failures.message())
  else await clearEmbeddingError(db, active.model)
  return total
}

// idle：没在换模型；switched：补齐了、已经切过去（旧模型的向量该清了）；
// cancelled：补的时候被放弃或换成了别的模型，停下了（这期间写下的向量该清了）；
// changed：还是这个模型，但渠道改了，停下来让新排的任务用新的渠道接着补；
// again：还有缺的，但这一遍有进展（补上了一些，或者有被锁着跳过、已经排了重试的），过一会儿再补；
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
    let skipped = 0
    const failures = failureLog()
    const written = await backfillEmbeddings(db, next, {
      onSkipped: (spaceId, ids) => {
        skipped += ids.length
        retry(spaceId, ids)
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
    if (written || skipped) return 'again'
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
