import { createRoute, z } from '@hono/zod-openapi'
import {
  BootPreview,
  BootPreviewRequest,
  ErrorResponse,
  KeyScopes,
  RecallDebug,
  RecallDebugRequest,
} from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'

import { keyEffectiveScopes } from '../access/access'
import { keyPrincipal, memberRole } from '../auth/middleware'
import { withSpace } from '../db/client'
import { apiKeys, apps, spaceMembers } from '../db/schema'
import type { AppEnv, Deps, KeyPrincipal } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'
import { bootPreview, recallDebug } from '../recall/debug'

const KeyParams = z.object({ spaceId: z.uuid(), appId: z.uuid(), keyId: z.uuid() })
const errors = {
  403: jsonResponse('没有权限', ErrorResponse),
  404: jsonResponse('应用或 Key 不存在，或 Key 已作废', ErrorResponse),
}

const preview = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/apps/{appId}/keys/{keyId}/preview',
  tags: ['apps'],
  summary: '启动预览：按这把 Key 模拟会话开始时注入的内容（只给应用主人）',
  request: { params: KeyParams, body: jsonBody(BootPreviewRequest) },
  responses: { 200: jsonResponse('启动预览', BootPreview), ...errors },
})

const debug = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/apps/{appId}/keys/{keyId}/debug',
  tags: ['apps'],
  summary: '召回调试：按这把 Key 模拟一句输入的召回，列出各路得分与被过滤掉的记忆（只给应用主人）',
  request: { params: KeyParams, body: jsonBody(RecallDebugRequest) },
  responses: { 200: jsonResponse('召回调试', RecallDebug), ...errors },
})

type Found = { key: KeyPrincipal } | { error: string; status: 403 | 404 }

// 模拟用的 Key：只有应用主人能用，因为模拟会读到主人的私人层与提示语（空间 owner 也不行）。
// 权限按这把 Key 现在的有效上限，作废的 Key 不能模拟
async function keyToSimulate(deps: Deps, c: Context<AppEnv>): Promise<Found> {
  const { spaceId, appId, keyId } = c.req.param() as z.infer<typeof KeyParams>
  const accountId = c.get('console').accountId
  if (!(await memberRole(deps, spaceId, accountId))) {
    return { error: '不是该空间成员', status: 403 }
  }
  const found = await withSpace(deps.db, spaceId, async (tx) => {
    const [app] = await tx.select().from(apps).where(eq(apps.id, appId))
    if (!app) return 'no-app' as const
    if (app.ownerAccountId !== accountId) return 'forbidden' as const
    const [key] = await tx
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.appId, appId)))
    return key ? { app, key } : ('no-key' as const)
  })
  if (found === 'no-app') return { error: '应用不存在', status: 404 }
  if (found === 'forbidden') return { error: '只有应用的主人能模拟它的 Key', status: 403 }
  if (found === 'no-key') return { error: 'Key 不存在', status: 404 }
  const { app, key } = found
  const [owner] = await deps.db
    .select({ role: spaceMembers.role, memberSince: spaceMembers.createdAt })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.accountId, accountId)))
  const scopes = keyEffectiveScopes({ ...key, scopes: KeyScopes.parse(key.scopes) }, owner)
  if (!scopes) return { error: 'Key 已作废', status: 404 }
  return { key: keyPrincipal(key, app, scopes) }
}

export function previewRoutes(deps: Deps) {
  return router()
    .openapi(preview, async (c) => {
      const found = await keyToSimulate(deps, c)
      if ('error' in found) return c.json({ error: found.error }, found.status)
      return c.json(await bootPreview(deps, found.key, c.req.valid('json')), 200)
    })
    .openapi(debug, async (c) => {
      const found = await keyToSimulate(deps, c)
      if ('error' in found) return c.json({ error: found.error }, found.status)
      // 管理界面里搜得到的范围按查看者本人（就是应用主人）的权限
      const { spaceId } = c.req.valid('param')
      const { service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      return c.json(
        await recallDebug(deps, found.key, service.access, c.req.valid('json').query),
        200,
      )
    })
}
