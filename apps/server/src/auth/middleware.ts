import { and, eq, isNull, sql } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'

import type { Db } from '../db/client'
import { apiKeys } from '../db/schema'
import type { AppEnv, Deps, KeyPrincipal } from '../http/env'
import { parseApiKey, verifyApiKey } from './keys'
import { resolveSession, SESSION_COOKIE } from './session'

const LAST_USED_INTERVAL_SECONDS = 5 * 60

export function requireConsole(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (!token) return c.json({ error: '未登录' }, 401)
    const session = await resolveSession(deps.db, token)
    if (!session) return c.json({ error: '登录已过期，请重新登录' }, 401)
    c.set('console', {
      kind: 'console',
      accountId: session.accountId,
      sessionId: session.sessionId,
    })
    return next()
  }
}

export async function authenticateApiKey(db: Db, rawKey: string): Promise<KeyPrincipal | null> {
  const parsed = parseApiKey(rawKey)
  if (!parsed) return null
  const [row] = await db
    .select({
      key: apiKeys,
      staleLastUsed: sql<boolean>`(${apiKeys.lastUsedAt} is null or ${apiKeys.lastUsedAt} < now() - make_interval(secs => ${LAST_USED_INTERVAL_SECONDS}))`,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.prefix, parsed.prefix), isNull(apiKeys.revokedAt)))
    .limit(1)
  if (!row || !verifyApiKey(rawKey, row.key.secretHash)) return null
  if (row.staleLastUsed) {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(apiKeys.id, row.key.id))
      .catch(() => {})
  }
  return {
    kind: 'key',
    keyId: row.key.id,
    name: row.key.name,
    prefix: row.key.prefix,
    runtimeFamily: row.key.runtimeFamily,
    envs: row.key.envs,
    allowedRealms: row.key.allowedRealms,
    canWrite: row.key.canWrite,
    canResolveCredentials: row.key.canResolveCredentials,
  }
}

export function requireKey(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.req.header('authorization')
    if (!auth || !auth.startsWith('Bearer ')) {
      return c.json({ error: '缺少访问密钥' }, 401)
    }
    const token = auth.slice('Bearer '.length).trim()
    const principal = await authenticateApiKey(deps.db, token)
    if (!principal) return c.json({ error: '访问密钥无效或已吊销' }, 401)
    c.set('key', principal)
    return next()
  }
}
