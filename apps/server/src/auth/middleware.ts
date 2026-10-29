import { AppConfig, KeyScopes } from '@kioku/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'

import { keyEffectiveScopes } from '../access/access'
import { withSpace, type Db } from '../db/client'
import { accounts, apiKeys, apps, spaceMembers } from '../db/schema'
import type { AppEnv, Deps, KeyPrincipal } from '../http/env'
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
    const principal = await principalOf(deps.db, key)
    if (!principal) return c.json(unauthorized, 401)

    // 最后使用时间只用于界面展示，失败不影响本次请求
    deps.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id))
      .catch(() => {})

    c.set('key', principal)
    await next()
  })
}

// 一把 Key 现在的身份：所属应用与有效上限。Key 的权限按应用主人计算：主人已经不在空间里
// （或离开后又被重新加入、Key 签发在那之前），Key 作废，返回 null；主人被降级，Key 的上限随之收紧
async function principalOf(db: Db, key: typeof apiKeys.$inferSelect): Promise<KeyPrincipal | null> {
  // 应用与主人当前的角色一次查出来
  const [found] = await withSpace(db, key.spaceId, (tx) =>
    tx
      .select({ app: apps, ownerRole: spaceMembers.role, memberSince: spaceMembers.createdAt })
      .from(apps)
      .leftJoin(
        spaceMembers,
        and(
          eq(spaceMembers.spaceId, apps.spaceId),
          eq(spaceMembers.accountId, apps.ownerAccountId),
        ),
      )
      .where(eq(apps.id, key.appId))
      .limit(1),
  )
  const scopes = found
    ? keyEffectiveScopes(
        { ...key, scopes: KeyScopes.parse(key.scopes) },
        { role: found.ownerRole, memberSince: found.memberSince },
      )
    : null
  return found && scopes ? keyPrincipal(key, found.app, scopes) : null
}

// 后台任务按记下的 Key 重新确认身份（例如抽取缓冲里的对话）：吊销了、作废了都返回 null
export async function principalForKeyId(db: Db, keyId: string): Promise<KeyPrincipal | null> {
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .limit(1)
  return key ? principalOf(db, key) : null
}

// 接入方的身份：Key、它所属的应用与有效上限。鉴权与管理界面的模拟（启动预览、召回调试）共用
export function keyPrincipal(
  key: { id: string; spaceId: string },
  app: typeof apps.$inferSelect,
  scopes: KeyScopes,
): KeyPrincipal {
  return {
    kind: 'key',
    keyId: key.id,
    spaceId: key.spaceId,
    scopes,
    app: {
      id: app.id,
      slug: app.slug,
      name: app.name,
      runtimeFamily: app.runtimeFamily,
      ownerAccountId: app.ownerAccountId,
      defaultPersonaId: app.defaultPersonaId,
      config: AppConfig.parse(app.config),
    },
  }
}

// 是不是实例管理员：实例设置、备份与模型接口的原始报错只给他们
export async function isInstanceAdmin(db: Db, accountId: string): Promise<boolean> {
  const [account] = await db
    .select({ isAdmin: accounts.isAdmin })
    .from(accounts)
    .where(eq(accounts.id, accountId))
  return Boolean(account?.isAdmin)
}

// 只给实例管理员的接口，放在 requireConsole 之后
export function requireInstanceAdmin(deps: Deps, message = '需要实例管理员') {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!(await isInstanceAdmin(deps.db, c.get('console').accountId))) {
      return c.json({ error: message }, 403)
    }
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
