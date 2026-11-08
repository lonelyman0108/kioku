import { createHash, randomBytes } from 'node:crypto'

import { and, eq, gt, isNull, sql } from 'drizzle-orm'

import type { Db, Tx } from '../db/client'
import { accounts, sessions } from '../db/schema'

export const SESSION_COOKIE = 'kioku_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
// 最近活动比上次晚这么久才写，免得每个请求都写一次会话
export const SESSION_ACTIVITY_INTERVAL_SECONDS = 5 * 60
// User-Agent 只用于登录设备列表，截断后存
export const USER_AGENT_MAX_LENGTH = 256

// 会话与一次性链接的令牌都是 32 字节随机数，库里只存 SHA-256
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

// 过期的会话由定时任务清理（jobs/cleanup.ts）
export async function createSession(
  db: Db | Tx,
  accountId: string,
  client: SessionClient = { clientAddress: null, userAgent: null },
): Promise<string> {
  const token = newToken()
  await db.insert(sessions).values({
    accountId,
    tokenHash: hashToken(token),
    clientAddress: client.clientAddress,
    userAgent: client.userAgent,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  })
  return token
}

// 停用的账号的会话也不认：停用时已经删掉了，这里再挡一次
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
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
        isNull(accounts.disabledAt),
      ),
    )
    .limit(1)
  if (!row) return null
  if (row.stale) {
    // 最近活动只用于登录设备列表，写不进去不影响这次请求
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
