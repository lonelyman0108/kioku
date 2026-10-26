import { createRoute, z } from '@hono/zod-openapi'
import {
  AppConfig,
  AppInfo,
  CreateAppRequest,
  CreatedKey,
  CreateKeyRequest,
  ErrorResponse,
  KeyInfo,
  KeyScopes,
  type MemberRole,
} from '@kioku/contracts'
import { and, desc, eq, isNull } from 'drizzle-orm'

import { generateApiKey } from '../auth/keys'
import { memberRole, requireConsole } from '../auth/middleware'
import { withSpace } from '../db/client'
import { apiKeys, apps } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const SpaceParams = z.object({ spaceId: z.uuid() })
const AppParams = SpaceParams.extend({ appId: z.uuid() })
const KeyParams = AppParams.extend({ keyId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('不存在', ErrorResponse)

const toAppInfo = (row: typeof apps.$inferSelect) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  runtimeFamily: row.runtimeFamily,
  ownerAccountId: row.ownerAccountId,
  config: AppConfig.parse(row.config),
})

const toKeyInfo = (row: typeof apiKeys.$inferSelect) => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scopes: KeyScopes.parse(row.scopes),
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
})

const listApps = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/apps',
  tags: ['apps'],
  summary: '列出空间里的接入应用',
  request: { params: SpaceParams },
  responses: { 200: jsonResponse('应用列表', z.array(AppInfo)), 403: forbidden },
})

const createApp = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/apps',
  tags: ['apps'],
  summary: '新建接入应用，创建者就是这个应用的主人',
  request: { params: SpaceParams, body: jsonBody(CreateAppRequest) },
  responses: {
    201: jsonResponse('已创建', AppInfo),
    403: forbidden,
    409: jsonResponse('标识已被占用', ErrorResponse),
  },
})

const listKeys = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/apps/{appId}/keys',
  tags: ['apps'],
  summary: '列出应用的 API Key（不含明文）',
  request: { params: AppParams },
  responses: { 200: jsonResponse('Key 列表', z.array(KeyInfo)), 403: forbidden, 404: notFound },
})

const createKey = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/apps/{appId}/keys',
  tags: ['apps'],
  summary: '签发 API Key，明文只在这次响应里出现',
  request: { params: AppParams, body: jsonBody(CreateKeyRequest) },
  responses: { 201: jsonResponse('已签发', CreatedKey), 403: forbidden, 404: notFound },
})

const revokeKey = createRoute({
  method: 'delete',
  path: '/spaces/{spaceId}/apps/{appId}/keys/{keyId}',
  tags: ['apps'],
  summary: '吊销 API Key',
  request: { params: KeyParams },
  responses: { 204: { description: '已吊销' }, 403: forbidden, 404: notFound },
})

const canManageApps = (role: MemberRole | null) => role === 'owner' || role === 'editor'
// Key 决定接入方能读到什么，只有空间的 owner 能签发和吊销
const canManageKeys = (role: MemberRole | null) => role === 'owner'

export function appRoutes(deps: Deps) {
  const app = router()
  app.use('/spaces/*', requireConsole(deps))

  const roleOf = (spaceId: string, accountId: string) => memberRole(deps, spaceId, accountId)

  return app
    .openapi(listApps, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await roleOf(spaceId, c.get('console').accountId))) {
        return c.json({ error: '不是该空间成员' }, 403)
      }
      const rows = await withSpace(deps.db, spaceId, (tx) =>
        tx.select().from(apps).orderBy(apps.createdAt),
      )
      return c.json(rows.map(toAppInfo), 200)
    })
    .openapi(createApp, async (c) => {
      const { spaceId } = c.req.valid('param')
      const body = c.req.valid('json')
      const accountId = c.get('console').accountId
      if (!canManageApps(await roleOf(spaceId, accountId))) {
        return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      }
      const rows = await withSpace(deps.db, spaceId, (tx) =>
        tx
          .insert(apps)
          .values({ spaceId, ...body, ownerAccountId: accountId })
          .onConflictDoNothing()
          .returning(),
      )
      if (!rows[0]) return c.json({ error: `标识 ${body.slug} 已被占用` }, 409)
      return c.json(toAppInfo(rows[0]), 201)
    })
    .openapi(listKeys, async (c) => {
      const { spaceId, appId } = c.req.valid('param')
      if (!canManageKeys(await roleOf(spaceId, c.get('console').accountId))) {
        return c.json({ error: '需要 owner 角色' }, 403)
      }
      const rows = await deps.db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.spaceId, spaceId), eq(apiKeys.appId, appId)))
        .orderBy(desc(apiKeys.createdAt))
      return c.json(rows.map(toKeyInfo), 200)
    })
    .openapi(createKey, async (c) => {
      const { spaceId, appId } = c.req.valid('param')
      const body = c.req.valid('json')
      if (!canManageKeys(await roleOf(spaceId, c.get('console').accountId))) {
        return c.json({ error: '需要 owner 角色' }, 403)
      }
      const [target] = await withSpace(deps.db, spaceId, (tx) =>
        tx.select({ id: apps.id }).from(apps).where(eq(apps.id, appId)).limit(1),
      )
      if (!target) return c.json({ error: '应用不存在' }, 404)

      const generated = generateApiKey()
      const [row] = await deps.db
        .insert(apiKeys)
        .values({
          spaceId,
          appId,
          name: body.name,
          prefix: generated.prefix,
          secretHash: generated.secretHash,
          scopes: body.scopes,
        })
        .returning()
      return c.json({ ...toKeyInfo(row!), key: generated.plaintext }, 201)
    })
    .openapi(revokeKey, async (c) => {
      const { spaceId, appId, keyId } = c.req.valid('param')
      if (!canManageKeys(await roleOf(spaceId, c.get('console').accountId))) {
        return c.json({ error: '需要 owner 角色' }, 403)
      }
      const rows = await deps.db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, keyId),
            eq(apiKeys.spaceId, spaceId),
            eq(apiKeys.appId, appId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ id: apiKeys.id })
      if (!rows[0]) return c.json({ error: 'Key 不存在或已吊销' }, 404)
      return c.body(null, 204)
    })
}
