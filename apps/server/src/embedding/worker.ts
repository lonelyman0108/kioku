import type { EmbeddingCoverage } from '@kioku/contracts'
import { and, count, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'

import { stillValidSql } from '../access/scope'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { entries, entryEmbeddings } from '../db/schema'
import { embedTexts } from '../models/client'
import { EMBEDDING_SETTING_KEY, loadResolvedModel } from '../models/store'
import { buildEmbeddingText, embeddingContentHash } from './text'

export const EMBED_BATCH = 32

export async function getEmbeddingCoverage(
  db: Db,
  masterKey: MasterKey | null,
): Promise<EmbeddingCoverage> {
  const modelCfg = await loadResolvedModel(db, masterKey, EMBEDDING_SETTING_KEY).catch(() => null)
  const [totalRow] = await db
    .select({ n: count() })
    .from(entries)
    .where(and(eq(entries.kind, 'entry'), isNull(entries.deletedAt)))
  const total = totalRow?.n ?? 0
  if (!modelCfg) {
    return { total, embedded: 0, model: null }
  }
  const [embRow] = await db
    .select({ n: count() })
    .from(entryEmbeddings)
    .innerJoin(entries, eq(entries.id, entryEmbeddings.entryId))
    .where(
      and(
        eq(entries.kind, 'entry'),
        isNull(entries.deletedAt),
        eq(entryEmbeddings.model, modelCfg.model),
      ),
    )
  return { total, embedded: embRow?.n ?? 0, model: modelCfg.model }
}

export interface EmbedProgress {
  processed: number
  total: number
  model: string
}

// 为给定词条批次计算并写入向量；内容哈希未变时跳过请求
export async function embedEntryIds(
  db: Db,
  masterKey: MasterKey | null,
  entryIds: readonly string[],
  signal?: AbortSignal,
  onProgress?: (progress: EmbedProgress) => void,
): Promise<number> {
  if (!entryIds.length) return 0
  const conn = await loadResolvedModel(db, masterKey, EMBEDDING_SETTING_KEY)
  if (!conn) return 0

  const uniqueIds = [...new Set(entryIds)]
  const rows = await db
    .select()
    .from(entries)
    .where(
      and(
        inArray(entries.id, uniqueIds),
        isNull(entries.deletedAt),
        or(
          eq(entries.kind, 'entry'),
          and(eq(entries.kind, 'episode'), stillValidSql(), isNotNull(entries.disclosure)),
        ),
      ),
    )
  if (!rows.length) return 0

  const existing = await db
    .select({
      entryId: entryEmbeddings.entryId,
      contentHash: entryEmbeddings.contentHash,
    })
    .from(entryEmbeddings)
    .where(
      and(
        inArray(
          entryEmbeddings.entryId,
          rows.map((r) => r.id),
        ),
        eq(entryEmbeddings.model, conn.model),
      ),
    )
  const hashById = new Map(existing.map((e) => [e.entryId, e.contentHash]))

  const pending: { id: string; text: string; hash: string }[] = []
  for (const row of rows) {
    const text = buildEmbeddingText(row)
    if (!text) continue
    const hash = embeddingContentHash(text)
    if (hashById.get(row.id) === hash) continue
    pending.push({ id: row.id, text, hash })
  }
  if (!pending.length) return 0

  onProgress?.({ processed: 0, total: pending.length, model: conn.model })

  let updated = 0
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    if (signal?.aborted) break
    const chunk = pending.slice(i, i + EMBED_BATCH)
    let vectors: number[][]
    try {
      vectors = await embedTexts(
        conn,
        chunk.map((c) => c.text),
        {
          maxRetries: 1,
          ...(signal ? { signal } : {}),
        },
      )
    } catch (err) {
      if (signal?.aborted) break
      throw err
    }
    for (let j = 0; j < chunk.length; j++) {
      if (signal?.aborted) break
      const item = chunk[j]!
      const vector = vectors[j]!
      await db
        .insert(entryEmbeddings)
        .values({
          entryId: item.id,
          model: conn.model,
          contentHash: item.hash,
          embedding: vector,
          updatedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: [entryEmbeddings.entryId, entryEmbeddings.model],
          set: {
            contentHash: item.hash,
            embedding: vector,
            updatedAt: sql`now()`,
          },
        })
      updated++
    }
    onProgress?.({ processed: updated, total: pending.length, model: conn.model })
  }
  return updated
}

// 切换模型时清理旧模型向量，再通过补齐任务重新生成
export async function purgeStaleEmbeddings(db: Db, keepModel: string | null): Promise<number> {
  const deleted = keepModel
    ? await db
        .delete(entryEmbeddings)
        .where(ne(entryEmbeddings.model, keepModel))
        .returning({ entryId: entryEmbeddings.entryId })
    : await db.delete(entryEmbeddings).returning({ entryId: entryEmbeddings.entryId })
  return deleted.length
}
