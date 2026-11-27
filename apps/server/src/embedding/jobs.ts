import { hasEpisodeSignals } from '@kioku/contracts'
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm'

import { stillValidSql } from '../access/scope'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { entries, entryEmbeddings } from '../db/schema'
import { EMBEDDING_SETTING_KEY, loadResolvedModel } from '../models/store'
import { embedEntryIds, type EmbedProgress } from './worker'

export interface EmbedJobTarget {
  entryId: string
}

export async function runEmbedBatch(
  db: Db,
  masterKey: MasterKey | null,
  targets: readonly EmbedJobTarget[],
  signal?: AbortSignal,
): Promise<number> {
  return embedEntryIds(
    db,
    masterKey,
    targets.map((t) => t.entryId),
    signal,
  )
}

async function findMissingEmbeddingIds(db: Db, model: string): Promise<string[]> {
  const rows = await db
    .select({ id: entries.id, kind: entries.kind, disclosure: entries.disclosure })
    .from(entries)
    .leftJoin(
      entryEmbeddings,
      and(eq(entryEmbeddings.entryId, entries.id), eq(entryEmbeddings.model, model)),
    )
    .where(
      and(
        isNull(entries.deletedAt),
        isNull(entryEmbeddings.entryId),
        or(
          eq(entries.kind, 'entry'),
          and(eq(entries.kind, 'episode'), stillValidSql(), isNotNull(entries.disclosure)),
        ),
      ),
    )

  return rows.filter((r) => r.kind === 'entry' || hasEpisodeSignals(r.disclosure)).map((r) => r.id)
}

// 统计当前模型下待补齐向量的词条总数（含活跃正式词条与含结构化信号的活跃会话摘要）
export async function countMissingEmbeddings(db: Db, model: string): Promise<number> {
  return (await findMissingEmbeddingIds(db, model)).length
}

// 补齐当前模型下缺失向量的全部活跃正式词条，以及含结构化信号的活跃会话摘要
export async function runBackfillEmbeddings(
  db: Db,
  masterKey: MasterKey | null,
  signal?: AbortSignal,
  onProgress?: (progress: EmbedProgress) => void,
): Promise<number> {
  const conn = await loadResolvedModel(db, masterKey, EMBEDDING_SETTING_KEY)
  if (!conn) return 0

  const targetIds = await findMissingEmbeddingIds(db, conn.model)
  if (!targetIds.length) return 0
  onProgress?.({ processed: 0, total: targetIds.length, model: conn.model })
  return embedEntryIds(db, masterKey, targetIds, signal, onProgress)
}
