import { createHash, randomBytes, randomInt } from 'node:crypto'

import { createRoute } from '@hono/zod-openapi'
import {
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
  DeviceGrantProblem,
  DEVICE_KEY_DENIALS,
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
import { and, count, eq, gt, sql } from 'drizzle-orm'

import { appOwnerOf, issueAppKey, issueDenial, membershipOf } from '../access/issue'
import { requireConsole } from '../auth/middleware'
import { toAppInfo } from './apps'
import { withSpace, type Tx } from '../db/client'
import {
  apps,
  deviceGrants,
  type DeviceGrantPlatform,
  type DeviceGrantSelection,
} from '../db/schema'
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
// 确认之后至少留这么久给命令行取走（秒）
const DEVICE_TAKE_WINDOW_SECONDS = 60
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

type GrantRow = typeof deviceGrants.$inferSelect

// 申请里的平台：单个平台的申请也规整成一项
function grantPlatforms(row: Pick<GrantRow, 'runtimeFamily' | 'platforms'>): DeviceGrantPlatform[] {
  return row.platforms ?? [{ runtimeFamily: row.runtimeFamily!, clientName: null }]
}

// 确认时的选择。升级之前确认、还没取走的单平台申请只有 appId、keyName、scopes 三列，规整成一项
function grantSelections(
  row: Pick<GrantRow, 'selections' | 'runtimeFamily' | 'appId' | 'keyName' | 'scopes'>,
): DeviceGrantSelection[] | null {
  if (row.selections) return row.selections
  if (row.runtimeFamily && row.appId && row.keyName && row.scopes) {
    return [
      {
        runtimeFamily: row.runtimeFamily,
        appId: row.appId,
        keyName: row.keyName,
        scopes: row.scopes,
      },
    ]
  }
  return null
}

// 确认涉及的应用，按 id 排好：取走时按这个顺序加锁，几次取走之间不会互相等住
const selectionAppIds = (selections: readonly DeviceGrantSelection[]) =>
  [...new Set(selections.flatMap((s) => ('appId' in s ? [s.appId] : [])))].sort()

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
  summary: '确认申请：选好空间、应用与权限范围',
  request: { body: jsonBody(DeviceGrantApprove) },
  responses: {
    200: jsonResponse('已确认', DeviceGrantApproved),
    400: jsonResponse('选择和申请的平台对不上', DeviceGrantProblem),
    403: jsonResponse('没有权限', DeviceGrantProblem),
    404: jsonResponse('确认码不对或已过期，或者应用不存在', DeviceGrantProblem),
    409: jsonResponse('应用的标识已被占用，或者运行时与申请的不一致', DeviceGrantProblem),
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
      // 待确认的申请有没有到上限。认不出客户端时（取不到地址）不按客户端数：
      // 那样所有人共用一个名额，几条申请就能让别人都申请不了，只看全实例的上限
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
      // 先不加锁看一眼：已经满了的请求不去排那把锁，不占着连接等
      if (await full(deps.db)) return c.json({ error: '待确认的申请太多，稍后再试' }, 429)
      const created = await deps.db.transaction(async (tx) => {
        // 数待确认的申请要和插入串行，否则并发的申请都看到「还没满」
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('kioku:device-grants'))`)
        if (await full(tx)) return null
        const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString('base64url')
        // 确认码撞上了还在的申请就换一个
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
      // 过期与轮询间隔都按数据库的时钟比：这些时间是数据库写的，应用进程的时钟和它差几秒就会判错
      const timing = {
        expired: sql<boolean>`${deviceGrants.expiresAt} <= now()`,
        polledRecently: sql<boolean>`coalesce(${deviceGrants.lastPolledAt} > now() - interval '1 second', false)`,
      }
      // 先不带空间看一眼：待确认、拒绝、过期都在这里答掉
      const first = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ grant: deviceGrants, ...timing })
          .from(deviceGrants)
          .where(eq(deviceGrants.deviceHash, deviceHash))
          .for('update')
        // 设备码不对和过期、已经取走答得一样
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
          // 轮询得太勤的让它慢一点；不更新时间，免得一直被挡
          if (row.polledRecently) return { status: 'slow' as const }
          await tx
            .update(deviceGrants)
            .set({ lastPolledAt: sql`now()` })
            .where(eq(deviceGrants.id, grant.id))
          return { status: 'pending' as const }
        }
        const selections = grantSelections(grant)
        const appIds = selections ? selectionAppIds(selections) : []
        // 确认过、却没有能用的选择（数据不全）：和别的作废一样删掉这一行，答过期
        if (!grant.spaceId || !appIds.length) {
          await tx.delete(deviceGrants).where(eq(deviceGrants.id, grant.id))
          return { status: 'expired' as const }
        }
        return { status: 'approved' as const, spaceId: grant.spaceId, appIds }
      })
      if (first.status === 'slow') return c.json({ error: '轮询太频繁' }, 429)
      if (first.status !== 'approved') return c.json({ status: first.status }, 200)

      // 确认过的：在空间的事务里先按 id 依次锁住涉及的应用、再锁这条申请（同时来的两次轮询只有一次拿得到），
      // 照签发的规则逐项核对确认人现在的成员关系与应用的所有者，过了才生成访问密钥；不管成不成，这条申请都删掉。
      // 锁的顺序和删除应用一致（应用 → 级联到申请），反过来会互相等成死锁
      const { spaceId, appIds } = first
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        for (const appId of appIds) await appOwnerOf(tx, appId, true)
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
        // 锁住的应用要正好是这些选择用到的：确认之后选择不会再变，对不上就不签发
        if (
          !approvedBy ||
          !approvedAt ||
          !selections ||
          selectionAppIds(selections).join() !== appIds.join()
        ) {
          return { status: 'denied' as const }
        }
        const member = await membershipOf(tx, spaceId, approvedBy)
        // 确认之后离开过空间的（现在的成员关系比确认晚）不算：离开时他的 Key 都作废了，不能借没取走的申请留一个
        const role =
          member && !member.disabledAt && member.memberSince <= approvedAt ? member.role : null
        const keys: DeviceIssuedKey[] = []
        for (const selection of selections) {
          const runtimeFamily = RuntimeFamily.parse(selection.runtimeFamily)
          if (!('appId' in selection)) {
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
          const issued = await issueAppKey(tx, {
            spaceId,
            appId: selection.appId,
            accountId: approvedBy,
            name: selection.keyName,
            scopes: selection.scopes,
          })
          if (!issued.ok) {
            denied(DEVICE_KEY_DENIALS.app)
            continue
          }
          keys.push({
            runtimeFamily,
            status: 'issued',
            key: issued.plaintext,
            app: {
              slug: issued.app.slug,
              name: issued.app.name,
              runtimeFamily: issued.app.runtimeFamily,
            },
          })
        }
        // 单个平台的申请照早期的形状回：一个访问密钥，或者整个 denied
        if (grant.platforms === null) {
          const [only] = keys
          if (only?.status !== 'issued') return { status: 'denied' as const }
          return { status: 'approved' as const, key: only.key, app: only.app }
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
      const { spaceId } = body
      try {
        const chosen = await withSpace(deps.db, spaceId, async (tx) => {
          const member = await membershipOf(tx, spaceId, accountId)
          // 不是这个空间的成员：和别的管理接口一样答 403，不说空间在不在
          if (!member) return refuse(403, '无权访问此空间')
          // 签发规则逐项判断，有一项不行就整体不确认，说明是哪个平台
          for (const item of body.items) {
            if (!('app' in item)) continue
            const denial = issueDenial(member.role, item.scopes)
            if (denial) refuse(403, denial, item.runtimeFamily)
          }
          // 选的已有应用按 id 排好一次锁全，再锁申请、逐项处理：和取走时同一个顺序（应用 → 申请），
          // 两个平台顺序相反的申请同时确认时也不会互相等住
          const existing = await lockApps(tx, body.items)
          const grant = await pendingGrant(tx, body.userCode)
          if (!grant) return refuse(404, '确认码不对或已过期')
          const items = orderedItems(grantPlatforms(grant), body.items)

          const selections: DeviceGrantSelection[] = []
          const picked: ApprovedItem[] = []
          for (const item of items) {
            if (!('app' in item)) {
              selections.push({ runtimeFamily: item.runtimeFamily, skip: true })
              continue
            }
            const target = await approveTarget(tx, item, existing, accountId, spaceId)
            selections.push({
              runtimeFamily: item.runtimeFamily,
              appId: target.id,
              keyName: item.keyName,
              scopes: item.scopes,
            })
            picked.push({ runtimeFamily: item.runtimeFamily, app: target, keyName: item.keyName })
          }
          await tx
            .update(deviceGrants)
            .set({
              status: 'approved',
              approvedBy: accountId,
              approvedAt: sql`now()`,
              spaceId,
              selections,
              // 单个平台的申请记下应用：应用删掉时申请跟着删，命令行取到的是过期，和早期一样
              appId: grant.platforms === null ? picked[0]!.app.id : null,
              // 快到期时确认的也留出取走的时间：否则应用建了、页面说已确认，命令行却取到过期
              expiresAt: sql`greatest(${deviceGrants.expiresAt}, now() + make_interval(secs => ${DEVICE_TAKE_WINDOW_SECONDS}))`,
            })
            .where(eq(deviceGrants.id, grant.id))
          return picked
        })
        return c.json(
          {
            items: chosen.map((item) => ({
              runtimeFamily: item.runtimeFamily,
              app: toAppInfo(item.app),
              keyName: item.keyName,
            })),
          },
          200,
        )
      } catch (err) {
        // 抛出来的是整体作废：事务回滚，前面几项新建的应用不留下
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
  app: AppRow
  keyName: string
}

// 确认中途要整体作废时抛出：事务回滚，前面几项新建的应用跟着撤掉。
// 只关于某一个平台的，说明前面带上平台名，响应里带上它的运行时，确认页据此标到那一行
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

// 申请里的每个平台恰好一项选择、至少一项不跳过，按申请的顺序排好
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
  if (ordered.every((item) => !('app' in item))) refuse(400, '至少选择一个平台')
  return ordered
}

type AppRow = typeof apps.$inferSelect

// 确认里选的已有应用，按 id 排序依次锁住；不存在的不在结果里
async function lockApps(tx: Tx, items: readonly DeviceGrantItem[]): Promise<Map<string, AppRow>> {
  const ids = [
    ...new Set(items.flatMap((item) => ('app' in item && 'id' in item.app ? [item.app.id] : []))),
  ].sort()
  const locked = new Map<string, AppRow>()
  for (const id of ids) {
    const [row] = await tx.select().from(apps).where(eq(apps.id, id)).for('update')
    if (row) locked.set(id, row)
  }
  return locked
}

// 确认时一项用的应用：已有的（lockApps 已经锁住）要是确认人自己的、运行时和这一项一致的（签发时还会再核对一次所有者）；
// 新建的运行时取这一项的，标识被占用时整个确认作废
async function approveTarget(
  tx: Tx,
  item: Extract<DeviceGrantItem, { app: unknown }>,
  existing: ReadonlyMap<string, AppRow>,
  accountId: string,
  spaceId: string,
): Promise<AppRow> {
  const { runtimeFamily } = item
  if ('id' in item.app) {
    const found = existing.get(item.app.id)
    if (!found) return refuse(404, '应用不存在', runtimeFamily)
    if (found.ownerAccountId !== accountId) {
      return refuse(403, '仅应用所有者可签发此应用的访问密钥', runtimeFamily)
    }
    if (found.runtimeFamily !== runtimeFamily) {
      return refuse(409, '应用的运行时与申请的不一致', runtimeFamily)
    }
    return found
  }
  const [created] = await tx
    .insert(apps)
    .values({
      spaceId,
      slug: item.app.slug,
      name: item.app.name,
      runtimeFamily,
      ownerAccountId: accountId,
    })
    .onConflictDoNothing()
    .returning()
  if (!created) return refuse(409, `标识 ${item.app.slug} 已被占用`, runtimeFamily)
  return created
}
