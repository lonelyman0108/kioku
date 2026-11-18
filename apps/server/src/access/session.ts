import type { PlatformRef, SessionContextInput, SubjectKind } from '@kioku/contracts'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import { withCircle, type Tx } from '../db/client'
import { clientGroupRules, conversations, subjectIdentities, subjects } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import { clipChars } from '../recall/text'
import { resolveAccess, type Access, type SessionContext } from './access'

const PLATFORM_NAME_CHARS = 128

export interface KeySession {
  context: SessionContext
  personaId: string | null
  subjects: SessionSubject[]
}

export interface SessionSubject {
  id: string
  role: 'sender' | 'group'
  name: string | null
}

interface ResolvedSubject {
  id: string
  name: string | null
  accountId: string | null
}

// 将密钥权限矩阵与本次会话上下文合成为单次请求的 Access 对象
export function accessForKey(key: KeyPrincipal, session: KeySession = defaultSession(key)): Access {
  return resolveAccess({
    primaryCircleId: key.circleId,
    primaryCircleRealms: key.primaryCircle.defaultRealms,
    scopes: key.scopes,
    grants: key.circleGrants,
    staticContextRealms: key.staticContextRealms,
    client: {
      clientId: key.client.id,
      ownerAccountId: key.client.ownerAccountId,
      ...(key.client.config.elevateOwnerDirect
        ? { elevateOwnerDirect: key.client.config.elevateOwnerDirect }
        : {}),
      personMemoryMode: key.client.config.personMemoryMode,
    },
    context: session.context,
  })
}

// 接入实例的有效默认人格（密钥指定的人格覆盖优先于接入实例默认人格）
export function defaultPersonaOf(key: KeyPrincipal): string | null {
  return key.personaOverrideId ?? key.client.defaultPersonaId
}

export function defaultSession(key: KeyPrincipal): KeySession {
  return { context: {}, personaId: defaultPersonaOf(key), subjects: [] }
}

// 把接入方上报的会话上下文解析成数据库对象与会话上下文：平台账号按 (circleId, platform, kind, externalId) 查找或创建
export async function resolveKeySession(
  deps: Deps,
  key: KeyPrincipal,
  input: SessionContextInput | undefined,
): Promise<KeySession> {
  if (!input) return defaultSession(key)
  const { chatType } = input
  if (chatType === 'cron' || chatType === 'subagent') {
    return { ...defaultSession(key), context: { chatType } }
  }

  const platform = input.platform!
  return withCircle(deps.db, key.circleId, async (tx) => {
    const sender = input.sender
      ? await resolveSubject(tx, key.circleId, platform, 'person', input.sender, {
          refresh: chatType === 'direct',
        })
      : null

    // 查出接入实例的全部按群规则，用于识别单群强隔离锁与按群人格覆盖
    const rules = await tx
      .select({
        groupSubjectId: clientGroupRules.groupSubjectId,
        personaId: clientGroupRules.personaId,
        isolateGroupMemory: clientGroupRules.isolateGroupMemory,
      })
      .from(clientGroupRules)
      .where(eq(clientGroupRules.clientId, key.client.id))

    const lockedGroupIds = new Set(
      rules.filter((r) => r.isolateGroupMemory).map((r) => r.groupSubjectId),
    )
    const lockedGroupScopes = [...lockedGroupIds].map((id) => `group:${id}`)

    const loadSharedGroupScopes = async (): Promise<string[]> => {
      if (key.client.config.personMemoryMode !== 'persona_shared') return []
      const convs = await tx
        .select({ subjectId: conversations.subjectId })
        .from(conversations)
        .where(
          and(
            eq(conversations.clientId, key.client.id),
            inArray(conversations.kind, ['group', 'channel']),
            isNotNull(conversations.subjectId),
          ),
        )
      return convs
        .map((c) => c.subjectId!)
        .filter((id) => !lockedGroupIds.has(id))
        .map((id) => `group:${id}`)
    }

    if (chatType === 'direct') {
      const sharedGroupScopes = await loadSharedGroupScopes()
      return {
        context: {
          chatType,
          senderSubjectId: sender!.id,
          senderIsOwner: sender!.accountId === key.client.ownerAccountId,
          sharedGroupScopes,
          lockedGroupScopes,
        },
        personaId: defaultPersonaOf(key),
        subjects: [{ id: sender!.id, role: 'sender', name: sender!.name }],
      }
    }

    const group = await resolveSubject(tx, key.circleId, platform, 'group', input.group!, {
      refresh: true,
    })
    const currentRule = rules.find((r) => r.groupSubjectId === group.id)
    const currentGroupIsolated = currentRule?.isolateGroupMemory === true
    const sharedGroupScopes = currentGroupIsolated ? [] : await loadSharedGroupScopes()

    return {
      context: {
        chatType,
        groupSubjectId: group.id,
        ...(sender ? { senderSubjectId: sender.id } : {}),
        currentGroupIsolated,
        sharedGroupScopes,
        lockedGroupScopes,
      },
      personaId: currentRule?.personaId ?? defaultPersonaOf(key),
      subjects: [
        ...(sender ? [{ id: sender.id, role: 'sender' as const, name: sender.name }] : []),
        { id: group.id, role: 'group', name: group.name },
      ],
    }
  })
}

export async function groupPersona(
  tx: Tx,
  key: KeyPrincipal,
  groupSubjectId: string,
): Promise<string | null> {
  const [rule] = await tx
    .select({ personaId: clientGroupRules.personaId })
    .from(clientGroupRules)
    .where(
      and(
        eq(clientGroupRules.clientId, key.client.id),
        eq(clientGroupRules.groupSubjectId, groupSubjectId),
      ),
    )
  return rule?.personaId ?? defaultPersonaOf(key)
}

async function resolveSubject(
  tx: Tx,
  circleId: string,
  platform: string,
  kind: SubjectKind,
  ref: PlatformRef,
  options: { refresh: boolean },
): Promise<ResolvedSubject> {
  const reported = ref.name ? clipChars(ref.name, PLATFORM_NAME_CHARS) : undefined
  const known = async () => {
    const found = await findIdentity(tx, circleId, platform, kind, ref.id)
    if (!found) return undefined
    if (options.refresh || found.identityName === null) await refreshName(tx, found, reported)
    return {
      id: found.subjectId,
      name: reported ?? (options.refresh ? found.identityName : null),
      accountId: found.accountId,
    }
  }
  const existing = await known()
  if (existing) return existing

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`subject:${circleId}:${platform}:${kind}:${ref.id}`}, 0))`,
  )
  const raced = await known()
  if (raced) return raced

  const [subject] = await tx
    .insert(subjects)
    .values({ circleId, kind, displayName: reported ?? ref.id })
    .returning({ id: subjects.id })
  await tx.insert(subjectIdentities).values({
    circleId,
    subjectId: subject!.id,
    kind,
    platform,
    externalId: ref.id,
    displayName: reported ?? null,
  })
  return { id: subject!.id, name: reported ?? null, accountId: null }
}

interface FoundIdentity {
  identityId: string
  externalId: string
  identityName: string | null
  subjectId: string
  subjectName: string
  nameLocked: boolean
  accountId: string | null
}

async function findIdentity(
  tx: Tx,
  circleId: string,
  platform: string,
  kind: SubjectKind,
  externalId: string,
): Promise<FoundIdentity | undefined> {
  const [row] = await tx
    .select({
      identityId: subjectIdentities.id,
      externalId: subjectIdentities.externalId,
      identityName: subjectIdentities.displayName,
      subjectId: subjects.id,
      subjectName: subjects.displayName,
      nameLocked: subjects.nameLocked,
      accountId: subjects.accountId,
    })
    .from(subjectIdentities)
    .innerJoin(subjects, eq(subjects.id, subjectIdentities.subjectId))
    .where(
      and(
        eq(subjectIdentities.circleId, circleId),
        eq(subjectIdentities.platform, platform),
        eq(subjectIdentities.kind, kind),
        eq(subjectIdentities.externalId, externalId),
      ),
    )
  return row
}

async function refreshName(tx: Tx, found: FoundIdentity, name: string | undefined): Promise<void> {
  if (name === undefined || name === found.identityName) return
  await tx
    .update(subjectIdentities)
    .set({ displayName: name })
    .where(eq(subjectIdentities.id, found.identityId))
  const previous = found.identityName ?? found.externalId
  if (!found.nameLocked && found.subjectName === previous) {
    await tx
      .update(subjects)
      .set({ displayName: name, updatedAt: new Date() })
      .where(
        and(
          eq(subjects.id, found.subjectId),
          eq(subjects.displayName, previous),
          eq(subjects.nameLocked, false),
        ),
      )
  }
}
