import { secureHeaders } from 'hono/secure-headers'

import { sameOriginForCookies } from './auth/csrf'
import { requireConsole } from './auth/middleware'
import type { Deps } from './http/env'
import { router } from './http/openapi'
import { mountWeb } from './http/web'
import { appRoutes } from './routes/apps'
import { authRoutes } from './routes/auth'
import { credentialRoutes } from './routes/credentials'
import { health } from './routes/health'
import { mcpRoutes } from './routes/mcp'
import { memoryRoutes } from './routes/memories'
import { overviewRoutes } from './routes/overview'
import { personaRoutes } from './routes/personas'
import { previewRoutes } from './routes/preview'
import { recallRoutes } from './routes/recall'
import { MemoryError } from './memory/service'
import { settingsRoutes } from './routes/settings'
import { setupRoutes } from './routes/setup'
import { spaceRoutes } from './routes/spaces'
import { whoamiRoutes } from './routes/whoami'
import { VERSION } from './version'

// 应用本身与监听端口分开，测试直接调 app.request，不用起服务
export function createApp(deps: Deps) {
  const app = router({ collapseSlashes: true })
  // 安全响应头。界面没有内联脚本；Nuxt UI 会写内联样式，所以 style-src 放开 unsafe-inline。
  // 不发 HSTS：服务自己不知道前面有没有 HTTPS，而 HSTS 会作用到整个主机名的所有端口和子域名，
  // 同一主机上别的 HTTP 服务会因此打不开，要不要发由前面的 HTTPS 反向代理决定
  app.use(
    '*',
    secureHeaders({
      strictTransportSecurity: false,
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    }),
  )
  app.use('/v1/*', sameOriginForCookies)
  app.route('/v1', health)
  app.route('/v1', setupRoutes(deps))
  app.route('/v1', authRoutes(deps))
  // 应用与人格路由共用 /spaces/*，会话鉴权在这里注册一次；各自注册会让每个请求查两次会话
  app.use('/v1/spaces/*', requireConsole(deps))
  app.route('/v1', appRoutes(deps))
  app.route('/v1', whoamiRoutes(deps))
  app.route('/v1', personaRoutes(deps))
  app.route('/v1', previewRoutes(deps))
  app.route('/v1', memoryRoutes(deps))
  app.route('/v1', credentialRoutes(deps))
  app.route('/v1', overviewRoutes(deps))
  app.route('/v1', spaceRoutes(deps))
  app.route('/v1', recallRoutes(deps))
  app.route('/v1', mcpRoutes(deps))
  app.route('/v1', settingsRoutes(deps))
  // 业务规则错误带着自己的状态码；其余错误不把内部信息透给调用方
  app.onError((err, c) => {
    if (err instanceof MemoryError) return c.json({ error: err.message }, err.status)
    console.error(err)
    return c.json({ error: '服务内部错误' }, 500)
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
  })
  // 管理界面放在 API 之后挂载，未知的 /v1 路径仍返回 404 而不是界面
  if (deps.webDir && !mountWeb(app, deps.webDir)) {
    console.warn(`没有找到管理界面的构建产物：${deps.webDir}，只提供 API`)
  }
  app.doc31('/v1/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Kioku API', version: VERSION },
  })
  return app
}
