import type {
  InstanceSpace,
  MemberRole,
  SpaceCreationPolicy,
  SpaceDetail,
  SpaceInfo,
  SpaceMember,
} from '@kioku/contracts'
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm'

import { withSpace, type Db, type Tx } from '../db/client'
import {
  accounts,
  apiKeys,
  apps,
  settings,
  spaceDepartures,
  spaceMembers,
  spaces,
} from '../db/schema'

// 空间与成员的增删改。spaces、space_members 与 space_departures 是身份表，不在 RLS 里；
// 改成员的操作都在 withSpace 的事务里先锁住空间那一行，同一个空间的成员变动一个接一个做，
// 「至少一个所有者」在锁里检查，并发的改角色、移除、离开与转让不会一起把所有者都去掉。
// 吊销 Key 要查应用（内容表），所以也要在 withSpace 里

const POLICY_KEY = 'space-creation'

export type MemberFailure =
  | 'no-space'
  | 'not-member'
  | 'forbidden'
  | 'no-account'
  | 'already-member'
  | 'no-target'
  | 'last-owner'
  | 'self'
  // 账号已停用：不能加为成员、转让给他或升为所有者
  | 'disabled'

export type MemberResult<T> = { ok: true; value: T } | { ok: false; reason: MemberFailure }
const fail = (reason: MemberFailure): { ok: false; reason: MemberFailure } => ({
  ok: false,
  reason,
})

const iso = (d: Date) => d.toISOString()
const toInfo = (row: { id: string; name: string; createdAt: Date }): SpaceInfo => ({
  id: row.id,
  name: row.name,
  createdAt: iso(row.createdAt),
})

// ---- 实例开关 ----

export async function loadSpaceCreationPolicy(db: Db): Promise<SpaceCreationPolicy> {
  const [row] = await db.select().from(settings).where(eq(settings.key, POLICY_KEY))
  const value = (row?.value ?? {}) as { membersCanCreate?: unknown }
  return { membersCanCreate: value.membersCanCreate === true }
}

export async function saveSpaceCreationPolicy(db: Db, value: SpaceCreationPolicy): Promise<void> {
  const stored = { membersCanCreate: value.membersCanCreate }
  await db
    .insert(settings)
    .values({ key: POLICY_KEY, value: stored })
    .onConflictDoUpdate({ target: settings.key, set: { value: stored, updatedAt: new Date() } })
}

// ---- 空间 ----

export async function accountExists(db: Db | Tx, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId))
  return Boolean(row)
}

// 新建空间，owner 成为唯一的所有者。账号不存在、已停用时不建
export async function createSpace(
  db: Db,
  input: { name: string; ownerAccountId: string },
): Promise<MemberResult<SpaceInfo>> {
  return db.transaction(async (tx) => {
    // 锁住账号那一行再建，建的同时账号不会被删掉、停用
    const [owner] = await tx
      .select({ id: accounts.id, disabledAt: accounts.disabledAt })
      .from(accounts)
      .where(eq(accounts.id, input.ownerAccountId))
      .for('share')
    if (!owner) return fail('no-account')
    if (owner.disabledAt) return fail('disabled')
    const [space] = await tx.insert(spaces).values({ name: input.name }).returning()
    await tx.insert(spaceMembers).values({ spaceId: space!.id, accountId: owner.id, role: 'owner' })
    return { ok: true, value: toInfo(space!) }
  })
}

// 账号停用了没有：锁住账号那一行再看，判断之后到事务结束不会被停用
async function disabled(tx: Tx, accountId: string): Promise<boolean> {
  const [row] = await tx
    .select({ disabledAt: accounts.disabledAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for('share')
  return Boolean(row?.disabledAt)
}

// 锁住空间那一行，返回它；空间不存在时为 undefined
async function lockSpace(tx: Tx, spaceId: string) {
  const [row] = await tx.select().from(spaces).where(eq(spaces.id, spaceId)).for('update')
  return row
}

async function roleIn(tx: Tx | Db, spaceId: string, accountId: string) {
  const [row] = await tx
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.accountId, accountId)))
  return row?.role ?? null
}

async function ownerCount(tx: Tx, spaceId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.role, 'owner')))
  return row?.n ?? 0
}

export async function spaceDetail(
  db: Db,
  spaceId: string,
  accountId: string,
): Promise<SpaceDetail | null> {
  const [row] = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      createdAt: spaces.createdAt,
      role: spaceMembers.role,
      memberCount: sql<number>`(select count(*)::int from ${spaceMembers} m where m.space_id = ${spaces.id})`,
    })
    .from(spaces)
    .innerJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.accountId, accountId)),
    )
    .where(eq(spaces.id, spaceId))
  return row ? { ...toInfo(row), role: row.role, memberCount: row.memberCount } : null
}

// 改名：只有空间所有者。actor 的角色在锁里再看一次
export async function renameSpace(
  db: Db,
  input: { spaceId: string; actor: string; name: string },
): Promise<MemberResult<SpaceInfo>> {
  return withSpace(db, input.spaceId, async (tx) => {
    if (!(await lockSpace(tx, input.spaceId))) return fail('no-space')
    const role = await roleIn(tx, input.spaceId, input.actor)
    if (!role) return fail('not-member')
    if (role !== 'owner') return fail('forbidden')
    const [row] = await tx
      .update(spaces)
      .set({ name: input.name })
      .where(eq(spaces.id, input.spaceId))
      .returning()
    return { ok: true, value: toInfo(row!) }
  })
}

// 删除空间：空间所有者或实例管理员，confirmName 要等于现在的空间名。内容表都按 space_id 级联删除；
// 在 withSpace 里删，删除会话时的触发器在 RLS 下也找得到要删的会话摘要
export async function deleteSpace(
  db: Db,
  input: { spaceId: string; actor: string; admin: boolean; confirmName: string },
): Promise<MemberResult<null> | { ok: false; reason: 'name-mismatch' }> {
  return withSpace(db, input.spaceId, async (tx) => {
    const space = await lockSpace(tx, input.spaceId)
    const role = space ? await roleIn(tx, input.spaceId, input.actor) : null
    if (!space || (!role && !input.admin)) return fail(space ? 'not-member' : 'no-space')
    if (role !== 'owner' && !input.admin) return fail('forbidden')
    if (input.confirmName !== space.name) return { ok: false as const, reason: 'name-mismatch' }
    await tx.delete(spaces).where(eq(spaces.id, input.spaceId))
    return { ok: true as const, value: null }
  })
}

// 实例的空间列表：名称、建立时间、所有者与成员数，不碰内容表
export async function instanceSpaces(db: Db): Promise<InstanceSpace[]> {
  const rows = await db.select().from(spaces).orderBy(asc(spaces.createdAt), asc(spaces.id))
  const members = rows.length
    ? await db
        .select({
          spaceId: spaceMembers.spaceId,
          role: spaceMembers.role,
          accountId: accounts.id,
          username: accounts.username,
          displayName: accounts.displayName,
        })
        .from(spaceMembers)
        .innerJoin(accounts, eq(accounts.id, spaceMembers.accountId))
        .where(
          inArray(
            spaceMembers.spaceId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(spaceMembers.createdAt), asc(accounts.username))
    : []
  return rows.map((space) => {
    const mine = members.filter((m) => m.spaceId === space.id)
    return {
      ...toInfo(space),
      owners: mine
        .filter((m) => m.role === 'owner')
        .map(({ accountId, username, displayName }) => ({ accountId, username, displayName })),
      memberCount: mine.length,
    }
  })
}

// ---- 成员 ----

// 成员表：账号、角色、加入时间与拥有的应用数。应用是内容表，在 withSpace 里数；别的数量都不给
export async function listMembers(db: Db, spaceId: string): Promise<SpaceMember[]> {
  return withSpace(db, spaceId, async (tx) => {
    const rows = await tx
      .select({
        accountId: accounts.id,
        username: accounts.username,
        displayName: accounts.displayName,
        role: spaceMembers.role,
        joinedAt: spaceMembers.createdAt,
      })
      .from(spaceMembers)
      .innerJoin(accounts, eq(accounts.id, spaceMembers.accountId))
      .where(eq(spaceMembers.spaceId, spaceId))
      .orderBy(asc(spaceMembers.createdAt), asc(accounts.username))
    const owned = await tx
      .select({ owner: apps.ownerAccountId, n: count() })
      .from(apps)
      .groupBy(apps.ownerAccountId)
    const apps_ = new Map(owned.map((r) => [r.owner, r.n]))
    return rows.map((r) => ({
      ...r,
      joinedAt: iso(r.joinedAt),
      appCount: apps_.get(r.accountId) ?? 0,
    }))
  })
}

async function memberRow(tx: Tx, spaceId: string, accountId: string): Promise<SpaceMember> {
  const [row] = await tx
    .select({
      accountId: accounts.id,
      username: accounts.username,
      displayName: accounts.displayName,
      role: spaceMembers.role,
      joinedAt: spaceMembers.createdAt,
    })
    .from(spaceMembers)
    .innerJoin(accounts, eq(accounts.id, spaceMembers.accountId))
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.accountId, accountId)))
  const [apps_] = await tx
    .select({ n: count() })
    .from(apps)
    .where(eq(apps.ownerAccountId, accountId))
  return { ...row!, joinedAt: iso(row!.joinedAt), appCount: apps_?.n ?? 0 }
}

// 锁住空间、确认 actor 是空间所有者
async function asOwner(tx: Tx, spaceId: string, actor: string): Promise<MemberFailure | null> {
  if (!(await lockSpace(tx, spaceId))) return 'no-space'
  const role = await roleIn(tx, spaceId, actor)
  if (!role) return 'not-member'
  return role === 'owner' ? null : 'forbidden'
}

// 按用户名添加成员（精确匹配）。之前离开过、离开记录还在的，删掉离开记录：他的本人记忆与凭据照旧可见。
// 加入时间是现在，离开之前签发的 Key 仍然作废（见 keyEffectiveScopes）
export async function addMember(
  db: Db,
  input: { spaceId: string; actor: string; username: string; role: MemberRole },
): Promise<MemberResult<SpaceMember>> {
  return withSpace(db, input.spaceId, async (tx) => {
    const denied = await asOwner(tx, input.spaceId, input.actor)
    if (denied) return fail(denied)
    const [account] = await tx
      .select({ id: accounts.id, disabledAt: accounts.disabledAt })
      .from(accounts)
      .where(eq(accounts.username, input.username))
      .for('share')
    if (!account) return fail('no-account')
    if (await roleIn(tx, input.spaceId, account.id)) return fail('already-member')
    if (account.disabledAt) return fail('disabled')
    const [departed] = await tx
      .delete(spaceDepartures)
      .where(
        and(eq(spaceDepartures.spaceId, input.spaceId), eq(spaceDepartures.accountId, account.id)),
      )
      .returning({ dreamPrivate: spaceDepartures.dreamPrivate })
    await tx.insert(spaceMembers).values({
      spaceId: input.spaceId,
      accountId: account.id,
      role: input.role,
      ...(departed ? { dreamPrivate: departed.dreamPrivate } : {}),
    })
    return { ok: true, value: await memberRow(tx, input.spaceId, account.id) }
  })
}

// 改角色：只有空间所有者；改完之后至少还有一个所有者
export async function updateMemberRole(
  db: Db,
  input: { spaceId: string; actor: string; target: string; role: MemberRole },
): Promise<MemberResult<SpaceMember>> {
  return withSpace(db, input.spaceId, async (tx) => {
    const denied = await asOwner(tx, input.spaceId, input.actor)
    if (denied) return fail(denied)
    const current = await roleIn(tx, input.spaceId, input.target)
    if (!current) return fail('no-target')
    if (input.role === 'owner' && current !== 'owner' && (await disabled(tx, input.target))) {
      return fail('disabled')
    }
    if (
      current === 'owner' &&
      input.role !== 'owner' &&
      (await ownerCount(tx, input.spaceId)) < 2
    ) {
      return fail('last-owner')
    }
    await tx
      .update(spaceMembers)
      .set({ role: input.role })
      .where(and(eq(spaceMembers.spaceId, input.spaceId), eq(spaceMembers.accountId, input.target)))
    return { ok: true, value: await memberRow(tx, input.spaceId, input.target) }
  })
}

// 移除成员（空间所有者移除别人）或离开（成员移除自己）。最后一个所有者不能离开、也不能被移除。
// 记下离开的时间（之前的离开记录换成这一次的）；他拥有的应用的 Key 立即吊销：
// 本来也按「所有者不在空间里」作废，吊销之后重新加入也不会再生效。他的本人记忆、凭据与密码库连接不删
export async function removeMember(
  db: Db,
  input: { spaceId: string; actor: string; target: string },
): Promise<MemberResult<null>> {
  return withSpace(db, input.spaceId, async (tx) => {
    if (!(await lockSpace(tx, input.spaceId))) return fail('no-space')
    const actorRole = await roleIn(tx, input.spaceId, input.actor)
    if (!actorRole) return fail('not-member')
    if (input.actor !== input.target && actorRole !== 'owner') return fail('forbidden')
    const [target] = await tx
      .select({ role: spaceMembers.role, dreamPrivate: spaceMembers.dreamPrivate })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, input.spaceId), eq(spaceMembers.accountId, input.target)))
    if (!target) return fail('no-target')
    if (target.role === 'owner' && (await ownerCount(tx, input.spaceId)) < 2) {
      return fail('last-owner')
    }
    await tx
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, input.spaceId), eq(spaceMembers.accountId, input.target)))
    await tx
      .insert(spaceDepartures)
      .values({
        spaceId: input.spaceId,
        accountId: input.target,
        dreamPrivate: target.dreamPrivate,
      })
      .onConflictDoUpdate({
        target: [spaceDepartures.spaceId, spaceDepartures.accountId],
        set: { leftAt: sql`now()`, dreamPrivate: target.dreamPrivate },
      })
    const owned = tx.select({ id: apps.id }).from(apps).where(eq(apps.ownerAccountId, input.target))
    await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.spaceId, input.spaceId),
          isNull(apiKeys.revokedAt),
          inArray(apiKeys.appId, owned),
        ),
      )
    return { ok: true, value: null }
  })
}

// 转让所有者：对方成为所有者，当前账号改为编辑者，同一个事务里做完。对方必须是别的成员
export async function transferOwnership(
  db: Db,
  input: { spaceId: string; actor: string; target: string },
): Promise<MemberResult<SpaceMember[]>> {
  return withSpace(db, input.spaceId, async (tx) => {
    const denied = await asOwner(tx, input.spaceId, input.actor)
    if (denied) return fail(denied)
    if (input.target === input.actor) return fail('self')
    if (!(await roleIn(tx, input.spaceId, input.target))) return fail('no-target')
    if (await disabled(tx, input.target)) return fail('disabled')
    const set = (accountId: string, role: MemberRole) =>
      tx
        .update(spaceMembers)
        .set({ role })
        .where(and(eq(spaceMembers.spaceId, input.spaceId), eq(spaceMembers.accountId, accountId)))
    await set(input.target, 'owner')
    await set(input.actor, 'editor')
    return {
      ok: true,
      value: [
        await memberRow(tx, input.spaceId, input.target),
        await memberRow(tx, input.spaceId, input.actor),
      ],
    }
  })
}
