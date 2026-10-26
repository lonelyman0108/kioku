import { createRoute, z } from '@hono/zod-openapi'
import { CreatePersonaRequest, ErrorResponse, PersonaInfo } from '@kioku/contracts'
import { asc, eq } from 'drizzle-orm'

import { memberRole } from '../auth/middleware'
import { withSpace } from '../db/client'
import { personas } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const SpaceParams = z.object({ spaceId: z.uuid() })

const toInfo = (row: typeof personas.$inferSelect) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  extendsId: row.extendsId,
  description: row.description,
})

const list = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/personas',
  tags: ['personas'],
  summary: '列出空间里的人格',
  request: { params: SpaceParams },
  responses: {
    200: jsonResponse('人格列表', z.array(PersonaInfo)),
    403: jsonResponse('没有权限', ErrorResponse),
  },
})

const create = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/personas',
  tags: ['personas'],
  summary: '新建人格，可以继承另一个人格',
  request: { params: SpaceParams, body: jsonBody(CreatePersonaRequest) },
  responses: {
    201: jsonResponse('已创建', PersonaInfo),
    403: jsonResponse('没有权限', ErrorResponse),
    404: jsonResponse('被继承的人格不存在', ErrorResponse),
    409: jsonResponse('标识已被占用', ErrorResponse),
  },
})

export function personaRoutes(deps: Deps) {
  const app = router()
  return app
    .openapi(list, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await memberRole(deps, spaceId, c.get('console').accountId))) {
        return c.json({ error: '不是该空间成员' }, 403)
      }
      const rows = await withSpace(deps.db, spaceId, (tx) =>
        tx.select().from(personas).orderBy(asc(personas.createdAt)),
      )
      return c.json(rows.map(toInfo), 200)
    })
    .openapi(create, async (c) => {
      const { spaceId } = c.req.valid('param')
      const role = await memberRole(deps, spaceId, c.get('console').accountId)
      if (role !== 'owner' && role !== 'editor') {
        return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      }
      const body = c.req.valid('json')
      const rows = await withSpace(deps.db, spaceId, async (tx) => {
        // 外键检查不受 RLS 约束，被继承的人格必须在 RLS 下可见，也就是同一空间
        if (body.extendsId) {
          const [parent] = await tx
            .select({ id: personas.id })
            .from(personas)
            .where(eq(personas.id, body.extendsId))
          if (!parent) return null
        }
        return tx
          .insert(personas)
          .values({ spaceId, ...body })
          .onConflictDoNothing()
          .returning()
      })
      if (!rows) return c.json({ error: '被继承的人格不存在' }, 404)
      if (!rows[0]) return c.json({ error: '人格标识已被占用' }, 409)
      return c.json(toInfo(rows[0]), 201)
    })
}
