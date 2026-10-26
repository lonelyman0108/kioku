import { createHash, randomBytes } from 'node:crypto'

import { and, eq, gt, lte } from 'drizzle-orm'

import type { Db } from '../db/client'
import { sessions } from '../db/schema'

export const SESSION_COOKIE = 'kioku_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(db: Db, accountId: string): Promise<string> {
  // 顺手清掉这个账号已过期的会话，表不会无限增长
  await db
    .delete(sessions)
    .where(and(eq(sessions.accountId, accountId), lte(sessions.expiresAt, new Date())))
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
