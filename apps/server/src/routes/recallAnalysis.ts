import { createRoute, z } from '@hono/zod-openapi'
import {
  ErrorResponse,
  MemoryRecallStat,
  RecallEventList,
  RecallEventQuery,
  RecallStats,
  type AppRecallVolume,
  type RecallSource,
} from '@kioku/contracts'
import { count, eq } from 'drizzle-orm'

import { withSpace } from '../db/client'
import { apps, recallEvents } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'
import { loadRecallSettings, recallRecordingSince } from '../recall/retention'

const SpaceParams = z.object({ spaceId: z.uuid() })
const forbidden = jsonResponse('不是该空间成员', ErrorResponse)
const TOP_LIMIT = 20
const NEVER_LIMIT = 50
const EVENT_PAGE = 50

const stats = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/recall/stats',
  tags: ['console'],
  summary: '召回分析：常被召回与从没被召回的记忆、各应用的调用量',
  request: { params: SpaceParams },
  responses: { 200: jsonResponse('召回分析', RecallStats), 403: forbidden },
})

const events = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/recall/events',
  tags: ['console'],
  summary: '召回事件的明细：只列查看者是事件发生时的应用主人的那些，最新的在前',
  request: { params: SpaceParams, query: RecallEventQuery },
  responses: { 200: jsonResponse('召回事件', RecallEventList), 403: forbidden },
})

const memoryStat = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/recall/memory',
  tags: ['console'],
  summary: '一条记忆被召回的次数（保留期内的与累计的）',
  request: { params: SpaceParams, query: z.object({ id: z.uuid() }) },
  responses: {
    200: jsonResponse('召回次数', MemoryRecallStat),
    403: forbidden,
    404: jsonResponse('记忆不存在', ErrorResponse),
  },
})

export function recallAnalysisRoutes(deps: Deps) {
  return router()
    .openapi(stats, async (c) => {
      const { spaceId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, spaceId, accountId)
      const [{ retentionDays }, recordingSince] = await Promise.all([
        loadRecallSettings(deps.db),
        recallRecordingSince(deps.db),
      ])
      const [ranking, rows] = await Promise.all([
        service.recallRanking(
          { top: TOP_LIMIT, never: NEVER_LIMIT },
          { retentionDays, recordingSince },
        ),
        withSpace(deps.db, spaceId, (tx) =>
          tx
            .select({
              appId: recallEvents.appId,
              source: recallEvents.source,
              n: count(),
              name: apps.name,
              owner: apps.ownerAccountId,
            })
            .from(recallEvents)
            .leftJoin(apps, eq(apps.id, recallEvents.appId))
            .groupBy(recallEvents.appId, recallEvents.source, apps.name, apps.ownerAccountId),
        ),
      ])
      // 各应用的调用量和 Key 一样，只给应用主人与空间 owner；应用删掉之后只有空间 owner 看得到
      const volumes = new Map<string, AppRecallVolume>()
      for (const row of rows) {
        if (role !== 'owner' && row.owner !== accountId) continue
        const volume = volumes.get(row.appId) ?? {
          appId: row.appId,
          name: row.name,
          total: 0,
          sources: [],
        }
        volume.total += row.n
        volume.sources.push({ source: row.source as RecallSource, count: row.n })
        volumes.set(row.appId, volume)
      }
      return c.json(
        {
          retentionDays,
          recordingSince: recordingSince?.toISOString() ?? null,
          apps: [...volumes.values()].sort((a, b) => b.total - a.total),
          ...ranking,
        },
        200,
      )
    })
    .openapi(events, async (c) => {
      const { spaceId } = c.req.valid('param')
      const { service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      return c.json(await service.recallEvents(c.req.valid('query'), EVENT_PAGE), 200)
    })
    .openapi(memoryStat, async (c) => {
      const { spaceId } = c.req.valid('param')
      const { service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      return c.json(await service.recallStat(c.req.valid('query').id), 200)
    })
}
