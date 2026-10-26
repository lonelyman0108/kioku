import { and, eq, inArray, isNull, ne } from 'drizzle-orm'

import { withSpace, type Db } from '../db/client'
import { memories, memoryEmbeddings, memoryGlossary, spaces } from '../db/schema'
import { formatUri } from '../memory/uri'
import type { Embedder } from './provider'
import { embeddingText, textHash } from './text'

const BATCH = 32

type Row = typeof memories.$inferSelect

// 为一批记忆生成或刷新向量；已删除、secret、没有正文的记忆删掉向量。嵌入文本没变就跳过
async function syncRows(db: Db, embedder: Embedder, spaceId: string, rows: Row[]): Promise<number> {
  if (!rows.length) return 0
  return withSpace(db, spaceId, async (tx) => {
    const ids = rows.map((r) => r.id)
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
    for (const row of rows) {
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

    if (stale.length)
      await tx.delete(memoryEmbeddings).where(inArray(memoryEmbeddings.memoryId, stale))
    for (let i = 0; i < pending.length; i += BATCH) {
      const chunk = pending.slice(i, i + BATCH)
      const vectors = await embedder.embed(chunk.map((p) => p.text))
      for (const [j, item] of chunk.entries()) {
        const values = {
          spaceId,
          memoryId: item.id,
          model: embedder.model,
          contentHash: item.hash,
          embedding: vectors[j]!,
        }
        await tx
          .insert(memoryEmbeddings)
          .values(values)
          .onConflictDoUpdate({
            target: [memoryEmbeddings.memoryId, memoryEmbeddings.model],
            set: { contentHash: item.hash, embedding: vectors[j]!, updatedAt: new Date() },
          })
      }
    }
    // 换过模型后，旧模型的向量不再参与检索，顺手清掉
    await tx
      .delete(memoryEmbeddings)
      .where(
        and(inArray(memoryEmbeddings.memoryId, ids), ne(memoryEmbeddings.model, embedder.model)),
      )
    return pending.length
  })
}

export async function embedMemory(
  db: Db,
  embedder: Embedder,
  spaceId: string,
  memoryId: string,
): Promise<number> {
  const rows = await withSpace(db, spaceId, (tx) =>
    tx.select().from(memories).where(eq(memories.id, memoryId)),
  )
  return syncRows(db, embedder, spaceId, rows)
}

// 全量补齐：逐个空间检查所有记忆，用于首次配置或更换模型之后
export async function backfillEmbeddings(db: Db, embedder: Embedder): Promise<number> {
  let total = 0
  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    const rows = await withSpace(db, spaceId, (tx) =>
      tx.select().from(memories).where(isNull(memories.deletedAt)),
    )
    for (let i = 0; i < rows.length; i += BATCH * 4) {
      total += await syncRows(db, embedder, spaceId, rows.slice(i, i + BATCH * 4))
    }
  }
  return total
}
