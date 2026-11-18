import {
  LensKeyScopes,
  type KeyInfo,
  type LinkedCircleGrant,
  type MemberRole,
  type WhenCondition,
} from '@kioku/contracts'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import { generateApiKey } from '../auth/keys'
import type { Db, Tx } from '../db/client'
import { accounts, apiKeys, circleMembers, circles, clients, personas } from '../db/schema'
import { computeKeyGrants, type CircleGrantMembership, type LinkedCircleInput } from './access'

// 访问密钥签发与轮换规则，控制台签发、密钥轮换与浏览器授权共用

export function issueDenial(role: MemberRole | null, scopes: LensKeyScopes): string | null {
  if (role !== 'owner' && role !== 'editor') return '需要记忆圈所有者或编辑者角色'
  if (
    role !== 'owner' &&
    (scopes.admin || scopes.maxSensitivity === 'secret' || scopes.credentials !== 'none')
  ) {
    return '仅记忆圈所有者可签发管理、机密级或可使用凭据的访问密钥'
  }
  return null
}

export async function clientOwnerOf(
  tx: Tx,
  clientId: string,
  lock = false,
): Promise<string | null> {
  return (await clientRow(tx, clientId, lock))?.ownerAccountId ?? null
}

async function clientRow(tx: Tx, clientId: string, lock: boolean) {
  const query = tx.select().from(clients).where(eq(clients.id, clientId))
  const [row] = lock ? await query.for('update') : await query
  return row ?? null
}

export async function membershipOf(dbOrTx: Db | Tx, circleId: string, accountId: string) {
  const [row] = await dbOrTx
    .select({
      role: circleMembers.role,
      memberSince: circleMembers.createdAt,
      disabledAt: accounts.disabledAt,
    })
    .from(circleMembers)
    .innerJoin(accounts, eq(accounts.id, circleMembers.accountId))
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, accountId)))
    .limit(1)
  return row
}

// 校验关联客场圈授权：不能指向主场圈，签发人须仍为各关联圈有效成员；申请读写客场时角色须为所有者或编辑者
export async function linkedCirclesDenial(
  dbOrTx: Db | Tx,
  accountId: string,
  primaryCircleId: string,
  linkedCircles: readonly LinkedCircleGrant[],
): Promise<string | null> {
  if (!linkedCircles.length) return null
  if (linkedCircles.some((l) => l.circleId === primaryCircleId)) {
    return '关联客场圈不能包含主场圈'
  }
  const ids = [...new Set(linkedCircles.map((l) => l.circleId))]
  const rows = await dbOrTx
    .select({
      circleId: circleMembers.circleId,
      role: circleMembers.role,
    })
    .from(circleMembers)
    .where(and(inArray(circleMembers.circleId, ids), eq(circleMembers.accountId, accountId)))
  const roleByCircle = new Map(rows.map((r) => [r.circleId, r.role]))
  for (const grant of linkedCircles) {
    const role = roleByCircle.get(grant.circleId)
    if (!role) return '关联记忆圈不存在或无成员权限'
    if (grant.mode === 'read_write' && role === 'viewer') {
      return '查看者角色不能签发可写客场圈'
    }
  }
  return null
}

export type IssuedClientKey =
  | {
      ok: true
      row: typeof apiKeys.$inferSelect
      client: typeof clients.$inferSelect
      plaintext: string
    }
  | { ok: false; reason: 'missing' | 'not-owner' | 'no-persona' }

// 在 withCircle 事务内给接入实例签发透镜访问密钥；明文仅在此返回一次
export async function issueClientKey(
  tx: Tx,
  input: {
    circleId: string
    clientId: string
    accountId: string
    name: string
    linkedCircles?: LinkedCircleGrant[]
    contextFacets?: WhenCondition
    personaOverrideId?: string | null
    scopes: LensKeyScopes
  },
): Promise<IssuedClientKey> {
  const client = await clientRow(tx, input.clientId, true)
  if (!client || client.circleId !== input.circleId) return { ok: false, reason: 'missing' }
  if (client.ownerAccountId !== input.accountId) return { ok: false, reason: 'not-owner' }

  if (input.personaOverrideId) {
    const [persona] = await tx
      .select({ id: personas.id })
      .from(personas)
      .where(eq(personas.id, input.personaOverrideId))
      .limit(1)
    if (!persona) return { ok: false, reason: 'no-persona' }
  }

  const generated = generateApiKey()
  const [row] = await tx
    .insert(apiKeys)
    .values({
      circleId: input.circleId,
      clientId: input.clientId,
      name: input.name,
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      linkedCircles: input.linkedCircles ?? [],
      contextFacets: input.contextFacets ?? {},
      personaOverrideId: input.personaOverrideId ?? null,
      scopes: input.scopes,
    })
    .returning()
  return { ok: true, row: row!, client, plaintext: generated.plaintext }
}

export type RotateClientKeyResult =
  | {
      ok: true
      row: typeof apiKeys.$inferSelect
      client: typeof clients.$inferSelect
      plaintext: string
    }
  | { ok: false; reason: 'missing' | 'not-owner' | 'forbidden' }

// 无缝轮换密钥：吊销旧密钥并同事务签发继承同一接入实例、有效客场圈与切面的新密钥，不断按群规则与会话
export async function rotateClientKey(
  tx: Tx,
  input: {
    circleId: string
    clientId: string
    keyId: string
    accountId: string
    name?: string
  },
): Promise<RotateClientKeyResult> {
  const client = await clientRow(tx, input.clientId, true)
  if (!client || client.circleId !== input.circleId) return { ok: false, reason: 'missing' }
  if (client.ownerAccountId !== input.accountId) return { ok: false, reason: 'not-owner' }

  const [oldKey] = await tx
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.id, input.keyId),
        eq(apiKeys.clientId, input.clientId),
        eq(apiKeys.circleId, input.circleId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .for('update')
  if (!oldKey) return { ok: false, reason: 'missing' }

  const member = await membershipOf(tx, input.circleId, input.accountId)
  const scopes = LensKeyScopes.parse(oldKey.scopes)
  if (!member || member.disabledAt || issueDenial(member.role, scopes)) {
    return { ok: false, reason: 'forbidden' }
  }

  // 过滤已离开或重新加入的失效客场圈，并按当前成员角色保留或收紧关联写权限
  const linked = oldKey.linkedCircles ?? []
  const linkedIds = [...new Set(linked.map((l) => l.circleId))]
  const activeLinked = linkedIds.length
    ? await tx
        .select({
          circleId: circleMembers.circleId,
          role: circleMembers.role,
          joinedAt: circleMembers.createdAt,
        })
        .from(circleMembers)
        .where(
          and(
            inArray(circleMembers.circleId, linkedIds),
            eq(circleMembers.accountId, input.accountId),
          ),
        )
    : []
  const activeByCircle = new Map(activeLinked.map((r) => [r.circleId, r]))
  const preservedLinked: LinkedCircleGrant[] = []
  for (const item of linked) {
    const m = activeByCircle.get(item.circleId)
    if (!m || m.joinedAt > oldKey.createdAt) continue
    preservedLinked.push({
      circleId: item.circleId,
      mode: item.mode === 'read_write' && m.role !== 'viewer' ? 'read_write' : 'read',
    })
  }

  let personaOverrideId = oldKey.personaOverrideId
  if (personaOverrideId) {
    const [persona] = await tx
      .select({ id: personas.id })
      .from(personas)
      .where(eq(personas.id, personaOverrideId))
      .limit(1)
    if (!persona) personaOverrideId = null
  }

  await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, oldKey.id))

  const generated = generateApiKey()
  const [created] = await tx
    .insert(apiKeys)
    .values({
      circleId: input.circleId,
      clientId: input.clientId,
      name: input.name ?? oldKey.name,
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      linkedCircles: preservedLinked,
      contextFacets: oldKey.contextFacets ?? {},
      personaOverrideId,
      scopes,
    })
    .returning()
  return { ok: true, row: created!, client, plaintext: generated.plaintext }
}

// 构造 KeyInfo（实时计算 effectiveScopes 与逐圈 circleGrants）
export async function buildKeyInfos(
  dbOrTx: Db | Tx,
  primaryCircleId: string,
  ownerAccountId: string,
  rows: readonly (typeof apiKeys.$inferSelect)[],
): Promise<KeyInfo[]> {
  if (!rows.length) return []
  const allLinkedIds = [
    ...new Set(rows.flatMap((r) => (r.linkedCircles ?? []).map((l) => l.circleId))),
  ]
  const circleIds = [...new Set([primaryCircleId, ...allLinkedIds])]
  const [ownerRow, circleRows, memberRows] = await Promise.all([
    dbOrTx
      .select({ disabledAt: accounts.disabledAt })
      .from(accounts)
      .where(eq(accounts.id, ownerAccountId))
      .limit(1),
    dbOrTx
      .select({ id: circles.id, slug: circles.slug, name: circles.name, kind: circles.kind })
      .from(circles)
      .where(inArray(circles.id, circleIds)),
    dbOrTx
      .select({
        circleId: circleMembers.circleId,
        role: circleMembers.role,
        createdAt: circleMembers.createdAt,
      })
      .from(circleMembers)
      .where(
        and(
          inArray(circleMembers.circleId, circleIds),
          eq(circleMembers.accountId, ownerAccountId),
        ),
      ),
  ])

  const ownerDisabledAt = ownerRow[0]?.disabledAt ?? null
  const circleById = new Map(circleRows.map((c) => [c.id, c]))
  const memberByCircle = new Map(memberRows.map((m) => [m.circleId, m]))
  const pCircle = circleById.get(primaryCircleId)
  const pMember = memberByCircle.get(primaryCircleId)
  const primaryMembership: CircleGrantMembership = {
    circleId: primaryCircleId,
    circleSlug: pCircle?.slug ?? '',
    circleName: pCircle?.name ?? '',
    circleKind: pCircle?.kind ?? 'shared',
    role: pMember?.role ?? null,
    memberSince: pMember?.createdAt ?? null,
  }

  return rows.map((row) => {
    const scopes = LensKeyScopes.parse(row.scopes)
    const linkedCircles = row.linkedCircles ?? []
    const linkedInputs: LinkedCircleInput[] = linkedCircles.map((grant) => {
      const c = circleById.get(grant.circleId)
      const m = memberByCircle.get(grant.circleId)
      return {
        grant,
        membership: c
          ? {
              circleId: c.id,
              circleSlug: c.slug,
              circleName: c.name,
              circleKind: c.kind,
              role: m?.role ?? null,
              memberSince: m?.createdAt ?? null,
            }
          : null,
      }
    })
    const { effectiveScopes, circleGrants } = computeKeyGrants({
      key: { scopes, createdAt: row.createdAt, revokedAt: row.revokedAt },
      ownerDisabledAt,
      primary: primaryMembership,
      linked: linkedInputs,
    })
    return {
      id: row.id,
      clientId: row.clientId,
      name: row.name,
      prefix: row.prefix,
      linkedCircles,
      contextFacets: row.contextFacets ?? {},
      personaOverrideId: row.personaOverrideId,
      scopes,
      effectiveScopes,
      circleGrants,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
    }
  })
}

export async function describeClientKeys(
  tx: Tx,
  circleId: string,
  clientId: string,
): Promise<KeyInfo[] | null> {
  const client = await clientRow(tx, clientId, false)
  if (!client || client.circleId !== circleId) return null
  const rows = await tx
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.clientId, clientId), eq(apiKeys.circleId, circleId)))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
  return buildKeyInfos(tx, circleId, client.ownerAccountId, rows)
}
