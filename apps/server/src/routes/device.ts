import { createHash, randomBytes, randomInt } from 'node:crypto'

import { createRoute } from '@hono/zod-openapi'
import {
  DEVICE_GRANT_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  DEVICE_USER_CODE_ALPHABET,
  DEVICE_USER_CODE_LENGTH,
  DeviceAuthorizeRequest,
  DeviceAuthorizeResponse,
  DeviceGrantApproveRequest,
  DeviceGrantApproveResponse,
  DeviceGrantDenyRequest,
  DeviceGrantLookupRequest,
  DeviceGrantLookupResponse,
  DeviceTokenRequest,
  DeviceTokenResponse,
  ErrorResponse,
  formatDeviceUserCode,
  type DeviceIssuedKey,
} from '@kioku/contracts'
import { and, count, eq, gt, sql } from 'drizzle-orm'

import { generateApiKey } from '../auth/keys'
import { requireConsole } from '../auth/middleware'
import type { Tx } from '../db/client'
import {
  apiKeys,
  deviceGrants,
  type DeviceGrantPlatform,
  type DeviceGrantSelection,
} from '../db/schema'
import { clientAddress, clientIdentity } from '../http/clientIp'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const MAX_PENDING = 500
const MAX_PENDING_PER_CLIENT = 10
const DEVICE_TAKE_WINDOW_SECONDS = 60
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

type GrantRow = typeof deviceGrants.$inferSelect

function grantPlatforms(
  row: Pick<GrantRow, 'runtimeFamily' | 'platforms' | 'clientName'>,
): DeviceGrantPlatform[] {
  return row.platforms ?? [{ runtimeFamily: row.runtimeFamily!, clientName: row.clientName }]
}

const authorizeRoute = createRoute({
  method: 'post',
  path: '/device/authorize',
  tags: ['device'],
  summary: '命令行发起浏览器设备授权申请',
  request: { body: jsonBody(DeviceAuthorizeRequest) },
  responses: {
    201: jsonResponse('授权申请已创建', DeviceAuthorizeResponse),
    429: jsonResponse('申请过多', ErrorResponse),
  },
})

const tokenRoute = createRoute({
  method: 'post',
  path: '/device/token',
  tags: ['device'],
  summary: '命令行轮询授权结果并在确认后惰性签发一次性访问密钥',
  request: { body: jsonBody(DeviceTokenRequest) },
  responses: {
    200: jsonResponse('轮询结果', DeviceTokenResponse),
    429: jsonResponse('轮询过于频繁', ErrorResponse),
  },
})

const lookupRoute = createRoute({
  method: 'post',
  path: '/device/grants/lookup',
  tags: ['device'],
  summary: '管理界面按确认码查看待审批的设备授权申请',
  request: { body: jsonBody(DeviceGrantLookupRequest) },
  responses: {
    200: jsonResponse('申请详情', DeviceGrantLookupResponse),
    404: jsonResponse('确认码无效或已过期', ErrorResponse),
  },
})

const approveRoute = createRoute({
  method: 'post',
  path: '/device/grants/approve',
  tags: ['device'],
  summary: '管理界面确认设备授权申请并保存终端透镜配置（待命令行取走时惰性签发密钥）',
  request: { body: jsonBody(DeviceGrantApproveRequest) },
  responses: {
    200: jsonResponse('已确认', DeviceGrantApproveResponse),
    400: jsonResponse('平台列表与申请不匹配', ErrorResponse),
    404: jsonResponse('确认码无效或已过期', ErrorResponse),
  },
})

const denyRoute = createRoute({
  method: 'post',
  path: '/device/grants/deny',
  tags: ['device'],
  summary: '管理界面拒绝设备授权申请',
  request: { body: jsonBody(DeviceGrantDenyRequest) },
  responses: {
    204: { description: '已拒绝' },
    404: jsonResponse('确认码无效或已过期', ErrorResponse),
  },
})

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

  app.openapi(authorizeRoute, async (c) => {
    const body = c.req.valid('json')
    const identity = clientIdentity(c, deps.trustedProxies ?? 0)
    const isFull = async (db: Pick<Tx, 'select'>) => {
      const [n] = await db
        .select({
          all: count(),
          mine: sql<number>`count(*) filter (where ${deviceGrants.clientKey} = ${identity.key})::int`,
        })
        .from(deviceGrants)
        .where(and(eq(deviceGrants.status, 'pending'), unexpired))
      return (
        (n?.all ?? 0) >= MAX_PENDING ||
        (identity.identified && (n?.mine ?? 0) >= MAX_PENDING_PER_CLIENT)
      )
    }

    if (await isFull(deps.db)) return c.json({ error: '待确认的申请太多，请稍后再试' }, 429)

    const created = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kioku:device-grants'))`)
      if (await isFull(tx)) return null
      const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString('base64url')
      for (let attempt = 0; attempt < 5; attempt++) {
        const userCode = newUserCode()
        const rows = await tx
          .insert(deviceGrants)
          .values({
            deviceHash: hash(deviceCode),
            userHash: hash(userCode),
            runtimeFamily: body.runtimeFamily ?? null,
            platforms:
              body.platforms?.map((p) => ({
                runtimeFamily: p.runtimeFamily,
                clientName: p.clientName ?? null,
              })) ?? null,
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

    if (!created) return c.json({ error: '待确认的申请太多，请稍后再试' }, 429)
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

  app.openapi(tokenRoute, async (c) => {
    const deviceHash = hash(c.req.valid('json').deviceCode)
    const outcome = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          grant: deviceGrants,
          expired: sql<boolean>`${deviceGrants.expiresAt} <= now()`,
          polledRecently: sql<boolean>`coalesce(${deviceGrants.lastPolledAt} > now() - interval '1 second', false)`,
        })
        .from(deviceGrants)
        .where(eq(deviceGrants.deviceHash, deviceHash))
        .for('update')

      if (!row) return { kind: 'expired' as const }
      const { grant } = row
      if (row.expired) {
        await tx.delete(deviceGrants).where(eq(deviceGrants.id, grant.id))
        return { kind: 'expired' as const }
      }
      if (grant.status === 'denied') {
        await tx.delete(deviceGrants).where(eq(deviceGrants.id, grant.id))
        return { kind: 'denied' as const }
      }
      if (grant.status === 'pending') {
        if (row.polledRecently) return { kind: 'slow' as const }
        await tx
          .update(deviceGrants)
          .set({ lastPolledAt: sql`now()` })
          .where(eq(deviceGrants.id, grant.id))
        return { kind: 'pending' as const }
      }

      // 已确认：在此事务内惰性签发 api_keys 并立即删除授权申请（一次性取走）
      const selections = grant.selections ?? []
      const envs = grant.envs ?? []
      const allowedRealms = grant.allowedRealms ?? null
      const focusRealms = grant.focusRealms ?? null
      const canWrite = grant.canWrite ?? true
      const canResolveCredentials = grant.canResolveCredentials ?? false

      await tx.delete(deviceGrants).where(eq(deviceGrants.id, grant.id))

      if (grant.runtimeFamily !== null) {
        const chosen = selections.find((s) => !('skip' in s))
        if (!chosen || 'skip' in chosen) return { kind: 'denied' as const }
        const generated = generateApiKey()
        await tx.insert(apiKeys).values({
          name: chosen.keyName,
          runtimeFamily: chosen.runtimeFamily,
          prefix: generated.prefix,
          secretHash: generated.secretHash,
          envs,
          allowedRealms,
          focusRealms,
          canWrite,
          canResolveCredentials,
        })
        return {
          kind: 'approved_single' as const,
          key: generated.plaintext,
          client: {
            slug: chosen.runtimeFamily,
            name: chosen.keyName,
            runtimeFamily: chosen.runtimeFamily,
          },
        }
      }

      const issued: DeviceIssuedKey[] = []
      for (const item of selections) {
        if ('skip' in item) {
          issued.push({ runtimeFamily: item.runtimeFamily, status: 'skipped' })
          continue
        }
        const generated = generateApiKey()
        await tx.insert(apiKeys).values({
          name: item.keyName,
          runtimeFamily: item.runtimeFamily,
          prefix: generated.prefix,
          secretHash: generated.secretHash,
          envs,
          allowedRealms,
          focusRealms,
          canWrite,
          canResolveCredentials,
        })
        issued.push({
          runtimeFamily: item.runtimeFamily,
          status: 'issued',
          key: generated.plaintext,
          client: {
            slug: item.runtimeFamily,
            name: item.keyName,
            runtimeFamily: item.runtimeFamily,
          },
        })
      }
      return { kind: 'approved_multi' as const, keys: issued }
    })

    if (outcome.kind === 'slow') {
      return c.json({ error: '轮询过于频繁，请按间隔重试' }, 429)
    }
    if (outcome.kind === 'expired') return c.json({ status: 'expired' as const }, 200)
    if (outcome.kind === 'denied') return c.json({ status: 'denied' as const }, 200)
    if (outcome.kind === 'pending') return c.json({ status: 'pending' as const }, 200)

    c.header('Cache-Control', 'no-store')
    if (outcome.kind === 'approved_single') {
      return c.json({ status: 'approved' as const, key: outcome.key, client: outcome.client }, 200)
    }
    return c.json({ status: 'approved' as const, keys: outcome.keys }, 200)
  })

  app.openapi(lookupRoute, async (c) => {
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
      .limit(1)
    if (!row) return c.json({ error: '确认码不对或已过期' }, 404)
    return c.json(
      {
        platforms: grantPlatforms(row),
        clientName: row.clientName,
        clientAddress: row.clientAddress,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      },
      200,
    )
  })

  app.openapi(approveRoute, async (c) => {
    const body = c.req.valid('json')
    const result = await deps.db.transaction(async (tx) => {
      const grant = await pendingGrant(tx, body.userCode)
      if (!grant) return { status: 404 as const, error: '确认码不对或已过期' }

      const expected = grantPlatforms(grant)
      const expectedSet = new Set(expected.map((p) => p.runtimeFamily))
      const seen = new Set<string>()
      const selections: DeviceGrantSelection[] = []
      const approvedItems: {
        runtimeFamily: DeviceGrantPlatform['runtimeFamily']
        keyName: string
      }[] = []

      for (const item of body.items) {
        if (!expectedSet.has(item.runtimeFamily) || seen.has(item.runtimeFamily)) {
          return { status: 400 as const, error: '所选平台与申请列表不一致' }
        }
        seen.add(item.runtimeFamily)
        if ('skip' in item && item.skip) {
          selections.push({ runtimeFamily: item.runtimeFamily, skip: true })
        } else {
          const keyName = 'keyName' in item ? item.keyName : ''
          selections.push({ runtimeFamily: item.runtimeFamily, keyName })
          approvedItems.push({ runtimeFamily: item.runtimeFamily, keyName })
        }
      }

      if (seen.size !== expectedSet.size) {
        return { status: 400 as const, error: '请为申请中的每个平台确认或跳过' }
      }
      if (!approvedItems.length) {
        return { status: 400 as const, error: '至少保留一个要签发的平台' }
      }

      await tx
        .update(deviceGrants)
        .set({
          status: 'approved',
          selections,
          keyName: approvedItems[0]?.keyName ?? null,
          envs: body.envs,
          allowedRealms: body.allowedRealms,
          focusRealms: body.focusRealms?.length ? body.focusRealms : null,
          canWrite: body.canWrite,
          canResolveCredentials: body.canResolveCredentials,
          approvedAt: sql`now()`,
          expiresAt: sql`now() + make_interval(secs => ${DEVICE_TAKE_WINDOW_SECONDS})`,
        })
        .where(eq(deviceGrants.id, grant.id))

      return { status: 200 as const, items: approvedItems }
    })

    if (result.status !== 200) {
      return c.json({ error: result.error }, result.status)
    }
    return c.json({ items: result.items }, 200)
  })

  app.openapi(denyRoute, async (c) => {
    const { userCode } = c.req.valid('json')
    const updated = await deps.db
      .update(deviceGrants)
      .set({ status: 'denied' })
      .where(
        and(
          eq(deviceGrants.userHash, hash(userCode)),
          eq(deviceGrants.status, 'pending'),
          unexpired,
        ),
      )
      .returning({ id: deviceGrants.id })
    if (!updated.length) return c.json({ error: '确认码不对或已过期' }, 404)
    return c.body(null, 204)
  })

  return app
}
