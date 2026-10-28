import { lte, sql } from 'drizzle-orm'

import { pruneAttempts } from '../auth/rateLimit'
import type { Db } from '../db/client'
import { sessions } from '../db/schema'
import { pruneConversationTurns } from '../extraction/buffer'
import { loadRecallSettings, pruneRecallEvents } from '../recall/retention'

// 定时清理已经过期的数据，由后台任务每小时执行一次，不再在登录时顺带清理
export async function cleanupExpired(
  db: Db,
): Promise<{ sessions: number; attempts: number; recallEvents: number; turns: number }> {
  const gone = await db
    .delete(sessions)
    .where(lte(sessions.expiresAt, sql`now()`))
    .returning({ id: sessions.id })
  const { retentionDays } = await loadRecallSettings(db)
  return {
    sessions: gone.length,
    attempts: await pruneAttempts(db),
    recallEvents: await pruneRecallEvents(db, retentionDays),
    turns: await pruneConversationTurns(db),
  }
}
