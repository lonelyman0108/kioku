import { createRoute, z } from '@hono/zod-openapi'
import {
  BootPreview,
  BootPreviewRequest,
  ErrorResponse,
  RecallDebug,
  RecallDebugRequest,
} from '@kioku/contracts'

import { keyToSimulate } from '../access/simulate'
import type { Deps } from '../http/env'
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

export function previewRoutes(deps: Deps) {
  return router()
    .openapi(preview, async (c) => {
      const found = await keyToSimulate(deps, c.req.valid('param'), c.get('console').accountId)
      if ('error' in found) return c.json({ error: found.error }, found.status)
      return c.json(await bootPreview(deps, found.key, c.req.valid('json')), 200)
    })
    .openapi(debug, async (c) => {
      const accountId = c.get('console').accountId
      const params = c.req.valid('param')
      const found = await keyToSimulate(deps, params, accountId)
      if ('error' in found) return c.json({ error: found.error }, found.status)
      // 管理界面里搜得到的范围按查看者本人（就是应用主人）的权限
      const { service } = await consoleMemberFor(deps, params.spaceId, accountId)
      return c.json(
        await recallDebug(deps, found.key, service.access, c.req.valid('json').query),
        200,
      )
    })
}
