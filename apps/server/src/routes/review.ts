import { createRoute, z } from '@hono/zod-openapi'
import {
  ErrorResponse,
  REVIEW_LAYERS,
  ReviewList,
  ReviewQuery,
  ReviewRequest,
  ReviewResult,
} from '@kioku/contracts'
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm'

import { withSpace } from '../db/client'
import {
  decodeTimeCursor,
  encodeTimeCursor,
  fromMicros,
  INVALID_CURSOR,
  microsOf,
  UUID,
} from '../db/paging'
import { memories, subjects } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'
import { readableConditions } from '../memory/filter'
import { scopeNames } from '../memory/scopes'
import { formatUri } from '../memory/uri'

const SpaceParams = z.object({ spaceId: z.uuid() })

const PAGE_SIZE = 50

const list = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/review',
  tags: ['review'],
  summary: '待审队列：不可信来源写进对象层与情节层的记忆，新的在前',
  request: { params: SpaceParams, query: ReviewQuery },
  responses: {
    200: jsonResponse('待审的记忆', ReviewList),
    400: jsonResponse('翻页参数无效', ErrorResponse),
    403: jsonResponse('不是该空间成员', ErrorResponse),
  },
})

const act = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/review',
  tags: ['review'],
  summary: '确认（来源改成主人）或删除待审的记忆',
  request: { params: SpaceParams, body: jsonBody(ReviewRequest) },
  responses: {
    200: jsonResponse('处理结果', ReviewResult),
    403: jsonResponse('没有权限', ErrorResponse),
  },
})

export function reviewRoutes(deps: Deps) {
  return router()
    .openapi(list, async (c) => {
      const { spaceId } = c.req.valid('param')
      const query = c.req.valid('query')
      const { service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      const after = decodeTimeCursor(query.cursor, UUID)
      if (after === 'invalid') return c.json({ error: INVALID_CURSOR }, 400)
      // 对象层与情节层不分人格，读权限里的人格限制用不上
      const pending = and(
        eq(memories.provenance, 'untrusted'),
        query.layer ? eq(memories.layer, query.layer) : inArray(memories.layer, REVIEW_LAYERS),
        readableConditions(service.access, { personaIds: [] }),
      )
      const page = await withSpace(deps.db, spaceId, async (tx) => {
        const rows = await tx
          .select({
            row: memories,
            subjectName: subjects.displayName,
            subjectKind: subjects.kind,
            createdMicros: sql<string>`${microsOf(memories.createdAt)}::text`,
          })
          .from(memories)
          .leftJoin(subjects, eq(subjects.id, memories.subjectId))
          .where(
            and(
              pending,
              after
                ? sql`(${memories.createdAt}, ${memories.id}) < (${fromMicros(after[0])}, ${after[1]}::uuid)`
                : undefined,
            ),
          )
          .orderBy(desc(memories.createdAt), desc(memories.id))
          .limit(PAGE_SIZE + 1)
        const [total] = await tx.select({ n: count() }).from(memories).where(pending)
        const named = await scopeNames(
          tx,
          rows.map((r) => r.row.originScope),
        )
        return { rows, total: total?.n ?? 0, named }
      })
      const items = page.rows.slice(0, PAGE_SIZE)
      const last = items.at(-1)
      return c.json(
        {
          items: items.map(({ row, subjectName, subjectKind }) => ({
            id: row.id,
            layer: row.layer as (typeof REVIEW_LAYERS)[number],
            uri: row.domain && row.path ? formatUri(row.domain, row.path) : null,
            content: row.content ?? '',
            subject:
              row.subjectId && subjectName && subjectKind
                ? { id: row.subjectId, kind: subjectKind, displayName: subjectName }
                : null,
            scope: page.named(row.originScope),
            createdAt: row.createdAt.toISOString(),
          })),
          total: page.total,
          nextCursor:
            page.rows.length > PAGE_SIZE && last
              ? encodeTimeCursor(last.createdMicros, last.row.id)
              : null,
        },
        200,
      )
    })
    .openapi(act, async (c) => {
      const { spaceId } = c.req.valid('param')
      const { role, service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      if (role === 'viewer') return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      return c.json(await service.review(c.req.valid('json')), 200)
    })
}
