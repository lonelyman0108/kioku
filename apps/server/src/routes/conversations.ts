import { createRoute, z } from '@hono/zod-openapi'
import {
  ConversationDetail,
  ConversationList,
  ConversationListQuery,
  ErrorResponse,
} from '@kioku/contracts'
import { and, eq, sql } from 'drizzle-orm'

import { conversationDetail, conversationInfos } from '../access/conversations'
import { isInstanceAdmin } from '../auth/middleware'
import { withSpace } from '../db/client'
import { decodeTimeCursor, encodeTimeCursor, fromMicros, INVALID_CURSOR, UUID } from '../db/paging'
import { conversations } from '../db/schema'
import { plainRunError } from '../extraction/extract'
import type { Deps } from '../http/env'
import { jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'

// 对话页的会话分页：会话列表（按最近活动）与会话详情（摘要的时间线、在这里记下的事实、抽取记录）

const SpaceParams = z.object({ spaceId: z.uuid() })
const ConversationParams = SpaceParams.extend({ conversationId: z.uuid() })
const forbidden = jsonResponse('没有权限', ErrorResponse)
const PAGE_SIZE = 50

const list = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/conversations',
  tags: ['conversations'],
  summary: '列出会话，最近活动的在前；可按应用或联系人筛',
  request: { params: SpaceParams, query: ConversationListQuery },
  responses: {
    200: jsonResponse('会话列表', ConversationList),
    400: jsonResponse('翻页参数无效', ErrorResponse),
    403: forbidden,
  },
})

const detail = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/conversations/{conversationId}',
  tags: ['conversations'],
  summary: '会话详情：会话摘要的时间线、在这里记下的事实与抽取记录',
  request: { params: ConversationParams },
  responses: {
    200: jsonResponse('会话详情', ConversationDetail),
    403: forbidden,
    404: jsonResponse('不存在', ErrorResponse),
  },
})

export function conversationRoutes(deps: Deps) {
  return router()
    .openapi(list, async (c) => {
      const { spaceId } = c.req.valid('param')
      const query = c.req.valid('query')
      const { service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      const after = decodeTimeCursor(query.cursor, UUID)
      if (after === 'invalid') return c.json({ error: INVALID_CURSOR }, 400)
      const page = await withSpace(deps.db, spaceId, (tx) =>
        conversationInfos(
          tx,
          service.access,
          and(
            query.appId ? eq(conversations.appId, query.appId) : undefined,
            query.subjectId ? eq(conversations.subjectId, query.subjectId) : undefined,
            after
              ? sql`(${conversations.lastActiveAt}, ${conversations.id}) < (${fromMicros(after[0])}, ${after[1]}::uuid)`
              : undefined,
          ),
          PAGE_SIZE + 1,
        ),
      )
      const items = page.slice(0, PAGE_SIZE)
      const last = items.at(-1)
      return c.json(
        {
          items: items.map((r) => r.info),
          nextCursor:
            page.length > PAGE_SIZE && last
              ? encodeTimeCursor(last.activeMicros, last.info.id)
              : null,
        },
        200,
      )
    })
    .openapi(detail, async (c) => {
      const { spaceId, conversationId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const { service } = await consoleMemberFor(deps, spaceId, accountId)
      const admin = await isInstanceAdmin(deps.db, accountId)
      // 失败原因的原文只给实例管理员看，和联系人详情一样（见 routes/subjects.ts）
      const errorOf = (stored: string | null) => {
        if (!stored) return stored
        return plainRunError(stored) ?? (admin ? stored : '抽取失败（原因仅实例管理员可见）')
      }
      const result = await withSpace(deps.db, spaceId, (tx) =>
        conversationDetail(tx, service.access, conversationId, errorOf),
      )
      if (!result) return c.json({ error: '会话不存在' }, 404)
      return c.json(result, 200)
    })
}
