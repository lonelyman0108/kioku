import { createRoute, z } from '@hono/zod-openapi'
import {
  ErrorResponse,
  ReviewList,
  ReviewQuery,
  ReviewRequest,
  ReviewResult,
} from '@kioku/contracts'

import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'

const CircleParams = z.object({ circleId: z.uuid() })

const list = createRoute({
  method: 'get',
  path: '/circles/{circleId}/review',
  tags: ['review'],
  summary: '待审队列：不可信来源写进联系人的事实与会话摘要，新的在前',
  request: { params: CircleParams, query: ReviewQuery },
  responses: {
    200: jsonResponse('待审的词条', ReviewList),
    400: jsonResponse('翻页参数无效', ErrorResponse),
    403: jsonResponse('不是该记忆圈成员', ErrorResponse),
  },
})

const act = createRoute({
  method: 'post',
  path: '/circles/{circleId}/review',
  tags: ['review'],
  summary: '确认（来源改成所有者）或删除待审的词条',
  request: { params: CircleParams, body: jsonBody(ReviewRequest) },
  responses: {
    200: jsonResponse('处理结果', ReviewResult),
    403: jsonResponse('没有权限', ErrorResponse),
  },
})

export function reviewRoutes(deps: Deps) {
  return router()
    .openapi(list, async (c) => {
      const { circleId } = c.req.valid('param')
      const { service } = await consoleMemberFor(deps, circleId, c.get('console').accountId)
      return c.json(await service.reviewList(c.req.valid('query')), 200)
    })
    .openapi(act, async (c) => {
      const { circleId } = c.req.valid('param')
      const { role, service } = await consoleMemberFor(deps, circleId, c.get('console').accountId)
      if (role === 'viewer') return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      return c.json(await service.review(c.req.valid('json')), 200)
    })
}
