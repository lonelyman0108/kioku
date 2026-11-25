import { Hono } from 'hono'

import { requireKey } from '../auth/middleware'
import type { CredentialService } from '../credential/service'
import type { AppEnv, Deps } from '../http/env'
import { handleMcpRequest } from '../mcp/server'
import type { EntryService } from '../memory/service'

// MCP 走 Streamable HTTP：POST 发 JSON-RPC；无状态模式拒绝 GET 订阅回 405，避免客户端高频重连
export function mcpRoutes(deps: Deps, entries: EntryService, credentials: CredentialService) {
  const app = new Hono<AppEnv>()
  app.use('/mcp', requireKey(deps))
  app.get('/mcp', (c) => c.json({ error: '不支持 GET 订阅' }, 405, { allow: 'POST' }))
  app.all('/mcp', (c) => handleMcpRequest(deps, c.get('key'), entries, credentials, c.req.raw))
  return app
}
