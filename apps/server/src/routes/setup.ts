import { createRoute } from '@hono/zod-openapi'
import { ErrorResponse, Me, SetupRequest, SetupStatus } from '@kioku/contracts'
import { count, sql } from 'drizzle-orm'
import { setCookie } from 'hono/cookie'

import { hashPassword } from '../auth/password'
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from '../auth/session'
import { accounts, spaceMembers, spaces } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const status = createRoute({
  method: 'get',
  path: '/setup/status',
  tags: ['setup'],
  summary: '是否还需要首次初始化',
  responses: { 200: jsonResponse('初始化状态', SetupStatus) },
})

const setup = createRoute({
  method: 'post',
  path: '/setup',
  tags: ['setup'],
  summary: '首次初始化：创建第一个账号和它的空间',
  request: { body: jsonBody(SetupRequest) },
  responses: {
    201: jsonResponse('已创建并登录', Me),
    409: jsonResponse('已经初始化过', ErrorResponse),
  },
})

export function setupRoutes(deps: Deps) {
  return router()
    .openapi(status, async (c) => {
      const [row] = await deps.db.select({ n: count() }).from(accounts)
      return c.json({ needsSetup: (row?.n ?? 0) === 0 }, 200)
    })
    .openapi(setup, async (c) => {
      const body = c.req.valid('json')
      const passwordHash = await hashPassword(body.password)
      const result = await deps.db.transaction(async (tx) => {
        // 用事务级咨询锁串行化，避免两个并发请求都看到「没有账号」
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kioku.setup'))`)
        const [existing] = await tx.select({ n: count() }).from(accounts)
        if ((existing?.n ?? 0) > 0) return null
        const [account] = await tx
          .insert(accounts)
          .values({
            username: body.username,
            displayName: body.displayName,
            passwordHash,
            isAdmin: true,
          })
          .returning()
        const [space] = await tx.insert(spaces).values({ name: body.spaceName }).returning()
        await tx
          .insert(spaceMembers)
          .values({ spaceId: space!.id, accountId: account!.id, role: 'owner' })
        return { account: account!, space: space! }
      })
      if (!result) return c.json({ error: '已经初始化过' }, 409)

      const token = await createSession(deps.db, result.account.id)
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: deps.cookieSecure,
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
      })
      return c.json(
        {
          id: result.account.id,
          username: result.account.username,
          displayName: result.account.displayName,
          spaces: [{ id: result.space.id, name: result.space.name, role: 'owner' as const }],
        },
        201,
      )
    })
}
