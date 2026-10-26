import { AppConfig, KeyScopes } from '@kioku/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'

import { withSpace } from '../db/client'
import { apiKeys, apps, spaceMembers } from '../db/schema'
import type { AppEnv, Deps } from '../http/env'
import { parseApiKey, verifyApiKey } from './keys'
import { resolveSession, SESSION_COOKIE } from './session'

const unauthorized = { error: '未登录或凭据无效' }

// 管理界面：Cookie 会话
export function requireConsole(deps: Deps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE)
    const session = token ? await resolveSession(deps.db, token) : null
    if (!session) return c.json(unauthorized, 401)
    c.set('console', { kind: 'console', ...session })
    await next()
  })
}

// 接入方：Authorization: Bearer <API Key>
export function requireKey(deps: Deps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const plaintext = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const parsed = parseApiKey(plaintext)
    if (!parsed) return c.json(unauthorized, 401)

    const [key] = await deps.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.prefix, parsed.prefix), isNull(apiKeys.revokedAt)))
      .limit(1)
    if (!key || !verifyApiKey(plaintext, key.secretHash)) return c.json(unauthorized, 401)

    const [app] = await withSpace(deps.db, key.spaceId, (tx) =>
      tx.select().from(apps).where(eq(apps.id, key.appId)).limit(1),
    )
    if (!app) return c.json(unauthorized, 401)

    // 最后使用时间只用于界面展示，失败不影响本次请求
    deps.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id))
      .catch(() => {})

    c.set('key', {
      kind: 'key',
      keyId: key.id,
      spaceId: key.spaceId,
      scopes: KeyScopes.parse(key.scopes),
      app: {
        id: app.id,
        slug: app.slug,
        name: app.name,
        runtimeFamily: app.runtimeFamily,
        ownerAccountId: app.ownerAccountId,
        defaultPersonaId: app.defaultPersonaId,
        config: AppConfig.parse(app.config),
      },
    })
    await next()
  })
}

export async function memberRole(deps: Deps, spaceId: string, accountId: string) {
  const [row] = await deps.db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.accountId, accountId)))
    .limit(1)
  return row?.role ?? null
}
