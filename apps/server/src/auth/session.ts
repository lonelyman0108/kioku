import { createHash, randomBytes } from 'node:crypto'

import { and, eq, gt } from 'drizzle-orm'

import type { Db } from '../db/client'
import { sessions } from '../db/schema'

export const SESSION_COOKIE = 'kioku_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// 过期的会话由定时任务清理（jobs/cleanup.ts）
export async function createSession(db: Db, accountId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.insert(sessions).values({
    accountId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  })
  return token
}

export async function resolveSession(
  db: Db,
  token: string,
): Promise<{ sessionId: string; accountId: string } | null> {
  const [row] = await db
    .select({ sessionId: sessions.id, accountId: sessions.accountId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1)
  return row ?? null
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}
