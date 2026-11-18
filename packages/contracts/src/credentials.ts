import { z } from 'zod'

import { ALLOWED_REALMS_MAX, Slug } from './auth'
import { BenchMark, DeletionRetention, EventActor, PageQuery } from './console'
import { ConsoleEntryView } from './entries'
import { FacetTermSlug } from './facets'
import { ShortId } from './links'
import { CircleKind, EntryKind, SENSITIVITIES, Sensitivity } from './memory'
import {
  addedSensitiveContent,
  CREDENTIAL_KINDS,
  CredentialKind,
  scanSensitiveContent,
  type SensitiveScanOptions,
} from './sensitive'

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

export const MAX_CREDENTIAL_FIELDS = 32

export const CREDENTIAL_PLACEHOLDER_START = '{{cred:'
export const CREDENTIAL_PLACEHOLDER =
  /\{\{cred:([a-z0-9][a-z0-9_-]{0,63})(?:#([a-z0-9][a-z0-9_-]{0,63}))?\}\}/

// 凭据占位符仅允许写在对应凭据所有者的个人圈、正式词条且敏感级不低于私密的正文切片中
export function placeholderAllowed(
  circleKind: CircleKind,
  kind: EntryKind,
  sensitivity: Sensitivity,
): boolean {
  return (
    circleKind === 'personal' &&
    kind === 'entry' &&
    SENSITIVITIES.indexOf(sensitivity) >= SENSITIVITIES.indexOf('private')
  )
}

export const CONVERT_SCOPE_TEXT =
  '凭据占位符只能放在个人圈、正式词条且敏感级不低于私密的记忆中。请先移入个人圈或调高敏感级，再转存。'

const SPACE =
  ' \\t\\n\\v\\f\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'

const PLAINTEXT_LABELS =
  'password|passwd|passphrase|密码|口令|token|api[_ -]?key|secret[_ -]?(?:access[_ -]?)?key|secret'
export const PLAINTEXT_QUOTES = '"\'`“‘「『*'
const VALUE_STOPS = '，。；、！？）】」』》”’'
const CJK = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff'
const QUOTED_KEY_CLOSER = `(?:(?<=["'\`][A-Za-z0-9_${CJK}-]{0,40})["'\`])?`
const CJK_LEADS = `${PLAINTEXT_QUOTES}（【《\\(\\[`
export const PLAINTEXT_MASK = '***'
const VALUE_ENDS_HERE =
  `(?:[,.;:]*(?:[${SPACE}]|$)|[${VALUE_STOPS}]` +
  `|["'\`](?=[${SPACE}${VALUE_STOPS},.;:\\)\\]}>]|$)` +
  `|\\*\\*(?![^${SPACE}${VALUE_STOPS},.;:]))`
const WHOLE_MASK = `(?:\\*{3,}|x{3,}|\\.{3,}|…{3,})${VALUE_ENDS_HERE}`
const TYPE_WORDS =
  '(?:string|str|number|int|integer|float|bool|boolean|bytes|null|none|nil|undefined|void|any|unknown|object' +
  '|optional|secretstr|list|dict|map|record|array|set|promise|partial|readonly|tuple|sequence|mapping|iterable)'
const TYPE_ARGS = (inner: string) => `[\\[<]${inner}(?:[ ,|]{1,3}${inner}){0,4}[\\]>]`
const TYPE_ARG = `${TYPE_WORDS}(?:${TYPE_ARGS(TYPE_WORDS)})?`
const TYPE_NAMES =
  TYPE_WORDS + `(?:\\[\\]|${TYPE_ARGS(TYPE_ARG)})?` + `[\\)\\]}>,;]{0,8}${VALUE_ENDS_HERE}`
const IN_LINE = (max: number, closer: string) => `[^${closer}\\n\\r\\u2028\\u2029]{1,${max}}`
const VARIABLE_NAME = '[A-Za-z_][A-Za-z0-9_]{0,127}'
const QUOTED_NAME = `(?:"[A-Za-z_][A-Za-z0-9_.-]{0,127}"|'[A-Za-z_][A-Za-z0-9_.-]{0,127}')`
const COMMAND_PART = `[^\\(\\)"'\`\\n\\r\\u2028\\u2029]{0,64}`
const VARIABLE_REFS =
  `(?:\\$${VARIABLE_NAME}` +
  `|\\$\\{${VARIABLE_NAME}\\}` +
  `|\\$\\(${COMMAND_PART}/${COMMAND_PART}\\)` +
  `|%${VARIABLE_NAME}%` +
  `|process\\.env\\.${VARIABLE_NAME}` +
  `|(?:process\\.env|os\\.environ)\\[${QUOTED_NAME}\\]` +
  `|(?:os\\.getenv|getenv|env)\\(${QUOTED_NAME}\\)` +
  `)[\\)\\]},;]{0,8}${VALUE_ENDS_HERE}`
const ANGLE_PLACEHOLDER = `<${IN_LINE(64, '<>')}>${VALUE_ENDS_HERE}`
const TEMPLATE_EXPRESSION = `\\$?\\{\\{[A-Za-z0-9_. |]{1,128}\\}\\}${VALUE_ENDS_HERE}`
const ONE_PLACEHOLDER = CREDENTIAL_PLACEHOLDER.source.replace(/\((?!\?)/g, '(?:')
const PLACEHOLDER_RUN = `${ONE_PLACEHOLDER}(?:[:@/,;=&|-]{0,3}${ONE_PLACEHOLDER}){0,8}`
const PLACEHOLDER_VALUE =
  `\\*{0,3}[${SPACE}]*${PLACEHOLDER_RUN}${VALUE_ENDS_HERE}` +
  `|["'\`“‘「『][${SPACE}]*${PLACEHOLDER_RUN}[${SPACE}]*["'\`”’」』]`
const NOT_A_VALUE =
  `${WHOLE_MASK}|${TYPE_NAMES}|${VARIABLE_REFS}|${ANGLE_PLACEHOLDER}|${TEMPLATE_EXPRESSION}` +
  `|(?:"[${SPACE}]*"|'[${SPACE}]*')${VALUE_ENDS_HERE}`

export const PLAINTEXT_KINDS = CREDENTIAL_KINDS
export const PlaintextKind = CredentialKind
export type PlaintextKind = CredentialKind
type TokenKind = 'sk' | 'github' | 'gitlab' | 'slack' | 'aws' | 'jwt' | 'private_key' | 'kioku'

const EMPHASIS_AFTER_COLON = `(?:(?:\\*\\*|__|\\*)(?=[${SPACE}]))?`
const EMPHASIS_BEFORE_COLON = '(?:\\*\\*|__|\\*|_)?'
const LABEL_RULE =
  `(?:${PLAINTEXT_LABELS})${QUOTED_KEY_CLOSER}${EMPHASIS_BEFORE_COLON}[${SPACE}]*[:：=]` +
  `${EMPHASIS_AFTER_COLON}[${SPACE}]*(?!(?:\\*\\*|__|\\*)[${SPACE}])` +
  `(?!${PLACEHOLDER_VALUE})(?![${PLAINTEXT_QUOTES}]*(?:${NOT_A_VALUE}))(?![${CJK_LEADS}]*[${CJK}])[^${SPACE}]`

const TOKEN_START = '(?<![A-Za-z0-9_-])'
const TOKEN_END = '(?![A-Za-z0-9_-])'
const TOKEN_RULES: Record<TokenKind, string> = {
  sk:
    `${TOKEN_START}(?:sk-(?:[A-Za-z0-9]+[-_]){0,8}[A-Za-z0-9]{16,}` +
    `|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})`,
  github: `${TOKEN_START}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})`,
  gitlab: `${TOKEN_START}glpat-[A-Za-z0-9_-]{20,}`,
  slack: `${TOKEN_START}xox[baprs]-[A-Za-z0-9-]{20,}`,
  aws: `${TOKEN_START}AKIA[A-Z0-9]{16}${TOKEN_END}`,
  jwt: `${TOKEN_START}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`,
  private_key: `-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[${SPACE}]*[A-Za-z0-9+/=]{16,}`,
  kioku: `${TOKEN_START}kioku_[A-Za-z0-9]{12}_[A-Za-z0-9]{40}${TOKEN_END}`,
}
const TOKEN_KINDS = Object.keys(TOKEN_RULES) as TokenKind[]

export const PLAINTEXT_CREDENTIAL_PARTS: readonly string[] = [
  LABEL_RULE,
  TOKEN_KINDS.map((kind) => TOKEN_RULES[kind]).join('|'),
]
export const PLAINTEXT_CREDENTIAL = new RegExp(PLAINTEXT_CREDENTIAL_PARTS.join('|'), 'i')

export interface PlaintextCredentialMatch {
  start: number
  end: number
  line: number
  kind: PlaintextKind
  field: string
}

export function findPlaintextCredentials(
  text: string,
  options: { overlapping?: boolean } & Pick<SensitiveScanOptions, 'customRules' | 'allowlist'> = {},
): PlaintextCredentialMatch[] {
  return scanSensitiveContent(text, {
    credentials: true,
    pii: false,
    ...(options.overlapping ? { overlapping: true } : {}),
    ...(options.customRules ? { customRules: options.customRules } : {}),
    ...(options.allowlist ? { allowlist: options.allowlist } : {}),
  }).map((m) => ({
    start: m.start,
    end: m.end,
    line: m.line,
    kind: m.kind as PlaintextKind,
    field: m.field,
  }))
}

export function addedPlaintextCredentials(
  before: string | null,
  after: string,
  options: Pick<SensitiveScanOptions, 'customRules' | 'allowlist'> = {},
): PlaintextCredentialMatch[] {
  return addedSensitiveContent(before, after, {
    credentials: true,
    pii: false,
    ...(options.customRules ? { customRules: options.customRules } : {}),
    ...(options.allowlist ? { allowlist: options.allowlist } : {}),
  }).map((m) => ({
    start: m.start,
    end: m.end,
    line: m.line,
    kind: m.kind as PlaintextKind,
    field: m.field,
  }))
}

export const PlaintextFinding = z
  .object({ line: z.number().int(), kind: PlaintextKind })
  .meta({ id: 'PlaintextFinding' })
export type PlaintextFinding = z.infer<typeof PlaintextFinding>

export const EntryWriteError = z
  .object({ error: z.string(), plaintext: z.array(PlaintextFinding).optional() })
  .meta({ id: 'EntryWriteError' })
export type EntryWriteError = z.infer<typeof EntryWriteError>

export const CREDENTIAL_SOURCES = ['hosted', 'vault'] as const
export const CredentialSource = z.enum(CREDENTIAL_SOURCES)
export type CredentialSource = z.infer<typeof CredentialSource>

export const VAULT_STANDARD_FIELDS = [
  'login.username',
  'login.password',
  'login.totp',
  'notes',
] as const
export const VAULT_CUSTOM_FIELD_PREFIX = 'field:'
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

export const CREDENTIAL_EXPIRING_DAYS = 7

export const CREDENTIAL_EXPIRY_STATES = ['expiring', 'expired'] as const
export const CredentialExpiry = z.enum(CREDENTIAL_EXPIRY_STATES)
export type CredentialExpiry = z.infer<typeof CredentialExpiry>

export const CredentialExpiresAt = z.iso
  .datetime({ offset: true, message: '到期时间格式不正确' })
  .refine((v) => {
    const year = new Date(v).getUTCFullYear()
    return year >= 2000 && year <= 9999
  }, '到期时间超出范围')
  .nullable()

export const CREDENTIAL_URL_MAX = 2000
export const CredentialUrl = z
  .string()
  .trim()
  .max(CREDENTIAL_URL_MAX, `网址最多 ${CREDENTIAL_URL_MAX} 个字符`)
  .refine((v) => /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(v), '网址要以 http:// 或 https:// 开头')
  .refine((v) => !CONTROL_CHARS.test(v), '网址不能包含控制字符')

export const VAULT_LOGIN_FIELD_NAMES = {
  username: 'login.username',
  password: 'login.password',
} as const

export const CredentialStoredIn = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hosted'), bench: z.boolean() }),
  z.object({ kind: z.literal('vault'), collectionName: z.string() }),
])
export type CredentialStoredIn = z.infer<typeof CredentialStoredIn>

const CredentialBase = z.object({
  id: z.uuid(),
  identifier: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  source: CredentialSource,
  version: z.number().int(),
  expiresAt: z.string().nullable(),
  expiry: CredentialExpiry.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const CredentialSummary = CredentialBase.extend({ fields: z.array(z.string()) })
export type CredentialSummary = z.infer<typeof CredentialSummary>

export const ConsoleCredential = CredentialBase.extend({
  fields: z.array(CredentialField),
  vault: z.object({ connectionId: z.uuid(), itemId: z.string() }).nullable(),
  clientIds: z.array(z.uuid()).nullable(),
  allowedRealms: z.array(z.string()).nullable(),
  deletedAt: z.string().nullable(),
  referenceCount: z.number().int(),
  rotationRequestedAt: z.string().nullable(),
  valueChangedAt: z.string().nullable(),
})
export type ConsoleCredential = z.infer<typeof ConsoleCredential>

export const CreatedCredential = ConsoleCredential.extend({ storedIn: CredentialStoredIn })
export type CreatedCredential = z.infer<typeof CreatedCredential>

export const ConsoleCredentialList = z.object({
  items: z.array(ConsoleCredential),
  truncated: z.boolean(),
})
export type ConsoleCredentialList = z.infer<typeof ConsoleCredentialList>

export const CredentialListQuery = z.object({
  attention: z.enum(['true']).optional(),
})
export type CredentialListQuery = z.infer<typeof CredentialListQuery>

export const DeletedCredentialList = ConsoleCredentialList.extend({ retention: DeletionRetention })
export type DeletedCredentialList = z.infer<typeof DeletedCredentialList>

const CredentialName = z.string().trim().min(1, '名称不能为空').max(100, '名称最多 100 个字')
const CredentialDescription = z.string().max(2000, '说明最多 2000 个字').nullable()
const CredentialValue = z.string().min(1, '值不能为空').max(16_384, '一个值最多 16384 个字符')
const ClientIds = z.array(z.uuid()).max(100, '最多限定 100 个接入实例').nullable()
const AllowedRealms = z.array(FacetTermSlug).max(ALLOWED_REALMS_MAX).nullable()

export const VaultItemId = z
  .string()
  .regex(/^[0-9A-Za-z-]{1,64}$/, '条目 id 只能包含字母、数字与 -，最长 64 个字符')

const fieldCount = (values: Record<string, unknown>) =>
  Object.keys(values).length <= MAX_CREDENTIAL_FIELDS

const distinctNames = (fields: { name: string }[]) =>
  new Set(fields.map((f) => f.name)).size === fields.length

export const HostedCredentialValues = z
  .record(CredentialFieldName, CredentialValue)
  .refine((v) => Object.keys(v).length > 0, '至少需要一个字段')
  .refine(fieldCount, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)

export const HostedCredentialValuesUpdate = z
  .record(CredentialFieldName, CredentialValue.nullable())
  .refine(fieldCount, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)

export const VaultCredentialFields = z
  .array(z.object({ name: CredentialFieldName, itemField: VaultFieldRef }))
  .min(1, '至少需要一个字段')
  .max(MAX_CREDENTIAL_FIELDS, `最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)
  .refine(distinctNames, '字段名不能重复')

export const HostedCredentialSource = z.object({
  kind: z.literal('hosted'),
  values: HostedCredentialValues,
})

export const VaultCredentialSource = z.object({
  kind: z.literal('vault'),
  connectionId: z.uuid(),
  itemId: VaultItemId,
  fields: VaultCredentialFields.optional(),
})

export const NewCredentialSource = z.object({
  kind: z.literal('new'),
  values: HostedCredentialValues,
  url: CredentialUrl.optional(),
})

export const CredentialSourceInput = z.discriminatedUnion('kind', [
  NewCredentialSource,
  VaultCredentialSource,
])
export type CredentialSourceInput = z.infer<typeof CredentialSourceInput>

export const CreateCredentialRequest = z.object({
  identifier: CredentialIdentifier,
  name: CredentialName,
  description: CredentialDescription.optional(),
  source: CredentialSourceInput,
  clientIds: ClientIds.optional(),
  allowedRealms: AllowedRealms.optional(),
  expiresAt: CredentialExpiresAt.optional(),
})
export type CreateCredentialRequest = z.infer<typeof CreateCredentialRequest>

export const UpdateCredentialRequest = z.object({
  expectedVersion: z.number().int(),
  name: CredentialName.optional(),
  description: CredentialDescription.optional(),
  values: HostedCredentialValuesUpdate.optional(),
  fields: VaultCredentialFields.optional(),
  clientIds: ClientIds.optional(),
  allowedRealms: AllowedRealms.optional(),
  expiresAt: CredentialExpiresAt.optional(),
  needsRotation: z.boolean().optional(),
})
export type UpdateCredentialRequest = z.infer<typeof UpdateCredentialRequest>

export const CONVERT_VALUE_MIN_LENGTH = 4

export const ConvertibleValue = CredentialValue.min(
  CONVERT_VALUE_MIN_LENGTH,
  `要转存的值至少 ${CONVERT_VALUE_MIN_LENGTH} 个字符，更短的值请手动新建凭据`,
)
  .refine((v) => v === v.trim(), '要转存的值前后不能有空白')
  .refine((v) => !/\p{Cs}/u.test(v), '要转存的值含不完整的字符')
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_START), '要转存的值不能含凭据占位符')

export const CREDENTIAL_MATCH_MAX = 20
export const MatchCredentialValuesRequest = z.object({
  values: z
    .array(ConvertibleValue)
    .min(1, '至少需要一个值')
    .max(CREDENTIAL_MATCH_MAX, `一次最多 ${CREDENTIAL_MATCH_MAX} 个值`),
})
export type MatchCredentialValuesRequest = z.infer<typeof MatchCredentialValuesRequest>

export const CredentialValueMatch = z.object({
  credentials: z.array(
    z.object({
      id: z.uuid(),
      identifier: z.string(),
      name: z.string(),
      field: z.string(),
    }),
  ),
  vaultItems: z.array(
    z.object({
      connectionId: z.uuid(),
      itemId: z.string(),
      itemName: z.string(),
      itemField: z.string(),
      credential: z.object({ id: z.uuid(), identifier: z.string() }).nullable(),
    }),
  ),
})
export type CredentialValueMatch = z.infer<typeof CredentialValueMatch>

export const CredentialValueMatches = z.object({
  items: z.array(CredentialValueMatch),
  unavailableConnections: z.number().int(),
  unreadableCredentials: z.number().int(),
})
export type CredentialValueMatches = z.infer<typeof CredentialValueMatches>

export const ConvertTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new'),
    identifier: CredentialIdentifier,
    name: CredentialName,
    description: CredentialDescription.optional(),
    field: CredentialFieldName,
    url: CredentialUrl.optional(),
    expiresAt: CredentialExpiresAt.optional(),
  }),
  z.object({
    kind: z.literal('credential'),
    credentialId: z.uuid(),
    field: CredentialFieldName,
  }),
  z
    .object({
      kind: z.literal('vault'),
      connectionId: z.uuid(),
      itemId: VaultItemId,
      itemField: VaultFieldRef,
      identifier: CredentialIdentifier,
      name: CredentialName.optional(),
      description: CredentialDescription.optional(),
      fields: VaultCredentialFields.optional(),
    })
    .refine((t) => !t.fields || t.fields.some((f) => f.itemField === t.itemField), {
      path: ['fields'],
      message: '字段对应里要有要转存的条目字段',
    }),
])
export type ConvertTarget = z.infer<typeof ConvertTarget>

function convertTargetTexts(target: ConvertTarget): string[] {
  switch (target.kind) {
    case 'new':
      return [
        target.identifier,
        target.name,
        target.description ?? '',
        target.field,
        target.url ?? '',
      ]
    case 'credential':
      return [target.field]
    case 'vault':
      return [
        target.identifier,
        target.name ?? '',
        target.description ?? '',
        target.itemField,
        ...(target.fields ?? []).flatMap((f) => [f.name, f.itemField]),
      ]
  }
}

export const ConvertToCredentialRequest = z
  .object({
    entryId: z.uuid(),
    expectedVersion: z.number().int(),
    value: ConvertibleValue,
    target: ConvertTarget,
  })
  .refine((r) => !convertTargetTexts(r.target).some((t) => t.includes(r.value)), {
    path: ['value'],
    message: '标识、名称、说明、字段名与网址不能包含要转存的值',
  })
export type ConvertToCredentialRequest = z.infer<typeof ConvertToCredentialRequest>

export const ConvertedToCredential = z.object({
  entry: ConsoleEntryView,
  credential: ConsoleCredential,
  created: z.boolean(),
  storedIn: CredentialStoredIn.nullable(),
  field: z.string(),
  replaced: z.number().int(),
  scrubbedEvents: z.number().int(),
  plaintextVersions: z.number().int(),
  otherEntries: z.number().int(),
})
export type ConvertedToCredential = z.infer<typeof ConvertedToCredential>

export const KeyCreateCredentialRequest = z.object({
  identifier: CredentialIdentifier,
  name: CredentialName,
  description: CredentialDescription.optional(),
  values: HostedCredentialValues,
  url: CredentialUrl.optional(),
  expiresAt: CredentialExpiresAt.optional(),
})
export type KeyCreateCredentialRequest = z.infer<typeof KeyCreateCredentialRequest>

export const KeyCreatedCredential = CredentialSummary.extend({ storedIn: CredentialStoredIn })
export type KeyCreatedCredential = z.infer<typeof KeyCreatedCredential>

export const KeyUpdateCredentialRequest = z.object({
  identifier: CredentialIdentifier,
  expectedVersion: z.number().int(),
  name: CredentialName.optional(),
  description: CredentialDescription.optional(),
  values: HostedCredentialValuesUpdate.optional(),
  expiresAt: CredentialExpiresAt.optional(),
})
export type KeyUpdateCredentialRequest = z.infer<typeof KeyUpdateCredentialRequest>

export const OrphanVaultItem = z.object({
  connectionId: z.uuid(),
  itemId: z.string(),
  itemName: z.string(),
  collectionName: z.string(),
})
export type OrphanVaultItem = z.infer<typeof OrphanVaultItem>

export const CREDENTIAL_WRITE_REASONS = [
  'version',
  'item_conflict',
  'read_only',
  'value_too_long',
  'deleted',
] as const
export const CredentialWriteReason = z.enum(CREDENTIAL_WRITE_REASONS)
export type CredentialWriteReason = z.infer<typeof CredentialWriteReason>

export const CredentialWriteError = z.object({
  error: z.string(),
  reason: CredentialWriteReason.optional(),
  vaultItem: OrphanVaultItem.optional(),
})
export type CredentialWriteError = z.infer<typeof CredentialWriteError>

export const CREDENTIAL_PURPOSE_MAX = 200
export const CredentialPurpose = z
  .string()
  .trim()
  .max(CREDENTIAL_PURPOSE_MAX, `用途最多 ${CREDENTIAL_PURPOSE_MAX} 个字`)
  .refine((v) => !CONTROL_CHARS.test(v), '用途不能包含换行等控制字符')
  .transform((v) => v || undefined)

export const CredentialIdentifierQuery = z.object({
  identifier: CredentialIdentifier,
  field: CredentialFieldName.optional(),
  purpose: CredentialPurpose.optional(),
})

export const CREDENTIAL_RESOLVE_MAX = 32
export const CredentialFieldRef = z.object({
  identifier: CredentialIdentifier,
  field: CredentialFieldName,
})
export type CredentialFieldRef = z.infer<typeof CredentialFieldRef>

export const ResolveCredentialsRequest = z.object({
  refs: z
    .array(CredentialFieldRef)
    .min(1, '至少需要一项')
    .max(CREDENTIAL_RESOLVE_MAX, `一次最多 ${CREDENTIAL_RESOLVE_MAX} 项`)
    .refine(
      (refs) => new Set(refs.map((r) => `${r.identifier}#${r.field}`)).size === refs.length,
      '同一个标识与字段不能重复',
    ),
  purpose: CredentialPurpose.optional(),
})
export type ResolveCredentialsRequest = z.infer<typeof ResolveCredentialsRequest>

export const ResolvedCredentials = z.object({
  values: z.array(CredentialFieldRef.extend({ value: z.string() })),
  expired: z.array(z.object({ identifier: z.string(), expiresAt: z.string() })),
})
export type ResolvedCredentials = z.infer<typeof ResolvedCredentials>

export const KeyDeleteCredentialQuery = z.object({
  identifier: CredentialIdentifier,
  expectedVersion: z.coerce.number().int().optional(),
})

export const CredentialReference = z.object({
  id: z.uuid(),
  shortId: ShortId,
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

export const CredentialValues = z.object({ values: z.record(z.string(), z.string()) })
export type CredentialValues = z.infer<typeof CredentialValues>

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

export const CREDENTIAL_ACCESS_RESULTS = ['ok', 'denied', 'failed'] as const
export const CredentialAccessResult = z.enum(CREDENTIAL_ACCESS_RESULTS)
export type CredentialAccessResult = z.infer<typeof CredentialAccessResult>

export const CREDENTIAL_ACCESS_REASONS = [
  'capability',
  'scope',
  'circle',
  'realm',
  'context',
  'client',
  'item_unavailable',
  'field_missing',
  'reauth_required',
  'disabled',
  'disconnected',
  'unreachable',
  'vault_error',
  'master_key',
  'internal_error',
] as const
export const CredentialAccessReason = z.enum(CREDENTIAL_ACCESS_REASONS)
export type CredentialAccessReason = z.infer<typeof CredentialAccessReason>

export const CredentialEvent = z.object({
  id: z.number().int(),
  type: z.string(),
  createdAt: z.string(),
  actor: EventActor,
  via: z.string().nullable(),
  fields: z.array(z.string()),
  purpose: z.string().nullable(),
  result: CredentialAccessResult.nullable(),
  reason: CredentialAccessReason.nullable(),
  chatType: z.string().nullable(),
  changes: z.array(z.string()),
  sinceValueChange: z.boolean().nullable(),
  bench: BenchMark.nullable(),
})
export type CredentialEvent = z.infer<typeof CredentialEvent>

export const CredentialEventList = z.object({
  items: z.array(CredentialEvent),
  nextCursor: z.string().nullable(),
})
export type CredentialEventList = z.infer<typeof CredentialEventList>

export const CredentialEventQuery = PageQuery.extend({
  sinceValueChange: z.enum(['true']).optional(),
})
export type CredentialEventQuery = z.infer<typeof CredentialEventQuery>

export const VAULT_CONNECTION_STATUSES = [
  'ok',
  'reauth_required',
  'disabled',
  'disconnected',
] as const
export const VaultConnectionStatus = z.enum(VAULT_CONNECTION_STATUSES)
export type VaultConnectionStatus = z.infer<typeof VaultConnectionStatus>

export const VAULT_DISABLED_REASONS = ['personal_items', 'organization_role'] as const
export const VaultDisabledReason = z.enum(VAULT_DISABLED_REASONS)
export type VaultDisabledReason = z.infer<typeof VaultDisabledReason>

export const VAULT_ERROR_KINDS = [
  'invalid_credentials',
  'two_factor_invalid',
  'unsupported_two_factor',
  'reauth_required',
  'item_unavailable',
  'read_only',
  'item_conflict',
  'value_too_long',
  'unsupported_format',
  'integrity',
  'unreachable',
  'server_error',
] as const
export const VaultErrorKind = z.enum(VAULT_ERROR_KINDS)
export type VaultErrorKind = z.infer<typeof VaultErrorKind>

export const VAULT_TWO_FACTOR_PROVIDERS = ['authenticator'] as const
export const VaultTwoFactorProvider = z.enum(VAULT_TWO_FACTOR_PROVIDERS)
export type VaultTwoFactorProvider = z.infer<typeof VaultTwoFactorProvider>

export const VAULT_ITEM_TYPES = ['login', 'note', 'card', 'identity', 'ssh_key'] as const
export const VaultItemType = z.enum(VAULT_ITEM_TYPES)
export type VaultItemType = z.infer<typeof VaultItemType>

export const VaultCollection = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  readOnly: z.boolean(),
})
export type VaultCollection = z.infer<typeof VaultCollection>

export const VaultCollectionId = z
  .string()
  .regex(/^[0-9A-Za-z-]{1,64}$/, '集合 id 只能包含字母、数字与 -，最长 64 个字符')

export const VaultDestination = z.object({
  collectionId: z.string(),
  organizationId: z.string(),
  collectionName: z.string(),
})
export type VaultDestination = z.infer<typeof VaultDestination>

export const VaultConnection = z.object({
  id: z.uuid(),
  serverUrl: z.string(),
  email: z.string(),
  status: VaultConnectionStatus,
  disabledReason: VaultDisabledReason.nullable(),
  lastError: z.object({ kind: VaultErrorKind, at: z.string() }).nullable(),
  lastCheckedAt: z.string().nullable(),
  disconnectedAt: z.string().nullable(),
  credentialCount: z.number().int(),
  destination: VaultDestination.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type VaultConnection = z.infer<typeof VaultConnection>

export const VaultConnectionList = z.object({ items: z.array(VaultConnection) })
export type VaultConnectionList = z.infer<typeof VaultConnectionList>

export const SetVaultDestinationRequest = z.object({ collectionId: VaultCollectionId })
export type SetVaultDestinationRequest = z.infer<typeof SetVaultDestinationRequest>

const SERVER_URL = /^https:\/\/[^\s/?#@\\]+(?:\/[^\s?#\\]*)?$/i
const LOCAL_HTTP_URL =
  /^http:\/\/(?:(?!(?:\d+|0x[0-9a-f]*)(?:[:/]|$))[a-z0-9-]+|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s?#\\]*)?$/i
export const VaultServerUrl = z
  .string()
  .trim()
  .max(500, '服务器地址最多 500 个字符')
  .refine(
    (v) => SERVER_URL.test(v) || LOCAL_HTTP_URL.test(v),
    '服务器地址要以 https:// 开头（本机地址与不带点的主机名可以用 http://），不带账号、查询参数与 #',
  )
  .transform((v) => v.replace(/\/+$/, ''))

export const VaultEmail = z
  .string()
  .trim()
  .max(320, '邮箱最多 320 个字符')
  .refine((v) => /^[^\s@]+@[^\s@]+$/.test(v), '邮箱格式不正确')
const MasterPassword = z.string().min(1, '主密码不能为空').max(1024, '主密码最多 1024 个字符')
const VaultTwoFactor = z.object({
  provider: VaultTwoFactorProvider,
  code: z.string().trim().min(1, '验证码不能为空').max(64, '验证码最多 64 个字符'),
})

export const ConnectVaultRequest = z.object({
  serverUrl: VaultServerUrl,
  email: VaultEmail,
  masterPassword: MasterPassword,
  twoFactor: VaultTwoFactor.optional(),
})
export type ConnectVaultRequest = z.infer<typeof ConnectVaultRequest>

export const ReconnectVaultRequest = z.object({
  email: VaultEmail.optional(),
  masterPassword: MasterPassword,
  twoFactor: VaultTwoFactor.optional(),
})
export type ReconnectVaultRequest = z.infer<typeof ReconnectVaultRequest>

export const VaultConnectResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connected'), connection: VaultConnection }),
  z.object({
    kind: z.literal('two_factor_required'),
    providers: z.array(VaultTwoFactorProvider),
  }),
])
export type VaultConnectResult = z.infer<typeof VaultConnectResult>

export const REVISION_TOLERANCE_MS = 1000

export function sameRevision(a: string, b: string): boolean {
  const x = Date.parse(a)
  const y = Date.parse(b)
  if (Number.isNaN(x) || Number.isNaN(y)) return a === b
  return Math.abs(x - y) < REVISION_TOLERANCE_MS
}

export function isNewerRevision(next: string, prev: string): boolean {
  const x = Date.parse(next)
  const y = Date.parse(prev)
  if (Number.isNaN(x) || Number.isNaN(y)) return next !== prev
  return x - y >= REVISION_TOLERANCE_MS
}

export const VaultItemSummary = z.object({
  id: z.string(),
  organizationId: z.string(),
  collectionIds: z.array(z.string()),
  name: z.string(),
  type: VaultItemType,
  fields: z.array(z.string()),
  revisionDate: z.string(),
  credential: z.object({ id: z.uuid(), identifier: z.string() }).nullable(),
})
export type VaultItemSummary = z.infer<typeof VaultItemSummary>

export const VaultItemList = z.object({
  items: z.array(VaultItemSummary),
  unreadableCount: z.number().int(),
  collections: z.array(VaultCollection),
  organizations: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type VaultItemList = z.infer<typeof VaultItemList>

export const VaultCheckResult = z.object({
  connection: VaultConnection,
  collections: z.array(VaultCollection),
})
export type VaultCheckResult = z.infer<typeof VaultCheckResult>
