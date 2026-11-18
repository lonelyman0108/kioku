import { createRoute, z } from '@hono/zod-openapi'
import {
  EntryRecallStat,
  ErrorResponse,
  RecallEventList,
  RecallEventQuery,
  RecallStats,
} from '@kioku/contracts'

import type { Deps } from '../http/env'
import { jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'
import {
  listCircleRecallEvents,
  loadCircleRecallStats,
  loadEntryRecallStat,
} from '../recall/events'

const CircleParams = z.object({ circleId: z.uuid() })
const forbidden = jsonResponse('不是该记忆圈成员', ErrorResponse)

const stats = createRoute({
  method: 'get',
  path: '/circles/{circleId}/recall/stats',
  tags: ['console'],
  summary: '召回分析：常被召回与从没被召回的词条、各接入实例的调用量',
  request: { params: CircleParams },
  responses: { 200: jsonResponse('召回分析', RecallStats), 403: forbidden },
})

const events = createRoute({
  method: 'get',
  path: '/circles/{circleId}/recall/events',
  tags: ['console'],
  summary: '召回事件的明细：只列查看者是事件发生时的接入实例所有者的那些，最新的在前',
  request: { params: CircleParams, query: RecallEventQuery },
  responses: { 200: jsonResponse('召回事件', RecallEventList), 403: forbidden },
})

const entryStat = createRoute({
  method: 'get',
  path: '/circles/{circleId}/recall/entry',
  tags: ['console'],
  summary: '一条词条被召回的次数（保留期内的与累计的）',
  request: { params: CircleParams, query: z.object({ id: z.uuid() }) },
  responses: {
    200: jsonResponse('召回次数', EntryRecallStat),
    403: forbidden,
    404: jsonResponse('词条不存在', ErrorResponse),
  },
})

export function recallAnalysisRoutes(deps: Deps) {
  return router()
    .openapi(stats, async (c) => {
      const { circleId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, circleId, accountId)
      return c.json(
        await loadCircleRecallStats(deps.db, circleId, service.access, { accountId, role }),
        200,
      )
    })
    .openapi(events, async (c) => {
      const { circleId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, circleId, accountId)
      return c.json(
        await listCircleRecallEvents(
          deps.db,
          circleId,
          service.access,
          { accountId, role },
          c.req.valid('query'),
        ),
        200,
      )
    })
    .openapi(entryStat, async (c) => {
      const { circleId } = c.req.valid('param')
      const { service } = await consoleMemberFor(deps, circleId, c.get('console').accountId)
      return c.json(
        await loadEntryRecallStat(deps.db, circleId, service.access, c.req.valid('query').id),
        200,
      )
    })
}
