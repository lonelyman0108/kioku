import {
  CREDENTIAL_ACCESS_REASON_NAMES,
  CREDENTIAL_ACCESS_RESULT_NAMES,
  CREDENTIAL_NAME_PATTERN,
  defaultCredentialFields,
  VAULT_CONNECTION_STATUS_NAMES,
  VAULT_CUSTOM_FIELD_PREFIX,
  VAULT_DISABLED_REASON_NAMES,
  type CredentialEvent,
  type CredentialField,
  type MemberRole,
  type VaultConnection,
  type VaultDisabledReason,
  type VaultErrorKind,
  type VaultItemList,
  type VaultItemSummary,
  type VaultItemType,
} from '@kioku/contracts'

import { readFailure } from './api/client'
import { accessContextLabels, credentialChangeLabels, credentialViaLabels } from './labels'
import { clipText } from './text'

// 凭据页的说法和计算：密码库连接、条目与凭据的访问记录

// 凭据的新建、修改、删除、查看值和密码库连接的全部操作都只给空间所有者，别的成员只看列表：
// 他们的访问密钥凭据能力一律是不可用，放开只会让人以为能用。服务端按同一条规则回 403
export const canManageCredentials = (role: MemberRole | undefined) => role === 'owner'

const STANDARD_FIELD_LABELS: Record<string, string> = {
  'login.username': '用户名',
  'login.password': '密码',
  'login.totp': 'TOTP',
  notes: '备注',
}

// 条目里的字段给人看的名字：固定字段用中文名，自定义字段显示原名
export function itemFieldLabel(ref: string): string {
  const fixed = STANDARD_FIELD_LABELS[ref]
  if (fixed) return fixed
  return ref.startsWith(VAULT_CUSTOM_FIELD_PREFIX)
    ? ref.slice(VAULT_CUSTOM_FIELD_PREFIX.length)
    : ref
}

// 接在「条目「…」的」后面的说法：自定义字段名是用户起的（多是英文），加上「字段「…」」才读得通
export function itemFieldPhrase(ref: string): string {
  return ref.startsWith(VAULT_CUSTOM_FIELD_PREFIX)
    ? `字段「${itemFieldLabel(ref)}」`
    : itemFieldLabel(ref)
}

export const vaultItemTypeLabels: Record<VaultItemType, string> = {
  login: '登录',
  note: '安全笔记',
  card: '支付卡',
  identity: '身份',
  ssh_key: 'SSH 密钥',
}

// 最近一次和服务器通信失败的原因
export const vaultErrorLabels: Record<VaultErrorKind, string> = {
  invalid_credentials: '邮箱或主密码错误',
  two_factor_invalid: '验证码错误',
  unsupported_two_factor: '不支持此两步验证方式',
  reauth_required: '登录已失效',
  item_unavailable: '条目不可用',
  read_only: '集合只读',
  item_conflict: '条目已在别处修改',
  value_too_long: '值超出长度上限',
  unsupported_format: '无法识别的加密格式',
  integrity: '内容校验失败',
  unreachable: '无法连接服务器',
  server_error: '服务器返回错误',
}

// 连接状态的一句话：已停用的带上原因
export function connectionStatusText(
  connection: Pick<VaultConnection, 'status' | 'disabledReason'>,
): string {
  const name = VAULT_CONNECTION_STATUS_NAMES[connection.status]
  if (connection.status === 'disabled' && connection.disabledReason) {
    return `${name}：${VAULT_DISABLED_REASON_NAMES[connection.disabledReason]}`
  }
  return name
}

// 重新检查的提示：可用、连接现在的状态，或者服务端的错误（连不上、返回的内容无法识别时回 502）
export function checkNotice(
  outcome: { connection: Pick<VaultConnection, 'status' | 'disabledReason'> } | { error: unknown },
): { title: string; color: 'success' | 'warning' | 'error' } {
  if ('error' in outcome) return { title: readFailure(outcome.error, '检查失败'), color: 'error' }
  const c = outcome.connection
  return c.status === 'ok'
    ? { title: '连接可用', color: 'success' }
    : { title: connectionStatusText(c), color: 'warning' }
}

// 重新检查之后要重读的查询。失败时服务端已经记下最近的错误，只重读连接；条目不重读：
// 列条目会对着连不上的密码库再同步一次，失败了还会自动重试
export function checkRefreshKeys(spaceId: string, succeeded: boolean): string[][] {
  const connections = ['vault-connections', spaceId]
  return succeeded
    ? [connections, ['vault-items', spaceId], ['credentials', spaceId]]
    : [connections]
}

// 停用之后怎么恢复：处理掉原因，再重新检查
export const disabledAdvice: Record<VaultDisabledReason, string> = {
  personal_items: '将个人条目移进组织或删除后，重新检查即可恢复。',
  organization_role: '将此账号在组织中改为普通成员、只分配需要的集合后，重新检查即可恢复。',
}

// 只有可用的连接列得出条目；停用、要重新登录、断开的都要先处理
export const itemsAvailable = (connection: Pick<VaultConnection, 'status'>) =>
  connection.status === 'ok'

// 断开的确认文字：结果、影响、动作
export function disconnectNotice(connection: Pick<VaultConnection, 'credentialCount'>): string {
  const affected = connection.credentialCount
    ? `指向它的 ${connection.credentialCount} 条凭据将无法取值。`
    : '指向它的凭据将无法取值。'
  return `断开后，保存的令牌与密钥立即清除，${affected}重新登录同一账号可恢复。`
}

// 条目所在的集合，按名字列出；读不到名字的（集合列表里没有）不列
export function collectionNames(item: VaultItemSummary, list: Pick<VaultItemList, 'collections'>) {
  return item.collectionIds
    .map((id) => list.collections.find((c) => c.id === id)?.name)
    .filter((name): name is string => !!name)
}

// 起标识时按条目名称建议一个标识：转成小写、别的字符换成 -，和已有的重名时加 -2、-3；拼不出时留空
export function suggestIdentifier(name: string, taken: readonly string[]): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|-+$/g, '')
    .slice(0, 60)
  if (!CREDENTIAL_NAME_PATTERN.test(base)) return ''
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    const next = `${base}-${n}`
    if (!taken.includes(next)) return next
  }
}

// 访问记录一行的细节：结果与原因、经由、用途、会话上下文、字段、修改了哪些部分
export function credentialEventParts(e: CredentialEvent): string[] {
  const parts: string[] = []
  if (e.result) {
    const result = CREDENTIAL_ACCESS_RESULT_NAMES[e.result]
    parts.push(e.reason ? `${result}：${CREDENTIAL_ACCESS_REASON_NAMES[e.reason]}` : result)
  }
  if (e.via) parts.push(credentialViaLabels[e.via] ?? e.via)
  if (e.chatType) {
    const context = accessContextLabels[e.chatType as keyof typeof accessContextLabels]
    parts.push(`会话上下文：${context ?? e.chatType}`)
  }
  if (e.purpose) parts.push(`用途：${e.purpose}`)
  if (e.changes.length) {
    parts.push(`修改了${e.changes.map((x) => credentialChangeLabels[x] ?? x).join('、')}`)
  }
  if (e.fields.length) parts.push(`字段 ${e.fields.join('、')}`)
  return parts
}

// 起标识的表单怎么预填：标识按条目名称建议，名称取条目名称，字段对应按条目里的字段推出
// （defaultCredentialFields，和服务端没给字段对应时推出的一样），字段名之后能改
export function vaultCredentialDraft(
  item: Pick<VaultItemSummary, 'name' | 'fields'>,
  identifiers: readonly string[],
): { identifier: string; name: string; fields: CredentialField[] } {
  return {
    identifier: suggestIdentifier(item.name, identifiers),
    name: clipText(item.name.trim(), 100),
    fields: defaultCredentialFields(item.fields),
  }
}
