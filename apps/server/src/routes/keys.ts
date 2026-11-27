import { createRoute, z } from '@hono/zod-openapi'
import {
  ApiKeyListResponse,
  ApiKeyView,
  CreateApiKeyRequest,
  ErrorResponse,
  IssuedApiKeyResponse,
  RotateApiKeyRequest,
  UpdateApiKeyRequest,
} from '@kioku/contracts'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import { generateApiKey } from '../auth/keys'
import { apiKeys } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('未登录', ErrorResponse),
  404: jsonResponse('访问密钥不存在', ErrorResponse),
}

const IdParams = z.object({ id: z.uuid() })

type ApiKeyRow = typeof apiKeys.$inferSelect

function normalizeFocusRealms(value: readonly string[] | null | undefined): string[] | null {
  if (!value || !value.length) return null
  return [...value]
}

function toApiKeyView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    runtimeFamily: row.runtimeFamily,
    prefix: row.prefix,
    envs: row.envs,
    allowedRealms: row.allowedRealms,
    focusRealms: row.focusRealms,
    canWrite: row.canWrite,
    canResolveCredentials: row.canResolveCredentials,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  }
}

const listRoute = createRoute({
  method: 'get',
  path: '/console/keys',
  tags: ['keys'],
  summary: '列出全部有效访问密钥',
  responses: { 200: jsonResponse('访问密钥列表', ApiKeyListResponse), ...errors },
})

const createRouteDef = createRoute({
  method: 'post',
  path: '/console/keys',
  tags: ['keys'],
  summary: '签发新的终端访问密钥（明文仅返回一次）',
  request: { body: jsonBody(CreateApiKeyRequest) },
  responses: { 201: jsonResponse('已签发', IssuedApiKeyResponse), ...errors },
})

const updateRoute = createRoute({
  method: 'patch',
  path: '/console/keys/{id}',
  tags: ['keys'],
  summary: '更新访问密钥的名称、终端透镜或权限开关',
  request: { params: IdParams, body: jsonBody(UpdateApiKeyRequest) },
  responses: { 200: jsonResponse('已更新', ApiKeyView), ...errors },
})

const rotateRoute = createRoute({
  method: 'post',
  path: '/console/keys/{id}/rotate',
  tags: ['keys'],
  summary: '轮换访问密钥：立即吊销旧密钥并按原透镜配置签发新密钥',
  request: { params: IdParams, body: jsonBody(RotateApiKeyRequest) },
  responses: { 200: jsonResponse('已轮换', IssuedApiKeyResponse), ...errors },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/console/keys/{id}',
  tags: ['keys'],
  summary: '吊销指定访问密钥',
  request: { params: IdParams },
  responses: { 204: { description: '已吊销' }, ...errors },
})

export function keyRoutes(deps: Deps) {
  return router()
    .openapi(listRoute, async (c) => {
      const rows = await deps.db
        .select()
        .from(apiKeys)
        .where(isNull(apiKeys.revokedAt))
        .orderBy(desc(apiKeys.createdAt))
      return c.json({ items: rows.map(toApiKeyView) }, 200)
    })
    .openapi(createRouteDef, async (c) => {
      const body = c.req.valid('json')
      const generated = generateApiKey()
      const [inserted] = await deps.db
        .insert(apiKeys)
        .values({
          name: body.name,
          runtimeFamily: body.runtimeFamily,
          prefix: generated.prefix,
          secretHash: generated.secretHash,
          envs: body.envs,
          allowedRealms: body.allowedRealms,
          focusRealms: normalizeFocusRealms(body.focusRealms),
          canWrite: body.canWrite,
          canResolveCredentials: body.canResolveCredentials,
        })
        .returning()
      c.header('Cache-Control', 'no-store')
      return c.json({ key: generated.plaintext, item: toApiKeyView(inserted!) }, 201)
    })
    .openapi(updateRoute, async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const [updated] = await deps.db
        .update(apiKeys)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.runtimeFamily !== undefined ? { runtimeFamily: body.runtimeFamily } : {}),
          ...(body.envs !== undefined ? { envs: body.envs } : {}),
          ...(body.allowedRealms !== undefined ? { allowedRealms: body.allowedRealms } : {}),
          ...(body.focusRealms !== undefined
            ? { focusRealms: normalizeFocusRealms(body.focusRealms) }
            : {}),
          ...(body.canWrite !== undefined ? { canWrite: body.canWrite } : {}),
          ...(body.canResolveCredentials !== undefined
            ? { canResolveCredentials: body.canResolveCredentials }
            : {}),
        })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning()
      if (!updated) return c.json({ error: '访问密钥不存在或已吊销' }, 404)
      return c.json(toApiKeyView(updated), 200)
    })
    .openapi(rotateRoute, async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const rotated = await deps.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
          .for('update')
        if (!existing) return null
        await tx
          .update(apiKeys)
          .set({ revokedAt: sql`now()` })
          .where(eq(apiKeys.id, existing.id))
        const generated = generateApiKey()
        const [inserted] = await tx
          .insert(apiKeys)
          .values({
            name: body.name ?? existing.name,
            runtimeFamily: existing.runtimeFamily,
            prefix: generated.prefix,
            secretHash: generated.secretHash,
            envs: existing.envs,
            allowedRealms: existing.allowedRealms,
            focusRealms: existing.focusRealms,
            canWrite: existing.canWrite,
            canResolveCredentials: existing.canResolveCredentials,
          })
          .returning()
        return { key: generated.plaintext, item: toApiKeyView(inserted!) }
      })
      if (!rotated) return c.json({ error: '访问密钥不存在或已吊销' }, 404)
      c.header('Cache-Control', 'no-store')
      return c.json(rotated, 200)
    })
    .openapi(deleteRoute, async (c) => {
      const { id } = c.req.valid('param')
      const revoked = await deps.db
        .update(apiKeys)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id })
      if (!revoked.length) return c.json({ error: '访问密钥不存在或已吊销' }, 404)
      return c.body(null, 204)
    })
}
