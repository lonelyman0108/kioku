import type { Db } from '../db/client'
import { embeddingCoverage } from './coverage'
import { clearEmbeddingError, recordEmbeddingError } from './errors'
import { loadEmbeddingModels, switchEmbedding } from './settings'
import type { EmbedderSource } from './source'
import { backfillEmbeddings, embedMemory, pruneEmbeddings } from './worker'

// 向量相关的后台任务本身，由任务队列调用。出错时记下来给实例设置页看，再抛出交给队列处理

// 写回时正被别的事务锁着而跳过的记忆，稍后逐条重试
export type Retry = (spaceId: string, ids: string[]) => void

async function recording<T>(db: Db, model: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    await recordEmbeddingError(db, model, (err as Error).message).catch(() => {})
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

// 一条记忆写入之后生成向量。换模型期间两个模型都生成，不然新模型永远补不齐
export async function embedJob(
  db: Db,
  source: EmbedderSource,
  spaceId: string,
  memoryId: string,
  retry: Retry,
): Promise<void> {
  const [active, next] = await Promise.all([source.get(), source.next()])
  for (const embedder of [active, next]) {
    if (!embedder) continue
    const written = await recording(db, embedder.model, () =>
      embedMemory(db, embedder, spaceId, memoryId, { onSkipped: (ids) => retry(spaceId, ids) }),
    )
    if (written) await clearEmbeddingError(db, embedder.model)
  }
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
    await recordEmbeddingError(db, target.model, (err as Error).message).catch(() => {})
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
