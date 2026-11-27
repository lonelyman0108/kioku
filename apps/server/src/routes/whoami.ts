import { createRoute } from '@hono/zod-openapi'
import { ErrorResponse, WhoAmIResponse } from '@kioku/contracts'

import { requireKey } from '../auth/middleware'
import { accounts } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonResponse, router } from '../http/openapi'

const route = createRoute({
  method: 'get',
  path: '/whoami',
  tags: ['agent'],
  security: [{ bearer: [] }],
  summary: '查看当前访问密钥的终端透镜与授权边界',
  responses: {
    200: jsonResponse('密钥身份与权限', WhoAmIResponse),
    401: jsonResponse('访问密钥无效', ErrorResponse),
  },
})

export function whoamiRoutes(deps: Deps) {
  const app = router()
  app.use('/whoami', requireKey(deps))
  return app.openapi(route, async (c) => {
    const key = c.get('key')
    const [owner] = await deps.db
      .select({ displayName: accounts.displayName })
      .from(accounts)
      .limit(1)
    return c.json(
      {
        accountName: owner?.displayName ?? 'Owner',
        key: {
          id: key.keyId,
          name: key.name,
          prefix: key.prefix,
          runtimeFamily: key.runtimeFamily,
          envs: [...key.envs],
          allowedRealms: key.allowedRealms ? [...key.allowedRealms] : null,
          focusRealms: key.focusRealms ? [...key.focusRealms] : null,
          canWrite: key.canWrite,
          canResolveCredentials: key.canResolveCredentials,
        },
        client: {
          slug: key.runtimeFamily,
          name: key.name,
          runtimeFamily: key.runtimeFamily,
        },
        primaryCircle: {
          slug: 'default',
          name: 'Kioku',
          kind: 'personal' as const,
        },
      },
      200,
    )
  })
}
