import { randomBytes } from 'node:crypto'

import {
  CIRCLE_LIMIT_DEFAULT,
  CIRCLE_NAME_MAX,
  CircleLimitSettings,
  type AdminCircle,
  type CircleDetail,
  type CircleInfo,
  type CircleLimitView,
  type CircleMember,
  type CircleSummary,
  type CreatedCircle,
  type DefaultFacets,
  type MemberRole,
  type SessionUser,
} from '@kioku/contracts'
import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm'

import { withCircle, type Db, type Tx } from '../db/client'
import {
  accounts,
  apiKeys,
  circleDepartures,
  circleMembers,
  circles,
  clients,
  settings,
} from '../db/schema'
import { computeKeyGrants } from './access'

const LIMIT_KEY = 'circle-limit'
const PERSONAL_CIRCLE_SUFFIX = '的个人圈'

export type MemberFailure =
  | 'no-circle'
  | 'personal-circle'
  | 'not-member'
  | 'forbidden'
  | 'no-account'
  | 'already-member'
  | 'no-target'
  | 'last-owner'
  | 'self'
  | 'slug-taken'
  // 账号已停用：不能加为成员、转让给他或升为所有者
  | 'disabled'
  // 离开后的数据已经开始清理：清理完成、离开记录删掉之前不能重新加入
  | 'departure-purging'
  // 要成为所有者的账号拥有的共享记忆圈已达上限
  | 'owner-limit'
  // 要成为所有者的账号正在新建或导入共享记忆圈，名额一时数不准
  | 'owner-busy'

export type MemberRejection =
  | { ok: false; reason: Exclude<MemberFailure, 'owner-limit'> }
  | { ok: false; reason: 'owner-limit'; limit: number }
export type MemberResult<T> = { ok: true; value: T } | MemberRejection

const fail = (reason: Exclude<MemberFailure, 'owner-limit'>): MemberRejection => ({
  ok: false,
  reason,
})
const overLimit = (limit: number): MemberRejection => ({ ok: false, reason: 'owner-limit', limit })

const iso = (d: Date) => d.toISOString()

function toCircleInfo(row: typeof circles.$inferSelect): CircleInfo {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    defaultFacets: row.defaultFacets,
    createdAt: iso(row.createdAt),
  }
}

// 个人圈名称："<截断显示名>的个人圈"，按码点截断以免切开代理对
export function personalCircleName(displayName: string): string {
  const head = Array.from(displayName).slice(0, CIRCLE_NAME_MAX - PERSONAL_CIRCLE_SUFFIX.length)
  return `${head.join('')}${PERSONAL_CIRCLE_SUFFIX}`
}

function sanitizeSlugBase(raw: string, fallbackPrefix: string): string {
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const candidate = clean || `${fallbackPrefix}-${randomBytes(4).toString('hex')}`
  const normalized = /^[a-z0-9]/.test(candidate) ? candidate : `${fallbackPrefix}-${candidate}`
  return normalized.slice(0, 52)
}

async function allocateUniqueSlug(tx: Tx, base: string): Promise<string> {
  const clean = base.slice(0, 63)
  const [taken] = await tx
    .select({ id: circles.id })
    .from(circles)
    .where(eq(circles.slug, clean))
    .limit(1)
  if (!taken) return clean
  for (let i = 2; i < 20; i++) {
    const suffix = `-${i}`
    const next = `${clean.slice(0, 63 - suffix.length)}${suffix}`
    const [exists] = await tx
      .select({ id: circles.id })
      .from(circles)
      .where(eq(circles.slug, next))
      .limit(1)
    if (!exists) return next
  }
  const tail = `-${randomBytes(4).toString('hex')}`
  return `${clean.slice(0, 63 - tail.length)}${tail}`
}

// 创建账号的唯一不可删个人圈并写入所有者成员记录
export async function createPersonalCircle(
  tx: Tx,
  account: { id: string; username: string; displayName: string },
): Promise<CircleSummary> {
  const slug = await allocateUniqueSlug(tx, sanitizeSlugBase(`me-${account.username}`, 'me'))
  const name = personalCircleName(account.displayName)
  const [circle] = await tx
    .insert(circles)
    .values({
      slug,
      name,
      kind: 'personal',
      ownerAccountId: account.id,
      defaultFacets: {},
    })
    .returning()
  await tx
    .insert(circleMembers)
    .values({ circleId: circle!.id, accountId: account.id, role: 'owner' })
  return {
    id: circle!.id,
    slug: circle!.slug,
    name: circle!.name,
    kind: 'personal',
    role: 'owner',
  }
}

// ---- 共享记忆圈数量上限（个人圈不占配额）----

export async function loadCircleLimit(db: Db | Tx): Promise<CircleLimitSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, LIMIT_KEY))
  const parsed = CircleLimitSettings.safeParse(row?.value)
  return parsed.success ? parsed.data : { maxOwnedCircles: CIRCLE_LIMIT_DEFAULT }
}

export async function saveCircleLimit(db: Db | Tx, value: CircleLimitSettings): Promise<void> {
  const stored = { maxOwnedCircles: value.maxOwnedCircles }
  await db
    .insert(settings)
    .values({ key: LIMIT_KEY, value: stored })
    .onConflictDoUpdate({ target: settings.key, set: { value: stored, updatedAt: new Date() } })
}

export async function ownedSharedCircles(db: Db | Tx, accountId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(circleMembers)
    .innerJoin(circles, eq(circles.id, circleMembers.circleId))
    .where(
      and(
        eq(circleMembers.accountId, accountId),
        eq(circleMembers.role, 'owner'),
        eq(circles.kind, 'shared'),
      ),
    )
  return row?.n ?? 0
}

export async function circleLimitView(db: Db, accountId: string): Promise<CircleLimitView> {
  const { maxOwnedCircles } = await loadCircleLimit(db)
  const owned = await ownedSharedCircles(db, accountId)
  return { maxOwnedCircles, ownedCircles: owned, canCreate: hasSeat(owned, maxOwnedCircles) }
}

const hasSeat = (owned: number, max: number) => owned < max
const seatLock = (accountId: string) => sql`hashtext(${`kioku.circle-owner:${accountId}`})`

async function seatLimit(tx: Tx, accountId: string): Promise<number | null> {
  const { maxOwnedCircles } = await loadCircleLimit(tx)
  return hasSeat(await ownedSharedCircles(tx, accountId), maxOwnedCircles) ? null : maxOwnedCircles
}

export async function claimOwnerSeat(tx: Tx, accountId: string): Promise<number | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(${seatLock(accountId)})`)
  return seatLimit(tx, accountId)
}

async function offerOwnerSeat(tx: Tx, accountId: string): Promise<MemberRejection | null> {
  const [row] = await tx.execute<{ ok: boolean }>(
    sql`select pg_try_advisory_xact_lock(${seatLock(accountId)}) as ok`,
  )
  if (row?.ok !== true) return fail('owner-busy')
  const limit = await seatLimit(tx, accountId)
  return limit === null ? null : overLimit(limit)
}

export const circleLimitReached = (limit: number) =>
  `已达共享记忆圈数量上限：每个账号最多拥有 ${limit} 个共享记忆圈`

// 读取登录账号的 SessionUser（含个人圈、全部所属圈与共享圈配额计数）
export async function loadSessionUser(db: Db | Tx, accountId: string): Promise<SessionUser | null> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1)
  if (!account) return null
  const [memberships, { maxOwnedCircles }] = await Promise.all([
    db
      .select({
        id: circles.id,
        slug: circles.slug,
        name: circles.name,
        kind: circles.kind,
        role: circleMembers.role,
      })
      .from(circleMembers)
      .innerJoin(circles, eq(circles.id, circleMembers.circleId))
      .where(eq(circleMembers.accountId, accountId))
      .orderBy(asc(circles.kind), asc(circles.createdAt)),
    loadCircleLimit(db),
  ])
  const personal = memberships.find((m) => m.kind === 'personal')
  if (!personal) return null
  const ownedSharedCirclesCount = memberships.filter(
    (m) => m.kind === 'shared' && m.role === 'owner',
  ).length
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    isAdmin: account.isAdmin,
    personalCircleId: personal.id,
    circles: memberships,
    ownedSharedCircles: ownedSharedCirclesCount,
    maxOwnedCircles,
  }
}

// ---- 记忆圈增删改 ----

// 在现有事务中创建共享记忆圈并将 ownerId 设为所有者
export async function insertSharedCircle(
  tx: Tx,
  input: {
    name: string
    slug?: string
    defaultFacets?: DefaultFacets
    ownerAccountId: string
  },
): Promise<CreatedCircle | null> {
  const slug = input.slug
    ? input.slug
    : await allocateUniqueSlug(tx, sanitizeSlugBase(input.name, 'circle'))

  const [created] = await tx
    .insert(circles)
    .values({
      slug,
      name: input.name,
      kind: 'shared',
      ownerAccountId: null,
      defaultFacets: input.defaultFacets ?? {},
    })
    .onConflictDoNothing({ target: circles.slug })
    .returning()
  if (!created) return null

  await tx
    .insert(circleMembers)
    .values({ circleId: created.id, accountId: input.ownerAccountId, role: 'owner' })
  return {
    ...toCircleInfo(created),
    ownerAccountId: created.ownerAccountId,
  }
}

export async function createSharedCircle(
  db: Db,
  input: {
    name: string
    slug?: string
    defaultFacets?: DefaultFacets
    ownerAccountId: string
  },
): Promise<MemberResult<CreatedCircle>> {
  return db.transaction(async (tx) => {
    const limit = await claimOwnerSeat(tx, input.ownerAccountId)
    const [owner] = await tx
      .select({ id: accounts.id, disabledAt: accounts.disabledAt })
      .from(accounts)
      .where(eq(accounts.id, input.ownerAccountId))
      .for('share')
    if (!owner) return fail('no-account')
    if (owner.disabledAt) return fail('disabled')
    if (limit !== null) return overLimit(limit)

    const created = await insertSharedCircle(tx, input)
    return created ? { ok: true, value: created } : fail('slug-taken')
  })
}

async function disabled(tx: Tx, accountId: string): Promise<boolean> {
  const [row] = await tx
    .select({ disabledAt: accounts.disabledAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for('share')
  return Boolean(row?.disabledAt)
}

async function lockCircle(tx: Tx, circleId: string) {
  const [row] = await tx.select().from(circles).where(eq(circles.id, circleId)).for('update')
  return row
}

async function roleIn(tx: Tx | Db, circleId: string, accountId: string) {
  const [row] = await tx
    .select({ role: circleMembers.role })
    .from(circleMembers)
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, accountId)))
  return row?.role ?? null
}

async function activeOwnersBesides(tx: Tx, circleId: string, except: string): Promise<number> {
  const rows = await tx
    .select({ id: accounts.id })
    .from(circleMembers)
    .innerJoin(accounts, eq(accounts.id, circleMembers.accountId))
    .where(
      and(
        eq(circleMembers.circleId, circleId),
        eq(circleMembers.role, 'owner'),
        isNull(accounts.disabledAt),
        ne(circleMembers.accountId, except),
      ),
    )
    .for('share', { of: accounts })
  return rows.length
}

export async function circleDetail(
  db: Db,
  circleId: string,
  accountId: string,
): Promise<CircleDetail | null> {
  const [row] = await db
    .select({
      circle: circles,
      role: circleMembers.role,
      memberCount: sql<number>`(select count(*)::int from ${circleMembers} m where m.circle_id = ${circles.id})`,
    })
    .from(circles)
    .innerJoin(
      circleMembers,
      and(eq(circleMembers.circleId, circles.id), eq(circleMembers.accountId, accountId)),
    )
    .where(eq(circles.id, circleId))
  return row
    ? {
        ...toCircleInfo(row.circle),
        role: row.role,
        ownerAccountId: row.circle.ownerAccountId,
        memberCount: row.memberCount,
      }
    : null
}

export async function updateCircle(
  db: Db,
  input: {
    circleId: string
    actor: string
    name?: string
    defaultFacets?: DefaultFacets
  },
): Promise<MemberResult<CircleInfo>> {
  return withCircle(db, input.circleId, async (tx) => {
    if (!(await lockCircle(tx, input.circleId))) return fail('no-circle')
    const role = await roleIn(tx, input.circleId, input.actor)
    if (!role) return fail('not-member')
    if (role !== 'owner') return fail('forbidden')
    const patch = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.defaultFacets !== undefined ? { defaultFacets: input.defaultFacets } : {}),
    }
    const [row] = await tx
      .update(circles)
      .set(patch)
      .where(eq(circles.id, input.circleId))
      .returning()
    return { ok: true, value: toCircleInfo(row!) }
  })
}

export async function deleteSharedCircle(
  db: Db,
  input: { circleId: string; actor: string; admin: boolean; confirmName: string },
): Promise<MemberResult<null> | { ok: false; reason: 'name-mismatch' }> {
  return withCircle(db, input.circleId, async (tx) => {
    const circle = await lockCircle(tx, input.circleId)
    if (!circle) return fail('no-circle')
    if (circle.kind === 'personal') return fail('personal-circle')
    const role = await roleIn(tx, input.circleId, input.actor)
    if (!role && !input.admin) return fail('not-member')
    if (role !== 'owner' && !input.admin) return fail('forbidden')
    if (input.confirmName !== circle.name) return { ok: false as const, reason: 'name-mismatch' }
    await tx.delete(circles).where(eq(circles.id, input.circleId))
    return { ok: true as const, value: null }
  })
}

export async function adminCircles(db: Db): Promise<AdminCircle[]> {
  const rows = await db.select().from(circles).orderBy(asc(circles.createdAt), asc(circles.id))
  const members = rows.length
    ? await db
        .select({
          circleId: circleMembers.circleId,
          role: circleMembers.role,
          accountId: accounts.id,
          username: accounts.username,
          displayName: accounts.displayName,
        })
        .from(circleMembers)
        .innerJoin(accounts, eq(accounts.id, circleMembers.accountId))
        .where(
          inArray(
            circleMembers.circleId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(circleMembers.createdAt), asc(accounts.username))
    : []
  return rows.map((circle) => {
    const mine = members.filter((m) => m.circleId === circle.id)
    return {
      ...toCircleInfo(circle),
      owners: mine
        .filter((m) => m.role === 'owner')
        .map(({ accountId, username, displayName }) => ({ accountId, username, displayName })),
      memberCount: mine.length,
    }
  })
}

// ---- 共享圈成员 ----

export async function listMembers(db: Db, circleId: string): Promise<CircleMember[]> {
  return withCircle(db, circleId, async (tx) => {
    const rows = await tx
      .select({
        accountId: accounts.id,
        username: accounts.username,
        displayName: accounts.displayName,
        role: circleMembers.role,
        joinedAt: circleMembers.createdAt,
      })
      .from(circleMembers)
      .innerJoin(accounts, eq(accounts.id, circleMembers.accountId))
      .where(eq(circleMembers.circleId, circleId))
      .orderBy(asc(circleMembers.createdAt), asc(accounts.username))
    const owned = await tx
      .select({ owner: clients.ownerAccountId, n: count() })
      .from(clients)
      .groupBy(clients.ownerAccountId)
    const clientCounts = new Map(owned.map((r) => [r.owner, r.n]))
    return rows.map((r) => ({
      ...r,
      joinedAt: iso(r.joinedAt),
      clientCount: clientCounts.get(r.accountId) ?? 0,
    }))
  })
}

async function memberRow(tx: Tx, circleId: string, accountId: string): Promise<CircleMember> {
  const [row] = await tx
    .select({
      accountId: accounts.id,
      username: accounts.username,
      displayName: accounts.displayName,
      role: circleMembers.role,
      joinedAt: circleMembers.createdAt,
    })
    .from(circleMembers)
    .innerJoin(accounts, eq(accounts.id, circleMembers.accountId))
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, accountId)))
  const [cnt] = await tx
    .select({ n: count() })
    .from(clients)
    .where(eq(clients.ownerAccountId, accountId))
  return { ...row!, joinedAt: iso(row!.joinedAt), clientCount: cnt?.n ?? 0 }
}

async function asSharedOwner(
  tx: Tx,
  circleId: string,
  actor: string,
): Promise<'no-circle' | 'personal-circle' | 'not-member' | 'forbidden' | null> {
  const circle = await lockCircle(tx, circleId)
  if (!circle) return 'no-circle'
  if (circle.kind === 'personal') return 'personal-circle'
  const role = await roleIn(tx, circleId, actor)
  if (!role) return 'not-member'
  return role === 'owner' ? null : 'forbidden'
}

export async function addMember(
  db: Db,
  input: { circleId: string; actor: string; username: string; role: MemberRole },
): Promise<MemberResult<CircleMember>> {
  return withCircle(db, input.circleId, async (tx) => {
    const denied = await asSharedOwner(tx, input.circleId, input.actor)
    if (denied) return fail(denied)

    const [found] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.username, input.username))
    if (!found) return fail('no-account')
    const noSeat = input.role === 'owner' ? await offerOwnerSeat(tx, found.id) : null
    const [account] = await tx
      .select({ id: accounts.id, disabledAt: accounts.disabledAt })
      .from(accounts)
      .where(eq(accounts.id, found.id))
      .for('share')
    if (!account) return fail('no-account')
    if (await roleIn(tx, input.circleId, account.id)) return fail('already-member')
    if (account.disabledAt) return fail('disabled')
    if (noSeat) return noSeat

    const ofDeparture = and(
      eq(circleDepartures.circleId, input.circleId),
      eq(circleDepartures.accountId, account.id),
    )
    const [departed] = await tx
      .select({
        dreamPrivate: circleDepartures.dreamPrivate,
        purgeStartedAt: circleDepartures.purgeStartedAt,
      })
      .from(circleDepartures)
      .where(ofDeparture)
      .for('update')
    if (departed?.purgeStartedAt) return fail('departure-purging')
    if (departed) await tx.delete(circleDepartures).where(ofDeparture)

    await tx.insert(circleMembers).values({
      circleId: input.circleId,
      accountId: account.id,
      role: input.role,
      ...(departed ? { dreamPrivate: departed.dreamPrivate } : {}),
    })
    return { ok: true, value: await memberRow(tx, input.circleId, account.id) }
  })
}

export async function updateMemberRole(
  db: Db,
  input: { circleId: string; actor: string; target: string; role: MemberRole },
): Promise<MemberResult<CircleMember>> {
  return withCircle(db, input.circleId, async (tx) => {
    const denied = await asSharedOwner(tx, input.circleId, input.actor)
    if (denied) return fail(denied)
    const current = await roleIn(tx, input.circleId, input.target)
    if (!current) return fail('no-target')
    if (input.role === 'owner' && current !== 'owner') {
      const noSeat = await offerOwnerSeat(tx, input.target)
      if (await disabled(tx, input.target)) return fail('disabled')
      if (noSeat) return noSeat
    }
    if (
      current === 'owner' &&
      input.role !== 'owner' &&
      (await activeOwnersBesides(tx, input.circleId, input.target)) === 0
    ) {
      return fail('last-owner')
    }
    await tx
      .update(circleMembers)
      .set({ role: input.role })
      .where(
        and(eq(circleMembers.circleId, input.circleId), eq(circleMembers.accountId, input.target)),
      )
    return { ok: true, value: await memberRow(tx, input.circleId, input.target) }
  })
}

export async function removeMember(
  db: Db,
  input: { circleId: string; actor: string; target: string },
): Promise<MemberResult<null>> {
  return withCircle(db, input.circleId, async (tx) => {
    const circle = await lockCircle(tx, input.circleId)
    if (!circle) return fail('no-circle')
    if (circle.kind === 'personal') return fail('personal-circle')
    const actorRole = await roleIn(tx, input.circleId, input.actor)
    if (!actorRole) return fail('not-member')
    if (input.actor !== input.target && actorRole !== 'owner') return fail('forbidden')
    const [target] = await tx
      .select({ role: circleMembers.role, dreamPrivate: circleMembers.dreamPrivate })
      .from(circleMembers)
      .where(
        and(eq(circleMembers.circleId, input.circleId), eq(circleMembers.accountId, input.target)),
      )
    if (!target) return fail('no-target')
    if (
      target.role === 'owner' &&
      (await activeOwnersBesides(tx, input.circleId, input.target)) === 0
    ) {
      return fail('last-owner')
    }

    await tx
      .delete(circleMembers)
      .where(
        and(eq(circleMembers.circleId, input.circleId), eq(circleMembers.accountId, input.target)),
      )
    await tx
      .insert(circleDepartures)
      .values({
        circleId: input.circleId,
        accountId: input.target,
        dreamPrivate: target.dreamPrivate,
      })
      .onConflictDoUpdate({
        target: [circleDepartures.circleId, circleDepartures.accountId],
        set: { leftAt: sql`now()`, dreamPrivate: target.dreamPrivate },
      })

    const owned = tx
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.ownerAccountId, input.target))
    await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.circleId, input.circleId),
          isNull(apiKeys.revokedAt),
          inArray(apiKeys.clientId, owned),
        ),
      )
    return { ok: true, value: null }
  })
}

export async function transferOwnership(
  db: Db,
  input: { circleId: string; actor: string; target: string },
): Promise<MemberResult<CircleMember[]>> {
  return withCircle(db, input.circleId, async (tx) => {
    const denied = await asSharedOwner(tx, input.circleId, input.actor)
    if (denied) return fail(denied)
    if (input.target === input.actor) return fail('self')
    const targetRole = await roleIn(tx, input.circleId, input.target)
    if (!targetRole) return fail('no-target')
    const noSeat = targetRole === 'owner' ? null : await offerOwnerSeat(tx, input.target)
    if (await disabled(tx, input.target)) return fail('disabled')
    if (noSeat) return noSeat

    const set = (accountId: string, role: MemberRole) =>
      tx
        .update(circleMembers)
        .set({ role })
        .where(
          and(eq(circleMembers.circleId, input.circleId), eq(circleMembers.accountId, accountId)),
        )
    await set(input.target, 'owner')
    await set(input.actor, 'editor')
    return {
      ok: true,
      value: [
        await memberRow(tx, input.circleId, input.target),
        await memberRow(tx, input.circleId, input.actor),
      ],
    }
  })
}

export { computeKeyGrants }
