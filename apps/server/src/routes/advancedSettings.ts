import { createRoute, z } from '@hono/zod-openapi'
import {
  CircleAdvancedView,
  ClientAdvancedView,
  ErrorResponse,
  UpdateCircleAdvanced,
  UpdateClientAdvanced,
  type MemberRole,
} from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'

import { memberRole } from '../auth/middleware'
import { withCircle, type Tx } from '../db/client'
import { clients } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { saveCircleAdvanced, saveClientAdvanced } from '../settings/advanced'
import { circleAdvancedView, clientAdvancedView } from '../settings/advancedViews'

// 高级设置的记忆圈与接入实例两级。实例一级在 routes/settings.ts（只给实例管理员）
const CircleParams = z.object({ circleId: z.uuid() })
const ClientParams = CircleParams.extend({ clientId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('接入实例不存在', ErrorResponse)
const invalid = jsonResponse('取值不对', ErrorResponse)

const circleView = createRoute({
  method: 'get',
  path: '/circles/{circleId}/settings/advanced',
  tags: ['circles'],
  summary:
    '记忆圈的高级设置：记忆圈的覆盖、生效值与来源、实例的生效值，以及有覆盖的接入实例（成员都能看）',
  request: { params: CircleParams },
  responses: { 200: jsonResponse('高级设置', CircleAdvancedView), 403: forbidden },
})

const circleUpdate = createRoute({
  method: 'put',
  path: '/circles/{circleId}/settings/advanced',
  tags: ['circles'],
  summary: '修改记忆圈的高级设置（只给记忆圈所有者）：只带要改的项，某项为 null 时恢复成沿用实例',
  request: { params: CircleParams, body: jsonBody(UpdateCircleAdvanced) },
  responses: {
    200: jsonResponse('高级设置', CircleAdvancedView),
    400: invalid,
    403: forbidden,
  },
})

const clientView = createRoute({
  method: 'get',
  path: '/circles/{circleId}/clients/{clientId}/settings/advanced',
  tags: ['clients'],
  summary: '接入实例的高级设置：接入实例的覆盖、生效值与来源（给接入实例所有者与记忆圈所有者）',
  request: { params: ClientParams },
  responses: {
    200: jsonResponse('高级设置', ClientAdvancedView),
    403: forbidden,
    404: notFound,
  },
})

const clientUpdate = createRoute({
  method: 'put',
  path: '/circles/{circleId}/clients/{clientId}/settings/advanced',
  tags: ['clients'],
  summary:
    '修改接入实例的高级设置（只给接入实例所有者）：只带要改的项，某项为 null 时恢复成沿用记忆圈',
  request: { params: ClientParams, body: jsonBody(UpdateClientAdvanced) },
  responses: {
    200: jsonResponse('高级设置', ClientAdvancedView),
    400: invalid,
    403: forbidden,
    404: notFound,
  },
})

type ClientRow = { id: string; runtimeFamily: string; ownerAccountId: string }

async function clientOf(
  tx: Tx,
  circleId: string,
  clientId: string,
  lock = false,
): Promise<ClientRow | undefined> {
  const query = tx
    .select({
      id: clients.id,
      runtimeFamily: clients.runtimeFamily,
      ownerAccountId: clients.ownerAccountId,
    })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.circleId, circleId)))
  const [row] = await (lock ? query.for('update') : query)
  return row
}

// 接入实例的配置只有接入实例所有者能改（和修改接入实例一样，还要是能管理接入实例的角色）；记忆圈所有者能看
const canEditClient = (role: MemberRole, client: ClientRow, accountId: string) =>
  client.ownerAccountId === accountId && (role === 'owner' || role === 'editor')
const canReadClient = (role: MemberRole, client: ClientRow, accountId: string) =>
  client.ownerAccountId === accountId || role === 'owner'

export function advancedSettingsRoutes(deps: Deps) {
  return router()
    .openapi(circleView, async (c) => {
      const { circleId } = c.req.valid('param')
      const role = await memberRole(deps, circleId, c.get('console').accountId)
      if (!role) return c.json({ error: '无权访问此记忆圈' }, 403)
      return c.json(await circleAdvancedView(deps.db, circleId, role === 'owner'), 200)
    })
    .openapi(circleUpdate, async (c) => {
      const { circleId } = c.req.valid('param')
      const role = await memberRole(deps, circleId, c.get('console').accountId)
      if (role !== 'owner') return c.json({ error: '仅记忆圈所有者可修改记忆圈设置' }, 403)
      await saveCircleAdvanced(deps.db, circleId, c.req.valid('json'))
      return c.json(await circleAdvancedView(deps.db, circleId, true), 200)
    })
    .openapi(clientView, async (c) => {
      const { circleId, clientId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await memberRole(deps, circleId, accountId)
      if (!role) return c.json({ error: '无权访问此记忆圈' }, 403)
      const client = await withCircle(deps.db, circleId, (tx) => clientOf(tx, circleId, clientId))
      if (!client) return c.json({ error: '接入实例不存在' }, 404)
      if (!canReadClient(role, client, accountId)) {
        return c.json({ error: '仅接入实例所有者与记忆圈所有者可查看' }, 403)
      }
      return c.json(
        await clientAdvancedView(deps.db, circleId, client, canEditClient(role, client, accountId)),
        200,
      )
    })
    .openapi(clientUpdate, async (c) => {
      const { circleId, clientId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await memberRole(deps, circleId, accountId)
      if (!role) return c.json({ error: '无权访问此记忆圈' }, 403)
      const patch = c.req.valid('json')
      // 锁住接入实例这一行再核对所有者：核对之后、写入之前转给别人的话，写入要等转移提交
      const client = await withCircle(deps.db, circleId, async (tx) => {
        const row = await clientOf(tx, circleId, clientId, true)
        if (!row) return 'missing' as const
        if (!canEditClient(role, row, accountId)) return 'forbidden' as const
        await saveClientAdvanced(tx, clientId, patch)
        return row
      })
      if (client === 'missing') return c.json({ error: '接入实例不存在' }, 404)
      if (client === 'forbidden') return c.json({ error: '仅接入实例所有者可修改此接入实例' }, 403)
      return c.json(await clientAdvancedView(deps.db, circleId, client, true), 200)
    })
}
