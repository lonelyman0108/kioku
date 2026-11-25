import { API_GENERATION, DATABASE_UNAVAILABLE_CODE } from '@kioku/contracts'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'

import { sameOriginForCookies } from './auth/csrf'
import { requireConsole } from './auth/middleware'
import { CredentialService } from './credential/service'
import { logInternalError } from './db/client'
import type { Deps, SetupHost } from './http/env'
import { router } from './http/openapi'
import { isApiPath, mountWeb } from './http/web'
import { MemoryError } from './memory/errors'
import { EntryService } from './memory/service'
import { authRoutes } from './routes/auth'
import { credentialRoutes } from './routes/credentials'
import { deviceRoutes } from './routes/device'
import { dreamRoutes } from './routes/dream'
import { health } from './routes/health'
import { keyRoutes } from './routes/keys'
import { mcpRoutes } from './routes/mcp'
import { memoryRoutes } from './routes/memories'
import { recallRoutes } from './routes/recall'
import { settingsRoutes } from './routes/settings'
import { setupDatabaseRoutes, setupRoutes, setupStatusRoutes } from './routes/setup'
import { transferRoutes } from './routes/transfer'
import { whoamiRoutes } from './routes/whoami'
import { VERSION } from './version'

const REQUEST_ERRORS: Partial<Record<number, string>> = {
  400: '请求格式错误',
  413: '请求体过大',
  415: '请求体类型（Content-Type）错误',
}
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding']

function requestError(c: Context, err: HTTPException): Response {
  const headers = new Headers(err.getResponse().headers)
  for (const name of BODY_HEADERS) headers.delete(name)
  return c.json(
    { error: REQUEST_ERRORS[err.status] ?? '请求不合法' },
    { status: err.status, headers },
  )
}

type App = ReturnType<typeof router>

function shell(): App {
  const app = router({ collapseSlashes: true })
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
  return app
}

function finish(app: App, webDir: string | undefined): void {
  app.onError((err, c) => {
    if (err instanceof MemoryError) {
      return c.json(
        {
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
        },
        err.status,
      )
    }
    if (err instanceof HTTPException && err.status < 500) return requestError(c, err)
    logInternalError('接口内部错误', err)
    return c.json({ error: '服务内部错误' }, 500)
  })
  app.notFound((c) =>
    isApiPath(c.req.path) ? c.json({ error: '接口不存在' }, 404) : c.text('404 Not Found', 404),
  )
  if (webDir && !mountWeb(app, webDir)) {
    console.warn(`没有找到管理界面的构建产物：${webDir}，只提供 API`)
  }
}

export function createApp(deps: Deps) {
  const app = shell()
  const credentials = new CredentialService(deps.db, deps.masterKey)
  const entries = new EntryService(deps.db, deps.masterKey, credentials, deps.jobs)

  app.route('/v1', health)
  app.route('/v1', setupRoutes(deps))
  app.route('/v1', authRoutes(deps))

  // 控制台所有资源统一挂在 /v1/console/*，由单一会话中间件鉴权
  app.use('/v1/console/*', requireConsole(deps))
  app.route('/v1', memoryRoutes(entries))
  app.route('/v1', dreamRoutes(deps, entries))
  app.route('/v1', credentialRoutes(deps, credentials))
  app.route('/v1', keyRoutes(deps))
  app.route('/v1', settingsRoutes(deps))
  app.route('/v1', transferRoutes(deps))
  app.route('/v1', deviceRoutes(deps))

  // 接入方与命令行接口（Bearer 访问密钥鉴权）
  app.route('/v1', recallRoutes(deps))
  app.route('/v1', mcpRoutes(deps, entries, credentials))
  app.route('/v1', whoamiRoutes(deps))

  finish(app, deps.webDir)
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

export function createSetupApp(options: {
  host: SetupHost
  trustedProxies: number
  webDir?: string
}) {
  const { host, trustedProxies } = options
  const app = shell()
  const needsSetup = () => Promise.resolve(host.database().state === 'missing')

  app.get('/v1/health', (c) =>
    host.database().state === 'unavailable'
      ? c.json(
          { status: 'unavailable', version: VERSION, api: API_GENERATION, database: 'unavailable' },
          503,
        )
      : c.json({ status: 'ok', version: VERSION, api: API_GENERATION }, 200),
  )
  app.route('/v1', setupStatusRoutes(host, needsSetup))
  app.route('/v1', setupDatabaseRoutes(host, trustedProxies, needsSetup))
  app.all('/v1/*', (c) =>
    c.json(
      {
        error: host.database().state === 'missing' ? '数据库尚未配置' : '数据库暂时无法连接',
        code: DATABASE_UNAVAILABLE_CODE,
      },
      503,
    ),
  )
  finish(app, options.webDir)
  return app
}
