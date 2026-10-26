import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm'

import { withSpace, type Db } from '../db/client'
import { memories, memoryEmbeddings, memoryGlossary, spaces } from '../db/schema'
import { formatUri } from '../memory/uri'
import type { Embedder } from './provider'
import { embeddingText, textHash } from './text'

const BATCH = 32
const PAGE = BATCH * 4

// updated_at 的文本形式保留微秒；用它判断记忆有没有被改过，JS 的 Date 只有毫秒，同一毫秒内的修改会被漏掉
const stamp = sql<string>`${memories.updatedAt}::text`

// 为一批记忆生成或刷新向量；已删除、secret、没有正文的记忆删掉向量。嵌入文本没变就跳过。
// 分三步：短事务读出要处理的内容 → 事务外请求嵌入接口 → 短事务写回。
// 请求外部接口时不占着数据库连接和事务；写回前锁住这些行并核对 updated_at，期间被改过的不写回，
// 交给那次修改触发的任务处理，避免旧内容的向量覆盖新状态（例如刚改成 secret 的记忆又被写上明文向量）
async function syncRows(
  db: Db,
  embedder: Embedder,
  spaceId: string,
  ids: string[],
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
        stale.push(row.id)
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

  const cleanupOtherModels = and(
    inArray(memoryEmbeddings.memoryId, ids),
    ne(memoryEmbeddings.model, embedder.model),
  )
  // 没有要写的也没有要删的，就不必锁行；只剩换模型后的旧向量清理
  if (!pending.length && !stale.length) {
    await withSpace(db, spaceId, (tx) => tx.delete(memoryEmbeddings).where(cleanupOtherModels))
    return 0
  }

  const vectors: number[][] = []
  for (let i = 0; i < pending.length; i += BATCH) {
    vectors.push(...(await embedder.embed(pending.slice(i, i + BATCH).map((p) => p.text))))
  }

  return withSpace(db, spaceId, async (tx) => {
    // 固定加锁顺序，两个重叠的任务不会互相等待成死锁
    const current = await tx
      .select({ id: memories.id, stamp })
      .from(memories)
      .where(inArray(memories.id, ids))
      .orderBy(memories.id)
      .for('update')
    const unchanged = new Set(current.filter((c) => c.stamp === readAt.get(c.id)).map((c) => c.id))
    const staleNow = stale.filter((id) => unchanged.has(id))
    if (staleNow.length) {
      await tx.delete(memoryEmbeddings).where(inArray(memoryEmbeddings.memoryId, staleNow))
    }
    const writes = pending
      .map((item, j) => ({ item, vector: vectors[j]! }))
      .filter(({ item }) => unchanged.has(item.id))
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
    await tx.delete(memoryEmbeddings).where(cleanupOtherModels)
    return writes.length
  })
}

export async function embedMemory(
  db: Db,
  embedder: Embedder,
  spaceId: string,
  memoryId: string,
): Promise<number> {
  return syncRows(db, embedder, spaceId, [memoryId])
}

// 全量补齐：逐个空间、按 id 分页检查所有记忆，用于首次配置或更换模型之后
export async function backfillEmbeddings(db: Db, embedder: Embedder): Promise<number> {
  let total = 0
  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    let after: string | null = null
    for (;;) {
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
      )
      after = page[page.length - 1]!.id
    }
  }
  return total
}
