import { lte, sql } from 'drizzle-orm'

import { pruneBindingData } from '../access/binding'
import { pruneAttempts } from '../auth/rateLimit'
import type { Db } from '../db/client'
import { sessions } from '../db/schema'
import { dropIneligibleEmbeddings } from '../embedding/worker'
import { pruneConversationTurns } from '../extraction/buffer'
import { loadRecallSettings, pruneRecallEvents } from '../recall/retention'

// 定时清理已经过期的数据，由后台任务每小时执行一次，不再在登录时顺带清理：会话、登录失败计数、
// 超过保留天数的召回事件明细、空闲超过一天的会话缓冲、过期的绑定码与过了窗口的输错绑定码计数，
// 以及过期记忆（时间到了，没有写入，不会触发向量任务）留下的向量
export async function cleanupExpired(db: Db): Promise<{
  sessions: number
  attempts: number
  recallEvents: number
  turns: number
  bindCodes: number
  bindAttempts: number
  embeddings: number
}> {
  const gone = await db
    .delete(sessions)
    .where(lte(sessions.expiresAt, sql`now()`))
    .returning({ id: sessions.id })
  const { retentionDays } = await loadRecallSettings(db)
  const attempts = await pruneAttempts(db)
  const recallEvents = await pruneRecallEvents(db, retentionDays)
  const turns = await pruneConversationTurns(db)
  const binding = await pruneBindingData(db)
  const embeddings = await dropIneligibleEmbeddings(db)
  return {
    sessions: gone.length,
    attempts,
    recallEvents,
    turns,
    bindCodes: binding.codes,
    bindAttempts: binding.attempts,
    embeddings,
  }
}
