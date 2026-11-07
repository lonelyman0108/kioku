import { z } from 'zod'

import { BenchMark, DeletionRetention, EventActor } from './console'
import { ConsoleMemoryView } from './memories'
import { SENSITIVITIES, Sensitivity, type Layer } from './memory'

// 凭据的标识与字段名。记忆正文里用 {{cred:<标识>}} 引用整条凭据，{{cred:<标识>#<字段>}} 引用其中一个字段
export const CREDENTIAL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const CredentialIdentifier = z
  .string()
  .regex(
    CREDENTIAL_NAME_PATTERN,
    '标识只能包含小写字母、数字、_ 和 -，须以字母或数字开头，最长 64 个字符',
  )
export const CredentialFieldName = z
  .string()
  .regex(
    CREDENTIAL_NAME_PATTERN,
    '字段名只能包含小写字母、数字、_ 和 -，须以字母或数字开头，最长 64 个字符',
  )

// 一条凭据最多这么多个字段
export const MAX_CREDENTIAL_FIELDS = 32

// 记忆正文里的凭据占位符。正文里任何位置出现 {{cred: 都算引用（代码里的也算），格式不对时拒绝写入；
// 要在正文里写到这种写法时去掉花括号。这里不带 g 标记，要找出全部时用它的 source 另建
export const CREDENTIAL_PLACEHOLDER_START = '{{cred:'
export const CREDENTIAL_PLACEHOLDER =
  /\{\{cred:([a-z0-9][a-z0-9_-]{0,63})(?:#([a-z0-9][a-z0-9_-]{0,63}))?\}\}/

// 占位符只能放在本人（user）、敏感级至少 private 的记忆里：按记忆的所有者解析，别的归属的读者解析不到。
// 写入检查、导入计划、转存和管理界面的入口都按这一条判断
export function placeholderAllowed(layer: Layer, sensitivity: Sensitivity): boolean {
  return layer === 'user' && SENSITIVITIES.indexOf(sensitivity) >= SENSITIVITIES.indexOf('private')
}

// 放不进时怎么说：服务端拒绝转存和管理界面提前拦下是同一句
export const CONVERT_SCOPE_TEXT =
  '凭据占位符只能放在本人、敏感级不低于私密的记忆中。请先把这条记忆移进本人或调高敏感级，再转存。'

// 空白字符逐个写出来（与 JS 的 \s 同一个集合）：服务端把这条规则的 source 原样交给 PostgreSQL，
// 它的 \s 随数据库的 locale 变，全角空格、BOM 这类字符两边会判断得不一样
const SPACE =
  ' \\t\\n\\v\\f\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'

const PLAINTEXT_LABELS = 'password|passwd|密码|口令|token|api[_ -]?key|secret'
// 值外面常见的引号、反引号与粗体：占位符写在里面也算占位符
const PLAINTEXT_QUOTES = '"\'`“‘「『*'
// 值到这里结束：中文标点与收尾的引号。英文标点常出现在密码里，不算
const VALUE_STOPS = '，。；、！？）】」』》”’'
// 盖掉明文之后留下的遮盖符（转存时的历史快照、会话摘要的打码）：盖过的不再算明文
export const PLAINTEXT_MASK = '***'
// 遮盖符要整段就是它：后面是空白、行尾、收尾的引号或中文标点；英文的逗号、句号这些算句子的标点，后面还要是空白或行尾。
// 所以 ***hunter2***、***x 照样算明文：真密码可能这样开头，不能借遮盖符躲过提醒和降级拦截
const WHOLE_MASK = `\\*\\*\\*(?:[,.;:]*(?:[${SPACE}]|$)|["'\`${VALUE_STOPS}])`

// 正文像有明文密码或 Token：「密码：…」「token = …」这类写法（值写在下一行的也算，后面跟着占位符或整段遮盖符的不算，
// 这两样写在引号里也不算），或者 sk- 开头的长串。启发式规则，宁可多报：只用来提醒，以及挡住带着明文从 secret 降级
// （管理界面里由空间 owner 确认后可以强制）
export const PLAINTEXT_CREDENTIAL = new RegExp(
  `(?:${PLAINTEXT_LABELS})[${SPACE}]*[:：=][${SPACE}]*(?![${PLAINTEXT_QUOTES}]*(?:\\{\\{cred:|${WHOLE_MASK}))[^${SPACE}]|sk-[A-Za-z0-9]{16,}`,
  'i',
)

// 正文里疑似明文的一处：值在 [start, end) 这一段（JS 字符串的下标），field 是建议用的字段名。
// 规则只认得出值从哪里开始，到哪里结束是猜的，要让人看过再转存
export interface PlaintextCredentialMatch {
  start: number
  end: number
  field: string
}

const PLAINTEXT_ALL = new RegExp(PLAINTEXT_CREDENTIAL.source, 'gi')
const PLAINTEXT_LABEL = new RegExp(`^(?:${PLAINTEXT_LABELS})`, 'i')
// 值写在这些符号里时取里面的部分
const VALUE_WRAPPERS: readonly (readonly [string, string])[] = [
  ['***', '***'],
  ['**', '**'],
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
]
// 值到这里结束：空白、中文标点、占位符
const VALUE_END = new RegExp(`[${SPACE}${VALUE_STOPS}]|\\{\\{cred:`)

function plaintextField(label: string): string {
  const word = label.toLowerCase()
  if (word === 'token' || word === 'secret') return word
  return word.startsWith('api') ? 'api_key' : 'password'
}

// 紧接在规则认出的第一个字之后，值到哪里结束
function plaintextValue(text: string, first: number): { start: number; end: number } {
  for (const [open, close] of VALUE_WRAPPERS) {
    if (!text.startsWith(open, first)) continue
    const start = first + open.length
    const end = text.indexOf(close, start)
    const body = end > start ? text.slice(start, end) : ''
    if (body && !/[\n\r\u2028\u2029]/.test(body)) return { start, end }
  }
  const stop = text.slice(first).search(VALUE_END)
  let end = stop === -1 ? text.length : first + stop
  // 结尾的逗号、句号是句子的标点；感叹号、问号常是密码的一部分，留着
  while (end > first + 1 && ',.;:'.includes(text[end - 1]!)) end--
  return { start: first, end: Math.max(end, first + 1) }
}

// 和 PLAINTEXT_CREDENTIAL 同一条规则，找出每一处的位置与字段名
export function findPlaintextCredentials(text: string): PlaintextCredentialMatch[] {
  const found: PlaintextCredentialMatch[] = []
  let last = 0
  for (const m of text.matchAll(PLAINTEXT_ALL)) {
    const label = PLAINTEXT_LABEL.exec(m[0])?.[0]
    let span: { start: number; end: number }
    if (label) {
      span = plaintextValue(text, m.index + m[0].length - 1)
    } else {
      // sk- 串可能带着连字符或下划线接着往后写，整串都是值
      const tail = /^[A-Za-z0-9_-]*/.exec(text.slice(m.index + m[0].length))![0]
      span = { start: m.index, end: m.index + m[0].length + tail.length }
    }
    // 上一处的值里又像一处（例如 a=1&token=2）：不重复算
    if (
      span.start < last ||
      text.slice(span.start, span.end).includes(CREDENTIAL_PLACEHOLDER_START)
    ) {
      continue
    }
    found.push({ ...span, field: label ? plaintextField(label) : 'api_key' })
    last = span.end
  }
  return found
}

// 凭据的来源：hosted 是值由 Kioku 加密保存；vault 是值在成员连接的密码库里，Kioku 只记连接与条目的 id
export const CREDENTIAL_SOURCES = ['hosted', 'vault'] as const
export const CredentialSource = z.enum(CREDENTIAL_SOURCES)
export type CredentialSource = z.infer<typeof CredentialSource>

// 密码库条目里的字段：login.username、login.password、login.totp、notes，自定义字段写成 field:<名字>。
// 和服务端 credential/bitwarden/types.ts 的 VaultFieldRef 同一种写法
export const VAULT_STANDARD_FIELDS = [
  'login.username',
  'login.password',
  'login.totp',
  'notes',
] as const
export const VAULT_CUSTOM_FIELD_PREFIX = 'field:'
// 自定义字段的名字最长这么多个字符
const VAULT_CUSTOM_FIELD_MAX = 200
const CONTROL_CHARS = /\p{Cc}/u

export function isVaultFieldRef(ref: string): boolean {
  if ((VAULT_STANDARD_FIELDS as readonly string[]).includes(ref)) return true
  if (!ref.startsWith(VAULT_CUSTOM_FIELD_PREFIX)) return false
  const name = ref.slice(VAULT_CUSTOM_FIELD_PREFIX.length)
  return name.length > 0 && name.length <= VAULT_CUSTOM_FIELD_MAX && !CONTROL_CHARS.test(name)
}
export const VaultFieldRef = z
  .string()
  .refine(
    isVaultFieldRef,
    '条目字段只能是 login.username、login.password、login.totp、notes 或 field:<名字>',
  )
export type VaultFieldRef = z.infer<typeof VaultFieldRef>

// 字段：占位符里用的名字，密码库来源再加上条目里对应的字段（itemField）；托管的 itemField 为 null
export const CredentialField = z.object({
  name: CredentialFieldName,
  itemField: VaultFieldRef.nullable(),
})
export type CredentialField = z.infer<typeof CredentialField>

const STANDARD_FIELD_NAMES: Record<string, string> = {
  'login.username': 'username',
  'login.password': 'password',
  'login.totp': 'totp',
  notes: 'notes',
}

function uniqueFieldName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const name = `${base.slice(0, 64 - suffix.length)}${suffix}`
    if (!taken.has(name)) return name
  }
}

// 按条目里的字段推出凭据的字段：login.* 与 notes 取固定的名字（username、password、totp、notes），
// 自定义字段的名字符合字段名的规则时照用；不符合时转成小写、别的字符换成 -，还是不行就叫 field，重名的加 -2、-3。
// 认不出的字段跳过，顺序同传入的顺序。服务端新建时没给字段对应就按它推，管理界面的预览也用它，两边才一致
export function defaultCredentialFields(refs: readonly string[]): CredentialField[] {
  const taken = new Set<string>()
  const names = new Map<string, string>()
  for (const ref of refs) {
    const fixed = STANDARD_FIELD_NAMES[ref]
    if (!fixed || names.has(ref)) continue
    const name = uniqueFieldName(fixed, taken)
    taken.add(name)
    names.set(ref, name)
  }
  for (const ref of refs) {
    if (names.has(ref) || !isVaultFieldRef(ref) || ref in STANDARD_FIELD_NAMES) continue
    const normalized = ref
      .slice(VAULT_CUSTOM_FIELD_PREFIX.length)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+/, '')
      .slice(0, 64)
    const base = CREDENTIAL_NAME_PATTERN.test(normalized) ? normalized : 'field'
    const name = uniqueFieldName(base, taken)
    taken.add(name)
    names.set(ref, name)
  }
  return refs.flatMap((ref) => {
    const name = names.get(ref)
    if (!name) return []
    names.delete(ref)
    return [{ name, itemField: ref }]
  })
}

const CredentialBase = z.object({
  id: z.uuid(),
  identifier: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  source: CredentialSource,
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

// 凭据的概况：标识、名称、说明、字段名与来源，不含值，也不含密码库的条目。
// 通过 Key 列出、新建、修改与取用时给的都是它。标识、名称、说明与字段名都是明文，不要把值写进这些地方
export const CredentialSummary = CredentialBase.extend({ fields: z.array(z.string()) })
export type CredentialSummary = z.infer<typeof CredentialSummary>

// 管理界面看到的：字段对应、指向的密码库条目、限定给哪些应用、删除时间与引用数
export const ConsoleCredential = CredentialBase.extend({
  fields: z.array(CredentialField),
  // 密码库来源指向的连接与条目；托管的为 null。条目的名称与取不取得到值看连接的条目列表
  vault: z.object({ connectionId: z.uuid(), itemId: z.string() }).nullable(),
  // 只给这些应用用；null 表示不限定
  appIds: z.array(z.uuid()).nullable(),
  deletedAt: z.string().nullable(),
  // 正文里引用这个标识的有效记忆数（不含 secret 的）；大于 0 时删不掉
  referenceCount: z.number().int(),
})
export type ConsoleCredential = z.infer<typeof ConsoleCredential>

export const ConsoleCredentialList = z.object({
  items: z.array(ConsoleCredential),
  // 太多时只给前面的一部分
  truncated: z.boolean(),
})
export type ConsoleCredentialList = z.infer<typeof ConsoleCredentialList>

// 已删除的凭据：过了保留期按删除时间永久清除，见 DeletionRetention
export const DeletedCredentialList = ConsoleCredentialList.extend({ retention: DeletionRetention })
export type DeletedCredentialList = z.infer<typeof DeletedCredentialList>

const CredentialName = z.string().trim().min(1, '名称不能为空').max(100, '名称最多 100 个字')
const CredentialDescription = z.string().max(2000, '说明最多 2000 个字').nullable()
const CredentialValue = z.string().min(1, '值不能为空').max(16_384, '一个值最多 16384 个字符')
const AppIds = z.array(z.uuid()).max(100, '最多限定 100 个应用').nullable()
// 密码库条目的 id（Bitwarden 与 Vaultwarden 都是 uuid）
export const VaultItemId = z
  .string()
  .regex(/^[0-9A-Za-z-]{1,64}$/, '条目 id 只能包含字母、数字与 -，最长 64 个字符')

const fieldCount = (values: Record<string, unknown>) =>
  Object.keys(values).length <= MAX_CREDENTIAL_FIELDS

const distinctNames = (fields: { name: string }[]) =>
  new Set(fields.map((f) => f.name)).size === fields.length

// 托管的值：字段名到值。新建凭据与空间的导入导出都按它检查
export const HostedCredentialValues = z
  .record(CredentialFieldName, CredentialValue)
  .refine((v) => Object.keys(v).length > 0, '至少需要一个字段')
  .refine(fieldCount, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)

// 修改托管的值：只给要改的字段，值为 null 表示删掉这个字段，没给的字段不变
export const HostedCredentialValuesUpdate = z
  .record(CredentialFieldName, CredentialValue.nullable())
  .refine(fieldCount, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)

// 密码库来源的字段对应：凭据里的字段名对应条目里的哪个字段
export const VaultCredentialFields = z
  .array(z.object({ name: CredentialFieldName, itemField: VaultFieldRef }))
  .min(1, '至少需要一个字段')
  .max(MAX_CREDENTIAL_FIELDS, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)
  .refine(distinctNames, '字段名不能重复')

export const HostedCredentialSource = z.object({
  kind: z.literal('hosted'),
  values: HostedCredentialValues,
})

// 给密码库的条目起标识：连接、条目与字段对应。不给字段对应时按条目里现有的字段推出（defaultCredentialFields）
export const VaultCredentialSource = z.object({
  kind: z.literal('vault'),
  connectionId: z.uuid(),
  itemId: VaultItemId,
  fields: VaultCredentialFields.optional(),
})

// 管理界面新建时的来源：托管的给出全部字段的值，密码库的给出连接、条目与（可选的）字段对应
export const CredentialSourceInput = z.discriminatedUnion('kind', [
  HostedCredentialSource,
  VaultCredentialSource,
])
export type CredentialSourceInput = z.infer<typeof CredentialSourceInput>

export const CreateCredentialRequest = z.object({
  identifier: CredentialIdentifier,
  name: CredentialName,
  description: CredentialDescription.optional(),
  source: CredentialSourceInput,
  // 只给哪些应用用，不填表示不限定。只能在管理界面设：通过 Key 新建的只给这个应用用
  appIds: AppIds.optional(),
})
export type CreateCredentialRequest = z.infer<typeof CreateCredentialRequest>

// 来源不能改：values 只给托管的，fields 只给密码库的，给错了返回 400。要换条目就删掉，再用同一个标识新建
export const UpdateCredentialRequest = z.object({
  // 界面上看到的版本号，期间被改过就返回 409
  expectedVersion: z.number().int(),
  name: CredentialName.optional(),
  description: CredentialDescription.optional(),
  values: HostedCredentialValuesUpdate.optional(),
  // 整个替换
  fields: VaultCredentialFields.optional(),
  // 只能在管理界面改：被诱导的 agent 不能给自己放宽
  appIds: AppIds.optional(),
})
export type UpdateCredentialRequest = z.infer<typeof UpdateCredentialRequest>

export const CONVERT_VALUE_MIN_LENGTH = 4

// 把记忆正文里的一段明文转存成一条 Kioku 托管的凭据：只给管理界面。expectedVersion 是看到这段值时的版本，
// 期间被改过就返回 409。正文里这段值出现几处换几处，历史快照里的也一起换掉，所以太短的不收：
// 只有几个字符时换掉的多半是别的内容
export const ConvertToCredentialRequest = z
  .object({
    memoryId: z.uuid(),
    expectedVersion: z.number().int(),
    value: CredentialValue.min(
      CONVERT_VALUE_MIN_LENGTH,
      `要转存的值至少 ${CONVERT_VALUE_MIN_LENGTH} 个字符，更短的值请手动新建凭据`,
    )
      .refine((v) => v === v.trim(), '要转存的值前后不能有空白')
      .refine((v) => !/\p{Cs}/u.test(v), '要转存的值含不完整的字符')
      .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_START), '要转存的值不能含凭据占位符'),
    identifier: CredentialIdentifier,
    name: CredentialName,
    description: CredentialDescription.optional(),
    field: CredentialFieldName,
  })
  // 标识、名称、说明与字段名都是明文，占位符里还带着标识和字段名：写进去就白转存了
  .refine(
    (r) => ![r.identifier, r.name, r.description ?? '', r.field].some((t) => t.includes(r.value)),
    { path: ['value'], message: '标识、名称、说明与字段名不能包含要转存的值' },
  )
export type ConvertToCredentialRequest = z.infer<typeof ConvertToCredentialRequest>

// 转存的结果，不含值
export const ConvertedToCredential = z.object({
  memory: ConsoleMemoryView,
  credential: ConsoleCredential,
  // 正文里换掉了几处
  replaced: z.number().int(),
  // 历史里改写了几个事件的快照
  scrubbedEvents: z.number().int(),
  // 历史里还有几个版本的正文疑似有别的明文（不含现在这一版）：只换掉了这一个值，换过的旧密码这类还留着
  plaintextVersions: z.number().int(),
  // 调用方有权看到的别的记忆（已删除、过期的也算）里还有几条含这个值：这次不动它们，要提示。
  // 比如 Dream 合并的来源被软删除了，撤销删除就回来。secret 的正文是密文，不数；占位符里的不算
  otherMemories: z.number().int(),
})
export type ConvertedToCredential = z.infer<typeof ConvertedToCredential>

// 通过 Key 新建：只收托管的值，只给这个应用用
export const KeyCreateCredentialRequest = z.object({
  identifier: CredentialIdentifier,
  name: CredentialName,
  description: CredentialDescription.optional(),
  values: HostedCredentialValues,
})
export type KeyCreateCredentialRequest = z.infer<typeof KeyCreateCredentialRequest>

// 通过 Key 修改：按标识找凭据，不能改字段对应与限定的应用；values 只对托管的凭据有效
export const KeyUpdateCredentialRequest = z.object({
  identifier: CredentialIdentifier,
  expectedVersion: z.number().int(),
  name: CredentialName.optional(),
  description: CredentialDescription.optional(),
  values: HostedCredentialValuesUpdate.optional(),
})
export type KeyUpdateCredentialRequest = z.infer<typeof KeyUpdateCredentialRequest>

// 取用时说明的用途，记进访问事件。只有空白的当作没给
export const CREDENTIAL_PURPOSE_MAX = 200
export const CredentialPurpose = z
  .string()
  .trim()
  .max(CREDENTIAL_PURPOSE_MAX, `用途最多 ${CREDENTIAL_PURPOSE_MAX} 个字`)
  .refine((v) => !CONTROL_CHARS.test(v), '用途不能包含换行等控制字符')
  .transform((v) => v || undefined)

export const CredentialIdentifierQuery = z.object({
  identifier: CredentialIdentifier,
  // 只取一个字段；不填时取全部字段
  field: CredentialFieldName.optional(),
  purpose: CredentialPurpose.optional(),
})

export const KeyDeleteCredentialQuery = z.object({
  identifier: CredentialIdentifier,
  expectedVersion: z.coerce.number().int().optional(),
})

// 引用一条凭据的记忆：凭据所有者本人的记忆里没删除、不是 secret、仍有效的
export const CredentialReference = z.object({
  id: z.uuid(),
  uri: z.string(),
  title: z.string(),
  sensitivity: Sensitivity,
  updatedAt: z.string(),
})
export type CredentialReference = z.infer<typeof CredentialReference>

export const CredentialReferenceList = z.object({
  items: z.array(CredentialReference),
  truncated: z.boolean(),
})
export type CredentialReferenceList = z.infer<typeof CredentialReferenceList>

// 管理界面查看值：托管的与密码库的都给，totp 给现算的验证码；记一条访问事件
export const CredentialValues = z.object({ values: z.record(z.string(), z.string()) })
export type CredentialValues = z.infer<typeof CredentialValues>

// 通过 Key 取用一条凭据：概况、值与提醒。totp 给的是现算的验证码，不是条目里的密钥。
// 测试台里取用一律不给值，values 为 null；真实的调用总有值，取不到时返回错误
export const CredentialAccess = z.object({
  credential: CredentialSummary,
  values: z.record(z.string(), z.string()).nullable(),
  notice: z.string(),
})
export type CredentialAccess = z.infer<typeof CredentialAccess>

export const KeyCredentialList = z.object({
  items: z.array(CredentialSummary),
  truncated: z.boolean(),
})
export type KeyCredentialList = z.infer<typeof KeyCredentialList>

// 取用的结果：交出了值；凭据存在、取用却被拒；向密码库取值失败
export const CREDENTIAL_ACCESS_RESULTS = ['ok', 'denied', 'failed'] as const
export const CredentialAccessResult = z.enum(CREDENTIAL_ACCESS_RESULTS)
export type CredentialAccessResult = z.infer<typeof CredentialAccessResult>

// 被拒与失败的原因。被拒：capability 凭据能力不够；scope 访问密钥读不到本人的私密记忆；
// context 会话上下文不允许；app 限定给了别的应用。失败：item_unavailable 条目不可用（被删、移出集合）；
// field_missing 条目里没有这个字段；reauth_required 需要重新登录；disabled 连接已停用；disconnected 连接已断开；
// unreachable 密码库无法连接；vault_error 密码库返回的内容认不出或校验不过；master_key 主密钥不可用
export const CREDENTIAL_ACCESS_REASONS = [
  'capability',
  'scope',
  'context',
  'app',
  'item_unavailable',
  'field_missing',
  'reauth_required',
  'disabled',
  'disconnected',
  'unreachable',
  'vault_error',
  'master_key',
] as const
export const CredentialAccessReason = z.enum(CREDENTIAL_ACCESS_REASONS)
export type CredentialAccessReason = z.infer<typeof CredentialAccessReason>

// 事件类型：create、update、delete、undelete、access（交出值、被拒或失败，包括管理界面查看与随空间导出）
export const CredentialEvent = z.object({
  id: z.number().int(),
  type: z.string(),
  createdAt: z.string(),
  actor: EventActor,
  // 取用经由哪里：kioku_credential、rest、run、console、space_export；其他事件为 null
  via: z.string().nullable(),
  // 取用了哪些字段
  fields: z.array(z.string()),
  // 取用时说明的用途；没给的与其他事件为 null
  purpose: z.string().nullable(),
  // 取用的结果与原因：交出了值时 reason 为 null；其他事件两个都为 null
  result: CredentialAccessResult.nullable(),
  reason: CredentialAccessReason.nullable(),
  // 通过 Key 取用时的会话上下文（chatType，不带会话上下文的为 none）；管理界面里的与其他事件为 null
  chatType: z.string().nullable(),
  // 修改了哪些部分：name、description、values、fields、appIds
  changes: z.array(z.string()),
  // 测试台写下的：真实客户端写的为 null
  bench: BenchMark.nullable(),
})
export type CredentialEvent = z.infer<typeof CredentialEvent>

export const CredentialEventList = z.object({
  items: z.array(CredentialEvent),
  nextCursor: z.string().nullable(),
})
export type CredentialEventList = z.infer<typeof CredentialEventList>

// ---- 密码库连接 ----

// 连接的状态：ok 可用；reauth_required 刷新令牌失效（改了主密码、在设备列表里注销了 Kioku），要重新登录；
// disabled 出现了个人条目，或组织角色是所有者、管理员，清掉之后恢复；disconnected 成员断开了，令牌与密钥已清掉。
// 连不上服务器不单独算一种：状态不变，记进 lastError，之后成功一次就清掉
export const VAULT_CONNECTION_STATUSES = [
  'ok',
  'reauth_required',
  'disabled',
  'disconnected',
] as const
export const VaultConnectionStatus = z.enum(VAULT_CONNECTION_STATUSES)
export type VaultConnectionStatus = z.infer<typeof VaultConnectionStatus>

// 停用的原因：账号里有不属于组织的条目；在某个组织里可访问全部集合（所有者、管理员，或开了「访问全部集合」的成员）
export const VAULT_DISABLED_REASONS = ['personal_items', 'organization_role'] as const
export const VaultDisabledReason = z.enum(VAULT_DISABLED_REASONS)
export type VaultDisabledReason = z.infer<typeof VaultDisabledReason>

// 和服务端 credential/bitwarden/types.ts 的 VaultErrorKind 一一对应
export const VAULT_ERROR_KINDS = [
  'invalid_credentials',
  'two_factor_invalid',
  'unsupported_two_factor',
  'reauth_required',
  'item_unavailable',
  'unsupported_format',
  'integrity',
  'unreachable',
  'server_error',
] as const
export const VaultErrorKind = z.enum(VAULT_ERROR_KINDS)
export type VaultErrorKind = z.infer<typeof VaultErrorKind>

// 两步验证只支持验证器应用：邮件验证码要另外请求发送，几种方式并存时服务端不会自动发
export const VAULT_TWO_FACTOR_PROVIDERS = ['authenticator'] as const
export const VaultTwoFactorProvider = z.enum(VAULT_TWO_FACTOR_PROVIDERS)
export type VaultTwoFactorProvider = z.infer<typeof VaultTwoFactorProvider>

export const VAULT_ITEM_TYPES = ['login', 'note', 'card', 'identity', 'ssh_key'] as const
export const VaultItemType = z.enum(VAULT_ITEM_TYPES)
export type VaultItemType = z.infer<typeof VaultItemType>

// 管理界面看到的连接：只给连接的所有者
export const VaultConnection = z.object({
  id: z.uuid(),
  serverUrl: z.string(),
  email: z.string(),
  status: VaultConnectionStatus,
  // status 为 disabled 时的原因，否则为 null
  disabledReason: VaultDisabledReason.nullable(),
  // 最近一次和服务器通信失败的原因与时间；之后成功一次就清掉
  lastError: z.object({ kind: VaultErrorKind, at: z.string() }).nullable(),
  // 最近一次成功同步的时间
  lastCheckedAt: z.string().nullable(),
  disconnectedAt: z.string().nullable(),
  // 指着它的有效凭据数
  credentialCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type VaultConnection = z.infer<typeof VaultConnection>

export const VaultConnectionList = z.object({ items: z.array(VaultConnection) })
export type VaultConnectionList = z.infer<typeof VaultConnectionList>

// 服务器地址：https:// 都收；http:// 只收本机回环地址（localhost、127.0.0.1、[::1]）与不带点的主机名
// （例如 Docker Compose 的服务名 vaultwarden，流量不出 Docker 网络）。不带账号、查询参数与 #，末尾的 / 去掉。
// 主密码与令牌都发到这里，所以别的地址不收明文的 http。
// 契约不依赖 URL（浏览器与 Node 之外也要能用），按写法判断，服务端请求之前再用 URL 解析一次
const SERVER_URL = /^https:\/\/[^\s/?#@\\]+(?:\/[^\s?#\\]*)?$/i
const LOCAL_HTTP_URL =
  /^http:\/\/(?:[a-z0-9-]+|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s?#\\]*)?$/i
export const VaultServerUrl = z
  .string()
  .trim()
  .max(500, '服务器地址最多 500 个字符')
  .refine(
    (v) => SERVER_URL.test(v) || LOCAL_HTTP_URL.test(v),
    '服务器地址要以 https:// 开头（本机地址与不带点的主机名可以用 http://），不带账号、查询参数与 #',
  )
  .transform((v) => v.replace(/\/+$/, ''))

// 密码库账号的邮箱：连接、重新登录与空间导入都按它检查
export const VaultEmail = z
  .string()
  .trim()
  .max(320, '邮箱最多 320 个字符')
  .refine((v) => /^[^\s@]+@[^\s@]+$/.test(v), '邮箱格式不正确')
// 主密码只用来登录这一次，不保存
const MasterPassword = z.string().min(1, '主密码不能为空').max(1024, '主密码最多 1024 个字符')
const VaultTwoFactor = z.object({
  provider: VaultTwoFactorProvider,
  code: z.string().trim().min(1, '验证码不能为空').max(64, '验证码最多 64 个字符'),
})

export const ConnectVaultRequest = z.object({
  serverUrl: VaultServerUrl,
  email: VaultEmail,
  masterPassword: MasterPassword,
  // 第一次不带；服务器要两步验证时，结果给出可用的方式，再带上验证码重新提交
  twoFactor: VaultTwoFactor.optional(),
})
export type ConnectVaultRequest = z.infer<typeof ConnectVaultRequest>

// 重新登录：服务器地址与账号不变，登录到别的账号时拒绝。邮箱在密码库里改过时给新的邮箱
export const ReconnectVaultRequest = z.object({
  email: VaultEmail.optional(),
  masterPassword: MasterPassword,
  twoFactor: VaultTwoFactor.optional(),
})
export type ReconnectVaultRequest = z.infer<typeof ReconnectVaultRequest>

// 连接与重新登录的结果：连上了给出连接；要两步验证时给出可用的方式（只列支持的）
export const VaultConnectResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connected'), connection: VaultConnection }),
  z.object({
    kind: z.literal('two_factor_required'),
    providers: z.array(VaultTwoFactorProvider),
  }),
])
export type VaultConnectResult = z.infer<typeof VaultConnectResult>

// 连接读得到的一个条目：名称与字段名，不含值。credential 是给它起了标识的有效凭据，没起的为 null
export const VaultItemSummary = z.object({
  id: z.string(),
  organizationId: z.string(),
  collectionIds: z.array(z.string()),
  name: z.string(),
  type: VaultItemType,
  // 有值的字段，写法同 VaultFieldRef
  fields: z.array(z.string()),
  revisionDate: z.string(),
  credential: z.object({ id: z.uuid(), identifier: z.string() }).nullable(),
})
export type VaultItemSummary = z.infer<typeof VaultItemSummary>

// 条目列表，连同条目所在的集合与组织；回收站里的不算
export const VaultItemList = z.object({
  items: z.array(VaultItemSummary),
  // 组织里解不开的条目数（格式不认识或校验不过），这些不在 items 里
  unreadableCount: z.number().int(),
  collections: z.array(z.object({ id: z.string(), organizationId: z.string(), name: z.string() })),
  organizations: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type VaultItemList = z.infer<typeof VaultItemList>
