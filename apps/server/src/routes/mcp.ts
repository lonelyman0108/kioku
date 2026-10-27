import { Hono } from 'hono'

import { requireKey } from '../auth/middleware'
import { credentialServiceForKey } from '../credential/context'
import type { AppEnv, Deps } from '../http/env'
import { handleMcpRequest } from '../mcp/server'
import { memoryServiceForKey, recallScopeForKey } from '../memory/context'

// MCP 走 Streamable HTTP：POST 发 JSON-RPC；无状态模式下不支持 GET 订阅
export function mcpRoutes(deps: Deps) {
  const app = new Hono<AppEnv>()
  app.use('/mcp', requireKey(deps))
  app.all('/mcp', (c) =>
    handleMcpRequest(
      memoryServiceForKey(deps, c.get('key')),
      recallScopeForKey(deps, c.get('key')),
      credentialServiceForKey(deps, c.get('key')),
      c.req.raw,
    ),
  )
  return app
}
