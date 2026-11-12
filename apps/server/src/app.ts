import { DATABASE_UNAVAILABLE_CODE } from '@kioku/contracts'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'

import { sameOriginForCookies } from './auth/csrf'
import { requireConsole } from './auth/middleware'
import { logInternalError } from './db/client'
import type { Deps, SetupHost } from './http/env'
import { router } from './http/openapi'
import { isApiPath, mountWeb } from './http/web'
import { accountRoutes } from './routes/accounts'
import { advancedSettingsRoutes } from './routes/advancedSettings'
import { appRoutes } from './routes/apps'
import { authRoutes } from './routes/auth'
import { benchRoutes } from './routes/bench'
import { bindingRoutes } from './routes/binding'
import { credentialRoutes } from './routes/credentials'
import { deviceRoutes } from './routes/device'
import { dreamRoutes } from './routes/dream'
import { health } from './routes/health'
import { loreImportRoutes } from './routes/loreImport'
import { mcpRoutes } from './routes/mcp'
import { memoryRoutes } from './routes/memories'
import { overviewRoutes } from './routes/overview'
import { personaRoutes } from './routes/personas'
import { previewRoutes } from './routes/preview'
import { recallAnalysisRoutes } from './routes/recallAnalysis'
import { recallRoutes } from './routes/recall'
import { reviewRoutes } from './routes/review'
import { MemoryError } from './memory/service'
import { settingsRoutes } from './routes/settings'
import { setupDatabaseRoutes, setupRoutes, setupStatusRoutes } from './routes/setup'
import { instanceSpaceRoutes, spaceRoutes } from './routes/spaces'
import { subjectRoutes } from './routes/subjects'
import { conversationRoutes } from './routes/conversations'
import { whoamiRoutes } from './routes/whoami'
import { VERSION } from './version'

// hono 在读请求时判出的问题：请求体不是合法的 JSON、表单解析不了（400），请求体超过上限（413），
// Content-Type 和接口收的不一样、或者有请求体却没写 Content-Type（415）
const REQUEST_ERRORS: Partial<Record<number, string>> = {
  400: '请求格式错误',
  413: '请求体过大',
  415: '请求体类型（Content-Type）错误',
}
// 自带响应里只有这些跟着原来的正文走，换成 { error } 之后不再沿用
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding']

// 请求本身的问题（依赖库抛出的 4xx）：状态码与响应头沿用它的（getResponse 给出，例如 Retry-After、
// WWW-Authenticate），正文换成和别的错误一样的 { error }，按状态码给中文说明。它自带的说明不给调用方：
// 应用自己不抛带说明的 HTTPException，说明都来自依赖库，是英文的，也可能带着内部细节
function requestError(c: Context, err: HTTPException): Response {
  const headers = new Headers(err.getResponse().headers)
  for (const name of BODY_HEADERS) headers.delete(name)
  return c.json(
    { error: REQUEST_ERRORS[err.status] ?? '请求不合法' },
    { status: err.status, headers },
  )
}

type App = ReturnType<typeof router>

// 完整服务与只做初始化的应用共用的外层：安全响应头与同源检查
function shell(): App {
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
  return app
}

// 两者共用的收尾：错误处理、未知路径、管理界面
function finish(app: App, webDir: string | undefined): void {
  // 业务规则错误带着自己的状态码；请求本身的问题（依赖库抛出的 4xx）是调用方的错，不打堆栈（见 requestError）；
  // 其余错误不把内部信息透给调用方，日志也不带 SQL 与参数（参数可能就是记忆正文，见 logInternalError）
  app.onError((err, c) => {
    if (err instanceof MemoryError) {
      // 新增的疑似明文被拒时带上每一处的行号与类别（MemoryWriteError）；凭据写入失败时带上原因，
      // 写进了密码库、凭据却没建成时带上留下的条目（CredentialWriteError）
      const body = {
        error: err.message,
        ...(err.plaintext ? { plaintext: err.plaintext } : {}),
        ...(err.write?.reason ? { reason: err.write.reason } : {}),
        ...(err.write?.vaultItem ? { vaultItem: err.write.vaultItem } : {}),
      }
      return c.json(body, err.status)
    }
    if (err instanceof HTTPException && err.status < 500) return requestError(c, err)
    logInternalError('接口内部错误', err)
    return c.json({ error: '服务内部错误' }, 500)
  })
  // /v1 下没有匹配的路由（路径不存在，或者路径对、方法不对）时和别的错误一样回 { error }；
  // 别的路径照旧是纯文本的 404，管理界面的页面路由由 mountWeb 回 index.html，走不到这里
  app.notFound((c) =>
    isApiPath(c.req.path) ? c.json({ error: '接口不存在' }, 404) : c.text('404 Not Found', 404),
  )
  // 管理界面放在 API 之后挂载，未知的 /v1 路径仍是上面 JSON 的 404 而不是界面
  if (webDir && !mountWeb(app, webDir)) {
    console.warn(`没有找到管理界面的构建产物：${webDir}，只提供 API`)
  }
}

// 应用本身与监听端口分开，测试直接调 app.request，不用起服务
export function createApp(deps: Deps) {
  const app = shell()
  app.route('/v1', health)
  app.route('/v1', setupRoutes(deps))
  app.route('/v1', authRoutes(deps))
  app.route('/v1', accountRoutes(deps))
  // 应用与人格路由共用 /spaces/*，会话鉴权在这里注册一次；各自注册会让每个请求查两次会话
  app.use('/v1/spaces/*', requireConsole(deps))
  app.route('/v1', appRoutes(deps))
  app.route('/v1', whoamiRoutes(deps))
  app.route('/v1', personaRoutes(deps))
  app.route('/v1', previewRoutes(deps))
  app.route('/v1', recallAnalysisRoutes(deps))
  app.route('/v1', memoryRoutes(deps))
  app.route('/v1', credentialRoutes(deps))
  app.route('/v1', overviewRoutes(deps))
  app.route('/v1', spaceRoutes(deps))
  app.route('/v1', loreImportRoutes(deps))
  app.route('/v1', subjectRoutes(deps))
  app.route('/v1', conversationRoutes(deps))
  app.route('/v1', reviewRoutes(deps))
  app.route('/v1', dreamRoutes(deps))
  app.route('/v1', recallRoutes(deps))
  app.route('/v1', bindingRoutes(deps))
  app.route('/v1', mcpRoutes(deps))
  app.route('/v1', settingsRoutes(deps))
  app.route('/v1', instanceSpaceRoutes(deps))
  app.route('/v1', advancedSettingsRoutes(deps))
  // 放在接入方的路由后面：OpenAPI 的组件按第一次用到的顺序排，Python SDK 的比对对顺序敏感，
  // 测试台的响应用到了 TurnEndEvent 这些接入方的组件
  // 浏览器授权的响应引用了 AppInfo：挂在 Key 鉴权的接口后面，不改变 OpenAPI 里组件的顺序
  app.route('/v1', deviceRoutes(deps))
  app.route('/v1', benchRoutes(deps))
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

// 没接上数据库时的应用：只有健康检查、初始化的状态与数据库这一步，加上管理界面；
// 别的接口回 503 并带 DATABASE_UNAVAILABLE_CODE，管理界面据此回到初始化页
export function createSetupApp(options: {
  host: SetupHost
  trustedProxies: number
  webDir?: string
}) {
  const { host, trustedProxies } = options
  const app = shell()
  // 没接上数据库：等人填库（missing）时要初始化；暂时连不上（unavailable）时不知道，按不要算
  const needsSetup = () => Promise.resolve(host.database().state === 'missing')
  // 等人初始化时服务是好的，健康检查照常 200；配了的库暂时连不上时回 503，容器的健康检查与编排看得到
  app.get('/v1/health', (c) =>
    host.database().state === 'unavailable'
      ? c.json({ status: 'unavailable', version: VERSION, database: 'unavailable' }, 503)
      : c.json({ status: 'ok', version: VERSION }, 200),
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
