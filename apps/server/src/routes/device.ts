import { createHash, randomBytes, randomInt } from 'node:crypto'

import { createRoute } from '@hono/zod-openapi'
import {
  AppConfig,
  DEVICE_GRANT_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  DEVICE_USER_CODE_ALPHABET,
  DEVICE_USER_CODE_LENGTH,
  DeviceAuthorization,
  DeviceAuthorizeRequest,
  DeviceGrantApprove,
  DeviceGrantApproved,
  DeviceGrantDeny,
  DeviceGrantInfo,
  DeviceGrantLookup,
  DeviceTokenRequest,
  DeviceTokenResponse,
  ErrorResponse,
  formatDeviceUserCode,
  RuntimeFamily,
} from '@kioku/contracts'
import { and, count, eq, gt, sql } from 'drizzle-orm'

import { appOwnerOf, issueAppKey, issueDenial, membershipOf } from '../access/issue'
import { requireConsole } from '../auth/middleware'
import { withSpace, type Tx } from '../db/client'
import { apps, deviceGrants } from '../db/schema'
import { clientAddress, clientIdentity } from '../http/clientIp'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

// 浏览器授权。三方各走各的接口：
// - 命令行（不带任何凭证）：申请，之后凭设备码轮询、取走一次访问密钥
// - 管理界面里登录了的成员：按确认码查看申请，确认或拒绝
// 访问密钥在取走的那一刻才生成：确认时只记下确认人的选择，取走时照签发的规则再核对一遍，
// 所以库里从头到尾没有明文，确认之后确认人被降级、停用、移出空间的，取的时候就拿不到

// 同时待确认的申请上限：整个实例，以及每个客户端。申请不用登录，不设上限的话可以拿它塞满这张表
const MAX_PENDING = 500
const MAX_PENDING_PER_CLIENT = 10
// 设备码的随机字节数
const DEVICE_CODE_BYTES = 32

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function newUserCode(): string {
  let code = ''
  for (let i = 0; i < DEVICE_USER_CODE_LENGTH; i++) {
    code += DEVICE_USER_CODE_ALPHABET[randomInt(DEVICE_USER_CODE_ALPHABET.length)]
  }
  return code
}

const unexpired = gt(deviceGrants.expiresAt, sql`now()`)

const tooMany = jsonResponse('申请太多', ErrorResponse)
const notFound = jsonResponse('确认码不对或已过期', ErrorResponse)
const forbidden = jsonResponse('没有权限', ErrorResponse)

const authorize = createRoute({
  method: 'post',
  path: '/device/authorize',
  tags: ['device'],
  summary: '命令行申请浏览器授权',
  request: { body: jsonBody(DeviceAuthorizeRequest) },
  responses: { 201: jsonResponse('申请', DeviceAuthorization), 429: tooMany },
})

const token = createRoute({
  method: 'post',
  path: '/device/token',
  tags: ['device'],
  summary: '命令行凭设备码查看申请的结果，确认之后取走一次访问密钥',
  request: { body: jsonBody(DeviceTokenRequest) },
  responses: { 200: jsonResponse('结果', DeviceTokenResponse), 429: tooMany },
})

const lookup = createRoute({
  method: 'post',
  path: '/device/grants/lookup',
  tags: ['device'],
  summary: '按确认码查看申请',
  request: { body: jsonBody(DeviceGrantLookup) },
  responses: { 200: jsonResponse('申请', DeviceGrantInfo), 404: notFound },
})

const approve = createRoute({
  method: 'post',
  path: '/device/grants/approve',
  tags: ['device'],
  summary: '确认申请：选好空间、应用与权限范围',
  request: { body: jsonBody(DeviceGrantApprove) },
  responses: {
    200: jsonResponse('已确认', DeviceGrantApproved),
    403: forbidden,
    404: notFound,
    409: jsonResponse('应用的标识已被占用', ErrorResponse),
  },
})

const deny = createRoute({
  method: 'post',
  path: '/device/grants/deny',
  tags: ['device'],
  summary: '拒绝申请',
  request: { body: jsonBody(DeviceGrantDeny) },
  responses: { 204: { description: '已拒绝' }, 404: notFound },
})

// 待确认、没过期的申请，按确认码找，锁住这一行
async function pendingGrant(tx: Tx, userCode: string) {
  const [row] = await tx
    .select()
    .from(deviceGrants)
    .where(
      and(eq(deviceGrants.userHash, hash(userCode)), eq(deviceGrants.status, 'pending'), unexpired),
    )
    .for('update')
  return row ?? null
}

export function deviceRoutes(deps: Deps) {
  const app = router()
  app.use('/device/grants/*', requireConsole(deps))

  return app
    .openapi(authorize, async (c) => {
      const body = c.req.valid('json')
      const identity = clientIdentity(c, deps.trustedProxies ?? 0)
      const created = await deps.db.transaction(async (tx) => {
        // 数待确认的申请要和插入串行，否则并发的申请都看到「还没满」
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kioku:device-grants'))`)
        const pending = and(eq(deviceGrants.status, 'pending'), unexpired)
        const [all] = await tx.select({ n: count() }).from(deviceGrants).where(pending)
        const [mine] = await tx
          .select({ n: count() })
          .from(deviceGrants)
          .where(and(pending, eq(deviceGrants.clientKey, identity.key)))
        if ((all?.n ?? 0) >= MAX_PENDING || (mine?.n ?? 0) >= MAX_PENDING_PER_CLIENT) return null
        const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString('base64url')
        // 确认码撞上了还在的申请就换一个
        for (let attempt = 0; attempt < 5; attempt++) {
          const userCode = newUserCode()
          const rows = await tx
            .insert(deviceGrants)
            .values({
              deviceHash: hash(deviceCode),
              userHash: hash(userCode),
              runtimeFamily: body.runtimeFamily,
              clientName: body.clientName ?? null,
              clientAddress: clientAddress(c, deps.trustedProxies ?? 0),
              clientKey: identity.key,
              expiresAt: sql`now() + make_interval(secs => ${DEVICE_GRANT_TTL_SECONDS})`,
            })
            .onConflictDoNothing()
            .returning({ id: deviceGrants.id })
          if (rows.length) return { deviceCode, userCode }
        }
        return null
      })
      if (!created) return c.json({ error: '待确认的申请太多，稍后再试' }, 429)
      return c.json(
        {
          deviceCode: created.deviceCode,
          userCode: formatDeviceUserCode(created.userCode),
          verificationPath: '/authorize',
          expiresIn: DEVICE_GRANT_TTL_SECONDS,
          interval: DEVICE_POLL_INTERVAL_SECONDS,
        },
        201,
      )
    })
    .openapi(token, async (c) => {
      const deviceHash = hash(c.req.valid('json').deviceCode)
      // 先不带空间看一眼：待确认、拒绝、过期都在这里答掉
      const first = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(deviceGrants)
          .where(eq(deviceGrants.deviceHash, deviceHash))
          .for('update')
        // 设备码不对和过期、已经取走答得一样
        if (!row) return { status: 'expired' as const }
        if (row.expiresAt.getTime() <= Date.now()) {
          await tx.delete(deviceGrants).where(eq(deviceGrants.id, row.id))
          return { status: 'expired' as const }
        }
        if (row.status === 'denied') {
          await tx.delete(deviceGrants).where(eq(deviceGrants.id, row.id))
          return { status: 'denied' as const }
        }
        if (row.status === 'pending') {
          // 轮询得太勤的让它慢一点；不更新时间，免得一直被挡
          const last = row.lastPolledAt?.getTime() ?? 0
          if (Date.now() - last < 1000) return { status: 'slow' as const }
          await tx
            .update(deviceGrants)
            .set({ lastPolledAt: sql`now()` })
            .where(eq(deviceGrants.id, row.id))
          return { status: 'pending' as const }
        }
        return { status: 'approved' as const, spaceId: row.spaceId }
      })
      if (first.status === 'slow') return c.json({ error: '轮询太频繁' }, 429)
      if (first.status !== 'approved') return c.json({ status: first.status }, 200)
      if (!first.spaceId) return c.json({ status: 'expired' as const }, 200)

      // 确认过的：在空间的事务里再锁一次这一行（同时来的两次轮询只有一次拿得到），
      // 照签发的规则核对确认人现在的角色与应用的所有者，过了才生成访问密钥；不管成不成，这条申请都删掉
      const spaceId = first.spaceId
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        const [row] = await tx
          .select()
          .from(deviceGrants)
          .where(and(eq(deviceGrants.deviceHash, deviceHash), eq(deviceGrants.status, 'approved')))
          .for('update')
        if (!row || row.expiresAt.getTime() <= Date.now()) return { status: 'expired' as const }
        await tx.delete(deviceGrants).where(eq(deviceGrants.id, row.id))
        const { approvedBy, appId, keyName, scopes } = row
        if (!approvedBy || !appId || !keyName || !scopes) return { status: 'denied' as const }
        const member = await membershipOf(tx, spaceId, approvedBy)
        if (!member || member.disabledAt || issueDenial(member.role, scopes)) {
          return { status: 'denied' as const }
        }
        const issued = await issueAppKey(tx, {
          spaceId,
          appId,
          accountId: approvedBy,
          name: keyName,
          scopes,
        })
        if (!issued.ok) return { status: 'denied' as const }
        const [target] = await tx.select().from(apps).where(eq(apps.id, appId))
        return {
          status: 'approved' as const,
          key: issued.plaintext,
          app: {
            slug: target!.slug,
            name: target!.name,
            runtimeFamily: target!.runtimeFamily,
          },
        }
      })
      return c.json(result, 200)
    })
    .openapi(lookup, async (c) => {
      const { userCode } = c.req.valid('json')
      const [row] = await deps.db
        .select()
        .from(deviceGrants)
        .where(
          and(
            eq(deviceGrants.userHash, hash(userCode)),
            eq(deviceGrants.status, 'pending'),
            unexpired,
          ),
        )
      if (!row) return c.json({ error: '确认码不对或已过期' }, 404)
      return c.json(
        {
          runtimeFamily: RuntimeFamily.parse(row.runtimeFamily),
          clientName: row.clientName,
          clientAddress: row.clientAddress,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
        },
        200,
      )
    })
    .openapi(approve, async (c) => {
      const body = c.req.valid('json')
      const accountId = c.get('console').accountId
      const { spaceId } = body
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        const member = await membershipOf(tx, spaceId, accountId)
        // 不是这个空间的成员：和别的管理接口一样答 403，不说空间在不在
        if (!member) return { error: '无权访问此空间', status: 403 as const }
        const denial = issueDenial(member.role, body.scopes)
        if (denial) return { error: denial, status: 403 as const }
        const grant = await pendingGrant(tx, body.userCode)
        if (!grant) return { error: '确认码不对或已过期', status: 404 as const }

        let appId: string
        if ('id' in body.app) {
          // 已有的应用：要是确认人自己的。签发时还会再核对一次
          const owner = await appOwnerOf(tx, body.app.id, true)
          if (!owner) return { error: '应用不存在', status: 404 as const }
          if (owner !== accountId) {
            return { error: '仅应用所有者可签发此应用的访问密钥', status: 403 as const }
          }
          appId = body.app.id
        } else {
          const [created] = await tx
            .insert(apps)
            .values({
              spaceId,
              slug: body.app.slug,
              name: body.app.name,
              runtimeFamily: grant.runtimeFamily,
              ownerAccountId: accountId,
            })
            .onConflictDoNothing()
            .returning({ id: apps.id })
          if (!created) return { error: `标识 ${body.app.slug} 已被占用`, status: 409 as const }
          appId = created.id
        }
        await tx
          .update(deviceGrants)
          .set({
            status: 'approved',
            approvedBy: accountId,
            spaceId,
            appId,
            keyName: body.keyName,
            scopes: body.scopes,
          })
          .where(eq(deviceGrants.id, grant.id))
        const [target] = await tx.select().from(apps).where(eq(apps.id, appId))
        return { app: target! }
      })
      if ('error' in result) return c.json({ error: result.error }, result.status)
      const row = result.app
      return c.json(
        {
          app: {
            id: row.id,
            slug: row.slug,
            name: row.name,
            runtimeFamily: row.runtimeFamily,
            ownerAccountId: row.ownerAccountId,
            defaultPersonaId: row.defaultPersonaId,
            config: AppConfig.parse(row.config),
          },
        },
        200,
      )
    })
    .openapi(deny, async (c) => {
      const { userCode } = c.req.valid('json')
      const denied = await deps.db.transaction(async (tx) => {
        const grant = await pendingGrant(tx, userCode)
        if (!grant) return false
        await tx.update(deviceGrants).set({ status: 'denied' }).where(eq(deviceGrants.id, grant.id))
        return true
      })
      if (!denied) return c.json({ error: '确认码不对或已过期' }, 404)
      return c.body(null, 204)
    })
}
