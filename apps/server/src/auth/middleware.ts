import {
  ClientConfig,
  LensKeyScopes,
  type CircleEffectiveGrant,
  type MemberRole,
} from '@kioku/contracts'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'

import {
  computeKeyGrants,
  type CircleGrantMembership,
  type LinkedCircleInput,
} from '../access/access'
import { resolveStaticContextRealms } from '../access/realms'
import { withCircle, type Db, type Tx } from '../db/client'
import { accounts, apiKeys, circleMembers, circles, clients, facetTerms } from '../db/schema'
import type { AppEnv, Deps, KeyPrincipal } from '../http/env'
import { parseApiKey, verifyApiKey } from './keys'
import { resolveSession, SESSION_COOKIE } from './session'

const unauthorized = { error: '未登录或凭据无效' }

export function requireConsole(deps: Deps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE)
    const session = token ? await resolveSession(deps.db, token) : null
    if (!session) return c.json(unauthorized, 401)
    c.set('console', { kind: 'console', ...session })
    await next()
  })
}

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

    deps.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id))
      .catch(() => {})

    c.set('key', principal)
    await next()
  })
}

// 解析一把访问密钥在多记忆圈中的有效权限矩阵与静态在场场域；主场失效整体作废返回 null
export async function principalOf(
  db: Db,
  key: typeof apiKeys.$inferSelect,
): Promise<KeyPrincipal | null> {
  const result = await withCircle(db, key.circleId, async (tx) => {
    const [found] = await tx
      .select({
        client: clients,
        primaryCircle: circles,
        ownerRole: circleMembers.role,
        memberSince: circleMembers.createdAt,
        disabledAt: accounts.disabledAt,
        accountName: accounts.displayName,
      })
      .from(clients)
      .innerJoin(circles, eq(circles.id, clients.circleId))
      .leftJoin(
        circleMembers,
        and(
          eq(circleMembers.circleId, clients.circleId),
          eq(circleMembers.accountId, clients.ownerAccountId),
        ),
      )
      .leftJoin(accounts, eq(accounts.id, clients.ownerAccountId))
      .where(eq(clients.id, key.clientId))
      .limit(1)
    if (!found) return null

    const contextFacets = key.contextFacets ?? {}
    const terms = Object.keys(contextFacets).length
      ? await tx
          .select({
            dimensionKey: facetTerms.dimensionKey,
            slug: facetTerms.slug,
            implies: facetTerms.implies,
          })
          .from(facetTerms)
      : []

    return {
      ...found,
      staticContextRealms: resolveStaticContextRealms(contextFacets, terms),
    }
  })

  if (!result) return null

  const {
    client,
    primaryCircle,
    ownerRole,
    memberSince,
    disabledAt,
    accountName,
    staticContextRealms,
  } = result
  const scopes = LensKeyScopes.parse(key.scopes)
  const linked = key.linkedCircles ?? []
  const linkedIds = [...new Set(linked.map((l) => l.circleId))]

  const [linkedCircles, linkedMembers] = linkedIds.length
    ? await Promise.all([
        db
          .select({ id: circles.id, slug: circles.slug, name: circles.name, kind: circles.kind })
          .from(circles)
          .where(inArray(circles.id, linkedIds)),
        db
          .select({
            circleId: circleMembers.circleId,
            role: circleMembers.role,
            createdAt: circleMembers.createdAt,
          })
          .from(circleMembers)
          .where(
            and(
              inArray(circleMembers.circleId, linkedIds),
              eq(circleMembers.accountId, client.ownerAccountId),
            ),
          ),
      ])
    : [[], []]

  const linkedCircleById = new Map(linkedCircles.map((c) => [c.id, c]))
  const linkedMemberByCircle = new Map(linkedMembers.map((m) => [m.circleId, m]))

  const primaryMembership: CircleGrantMembership = {
    circleId: primaryCircle.id,
    circleSlug: primaryCircle.slug,
    circleName: primaryCircle.name,
    circleKind: primaryCircle.kind,
    role: ownerRole,
    memberSince,
  }
  const linkedInputs: LinkedCircleInput[] = linked.map((grant) => {
    const c = linkedCircleById.get(grant.circleId)
    const m = linkedMemberByCircle.get(grant.circleId)
    return {
      grant,
      membership: c
        ? {
            circleId: c.id,
            circleSlug: c.slug,
            circleName: c.name,
            circleKind: c.kind,
            role: m?.role ?? null,
            memberSince: m?.createdAt ?? null,
          }
        : null,
    }
  })

  const { effectiveScopes, circleGrants } = computeKeyGrants({
    key: { scopes, createdAt: key.createdAt, revokedAt: key.revokedAt },
    ownerDisabledAt: disabledAt,
    primary: primaryMembership,
    linked: linkedInputs,
  })
  if (!effectiveScopes) return null

  return keyPrincipal({
    key,
    client,
    primaryCircle,
    scopes: effectiveScopes,
    circleGrants,
    staticContextRealms,
    labels: { circleName: primaryCircle.name, accountName },
  })
}

export async function principalForKeyId(db: Db, keyId: string): Promise<KeyPrincipal | null> {
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .limit(1)
  return key ? principalOf(db, key) : null
}

export interface KeyPrincipalInput {
  key: {
    id: string
    circleId: string
    contextFacets?: Record<string, string[]>
    personaOverrideId: string | null
  }
  client: typeof clients.$inferSelect
  primaryCircle: Pick<
    typeof circles.$inferSelect,
    'id' | 'slug' | 'name' | 'kind' | 'defaultFacets'
  >
  scopes: LensKeyScopes
  circleGrants: readonly CircleEffectiveGrant[]
  staticContextRealms?: ReadonlySet<string>
  labels?: KeyPrincipal['labels']
}

export function keyPrincipal(input: KeyPrincipalInput): KeyPrincipal {
  const {
    key,
    client,
    primaryCircle,
    scopes,
    circleGrants,
    staticContextRealms = new Set<string>(),
    labels,
  } = input
  return {
    kind: 'key',
    keyId: key.id,
    circleId: key.circleId,
    scopes,
    contextFacets: key.contextFacets ?? {},
    staticContextRealms,
    personaOverrideId: key.personaOverrideId,
    primaryCircle: {
      id: primaryCircle.id,
      slug: primaryCircle.slug,
      name: primaryCircle.name,
      kind: primaryCircle.kind,
      defaultRealms: primaryCircle.defaultFacets?.realm ?? [],
    },
    circleGrants,
    ...(labels ? { labels } : {}),
    client: {
      id: client.id,
      slug: client.slug,
      name: client.name,
      runtimeFamily: client.runtimeFamily,
      ownerAccountId: client.ownerAccountId,
      defaultPersonaId: client.defaultPersonaId,
      config: ClientConfig.parse(client.config),
    },
  }
}

export async function isInstanceAdmin(db: Db, accountId: string): Promise<boolean> {
  const [account] = await db
    .select({ isAdmin: accounts.isAdmin, disabledAt: accounts.disabledAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
  return Boolean(account?.isAdmin && !account.disabledAt)
}

export function requireInstanceAdmin(deps: Deps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!(await isInstanceAdmin(deps.db, c.get('console').accountId))) {
      return c.json({ error: '需要实例管理员' }, 403)
    }
    await next()
  })
}

const ADMIN_LOCK = 'kioku.instance-admins'

export async function lockAsAdmin(tx: Tx, actor: string): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ADMIN_LOCK}))`)
  const [self] = await tx
    .select({ isAdmin: accounts.isAdmin, disabledAt: accounts.disabledAt })
    .from(accounts)
    .where(eq(accounts.id, actor))
  return Boolean(self?.isAdmin && !self.disabledAt)
}

export async function memberRole(
  deps: Deps,
  circleId: string,
  accountId: string,
): Promise<MemberRole | null> {
  const [row] = await deps.db
    .select({ role: circleMembers.role })
    .from(circleMembers)
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, accountId)))
    .limit(1)
  return row?.role ?? null
}
