import type { Db } from '../db/client'
import { embeddingCoverage } from './coverage'
import { clearEmbeddingError, recordEmbeddingError } from './errors'
import { loadEmbeddingModels, switchEmbedding } from './settings'
import type { EmbedderSource } from './source'
import { backfillEmbeddings, embedMemory, pruneEmbeddings } from './worker'

// 向量相关的后台任务本身，由任务队列调用。出错时记下来给实例设置页看，再抛出交给队列重试

// 写回时正被别的事务锁着而跳过的记忆，稍后逐条重试
export type Retry = (spaceId: string, ids: string[]) => void

// 正在用的与正在换过去的模型；两个模型的向量都要留着
async function models(source: EmbedderSource) {
  const [active, next] = await Promise.all([source.get(), source.next()])
  return { active, next, keep: [active, next].flatMap((e) => (e ? [e.model] : [])) }
}

async function recording<T>(db: Db, model: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    await recordEmbeddingError(db, model, (err as Error).message).catch(() => {})
    throw err
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
  const { active, next, keep } = await models(source)
  for (const embedder of [active, next]) {
    if (!embedder) continue
    const written = await recording(db, embedder.model, () =>
      embedMemory(db, embedder, spaceId, memoryId, (ids) => retry(spaceId, ids), keep),
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
  const { active, keep } = await models(source)
  if (!active) return null
  const total = await recording(db, active.model, () => backfillEmbeddings(db, active, retry, keep))
  await clearEmbeddingError(db, active.model)
  return total
}

// idle：没在换模型；switched：补齐了、已经切过去（旧模型的向量该清了）；
// again：补了一些但还有缺的（期间新写入的、被锁着跳过的），过一会儿再补一遍；stuck：补了一遍一条都没补上
export type SwitchOutcome = 'idle' | 'switched' | 'again' | 'stuck'

// 补齐新模型的向量，召回在这期间一直用旧模型；补齐了就切过去
export async function switchJob(
  db: Db,
  source: EmbedderSource,
  retry: Retry,
): Promise<SwitchOutcome> {
  const { next, keep } = await models(source)
  if (!next) return 'idle'
  const written = await recording(db, next.model, () => backfillEmbeddings(db, next, retry, keep))
  const { eligible, embedded } = await embeddingCoverage(db, [next.model])
  const done = embedded.get(next.model) ?? 0
  if (done >= eligible) {
    const previous = await switchEmbedding(db, next.model)
    // 期间被放弃或换成了别的模型：这次不切
    if (previous === null) return 'idle'
    source.invalidate()
    await clearEmbeddingError(db, next.model)
    console.log(`嵌入模型已从 ${previous} 换成 ${next.model}`)
    return 'switched'
  }
  if (written) {
    await clearEmbeddingError(db, next.model)
    return 'again'
  }
  // 停下来，等管理员重试或直接切换，不一直空转
  await recordEmbeddingError(
    db,
    next.model,
    `还有 ${eligible - done} 条记忆没有新模型的向量，补了一遍也没补上；可以稍后重试，或者现在就切换`,
  )
  return 'stuck'
}

// 删掉既不是正在用、也不是正在换过去的模型的向量。按库里的设置算，不用缓存：刚切换或放弃之后缓存可能还是旧的
export async function pruneJob(db: Db): Promise<number> {
  const stored = await loadEmbeddingModels(db)
  return pruneEmbeddings(
    db,
    [stored.active, stored.next].flatMap((s) => (s ? [s.model] : [])),
  )
}
