import { and, isNotNull, lt, lte, ne, sql } from 'drizzle-orm'

import type { Db } from '../db/client'
import { deviceGrants, dreamSuggestions, entries, entryEmbeddings, sessions } from '../db/schema'
import { pruneIdleTurnBuffers } from '../extraction/buffer'

const TRASH_RETENTION_DAYS = 30
const SUGGESTION_RETENTION_DAYS = 30

export interface CleanupCounts {
  sessions: number
  deviceGrants: number
  turnBuffer: number
  entries: number
  suggestions: number
}

// 定期清理过期会话、过期设备授权、超时对话缓冲、回收站超期词条及已处理历史建议
export async function cleanupExpired(db: Db): Promise<CleanupCounts> {
  const [expiredSessions, expiredGrants, prunedTurns, purgedEntries, purgedSuggestions] =
    await Promise.all([
      db
        .delete(sessions)
        .where(lte(sessions.expiresAt, sql`now()`))
        .returning({ id: sessions.id }),
      db
        .delete(deviceGrants)
        .where(lte(deviceGrants.expiresAt, sql`now()`))
        .returning({ id: deviceGrants.id }),
      pruneIdleTurnBuffers(db),
      db
        .delete(entries)
        .where(
          and(
            isNotNull(entries.deletedAt),
            lt(entries.deletedAt, sql`now() - make_interval(days => ${TRASH_RETENTION_DAYS}::int)`),
          ),
        )
        .returning({ id: entries.id }),
      db
        .delete(dreamSuggestions)
        .where(
          and(
            ne(dreamSuggestions.status, 'pending'),
            isNotNull(dreamSuggestions.decidedAt),
            lt(
              dreamSuggestions.decidedAt,
              sql`now() - make_interval(days => ${SUGGESTION_RETENTION_DAYS}::int)`,
            ),
          ),
        )
        .returning({ id: dreamSuggestions.id }),
      // 回收已过期或软删会话摘要的信号向量，避免在 HNSW 索引中堆积
      db.execute(sql`
        delete from ${entryEmbeddings}
        where ${entryEmbeddings.entryId} in (
          select ${entries.id}
          from ${entries}
          where ${entries.kind} = 'episode'
            and (${entries.deletedAt} is not null or ${entries.validTo} <= now())
        )
      `),
    ])

  return {
    sessions: expiredSessions.length,
    deviceGrants: expiredGrants.length,
    turnBuffer: prunedTurns,
    entries: purgedEntries.length,
    suggestions: purgedSuggestions.length,
  }
}
