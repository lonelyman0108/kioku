import {
  CREDENTIAL_ACCESS_REASON_NAMES,
  CREDENTIAL_ACCESS_RESULT_NAMES,
  CREDENTIAL_EXPIRY_NAMES,
  CREDENTIAL_HOSTED_NAME,
  CREDENTIAL_NAME_PATTERN,
  CREDENTIAL_ROTATION_NAME,
  CredentialWriteError,
  defaultCredentialFields,
  VAULT_CONNECTION_STATUS_NAMES,
  VAULT_CUSTOM_FIELD_PREFIX,
  VAULT_DISABLED_REASON_NAMES,
  VAULT_LOGIN_FIELD_NAMES,
  type ConsoleCredential,
  type CredentialEvent,
  type CredentialField,
  type CredentialStoredIn,
  type MemberRole,
  type OrphanVaultItem,
  type VaultCollection,
  type VaultConnection,
  type VaultDisabledReason,
  type VaultItemList,
  type VaultItemSummary,
  type VaultItemType,
} from '@kioku/contracts'

import { ApiError, readFailure } from './api/client'
import { accessContextLabels, credentialChangeLabels, credentialViaLabels } from './labels'
import { clipText } from './text'
import { formatShort, fromLocalInput, toLocalInput } from './time'

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

// ---- 新凭据的去处 ----

// 设了去处的连接：每个成员最多一个
export function destinationConnection(
  connections: readonly VaultConnection[] | undefined,
): VaultConnection | null {
  return connections?.find((c) => c.destination !== null) ?? null
}

// 新建的凭据（新建、转存、保存前处理里的新建）写到哪里：有去处写进那个集合，没有时由 Kioku 托管。
// 连接列表还没读到时为 null，不下结论
export type NewCredentialStore =
  { kind: 'vault'; connection: VaultConnection; collectionName: string } | { kind: 'hosted' }

export function newCredentialStore(
  connections: readonly VaultConnection[] | undefined,
): NewCredentialStore | null {
  if (!connections) return null
  const c = destinationConnection(connections)
  return c?.destination
    ? { kind: 'vault', connection: c, collectionName: c.destination.collectionName }
    : { kind: 'hosted' }
}

// 写到哪里的名字：密码库的写集合，托管的写「Kioku 托管」。新建之前的去处与新建之后的结果（storedIn）共用
export function storeName(
  store: { kind: 'hosted' } | { kind: 'vault'; collectionName: string },
): string {
  return store.kind === 'vault' ? `密码库集合「${store.collectionName}」` : CREDENTIAL_HOSTED_NAME
}

export const storedInName = (storedIn: CredentialStoredIn) => storeName(storedIn)

// 去处眼下用不了的原因：连接不可用，或者读到的集合里没有它、它变成了只读。用得了时为 null。
// collections 是最近一次同步读到的集合，没读到时只看连接的状态
export function destinationProblem(
  connection: Pick<VaultConnection, 'status' | 'disabledReason' | 'destination'>,
  collections?: readonly VaultCollection[],
): string | null {
  if (!connection.destination) return null
  if (connection.status !== 'ok') {
    return `连接${connectionStatusText(connection)}，恢复前新建凭据将失败`
  }
  if (!collections) return null
  const found = collections.find((x) => x.id === connection.destination!.collectionId)
  if (!found) return '集合不可用，新建凭据将失败，请更改或清除去处'
  if (found.readOnly) return '集合只读，新建凭据将失败，请更改或清除去处'
  return null
}

// 选去处时的集合：按名称排，只读的列出来但不能选
export function destinationChoices(collections: readonly VaultCollection[]) {
  return [...collections]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((x) => ({ id: x.id, name: x.name, disabled: x.readOnly }))
}

// 写进了密码库、凭据却没建成时留下的条目（CredentialWriteError.vaultItem），别的错误为 null
export function orphanVaultItem(err: unknown): OrphanVaultItem | null {
  if (!(err instanceof ApiError)) return null
  const parsed = CredentialWriteError.safeParse(err.payload)
  return parsed.success ? (parsed.data.vaultItem ?? null) : null
}

// 留下的条目怎么说：结果、影响、动作
export function orphanNotice(item: Pick<OrphanVaultItem, 'itemName' | 'collectionName'>): {
  title: string
  detail: string
} {
  return {
    title: `条目「${item.itemName}」已写进集合「${item.collectionName}」，凭据未建成`,
    detail:
      '可在「密码库」分页给这个条目起标识，或在密码库中删除它。直接重试会在集合中另建一个条目。',
  }
}

// 写进密码库时是不是登录类：有 username 或 password 字段的写成登录条目，网址用于自动填充；别的写成隐藏字段
export const isLoginFields = (names: readonly string[]) =>
  names.some((n) => n in VAULT_LOGIN_FIELD_NAMES)

// 网址的说明，放提示层
export const CREDENTIAL_URL_HINT =
  '写进密码库时，含 username 或 password 字段的条目按网址的主机与端口自动填充，其余条目只记下网址。Kioku 托管时不保存网址。'

// ---- 到期与轮换 ----

// 凭据要处理的标记：快到期或已到期、需要轮换。待处理、列表与详情共用
export function credentialFlags(
  c: Pick<ConsoleCredential, 'expiry' | 'rotationRequestedAt'>,
): string[] {
  const flags: string[] = []
  if (c.expiry) flags.push(CREDENTIAL_EXPIRY_NAMES[c.expiry])
  if (c.rotationRequestedAt) flags.push(CREDENTIAL_ROTATION_NAME)
  return flags
}

// 待处理里一条凭据的说明：什么时候到期、什么时候标了需要轮换
export function attentionNotes(
  c: Pick<ConsoleCredential, 'expiresAt' | 'expiry' | 'rotationRequestedAt'>,
  now: Date = new Date(),
): string[] {
  const notes: string[] = []
  if (c.expiresAt && c.expiry === 'expiring') notes.push(`${formatShort(c.expiresAt, now)} 到期`)
  if (c.expiresAt && c.expiry === 'expired') notes.push(`${formatShort(c.expiresAt, now)} 已到期`)
  if (c.rotationRequestedAt) {
    notes.push(`${formatShort(c.rotationRequestedAt, now)} 标记${CREDENTIAL_ROTATION_NAME}`)
  }
  return notes
}

// 到期时间的输入框：datetime-local 的本地时间，没设时为空
export const expiresInput = (expiresAt: string | null) => (expiresAt ? toLocalInput(expiresAt) : '')

// 到期时间要发什么：没改为 undefined，清空为 null，否则是带时区的 ISO 时间。
// 输入框只到分钟，按分钟比较，打开表单什么都没改时不发；填得不完整也不发，由 expiresProblem 拦下
export function expiresChange(before: string | null, input: string): string | null | undefined {
  if (input === expiresInput(before)) return undefined
  if (!input) return null
  return fromLocalInput(input) ?? undefined
}

// 填了却不是完整的日期与时间
export const expiresProblem = (input: string) =>
  input && !fromLocalInput(input) ? '请填写完整的到期时间' : null

// 密码库凭据的值写回原条目时，对应到 TOTP 密钥的字段不能改（取用时给的是现算的验证码）
export const writableVaultField = (field: Pick<CredentialField, 'itemField'>) =>
  field.itemField !== 'login.totp'
