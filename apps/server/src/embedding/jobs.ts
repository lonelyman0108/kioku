import { errorText, type Db } from '../db/client'
import { embeddingNextSnapshot } from '../models/store'
import { embeddingCoverage } from './coverage'
import { clearEmbeddingError, recordEmbeddingError } from './errors'
import { loadEmbeddingModels, switchEmbedding } from './settings'
import type { EmbedderSource } from './source'
import { backfillEmbeddings, embedEntries, EmbedUnavailable, pruneEmbeddings } from './worker'

export type Retry = (circleId: string, entryIds: string[]) => Promise<string[]>

async function recording<T>(db: Db, model: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    await recordEmbeddingError(db, model, errorText(err))
    throw err
  }
}

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
    message: () => `${count} 条词条无法生成向量，最近一条的原因：${last}`,
  }
}

export interface EmbedTarget {
  circleId: string
  entryId: string
}

export interface EmbedJobsSignals {
  budget?: AbortSignal | undefined
  jobs?: AbortSignal[] | undefined
}

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
  const groups = new Map<string, Map<string, number[]>>()
  targets.forEach((target, index) => {
    const items = groups.get(target.circleId) ?? new Map<string, number[]>()
    items.set(target.entryId, [...(items.get(target.entryId) ?? []), index])
    groups.set(target.circleId, items)
  })
  const failed = new Map<number, Error>()
  const indexes = (circleId: string, entryIds: Iterable<string>) =>
    [...entryIds].flatMap((entryId) => groups.get(circleId)?.get(entryId) ?? [])
  const fail = (circleId: string, entryIds: Iterable<string>, error: Error) => {
    for (const index of indexes(circleId, entryIds)) failed.set(index, error)
  }
  const later = new Map<string, Set<string>>()
  const postpone = (circleId: string, entryIds: Iterable<string>) => {
    const set = later.get(circleId) ?? new Set<string>()
    for (const id of entryIds) set.add(id)
    later.set(circleId, set)
  }
  const signals = [budget, stopping].filter((s): s is AbortSignal => s !== undefined)
  const signal = signals.length ? AbortSignal.any(signals) : undefined
  const unfinished = () =>
    new Error(stopping?.aborted ? '服务正在停止，这一批未完成' : '这一批未在时限内完成，将重试')

  const [active, next] = await Promise.all([source.get(), source.next()])
  for (const embedder of [active, next]) {
    if (!embedder) continue
    const failures = failureLog()
    let broken: Error | null = null
    let deferred = 0
    let written = 0
    for (const [circleId, items] of groups) {
      if (signal?.aborted) {
        deferred += items.size
        fail(circleId, items.keys(), unfinished())
        continue
      }
      try {
        written += await embedEntries(db, embedder, circleId, [...items.keys()], {
          signal,
          onSkipped: (ids) => postpone(circleId, ids),
          onFailed: (entryId, message) => {
            failures.onFailed(entryId, message)
            fail(circleId, [entryId], new Error(message))
          },
          onDeferred: (ids) => {
            deferred += ids.length
            fail(circleId, ids, unfinished())
          },
        })
      } catch (err) {
        broken = err as Error
        fail(circleId, err instanceof EmbedUnavailable ? err.unfinished : items.keys(), broken)
      }
    }
    if (stopping?.aborted) continue
    if (broken) {
      await recordEmbeddingError(db, embedder.model, errorText(broken))
    } else if (failures.count) {
      await recordEmbeddingError(db, embedder.model, failures.message())
    } else if (deferred) {
      const message = `这一批未在时限内完成：${deferred} 条尚未生成向量，将重试；嵌入接口可能过慢`
      await recordEmbeddingError(db, embedder.model, message)
    } else if (written) {
      await clearEmbeddingError(db, embedder.model)
    }
  }

  for (const [circleId, ids] of later) {
    if (stopping?.aborted) {
      fail(circleId, ids, unfinished())
      continue
    }
    const lost = new Set(await retry(circleId, [...ids]))
    const queued = [...ids].filter((id) => !lost.has(id))
    for (const index of indexes(circleId, queued)) failed.delete(index)
    fail(circleId, lost, new Error('写回时遇到锁，新任务未能入队，将重试'))
  }
  return failed
}

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
      onSkipped: async (circleId, ids) => {
        lost += (await retry(circleId, ids)).length
      },
      onFailed: failures.onFailed,
    }),
  )
  const problems: string[] = []
  if (failures.count) problems.push(failures.message())
  if (lost) problems.push(`${lost} 条词条写回时遇到锁，新任务未能入队，将在下次补齐`)
  if (problems.length) await recordEmbeddingError(db, active.model, problems.join('；'))
  else await clearEmbeddingError(db, active.model)
  return total
}

export type SwitchOutcome = 'idle' | 'switched' | 'cancelled' | 'changed' | 'again' | 'stuck'

export async function switchJob(
  db: Db,
  source: EmbedderSource,
  retry: Retry,
): Promise<SwitchOutcome> {
  const target = (await loadEmbeddingModels(db)).next
  if (!target) return 'idle'
  const snapshot = await embeddingNextSnapshot(db)
  if (!snapshot) return 'idle'
  try {
    const next = await source.next()
    if (next?.model !== target.model) return 'changed'
    const unchanged = async () => (await embeddingNextSnapshot(db)) === snapshot
    let requeued = 0
    const failures = failureLog()
    const written = await backfillEmbeddings(db, next, {
      onSkipped: async (circleId, ids) => {
        requeued += ids.length - (await retry(circleId, ids)).length
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
        `仍有 ${eligible - done} 个切片缺少新模型的向量，补齐未成功；稍后将重试，也可以立即切换`,
      )
    }
    return 'stuck'
  } catch (err) {
    await recordEmbeddingError(db, target.model, errorText(err))
    throw err
  }
}

export async function pruneJob(db: Db): Promise<number> {
  const stored = await loadEmbeddingModels(db)
  return pruneEmbeddings(
    db,
    [stored.active, stored.next].flatMap((s) => (s ? [s.model] : [])),
  )
}
