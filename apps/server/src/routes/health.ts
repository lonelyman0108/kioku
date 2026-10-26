import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { HealthResponse } from '@kioku/contracts'

import { VERSION } from '../version'

const route = createRoute({
  method: 'get',
  path: '/health',
  tags: ['system'],
  summary: '存活检查',
  responses: {
    200: {
      description: '服务可用',
      content: { 'application/json': { schema: HealthResponse } },
    },
  },
})

export const health = new OpenAPIHono().openapi(route, (c) =>
  c.json({ status: 'ok' as const, version: VERSION }, 200),
)
