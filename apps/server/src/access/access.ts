import {
  ACCESS_CONTEXTS,
  CIRCLE_KINDS,
  ENTRY_KINDS,
  SENSITIVITIES,
  sensitivityAllowed,
  type AccessContext,
  type CircleEffectiveGrant,
  type CircleKind,
  type CredentialAccessReason,
  type CredentialCapability,
  type EntryKind,
  type KeyAccessMatrix,
  type LensKeyScopes,
  type MemberRole,
  type PersonMemoryMode,
  type Provenance,
  type ReadDenial,
  type Sensitivity,
  type SubjectKind,
} from '@kioku/contracts'

import { currentMoment } from '../db/moment'
import { checkStaticRealmLock, normalizeRealms } from './realms'

// 有效权限 = 透镜访问密钥上限（主场圈 / 关联客场圈）∩ 会话上下文规则 ∩ 接入实例配置。
// 会话上下文由插件上报，不可信，每条规则只能在密钥上限之内收紧，绝不能放宽。

export type ChatType = 'direct' | 'group' | 'channel' | 'cron' | 'subagent'

export interface SessionContext {
  chatType?: ChatType
  groupSubjectId?: string
  senderSubjectId?: string
  senderIsOwner?: boolean
  // 当前群是否开启单群强隔离锁（client_group_rules.isolate_group_memory）
  currentGroupIsolated?: boolean
  // 拟人跨群模式下，当前 client 未加锁且实际存在会话的群作用域（形如 group:<id>）
  sharedGroupScopes?: readonly string[]
  // 已开启单群强隔离锁的群作用域集合（用于 readDenial 准确区分 group_lock 与 origin）
  lockedGroupScopes?: readonly string[]
}

export interface ClientAccessConfig {
  clientId: string
  ownerAccountId: string
  elevateOwnerDirect?: 'internal'
  personMemoryMode?: PersonMemoryMode
}

export interface CircleAccess {
  circleId: string
  circleKind: CircleKind
  isPrimary: boolean
  readKinds: ReadonlySet<EntryKind>
  writeKinds: ReadonlySet<EntryKind>
  maxSensitivity: Sensitivity
  canReadSecret: boolean
}

export interface Access {
  primaryCircleId: string
  primaryCircleRealms: readonly string[]
  circles: ReadonlyMap<string, CircleAccess>
  // null 表示不按白名单限制场域；非 null 时仅放行与之交集非空的目标
  allowedRealms: ReadonlySet<string> | null
  // 访问密钥静态 context_facets 经 implies 展开后的场域集合
  staticContextRealms: ReadonlySet<string>
  // null 表示无会话上下文上限（本机受信 Agent 或管理界面）；否则仅允许基础作用域 + 合法跨群人物印象
  baseOriginScopes: ReadonlySet<string> | null
  crossGroupPersonScopes: ReadonlySet<string>
  lockedGroupScopes: ReadonlySet<string>
  currentGroupIsolated: boolean
  // 带会话上下文（cron/subagent/group/channel/direct）时，一律禁止读取归属于成员个人的本地会话摘要
  forbidOwnerBoundEpisodes: boolean
  writeOriginScope: string
  writeProvenance: Provenance
  ownerAccountId: string
  // null 表示管理界面（不代表某个接入实例）
  clientId: string | null
  admin: boolean
  // 主场圈的凭据能力；带会话上下文或客场圈一律为 none
  credentials: CredentialCapability
}

const UNTRUSTED_WRITE_KINDS: readonly EntryKind[] = ['fact', 'episode']

export function sensitivityRank(s: Sensitivity): number {
  return SENSITIVITIES.indexOf(s)
}

function minSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return sensitivityRank(a) <= sensitivityRank(b) ? a : b
}

function intersectKinds(base: readonly EntryKind[], allowed: readonly EntryKind[]): Set<EntryKind> {
  return new Set(base.filter((k) => allowed.includes(k)))
}

export interface CircleGrantMembership {
  circleId: string
  circleSlug: string
  circleName: string
  circleKind: CircleKind
  role: MemberRole | null
  memberSince: Date | null
}

export interface LinkedCircleInput {
  grant: { circleId: string; mode: 'read' | 'read_write' }
  membership: CircleGrantMembership | null
}

export interface ComputeKeyGrantsInput {
  key: { scopes: LensKeyScopes; createdAt: Date; revokedAt: Date | null }
  ownerDisabledAt: Date | null
  primary: CircleGrantMembership
  linked: readonly LinkedCircleInput[]
}

export interface ComputedKeyGrants {
  effectiveScopes: LensKeyScopes | null
  circleGrants: CircleEffectiveGrant[]
}

// 密钥上限受成员「当前」在该记忆圈的角色约束：owner 保留上限；editor 失去 admin、secret 与凭据能力；
// viewer 在此基础上转为只读
export function clampScopesToRole(scopes: LensKeyScopes, role: MemberRole): LensKeyScopes {
  if (role === 'owner') return scopes
  return {
    readKinds: scopes.readKinds,
    writeKinds: role === 'viewer' ? [] : scopes.writeKinds,
    maxSensitivity: minSensitivity(scopes.maxSensitivity, 'private'),
    allowedRealms: scopes.allowedRealms,
    admin: false,
    credentials: 'none',
  }
}

// 密钥在主场圈现在的有效上限：吊销、不在圈里、账号停用、或在重新加入前签发的密钥一律作废返回 null
export function keyEffectiveScopes(
  key: { scopes: LensKeyScopes; createdAt: Date; revokedAt: Date | null },
  owner: { role: MemberRole | null; memberSince: Date | null; disabledAt: Date | null } | undefined,
): LensKeyScopes | null {
  if (key.revokedAt || !owner?.role || owner.disabledAt) return null
  if (owner.memberSince && key.createdAt < owner.memberSince) return null
  return clampScopesToRole(key.scopes, owner.role)
}

// 计算主场圈 + 各关联客场圈的独立权限状态：
// 主场圈失效则整把密钥作废，客场圈离开或重进后失效时静默剥离该圈，客场圈上限封顶在 private 且禁用凭据、禁用跨圈写入非 entry
export function computeKeyGrants(input: ComputeKeyGrantsInput): ComputedKeyGrants {
  const { key, ownerDisabledAt, primary, linked } = input
  const effectiveScopes = keyEffectiveScopes(key, {
    role: primary.role,
    memberSince: primary.memberSince,
    disabledAt: ownerDisabledAt,
  })

  if (!effectiveScopes) {
    return {
      effectiveScopes: null,
      circleGrants: [
        {
          circleId: primary.circleId,
          circleSlug: primary.circleSlug,
          circleName: primary.circleName,
          circleKind: primary.circleKind,
          isPrimary: true,
          mode: 'read',
          readKinds: [],
          writeKinds: [],
          maxSensitivity: 'public',
          credentials: 'none',
          active: false,
        },
        ...linked.map((l) => ({
          circleId: l.grant.circleId,
          circleSlug: l.membership?.circleSlug ?? '',
          circleName: l.membership?.circleName ?? '',
          circleKind: l.membership?.circleKind ?? ('shared' as CircleKind),
          isPrimary: false,
          mode: 'read' as const,
          readKinds: [] as EntryKind[],
          writeKinds: [] as EntryKind[],
          maxSensitivity: 'public' as Sensitivity,
          credentials: 'none' as CredentialCapability,
          active: false,
        })),
      ],
    }
  }

  const primaryGrant: CircleEffectiveGrant = {
    circleId: primary.circleId,
    circleSlug: primary.circleSlug,
    circleName: primary.circleName,
    circleKind: primary.circleKind,
    isPrimary: true,
    mode: effectiveScopes.writeKinds.length > 0 ? 'read_write' : 'read',
    readKinds: [...effectiveScopes.readKinds],
    writeKinds: [...effectiveScopes.writeKinds],
    maxSensitivity: effectiveScopes.maxSensitivity,
    credentials: effectiveScopes.credentials,
    active: true,
  }

  const linkedGrants: CircleEffectiveGrant[] = linked.map((item) => {
    const m = item.membership
    const isActive = Boolean(
      m &&
      m.role &&
      m.circleId !== primary.circleId &&
      (!m.memberSince || key.createdAt >= m.memberSince),
    )
    if (!isActive || !m?.role) {
      return {
        circleId: item.grant.circleId,
        circleSlug: m?.circleSlug ?? '',
        circleName: m?.circleName ?? '',
        circleKind: m?.circleKind ?? 'shared',
        isPrimary: false,
        mode: 'read',
        readKinds: [],
        writeKinds: [],
        maxSensitivity: 'public',
        credentials: 'none',
        active: false,
      }
    }
    const clamped = clampScopesToRole(key.scopes, m.role)
    const canWriteAway = item.grant.mode === 'read_write' && m.role !== 'viewer'
    const writeKinds = canWriteAway ? clamped.writeKinds.filter((k) => k === 'entry') : []
    return {
      circleId: m.circleId,
      circleSlug: m.circleSlug,
      circleName: m.circleName,
      circleKind: m.circleKind,
      isPrimary: false,
      mode: canWriteAway && writeKinds.length > 0 ? 'read_write' : 'read',
      readKinds: [...clamped.readKinds],
      writeKinds,
      maxSensitivity: minSensitivity(clamped.maxSensitivity, 'private'),
      credentials: 'none',
      active: true,
    }
  })

  return {
    effectiveScopes,
    circleGrants: [primaryGrant, ...linkedGrants],
  }
}

export interface ResolveAccessInput {
  primaryCircleId: string
  primaryCircleRealms?: readonly string[]
  scopes: LensKeyScopes
  grants: readonly CircleEffectiveGrant[]
  staticContextRealms?: ReadonlySet<string>
  client: ClientAccessConfig
  context?: SessionContext
}

export function resolveAccess(input: ResolveAccessInput): Access {
  const {
    primaryCircleId,
    primaryCircleRealms = [],
    scopes,
    grants,
    staticContextRealms = new Set<string>(),
    client,
    context = {},
  } = input
  const allowedRealms =
    scopes.allowedRealms !== null ? new Set(normalizeRealms(scopes.allowedRealms)) : null
  const normalizedPrimaryRealms = normalizeRealms(primaryCircleRealms)
  const lockedGroupScopes = new Set(context.lockedGroupScopes ?? [])
  const currentGroupIsolated = context.currentGroupIsolated === true
  const clientScope = `client:${client.clientId}`
  const chatType = context.chatType

  const circleMap = new Map<string, CircleAccess>()
  const activeGrants = grants.filter((g) => g.active)

  if (!chatType) {
    for (const g of activeGrants) {
      circleMap.set(g.circleId, {
        circleId: g.circleId,
        circleKind: g.circleKind,
        isPrimary: g.isPrimary,
        readKinds: new Set(g.readKinds),
        writeKinds: new Set(g.writeKinds),
        maxSensitivity: g.isPrimary
          ? g.maxSensitivity
          : minSensitivity(g.maxSensitivity, 'private'),
        canReadSecret: g.isPrimary && g.maxSensitivity === 'secret',
      })
    }
    return {
      primaryCircleId,
      primaryCircleRealms: normalizedPrimaryRealms,
      circles: circleMap,
      allowedRealms,
      staticContextRealms,
      baseOriginScopes: null,
      crossGroupPersonScopes: new Set(),
      lockedGroupScopes,
      currentGroupIsolated: false,
      forbidOwnerBoundEpisodes: false,
      writeOriginScope: 'global',
      writeProvenance: 'agent',
      ownerAccountId: client.ownerAccountId,
      clientId: client.clientId,
      admin: scopes.admin,
      credentials: scopes.credentials ?? 'none',
    }
  }

  if (chatType === 'cron' || chatType === 'subagent') {
    for (const g of activeGrants) {
      circleMap.set(g.circleId, {
        circleId: g.circleId,
        circleKind: g.circleKind,
        isPrimary: g.isPrimary,
        readKinds: new Set(g.readKinds),
        writeKinds: g.isPrimary ? new Set(g.writeKinds) : new Set(),
        maxSensitivity:
          g.circleKind === 'personal'
            ? minSensitivity(g.maxSensitivity, 'public')
            : minSensitivity(g.maxSensitivity, 'internal'),
        canReadSecret: false,
      })
    }
    return {
      primaryCircleId,
      primaryCircleRealms: normalizedPrimaryRealms,
      circles: circleMap,
      allowedRealms,
      staticContextRealms,
      baseOriginScopes: new Set(['global', clientScope]),
      crossGroupPersonScopes: new Set(),
      lockedGroupScopes,
      currentGroupIsolated: false,
      forbidOwnerBoundEpisodes: true,
      writeOriginScope: clientScope,
      writeProvenance: 'agent',
      ownerAccountId: client.ownerAccountId,
      clientId: client.clientId,
      admin: scopes.admin,
      credentials: 'none',
    }
  }

  if (chatType === 'group' || chatType === 'channel') {
    if (!context.groupSubjectId) throw new Error('群聊上下文缺少群对象')
    const groupScope = `group:${context.groupSubjectId}`
    const crossGroupPersonScopes = new Set<string>()
    if (client.personMemoryMode === 'persona_shared' && !currentGroupIsolated) {
      for (const s of context.sharedGroupScopes ?? []) {
        if (s.startsWith('group:') && s !== groupScope && !lockedGroupScopes.has(s)) {
          crossGroupPersonScopes.add(s)
        }
      }
    }
    for (const g of activeGrants) {
      circleMap.set(g.circleId, {
        circleId: g.circleId,
        circleKind: g.circleKind,
        isPrimary: g.isPrimary,
        readKinds: new Set(g.readKinds),
        writeKinds: g.isPrimary ? intersectKinds(g.writeKinds, UNTRUSTED_WRITE_KINDS) : new Set(),
        maxSensitivity: minSensitivity(g.maxSensitivity, 'public'),
        canReadSecret: false,
      })
    }
    return {
      primaryCircleId,
      primaryCircleRealms: normalizedPrimaryRealms,
      circles: circleMap,
      allowedRealms,
      staticContextRealms,
      baseOriginScopes: new Set(['global', clientScope, groupScope]),
      crossGroupPersonScopes,
      lockedGroupScopes,
      currentGroupIsolated,
      forbidOwnerBoundEpisodes: true,
      writeOriginScope: groupScope,
      writeProvenance: 'untrusted',
      ownerAccountId: client.ownerAccountId,
      clientId: client.clientId,
      admin: scopes.admin,
      credentials: 'none',
    }
  }

  // 私聊
  if (!context.senderSubjectId) throw new Error('私聊上下文缺少发言人对象')
  const directScope = `direct:${context.senderSubjectId}`
  const elevated = context.senderIsOwner === true && client.elevateOwnerDirect === 'internal'
  const directCap: Sensitivity = elevated ? 'internal' : 'public'
  const crossGroupPersonScopes = new Set<string>()
  if (client.personMemoryMode === 'persona_shared') {
    for (const s of context.sharedGroupScopes ?? []) {
      if (s.startsWith('group:') && !lockedGroupScopes.has(s)) {
        crossGroupPersonScopes.add(s)
      }
    }
  }
  for (const g of activeGrants) {
    circleMap.set(g.circleId, {
      circleId: g.circleId,
      circleKind: g.circleKind,
      isPrimary: g.isPrimary,
      readKinds: new Set(g.readKinds),
      writeKinds: g.isPrimary ? intersectKinds(g.writeKinds, UNTRUSTED_WRITE_KINDS) : new Set(),
      maxSensitivity: minSensitivity(g.maxSensitivity, directCap),
      canReadSecret: false,
    })
  }
  return {
    primaryCircleId,
    primaryCircleRealms: normalizedPrimaryRealms,
    circles: circleMap,
    allowedRealms,
    staticContextRealms,
    baseOriginScopes: new Set(['global', clientScope, directScope]),
    crossGroupPersonScopes,
    lockedGroupScopes,
    currentGroupIsolated: false,
    forbidOwnerBoundEpisodes: true,
    writeOriginScope: directScope,
    writeProvenance: 'untrusted',
    ownerAccountId: client.ownerAccountId,
    clientId: client.clientId,
    admin: scopes.admin,
    credentials: 'none',
  }
}

export interface EntryFacts {
  circleId: string
  kind: EntryKind
  sensitivity: Sensitivity
  originScope: string
  clientId: string | null
  ownerAccountId: string | null
  subjectKind: SubjectKind | null
  realms: readonly string[]
  validTo: Date | null
  expiresAt: Date | null
  deletedAt: Date | null
}

export interface ReadOptions {
  explicit?: boolean
  management?: boolean
  now?: Date
}

export function canRead(access: Access, entry: EntryFacts, options: ReadOptions = {}): boolean {
  return readDenial(access, entry, options) === null
}

// 有效期过了没有：validTo 或 expiresAt 不晚于 now 就算过期
export function lapsed(entry: Pick<EntryFacts, 'validTo' | 'expiresAt'>, now: Date): boolean {
  return (
    (entry.validTo !== null && entry.validTo <= now) ||
    (entry.expiresAt !== null && entry.expiresAt <= now)
  )
}

// 读不到的原因，读得到时为 null；SQL 过滤条件 readableConditions 必须与之逐条对齐
export function readDenial(
  access: Access,
  entry: EntryFacts,
  options: ReadOptions = {},
): ReadDenial | null {
  if (!options.management) {
    if (entry.deletedAt) return 'deleted'
    if (entry.validTo !== null || entry.expiresAt !== null) {
      const now = options.now ?? currentMoment()
      if (!now) throw new Error('判断有效期要传入数据库的时刻（ReadOptions.now）')
      if (lapsed(entry, now)) return 'expired'
    }
  }

  const circle = access.circles.get(entry.circleId)
  if (!circle) return 'circle'
  if (!circle.readKinds.has(entry.kind)) return 'kind'

  if (entry.sensitivity === 'secret') {
    if (!circle.isPrimary) return 'circle'
    if (!(options.explicit || options.management) || !circle.canReadSecret) return 'secret'
    if (
      !checkStaticRealmLock(
        entry.realms,
        access.primaryCircleRealms,
        access.allowedRealms,
        access.staticContextRealms,
      )
    ) {
      return 'realm'
    }
  } else if (sensitivityRank(entry.sensitivity) > sensitivityRank(circle.maxSensitivity)) {
    return 'sensitivity'
  }

  if (entry.ownerAccountId !== null && entry.ownerAccountId !== access.ownerAccountId) {
    return 'owner'
  }
  if (
    access.forbidOwnerBoundEpisodes &&
    entry.kind === 'episode' &&
    entry.ownerAccountId !== null
  ) {
    return 'owner'
  }

  if (access.baseOriginScopes !== null && !access.baseOriginScopes.has(entry.originScope)) {
    const canCrossGroup =
      access.clientId !== null &&
      access.crossGroupPersonScopes.has(entry.originScope) &&
      entry.circleId === access.primaryCircleId &&
      entry.kind === 'fact' &&
      entry.subjectKind === 'person' &&
      (entry.clientId === null || entry.clientId === access.clientId)

    if (!canCrossGroup) {
      if (
        entry.kind === 'fact' &&
        entry.subjectKind === 'person' &&
        entry.originScope.startsWith('group:')
      ) {
        if (
          entry.clientId !== null &&
          access.clientId !== null &&
          entry.clientId !== access.clientId
        ) {
          return 'client'
        }
        if (access.currentGroupIsolated || access.lockedGroupScopes.has(entry.originScope)) {
          return 'group_lock'
        }
      }
      return 'origin'
    }
  }

  return null
}

export interface WriteIntent {
  circleId: string
  kind: EntryKind
  sensitivity: Sensitivity
}

export function canWrite(access: Access, intent: WriteIntent): boolean {
  const circle = access.circles.get(intent.circleId)
  if (!circle) return false
  if (!circle.writeKinds.has(intent.kind)) return false
  if (!sensitivityAllowed(circle.circleKind, intent.kind, intent.sensitivity)) return false
  if (intent.sensitivity === 'secret') return circle.canReadSecret
  return sensitivityRank(intent.sensitivity) <= sensitivityRank(circle.maxSensitivity)
}

// 改动已有的记录（修改、删除、取代、恢复）：在能写的基础上，不可信来源（群聊、陌生人私聊）
// 只能改动同 originScope 内由不可信来源写下的记录
export function canModify(
  access: Access,
  row: WriteIntent & { provenance: Provenance; originScope: string },
): boolean {
  return (
    canWrite(access, row) &&
    (access.writeProvenance !== 'untrusted' ||
      (row.provenance === 'untrusted' && row.originScope === access.writeOriginScope))
  )
}

export interface CredentialFacts {
  circleId: string
  clientIds: readonly string[] | null
  allowedRealms: readonly string[] | null
}

const CAPABILITY_RANK: Record<CredentialCapability, number> = { none: 0, use: 1, manage: 2 }
const CREDENTIAL_CAPABILITIES_DESC = ['manage', 'use'] as const

// 凭据取用或管理拒绝原因：客场圈与静态场域锁定冲突均拒绝（接口对外统一返回 404）
export function credentialDenial(
  access: Access,
  credential: CredentialFacts,
  need: 'use' | 'manage',
): CredentialAccessReason | null {
  if (access.clientId !== null && access.baseOriginScopes !== null) return 'context'
  const primary = access.circles.get(access.primaryCircleId)
  if (!primary || credential.circleId !== access.primaryCircleId) return 'circle'
  if (CAPABILITY_RANK[access.credentials] < CAPABILITY_RANK[need]) return 'capability'
  if (!primary.readKinds.has('entry')) return 'scope'
  if (sensitivityRank(primary.maxSensitivity) < sensitivityRank('private')) return 'scope'
  if (need === 'manage' && !primary.writeKinds.has('entry')) return 'scope'
  if (access.clientId !== null) {
    if (
      !checkStaticRealmLock(
        credential.allowedRealms ?? [],
        access.primaryCircleRealms,
        access.allowedRealms,
        access.staticContextRealms,
      )
    ) {
      return 'realm'
    }
    if (credential.clientIds !== null && !credential.clientIds.includes(access.clientId)) {
      return 'client'
    }
  }
  return null
}

export function canUseCredential(access: Access, credential: CredentialFacts): boolean {
  return credentialDenial(access, credential, 'use') === null
}

export type ConsoleRole = 'owner' | 'editor' | 'viewer'

// 管理界面单圈权限：owner 可读写 secret 与管理凭据；editor 最高 private 且不可管理凭据；viewer 只读
export function consoleAccess(
  circleId: string,
  circleKind: CircleKind,
  role: ConsoleRole,
  accountId: string,
  circleDefaultRealms: readonly string[] = [],
): Access {
  const allKinds = new Set<EntryKind>(ENTRY_KINDS)
  const circles = new Map<string, CircleAccess>([
    [
      circleId,
      {
        circleId,
        circleKind,
        isPrimary: true,
        readKinds: allKinds,
        writeKinds: role === 'viewer' ? new Set() : allKinds,
        maxSensitivity: role === 'owner' ? 'secret' : 'private',
        canReadSecret: role === 'owner',
      },
    ],
  ])
  return {
    primaryCircleId: circleId,
    primaryCircleRealms: normalizeRealms(circleDefaultRealms),
    circles,
    allowedRealms: null,
    staticContextRealms: new Set(),
    baseOriginScopes: null,
    crossGroupPersonScopes: new Set(),
    lockedGroupScopes: new Set(),
    currentGroupIsolated: false,
    forbidOwnerBoundEpisodes: false,
    writeOriginScope: 'global',
    writeProvenance: 'owner',
    ownerAccountId: accountId,
    clientId: null,
    admin: role === 'owner',
    credentials: role === 'owner' ? 'manage' : 'use',
  }
}

const MATRIX_CONTEXTS: Record<AccessContext, SessionContext> = {
  none: {},
  direct: { chatType: 'direct', senderSubjectId: 'sender' },
  owner_direct: { chatType: 'direct', senderSubjectId: 'owner', senderIsOwner: true },
  group: { chatType: 'group', groupSubjectId: 'group' },
  cron: { chatType: 'cron' },
}

export function accessMatrix(input: Omit<ResolveAccessInput, 'context'>): KeyAccessMatrix {
  const activeGrants = input.grants.filter((g) => g.active)
  return {
    contexts: ACCESS_CONTEXTS.map((context) => {
      const access = resolveAccess({ ...input, context: MATRIX_CONTEXTS[context] })
      const origins = access.baseOriginScopes ? [...access.baseOriginScopes] : null
      const testRealms =
        access.allowedRealms !== null ? [...access.allowedRealms] : [...access.staticContextRealms]
      return {
        context,
        credentials:
          CREDENTIAL_CAPABILITIES_DESC.find(
            (need) =>
              credentialDenial(
                access,
                {
                  circleId: input.primaryCircleId,
                  clientIds: null,
                  allowedRealms: testRealms.length ? testRealms : null,
                },
                need,
              ) === null,
          ) ?? 'none',
        originScope: !origins
          ? 'any'
          : origins.some((o) => o.startsWith('group:'))
            ? 'group'
            : origins.some((o) => o.startsWith('direct:'))
              ? 'direct'
              : 'client',
        circles: activeGrants.map((grant) => ({
          circleId: grant.circleId,
          circleName: grant.circleName,
          circleKind: grant.circleKind,
          isPrimary: grant.isPrimary,
          credentials: grant.isPrimary
            ? (CREDENTIAL_CAPABILITIES_DESC.find(
                (need) =>
                  credentialDenial(
                    access,
                    {
                      circleId: grant.circleId,
                      clientIds: null,
                      allowedRealms: testRealms.length ? testRealms : null,
                    },
                    need,
                  ) === null,
              ) ?? 'none')
            : 'none',
          rows: ENTRY_KINDS.map((kind) => ({
            kind,
            cells: SENSITIVITIES.map((sensitivity) => {
              const allowed = sensitivityAllowed(grant.circleKind, kind, sensitivity)
              const facts: EntryFacts = {
                circleId: grant.circleId,
                kind,
                sensitivity,
                originScope: 'global',
                clientId: null,
                ownerAccountId: null,
                subjectKind: kind === 'fact' ? 'person' : null,
                realms:
                  sensitivity === 'secret' && access.allowedRealms?.size !== 0 ? testRealms : [],
                validTo: null,
                expiresAt: null,
                deletedAt: null,
              }
              const read = !allowed
                ? 'none'
                : !canRead(access, facts, { explicit: true })
                  ? 'none'
                  : canRead(access, facts, { explicit: false })
                    ? 'recall'
                    : 'explicit'
              return {
                sensitivity,
                read,
                write: canWrite(access, { circleId: grant.circleId, kind, sensitivity }),
              } as const
            }),
          })),
        })),
      }
    }),
  }
}

export { CIRCLE_KINDS }
