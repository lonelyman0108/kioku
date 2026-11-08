import {
  ACCESS_CONTEXTS,
  LAYERS,
  SENSITIVITIES,
  sensitivityAllowed,
  type AccessContext,
  type CredentialAccessReason,
  type CredentialCapability,
  type KeyAccessMatrix,
  type KeyScopes,
  type Layer,
  type MemberRole,
  type Provenance,
  type ReadDenial,
  type Sensitivity,
} from '@kioku/contracts'

// 有效权限 = API Key 的上限 ∩ 会话上下文规则 ∩ 应用配置。
// 会话上下文由插件上报，不可信，所以每条规则都只能在 Key 上限之内收紧，不能放宽。

export type ChatType = 'direct' | 'group' | 'channel' | 'cron' | 'subagent'

export interface SessionContext {
  chatType?: ChatType
  // 以下由服务端根据插件上报的平台 ID 解析成对象后填入
  groupSubjectId?: string
  senderSubjectId?: string
  senderIsOwner?: boolean
}

export interface AppAccessConfig {
  appId: string
  ownerAccountId: string
  // 应用当前的人格。Key 写人格的记忆只能写它，不能改继承链上的祖先；没有人格时人格的记忆一条也写不了
  personaId?: string | null
  // 本人私聊时读取本人记忆（界面上的开关）：开启后本人私聊读本人的内部及以下，不开就和陌生人私聊一样
  elevateOwnerDirect?: 'internal'
}

export interface Access {
  readLayers: ReadonlySet<Layer>
  writeLayers: ReadonlySet<Layer>
  maxSensitivity: Sensitivity
  // null 表示不限来源作用域（没有会话上下文的受信 agent）
  originScopes: ReadonlySet<string> | null
  // 新写入记忆的来源作用域与来源
  writeOriginScope: string
  writeProvenance: Provenance
  ownerAccountId: string
  // null 表示管理界面：不代表某个应用，能看到空间里所有应用的记忆
  appId: string | null
  // 能写哪些应用的记忆。'all'：admin Key 与管理界面里的空间 owner；Key 只能写自己的应用；
  // 管理界面里的 editor 只能写自己是所有者的应用，与签发 Key 的规则一致（Key 只能由应用所有者签发）
  writableAppIds: ReadonlySet<string> | 'all'
  // 能写哪些人格的记忆。'all'：admin Key 与管理界面；Key 只能写应用当前的人格，
  // 否则群聊版的应用能改掉它继承的主人格的设定
  writablePersonaIds: ReadonlySet<string> | 'all'
  // 允许按坐标显式读取 secret；召回和搜索永远不返回 secret
  canReadSecret: boolean
  admin: boolean
  // 凭据能力：Key 的签发上限，带会话上下文时一律是 none；管理界面里空间 owner 是 manage，别人是 use
  credentials: CredentialCapability
}

// 带会话上下文时读得到的归属：本人之外的五类。本人只给不带会话上下文的访问密钥，开启之后再给本人私聊
const SHARED_CONTEXT_LAYERS: readonly Layer[] = ['core', 'persona', 'app', 'subject', 'episode']
const UNTRUSTED_WRITE_LAYERS: readonly Layer[] = ['subject', 'episode']

export function sensitivityRank(s: Sensitivity): number {
  return SENSITIVITIES.indexOf(s)
}

function minSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return sensitivityRank(a) <= sensitivityRank(b) ? a : b
}

function intersect(base: readonly Layer[], allowed: readonly Layer[]): Set<Layer> {
  return new Set(base.filter((l) => allowed.includes(l)))
}

export function resolveAccess(
  scopes: KeyScopes,
  app: AppAccessConfig,
  context: SessionContext = {},
): Access {
  const common = {
    ownerAccountId: app.ownerAccountId,
    appId: app.appId,
    writableAppIds: scopes.admin ? ('all' as const) : new Set([app.appId]),
    writablePersonaIds: scopes.admin
      ? ('all' as const)
      : new Set(app.personaId ? [app.personaId] : []),
    admin: scopes.admin,
    // 凭据只给不带会话上下文的访问：群聊、私聊、定时任务与子 agent 都没有
    credentials: 'none' as CredentialCapability,
  }
  const appScope = `app:${app.appId}`

  // 没有会话上下文：Key 自己就是全部授权，例如本机的编码 agent
  if (!context.chatType) {
    return {
      ...common,
      readLayers: new Set(scopes.readLayers),
      writeLayers: new Set(scopes.writeLayers),
      maxSensitivity: scopes.maxSensitivity,
      originScopes: null,
      writeOriginScope: 'global',
      writeProvenance: 'agent',
      canReadSecret: scopes.maxSensitivity === 'secret',
      credentials: scopes.credentials ?? 'none',
    }
  }

  // 定时任务与子 agent：不是和本人对话，读不到本人的记忆
  if (context.chatType === 'cron' || context.chatType === 'subagent') {
    return {
      ...common,
      readLayers: intersect(scopes.readLayers, SHARED_CONTEXT_LAYERS),
      writeLayers: intersect(scopes.writeLayers, SHARED_CONTEXT_LAYERS),
      maxSensitivity: minSensitivity(scopes.maxSensitivity, 'internal'),
      originScopes: new Set(['global', appScope]),
      writeOriginScope: appScope,
      writeProvenance: 'agent',
      canReadSecret: false,
    }
  }

  if (context.chatType === 'group' || context.chatType === 'channel') {
    if (!context.groupSubjectId) throw new Error('群聊上下文缺少群对象')
    const groupScope = `group:${context.groupSubjectId}`
    return {
      ...common,
      readLayers: intersect(scopes.readLayers, SHARED_CONTEXT_LAYERS),
      writeLayers: intersect(scopes.writeLayers, UNTRUSTED_WRITE_LAYERS),
      maxSensitivity: minSensitivity(scopes.maxSensitivity, 'public'),
      originScopes: new Set(['global', appScope, groupScope]),
      writeOriginScope: groupScope,
      writeProvenance: 'untrusted',
      canReadSecret: false,
    }
  }

  // 私聊
  if (!context.senderSubjectId) throw new Error('私聊上下文缺少发言人对象')
  const directScope = `direct:${context.senderSubjectId}`
  const elevated = context.senderIsOwner === true && app.elevateOwnerDirect === 'internal'
  return {
    ...common,
    // 开启「本人私聊时读取本人记忆」后加上本人，敏感级到内部为止：本人的私密只给不带会话上下文的访问密钥
    readLayers: elevated
      ? intersect(scopes.readLayers, [...SHARED_CONTEXT_LAYERS, 'user'])
      : intersect(scopes.readLayers, SHARED_CONTEXT_LAYERS),
    writeLayers: intersect(scopes.writeLayers, UNTRUSTED_WRITE_LAYERS),
    maxSensitivity: minSensitivity(scopes.maxSensitivity, elevated ? 'internal' : 'public'),
    originScopes: new Set(['global', appScope, directScope]),
    writeOriginScope: directScope,
    // 平台账号能证明的身份有限，本人私聊写入也按 untrusted 处理
    writeProvenance: 'untrusted',
    canReadSecret: false,
  }
}

// Key 的有效上限还要受应用主人「当前」角色约束：签发之后主人被降级，Key 也随之降级，
// 与签发规则一致：admin、secret 与凭据能力（取用、管理）只属于空间 owner，viewer 只读
export function clampScopesToRole(scopes: KeyScopes, role: MemberRole): KeyScopes {
  if (role === 'owner') return scopes
  return {
    readLayers: scopes.readLayers,
    writeLayers: role === 'viewer' ? [] : scopes.writeLayers,
    maxSensitivity: minSensitivity(scopes.maxSensitivity, 'private'),
    admin: false,
    credentials: 'none',
  }
}

// Key 现在的有效上限：签发上限按应用主人当前的角色收紧。Key 已吊销、主人已经不在空间里、主人的账号被停用，
// 或主人离开后又被重新加入、而 Key 签发在重新加入之前，Key 都作废，返回 null。鉴权与 Key 列表都按这里算。
// 停用之后再启用，Key 恢复：停用不吊销，只是期间用不了
export function keyEffectiveScopes(
  key: { scopes: KeyScopes; createdAt: Date; revokedAt: Date | null },
  owner: { role: MemberRole | null; memberSince: Date | null; disabledAt: Date | null } | undefined,
): KeyScopes | null {
  if (key.revokedAt || !owner?.role || owner.disabledAt) return null
  if (owner.memberSince && key.createdAt < owner.memberSince) return null
  return clampScopesToRole(key.scopes, owner.role)
}

// 权限范围用的会话上下文：联系人只是占位，只看归属与敏感级，来源作用域另外说明
const MATRIX_CONTEXTS: Record<AccessContext, SessionContext> = {
  none: {},
  direct: { chatType: 'direct', senderSubjectId: 'sender' },
  owner_direct: { chatType: 'direct', senderSubjectId: 'owner', senderIsOwner: true },
  group: { chatType: 'group', groupSubjectId: 'group' },
  cron: { chatType: 'cron' },
}

// 一把 Key 在各种会话上下文下实际能读写哪些归属、哪些敏感级：每一格按 canRead 与 canWrite 判断一条
// 属于这个应用、应用所有者与当前人格的记忆，不另写一份规则。本人不设公开，那一格读写都没有
export function accessMatrix(scopes: KeyScopes, app: AppAccessConfig): KeyAccessMatrix {
  const personaId = app.personaId ?? null
  const personaIds = personaId ? [personaId] : []
  return {
    contexts: ACCESS_CONTEXTS.map((context) => {
      const access = resolveAccess(scopes, app, MATRIX_CONTEXTS[context])
      const origins = access.originScopes ? [...access.originScopes] : null
      return {
        context,
        credentials:
          CREDENTIAL_CAPABILITIES_DESC.find(
            (need) => credentialDenial(access, { appIds: null }, need) === null,
          ) ?? 'none',
        originScope: !origins
          ? 'any'
          : origins.some((o) => o.startsWith('group:'))
            ? 'group'
            : origins.some((o) => o.startsWith('direct:'))
              ? 'direct'
              : 'app',
        rows: LAYERS.map((layer) => ({
          layer,
          cells: SENSITIVITIES.map((sensitivity) => {
            const facts: MemoryFacts = {
              layer,
              sensitivity,
              originScope: 'global',
              ownerAccountId: app.ownerAccountId,
              personaId,
              appId: app.appId,
              validTo: null,
              expiresAt: null,
              deletedAt: null,
            }
            const read = !sensitivityAllowed(layer, sensitivity)
              ? 'none'
              : !canRead(access, facts, { personaIds, explicit: true })
                ? 'none'
                : canRead(access, facts, { personaIds })
                  ? 'recall'
                  : 'explicit'
            return {
              sensitivity,
              read,
              write: canWrite(access, { layer, sensitivity, appId: app.appId, personaId }),
            } as const
          }),
        })),
      }
    }),
  }
}

// 判断时用到的记忆字段；查询里的 SQL 过滤条件必须与 canRead 保持一致
export interface MemoryFacts {
  layer: Layer
  sensitivity: Sensitivity
  originScope: string
  ownerAccountId: string | null
  personaId: string | null
  appId: string | null
  validTo: Date | null
  expiresAt: Date | null
  deletedAt: Date | null
}

export interface ReadOptions {
  // 当前人格及其继承链；人格的记忆只能读到这些人格的
  personaIds: readonly string[]
  // 按坐标显式读取时才可能读到 secret
  explicit?: boolean
  // 管理读取：管理界面看历史、恢复时用。不看有效期与删除状态（历史就是给过期、被推翻和删掉的版本看的），
  // 按显式读取算，人格也不限（管理界面本来看得到全部人格，删掉的人格的旧快照照样看得到）
  management?: boolean
  now?: Date
}

export function canRead(access: Access, memory: MemoryFacts, options: ReadOptions): boolean {
  return readDenial(access, memory, options) === null
}

// 有效期过了没有：失效（valid_to：被推翻、到了有效到）或到期（expires_at：会话摘要）的时刻不晚于 now 就算过了
export function lapsed(memory: Pick<MemoryFacts, 'validTo' | 'expiresAt'>, now: Date): boolean {
  return (
    (memory.validTo !== null && memory.validTo <= now) ||
    (memory.expiresAt !== null && memory.expiresAt <= now)
  )
}

// 读不到的第一个原因，读得到时为 null。canRead 就是它，召回调试台用它说明一条记忆为什么被过滤掉
export function readDenial(
  access: Access,
  memory: MemoryFacts,
  options: ReadOptions,
): Exclude<ReadDenial, 'override'> | null {
  const now = options.now ?? new Date()
  if (!options.management) {
    if (memory.deletedAt) return 'deleted'
    if (lapsed(memory, now)) return 'expired'
  }
  if (!access.readLayers.has(memory.layer)) return 'layer'

  if (memory.sensitivity === 'secret') {
    if (!(options.explicit || options.management) || !access.canReadSecret) return 'secret'
  } else if (sensitivityRank(memory.sensitivity) > sensitivityRank(access.maxSensitivity)) {
    return 'sensitivity'
  }

  if (access.originScopes && !access.originScopes.has(memory.originScope)) return 'origin'
  // 归某个成员的（本人，以及不带会话上下文的会话摘要）只有这个成员读得到
  if (memory.ownerAccountId !== null && memory.ownerAccountId !== access.ownerAccountId) {
    return 'owner'
  }
  if (
    memory.layer === 'persona' &&
    !options.management &&
    !options.personaIds.includes(memory.personaId ?? '')
  ) {
    return 'persona'
  }
  if (memory.layer === 'app' && access.appId !== null && memory.appId !== access.appId) {
    return 'app'
  }
  return null
}

export interface WriteIntent {
  layer: Layer
  sensitivity: Sensitivity
  // 应用的记忆所属的应用、人格的记忆所属的人格；其他归属为 null
  appId: string | null
  personaId: string | null
}

export function canWrite(access: Access, intent: WriteIntent): boolean {
  if (!access.writeLayers.has(intent.layer)) return false
  if (!sensitivityAllowed(intent.layer, intent.sensitivity)) return false
  if (intent.layer === 'app' && !canWriteApp(access, intent.appId)) return false
  if (intent.layer === 'persona' && !canWritePersona(access, intent.personaId)) return false
  if (intent.sensitivity === 'secret') return access.canReadSecret
  return sensitivityRank(intent.sensitivity) <= sensitivityRank(access.maxSensitivity)
}

// 改动已有的记录（修改、移动、删除、推翻、恢复）：在能写这一类之上，不可信来源（群聊、陌生人私聊）
// 只能动不可信来源写下的记录。否则群里的人能改掉受信的记忆（例如本人确认过的事实），来源却仍显示受信
export function canModify(access: Access, row: WriteIntent & { provenance: Provenance }): boolean {
  return (
    canWrite(access, row) &&
    (access.writeProvenance !== 'untrusted' || row.provenance === 'untrusted')
  )
}

export function canWriteApp(access: Access, appId: string | null): boolean {
  return access.writableAppIds === 'all' || (appId !== null && access.writableAppIds.has(appId))
}

export function canWritePersona(access: Access, personaId: string | null): boolean {
  return (
    access.writablePersonaIds === 'all' ||
    (personaId !== null && access.writablePersonaIds.has(personaId))
  )
}

// 凭据归某个成员，和本人的记忆一样：取用（列出、取值）要凭据能力至少是 use，能读本人、最高敏感级至少 private，
// 并且不带会话上下文；管理（新建、修改、删除）要能力是 manage，并且还能写本人。凭据属于这次访问代表的成员
// （Key 是应用所有者），只查这个成员的凭据，所以这里不比所有者。限定了应用的，只有那些应用的 Key 能用；
// 跨人格 / 应用写入（admin）也不放宽。管理界面不代表某个应用，不受这个限制。不再借用 secret 级
export interface CredentialFacts {
  appIds: readonly string[] | null
}

const CAPABILITY_RANK: Record<CredentialCapability, number> = { none: 0, use: 1, manage: 2 }
// 从高到低，权限范围按它找出某个会话上下文下实际的能力
const CREDENTIAL_CAPABILITIES_DESC = ['manage', 'use'] as const

// 不能取用或管理的第一个原因，能时为 null。原因记进访问事件，见 contracts 的 CREDENTIAL_ACCESS_REASONS
export function credentialDenial(
  access: Access,
  credential: CredentialFacts,
  need: 'use' | 'manage',
): CredentialAccessReason | null {
  if (access.appId !== null && access.originScopes !== null) return 'context'
  if (CAPABILITY_RANK[access.credentials] < CAPABILITY_RANK[need]) return 'capability'
  if (!access.readLayers.has('user')) return 'scope'
  if (sensitivityRank(access.maxSensitivity) < sensitivityRank('private')) return 'scope'
  if (need === 'manage' && !access.writeLayers.has('user')) return 'scope'
  if (
    access.appId !== null &&
    credential.appIds !== null &&
    !credential.appIds.includes(access.appId)
  ) {
    return 'app'
  }
  return null
}

export function canUseCredential(access: Access, credential: CredentialFacts): boolean {
  return credentialDenial(access, credential, 'use') === null
}

export type ConsoleRole = 'owner' | 'editor' | 'viewer'

// 管理界面里成员本人的权限，与签发 Key 的规则一致：secret 只有空间 owner 能读写，viewer 只读，
// 应用的记忆 editor 只能写自己是所有者的应用（ownedAppIds）。本人的记忆与不带会话上下文的会话摘要只看得到自己的；
// 所有人格、所有应用的记忆都能看到（personaIds 由调用方传入全部人格）
export function consoleAccess(
  role: ConsoleRole,
  accountId: string,
  ownedAppIds: Iterable<string> = [],
): Access {
  const all = new Set<Layer>(LAYERS)
  return {
    readLayers: all,
    writeLayers: role === 'viewer' ? new Set() : all,
    maxSensitivity: role === 'owner' ? 'secret' : 'private',
    originScopes: null,
    writeOriginScope: 'global',
    writeProvenance: 'owner',
    ownerAccountId: accountId,
    appId: null,
    writableAppIds: role === 'owner' ? 'all' : new Set(role === 'editor' ? ownedAppIds : []),
    // 人格不设限：editor 本来就能建一个用任意人格的应用、再用它的 Key 写那个人格
    writablePersonaIds: 'all',
    canReadSecret: role === 'owner',
    admin: role === 'owner',
    // 凭据和机密记忆一样，目前只有空间 owner 能管理（含连接密码库与查看值）
    credentials: role === 'owner' ? 'manage' : 'use',
  }
}
