import { createRoute } from '@hono/zod-openapi'
import {
  DATABASE_FAILURE_NAMES,
  DATABASE_UNAVAILABLE_CODE,
  DatabaseConnected,
  DatabaseSetupError,
  ErrorResponse,
  MeResponse,
  PROVISION_PROBLEM_NAMES,
  SETUP_CODE_INVALID,
  SETUP_CODE_LIMITED,
  SetupDatabaseApplyRequest,
  SetupDatabaseCheckRequest,
  SetupDatabaseCheckResponse,
  SetupDatabaseProvisionRequest,
  SetupRequest,
  SetupStatusResponse,
} from '@kioku/contracts'
import { count, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'

import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_PATH,
  DEVICE_TTL_SECONDS,
  issueDeviceToken,
} from '../auth/deviceCookie'
import { hashPassword } from '../auth/password'
import { createSession, SESSION_COOKIE, SESSION_TTL_MS, truncateUserAgent } from '../auth/session'
import type { Db } from '../db/client'
import {
  connectionUrl,
  probeDatabase,
  provisionDatabase,
  ProvisionError,
  summarize,
} from '../db/probe'
import { accounts } from '../db/schema'
import { clientAddress, clientIdentity } from '../http/clientIp'
import type { AppEnv, Deps, SetupHost } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { loadModelFlags } from '../models/store'
import { ActivationError, SetupBusyError } from '../setupErrors'
import { VERSION } from '../version'

const statusRoute = createRoute({
  method: 'get',
  path: '/setup/status',
  tags: ['setup'],
  summary: '查看是否需要首次初始化以及数据库连接状态',
  responses: { 200: jsonResponse('初始化状态', SetupStatusResponse) },
})

const setupRoute = createRoute({
  method: 'post',
  path: '/setup',
  tags: ['setup'],
  summary: '首次初始化：创建唯一管理员账号并自动登录',
  request: { body: jsonBody(SetupRequest) },
  responses: {
    201: jsonResponse('已创建并登录', MeResponse),
    403: jsonResponse('初始化码错误', ErrorResponse),
    409: jsonResponse('已经初始化过', ErrorResponse),
    429: jsonResponse('初始化码错误次数过多', ErrorResponse),
    503: jsonResponse('数据库暂时无法连接', ErrorResponse),
  },
})

const codeResponses = {
  403: jsonResponse('初始化码错误', ErrorResponse),
  409: jsonResponse('已完成初始化，或数据库已配置', ErrorResponse),
  429: jsonResponse('初始化码错误次数过多', ErrorResponse),
  503: jsonResponse('数据库暂时无法连接', ErrorResponse),
}

const checkRoute = createRoute({
  method: 'post',
  path: '/setup/database/check',
  tags: ['setup'],
  summary: '检查填写的数据库连接（不保存）',
  request: { body: jsonBody(SetupDatabaseCheckRequest) },
  responses: { 200: jsonResponse('检查结果', SetupDatabaseCheckResponse), ...codeResponses },
})

const applyRoute = createRoute({
  method: 'post',
  path: '/setup/database',
  tags: ['setup'],
  summary: '检查并接入指定的数据库，保存连接串至数据目录',
  request: { body: jsonBody(SetupDatabaseApplyRequest) },
  responses: {
    200: jsonResponse('已接入数据库', DatabaseConnected),
    422: jsonResponse('数据库未通过检查', DatabaseSetupError),
    ...codeResponses,
  },
})

const provisionRoute = createRoute({
  method: 'post',
  path: '/setup/database/provision',
  tags: ['setup'],
  summary: '使用超级用户代建角色与数据库、安装扩展并立即接入',
  request: { body: jsonBody(SetupDatabaseProvisionRequest) },
  responses: {
    200: jsonResponse('已创建并接入数据库', DatabaseConnected),
    422: jsonResponse('代建失败', DatabaseSetupError),
    ...codeResponses,
  },
})

async function countAccounts(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(accounts)
  return row?.n ?? 0
}

function verifySetupCode(
  c: Context<AppEnv>,
  host: SetupHost,
  trustedProxies: number,
  setupCode: string,
): Response | null {
  const client = clientIdentity(c, trustedProxies).key
  const result = host.gate.verify(setupCode, client)
  if (result === 'ok') return null
  if (result === 'closed') return c.json({ error: '已完成初始化' }, 409)
  if (result === 'limited') {
    return c.json({ error: '初始化码错误次数过多，请稍后重试', code: SETUP_CODE_LIMITED }, 429)
  }
  return c.json({ error: '初始化码不正确', code: SETUP_CODE_INVALID }, 403)
}

export function setupStatusRoutes(host: SetupHost, needsSetup: () => Promise<boolean>) {
  return router().openapi(statusRoute, async (c) => {
    const db = host.database()
    return c.json(
      {
        needsSetup: await needsSetup(),
        database: {
          state: db.state,
          source: db.source,
          failure: db.check?.failure ?? null,
          summary: db.url ? summarize(db.url) : null,
        },
        masterKey: host.masterKey,
      },
      200,
    )
  })
}

export function setupDatabaseRoutes(
  host: SetupHost,
  trustedProxies: number,
  needsSetup: () => Promise<boolean>,
) {
  const app = router()

  app.openapi(checkRoute, async (c) => {
    const body = c.req.valid('json')
    if (host.database().state === 'unavailable') {
      return c.json({ error: '数据库暂时无法连接', code: DATABASE_UNAVAILABLE_CODE }, 503)
    }
    if (!(await needsSetup())) return c.json({ error: '已完成初始化' }, 409)
    const denied = verifySetupCode(c, host, trustedProxies, body.setupCode)
    if (denied) return denied as never
    const url = connectionUrl(body.connection)
    const check = await probeDatabase(url, host.migrationsFolder)
    return c.json(check, 200)
  })

  app.openapi(applyRoute, async (c) => {
    const body = c.req.valid('json')
    if (host.database().state !== 'missing') {
      return c.json({ error: '数据库已配置' }, 409)
    }
    const denied = verifySetupCode(c, host, trustedProxies, body.setupCode)
    if (denied) return denied as never

    const url = connectionUrl(body.connection)
    try {
      const check = await host.exclusive(async () => {
        const result = await probeDatabase(url, host.migrationsFolder)
        if (!result.ready) return result
        await host.activate(url)
        return result
      })
      if (!check.ready) {
        return c.json(
          {
            error: '数据库未通过检查',
            check,
            ...(check.failure ? { failure: check.failure } : {}),
          },
          422,
        )
      }
      return c.json({ summary: summarize(url)!, check }, 200)
    } catch (err) {
      if (err instanceof SetupBusyError) {
        return c.json({ error: err.message }, 409)
      }
      if (err instanceof ActivationError) {
        return c.json({ error: err.message }, 422)
      }
      throw err
    }
  })

  app.openapi(provisionRoute, async (c) => {
    const body = c.req.valid('json')
    if (host.database().state !== 'missing') {
      return c.json({ error: '数据库已配置' }, 409)
    }
    const denied = verifySetupCode(c, host, trustedProxies, body.setupCode)
    if (denied) return denied as never

    try {
      const result = await host.exclusive(async () => {
        const provisioned = await provisionDatabase({
          superuser: body.superuser,
          role: body.role,
          database: body.database,
        })
        try {
          const check = await probeDatabase(provisioned.url, host.migrationsFolder)
          await host.activate(provisioned.url)
          return { url: provisioned.url, check }
        } catch (err) {
          if (err instanceof ActivationError) {
            await provisioned.undo().catch(() => {})
          }
          throw err
        }
      })
      return c.json({ summary: summarize(result.url)!, check: result.check }, 200)
    } catch (err) {
      if (err instanceof SetupBusyError) return c.json({ error: err.message }, 409)
      if (err instanceof ProvisionError) {
        const reason = err.detail.failure
          ? `${PROVISION_PROBLEM_NAMES[err.problem]}：${DATABASE_FAILURE_NAMES[err.detail.failure]}`
          : PROVISION_PROBLEM_NAMES[err.problem]
        return c.json(
          {
            error: reason,
            problem: err.problem,
            ...(err.detail.failure ? { failure: err.detail.failure } : {}),
            ...(err.detail.extensions ? { extensions: err.detail.extensions } : {}),
          },
          422,
        )
      }
      if (err instanceof ActivationError) return c.json({ error: err.message }, 422)
      throw err
    }
  })

  return app
}

export function setupRoutes(deps: Deps) {
  const app = router()
  const needsSetup = async () => (await countAccounts(deps.db)) === 0
  const trustedProxies = deps.trustedProxies ?? 0

  if (deps.setup) {
    app.route('/', setupStatusRoutes(deps.setup, needsSetup))
    app.route('/', setupDatabaseRoutes(deps.setup, trustedProxies, needsSetup))
  } else {
    app.openapi(statusRoute, async (c) =>
      c.json(
        {
          needsSetup: await needsSetup(),
          database: {
            state: 'ready' as const,
            source: 'env' as const,
            failure: null,
            summary: null,
          },
          masterKey: Boolean(deps.masterKey),
        },
        200,
      ),
    )
  }

  app.openapi(setupRoute, async (c) => {
    const body = c.req.valid('json')
    if (deps.setup) {
      const denied = verifySetupCode(c, deps.setup, trustedProxies, body.setupCode)
      if (denied) return denied as never
    }
    const passwordHash = await hashPassword(body.password)
    const created = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kioku:setup'))`)
      const [existing] = await tx.select({ n: count() }).from(accounts)
      if ((existing?.n ?? 0) > 0) return null
      const [account] = await tx
        .insert(accounts)
        .values({
          username: body.username,
          displayName: body.displayName,
          passwordHash,
        })
        .returning()
      const sessionToken = await createSession(tx, account!.id, {
        clientAddress: clientAddress(c, trustedProxies),
        userAgent: truncateUserAgent(c.req.header('user-agent')),
      })
      return { account: account!, sessionToken }
    })

    if (!created) return c.json({ error: '已完成初始化' }, 409)
    deps.setup?.gate.close()

    const cookieOpts = {
      httpOnly: true,
      sameSite: 'Lax' as const,
      secure: deps.cookieSecure,
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    }
    setCookie(c, SESSION_COOKIE, created.sessionToken, cookieOpts)

    const deviceToken = await issueDeviceToken(deps.db, {
      id: created.account.id,
      passwordHash: created.account.passwordHash,
    })
    setCookie(c, DEVICE_COOKIE, deviceToken, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: deps.cookieSecure,
      path: DEVICE_COOKIE_PATH,
      maxAge: DEVICE_TTL_SECONDS,
    })

    const flags = await loadModelFlags(deps.db)
    return c.json(
      {
        id: created.account.id,
        username: created.account.username,
        displayName: created.account.displayName,
        hasMasterKey: Boolean(deps.masterKey),
        hasEmbeddingModel: flags.hasEmbeddingModel,
        hasChatModel: flags.hasChatModel,
        version: VERSION,
      },
      201,
    )
  })

  return app
}
