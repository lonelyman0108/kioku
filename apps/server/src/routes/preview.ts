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
import { consoleAllCirclesAccessFor } from '../memory/context'
import { bootPreview, recallDebug } from '../recall/debug'

const KeyParams = z.object({ circleId: z.uuid(), clientId: z.uuid(), keyId: z.uuid() })
const errors = {
  403: jsonResponse('没有权限', ErrorResponse),
  404: jsonResponse('接入实例或密钥不存在，或密钥已作废', ErrorResponse),
}

const preview = createRoute({
  method: 'post',
  path: '/circles/{circleId}/clients/{clientId}/keys/{keyId}/preview',
  tags: ['clients'],
  summary: '启动预览：按这把访问密钥模拟会话开始时注入的内容（只给接入实例所有者）',
  request: { params: KeyParams, body: jsonBody(BootPreviewRequest) },
  responses: { 200: jsonResponse('启动预览', BootPreview), ...errors },
})

const debug = createRoute({
  method: 'post',
  path: '/circles/{circleId}/clients/{clientId}/keys/{keyId}/debug',
  tags: ['clients'],
  summary:
    '召回调试：按这把访问密钥模拟一句输入的召回，列出各路得分与被过滤掉的词条（只给接入实例所有者）；可以带最低分与条数试算',
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
      const memberAccess = await consoleAllCirclesAccessFor(deps, params.circleId, accountId)
      return c.json(await recallDebug(deps, found.key, memberAccess, c.req.valid('json')), 200)
    })
}
