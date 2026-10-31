import { z } from 'zod'

import { BenchMark, DeletionRetention, EventActor } from './console'
import { ConsoleMemoryView } from './memories'
import { Sensitivity } from './memory'

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

// 凭据源的类型。Bitwarden 兼容的自建服务端也选 bitwarden
export const CREDENTIAL_PROVIDER_KINDS = ['bitwarden', '1password', 'env', 'other'] as const
export const CredentialProviderKind = z.enum(CREDENTIAL_PROVIDER_KINDS)
export type CredentialProviderKind = z.infer<typeof CredentialProviderKind>

// 凭据的来源：hosted 是值由 Kioku 加密保存；external 是值在外部凭据源里，Kioku 只存条目位置
export const CREDENTIAL_SOURCES = ['hosted', 'external'] as const
export const CredentialSource = z.enum(CREDENTIAL_SOURCES)
export type CredentialSource = z.infer<typeof CredentialSource>

// 字段：占位符里用的名字，外部来源再加上条目里对应的字段（例如 password，或自定义字段的名字）
export const CredentialField = z.object({
  name: CredentialFieldName,
  // 托管的为 null
  sourceField: z.string().nullable(),
})
export type CredentialField = z.infer<typeof CredentialField>

export const CredentialProviderSummary = z.object({
  id: z.uuid(),
  kind: CredentialProviderKind,
  name: z.string(),
  // 凭据源已经删除：绑定它的凭据要重新绑定才取得到值
  deleted: z.boolean(),
})
export type CredentialProviderSummary = z.infer<typeof CredentialProviderSummary>

const CredentialBase = z.object({
  id: z.uuid(),
  identifier: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  source: CredentialSource,
  provider: CredentialProviderSummary.nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

// 凭据的说明与绑定，不含值。标识、名称、说明、字段名与条目位置都是明文，不要把值写进这些地方
export const CredentialInfo = CredentialBase.extend({
  // 外部来源的条目位置（条目名、id 或路径）；托管的为 null
  location: z.string().nullable(),
  fields: z.array(CredentialField),
})
export type CredentialInfo = z.infer<typeof CredentialInfo>

// 通过 Key 列出、新建与修改时给的：不含外部条目的位置与字段对应。绑定只在取用时给，并记一条访问事件
export const CredentialSummary = CredentialBase.extend({ fields: z.array(z.string()) })
export type CredentialSummary = z.infer<typeof CredentialSummary>

// 管理界面看到的：再加上限定给哪些应用、删除时间与引用数
export const ConsoleCredential = CredentialInfo.extend({
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
// 条目位置与来源字段会代入取值命令，服务端给出的命令里它们都放在单引号里。值里不能有单引号
// （包括 PowerShell 也当作引号的弯引号）：这样单引号包起来在 bash、zsh 与 PowerShell 里都是字面量。
// 再挡掉放在引号外也能拼出新命令的字符（; | & < > ` $ \ " %）、换行、看不见的字符
// （双向控制符、零宽字符、变体选择符等），以及开头的 -（会被当成选项）。
// 否则改得了绑定的 Key 能借取值命令或凭据源的使用说明，给别的 agent 塞进一条命令
const BINDING_UNSAFE =
  /[;|&<>`$\\"'%\u2018-\u201f]|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
const shellSafe = (v: string) => !BINDING_UNSAFE.test(v) && !v.startsWith('-')
const SHELL_SAFE_MESSAGE =
  '不能包含引号、; | & < > ` $ \\ % 与换行等不可见字符，也不能以 - 开头；条目名含这些字符时，请改用条目 id'
const Location = z
  .string()
  .trim()
  .min(1, '条目位置不能为空')
  .max(500, '条目位置最多 500 个字')
  .refine(shellSafe, `条目位置${SHELL_SAFE_MESSAGE}`)
const SourceField = z
  .string()
  .trim()
  .min(1, '来源字段不能为空')
  .max(200, '来源字段最多 200 个字')
  .refine(shellSafe, `来源字段${SHELL_SAFE_MESSAGE}`)
const AppIds = z.array(z.uuid()).max(100, '最多限定 100 个应用').nullable()

const fieldCount = (values: Record<string, unknown>) =>
  Object.keys(values).length <= MAX_CREDENTIAL_FIELDS

const distinctNames = (fields: { name: string }[]) =>
  new Set(fields.map((f) => f.name)).size === fields.length

// 外部来源：凭据源、条目位置与字段对应。新建、修改凭据与空间的导入导出都按它检查
export const ExternalCredentialSource = z.object({
  kind: z.literal('external'),
  providerId: z.uuid(),
  location: Location,
  fields: z
    .array(z.object({ name: CredentialFieldName, sourceField: SourceField }))
    .min(1, '至少需要一个字段')
    .max(MAX_CREDENTIAL_FIELDS, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)
    .refine(distinctNames, '字段名不能重复'),
})

// 托管的来源：全部字段的值。新建凭据与空间的导入导出都按它检查
export const HostedCredentialSource = z.object({
  kind: z.literal('hosted'),
  values: z
    .record(CredentialFieldName, CredentialValue)
    .refine((v) => Object.keys(v).length > 0, '至少需要一个字段')
    .refine(fieldCount, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`),
})

// 新建时的来源：托管的给出全部字段的值，外部的给出凭据源、条目位置与字段对应
export const CredentialSourceInput = z.discriminatedUnion('kind', [
  HostedCredentialSource,
  ExternalCredentialSource,
])
export type CredentialSourceInput = z.infer<typeof CredentialSourceInput>

// 修改时的来源：托管的只给要改的字段，值为 null 表示删掉这个字段，没给的字段不变；
// 从外部来源改成托管时，给出的就是全部字段。外部的整个替换
export const CredentialSourceUpdate = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hosted'),
    values: z
      .record(CredentialFieldName, CredentialValue.nullable())
      .refine(fieldCount, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`),
  }),
  ExternalCredentialSource,
])
export type CredentialSourceUpdate = z.infer<typeof CredentialSourceUpdate>

export const CreateCredentialRequest = z.object({
  identifier: CredentialIdentifier,
  name: CredentialName,
  description: CredentialDescription.optional(),
  source: CredentialSourceInput,
  // 只给哪些应用用，不填表示不限定。只能在管理界面设：通过 Key 新建的只给这个应用用
  appIds: AppIds.optional(),
})
export type CreateCredentialRequest = z.infer<typeof CreateCredentialRequest>

export const UpdateCredentialRequest = z.object({
  // 界面上看到的版本号，期间被改过就返回 409
  expectedVersion: z.number().int(),
  name: CredentialName.optional(),
  description: CredentialDescription.optional(),
  source: CredentialSourceUpdate.optional(),
  // 只能在管理界面改：被诱导的 agent 不能给自己放宽
  appIds: AppIds.optional(),
})
export type UpdateCredentialRequest = z.infer<typeof UpdateCredentialRequest>

// 把记忆正文里的一段明文转存成一条 Kioku 托管的凭据：只给管理界面。expectedVersion 是看到这段值时的版本，
// 期间被改过就返回 409。正文里这段值出现几处换几处，历史快照里的也一起换掉，所以太短的不收：
// 只有几个字符时换掉的多半是别的内容
export const ConvertToCredentialRequest = z
  .object({
    memoryId: z.uuid(),
    expectedVersion: z.number().int(),
    value: CredentialValue.min(4, '要转存的值至少 4 个字符，更短的值请手动新建凭据')
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

// 通过 Key 新建、修改：按标识找凭据，不能设限定的应用
export const KeyCreateCredentialRequest = CreateCredentialRequest.omit({ appIds: true })
export type KeyCreateCredentialRequest = z.infer<typeof KeyCreateCredentialRequest>

export const KeyUpdateCredentialRequest = UpdateCredentialRequest.omit({ appIds: true }).extend({
  identifier: CredentialIdentifier,
})
export type KeyUpdateCredentialRequest = z.infer<typeof KeyUpdateCredentialRequest>

export const CredentialIdentifierQuery = z.object({
  identifier: CredentialIdentifier,
  // 只取一个字段；不填时取全部字段
  field: CredentialFieldName.optional(),
})

export const KeyDeleteCredentialQuery = z.object({
  identifier: CredentialIdentifier,
  expectedVersion: z.coerce.number().int().optional(),
})

// 引用一条凭据的记忆：凭据主人私人层里没删除、不是 secret、仍有效的
export const CredentialReference = z.object({
  id: z.uuid(),
  uri: z.string(),
  sensitivity: Sensitivity,
  updatedAt: z.string(),
})
export type CredentialReference = z.infer<typeof CredentialReference>

export const CredentialReferenceList = z.object({
  items: z.array(CredentialReference),
  truncated: z.boolean(),
})
export type CredentialReferenceList = z.infer<typeof CredentialReferenceList>

// 管理界面查看托管的值（记一条访问事件）
export const CredentialValues = z.object({ values: z.record(z.string(), z.string()) })
export type CredentialValues = z.infer<typeof CredentialValues>

// 通过 Key 取用一条凭据：托管的给值，外部的给凭据源与条目位置，都带上取法与提醒
export const CredentialAccess = z.object({
  credential: CredentialInfo,
  // 托管的值；Key 不是 secret 级、或者是外部来源时为 null
  values: z.record(z.string(), z.string()).nullable(),
  // 外部来源的凭据源：类型、名字与主人写的使用说明
  provider: z
    .object({ kind: CredentialProviderKind, name: z.string(), instructions: z.string() })
    .nullable(),
  // 怎么取到值：按来源与凭据源类型给出的通用说明
  method: z.string(),
  notice: z.string(),
})
export type CredentialAccess = z.infer<typeof CredentialAccess>

export const KeyCredentialList = z.object({
  items: z.array(CredentialSummary),
  // 新建外部来源的凭据时要用凭据源的 id
  providers: z.array(CredentialProviderSummary),
  truncated: z.boolean(),
})
export type KeyCredentialList = z.infer<typeof KeyCredentialList>

// 事件类型：create、update、delete、undelete、access（取用，包括查外部绑定与管理界面查看）
export const CredentialEvent = z.object({
  id: z.number().int(),
  type: z.string(),
  createdAt: z.string(),
  actor: EventActor,
  // 取用经由哪里：kioku_credential、rest、console 等；其他事件为 null
  via: z.string().nullable(),
  // 取用了哪些字段
  fields: z.array(z.string()),
  // 修改了哪些部分：name、description、source、location、fields、values、appIds
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

// 凭据源：只在管理界面配置。使用说明会下发给 agent，写在哪台机器上、用什么工具取值，不写主密码、会话令牌这类东西本身
export const CredentialProvider = z.object({
  id: z.uuid(),
  kind: CredentialProviderKind,
  name: z.string(),
  instructions: z.string(),
  // 绑定它的有效凭据数
  credentialCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CredentialProvider = z.infer<typeof CredentialProvider>

// 已删除的凭据源：不能恢复，绑定过它的凭据恢复之后要改绑。过了保留期、也没有凭据（含已删除的）指着它时永久清除
export const DeletedCredentialProvider = z.object({
  id: z.uuid(),
  kind: CredentialProviderKind,
  name: z.string(),
  deletedAt: z.string(),
  // 保留期从什么时候算起：清理先删到期的凭据、再删没有凭据指着的凭据源，所以是自己的删除时间与
  // 指着它的已删除凭据里最晚的删除时间，取晚的。还有没删除的凭据指着它时为 null，改绑或删掉那些凭据之前不会清除
  retentionFrom: z.string().nullable(),
})
export type DeletedCredentialProvider = z.infer<typeof DeletedCredentialProvider>

export const DeletedCredentialProviderList = z.object({
  items: z.array(DeletedCredentialProvider),
  // 太多时只给前面的一部分
  truncated: z.boolean(),
  retention: DeletionRetention,
})
export type DeletedCredentialProviderList = z.infer<typeof DeletedCredentialProviderList>

const ProviderInstructions = z.string().max(4000, '使用说明最多 4000 个字')

export const CreateCredentialProviderRequest = z.object({
  kind: CredentialProviderKind,
  name: CredentialName,
  instructions: ProviderInstructions.default(''),
})
export type CreateCredentialProviderRequest = z.infer<typeof CreateCredentialProviderRequest>

export const UpdateCredentialProviderRequest = z.object({
  kind: CredentialProviderKind.optional(),
  name: CredentialName.optional(),
  instructions: ProviderInstructions.optional(),
})
export type UpdateCredentialProviderRequest = z.infer<typeof UpdateCredentialProviderRequest>
