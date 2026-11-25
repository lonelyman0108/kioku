import { createRoute } from '@hono/zod-openapi'
import { API_GENERATION, HealthResponse } from '@kioku/contracts'

import { jsonResponse, router } from '../http/openapi'
import { VERSION } from '../version'

const route = createRoute({
  method: 'get',
  path: '/health',
  tags: ['system'],
  summary: '服务健康检查',
  responses: { 200: jsonResponse('正常', HealthResponse) },
})

export const health = router().openapi(route, (c) =>
  c.json({ status: 'ok' as const, version: VERSION, api: API_GENERATION }, 200),
)
