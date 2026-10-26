import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { serveStatic } from '@hono/node-server/serve-static'
import type { OpenAPIHono } from '@hono/zod-openapi'

import type { AppEnv } from './env'

// 托管管理界面的构建产物：单个容器同时提供 API 与界面，同源访问，登录用 Cookie 会话。
// 带哈希的资源文件长期缓存；其他非 /v1 的 GET 请求都返回 index.html，交给前端路由
export function mountWeb(app: OpenAPIHono<AppEnv>, webDir: string): boolean {
  const indexFile = join(webDir, 'index.html')
  if (!existsSync(indexFile)) return false
  const index = readFileSync(indexFile, 'utf8')

  // serveStatic 的 onFound 在响应构造之后才调用，在那里设置的头不会生效，所以先设置再交给它；
  // 找不到文件时会落到下面的 index.html，那里会把 Cache-Control 改回 no-cache
  // 找不到的资源文件返回 404，不回退到 index.html：升级后旧标签页按旧哈希加载模块时，
  // 拿到 HTML 只会报难懂的 MIME 错误，代理和日志也会记成成功
  const assets = serveStatic({ root: webDir })
  app.get('/assets/*', async (c) => {
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
    const found = await assets(c, async () => {})
    if (found) return found
    c.header('Cache-Control', 'no-store')
    return c.text('Not Found', 404)
  })
  app.get('*', async (c, next) => {
    if (c.req.path === '/v1' || c.req.path.startsWith('/v1/')) return next()
    // 根目录下的其他静态文件（例如图标）原样返回
    const asset = c.req.path.slice(1)
    if (asset && !asset.includes('..') && isFile(join(webDir, asset))) {
      return serveStatic({ root: webDir })(c, next)
    }
    // 像文件的路径（带扩展名，或 /.well-known 这类点开头的）找不到时是 404；
    // 其余交给前端路由，返回 index.html
    if (/\/\.|\.[^/]+$/.test(c.req.path)) return c.text('Not Found', 404)
    c.header('Cache-Control', 'no-cache')
    return c.html(index)
  })
  return true
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
