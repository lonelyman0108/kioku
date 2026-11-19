import { createHash, randomBytes, randomInt } from 'node:crypto'

import { createRoute } from '@hono/zod-openapi'
import {
  DEVICE_GRANT_TTL_SECONDS,
  DEVICE_KEY_DENIALS,
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
  DeviceGrantProblem,
  DeviceTokenRequest,
  DeviceTokenResponse,
  ErrorResponse,
  formatDeviceUserCode,
  RUNTIME_FAMILY_NAMES,
  RuntimeFamily,
  type DeviceGrantItem,
  type DeviceIssuedKey,
  type DeviceKeyDenial,
} from '@kioku/contracts'
import { and, count, eq, gt, inArray, sql } from 'drizzle-orm'

import { toClientInfo } from '../access/clients'
import {
  clientOwnerOf,
  issueClientKey,
  issueDenial,
  linkedCirclesDenial,
  membershipOf,
} from '../access/issue'
import { requireConsole } from '../auth/middleware'
import { withCircle, type Tx } from '../db/client'
import {
  circleMembers,
  clients,
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

function grantPlatforms(row: Pick<GrantRow, 'runtimeFamily' | 'platforms'>): DeviceGrantPlatform[] {
  return row.platforms ?? [{ runtimeFamily: row.runtimeFamily!, clientName: null }]
}

function grantSelections(
  row: Pick<
    GrantRow,
    'selections' | 'runtimeFamily' | 'clientId' | 'keyName' | 'scopes' | 'contextFacets'
  >,
): DeviceGrantSelection[] | null {
  if (row.selections) return row.selections
  if (row.runtimeFamily && row.clientId && row.keyName && row.scopes) {
    return [
      {
        runtimeFamily: row.runtimeFamily,
        clientId: row.clientId,
        keyName: row.keyName,
        scopes: row.scopes,
        ...(row.contextFacets ? { contextFacets: row.contextFacets } : {}),
      },
    ]
  }
  return null
}

const selectionClientIds = (selections: readonly DeviceGrantSelection[]) =>
  [...new Set(selections.flatMap((s) => ('clientId' in s ? [s.clientId] : [])))].sort()

const tooMany = jsonResponse('申请太多', ErrorResponse)
const notFound = jsonResponse('确认码不对或已过期', ErrorResponse)

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
  summary: '确认申请：选好主场记忆圈、关联客场圈、接入实例、在场切面与权限范围',
  request: { body: jsonBody(DeviceGrantApprove) },
  responses: {
    200: jsonResponse('已确认', DeviceGrantApproved),
    400: jsonResponse('选择和申请的平台对不上', DeviceGrantProblem),
    403: jsonResponse('没有权限', DeviceGrantProblem),
    404: jsonResponse('确认码不对或已过期，或者接入实例不存在', DeviceGrantProblem),
    409: jsonResponse('接入实例的标识已被占用，或者运行时与申请的不一致', DeviceGrantProblem),
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
      const full = async (db: Pick<Tx, 'select'>) => {
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
      if (await full(deps.db)) return c.json({ error: '待确认的申请太多，稍后再试' }, 429)
      const created = await deps.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kioku:device-grants'))`)
        if (await full(tx)) return null
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
      const timing = {
        expired: sql<boolean>`${deviceGrants.expiresAt} <= now()`,
        polledRecently: sql<boolean>`coalesce(${deviceGrants.lastPolledAt} > now() - interval '1 second', false)`,
      }
      const first = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ grant: deviceGrants, ...timing })
          .from(deviceGrants)
          .where(eq(deviceGrants.deviceHash, deviceHash))
          .for('update')
        if (!row) return { status: 'expired' as const }
        const { grant } = row
        if (row.expired) {
          await tx.delete(deviceGrants).where(eq(deviceGrants.id, grant.id))
          return { status: 'expired' as const }
        }
        if (grant.status === 'denied') {
          await tx.delete(deviceGrants).where(eq(deviceGrants.id, grant.id))
          return { status: 'denied' as const }
        }
        if (grant.status === 'pending') {
          if (row.polledRecently) return { status: 'slow' as const }
          await tx
            .update(deviceGrants)
            .set({ lastPolledAt: sql`now()` })
            .where(eq(deviceGrants.id, grant.id))
          return { status: 'pending' as const }
        }
        const selections = grantSelections(grant)
        const clientIds = selections ? selectionClientIds(selections) : []
        if (!grant.circleId || !clientIds.length) {
          await tx.delete(deviceGrants).where(eq(deviceGrants.id, grant.id))
          return { status: 'expired' as const }
        }
        return { status: 'approved' as const, circleId: grant.circleId, clientIds }
      })
      if (first.status === 'slow') return c.json({ error: '轮询太频繁' }, 429)
      if (first.status !== 'approved') return c.json({ status: first.status }, 200)

      const { circleId, clientIds } = first
      const result = await withCircle(deps.db, circleId, async (tx) => {
        for (const clientId of clientIds) await clientOwnerOf(tx, clientId, true)
        const [row] = await tx
          .select({ grant: deviceGrants, expired: timing.expired })
          .from(deviceGrants)
          .where(and(eq(deviceGrants.deviceHash, deviceHash), eq(deviceGrants.status, 'approved')))
          .for('update')
        if (!row || row.expired) return { status: 'expired' as const }
        const { grant } = row
        await tx.delete(deviceGrants).where(eq(deviceGrants.id, grant.id))
        const selections = grantSelections(grant)
        const { approvedBy, approvedAt } = grant
        if (
          !approvedBy ||
          !approvedAt ||
          !selections ||
          selectionClientIds(selections).join() !== clientIds.join()
        ) {
          return { status: 'denied' as const }
        }

        const member = await membershipOf(tx, circleId, approvedBy)
        const role =
          member && !member.disabledAt && member.memberSince <= approvedAt ? member.role : null

        // 逐圈复核全部 linkedCircles：确认人须仍在客场圈内且加入不晚于确认时刻，read_write 须仍非 viewer
        const linked = grant.linkedCircles ?? []
        let linkedInvalid = false
        if (linked.length) {
          const linkedIds = [...new Set(linked.map((l) => l.circleId))]
          const lmRows = await tx
            .select({
              circleId: circleMembers.circleId,
              role: circleMembers.role,
              joinedAt: circleMembers.createdAt,
            })
            .from(circleMembers)
            .where(
              and(
                inArray(circleMembers.circleId, linkedIds),
                eq(circleMembers.accountId, approvedBy),
              ),
            )
          const lmByCircle = new Map(lmRows.map((r) => [r.circleId, r]))
          for (const item of linked) {
            if (item.circleId === circleId) {
              linkedInvalid = true
              break
            }
            const lm = lmByCircle.get(item.circleId)
            if (!lm || lm.joinedAt > approvedAt) {
              linkedInvalid = true
              break
            }
            if (item.mode === 'read_write' && lm.role === 'viewer') {
              linkedInvalid = true
              break
            }
          }
        }

        const keys: DeviceIssuedKey[] = []
        for (const selection of selections) {
          const runtimeFamily = RuntimeFamily.parse(selection.runtimeFamily)
          if (!('clientId' in selection)) {
            keys.push({ runtimeFamily, status: 'skipped' })
            continue
          }
          const denied = (reason: DeviceKeyDenial) =>
            keys.push({ runtimeFamily, status: 'denied', reason })
          if (!role) {
            denied(DEVICE_KEY_DENIALS.member)
            continue
          }
          if (issueDenial(role, selection.scopes)) {
            denied(DEVICE_KEY_DENIALS.role)
            continue
          }
          if (linkedInvalid) {
            denied(DEVICE_KEY_DENIALS.linked)
            continue
          }
          const issued = await issueClientKey(tx, {
            circleId,
            clientId: selection.clientId,
            accountId: approvedBy,
            name: selection.keyName,
            linkedCircles: linked,
            contextFacets: selection.contextFacets ?? grant.contextFacets ?? {},
            scopes: selection.scopes,
          })
          if (!issued.ok) {
            denied(DEVICE_KEY_DENIALS.client)
            continue
          }
          keys.push({
            runtimeFamily,
            status: 'issued',
            key: issued.plaintext,
            client: {
              slug: issued.client.slug,
              name: issued.client.name,
              runtimeFamily: issued.client.runtimeFamily,
            },
          })
        }
        if (grant.platforms === null) {
          const [only] = keys
          if (only?.status !== 'issued') return { status: 'denied' as const }
          return { status: 'approved' as const, key: only.key, client: only.client }
        }
        return { status: 'approved' as const, keys }
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
          platforms: grantPlatforms(row).map((p) => ({
            runtimeFamily: RuntimeFamily.parse(p.runtimeFamily),
            clientName: p.clientName,
          })),
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
      const { circleId } = body
      try {
        const chosen = await withCircle(deps.db, circleId, async (tx) => {
          const member = await membershipOf(tx, circleId, accountId)
          if (!member) return refuse(403, '无权访问此记忆圈')
          const linkedDenial = await linkedCirclesDenial(
            tx,
            accountId,
            circleId,
            body.linkedCircles,
          )
          if (linkedDenial) return refuse(403, linkedDenial)

          for (const item of body.items) {
            if (!('client' in item)) continue
            const denial = issueDenial(member.role, item.scopes)
            if (denial) refuse(403, denial, item.runtimeFamily)
          }
          const existing = await lockClients(tx, body.items)
          const grant = await pendingGrant(tx, body.userCode)
          if (!grant) return refuse(404, '确认码不对或已过期')
          const items = orderedItems(grantPlatforms(grant), body.items)

          const selections: DeviceGrantSelection[] = []
          const picked: ApprovedItem[] = []
          for (const item of items) {
            if (!('client' in item)) {
              selections.push({ runtimeFamily: item.runtimeFamily, skip: true })
              continue
            }
            const target = await approveTarget(tx, item, existing, accountId, circleId)
            const contextFacets = item.contextFacets ?? body.contextFacets
            selections.push({
              runtimeFamily: item.runtimeFamily,
              clientId: target.id,
              keyName: item.keyName,
              scopes: item.scopes,
              contextFacets,
            })
            picked.push({
              runtimeFamily: item.runtimeFamily,
              client: target,
              keyName: item.keyName,
            })
          }
          await tx
            .update(deviceGrants)
            .set({
              status: 'approved',
              approvedBy: accountId,
              approvedAt: sql`now()`,
              circleId,
              linkedCircles: body.linkedCircles,
              contextFacets: body.contextFacets,
              selections,
              clientId: grant.platforms === null ? picked[0]!.client.id : null,
              expiresAt: sql`greatest(${deviceGrants.expiresAt}, now() + make_interval(secs => ${DEVICE_TAKE_WINDOW_SECONDS}))`,
            })
            .where(eq(deviceGrants.id, grant.id))
          return picked
        })
        return c.json(
          {
            items: chosen.map((item) => ({
              runtimeFamily: item.runtimeFamily,
              client: toClientInfo(item.client),
              keyName: item.keyName,
            })),
          },
          200,
        )
      } catch (err) {
        if (err instanceof ApproveRefused) return c.json(err.body, err.status)
        throw err
      }
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

type ApprovedItem = {
  runtimeFamily: RuntimeFamily
  client: ClientRow
  keyName: string
}

class ApproveRefused extends Error {
  readonly body: DeviceGrantProblem
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    error: string,
    runtimeFamily?: RuntimeFamily,
  ) {
    super(error)
    this.body = runtimeFamily
      ? { error: `${RUNTIME_FAMILY_NAMES[runtimeFamily]}：${error}`, runtimeFamily }
      : { error }
  }
}

function refuse(
  status: ApproveRefused['status'],
  error: string,
  runtimeFamily?: RuntimeFamily,
): never {
  throw new ApproveRefused(status, error, runtimeFamily)
}

function orderedItems(
  platforms: readonly DeviceGrantPlatform[],
  items: readonly DeviceGrantItem[],
): DeviceGrantItem[] {
  const matched = platforms.map((p) =>
    items.filter((item) => item.runtimeFamily === p.runtimeFamily),
  )
  if (items.length !== platforms.length || matched.some((m) => m.length !== 1)) {
    return refuse(400, '每个申请的平台要恰好有一项选择')
  }
  const ordered = matched.map((m) => m[0]!)
  if (ordered.every((item) => !('client' in item))) refuse(400, '至少选择一个平台')
  return ordered
}

type ClientRow = typeof clients.$inferSelect

async function lockClients(
  tx: Tx,
  items: readonly DeviceGrantItem[],
): Promise<Map<string, ClientRow>> {
  const ids = [
    ...new Set(
      items.flatMap((item) => ('client' in item && 'id' in item.client ? [item.client.id] : [])),
    ),
  ].sort()
  const locked = new Map<string, ClientRow>()
  for (const id of ids) {
    const [row] = await tx.select().from(clients).where(eq(clients.id, id)).for('update')
    if (row) locked.set(id, row)
  }
  return locked
}

async function approveTarget(
  tx: Tx,
  item: Extract<DeviceGrantItem, { client: unknown }>,
  existing: ReadonlyMap<string, ClientRow>,
  accountId: string,
  circleId: string,
): Promise<ClientRow> {
  const { runtimeFamily } = item
  if ('id' in item.client) {
    const found = existing.get(item.client.id)
    if (!found) return refuse(404, '接入实例不存在', runtimeFamily)
    if (found.ownerAccountId !== accountId) {
      return refuse(403, '仅接入实例所有者可签发此接入实例的访问密钥', runtimeFamily)
    }
    if (found.runtimeFamily !== runtimeFamily) {
      return refuse(409, '接入实例的运行时与申请的不一致', runtimeFamily)
    }
    return found
  }
  const [created] = await tx
    .insert(clients)
    .values({
      circleId,
      slug: item.client.slug,
      name: item.client.name,
      runtimeFamily,
      ownerAccountId: accountId,
    })
    .onConflictDoNothing()
    .returning()
  if (!created) return refuse(409, `标识 ${item.client.slug} 已被占用`, runtimeFamily)
  return created
}
