import { createRoute } from '@hono/zod-openapi'
import {
  DATABASE_FAILURE_NAMES,
  DATABASE_SOURCE_NAMES,
  DatabaseCheck,
  DatabaseCheckRequest,
  DatabaseConnected,
  DatabaseInspection,
  DatabaseProvisionRequest,
  DatabaseSetupError,
  ErrorResponse,
  Me,
  PROVISION_PROBLEM_NAMES,
  SETUP_CODE_INVALID,
  SETUP_CODE_LIMITED,
  SetupCodeRequest,
  SetupRequest,
  SetupStatus,
} from '@kioku/contracts'
import { count, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'

import { isSameOrigin } from '../auth/csrf'
import { hashPassword } from '../auth/password'
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from '../auth/session'
import type { Db } from '../db/client'
import {
  connectionUrl,
  probeDatabase,
  provisionDatabase,
  ProvisionError,
  summarize,
} from '../db/probe'
import { accounts, spaceMembers, spaces } from '../db/schema'
import { clientIdentity } from '../http/clientIp'
import type { Deps, SetupHost } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { ActivationError, SetupBusyError } from '../setupErrors'
import { sessionClient } from './auth'

const status = createRoute({
  method: 'get',
  path: '/setup/status',
  tags: ['setup'],
  summary: '是否还需要首次初始化、数据库接上了没有',
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
    403: jsonResponse('初始化码错误', ErrorResponse),
    409: jsonResponse('已经初始化过', ErrorResponse),
    429: jsonResponse('初始化码错误次数过多', ErrorResponse),
  },
})

const codeResponses = {
  403: jsonResponse('初始化码错误，或者不是同源页面的请求', ErrorResponse),
  409: jsonResponse('已完成初始化，或者数据库已配置', ErrorResponse),
  429: jsonResponse('初始化码错误次数过多', ErrorResponse),
}

const inspect = createRoute({
  method: 'post',
  path: '/setup/database/inspect',
  tags: ['setup'],
  summary: '查看当前的数据库：来自哪里、连接信息与检查结果',
  request: { body: jsonBody(SetupCodeRequest) },
  responses: { 200: jsonResponse('当前的数据库', DatabaseInspection), ...codeResponses },
})

const check = createRoute({
  method: 'post',
  path: '/setup/database/check',
  tags: ['setup'],
  summary: '检查填写的数据库连接（不保存）',
  request: { body: jsonBody(DatabaseCheckRequest) },
  responses: { 200: jsonResponse('检查结果', DatabaseCheck), ...codeResponses },
})

const connectDatabase = createRoute({
  method: 'post',
  path: '/setup/database',
  tags: ['setup'],
  summary: '保存数据库连接并当场接上',
  request: { body: jsonBody(DatabaseCheckRequest) },
  responses: {
    200: jsonResponse('已接上', DatabaseConnected),
    400: jsonResponse('检查未通过', DatabaseSetupError),
    500: jsonResponse('接入失败', DatabaseSetupError),
    ...codeResponses,
  },
})

const provision = createRoute({
  method: 'post',
  path: '/setup/database/provision',
  tags: ['setup'],
  summary: '用超级用户创建应用角色与库，保存应用角色的连接并当场接上',
  request: { body: jsonBody(DatabaseProvisionRequest) },
  responses: {
    200: jsonResponse('已创建并接上', DatabaseConnected),
    400: jsonResponse('创建失败', DatabaseSetupError),
    500: jsonResponse('接入失败', DatabaseSetupError),
    ...codeResponses,
  },
})

const DONE = '已完成初始化'

// 核对初始化码。不是同源页面发来的写请求直接拒绝：初始化页之外的网页不能替人填库、建账号。
// 返回 null 表示通过
function guard(c: Context, host: SetupHost, trustedProxies: number, code: string) {
  if (!isSameOrigin(c)) return c.json({ error: '跨站请求被拒绝' }, 403)
  const identity = clientIdentity(c, trustedProxies)
  switch (host.gate.verify(code, identity.identified ? identity.key : null)) {
    case 'ok':
      return null
    case 'closed':
      return c.json({ error: DONE }, 409)
    case 'limited':
      return c.json({ error: '初始化码错误次数过多，请稍后重试', code: SETUP_CODE_LIMITED }, 429)
    case 'wrong':
      return c.json({ error: '初始化码错误：见服务的启动日志', code: SETUP_CODE_INVALID }, 403)
  }
}

// 只有还没配置数据库时才能在页面上填；来自环境变量或 kioku.json 的只能改了之后重启
function notEditable(host: SetupHost): string | null {
  const { state, source } = host.database()
  if (state === 'missing') return null
  if (state === 'ready') return '数据库已接上'
  return `数据库来自${source ? DATABASE_SOURCE_NAMES[source] : '配置'}，无法在此修改：改了之后重启服务`
}

function setupErrorStatus(err: unknown): { status: 409 | 500; error: string } | null {
  if (err instanceof SetupBusyError) return { status: 409, error: err.message }
  if (err instanceof ActivationError) return { status: 500, error: err.message }
  return null
}

// 数据库这一步的接口：没接上数据库时由初始化专用的应用提供，接上之后完整的服务里也有（查看环境变量来源的库）。
// needsSetup 回答还要不要初始化：没接上时总是要，接上之后看有没有账号
export function setupDatabaseRoutes(
  host: SetupHost,
  trustedProxies: number,
  needsSetup: () => Promise<boolean>,
) {
  return router()
    .openapi(inspect, async (c) => {
      const denied = guard(c, host, trustedProxies, c.req.valid('json').setupCode)
      if (denied) return denied
      if (!(await needsSetup())) return c.json({ error: DONE }, 409)
      const current = host.database()
      const result = current.url ? await probeDatabase(current.url, host.migrationsFolder) : null
      return c.json(
        {
          source: current.source,
          state: current.state,
          summary: current.url ? summarize(current.url) : null,
          check: result,
        },
        200,
      )
    })
    .openapi(check, async (c) => {
      const body = c.req.valid('json')
      const denied = guard(c, host, trustedProxies, body.setupCode)
      if (denied) return denied
      const locked = notEditable(host)
      if (locked) return c.json({ error: locked }, 409)
      return c.json(await probeDatabase(connectionUrl(body.connection), host.migrationsFolder), 200)
    })
    .openapi(connectDatabase, async (c) => {
      const body = c.req.valid('json')
      const denied = guard(c, host, trustedProxies, body.setupCode)
      if (denied) return denied
      const locked = notEditable(host)
      if (locked) return c.json({ error: locked }, 409)
      const url = connectionUrl(body.connection)
      try {
        return await host.exclusive(async () => {
          const result = await probeDatabase(url, host.migrationsFolder)
          if (!result.ready) {
            const error = result.failure
              ? `无法连接数据库：${DATABASE_FAILURE_NAMES[result.failure]}`
              : '检查未通过'
            return c.json(
              { error, check: result, ...(result.failure ? { failure: result.failure } : {}) },
              400,
            )
          }
          await host.activate(url)
          return c.json({ summary: summarize(url)!, check: result }, 200)
        })
      } catch (err) {
        const known = setupErrorStatus(err)
        if (known) return c.json({ error: known.error }, known.status)
        throw err
      }
    })
    .openapi(provision, async (c) => {
      const body = c.req.valid('json')
      const denied = guard(c, host, trustedProxies, body.setupCode)
      if (denied) return denied
      const locked = notEditable(host)
      if (locked) return c.json({ error: locked }, 409)
      try {
        return await host.exclusive(async () => {
          const made = await provisionDatabase(body)
          try {
            const result = await probeDatabase(made.url, host.migrationsFolder)
            if (!result.ready) {
              throw new ActivationError(
                result.failure
                  ? `无法用新建的角色连接：${DATABASE_FAILURE_NAMES[result.failure]}`
                  : '新建的库检查未通过',
              )
            }
            await host.activate(made.url)
            return c.json({ summary: summarize(made.url)!, check: result }, 200)
          } catch (err) {
            // 接不上就把刚建的库与角色删掉，不留下没人知道密码的角色
            await made.undo().catch(() => console.error('删除代建的库与角色失败'))
            throw err
          }
        })
      } catch (err) {
        if (err instanceof ProvisionError) {
          const { failure, extensions } = err.detail
          const reason = failure
            ? `${PROVISION_PROBLEM_NAMES[err.problem]}：${DATABASE_FAILURE_NAMES[failure]}`
            : extensions?.length
              ? `${PROVISION_PROBLEM_NAMES[err.problem]}：${extensions.join('、')}`
              : PROVISION_PROBLEM_NAMES[err.problem]
          return c.json(
            {
              error: reason,
              problem: err.problem,
              ...(failure ? { failure } : {}),
              ...(extensions ? { extensions } : {}),
            },
            400,
          )
        }
        const known = setupErrorStatus(err)
        if (known) return c.json({ error: known.error }, known.status)
        throw err
      }
    })
}

// 初始化状态：没有 host 的（测试）按已接上的库算
export function setupStatusRoutes(
  host: SetupHost | undefined,
  masterKey: boolean,
  needsSetup: () => Promise<boolean>,
) {
  return router().openapi(status, async (c) => {
    const current = host?.database() ?? { state: 'ready' as const, source: null }
    return c.json(
      {
        needsSetup: current.state === 'ready' ? await needsSetup() : true,
        database: { state: current.state, source: current.source },
        masterKey,
      },
      200,
    )
  })
}

async function noAccounts(db: Db): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(accounts)
  return (row?.n ?? 0) === 0
}

// 完整服务里的初始化：状态、数据库这一步（有 host 时），以及建第一个管理员
export function setupRoutes(deps: Deps) {
  const host = deps.setup
  const trustedProxies = deps.trustedProxies ?? 0
  const needsSetup = () => noAccounts(deps.db)
  const app = router()
  app.route('/', setupStatusRoutes(host, Boolean(deps.masterKey), needsSetup))
  if (host) app.route('/', setupDatabaseRoutes(host, trustedProxies, needsSetup))
  return app.openapi(setup, async (c) => {
    const body = c.req.valid('json')
    // 先核对初始化码再算密码哈希：码错的请求不花 CPU
    if (host) {
      const denied = guard(c, host, trustedProxies, body.setupCode)
      if (denied) return denied
    }
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
    if (!result) return c.json({ error: DONE }, 409)
    // 有了账号：初始化码作废
    host?.gate.close()

    const token = await createSession(deps.db, result.account.id, sessionClient(c, deps))
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
        isAdmin: result.account.isAdmin,
        spaces: [{ id: result.space.id, name: result.space.name, role: 'owner' as const }],
      },
      201,
    )
  })
}
