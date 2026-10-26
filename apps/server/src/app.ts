import { sameOriginForCookies } from './auth/csrf'
import { requireConsole } from './auth/middleware'
import type { Deps } from './http/env'
import { router } from './http/openapi'
import { appRoutes } from './routes/apps'
import { authRoutes } from './routes/auth'
import { health } from './routes/health'
import { mcpRoutes } from './routes/mcp'
import { memoryRoutes } from './routes/memories'
import { personaRoutes } from './routes/personas'
import { recallRoutes } from './routes/recall'
import { MemoryError } from './memory/service'
import { settingsRoutes } from './routes/settings'
import { setupRoutes } from './routes/setup'
import { whoamiRoutes } from './routes/whoami'
import { VERSION } from './version'

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pg = ((err as { cause?: unknown })?.cause ?? err) as {
    code?: string
    constraint_name?: string
  }
  return pg.code === '23505' && pg.constraint_name === constraint
}

// 应用本身与监听端口分开，测试直接调 app.request，不用起服务
export function createApp(deps: Deps) {
  const app = router()
  app.use('/v1/*', sameOriginForCookies)
  app.route('/v1', health)
  app.route('/v1', setupRoutes(deps))
  app.route('/v1', authRoutes(deps))
  // 应用与人格路由共用 /spaces/*，会话鉴权在这里注册一次；各自注册会让每个请求查两次会话
  app.use('/v1/spaces/*', requireConsole(deps))
  app.route('/v1', appRoutes(deps))
  app.route('/v1', whoamiRoutes(deps))
  app.route('/v1', personaRoutes(deps))
  app.route('/v1', memoryRoutes(deps))
  app.route('/v1', recallRoutes(deps))
  app.route('/v1', mcpRoutes(deps))
  app.route('/v1', settingsRoutes(deps))
  // 业务规则错误带着自己的状态码；其余错误不把内部信息透给调用方
  app.onError((err, c) => {
    if (err instanceof MemoryError) return c.json({ error: err.message }, err.status)
    // URI 唯一约束的兜底：正常情况下 claimUri 已用咨询锁串行化，这里只防遗漏的写入路径
    if (isUniqueViolation(err, 'memories_uri_live_idx'))
      return c.json({ error: 'URI 已被占用' }, 409)
    console.error(err)
    return c.json({ error: '服务内部错误' }, 500)
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
  })
  app.doc31('/v1/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Kioku API', version: VERSION },
  })
  return app
}
