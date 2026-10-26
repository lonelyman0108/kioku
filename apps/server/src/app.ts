import { sameOriginForCookies } from './auth/csrf'
import type { Deps } from './http/env'
import { router } from './http/openapi'
import { appRoutes } from './routes/apps'
import { authRoutes } from './routes/auth'
import { health } from './routes/health'
import { setupRoutes } from './routes/setup'
import { whoamiRoutes } from './routes/whoami'
import { VERSION } from './version'

// 应用本身与监听端口分开，测试直接调 app.request，不用起服务
export function createApp(deps: Deps) {
  const app = router()
  app.use('/v1/*', sameOriginForCookies)
  app.route('/v1', health)
  app.route('/v1', setupRoutes(deps))
  app.route('/v1', authRoutes(deps))
  app.route('/v1', appRoutes(deps))
  app.route('/v1', whoamiRoutes(deps))
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
