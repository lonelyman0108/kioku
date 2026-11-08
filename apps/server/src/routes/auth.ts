import { randomBytes } from 'node:crypto'

import { createRoute, z } from '@hono/zod-openapi'
import {
  ChangePasswordRequest,
  ErrorResponse,
  LoginRequest,
  LoginSessionList,
  Me,
  PasswordLinkInfo,
  PasswordLinkRequest,
  SetPasswordRequest,
  UpdateProfileRequest,
} from '@kioku/contracts'
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

import { isSameOrigin } from '../auth/csrf'
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
import { recordSuccess, refundAttempt, reserveAttempt } from '../auth/rateLimit'
import {
  createSession,
  deleteSession,
  hashToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  truncateUserAgent,
  type SessionClient,
} from '../auth/session'
import type { Db, Tx } from '../db/client'
import { accountLinks, accounts, sessions, spaceMembers, spaces } from '../db/schema'
import { clientAddress, clientIdentity } from '../http/clientIp'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

// 一次密码校验大约耗时多少：启动时实测一次，用户名不存在时按这个时长等待后再返回。
// 实测用的哈希同时给还没设过密码的账号做校验：密码是随机的，谁也对不上，耗时与真的校验一样
let VERIFY_DURATION_MS = 100
const UNUSABLE_HASH = (async () => {
  const started = performance.now()
  const hash = await hashPassword(randomBytes(32).toString('base64'))
  VERIFY_DURATION_MS = Math.round(performance.now() - started)
  return hash
})()

type Account = typeof accounts.$inferSelect

export async function loadMe(db: Db | Tx, accountId: string) {
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
    isAdmin: account.isAdmin,
    spaces: memberships,
  }
}

export function sessionClient(c: Context, deps: Deps): SessionClient {
  return {
    clientAddress: clientAddress(c, deps.trustedProxies ?? 0),
    userAgent: truncateUserAgent(c.req.header('user-agent')),
  }
}

function setSessionCookie(c: Context, deps: Deps, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: deps.cookieSecure,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
}

async function setDeviceCookie(
  c: Context,
  deps: Deps,
  account: { id: string; passwordHash: string },
) {
  setCookie(c, DEVICE_COOKIE, await issueDeviceToken(deps.db, account), {
    httpOnly: true,
    sameSite: 'Strict',
    secure: deps.cookieSecure,
    path: DEVICE_COOKIE_PATH,
    maxAge: DEVICE_TTL_SECONDS,
  })
}

type Guarded<T> =
  { kind: 'ok'; value: T } | { kind: 'wrong' } | { kind: 'limited'; message: string }

// 登录与改密码共用：先计数、再进校验闸门、成功清计数（顺序与理由见 AGENTS.md「登录防护的顺序」）。
// 停用的账号、还没设过密码的账号与密码错误的结果一样：照样计数、照样跑一次 scrypt、不清计数，
// 回应与耗时都分不出来。onSuccess 在闸门里执行（改密码时算新密码的哈希，同样占名额）
async function verifyGuarded<T>(
  c: Context<AppEnv>,
  deps: Deps,
  username: string,
  account: Account | undefined,
  password: string,
  onSuccess: (account: Account & { passwordHash: string }) => Promise<T>,
): Promise<Guarded<T>> {
  // 拿不到客户端地址时（没有底层连接，例如测试）传 null：失败计数归入「未知客户端」，校验闸门只用全局名额
  const identity = clientIdentity(c, deps.trustedProxies ?? 0)
  const client = identity.identified ? identity.key : null
  // 这台设备之前用这个账号成功登录过，就不受「用户名合计」上限约束（见 deviceCookie.ts）
  const trustedDevice = await isTrustedDevice(deps.db, getCookie(c, DEVICE_COOKIE), account)
  // 先计数再校验：超限的请求不花任何 CPU。用户名不存在也照样计数，行为与存在时一致，不暴露账号是否存在
  if (!(await reserveAttempt(deps.db, username, client, trustedDevice))) {
    return { kind: 'limited', message: '失败次数过多，请稍后重试' }
  }
  // 用户名不存在时不跑 scrypt，改为等一段与一次校验相当的时间。它同样经过校验闸门，
  // 占本客户端的名额、闸门排满时同样被拒，只是不占全局名额：繁忙时的表现与存在的账号一致，
  // 不暴露账号是否存在；随机用户名也耗不了 CPU、挤不满闸门
  const check = account
    ? async (): Promise<Guarded<T>> => {
        const matched = await verifyPassword(
          password,
          account.passwordHash ?? (await UNUSABLE_HASH),
        )
        if (!matched || account.passwordHash === null || account.disabledAt)
          return { kind: 'wrong' }
        return {
          kind: 'ok',
          value: await onSuccess({ ...account, passwordHash: account.passwordHash }),
        }
      }
    : () =>
        new Promise<Guarded<T>>((r) => setTimeout(() => r({ kind: 'wrong' }), VERIFY_DURATION_MS))
  let result: Guarded<T>
  try {
    result = await withPasswordGate(client, check, { global: account !== undefined })
  } catch (err) {
    if (!(err instanceof PasswordGateBusy)) throw err
    // 没有真正校验密码，退回刚才占的名额
    await refundAttempt(deps.db, username, client, trustedDevice)
    return { kind: 'limited', message: err.message }
  }
  if (result.kind === 'ok') await recordSuccess(deps.db, username, client, trustedDevice)
  return result
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

const updateProfile = createRoute({
  method: 'patch',
  path: '/auth/profile',
  tags: ['auth'],
  summary: '修改自己的显示名',
  request: { body: jsonBody(UpdateProfileRequest) },
  responses: { 200: jsonResponse('当前账号', Me), 401: jsonResponse('未登录', ErrorResponse) },
})

const changePassword = createRoute({
  method: 'post',
  path: '/auth/password',
  tags: ['auth'],
  summary:
    '修改自己的密码：要当前密码，和登录一样计数、过校验闸门；成功后其他会话退出，当前设备重新下发设备 Cookie',
  request: { body: jsonBody(ChangePasswordRequest) },
  responses: {
    204: { description: '已修改' },
    400: jsonResponse('当前密码错误', ErrorResponse),
    401: jsonResponse('未登录', ErrorResponse),
    409: jsonResponse('密码刚在别处改过', ErrorResponse),
    429: jsonResponse('失败次数过多', ErrorResponse),
  },
})

const listSessions = createRoute({
  method: 'get',
  path: '/auth/sessions',
  tags: ['auth'],
  summary: '自己的登录设备（未过期的会话），最近活动的在前',
  responses: {
    200: jsonResponse('登录设备', LoginSessionList),
    401: jsonResponse('未登录', ErrorResponse),
  },
})

const deleteOneSession = createRoute({
  method: 'delete',
  path: '/auth/sessions/{sessionId}',
  tags: ['auth'],
  summary: '退出一个登录设备；退出当前这个等于退出登录',
  request: { params: z.object({ sessionId: z.uuid() }) },
  responses: {
    204: { description: '已退出' },
    401: jsonResponse('未登录', ErrorResponse),
    404: jsonResponse('不存在', ErrorResponse),
  },
})

const signOutOthers = createRoute({
  method: 'post',
  path: '/auth/sessions/sign-out-others',
  tags: ['auth'],
  summary: '退出当前设备以外的全部登录设备',
  responses: { 204: { description: '已退出' }, 401: jsonResponse('未登录', ErrorResponse) },
})

const inspectLink = createRoute({
  method: 'post',
  path: '/auth/password-link/inspect',
  tags: ['auth'],
  summary: '读一次性链接：无效、过期、用过的与停用账号的一律 404',
  request: { body: jsonBody(PasswordLinkRequest) },
  responses: {
    200: jsonResponse('链接', PasswordLinkInfo),
    404: jsonResponse('链接无效', ErrorResponse),
  },
})

const usePasswordLink = createRoute({
  method: 'post',
  path: '/auth/password-link',
  tags: ['auth'],
  summary: '用一次性链接设置密码：链接作废，这个账号的会话全部退出，然后以它登录',
  request: { body: jsonBody(SetPasswordRequest) },
  responses: {
    200: jsonResponse('已设置并登录', Me),
    403: jsonResponse('跨站请求', ErrorResponse),
    404: jsonResponse('链接无效', ErrorResponse),
    429: jsonResponse('繁忙', ErrorResponse),
  },
})

const LINK_INVALID = '链接无效或已过期'

// 还能用的链接：没用过、没过期、账号没停用
function liveLink(tokenHash: string) {
  return and(
    eq(accountLinks.tokenHash, tokenHash),
    isNull(accountLinks.usedAt),
    gt(accountLinks.expiresAt, new Date()),
    isNull(accounts.disabledAt),
  )
}

export function authRoutes(deps: Deps) {
  const app = router()
  for (const path of [
    '/auth/logout',
    '/auth/me',
    '/auth/profile',
    '/auth/password',
    '/auth/sessions',
    '/auth/sessions/*',
  ]) {
    app.use(path, requireConsole(deps))
  }
  return app
    .openapi(login, async (c) => {
      const { username, password } = c.req.valid('json')
      const [account] = await deps.db
        .select()
        .from(accounts)
        .where(eq(accounts.username, username))
        .limit(1)
      const result = await verifyGuarded(c, deps, username, account, password, async (a) => a)
      if (result.kind === 'limited') return c.json({ error: result.message }, 429)
      if (result.kind === 'wrong') return c.json({ error: '用户名或密码错误' }, 401)
      const verified = result.value
      setSessionCookie(c, deps, await createSession(deps.db, verified.id, sessionClient(c, deps)))
      await setDeviceCookie(c, deps, verified)
      return c.json((await loadMe(deps.db, verified.id))!, 200)
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
    .openapi(updateProfile, async (c) => {
      const { displayName } = c.req.valid('json')
      const accountId = c.get('console').accountId
      await deps.db.update(accounts).set({ displayName }).where(eq(accounts.id, accountId))
      const result = await loadMe(deps.db, accountId)
      if (!result) return c.json({ error: '账号不存在' }, 401)
      return c.json(result, 200)
    })
    .openapi(changePassword, async (c) => {
      const { currentPassword, newPassword } = c.req.valid('json')
      const { accountId, sessionId } = c.get('console')
      const [account] = await deps.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1)
      if (!account) return c.json({ error: '账号不存在' }, 401)
      // 错的当前密码和登录失败记在同一个计数上，拿这个接口猜不了密码
      const result = await verifyGuarded(
        c,
        deps,
        account.username,
        account,
        currentPassword,
        async (verified) => ({ verified, next: await hashPassword(newPassword) }),
      )
      if (result.kind === 'limited') return c.json({ error: result.message }, 429)
      if (result.kind === 'wrong') return c.json({ error: '当前密码错误' }, 400)
      const { verified, next } = result.value
      const changed = await deps.db.transaction(async (tx) => {
        // 加锁的顺序和用链接设置密码、管理员停用一致：先链接、再账号
        await tx
          .select({ id: accountLinks.id })
          .from(accountLinks)
          .where(eq(accountLinks.accountId, accountId))
          .for('update')
        const [row] = await tx
          .select({ passwordHash: accounts.passwordHash, disabledAt: accounts.disabledAt })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .for('update')
        // 校验之后密码在别处改过（另一个设备、重置链接），或者账号刚被停用：不覆盖
        if (!row || row.passwordHash !== verified.passwordHash || row.disabledAt) return false
        await tx.update(accounts).set({ passwordHash: next }).where(eq(accounts.id, accountId))
        await tx
          .delete(sessions)
          .where(and(eq(sessions.accountId, accountId), ne(sessions.id, sessionId)))
        // 没用过的重置链接一起作废：密码已经由本人换过了
        await tx.delete(accountLinks).where(eq(accountLinks.accountId, accountId))
        return true
      })
      if (!changed) return c.json({ error: '密码刚在别处改过，请刷新后重试' }, 409)
      // 设备 Cookie 绑着密码指纹，旧的都失效了，当前设备换一个新的
      await setDeviceCookie(c, deps, { id: accountId, passwordHash: next })
      return c.body(null, 204)
    })
    .openapi(listSessions, async (c) => {
      const { accountId, sessionId } = c.get('console')
      const rows = await deps.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.accountId, accountId), gt(sessions.expiresAt, new Date())))
        .orderBy(desc(sessions.lastActiveAt), desc(sessions.createdAt))
      return c.json(
        {
          sessions: rows.map((s) => ({
            id: s.id,
            current: s.id === sessionId,
            clientAddress: s.clientAddress,
            userAgent: s.userAgent,
            createdAt: s.createdAt.toISOString(),
            lastActiveAt: s.lastActiveAt.toISOString(),
          })),
        },
        200,
      )
    })
    .openapi(deleteOneSession, async (c) => {
      const { accountId, sessionId: current } = c.get('console')
      const { sessionId } = c.req.valid('param')
      const gone = await deps.db
        .delete(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)))
        .returning({ id: sessions.id })
      if (!gone.length) return c.json({ error: '登录设备不存在' }, 404)
      if (sessionId === current) deleteCookie(c, SESSION_COOKIE, { path: '/' })
      return c.body(null, 204)
    })
    .openapi(signOutOthers, async (c) => {
      const { accountId, sessionId } = c.get('console')
      await deps.db
        .delete(sessions)
        .where(and(eq(sessions.accountId, accountId), ne(sessions.id, sessionId)))
      return c.body(null, 204)
    })
    .openapi(inspectLink, async (c) => {
      const { token } = c.req.valid('json')
      const [row] = await deps.db
        .select({
          username: accounts.username,
          displayName: accounts.displayName,
          purpose: accountLinks.purpose,
          expiresAt: accountLinks.expiresAt,
        })
        .from(accountLinks)
        .innerJoin(accounts, eq(accounts.id, accountLinks.accountId))
        .where(liveLink(hashToken(token)))
        .limit(1)
      if (!row) return c.json({ error: LINK_INVALID }, 404)
      return c.json({ ...row, expiresAt: row.expiresAt.toISOString() }, 200)
    })
    .openapi(usePasswordLink, async (c) => {
      // 不带会话 Cookie 的写请求不经过 sameOriginForCookies，这里自己要求同源：
      // 别的网站不能替访问者用链接设置密码、让他登录进别人的账号
      if (!isSameOrigin(c)) return c.json({ error: '跨站请求被拒绝' }, 403)
      const { token, password } = c.req.valid('json')
      const tokenHash = hashToken(token)
      // 先确认链接能用再算哈希：公开接口，不能让随便一个令牌就耗一次 scrypt
      const [found] = await deps.db
        .select({ id: accountLinks.id })
        .from(accountLinks)
        .innerJoin(accounts, eq(accounts.id, accountLinks.accountId))
        .where(liveLink(tokenHash))
        .limit(1)
      if (!found) return c.json({ error: LINK_INVALID }, 404)
      const identity = clientIdentity(c, deps.trustedProxies ?? 0)
      let passwordHash: string
      try {
        passwordHash = await withPasswordGate(identity.identified ? identity.key : null, () =>
          hashPassword(password),
        )
      } catch (err) {
        if (!(err instanceof PasswordGateBusy)) throw err
        return c.json({ error: err.message }, 429)
      }
      const client = sessionClient(c, deps)
      const done = await deps.db.transaction(async (tx) => {
        // 锁住链接再判断一次：同一个链接并发提交时只有一个用得上
        const [link] = await tx
          .select({ id: accountLinks.id, accountId: accountLinks.accountId })
          .from(accountLinks)
          .innerJoin(accounts, eq(accounts.id, accountLinks.accountId))
          .where(liveLink(tokenHash))
          .for('update', { of: accountLinks })
        if (!link) return null
        await tx
          .update(accountLinks)
          .set({ usedAt: new Date() })
          .where(eq(accountLinks.id, link.id))
        await tx
          .delete(accountLinks)
          .where(and(eq(accountLinks.accountId, link.accountId), isNull(accountLinks.usedAt)))
        await tx.update(accounts).set({ passwordHash }).where(eq(accounts.id, link.accountId))
        await tx.delete(sessions).where(eq(sessions.accountId, link.accountId))
        const session = await createSession(tx, link.accountId, client)
        return { accountId: link.accountId, session, me: (await loadMe(tx, link.accountId))! }
      })
      if (!done) return c.json({ error: LINK_INVALID }, 404)
      setSessionCookie(c, deps, done.session)
      await setDeviceCookie(c, deps, { id: done.accountId, passwordHash })
      return c.json(done.me, 200)
    })
}
