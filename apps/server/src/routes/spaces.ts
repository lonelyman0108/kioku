import { createRoute, z } from '@hono/zod-openapi'
import {
  DomainLayers,
  ErrorResponse,
  ExtractionBudget,
  ExtractionUsage,
  MemberInfo,
} from '@kioku/contracts'
import { asc, eq } from 'drizzle-orm'

import { memberRole } from '../auth/middleware'
import { accounts, spaceMembers, spaces } from '../db/schema'
import { extractionUsage, saveExtractionBudget } from '../extraction/budget'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const params = z.object({ spaceId: z.uuid() })
const forbidden = jsonResponse('没有权限', ErrorResponse)

const read = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/domain-layers',
  tags: ['console'],
  summary: '空间的 domain 默认层：管理界面新建记忆时按 domain 带出层',
  request: { params },
  responses: { 200: jsonResponse('默认层', DomainLayers), 403: forbidden },
})

const save = createRoute({
  method: 'put',
  path: '/spaces/{spaceId}/domain-layers',
  tags: ['console'],
  summary: '修改空间的 domain 默认层（只有空间 owner）',
  request: { params, body: jsonBody(DomainLayers) },
  responses: {
    200: jsonResponse('已保存', DomainLayers),
    400: jsonResponse('请求不合法', ErrorResponse),
    403: forbidden,
  },
})

const budget = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/extraction-budget',
  tags: ['console'],
  summary: '抽取预算与本月用量：每月的 token 上限、每个对象每天最多写几条事实',
  request: { params },
  responses: { 200: jsonResponse('预算与用量', ExtractionUsage), 403: forbidden },
})

const saveBudget = createRoute({
  method: 'put',
  path: '/spaces/{spaceId}/extraction-budget',
  tags: ['console'],
  summary: '修改抽取预算（只有空间 owner）：用完之后只写会话摘要，下个月恢复',
  request: { params, body: jsonBody(ExtractionBudget) },
  responses: {
    200: jsonResponse('预算与用量', ExtractionUsage),
    400: jsonResponse('请求不合法', ErrorResponse),
    403: forbidden,
  },
})

const members = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/members',
  tags: ['console'],
  summary: '空间成员：名字与角色（转移应用时选新主人用）',
  request: { params },
  responses: { 200: jsonResponse('成员列表', z.array(MemberInfo)), 403: forbidden },
})

// 空间级的设置。spaces 是身份表，不在 RLS 里，按成员关系自己检查权限
export function spaceRoutes(deps: Deps) {
  return router()
    .openapi(members, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await memberRole(deps, spaceId, c.get('console').accountId))) {
        return c.json({ error: '不是该空间成员' }, 403)
      }
      const rows = await deps.db
        .select({
          accountId: accounts.id,
          username: accounts.username,
          displayName: accounts.displayName,
          role: spaceMembers.role,
        })
        .from(spaceMembers)
        .innerJoin(accounts, eq(accounts.id, spaceMembers.accountId))
        .where(eq(spaceMembers.spaceId, spaceId))
        .orderBy(asc(spaceMembers.createdAt))
      return c.json(rows, 200)
    })
    .openapi(budget, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await memberRole(deps, spaceId, c.get('console').accountId))) {
        return c.json({ error: '不是该空间成员' }, 403)
      }
      return c.json(await extractionUsage(deps.db, spaceId), 200)
    })
    .openapi(saveBudget, async (c) => {
      const { spaceId } = c.req.valid('param')
      // 预算管的是花钱的事，和 domain 默认层一样只有空间 owner 能改
      if ((await memberRole(deps, spaceId, c.get('console').accountId)) !== 'owner') {
        return c.json({ error: '只有空间 owner 能改抽取预算' }, 403)
      }
      await saveExtractionBudget(deps.db, spaceId, c.req.valid('json'))
      return c.json(await extractionUsage(deps.db, spaceId), 200)
    })
    .openapi(read, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await memberRole(deps, spaceId, c.get('console').accountId))) {
        return c.json({ error: '不是该空间成员' }, 403)
      }
      const [row] = await deps.db
        .select({ domainLayers: spaces.domainLayers })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
      return c.json({ defaults: row?.domainLayers ?? {} }, 200)
    })
    .openapi(save, async (c) => {
      const { spaceId } = c.req.valid('param')
      if ((await memberRole(deps, spaceId, c.get('console').accountId)) !== 'owner') {
        return c.json({ error: '只有空间 owner 能改 domain 默认层' }, 403)
      }
      const { defaults } = c.req.valid('json')
      await deps.db.update(spaces).set({ domainLayers: defaults }).where(eq(spaces.id, spaceId))
      return c.json({ defaults }, 200)
    })
}
