import { createRoute } from '@hono/zod-openapi'
import { ErrorResponse, LoginRequest, Me } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_PATH,
  DEVICE_TTL_SECONDS,
  isTrustedDevice,
  issueDeviceToken,
} from '../auth/deviceCookie'
import { requireConsole } from '../auth/middleware'
import { hashPassword, verifyPassword } from '../auth/password'
import { PasswordGateBusy, withPasswordGate } from '../auth/passwordGate'
import { clientIdentity } from '../http/clientIp'
import {
  clearClientAttempts,
  pruneAttempts,
  refundAttempt,
  reserveAttempt,
} from '../auth/rateLimit'
import { createSession, deleteSession, SESSION_COOKIE, SESSION_TTL_MS } from '../auth/session'
import type { Db } from '../db/client'
import { accounts, spaceMembers, spaces } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

// 一次密码校验大约耗时多少：启动时实测一次，用户名不存在时按这个时长等待后再返回
let VERIFY_DURATION_MS = 100
void (async () => {
  const started = performance.now()
  await hashPassword('kioku-timing-probe')
  VERIFY_DURATION_MS = Math.round(performance.now() - started)
})()

export async function loadMe(db: Db, accountId: string) {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1)
  if (!account) return null
  const memberships = await db
    .select({ id: spaces.id, name: spaces.name, role: spaceMembers.role })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(eq(spaceMembers.accountId, accountId))
    .orderBy(spaces.createdAt)
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    spaces: memberships,
  }
}

const login = createRoute({
  method: 'post',
  path: '/auth/login',
  tags: ['auth'],
  summary: '管理界面登录',
  request: { body: jsonBody(LoginRequest) },
  responses: {
    200: jsonResponse('已登录', Me),
    401: jsonResponse('用户名或密码错误', ErrorResponse),
    429: jsonResponse('失败次数过多', ErrorResponse),
  },
})

const logout = createRoute({
  method: 'post',
  path: '/auth/logout',
  tags: ['auth'],
  summary: '退出登录',
  responses: { 204: { description: '已退出' } },
})

const me = createRoute({
  method: 'get',
  path: '/auth/me',
  tags: ['auth'],
  summary: '当前登录账号与所属空间',
  responses: {
    200: jsonResponse('当前账号', Me),
    401: jsonResponse('未登录', ErrorResponse),
  },
})

export function authRoutes(deps: Deps) {
  const app = router()
  app.use('/auth/logout', requireConsole(deps))
  app.use('/auth/me', requireConsole(deps))
  return app
    .openapi(login, async (c) => {
      const { username, password } = c.req.valid('json')
      // 拿不到客户端地址时（没有底层连接，例如测试）传 null：失败计数只按用户名，校验闸门只用全局名额
      const identity = clientIdentity(c, deps.trustedProxies ?? 0)
      const client = identity.identified ? identity.key : null
      // 偶尔顺手清理过期的失败计数，不单独起定时任务
      if (Math.random() < 0.01) void pruneAttempts(deps.db).catch(() => {})

      const [account] = await deps.db
        .select()
        .from(accounts)
        .where(eq(accounts.username, username))
        .limit(1)
      // 这台设备之前用这个账号成功登录过，就不受「用户名合计」上限约束（见 deviceCookie.ts）
      const trustedDevice = await isTrustedDevice(deps.db, getCookie(c, DEVICE_COOKIE), account)
      // 先计数再校验：超限的请求不花任何 CPU。用户名不存在也照样计数，行为与存在时一致，不暴露账号是否存在
      if (!(await reserveAttempt(deps.db, username, client, trustedDevice))) {
        return c.json({ error: '失败次数过多，请稍后再试' }, 429)
      }
      // 用户名不存在时不跑 scrypt，等一段与一次校验相当的时间再返回：
      // 既不暴露账号是否存在，又不能用随机用户名耗 CPU、占满校验闸门
      if (!account) {
        await new Promise((r) => setTimeout(r, VERIFY_DURATION_MS))
        return c.json({ error: '用户名或密码错误' }, 401)
      }
      let ok: boolean
      try {
        ok = await withPasswordGate(client, () => verifyPassword(password, account.passwordHash))
      } catch (err) {
        if (!(err instanceof PasswordGateBusy)) throw err
        // 没有真正校验密码，退回刚才占的名额
        await refundAttempt(deps.db, username, client, trustedDevice)
        return c.json({ error: err.message }, 429)
      }
      if (!ok) return c.json({ error: '用户名或密码错误' }, 401)
      await clearClientAttempts(deps.db, username, client)

      const token = await createSession(deps.db, account.id)
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: deps.cookieSecure,
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
      })
      setCookie(c, DEVICE_COOKIE, await issueDeviceToken(deps.db, account), {
        httpOnly: true,
        sameSite: 'Strict',
        secure: deps.cookieSecure,
        path: DEVICE_COOKIE_PATH,
        maxAge: DEVICE_TTL_SECONDS,
      })
      return c.json((await loadMe(deps.db, account.id))!, 200)
    })
    .openapi(logout, async (c) => {
      await deleteSession(deps.db, c.get('console').sessionId)
      deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.body(null, 204)
    })
    .openapi(me, async (c) => {
      const result = await loadMe(deps.db, c.get('console').accountId)
      if (!result) return c.json({ error: '账号不存在' }, 401)
      return c.json(result, 200)
    })
}
