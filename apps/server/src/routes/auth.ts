import { createRoute, z } from '@hono/zod-openapi'
import {
  ChangePasswordRequest,
  ErrorResponse,
  LoginRequest,
  MeResponse,
  SessionsResponse,
  UpdateProfileRequest,
} from '@kioku/contracts'
import { and, desc, eq, ne } from 'drizzle-orm'
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
import { clearLoginFailures, refundLoginAttempt, reserveLoginAttempt } from '../auth/rateLimit'
import {
  createSession,
  deleteSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  truncateUserAgent,
} from '../auth/session'
import { accounts, sessions } from '../db/schema'
import { clientAddress, clientIdentity } from '../http/clientIp'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { loadModelFlags } from '../models/store'
import { VERSION } from '../version'

const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('未登录或密码错误', ErrorResponse),
  404: jsonResponse('不存在', ErrorResponse),
  429: jsonResponse('登录尝试过于频繁', ErrorResponse),
}

const loginRoute = createRoute({
  method: 'post',
  path: '/auth/login',
  tags: ['auth'],
  summary: '用户名与密码登录',
  request: { body: jsonBody(LoginRequest) },
  responses: { 200: jsonResponse('已登录', MeResponse), ...errors },
})

const logoutRoute = createRoute({
  method: 'post',
  path: '/auth/logout',
  tags: ['auth'],
  summary: '退出当前登录会话',
  responses: { 204: { description: '已退出' } },
})

const meRoute = createRoute({
  method: 'get',
  path: '/auth/me',
  tags: ['auth'],
  summary: '读取当前登录账号与实例模型就绪状态',
  responses: { 200: jsonResponse('当前账号', MeResponse), ...errors },
})

const updateMeRoute = createRoute({
  method: 'patch',
  path: '/auth/me',
  tags: ['auth'],
  summary: '修改当前账号显示名',
  request: { body: jsonBody(UpdateProfileRequest) },
  responses: { 200: jsonResponse('已修改', MeResponse), ...errors },
})

const passwordRoute = createRoute({
  method: 'post',
  path: '/auth/password',
  tags: ['auth'],
  summary: '修改密码并使其他设备会话失效',
  request: { body: jsonBody(ChangePasswordRequest) },
  responses: { 204: { description: '密码已更新' }, ...errors },
})

const sessionsRoute = createRoute({
  method: 'get',
  path: '/auth/sessions',
  tags: ['auth'],
  summary: '列出当前账号活跃登录会话',
  responses: { 200: jsonResponse('会话列表', SessionsResponse), ...errors },
})

const deleteSessionRoute = createRoute({
  method: 'delete',
  path: '/auth/sessions/{id}',
  tags: ['auth'],
  summary: '撤销指定登录会话',
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 204: { description: '已撤销' }, ...errors },
})

async function buildMe(deps: Deps, account: { id: string; username: string; displayName: string }) {
  const flags = await loadModelFlags(deps.db)
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    hasMasterKey: Boolean(deps.masterKey),
    hasEmbeddingModel: flags.hasEmbeddingModel,
    hasChatModel: flags.hasChatModel,
    version: VERSION,
  }
}

// 未知用户名走恒定等待填充，防止响应时长暴露账号是否存在，同时不占用全局 scrypt 并发名额
const VERIFY_DURATION_MS = 80

type VerifyGuardResult =
  | { status: 'ok' }
  | { status: 'failed' }
  | { status: 'limited'; retryAfterSeconds: number }
  | { status: 'busy'; message: string }

async function padMissingAccount(startedAt: number): Promise<boolean> {
  const remaining = VERIFY_DURATION_MS - (Date.now() - startedAt)
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining))
  }
  return false
}

// 登录与修改密码共用的密码校验入口：原子预扣限流、受并发闸门保护、未知账号时长填充、繁忙时退还名额
async function verifyGuarded(options: {
  username: string
  password: string
  passwordHash: string | null
  clientKey: string
  gateClient: string | null
  trustedDevice: boolean
}): Promise<VerifyGuardResult> {
  const limit = reserveLoginAttempt(options.username, options.clientKey, {
    trustedDevice: options.trustedDevice,
  })
  if (limit.limited) {
    return { status: 'limited', retryAfterSeconds: limit.retryAfterSeconds }
  }

  const startedAt = Date.now()
  let matched: boolean
  try {
    matched = await withPasswordGate(
      options.gateClient,
      () =>
        options.passwordHash
          ? verifyPassword(options.password, options.passwordHash)
          : padMissingAccount(startedAt),
      { global: Boolean(options.passwordHash) },
    )
  } catch (err) {
    refundLoginAttempt(options.username, options.clientKey)
    if (err instanceof PasswordGateBusy) {
      return { status: 'busy', message: err.message }
    }
    throw err
  }

  if (!options.passwordHash || !matched) {
    return { status: 'failed' }
  }

  clearLoginFailures(options.username, options.clientKey)
  return { status: 'ok' }
}

export function authRoutes(deps: Deps) {
  const app = router()
  const trustedProxies = deps.trustedProxies ?? 0

  app.openapi(loginRoute, async (c) => {
    const { username, password } = c.req.valid('json')
    const identity = clientIdentity(c, trustedProxies)
    const [account] = await deps.db
      .select()
      .from(accounts)
      .where(eq(accounts.username, username))
      .limit(1)

    const trustedDevice = await isTrustedDevice(deps.db, getCookie(c, DEVICE_COOKIE), account)
    const verdict = await verifyGuarded({
      username,
      password,
      passwordHash: account?.passwordHash ?? null,
      clientKey: identity.key,
      gateClient: identity.identified ? identity.key : null,
      trustedDevice,
    })
    if (verdict.status === 'limited') {
      c.header('Retry-After', String(verdict.retryAfterSeconds))
      return c.json({ error: '登录失败次数过多，请稍后再试' }, 429)
    }
    if (verdict.status === 'busy') {
      return c.json({ error: verdict.message }, 429)
    }
    if (verdict.status === 'failed' || !account) {
      return c.json({ error: '用户名或密码不正确' }, 401)
    }

    const sessionToken = await createSession(deps.db, account.id, {
      clientAddress: clientAddress(c, trustedProxies),
      userAgent: truncateUserAgent(c.req.header('user-agent')),
    })
    setCookie(c, SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: deps.cookieSecure,
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    })

    const deviceToken = await issueDeviceToken(deps.db, {
      id: account.id,
      passwordHash: account.passwordHash,
    })
    setCookie(c, DEVICE_COOKIE, deviceToken, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: deps.cookieSecure,
      path: DEVICE_COOKIE_PATH,
      maxAge: DEVICE_TTL_SECONDS,
    })

    return c.json(await buildMe(deps, account), 200)
  })

  const guard = requireConsole(deps)
  app.use('/auth/logout', guard)
  app.use('/auth/me', guard)
  app.use('/auth/password', guard)
  app.use('/auth/sessions', guard)
  app.use('/auth/sessions/*', guard)

  app.openapi(logoutRoute, async (c) => {
    const { sessionId } = c.get('console')
    await deleteSession(deps.db, sessionId)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })

  app.openapi(meRoute, async (c) => {
    const { accountId } = c.get('console')
    const [account] = await deps.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1)
    if (!account) return c.json({ error: '账号不存在' }, 401)
    return c.json(await buildMe(deps, account), 200)
  })

  app.openapi(updateMeRoute, async (c) => {
    const { accountId } = c.get('console')
    const { displayName } = c.req.valid('json')
    const [updated] = await deps.db
      .update(accounts)
      .set({ displayName })
      .where(eq(accounts.id, accountId))
      .returning()
    if (!updated) return c.json({ error: '账号不存在' }, 401)
    return c.json(await buildMe(deps, updated), 200)
  })

  app.openapi(passwordRoute, async (c) => {
    const { accountId, sessionId } = c.get('console')
    const { currentPassword, newPassword } = c.req.valid('json')
    const identity = clientIdentity(c, trustedProxies)
    const [account] = await deps.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1)
    if (!account) return c.json({ error: '账号不存在' }, 401)

    const gateClient = identity.identified ? identity.key : null
    const trustedDevice = await isTrustedDevice(deps.db, getCookie(c, DEVICE_COOKIE), account)
    const verdict = await verifyGuarded({
      username: account.username,
      password: currentPassword,
      passwordHash: account.passwordHash,
      clientKey: identity.key,
      gateClient,
      trustedDevice,
    })
    if (verdict.status === 'limited') {
      c.header('Retry-After', String(verdict.retryAfterSeconds))
      return c.json({ error: '密码校验失败次数过多，请稍后再试' }, 429)
    }
    if (verdict.status === 'busy') return c.json({ error: verdict.message }, 429)
    if (verdict.status === 'failed') return c.json({ error: '当前密码不正确' }, 401)

    let nextHash: string
    try {
      nextHash = await withPasswordGate(gateClient, () => hashPassword(newPassword))
    } catch (err) {
      if (err instanceof PasswordGateBusy) return c.json({ error: err.message }, 429)
      throw err
    }
    await deps.db.transaction(async (tx) => {
      await tx.update(accounts).set({ passwordHash: nextHash }).where(eq(accounts.id, accountId))
      await tx
        .delete(sessions)
        .where(and(eq(sessions.accountId, accountId), ne(sessions.id, sessionId)))
    })

    const deviceToken = await issueDeviceToken(deps.db, { id: accountId, passwordHash: nextHash })
    setCookie(c, DEVICE_COOKIE, deviceToken, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: deps.cookieSecure,
      path: DEVICE_COOKIE_PATH,
      maxAge: DEVICE_TTL_SECONDS,
    })

    return c.body(null, 204)
  })

  app.openapi(sessionsRoute, async (c) => {
    const { accountId, sessionId } = c.get('console')
    const rows = await deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.accountId, accountId))
      .orderBy(desc(sessions.lastActiveAt))
    return c.json(
      {
        items: rows.map((r) => ({
          id: r.id,
          clientAddress: r.clientAddress,
          userAgent: r.userAgent,
          createdAt: r.createdAt.toISOString(),
          lastActiveAt: r.lastActiveAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          current: r.id === sessionId,
        })),
      },
      200,
    )
  })

  app.openapi(deleteSessionRoute, async (c) => {
    const { accountId, sessionId } = c.get('console')
    const { id } = c.req.valid('param')
    const deleted = await deps.db
      .delete(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.accountId, accountId)))
      .returning({ id: sessions.id })
    if (!deleted.length) return c.json({ error: '会话不存在' }, 404)
    if (id === sessionId) deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })

  return app
}
