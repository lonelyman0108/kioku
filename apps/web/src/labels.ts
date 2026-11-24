import {
  BUILTIN_FACET_NAMES,
  CIRCLE_KIND_NAMES,
  CREDENTIAL_CAPABILITY_NAMES,
  CREDENTIAL_HOSTED_NAME,
  CREDENTIAL_ROTATION_NAME,
  DREAM_KIND_NAMES,
  ENTRY_KIND_NAMES,
  FACET_MATCH_MODE_NAMES,
  PERSON_MEMORY_MODE_NAMES,
  SENSITIVITY_NAMES,
  STRATA_BAND_NAMES,
  type AccessContext,
  type ActivityItem,
  type BenchMark,
  type ClientInfo,
  type CredentialSource,
  type EventActor,
  type KeyAccessMatrix,
  type LensKeyScopes,
  type OriginScope,
  type Provenance,
  type ReadDenial,
  type RecallSource,
  type SessionExtra,
} from '@kioku/contracts'

import { icons } from './icons'

export const bandLabels = STRATA_BAND_NAMES
export const entryKindLabels = ENTRY_KIND_NAMES
export const circleKindLabels = CIRCLE_KIND_NAMES
export const sensitivityLabels = SENSITIVITY_NAMES
export const credentialCapabilityLabels = CREDENTIAL_CAPABILITY_NAMES
export const personMemoryModeLabels = PERSON_MEMORY_MODE_NAMES
export const facetMatchModeLabels = FACET_MATCH_MODE_NAMES
export const builtinFacetLabels = BUILTIN_FACET_NAMES
export const dreamKindLabels = DREAM_KIND_NAMES

// 访问密钥的 admin 权限对应「管理语境词典与人格」，避免被误解为记忆圈管理员
export const ADMIN_SCOPE_LABEL = '管理语境词典与人格'

export interface ScopeTag {
  key: 'read' | 'write' | 'max' | 'realms' | 'credentials' | 'admin'
  prefix: string
  value: string
  suffix: string
}

export function scopeTags(s: LensKeyScopes, credentials = s.credentials): ScopeTag[] {
  const tags: ScopeTag[] = [
    { key: 'read', prefix: '读 ', value: String(s.readKinds.length), suffix: ' 类' },
    { key: 'write', prefix: '写 ', value: String(s.writeKinds.length), suffix: ' 类' },
    { key: 'max', prefix: '至', value: sensitivityLabels[s.maxSensitivity], suffix: '' },
  ]
  if (s.allowedRealms !== null) {
    tags.push({
      key: 'realms',
      prefix: '场域 ',
      value: s.allowedRealms.length ? s.allowedRealms.join(' / ') : '无',
      suffix: '',
    })
  }
  if (credentials !== 'none') {
    tags.push({
      key: 'credentials',
      prefix: '凭据',
      value: credentialCapabilityLabels[credentials],
      suffix: '',
    })
  }
  if (s.admin) tags.push({ key: 'admin', prefix: ADMIN_SCOPE_LABEL, value: '', suffix: '' })
  return tags
}

export const scopeTagText = (tag: ScopeTag) => `${tag.prefix}${tag.value}${tag.suffix}`

export const scopesSummary = (s: LensKeyScopes, credentials = s.credentials) =>
  scopeTags(s, credentials).map(scopeTagText).join('，')

export const accessContextLabels: Record<AccessContext, string> = {
  none: '无上下文（本机 Agent）',
  direct: '陌生人私聊',
  owner_direct: '本人私聊',
  group: '群聊',
  cron: '定时任务 / 子 Agent',
}

export const accessContextShortLabels: Record<AccessContext, string> = {
  none: '无上下文',
  direct: '陌生人私聊',
  owner_direct: '本人私聊',
  group: '群聊',
  cron: '定时任务',
}

export const originScopeLabels: Record<KeyAccessMatrix['contexts'][number]['originScope'], string> =
  {
    any: '来源不限',
    client: '来源仅限全局与本客户端',
    group: '来源仅限全局、本客户端与本群（按跨群认人设置）',
    direct: '来源仅限全局、本客户端与此人的对话',
  }

export const recallSourceLabels: Record<RecallSource, string> = {
  'session.start': '会话开始',
  'prompt.submit': '每轮输入',
  'mcp.search': 'MCP 搜索',
  'rest.recall': 'REST 召回',
}

export const sessionExtraLabels: Record<SessionExtra, string> = {
  summaries: '会话摘要',
  recent: '近期更新的记忆',
  related: '与当前项目相关的记忆',
}

export const readDenialLabels: Record<ReadDenial, string> = {
  deleted: '已删除',
  expired: '已失效或过期',
  kind: '超出访问密钥的可读记忆类型',
  circle: '不在访问密钥的可读记忆圈内',
  sensitivity: '超出访问密钥的敏感级上限',
  secret: '机密记忆仅可按短 ID 读取，不参与召回',
  realm: '允许场域白名单不允许',
  client: '仅限对应客户端可见',
  origin: '来源作用域不匹配',
  owner: '属于其他成员',
  group_lock: '受单群隔离锁拦截',
  persona: '不在当前人格范围内',
}

export const provenanceLabels: Record<Provenance, string> = {
  owner: '本人',
  agent: 'Agent',
  untrusted: '未确认来源',
  system: '系统',
}

export const eventLabels: Record<string, { label: string; icon: string }> = {
  create: { label: '新建', icon: icons.add },
  import: { label: '导入', icon: icons.imported },
  sync: { label: '同步导入', icon: icons.imported },
  update: { label: '修改', icon: icons.edit },
  transfer_out: { label: '迁出记忆圈', icon: icons.moved },
  transfer_in: { label: '迁入记忆圈', icon: icons.moved },
  delete: { label: '删除', icon: icons.remove },
  restore: { label: '恢复此版', icon: icons.restore },
  undelete: { label: '恢复', icon: icons.undelete },
  expire: { label: '到期失效', icon: icons.expired },
  reactivate: { label: '恢复生效', icon: icons.reactivate },
  confirm: { label: '确认来源', icon: icons.confirmed },
  convert_credential: { label: '转存为凭据', icon: icons.credentials },
  protect: { label: '提高保护', icon: icons.confirmed },
  redact: { label: '抹除敏感段', icon: icons.privacy },
  ignore_plaintext: { label: '忽略明文提示', icon: icons.left },
  unignore_plaintext: { label: '撤销忽略', icon: icons.undelete },
  access: { label: '查看正文', icon: icons.reveal },
}

export const entryViaLabels: Record<string, string> = {
  console: '在管理界面查看',
  export: '随记忆圈导出',
  rest: '通过 REST 接口',
  kioku_get: '通过 kioku_get',
  kioku_browse: '通过 kioku_browse',
  kioku_update: '修改后的结果（kioku_update）',
  kioku_transfer: '迁移后的结果（kioku_transfer）',
}

export const memoryViaLabels = entryViaLabels

export function eventLabel(type: string): { label: string; icon: string } {
  return eventLabels[type] ?? { label: type, icon: icons.edit }
}

export function originScopeText(scope: OriginScope): string {
  switch (scope.kind) {
    case 'group':
      return scope.name ? `群「${scope.name}」` : '已删除的群'
    case 'direct':
      return scope.name ? `与「${scope.name}」的私聊` : '已删除的联系人'
    case 'client':
      return scope.name ? `客户端「${scope.name}」` : '已删除的客户端'
    default:
      return '全局'
  }
}

export const activityLinkable = (item: Pick<ActivityItem, 'left' | 'deleted' | 'expired'>) =>
  !item.left && !item.deleted && !item.expired

export function actorLabel(actor: EventActor): { name: string; viaClient: boolean } {
  if (actor.accountName) return { name: actor.accountName, viaClient: false }
  if (actor.clientName) {
    return {
      name: actor.keyName ? `${actor.clientName}（${actor.keyName}）` : actor.clientName,
      viaClient: true,
    }
  }
  return { name: '未知', viaClient: false }
}

export const benchAccountLabel = (mark: BenchMark) => mark.accountName ?? '已删除的账号'

export const changeLabels: Record<string, string> = {
  content: '正文',
  title: '标题',
  variants: '变体',
  topics: '主题标签',
  disclosure: '召回说明',
  priority: '优先级',
  sensitivity: '敏感级',
  glossary: '关键词',
  validTo: '有效期',
}

export const credentialSourceLabels: Record<CredentialSource, string> = {
  hosted: CREDENTIAL_HOSTED_NAME,
  vault: '密码库',
}

export const credentialEventLabels: Record<string, { label: string; icon: string }> = {
  create: { label: '新建', icon: icons.add },
  import: { label: '从导出文件导入', icon: icons.imported },
  update: { label: '修改', icon: icons.edit },
  delete: { label: '删除', icon: icons.remove },
  undelete: { label: '恢复', icon: icons.undelete },
  access: { label: '取用', icon: icons.reveal },
}

export const credentialViaLabels: Record<string, string> = {
  console: '在管理界面查看',
  circle_export: '随记忆圈导出',
  kioku_credential: '通过 kioku_credential',
  run: '通过 kioku run',
  rest: '通过 REST 接口',
}

export const credentialChangeLabels: Record<string, string> = {
  name: '名称',
  description: '说明',
  values: '值',
  fields: '字段对应',
  clientIds: '限定的客户端',
  allowedRealms: '允许的场域',
  expiresAt: '到期时间',
  needsRotation: CREDENTIAL_ROTATION_NAME,
}

export function restrictedClientsLabel(
  clientIds: readonly string[] | null,
  clients: readonly ClientInfo[] | undefined,
  me: string | undefined,
): string {
  if (clientIds === null) return '不限定'
  if (!clientIds.length) return '不开放给任何客户端'
  if (!clients) return '…'
  return clientIds
    .map((id) => {
      const client = clients.find((c) => c.id === id)
      if (!client) return '已删除的客户端'
      return client.ownerAccountId === me
        ? client.name
        : `${client.name}（非当前账号的客户端，不可用）`
    })
    .join('、')
}

export function allowedRealmsLabel(allowedRealms: readonly string[] | null): string {
  if (allowedRealms === null) return '不限定'
  if (!allowedRealms.length) return '禁止所有场域'
  return allowedRealms.join('、')
}

export const plaintextChoiceLabels = {
  convert: '转存为凭据',
  ignore: '不是凭据',
} as const satisfies Record<'convert' | 'ignore', string>

export type ActivityActorKind = 'account' | 'client' | 'bench' | 'unknown'
export function activityActorKind(key: string): ActivityActorKind {
  if (key.startsWith('account:')) return 'account'
  if (key.startsWith('client:')) return 'client'
  return key === 'bench' ? 'bench' : 'unknown'
}

export const activityActorIcons: Record<ActivityActorKind, string> = {
  account: icons.user,
  client: icons.bot,
  bench: icons.bench,
  unknown: icons.unknownActor,
}

export function activityActorName(kind: ActivityActorKind, name: string | null): string {
  if (kind === 'bench') return '测试台'
  if (kind === 'unknown') return '未知'
  return name ?? (kind === 'account' ? '已删除的账号' : '已删除的客户端')
}

export function activityActor(item: Pick<ActivityItem, 'actor' | 'actorKey' | 'bench'>): {
  kind: ActivityActorKind
  name: string
  hint: string
} {
  const kind = activityActorKind(item.actorKey)
  if (kind === 'bench') {
    const account = item.bench ? benchAccountLabel(item.bench) : '未知'
    return { kind, name: `测试台 · ${account}`, hint: `测试台，操作账号：${account}` }
  }
  const name =
    kind === 'account'
      ? (item.actor.accountName ?? '已删除的账号')
      : kind === 'client'
        ? (item.actor.clientName ?? '已删除的客户端')
        : '未知'
  return {
    kind,
    name,
    hint: item.actor.keyName ? `${name}，访问密钥：${item.actor.keyName}` : name,
  }
}
