import { createRoute } from '@hono/zod-openapi'
import { ErrorResponse, WhoAmI } from '@kioku/contracts'

import { requireKey } from '../auth/middleware'
import type { Deps } from '../http/env'
import { jsonResponse, router } from '../http/openapi'
import { whoamiOf } from '../lifecycle/handlers'

const whoami = createRoute({
  method: 'get',
  path: '/whoami',
  tags: ['auth'],
  summary: '当前 API Key 对应的空间、应用与授权上限',
  security: [{ bearer: [] }],
  responses: {
    200: jsonResponse('Key 信息', WhoAmI),
    401: jsonResponse('Key 无效', ErrorResponse),
  },
})

export function whoamiRoutes(deps: Deps) {
  const app = router()
  app.use('/whoami', requireKey(deps))
  return app.openapi(whoami, (c) => c.json(whoamiOf(c.get('key')), 200))
}
