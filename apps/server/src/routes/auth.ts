import { createRoute } from '@hono/zod-openapi'
import { ErrorResponse, LoginRequest, Me } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { deleteCookie, setCookie } from 'hono/cookie'

import { requireConsole } from '../auth/middleware'
import { hashPassword, verifyPassword } from '../auth/password'
import { PasswordGateBusy, withPasswordGate } from '../auth/passwordGate'
import { clearAttempts, pruneAttempts, reserveAttempt } from '../auth/rateLimit'
import { createSession, deleteSession, SESSION_COOKIE, SESSION_TTL_MS } from '../auth/session'
import type { Db } from '../db/client'
import { accounts, spaceMembers, spaces } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

// 用户名不存在时也做一次同等开销的校验，避免按响应时间区分「用户不存在」和「密码错误」
const DUMMY_HASH = hashPassword('kioku-timing-equalizer')

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
      // 偶尔顺手清理过期的失败计数，不单独起定时任务
      if (Math.random() < 0.01) void pruneAttempts(deps.db).catch(() => {})

      const [account] = await deps.db
        .select()
        .from(accounts)
        .where(eq(accounts.username, username))
        .limit(1)
      // 先排进校验闸门，再占失败次数名额：因为繁忙被拒的请求没有校验过密码，不该扣次数
      let outcome: 'ok' | 'wrong' | 'locked'
      try {
        outcome = await withPasswordGate(async () => {
          if (!(await reserveAttempt(deps.db, username))) return 'locked'
          const ok = await verifyPassword(password, account?.passwordHash ?? (await DUMMY_HASH))
          return account && ok ? 'ok' : 'wrong'
        })
      } catch (err) {
        if (err instanceof PasswordGateBusy) return c.json({ error: err.message }, 429)
        throw err
      }
      if (outcome === 'locked') return c.json({ error: '失败次数过多，请稍后再试' }, 429)
      if (outcome === 'wrong' || !account) return c.json({ error: '用户名或密码错误' }, 401)
      await clearAttempts(deps.db, username)

      const token = await createSession(deps.db, account.id)
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: deps.cookieSecure,
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
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
