import {
  LAYERS,
  SENSITIVITIES,
  type KeyScopes,
  type Layer,
  type Provenance,
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
  // 主人私聊时最多提升到哪一级；不配置就不提升，和陌生人私聊一样
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
  appId: string
  // 允许按 URI 显式读取 secret；召回和搜索永远不返回 secret
  canReadSecret: boolean
  admin: boolean
}

const PRIVATE_LAYERS: readonly Layer[] = ['owner', 'private']
const SHARED_CONTEXT_LAYERS: readonly Layer[] = ['base', 'persona', 'app', 'subject', 'episode']
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
    admin: scopes.admin,
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
    }
  }

  // 定时任务与子 agent：不是和主人对话，拿不到主人画像和私人层
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
    readLayers: elevated
      ? intersect(scopes.readLayers, [...SHARED_CONTEXT_LAYERS, 'owner'])
      : intersect(scopes.readLayers, SHARED_CONTEXT_LAYERS),
    writeLayers: intersect(scopes.writeLayers, UNTRUSTED_WRITE_LAYERS),
    maxSensitivity: minSensitivity(scopes.maxSensitivity, elevated ? 'internal' : 'public'),
    originScopes: new Set(['global', appScope, directScope]),
    writeOriginScope: directScope,
    // 平台账号能证明的身份有限，主人私聊写入也按 untrusted 处理
    writeProvenance: 'untrusted',
    canReadSecret: false,
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
  // 当前人格及其继承链；persona 层只能读到这些人格的记忆
  personaIds: readonly string[]
  // 按 URI 显式读取时才可能读到 secret
  explicit?: boolean
  now?: Date
}

export function canRead(access: Access, memory: MemoryFacts, options: ReadOptions): boolean {
  const now = options.now ?? new Date()
  if (memory.deletedAt) return false
  if (memory.validTo && memory.validTo <= now) return false
  if (memory.expiresAt && memory.expiresAt <= now) return false
  if (!access.readLayers.has(memory.layer)) return false

  if (memory.sensitivity === 'secret') {
    if (!options.explicit || !access.canReadSecret) return false
  } else if (sensitivityRank(memory.sensitivity) > sensitivityRank(access.maxSensitivity)) {
    return false
  }

  if (access.originScopes && !access.originScopes.has(memory.originScope)) return false
  if (PRIVATE_LAYERS.includes(memory.layer) && memory.ownerAccountId !== access.ownerAccountId) {
    return false
  }
  if (memory.layer === 'persona' && !options.personaIds.includes(memory.personaId ?? '')) {
    return false
  }
  if (memory.layer === 'app' && memory.appId !== access.appId) return false
  return true
}

export interface WriteIntent {
  layer: Layer
  sensitivity: Sensitivity
}

export function canWrite(access: Access, intent: WriteIntent): boolean {
  if (!access.writeLayers.has(intent.layer)) return false
  if (intent.sensitivity === 'secret') return access.canReadSecret
  return sensitivityRank(intent.sensitivity) <= sensitivityRank(access.maxSensitivity)
}

// 管理界面里主人本人的会话：读写自己能看到的一切
export function ownerConsoleScopes(): KeyScopes {
  return {
    readLayers: [...LAYERS],
    writeLayers: [...LAYERS],
    maxSensitivity: 'secret',
    admin: true,
  }
}
