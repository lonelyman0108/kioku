import { createRoute } from '@hono/zod-openapi'
import {
  ErrorResponse,
  LEGACY_ADMIN_INVALID,
  LEGACY_ADMIN_LIMITED,
  LegacyUpgradeRequest,
  LegacyUpgradeResult,
  LegacyUpgradeStatus,
} from '@kioku/contracts'
import { sql } from 'drizzle-orm'
import type { Context } from 'hono'

import { hashPassword, verifyPassword } from '../auth/password'
import { ClientAttempts } from '../auth/setupCode'
import { logInternalError, type Tx } from '../db/client'
import { clientIdentity } from '../http/clientIp'
import type { SetupHost } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { LegacyUpgradeError } from '../importer/legacyInPlace'
import { SetupBusyError } from '../setupErrors'

const status = createRoute({
  method: 'get',
  path: '/legacy-upgrade/status',
  tags: ['setup'],
  summary: '库是不是重构之前的结构、在等就地升级',
  responses: { 200: jsonResponse('升级状态', LegacyUpgradeStatus) },
})

const upgradeResponses = {
  200: jsonResponse('迁移统计', LegacyUpgradeResult),
  403: jsonResponse('旧管理员账号或密码错误', ErrorResponse),
  409: jsonResponse('不是待迁移的状态，或者正在迁移', ErrorResponse),
  422: jsonResponse('迁移无法进行', ErrorResponse),
  429: jsonResponse('错误次数过多', ErrorResponse),
  500: jsonResponse('迁移失败', ErrorResponse),
}

const preview = createRoute({
  method: 'post',
  path: '/legacy-upgrade/preview',
  tags: ['setup'],
  summary: '预览就地升级：整套迁移跑完再回滚，返回统计',
  request: { body: jsonBody(LegacyUpgradeRequest) },
  responses: upgradeResponses,
})

const apply = createRoute({
  method: 'post',
  path: '/legacy-upgrade/apply',
  tags: ['setup'],
  summary: '执行就地升级：旧对象移进 kioku_legacy，迁入新结构并切换到完整服务',
  request: { body: jsonBody(LegacyUpgradeRequest) },
  responses: upgradeResponses,
})

class AdminRejected extends Error {}

// 账号不存在时也算一次哈希，响应时间不暴露用户名是否存在
let dummyHash: Promise<string> | null = null

// 在迁移的事务里核对旧实例的管理员：表还在 public 里，是重构之前的 accounts
function authorizer(username: string, password: string) {
  return async (tx: Tx) => {
    const [row] = await tx.execute<Record<string, unknown>>(
      sql`select * from public.accounts where username = ${username}`,
    )
    const passwordHash = typeof row?.password_hash === 'string' ? row.password_hash : null
    if (!passwordHash) {
      dummyHash ??= hashPassword('kioku-legacy-upgrade')
      await verifyPassword(password, await dummyHash)
      throw new AdminRejected()
    }
    const ok = await verifyPassword(password, passwordHash)
    if (!ok || !row?.is_admin || row?.disabled_at) throw new AdminRejected()
  }
}

// 旧库里的说明是写给运维的（规划与写入时的数据问题），管理员已经核对过身份，可以原样给人看；
// 数据库报的错只记日志
function knownFailure(err: unknown): string | null {
  if (err instanceof LegacyUpgradeError) return err.message
  if (err instanceof Error && err.constructor === Error && !('code' in err)) return err.message
  return null
}

// 升级页的接口：只在库是重构之前的结构时由初始化专用的应用提供。靠旧实例的管理员账号保护，
// 按客户端限次（和初始化码同一种计数），计数在内存里
export function legacyUpgradeRoutes(host: SetupHost, trustedProxies: number) {
  const attempts = new ClientAttempts()

  const run = async (c: Context, applyNow: boolean, body: LegacyUpgradeRequest) => {
    if (host.database().state !== 'legacy') {
      return c.json({ error: '数据库不是待迁移的状态' }, 409)
    }
    const identity = clientIdentity(c, trustedProxies)
    const client = identity.identified ? identity.key : null
    if (!attempts.take(client)) {
      return c.json({ error: '错误次数过多，请稍后重试', code: LEGACY_ADMIN_LIMITED }, 429)
    }
    try {
      const result = await host.exclusive(() =>
        host.upgradeLegacy({
          apply: applyNow,
          authorize: authorizer(body.username, body.password),
        }),
      )
      attempts.clear(client)
      return c.json(result, 200)
    } catch (err) {
      if (err instanceof AdminRejected) {
        return c.json(
          { error: '用户名或密码错误，或者不是旧实例的管理员', code: LEGACY_ADMIN_INVALID },
          403,
        )
      }
      if (err instanceof SetupBusyError) return c.json({ error: err.message }, 409)
      const known = knownFailure(err)
      if (known) return c.json({ error: known }, 422)
      logInternalError('就地升级失败', err)
      return c.json({ error: '迁移失败：原因见服务日志' }, 500)
    }
  }

  return router()
    .openapi(status, (c) =>
      c.json({ pending: host.database().state === 'legacy', masterKey: host.masterKey }, 200),
    )
    .openapi(preview, (c) => run(c, false, c.req.valid('json')) as never)
    .openapi(apply, (c) => run(c, true, c.req.valid('json')) as never)
}
