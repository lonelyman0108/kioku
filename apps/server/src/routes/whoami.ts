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
  summary:
    '当前访问密钥对应的主场圈、关联客场圈、接入实例、人格、解析后的在场切面、可见词表与授权上限',
  security: [{ bearer: [] }],
  responses: {
    200: jsonResponse('Key 信息', WhoAmI),
    401: jsonResponse('Key 无效', ErrorResponse),
  },
})

export function whoamiRoutes(deps: Deps) {
  const app = router()
  app.use('/whoami', requireKey(deps))
  return app.openapi(whoami, async (c) => c.json(await whoamiOf(deps, c.get('key')), 200))
}
