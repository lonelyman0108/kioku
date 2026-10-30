import { and, asc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm'

import { withSpace, type Db, type Tx } from '../db/client'
import { memories, memoryEmbeddings, memoryGlossary, spaces } from '../db/schema'
import { formatUri } from '../memory/uri'
import type { Embedder } from './provider'
import { lockEmbeddingModels } from './settings'
import { embeddingText, textHash } from './text'

// 一次请求嵌入接口最多带这么多条文本
export const EMBED_BATCH = 32
const PAGE = EMBED_BATCH * 4
// 整批失败后逐条再试时，开头连着这么多条（批次更小时是整批）都失败、一条都没成功，就当作接口不可用，不再一条条请求
const GIVE_UP_AFTER = 3

// 判断记忆有没有被改过用 PostgreSQL 的 xmin（最后一次修改这一行的事务号）：每次 UPDATE 都会变，
// 不像 updated_at 依赖应用写入的时间戳（只有毫秒精度，同一毫秒内的两次修改分不出来）
const stamp = sql<string>`memories.xmin::text`

export interface SyncHooks {
  // 写回时正被别的事务锁着、这次没处理的记忆，交给调用方稍后重试
  onSkipped?: ((ids: string[]) => void) | undefined
  // 接口只拒绝了这一条（例如正文超过模型的长度上限）：跳过它，别的照常写
  onFailed?: ((memoryId: string, message: string) => void) | undefined
}

// 还要留着向量的模型：写回时按设置里正在用的与正在换过去的算（锁住设置到写完），不用任务开始时的：
// 期间换模型被放弃、已经切走或换成了别的，旧的判断会写下没人用的向量，或者删掉新模型刚写的。
// 还没配置嵌入模型时（命令行工具、测试直接给模型）只认这次写的模型
async function keptModels(tx: Tx, embedder: Embedder): Promise<string[]> {
  const { active, next } = await lockEmbeddingModels(tx)
  const kept = [active, next].flatMap((s) => (s ? [s.model] : []))
  return kept.length ? kept : [embedder.model]
}

// 一批文本的向量。整批失败时逐条再试：开头几条都失败多半是接口不可用，照常报错；
// 只有个别失败的告诉调用方、跳过，一条坏的不拦住别的
async function embedBatch(
  embedder: Embedder,
  batch: { id: string; text: string }[],
  onFailed: SyncHooks['onFailed'],
): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>()
  try {
    const out = await embedder.embed(batch.map((p) => p.text))
    batch.forEach((p, j) => vectors.set(p.id, out[j]!))
    return vectors
  } catch (err) {
    if (batch.length === 1) throw err
  }
  let failures = 0
  for (const item of batch) {
    try {
      const [vector] = await embedder.embed([item.text])
      vectors.set(item.id, vector!)
    } catch (err) {
      if (!vectors.size && ++failures >= Math.min(GIVE_UP_AFTER, batch.length)) throw err
      onFailed?.(item.id, (err as Error).message)
    }
  }
  return vectors
}

// 为一批记忆生成或刷新这个模型的向量；已删除、secret、没有正文的记忆删掉向量。嵌入文本没变就跳过。
// 分三步：短事务读出要处理的内容 → 事务外请求嵌入接口 → 短事务写回。
// 请求外部接口时不占着数据库连接和事务；写回前锁住这些行并核对 xmin，期间被改过的不写回，
// 交给那次修改触发的任务处理，避免旧内容的向量覆盖新状态（例如刚改成 secret 的记忆又被写上明文向量）。
// 这些记忆别的模型的向量（不再留着的）顺手删掉
async function syncRows(
  db: Db,
  embedder: Embedder,
  spaceId: string,
  ids: string[],
  hooks: SyncHooks,
): Promise<number> {
  if (!ids.length) return 0

  const { stale, pending, readAt } = await withSpace(db, spaceId, async (tx) => {
    const rows = await tx
      .select({ row: memories, stamp })
      .from(memories)
      .where(inArray(memories.id, ids))
    const glossaryRows = await tx
      .select()
      .from(memoryGlossary)
      .where(inArray(memoryGlossary.memoryId, ids))
    const existing = await tx
      .select({ memoryId: memoryEmbeddings.memoryId, contentHash: memoryEmbeddings.contentHash })
      .from(memoryEmbeddings)
      .where(
        and(inArray(memoryEmbeddings.memoryId, ids), eq(memoryEmbeddings.model, embedder.model)),
      )
    const hashes = new Map(existing.map((e) => [e.memoryId, e.contentHash]))
    const stale: string[] = []
    const pending: { id: string; text: string; hash: string }[] = []
    for (const { row } of rows) {
      if (
        row.deletedAt ||
        row.sensitivity === 'secret' ||
        !row.content ||
        !row.domain ||
        !row.path
      ) {
        // 只有确实有向量的才需要删，没有的不必为它锁行
        if (hashes.has(row.id)) stale.push(row.id)
        continue
      }
      const text = embeddingText({
        uri: formatUri(row.domain, row.path),
        disclosure: row.disclosure,
        glossary: glossaryRows
          .filter((g) => g.memoryId === row.id)
          .map((g) => g.keyword)
          .sort(),
        content: row.content,
      })
      const hash = textHash(embedder.model, text)
      if (hashes.get(row.id) !== hash) pending.push({ id: row.id, text, hash })
    }
    return { stale, pending, readAt: new Map(rows.map((r) => [r.row.id, r.stamp])) }
  })

  const cleanupOtherModels = (keep: string[]) =>
    and(inArray(memoryEmbeddings.memoryId, ids), notInArray(memoryEmbeddings.model, keep))
  // 没有要写的也没有要删的，就不必锁行；只剩换模型后的旧向量清理
  if (!pending.length && !stale.length) {
    await withSpace(db, spaceId, async (tx) =>
      tx.delete(memoryEmbeddings).where(cleanupOtherModels(await keptModels(tx, embedder))),
    )
    return 0
  }

  const vectors = new Map<string, number[]>()
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const out = await embedBatch(embedder, pending.slice(i, i + EMBED_BATCH), hooks.onFailed)
    for (const [id, vector] of out) vectors.set(id, vector)
  }

  const { written, skipped } = await withSpace(db, spaceId, async (tx) => {
    // 这个模型已经不用了（换模型被放弃、已经切走）就不写它的向量，只做清理
    const keep = await keptModels(tx, embedder)
    // 正被别的事务锁着的行跳过，不等它：移动记忆、让出 URI 会按自己的顺序锁多行，
    // 在这里等锁可能和它们互相等待成死锁。那些行如果被改了，修改本身会再触发向量任务；
    // 没改的由调用方稍后重试
    const current = await tx
      .select({ id: memories.id, stamp })
      .from(memories)
      .where(inArray(memories.id, ids))
      .for('update', { skipLocked: true })
    const locked = new Set(current.map((c) => c.id))
    const skipped = [...stale, ...pending.map((p) => p.id)].filter((id) => !locked.has(id))
    const unchanged = new Set(current.filter((c) => c.stamp === readAt.get(c.id)).map((c) => c.id))
    const staleNow = stale.filter((id) => unchanged.has(id))
    if (staleNow.length) {
      await tx.delete(memoryEmbeddings).where(inArray(memoryEmbeddings.memoryId, staleNow))
    }
    const writes = keep.includes(embedder.model)
      ? pending
          .filter((item) => unchanged.has(item.id) && vectors.has(item.id))
          .map((item) => ({ item, vector: vectors.get(item.id)! }))
      : []
    if (writes.length) {
      // 一条多行 upsert 写完，缩短锁住这些行的时间
      await tx
        .insert(memoryEmbeddings)
        .values(
          writes.map(({ item, vector }) => ({
            spaceId,
            memoryId: item.id,
            model: embedder.model,
            contentHash: item.hash,
            embedding: vector,
          })),
        )
        .onConflictDoUpdate({
          target: [memoryEmbeddings.memoryId, memoryEmbeddings.model],
          set: {
            contentHash: sql`excluded.content_hash`,
            embedding: sql`excluded.embedding`,
            updatedAt: new Date(),
          },
        })
    }
    // 换过模型后，旧模型的向量不再参与检索，顺手清掉
    await tx.delete(memoryEmbeddings).where(cleanupOtherModels(keep))
    return { written: writes.length, skipped }
  })
  if (skipped.length) hooks.onSkipped?.(skipped)
  return written
}

export async function embedMemory(
  db: Db,
  embedder: Embedder,
  spaceId: string,
  memoryId: string,
  hooks: SyncHooks = {},
): Promise<number> {
  return syncRows(db, embedder, spaceId, [memoryId], hooks)
}

// 同一个空间的几条记忆一起处理：一起读、合起来请求嵌入接口、一起写回。返回写下了几条向量
export async function embedMemories(
  db: Db,
  embedder: Embedder,
  spaceId: string,
  memoryIds: string[],
  hooks: SyncHooks = {},
): Promise<number> {
  return syncRows(db, embedder, spaceId, [...new Set(memoryIds)], hooks)
}

export interface BackfillOptions {
  onSkipped?: (spaceId: string, ids: string[]) => void
  onFailed?: SyncHooks['onFailed']
  // 每补一页之前问一次，返回 false 就停下（例如换模型被放弃了，不再请求它的接口）
  shouldContinue?: () => Promise<boolean>
}

// 全量补齐：逐个空间、按 id 分页检查所有记忆，用于首次配置或换模型
export async function backfillEmbeddings(
  db: Db,
  embedder: Embedder,
  options: BackfillOptions = {},
): Promise<number> {
  const { onSkipped, onFailed, shouldContinue } = options
  let total = 0
  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    let after: string | null = null
    for (;;) {
      if (shouldContinue && !(await shouldContinue())) return total
      const cursor: string | null = after
      const page: { id: string }[] = await withSpace(db, spaceId, (tx) =>
        tx
          .select({ id: memories.id })
          .from(memories)
          .where(and(isNull(memories.deletedAt), cursor ? gt(memories.id, cursor) : undefined))
          .orderBy(asc(memories.id))
          .limit(PAGE),
      )
      if (!page.length) break
      total += await syncRows(
        db,
        embedder,
        spaceId,
        page.map((r) => r.id),
        { onSkipped: onSkipped && ((ids) => onSkipped(spaceId, ids)), onFailed },
      )
      after = page[page.length - 1]!.id
    }
  }
  return total
}

// 删掉不在 keep 里的模型的向量：切换或放弃换模型之后，没被改过的记忆还留着另一个模型的向量。
// keep 为空时什么都不删（还没配置嵌入模型，不知道该留哪个）
export async function pruneEmbeddings(db: Db, keep: string[]): Promise<number> {
  if (!keep.length) return 0
  let total = 0
  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    const removed = await withSpace(db, spaceId, (tx) =>
      tx
        .delete(memoryEmbeddings)
        .where(notInArray(memoryEmbeddings.model, keep))
        .returning({ id: memoryEmbeddings.memoryId }),
    )
    total += removed.length
  }
  return total
}
