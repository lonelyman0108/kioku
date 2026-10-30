import { and, asc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm'

import { withSpace, type Db, type Tx } from '../db/client'
import { memories, memoryEmbeddings, memoryGlossary, spaces } from '../db/schema'
import { formatUri } from '../memory/uri'
import { EmbedRejected, type Embedder } from './provider'
import { lockEmbeddingModels } from './settings'
import { embeddingText, textHash } from './text'

// 一次请求嵌入接口最多带这么多条文本
export const EMBED_BATCH = 32
const PAGE = EMBED_BATCH * 4
// 整批失败后逐条再试时，连着这么多条（批次更小时是整批）都失败，就当作接口不可用，不再一条条请求（见 embedBatch）
const GIVE_UP_AFTER = 3

// 判断记忆有没有被改过用 PostgreSQL 的 xmin（最后一次修改这一行的事务号）：每次 UPDATE 都会变，
// 不像 updated_at 依赖应用写入的时间戳（只有毫秒精度，同一毫秒内的两次修改分不出来）
const stamp = sql<string>`memories.xmin::text`

// 一次处理（一批写入之后的任务、一次补齐）里这个模型的接口有没有接受过文本。接受过之后，接口拒绝的（EmbedRejected）
// 才算是那一条文本的问题；还没接受过时什么错都可能是接口本身不对（例如渠道的模型名写错了，每个请求都回 400）
export interface EmbedRun {
  accepted: boolean
}

export interface SyncHooks {
  // 写回时正被别的事务锁着、这次没处理的记忆，交给调用方稍后重试
  onSkipped?: ((ids: string[]) => void) | undefined
  // 接口拒绝了这一条，或者逐条再试时这一条请求失败：跳过它，别的照常写
  onFailed?: ((memoryId: string, message: string) => void) | undefined
  // 处理时间用完了、服务要停（signal）：还没请求的不再请求，正在请求的取消；写回已经拿到的向量，
  // 没生成的（不含被锁着、已经交给 onSkipped 的）交给调用方另排
  signal?: AbortSignal | undefined
  onDeferred?: ((ids: string[]) => void) | undefined
  // 同一次处理里的几次调用共用一个，记着接口接受过文本没有；不给时只算这一次调用
  run?: EmbedRun | undefined
}

// 还要留着向量的模型：写回时按设置里正在用的与正在换过去的算（锁住设置到写完），不用任务开始时的：
// 期间换模型被放弃、已经切走或换成了别的，旧的判断会写下没人用的向量，或者删掉新模型刚写的。
// 还没配置嵌入模型时（命令行工具、测试直接给模型）只认这次写的模型
async function keptModels(tx: Tx, embedder: Embedder): Promise<string[]> {
  const { active, next } = await lockEmbeddingModels(tx)
  const kept = [active, next].flatMap((s) => (s ? [s.model] : []))
  return kept.length ? kept : [embedder.model]
}

// 一批文本的向量。整批失败时逐条再试，先试短的：接口拒绝单条文本多半是因为太长，先试短的能尽早确认接口是好的。
// 这一次处理里接口还没接受过任何文本时，连着几条都失败（不管什么错）就当作接口不可用，停下来报给调用方（broken），
// 不再一条条请求；接受过之后，被拒的（EmbedRejected，例如正文超长）只算这一条、跳过，连着几条都是别的错
// （连不上、超时、5xx）照样当作接口不可用。处理时间用完了也停下：没拿到的不在结果里、也不报失败。
// 已经拿到的向量不论怎样都交回去
async function embedBatch(
  embedder: Embedder,
  batch: { id: string; text: string }[],
  hooks: SyncHooks,
  run: EmbedRun,
): Promise<{ vectors: Map<string, number[]>; broken: Error | null }> {
  const { signal, onFailed } = hooks
  const options = signal ? { signal } : {}
  const vectors = new Map<string, number[]>()
  // 这一条是被拒、只算它自己的吗
  const rejectedAlone = (err: unknown) => run.accepted && err instanceof EmbedRejected
  try {
    const out = await embedder.embed(
      batch.map((p) => p.text),
      options,
    )
    batch.forEach((p, j) => vectors.set(p.id, out[j]!))
    run.accepted = true
    return { vectors, broken: null }
  } catch (err) {
    if (signal?.aborted) return { vectors, broken: null }
    if (batch.length === 1) {
      if (!rejectedAlone(err)) return { vectors, broken: err as Error }
      onFailed?.(batch[0]!.id, (err as Error).message)
      return { vectors, broken: null }
    }
  }
  const limit = Math.min(GIVE_UP_AFTER, batch.length)
  let failures = 0
  for (const item of [...batch].sort((a, b) => a.text.length - b.text.length)) {
    if (signal?.aborted) break
    try {
      const [vector] = await embedder.embed([item.text], options)
      vectors.set(item.id, vector!)
      run.accepted = true
      failures = 0
    } catch (err) {
      if (signal?.aborted) break
      if (!rejectedAlone(err) && ++failures >= limit) return { vectors, broken: err as Error }
      onFailed?.(item.id, (err as Error).message)
    }
  }
  return { vectors, broken: null }
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
    // 按 id 排：一批里请求的顺序固定，出问题时好重现
    const rows = await tx
      .select({ row: memories, stamp })
      .from(memories)
      .where(inArray(memories.id, ids))
      .orderBy(asc(memories.id))
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

  const run = hooks.run ?? { accepted: false }
  const vectors = new Map<string, number[]>()
  const failed = new Set<string>()
  const batchHooks: SyncHooks = {
    ...hooks,
    onFailed: (memoryId, message) => {
      failed.add(memoryId)
      hooks.onFailed?.(memoryId, message)
    },
  }
  // 接口不可用时停下，不再请求后面的；已经拿到的向量照样写回，下次只请求剩下的
  let broken: Error | null = null
  for (let i = 0; i < pending.length && !broken; i += EMBED_BATCH) {
    if (hooks.signal?.aborted) break
    const out = await embedBatch(embedder, pending.slice(i, i + EMBED_BATCH), batchHooks, run)
    for (const [id, vector] of out.vectors) vectors.set(id, vector)
    broken = out.broken
  }

  const { written, skipped } = await withSpace(db, spaceId, async (tx) => {
    // 这个模型已经不用了（换模型被放弃、已经切走）就不写它的向量，只做清理
    const keep = await keptModels(tx, embedder)
    // 正被别的事务锁着的行跳过，不等它：移动记忆、让出 URI 会按自己的顺序锁多行，
    // 在这里等锁可能和它们互相等待成死锁。那些行如果被改了，修改本身会再触发向量任务；
    // 没改的由调用方稍后重试。
    // 这里只写向量表，不改记忆这一行（更不改它的键列），所以锁用 FOR NO KEY UPDATE：别的事务往事件、关键词、
    // 向量表写指向它的外键时只在这一行上加 KEY SHARE，和它不冲突，不会被当成锁住而跳过；
    // 改这一行本身（UPDATE、DELETE）的事务照样和它冲突，读到之后到写完之间它不会被改
    const current = await tx
      .select({ id: memories.id, stamp })
      .from(memories)
      .where(inArray(memories.id, ids))
      .for('no key update', { skipLocked: true })
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
  if (broken) throw broken
  // 处理时间用完了、服务要停，没生成、也没失败的：交给调用方另排。被锁着的已经交给 onSkipped 另排了，不重复算
  const later = new Set(skipped)
  const deferred = pending
    .map((p) => p.id)
    .filter((id) => !vectors.has(id) && !failed.has(id) && !later.has(id))
  if (deferred.length) hooks.onDeferred?.(deferred)
  return written
}

// 同一个空间的几条记忆一起处理：一起读、合起来请求嵌入接口、一起写回。返回写下了几条向量。
// id 先去重：调用方可能把同一条记忆传了几次（同一条连着改了几次会排几个任务），每条只处理一次
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
  // 整次补齐算一次处理：前面的页里接口接受过文本，后面页里被拒的就只算那一条
  const run: EmbedRun = { accepted: false }
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
        { onSkipped: onSkipped && ((ids) => onSkipped(spaceId, ids)), onFailed, run },
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
