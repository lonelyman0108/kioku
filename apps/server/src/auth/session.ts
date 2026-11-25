import { createHash, randomBytes } from 'node:crypto'

import { and, eq, gt, sql } from 'drizzle-orm'

import type { Db, Tx } from '../db/client'
import { accounts, sessions } from '../db/schema'

export const SESSION_COOKIE = 'kioku_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
// 最近活动比上次晚这么久才写，免得每个请求都写一次会话
export const SESSION_ACTIVITY_INTERVAL_SECONDS = 5 * 60
export const USER_AGENT_MAX_LENGTH = 256

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export interface SessionClient {
  clientAddress: string | null
  userAgent: string | null
}

// 按码点截断，不切开代理对
export function truncateUserAgent(value: string | undefined): string | null {
  if (!value) return null
  const points = Array.from(value)
  return points.length > USER_AGENT_MAX_LENGTH
    ? points.slice(0, USER_AGENT_MAX_LENGTH).join('')
    : value
}

export async function createSession(
  db: Db | Tx,
  accountId: string,
  client: SessionClient = { clientAddress: null, userAgent: null },
): Promise<string> {
  const token = newToken()
  const ttlSeconds = Math.floor(SESSION_TTL_MS / 1000)
  await db.insert(sessions).values({
    accountId,
    tokenHash: hashToken(token),
    clientAddress: client.clientAddress,
    userAgent: client.userAgent,
    expiresAt: sql`now() + make_interval(secs => ${ttlSeconds})`,
  })
  return token
}

export async function resolveSession(
  db: Db,
  token: string,
): Promise<{ sessionId: string; accountId: string } | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      accountId: sessions.accountId,
      stale: sql<boolean>`(${sessions.lastActiveAt} < now() - make_interval(secs => ${SESSION_ACTIVITY_INTERVAL_SECONDS}))`,
    })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, sql`now()`)))
    .limit(1)
  if (!row) return null
  if (row.stale) {
    await db
      .update(sessions)
      .set({ lastActiveAt: sql`now()` })
      .where(
        and(
          eq(sessions.id, row.sessionId),
          sql`${sessions.lastActiveAt} < now() - make_interval(secs => ${SESSION_ACTIVITY_INTERVAL_SECONDS})`,
        ),
      )
      .catch(() => {})
  }
  return { sessionId: row.sessionId, accountId: row.accountId }
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}
