import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'

import { SESSION_COOKIE } from './session'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// 只有带会话 Cookie 的写请求才可能被跨站伪造，要求它来自同源页面；
// 带 Bearer Key 的请求不依赖 Cookie，不检查。
// 优先看浏览器的 Sec-Fetch-Site；没有时比对 Origin 与 Host（反向代理后 URL 的协议可能变，主机名不变）。
export const sameOriginForCookies = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || !getCookie(c, SESSION_COOKIE)) return next()
  const site = c.req.header('sec-fetch-site')
  let ok = site === 'same-origin'
  if (!site) {
    const origin = c.req.header('origin')
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host')
    ok = Boolean(origin && host && URL.canParse(origin) && new URL(origin).host === host)
  }
  if (!ok) return c.json({ error: '跨站请求被拒绝' }, 403)
  return next()
})
