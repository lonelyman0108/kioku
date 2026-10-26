import { OpenAPIHono } from '@hono/zod-openapi'

import { health } from './routes/health'
import { VERSION } from './version'

// 应用本身与监听端口分开，测试直接调 app.request，不用起服务
export function createApp() {
  const app = new OpenAPIHono()
  app.route('/v1', health)
  app.doc31('/v1/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Kioku API', version: VERSION },
  })
  return app
}
