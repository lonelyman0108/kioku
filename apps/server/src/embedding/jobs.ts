import { and, eq, isNull } from 'drizzle-orm'

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

// 补齐当前模型下缺失向量的所有活跃正式词条
export async function runBackfillEmbeddings(
  db: Db,
  masterKey: MasterKey | null,
  signal?: AbortSignal,
  onProgress?: (progress: EmbedProgress) => void,
): Promise<number> {
  const conn = await loadResolvedModel(db, masterKey, EMBEDDING_SETTING_KEY)
  if (!conn) return 0

  const rows = await db
    .select({ id: entries.id })
    .from(entries)
    .leftJoin(
      entryEmbeddings,
      and(eq(entryEmbeddings.entryId, entries.id), eq(entryEmbeddings.model, conn.model)),
    )
    .where(
      and(eq(entries.kind, 'entry'), isNull(entries.deletedAt), isNull(entryEmbeddings.entryId)),
    )

  if (!rows.length) return 0
  onProgress?.({ processed: 0, total: rows.length, model: conn.model })
  return embedEntryIds(
    db,
    masterKey,
    rows.map((r) => r.id),
    signal,
    onProgress,
  )
}
