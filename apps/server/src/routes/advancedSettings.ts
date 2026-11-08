import { createRoute, z } from '@hono/zod-openapi'
import {
  AppAdvancedView,
  ErrorResponse,
  SpaceAdvancedView,
  UpdateAppAdvanced,
  UpdateSpaceAdvanced,
  type MemberRole,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'

import { memberRole } from '../auth/middleware'
import { withSpace, type Tx } from '../db/client'
import { apps } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { saveAppAdvanced, saveSpaceAdvanced } from '../settings/advanced'
import { appAdvancedView, spaceAdvancedView } from '../settings/advancedViews'

// 高级设置的空间与应用两级。实例一级在 routes/settings.ts（只给实例管理员）
const SpaceParams = z.object({ spaceId: z.uuid() })
const AppParams = SpaceParams.extend({ appId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('应用不存在', ErrorResponse)
const invalid = jsonResponse('取值不对', ErrorResponse)

const spaceView = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/settings/advanced',
  tags: ['spaces'],
  summary: '空间的高级设置：空间的覆盖、生效值与来源、实例的生效值，以及有覆盖的应用（成员都能看）',
  request: { params: SpaceParams },
  responses: { 200: jsonResponse('高级设置', SpaceAdvancedView), 403: forbidden },
})

const spaceUpdate = createRoute({
  method: 'put',
  path: '/spaces/{spaceId}/settings/advanced',
  tags: ['spaces'],
  summary: '修改空间的高级设置（只给空间所有者）：只带要改的项，某项为 null 时恢复成沿用实例',
  request: { params: SpaceParams, body: jsonBody(UpdateSpaceAdvanced) },
  responses: {
    200: jsonResponse('高级设置', SpaceAdvancedView),
    400: invalid,
    403: forbidden,
  },
})

const appView = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/apps/{appId}/settings/advanced',
  tags: ['apps'],
  summary: '应用的高级设置：应用的覆盖、生效值与来源（给应用所有者与空间所有者）',
  request: { params: AppParams },
  responses: {
    200: jsonResponse('高级设置', AppAdvancedView),
    403: forbidden,
    404: notFound,
  },
})

const appUpdate = createRoute({
  method: 'put',
  path: '/spaces/{spaceId}/apps/{appId}/settings/advanced',
  tags: ['apps'],
  summary: '修改应用的高级设置（只给应用所有者）：只带要改的项，某项为 null 时恢复成沿用空间',
  request: { params: AppParams, body: jsonBody(UpdateAppAdvanced) },
  responses: {
    200: jsonResponse('高级设置', AppAdvancedView),
    400: invalid,
    403: forbidden,
    404: notFound,
  },
})

type AppRow = { id: string; runtimeFamily: string; ownerAccountId: string }

async function appOf(tx: Tx, appId: string, lock = false): Promise<AppRow | undefined> {
  const query = tx
    .select({ id: apps.id, runtimeFamily: apps.runtimeFamily, ownerAccountId: apps.ownerAccountId })
    .from(apps)
    .where(eq(apps.id, appId))
  const [row] = await (lock ? query.for('update') : query)
  return row
}

// 应用的配置只有应用所有者能改（和修改应用一样，还要是能管理应用的角色）；空间所有者能看
const canEditApp = (role: MemberRole, app: AppRow, accountId: string) =>
  app.ownerAccountId === accountId && (role === 'owner' || role === 'editor')
const canReadApp = (role: MemberRole, app: AppRow, accountId: string) =>
  app.ownerAccountId === accountId || role === 'owner'

export function advancedSettingsRoutes(deps: Deps) {
  return router()
    .openapi(spaceView, async (c) => {
      const { spaceId } = c.req.valid('param')
      const role = await memberRole(deps, spaceId, c.get('console').accountId)
      if (!role) return c.json({ error: '无权访问此空间' }, 403)
      return c.json(await spaceAdvancedView(deps.db, spaceId, role === 'owner'), 200)
    })
    .openapi(spaceUpdate, async (c) => {
      const { spaceId } = c.req.valid('param')
      const role = await memberRole(deps, spaceId, c.get('console').accountId)
      if (role !== 'owner') return c.json({ error: '仅空间所有者可修改空间设置' }, 403)
      await saveSpaceAdvanced(deps.db, spaceId, c.req.valid('json'))
      return c.json(await spaceAdvancedView(deps.db, spaceId, true), 200)
    })
    .openapi(appView, async (c) => {
      const { spaceId, appId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await memberRole(deps, spaceId, accountId)
      if (!role) return c.json({ error: '无权访问此空间' }, 403)
      const app = await withSpace(deps.db, spaceId, (tx) => appOf(tx, appId))
      if (!app) return c.json({ error: '应用不存在' }, 404)
      if (!canReadApp(role, app, accountId)) {
        return c.json({ error: '仅应用所有者与空间所有者可查看' }, 403)
      }
      return c.json(
        await appAdvancedView(deps.db, spaceId, app, canEditApp(role, app, accountId)),
        200,
      )
    })
    .openapi(appUpdate, async (c) => {
      const { spaceId, appId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await memberRole(deps, spaceId, accountId)
      if (!role) return c.json({ error: '无权访问此空间' }, 403)
      const patch = c.req.valid('json')
      // 锁住应用这一行再核对所有者：核对之后、写入之前应用转给别人的话，写入要等转移提交
      const app = await withSpace(deps.db, spaceId, async (tx) => {
        const row = await appOf(tx, appId, true)
        if (!row) return 'missing' as const
        if (!canEditApp(role, row, accountId)) return 'forbidden' as const
        await saveAppAdvanced(tx, appId, patch)
        return row
      })
      if (app === 'missing') return c.json({ error: '应用不存在' }, 404)
      if (app === 'forbidden') return c.json({ error: '仅应用所有者可修改此应用' }, 403)
      return c.json(await appAdvancedView(deps.db, spaceId, app, true), 200)
    })
}
