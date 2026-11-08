import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'

import { SESSION_COOKIE } from './session'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// 只有带会话 Cookie 的写请求才可能被跨站伪造，要求它来自同源页面；
// 带 Bearer Key 的请求不依赖 Cookie，不检查。
// 优先看浏览器的 Sec-Fetch-Site；没有时比对 Origin 与 Host（反向代理后 URL 的协议可能变，主机名不变）。
export const sameOriginForCookies = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || !getCookie(c, SESSION_COOKIE)) return next()
  if (!isSameOrigin(c)) return c.json({ error: '跨站请求被拒绝' }, 403)
  return next()
})

// 请求是否来自同源页面。不带会话 Cookie、却会让访问者登录的写请求（用链接设置密码）自己调它
export function isSameOrigin(c: Context): boolean {
  const site = c.req.header('sec-fetch-site')
  if (site) return site === 'same-origin'
  const origin = c.req.header('origin')
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host')
  return Boolean(origin && host && URL.canParse(origin) && new URL(origin).host === host)
}
