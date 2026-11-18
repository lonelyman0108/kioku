import { z } from 'zod'

import { BIP39_ENGLISH_WORDS } from './bip39'

export const SENSITIVE_CATEGORIES = ['credential', 'pii'] as const
export const SensitiveCategory = z.enum(SENSITIVE_CATEGORIES)
export type SensitiveCategory = z.infer<typeof SensitiveCategory>

// 疑似明文凭据类别（含原有类别与扩展类别）
export const CREDENTIAL_KINDS = [
  'label',
  'sk',
  'github',
  'gitlab',
  'slack',
  'aws',
  'jwt',
  'private_key',
  'kioku',
  'provider_token',
  'url_password',
  'header_secret',
  'wallet_key',
  'seed_phrase',
  'custom',
] as const
export const CredentialKind = z.enum(CREDENTIAL_KINDS)
export type CredentialKind = z.infer<typeof CredentialKind>

// 核心 PII（默认开启）与扩展 PII（默认关闭，按空间开关）
export const CORE_PII_KINDS = ['phone', 'id_card', 'bank_card', 'email'] as const
export const OPTIONAL_PII_KINDS = ['public_ip', 'mac', 'ssn', 'iban', 'passport'] as const
export const MODEL_PII_KINDS = ['person', 'address', 'account'] as const
export const TOGGLEABLE_PII_KINDS = [...CORE_PII_KINDS, ...OPTIONAL_PII_KINDS] as const
export const PII_KINDS = [...TOGGLEABLE_PII_KINDS, ...MODEL_PII_KINDS] as const

export const ToggleablePiiKind = z.enum(TOGGLEABLE_PII_KINDS)
export type ToggleablePiiKind = z.infer<typeof ToggleablePiiKind>
export const PiiKind = z.enum(PII_KINDS)
export type PiiKind = z.infer<typeof PiiKind>

export const SENSITIVE_KINDS = [...CREDENTIAL_KINDS, ...PII_KINDS] as const
export const SensitiveKind = z.enum(SENSITIVE_KINDS)
export type SensitiveKind = z.infer<typeof SensitiveKind>

export const DEFAULT_PII_KINDS: Record<ToggleablePiiKind, boolean> = {
  phone: true,
  id_card: true,
  bank_card: true,
  email: true,
  public_ip: false,
  mac: false,
  ssn: false,
  iban: false,
  passport: false,
}

export const CUSTOM_RULE_MAX = 32
export const ALLOWLIST_MAX = 200

export const CustomSensitiveRule = z
  .object({
    kind: z.string().trim().min(1, '规则类别不能为空').max(24, '规则类别最多 24 个字符'),
    prefix: z.string().trim().min(3, '前缀至少 3 个字符').max(64, '前缀最多 64 个字符').optional(),
    regex: z.string().trim().min(1, '正则不能为空').max(300, '正则最多 300 个字符').optional(),
  })
  .refine((r) => Boolean(r.prefix) !== Boolean(r.regex), '自定义规则只能填写前缀或正则表达式之一')
export type CustomSensitiveRule = z.infer<typeof CustomSensitiveRule>

export const CirclePrivacySettings = z.object({
  credentials: z.boolean().default(true),
  pii: z.boolean().default(true),
  piiKinds: z.record(ToggleablePiiKind, z.boolean()).default({ ...DEFAULT_PII_KINDS }),
  customRules: z.array(CustomSensitiveRule).max(CUSTOM_RULE_MAX).default([]),
  allowlist: z.array(z.string().trim().min(2).max(200)).max(ALLOWLIST_MAX).default([]),
  usePrivacyModel: z.boolean().default(false),
})
export type CirclePrivacySettings = z.infer<typeof CirclePrivacySettings>

const PartialPiiKinds = z.object({
  phone: z.boolean().optional(),
  id_card: z.boolean().optional(),
  bank_card: z.boolean().optional(),
  email: z.boolean().optional(),
  public_ip: z.boolean().optional(),
  mac: z.boolean().optional(),
  ssn: z.boolean().optional(),
  iban: z.boolean().optional(),
  passport: z.boolean().optional(),
})

export const UpdateCirclePrivacySettings = z.object({
  credentials: z.boolean().optional(),
  pii: z.boolean().optional(),
  piiKinds: PartialPiiKinds.optional(),
  customRules: z.array(CustomSensitiveRule).max(CUSTOM_RULE_MAX).optional(),
  allowlist: z.array(z.string().trim().min(2).max(200)).max(ALLOWLIST_MAX).optional(),
  usePrivacyModel: z.boolean().optional(),
})
export type UpdateCirclePrivacySettings = z.infer<typeof UpdateCirclePrivacySettings>

export const DEFAULT_CIRCLE_PRIVACY: CirclePrivacySettings = {
  credentials: true,
  pii: true,
  piiKinds: { ...DEFAULT_PII_KINDS },
  customRules: [],
  allowlist: [],
  usePrivacyModel: false,
}

export function resolveCirclePrivacy(
  raw?: Partial<CirclePrivacySettings> | null,
): CirclePrivacySettings {
  return {
    credentials: raw?.credentials ?? true,
    pii: raw?.pii ?? true,
    piiKinds: { ...DEFAULT_PII_KINDS, ...(raw?.piiKinds ?? {}) },
    customRules: raw?.customRules ?? [],
    allowlist: raw?.allowlist ?? [],
    usePrivacyModel: raw?.usePrivacyModel ?? false,
  }
}

// 存库与返回给前端的安全摘要：只留类别、细类、行号与可选规则名，绝不存明文值
export const StoredSensitiveFinding = z.object({
  category: SensitiveCategory,
  kind: SensitiveKind,
  line: z.number().int().min(1),
  label: z.string().optional(),
})
export type StoredSensitiveFinding = z.infer<typeof StoredSensitiveFinding>

export const REDACT_MODES = ['stars', 'tag'] as const
export const RedactMode = z.enum(REDACT_MODES)
export type RedactMode = z.infer<typeof RedactMode>

export const RedactEntryRequest = z.object({
  entryId: z.uuid(),
  variantId: z.uuid().optional(),
  expectedVersion: z.number().int(),
  mode: RedactMode.default('stars'),
  categories: z.array(SensitiveCategory).min(1).max(2).optional(),
})
export type RedactEntryRequest = z.infer<typeof RedactEntryRequest>

export const PROTECT_TARGETS = ['personal_private', 'secret'] as const
export const ProtectTarget = z.enum(PROTECT_TARGETS)
export type ProtectTarget = z.infer<typeof ProtectTarget>

export const ProtectEntryRequest = z.object({
  entryId: z.uuid(),
  expectedVersion: z.number().int(),
  target: ProtectTarget,
})
export type ProtectEntryRequest = z.infer<typeof ProtectEntryRequest>

// 个人圈私密及以上且来源受信任的词条：个人信息保留在个人安全边界内，不进待处理红点，外发模型前自动脱敏
export function isProtectedPersonalEntry(
  circleKind: string,
  sensitivity: string,
  provenance: string,
): boolean {
  return (
    circleKind === 'personal' &&
    (sensitivity === 'private' || sensitivity === 'secret') &&
    provenance !== 'untrusted'
  )
}

// 待处理 › 疑似敏感内容的判定口径（与服务端 SQL 条件一致）：
// 非机密明文凭据始终提示；个人信息仅在未进入「个人圈私密及以上且来源受信」边界时提示
export function needsSensitiveInboxAlert(input: {
  circleKind: string
  sensitivity: string
  provenance?: string | null
  sensitiveCredential?: boolean | null
  sensitivePii?: boolean | null
  plaintextIgnored?: boolean | null
}): boolean {
  if (input.sensitivity === 'secret' || input.plaintextIgnored) return false
  if (input.sensitiveCredential) return true
  if (input.sensitivePii) {
    return !isProtectedPersonalEntry(
      input.circleKind,
      input.sensitivity,
      input.provenance ?? 'owner',
    )
  }
  return false
}

// 规则类别标准化为大写字母、数字与下划线
export function normalizeRuleKind(kind: string): string {
  const cleaned = kind
    .trim()
    .toUpperCase()
    .replace(/[ .-]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
    .replace(/^_+|_+$/g, '')
  if (!cleaned) return 'CUSTOM'
  const prefixed = /^[A-Z]/.test(cleaned) ? cleaned : `CUSTOM_${cleaned}`
  return prefixed.slice(0, 24).replace(/_+$/g, '') || 'CUSTOM'
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compileCustomRule(rule: CustomSensitiveRule): RegExp {
  if (rule.prefix) {
    return new RegExp(`${escapeRegExp(rule.prefix)}[A-Za-z0-9_-]{8,}`, 'g')
  }
  return new RegExp(rule.regex!, 'g')
}

export function validateCustomRules(
  input: readonly CustomSensitiveRule[],
): { ok: true; rules: CustomSensitiveRule[] } | { ok: false; error: string } {
  const out: CustomSensitiveRule[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    const prefix = raw.prefix?.trim() || undefined
    const regex = raw.regex?.trim() || undefined
    if (!prefix && !regex) continue
    if (prefix && regex) {
      return { ok: false, error: `自定义规则 ${raw.kind} 不能同时填写前缀和正则表达式` }
    }
    const kind = normalizeRuleKind(raw.kind)
    if (prefix && (prefix.length < 3 || prefix.length > 64)) {
      return { ok: false, error: `自定义规则 ${kind} 的前缀长度须在 3 到 64 个字符之间` }
    }
    if (regex && regex.length > 300) {
      return { ok: false, error: `自定义规则 ${kind} 的正则表达式最多 300 个字符` }
    }
    let re: RegExp
    try {
      re = compileCustomRule({ kind, ...(prefix ? { prefix } : { regex }) })
    } catch {
      return { ok: false, error: `自定义规则 ${kind} 的正则表达式无法编译` }
    }
    if (re.test('')) {
      return { ok: false, error: `自定义规则 ${kind} 的正则表达式会匹配空串，无法使用` }
    }
    const dedupeKey = `${kind}|${prefix ?? ''}|${regex ?? ''}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push({ kind, ...(prefix ? { prefix } : { regex }) })
  }
  if (out.length > CUSTOM_RULE_MAX) {
    return { ok: false, error: `最多只能配置 ${CUSTOM_RULE_MAX} 条自定义规则` }
  }
  return { ok: true, rules: out }
}

// ---- 核心文本扫描与上下文过滤 ----

export interface SensitiveMatch {
  category: SensitiveCategory
  kind: SensitiveKind
  start: number
  end: number
  extendedEnd: number
  line: number
  field: string
  label?: string
}

export interface SensitiveScanOptions {
  credentials?: boolean
  pii?: boolean
  piiKinds?: Partial<Record<ToggleablePiiKind, boolean>>
  customRules?: readonly CustomSensitiveRule[]
  allowlist?: readonly string[]
  overlapping?: boolean
}

export const SENSITIVE_PLACEHOLDER_START = '{{cred:'
const CREDENTIAL_PLACEHOLDER_RE =
  /\{\{cred:([a-z0-9][a-z0-9_-]{0,63})(?:#([a-z0-9][a-z0-9_-]{0,63}))?\}\}/
const PLACEHOLDER_AT = new RegExp(CREDENTIAL_PLACEHOLDER_RE.source, 'y')
const PLACEHOLDER_START_RE = /\{\{cred:/g
const REDACTED_MARKER_RE = /\[REDACTED:[A-Z0-9_]+\]/y

const SPACE =
  ' \\t\\n\\v\\f\\r\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'
const QUOTES = '"\'`“‘「『*'
const VALUE_STOPS = '，。；、！？）】」』》”’'
const VALUE_BREAKS = '（【《「『“‘&'
const CJK = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff'
const LINE_BREAK = /[\n\r\u2028\u2029]/g
const VALUE_END = new RegExp(`[${SPACE}${VALUE_STOPS}${VALUE_BREAKS}]|\\{\\{cred:`, 'g')
const EXTENDED_END = new RegExp(`[${SPACE}${VALUE_STOPS}]|\\{\\{cred:`, 'g')

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
const UNPAIRED_CLOSERS: readonly (readonly [string, string])[] = [
  ['**', '**'],
  ['`', '`'],
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
]
const WRAPPED_VALUE_MAX = 1024
const VALUE_MAX = 1024

// 与旧规则保持兼容并扩充中日韩常用凭据词（密钥、秘钥、私钥、金钥、令牌、授权码、PIN码、安全码）
const ALL_LABELS =
  'password|passwd|passphrase|pwd|密码|密碼|口令|pin[ ]?码|pin[ ]?code|安全码|安全碼|' +
  'token|api[_ -]?key|access[_ -]?key|secret[_ -]?(?:access[_ -]?)?key|private[_ -]?key|priv[_ -]?key|secret|' +
  '密钥|密鑰|秘钥|秘鑰|私钥|私鑰|金钥|金鑰|令牌|权杖|權杖|授权码|授權碼'

const QUOTED_KEY_CLOSER = `(?:(?<=["'\`][A-Za-z0-9_${CJK}-]{0,40})["'\`])?`
const CJK_LEADS = `${QUOTES}（【《\\(\\[`
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
const ONE_PLACEHOLDER = CREDENTIAL_PLACEHOLDER_RE.source.replace(/\((?!\?)/g, '(?:')
const PLACEHOLDER_RUN = `${ONE_PLACEHOLDER}(?:[:@/,;=&|-]{0,3}${ONE_PLACEHOLDER}){0,8}`
const PLACEHOLDER_VALUE =
  `\\*{0,3}[${SPACE}]*${PLACEHOLDER_RUN}${VALUE_ENDS_HERE}` +
  `|["'\`“‘「『][${SPACE}]*${PLACEHOLDER_RUN}[${SPACE}]*["'\`”’」』]`
const NOT_A_VALUE =
  `${WHOLE_MASK}|${TYPE_NAMES}|${VARIABLE_REFS}|${ANGLE_PLACEHOLDER}|${TEMPLATE_EXPRESSION}` +
  `|(?:"[${SPACE}]*"|'[${SPACE}]*')${VALUE_ENDS_HERE}`

const EMPHASIS_AFTER_COLON = `(?:(?:\\*\\*|__|\\*)(?=[${SPACE}]))?`
const EMPHASIS_BEFORE_COLON = '(?:\\*\\*|__|\\*|_)?'
const LABEL_PREFIX =
  `(?:${ALL_LABELS})${QUOTED_KEY_CLOSER}${EMPHASIS_BEFORE_COLON}[${SPACE}]*(?:[:：=]|(?<![A-Za-z0-9_])[为為是][${SPACE}]*[:：]?)` +
  `${EMPHASIS_AFTER_COLON}[${SPACE}]*(?!(?:\\*\\*|__|\\*)[${SPACE}])` +
  `(?!${PLACEHOLDER_VALUE})(?![${QUOTES}]*(?:${NOT_A_VALUE}))(?![${CJK_LEADS}]*[${CJK}])[^${SPACE}]`

const TOKEN_START = '(?<![A-Za-z0-9_-])'
const TOKEN_END = '(?![A-Za-z0-9_-])'

type TokenKind = Exclude<
  CredentialKind,
  'label' | 'url_password' | 'header_secret' | 'wallet_key' | 'seed_phrase' | 'custom'
>

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
  provider_token:
    `${TOKEN_START}(?:` +
    `[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}` +
    `|ark-[A-Za-z0-9][A-Za-z0-9_-]{15,}` +
    `|AIza[0-9A-Za-z_-]{35}` +
    `|hf_[A-Za-z0-9]{30,}` +
    `|gsk_[A-Za-z0-9]{40,}` +
    `|xai-[A-Za-z0-9]{40,}` +
    `|npm_[A-Za-z0-9]{36}` +
    `|pypi-[A-Za-z0-9_-]{50,}` +
    `|dop_v1_[a-f0-9]{64}` +
    `|SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}` +
    `|cf(?:ut|at|k|oat)_[A-Za-z0-9_-]{40,}` +
    `|v1\\.0-[A-Za-z0-9]{16,}-[A-Za-z0-9]{40,}` + // lint-comments: allow
    `|eyJhIjoi[A-Za-z0-9+/_-]{40,}={0,2}` +
    `)`,
}

const TOKEN_KINDS = Object.keys(TOKEN_RULES) as TokenKind[]
const TOKEN_AT = TOKEN_KINDS.map((k) => [k, new RegExp(`(?:${TOKEN_RULES[k]})`, 'iy')] as const)
const TOKEN_ANCHORED = TOKEN_KINDS.map(
  (k) => [k, new RegExp(`^(?:${TOKEN_RULES[k]})`, 'i')] as const,
)
const LABEL_START_RE = new RegExp(`^(?:${ALL_LABELS})`, 'i')
const CREDENTIAL_ALL = new RegExp(
  `${LABEL_PREFIX}|${TOKEN_KINDS.map((k) => TOKEN_RULES[k]).join('|')}`,
  'gi',
)

const TOKEN_FIELDS: Record<TokenKind, string> = {
  sk: 'api_key',
  github: 'token',
  gitlab: 'token',
  slack: 'token',
  aws: 'access_key_id',
  jwt: 'token',
  private_key: 'private_key',
  kioku: 'api_key',
  provider_token: 'api_key',
}

const TOKEN_TAIL = /[A-Za-z0-9_-]*/y
const PRIVATE_KEY_END = /[A-Za-z0-9+/=\s]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/iy
const BASE64_RUN = /[A-Za-z0-9+/=]*/y
const BASE64_LINE = /\r?\n[A-Za-z0-9+/=]+(?=\r?\n|$)/y

// ---- Magpie 反误报上下文过滤 ----

const VERSION_RANGE_RE =
  /^(?:[~^]|[<>=!~]=?|==)?[vV]?\d+(?:\.\d+)+(?:[-+._]?(?:(?:alpha|beta|rc|pre|preview|post|dev|canary|next|nightly|snapshot|release|final|ga|stable|build|incubating)\d*|[abcmABCM]\d+|\d+))*$/i

// 仅匹配带秒/时区的完整时间戳或字段名含时间语义的值，纯日期与简写时间（如 密码：2026-10-27T12:30）仍按疑似密码处理
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i

const LINE_REF_RE = /^L?\d+(?:[-:,]L?\d+)*[.,;:]?$/i

const NEXT_FIELD_RE = /^(?:[A-Z_][A-Z0-9_]*|--?[A-Za-z][A-Za-z0-9_-]*)=[^=]/

const CALL_EXPR_RE = /^[A-Za-z_][A-Za-z0-9_.]*\(\)$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/

const SECRET_WORDS = new Set([
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwords',
  'passwd',
  'pwd',
  'key',
  'keys',
  'apikey',
  'credential',
  'credentials',
])

const SOURCE_EXT = new Set([
  'go',
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'pyi',
  'rb',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'm',
  'mm',
  'cs',
  'fs',
  'php',
  'scala',
  'dart',
  'lua',
  'zig',
  'nim',
  'ex',
  'exs',
  'erl',
  'hs',
  'ml',
  'clj',
  'r',
  'jl',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'vue',
  'svelte',
  'astro',
  'md',
  'mdx',
  'rst',
  'sql',
  'proto',
  'graphql',
  'gradle',
  'html',
  'css',
  'scss',
  'less',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'xml',
  'tf',
  'ipynb',
])

const PATH_ROOTS = new Set([
  'Users',
  'home',
  'tmp',
  'private',
  'var',
  'etc',
  'run',
  'opt',
  'usr',
  'mnt',
  'Volumes',
  'root',
  'srv',
  'data',
  'workspace',
  'workspaces',
  'app',
  'Applications',
  'Library',
  'System',
  'proc',
  'dev',
  'sys',
  'nix',
])

const PLAIN_KEY_SUFFIXES = [
  'sort_key',
  'cache_key',
  'prompt_cache_key',
  'public_key',
  'key_id',
  'token_id',
  'secret_id',
  'tokens',
  'token_count',
]

function identWords(v: string): string[] {
  const out: string[] = []
  for (const part of v.split(/[_.]/)) {
    if (!part) continue
    let start = 0
    for (let i = 1; i < part.length; i++) {
      const prev = part[i - 1]!
      const cur = part[i]!
      if (cur >= 'A' && cur <= 'Z' && prev >= 'a' && prev <= 'z') {
        out.push(part.slice(start, i))
        start = i
      }
    }
    out.push(part.slice(start))
  }
  return out
}

// 排除代码里多词命名（refreshToken2、config.password、env.SECRET_V2），保留单词密码如 abc、s3cret、Passw0rd123
function namesASecret(v: string): boolean {
  if (!IDENT_RE.test(v)) return false
  const first = v[0]!
  if (!(first >= 'a' && first <= 'z') && !v.includes('_') && !v.includes('.')) return false
  let words = 0
  let named = false
  for (let w of identWords(v)) {
    if (!/[A-Za-z]/.test(w)) continue
    words++
    w = w.replace(/\d+$/, '').toLowerCase()
    if (SECRET_WORDS.has(w)) named = true
  }
  return words >= 2 && named
}

function pathValue(v: string): boolean {
  if (v.includes('+') || v.includes('=')) return false
  if (v.startsWith('~/') || v.startsWith('./') || v.startsWith('../')) return v.length > 2
  if (!v.startsWith('/')) return false
  const slash = v.indexOf('/', 1)
  if (slash <= 1 || slash === v.length - 1) return false
  return PATH_ROOTS.has(v.slice(1, slash))
}

function fileField(text: string, labelStart: number): boolean {
  // 往前扫到所属字段名开头（支持文件路径与行号引用）
  let i = labelStart
  while (i > 0 && /[A-Za-z0-9_.\-/\\]/.test(text[i - 1]!)) i--
  const token = text.slice(i, labelStart)
  if (!token) return false
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'))
  if (slash >= 0) return true
  const dot = token.lastIndexOf('.')
  if (dot > 0) {
    const afterDot = token.slice(dot + 1).toLowerCase()
    if (SOURCE_EXT.has(afterDot)) return true
  }
  return false
}

function fieldNameBeforeLabel(text: string, labelStart: number): string {
  let i = labelStart
  while (i > 0 && /[A-Za-z0-9_.-]/.test(text[i - 1]!)) i--
  return text.slice(i, labelStart).toLowerCase()
}

function isPlainKeyName(text: string, labelStart: number, labelEnd: number): boolean {
  const full = `${fieldNameBeforeLabel(text, labelStart)}${text.slice(labelStart, labelEnd).toLowerCase()}`
  return PLAIN_KEY_SUFFIXES.some((s) => full.endsWith(s))
}

const KEY_ONLY_LABELS = new Set([
  'key',
  'api_key',
  'api-key',
  'apikey',
  'access_key',
  'secret_key',
  'private_key',
  'priv_key',
  'secret',
  'token',
  '密钥',
  '密鑰',
  '秘钥',
  '秘鑰',
  '私钥',
  '私鑰',
  '金钥',
  '金鑰',
  '令牌',
  '权杖',
  '權杖',
  '授权码',
  '授權碼',
])

const COUNT_UNIT_RE =
  /^[ \t]*(?:位|比特|bits?|字节|bytes?|个|条|秒|毫秒|ms|分钟|小时|天|tokens?)\b/i

function isCodeOrNonSecretLabelValue(
  text: string,
  labelStart: number,
  labelEnd: number,
  valStart: number,
  valEnd: number,
): boolean {
  const len = valEnd - valStart
  if (len <= 0) return true
  if (text[valStart] === '=' && text[valStart - 1] === ':') return true
  if (isPlainKeyName(text, labelStart, labelEnd)) return true
  if (len >= 2) {
    const v = text.slice(valStart, valEnd)
    if (CALL_EXPR_RE.test(v)) return true
    if (namesASecret(v)) return true
    if (pathValue(v)) return true
    if (VERSION_RANGE_RE.test(v)) return true
    if (TIMESTAMP_RE.test(v)) return true
    if (/^L\d+(?:[-:,]L?\d+)*[.,;:]?$/i.test(v)) return true
    // 密钥/令牌类标签后跟纯数字时：不足 6 位或后接计量单位（如 密钥为 2048 位）不算密钥
    if (/^\d+$/.test(v)) {
      const rawLabel = text.slice(labelStart, labelEnd).toLowerCase().replace(/\s+/g, '_')
      if (KEY_ONLY_LABELS.has(rawLabel) || rawLabel.endsWith('_key')) {
        if (v.length < 6) return true
        if (COUNT_UNIT_RE.test(text.slice(valEnd, valEnd + 16))) return true
      }
    }
    if (LINE_REF_RE.test(v) && fileField(text, labelStart)) return true
  }
  return fileField(text, labelStart)
}

// 排除全小写连字符 URL slug（如 sk-hynix-third-quarter-profit）
function notASlug(v: string): boolean {
  if (/[A-Z]/.test(v)) return true
  const body = v.startsWith('sk-') ? v.slice(3) : v
  if (/^[0-9a-f_-]+$/.test(body)) return true
  return body.split(/[-_]/).some((seg) => seg.length >= 16)
}

function secretValueShape(v: string): boolean {
  return /[A-Za-z]/.test(v) && (/\d/.test(v) || v.length >= 24)
}

function notAVariable(v: string): boolean {
  if (!v) return false
  if ('$%{<[*'.includes(v[0]!)) return false
  return v.replace(/[*xX.]/g, '') !== ''
}

// ---- URL 密码、HTTP Header、加密钱包与助记词 ----

const URL_PASSWORD_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s:@/?#"'<>]*):([^\s@/?#"'<>]{3,})@/g

function hiddenInUrl(text: string, user: string, pw: string, atIndex: number): boolean {
  if (!notAVariable(pw)) return false
  if (user && user === pw) return false
  let end = atIndex + 1
  while (end < text.length && !' \t\r\n"\'<>`\\)]}'.includes(text[end]!)) end++
  const rest = text.slice(atIndex + 1, end)
  const parts = rest.split(/[/:.?#&=;,@]+/)
  return !parts.includes(pw)
}

const HEADER_SECRET_RE = /^[ \t]*(authorization|cookie)[ \t]*:[ \t]*(\S[^\r\n]{7,})/gim
const X_AUTH_KEY_RE =
  /(?<![A-Za-z0-9_.-])x-auth-(?:user-service-)?key["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9._-]{16,})/gi

function validHeaderValue(raw: string): boolean {
  const v = raw.trim()
  if (!v || !notAVariable(v)) return false
  const fields = v.split(/\s+/)
  if (fields.length === 1 || (fields.length === 2 && /^[A-Za-z]+$/.test(fields[0]!))) {
    const cred = fields[fields.length - 1]!
    return cred.length >= 8 && notAVariable(cred) && /[^A-Za-z]/.test(cred)
  }
  if (!v.includes('=')) return false
  for (const kv of v.split(';')) {
    const part = kv.trim()
    if (!part) continue
    const eq = part.indexOf('=')
    if (eq <= 0 || /\s/.test(part.slice(0, eq))) return false
  }
  return true
}

const FIXED_WALLET_RE = new RegExp(
  `${TOKEN_START}(?:` +
    `suiprivkey1[0-9a-z]{58}` +
    `|nsec1[02-9ac-hj-np-z]{58}` +
    `|AGE-SECRET-KEY-1[0-9A-Z]{58}` +
    `|ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}` +
    `|(?:ed25519|secp256k1)-priv-0x[0-9a-fA-F]{64}` +
    `|[xyztuvYZUV]prv[1-9A-HJ-NP-Za-km-z]{107}` +
    `|secret-extended-key-(?:main|test)1[0-9a-z]{150,320}` +
    `)${TOKEN_END}`,
  'g',
)

const SOLANA_KEYPAIR_RE = /\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){63}\s*\]/g
const WALLET_HEX_RE = /(?<![A-Za-z0-9_])(?:0x[0-9a-f]{56,64}|[0-9a-f]{64})(?![A-Za-z0-9_])/gi
const WALLET_CUES = [
  'priv',
  'secret',
  'signer',
  'signing',
  'deployer',
  'wallet',
  'pk',
  '私钥',
  '私鑰',
  '秘密鍵',
  '개인키',
  '비밀키',
]
const NOT_WALLET_KEY_WORDS = [
  'hash',
  'sha',
  'digest',
  'sum',
  'pub',
  'addr',
  'tx',
  'fingerprint',
  'id',
]

function hasWalletCue(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 64), start).toLowerCase()
  let best = -1
  for (const cue of WALLET_CUES) {
    const idx = before.lastIndexOf(cue)
    if (idx > best) best = idx
  }
  if (best < 0) return false
  const gap = before.slice(best)
  return !NOT_WALLET_KEY_WORDS.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(gap))
}

const SEED_PHRASE_RE =
  /(?:seed|mnemonic|phrase|recovery|助记词|助記詞|シード|ニーモニック|시드|니모닉)[^.\n]{0,24}?(?:\n[ \t]*)?\b([a-z]{3,8}(?:[ \t]+[a-z]{3,8}){11,40})\b/gi

// ---- PII 规则与校验器 ----

const PHONE_RE = /(?<![A-Za-z0-9])(?:\+?86[- ]?)?(1[3-9]\d{9})(?![A-Za-z0-9])/g
const ID_CARD_RE =
  /(?<![A-Za-z0-9])([1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?![A-Za-z0-9])/g
const BANK_CARD_RE =
  /(?<![A-Za-z0-9])([3-6]\d{3}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?)(?![A-Za-z0-9])/g
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9_%+-])/g
const IPV4_RE = /(?<![A-Za-z0-9._-])(\d{1,3}(?:\.\d{1,3}){3})(?![A-Za-z0-9_-])/g
const MAC_RE = /(?<![A-Za-z0-9:])((?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2})(?![A-Za-z0-9:])/g
const SSN_RE = /(?<![A-Za-z0-9-])(\d{3}-\d{2}-\d{4})(?![A-Za-z0-9-])/g
const IBAN_RE =
  /(?<![A-Za-z0-9])([A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?))(?![A-Za-z0-9])/g
const PASSPORT_RE =
  /(?:passport(?:[ \t]*(?:no\.?|number|num|#))?|护照(?:号码|号)?|護照(?:號碼|号码|番号)?|パスポート(?:番号)?)[ \t]*(?:[:：=][ \t]*)?(?:是[ \t]*|は[ \t]*)?["']?([A-Z0-9]{6,9})(?![A-Za-z0-9])/gi

function validChineseId(v: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  let sum = 0
  for (let i = 0; i < 17; i++) sum += Number(v[i]) * weights[i]!
  return v[17]!.toUpperCase() === '10X98765432'[sum % 11]
}

function validLuhn(v: string): boolean {
  const digits = v.replace(/\D/g, '')
  if (digits.length < 15 || digits.length > 19) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

function validIban(v: string): boolean {
  const compact = v.replace(/\s+/g, '')
  if (compact.length < 15 || compact.length > 34) return false
  const rearranged = compact.slice(4) + compact.slice(0, 4)
  let rem = 0
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0)
    if (code >= 48 && code <= 57) {
      rem = (rem * 10 + (code - 48)) % 97
    } else if (code >= 65 && code <= 90) {
      const val = code - 55
      rem = (rem * 100 + val) % 97
    } else {
      return false
    }
  }
  return rem === 1
}

function validSsn(v: string): boolean {
  const area = Number(v.slice(0, 3))
  const group = Number(v.slice(4, 6))
  const serial = Number(v.slice(7, 11))
  return area !== 0 && area !== 666 && area < 900 && group !== 0 && serial !== 0
}

const FILE_EXT_NOT_TLD = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'heic',
  'heif',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'ico',
  'icns',
  'pdf',
  'mp4',
  'm4v',
  'webm',
  'mkv',
  'avi',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'txt',
  'csv',
  'tsv',
  'log',
  'html',
  'css',
  'scss',
  'less',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'gz',
  'tgz',
  'tar',
  'rar',
  '7z',
  'dmg',
])
const SCALE_EXT = new Set(['zip', 'mov', 'md', 'map'])
const DOC_FILES = new Set([
  'agents.md',
  'claude.md',
  'gemini.md',
  'readme.md',
  'skill.md',
  'changelog.md',
  'contributing.md',
  'license.md',
  'lessons.md',
  'todo.md',
])
const LINKER_WORDS = new Set(['plt', 'got', 'sec', 'iplt', 'igot'])
const FAKE_EMAIL_HOSTS = [
  'example.com',
  'example.org',
  'example.net',
  'localhost',
  '.test',
  '.invalid',
  '.example',
]

function validEmail(v: string): boolean {
  const at = v.lastIndexOf('@')
  if (at <= 0) return false
  const local = v.slice(0, at)
  const host = v.slice(at + 1).toLowerCase()
  if (local.toLowerCase() === 'git' || local.toLowerCase() === 'noreply') return false
  if (host.startsWith('noreply.') || DOC_FILES.has(host)) return false
  if (FAKE_EMAIL_HOSTS.some((f) => host === f.replace(/^\./, '') || host.endsWith(f))) return false
  const parts = host.split('.')
  if (parts.length < 2 || parts.some((p) => !p)) return false
  if (parts.every((p) => LINKER_WORDS.has(p))) return false
  const ext = parts[parts.length - 1]!
  if (FILE_EXT_NOT_TLD.has(ext)) return false
  if (SCALE_EXT.has(ext) && /^\d+(?:\.\d+)?x$/i.test(parts.slice(0, -1).join('.'))) return false
  return true
}

const PUBLIC_DNS_RESOLVERS = new Set([
  '8.8.8.8',
  '8.8.4.4',
  '1.1.1.1',
  '1.0.0.1',
  '9.9.9.9',
  '149.112.112.112',
  '208.67.222.222',
  '208.67.220.220',
  '114.114.114.114',
  '223.5.5.5',
  '223.6.6.6',
  '119.29.29.29',
  '180.76.76.76',
])

function validPublicIpv4(text: string, start: number, end: number): boolean {
  const v = text.slice(start, end)
  if (start > 0) {
    const prev = text[start - 1]!
    if (/[A-Za-z0-9._\-=~^]/.test(prev)) return false
    if (prev === '/' && start >= 2 && /[A-Za-z0-9._-]/.test(text[start - 2]!)) return false
  }
  if (
    end < text.length &&
    text[end] === '.' &&
    end + 1 < text.length &&
    /\d/.test(text[end + 1]!)
  ) {
    return false
  }
  const before = text
    .slice(Math.max(0, start - 16), start)
    .replace(/[ \t:="']+$/, '')
    .toLowerCase()
  for (const w of ['version', 'ver', 'release', 'build', 'rev', '版本']) {
    if (before.endsWith(w)) {
      const idx = before.length - w.length - 1
      if (idx < 0 || !/[A-Za-z0-9_]/.test(before[idx]!)) return false
    }
  }
  const octets = v.split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false
  const [a, b, c] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false
  if (a === 203 && b === 0 && c === 113) return false
  return !PUBLIC_DNS_RESOLVERS.has(v)
}

// ---- ID 边界保护（UUID、32+ hex、16-31 hex 摘要、element_token 不被拆成手机/银行卡） ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ELEMENT_TOKEN_RE = /s[0-9a-f]{8}(?::\d+)?/g

function isIdRange(text: string, start: number, end: number): boolean {
  let l = start
  let r = end
  while (l > 0 && /[0-9A-Fa-f-]/.test(text[l - 1]!)) l--
  while (r < text.length && /[0-9A-Fa-f-]/.test(text[r]!)) r++
  while (l < r && text[l] === '-') l++
  while (r > l && text[r - 1] === '-') r--
  if (start < l || end > r) return false
  const run = text.slice(l, r)
  if (UUID_RE.test(run)) return start > l || end < r
  if (!run.includes('-') && run.length >= 32) return start > l || end < r
  if (run.length >= 16 && run.length < 32 && /[0-9]/.test(run) && /[a-fA-F]/.test(run)) {
    return start > l || end < r
  }
  return false
}

// ---- 工具函数 ----

function forwardSearch(text: string, pattern: RegExp): (from: number) => number {
  let searchedFrom = -1
  let found = -1
  return (from) => {
    if (searchedFrom !== -1 && from >= searchedFrom && from <= found) return found
    pattern.lastIndex = from
    const m = pattern.exec(text)
    searchedFrom = from
    found = m ? m.index : text.length
    return found
  }
}

function lineCounter(text: string): (index: number) => number {
  let line = 1
  let next = text.indexOf('\n')
  return (index) => {
    while (next !== -1 && next < index) {
      line++
      next = text.indexOf('\n', next + 1)
    }
    return line
  }
}

function createScanner(text: string) {
  const valueEnd = forwardSearch(text, new RegExp(VALUE_END.source, 'g'))
  const extendedEnd = forwardSearch(text, new RegExp(EXTENDED_END.source, 'g'))
  const placeholderAt = forwardSearch(text, new RegExp(PLACEHOLDER_START_RE.source, 'g'))
  const lineEnd = forwardSearch(text, new RegExp(LINE_BREAK.source, 'g'))
  const closers = new Map<string, (from: number) => number>()
  const closerAt = (close: string, from: number) => {
    let find = closers.get(close)
    if (!find) {
      find = forwardSearch(text, new RegExp(escapeRegExp(close), 'g'))
      closers.set(close, find)
    }
    return find(from)
  }

  const trimSentence = (first: number, end: number) => {
    while (end > first + 1 && ',.;:'.includes(text[end - 1]!)) end--
    return Math.max(end, first + 1)
  }

  const trimCloser = (first: number, end: number) => {
    for (const [open, close] of UNPAIRED_CLOSERS) {
      const at = end - close.length
      if (at <= first || !text.startsWith(close, at)) continue
      if (closerAt(open, first) < at) continue
      return trimSentence(first, at)
    }
    return end
  }

  const skipPlaceholders = (at: number) => {
    for (;;) {
      PLACEHOLDER_AT.lastIndex = at
      const ph = PLACEHOLDER_AT.exec(text)
      if (ph) {
        at += ph[0].length
        continue
      }
      REDACTED_MARKER_RE.lastIndex = at
      const red = REDACTED_MARKER_RE.exec(text)
      if (red) {
        at += red[0].length
        continue
      }
      return at
    }
  }

  const labelValue = (
    first: number,
  ): { start: number; end: number; extendedEnd: number } | null => {
    const line = lineEnd(first)
    for (const [open, close] of VALUE_WRAPPERS) {
      if (!text.startsWith(open, first)) continue
      const start = first + open.length
      const end = closerAt(close, start)
      if (end <= start || end >= line || end - start > WRAPPED_VALUE_MAX) continue
      let valueStart = skipPlaceholders(start)
      if (valueStart > start) {
        while (valueStart < end && /\s/.test(text[valueStart]!)) valueStart++
      }
      if (valueStart >= end) return null
      const ph = placeholderAt(valueStart)
      let stop = ph < end ? ph : end
      while (stop > valueStart && /\s/.test(text[stop - 1]!)) stop--
      if (stop === valueStart) return null
      return { start: valueStart, end: stop, extendedEnd: stop }
    }
    const at = skipPlaceholders(first)
    if (at > first && (at >= line || valueEnd(at) === at)) return null
    const capped = (end: number) => Math.min(end, at + VALUE_MAX)
    return {
      start: at,
      end: trimCloser(at, trimSentence(at, capped(valueEnd(at)))),
      extendedEnd: trimCloser(at, trimSentence(at, capped(extendedEnd(at)))),
    }
  }

  const tokenValue = (kind: TokenKind, start: number, matched: number) => {
    let end = start + matched
    if (kind === 'private_key') {
      PRIVATE_KEY_END.lastIndex = end
      const close = PRIVATE_KEY_END.exec(text)
      if (close) {
        end += close[0].length
      } else {
        BASE64_RUN.lastIndex = end
        end += BASE64_RUN.exec(text)![0].length
        for (;;) {
          BASE64_LINE.lastIndex = end
          const line = BASE64_LINE.exec(text)
          if (!line) break
          end += line[0].length
        }
      }
    } else if (kind !== 'aws' && kind !== 'kioku') {
      TOKEN_TAIL.lastIndex = end
      end += TOKEN_TAIL.exec(text)![0].length
    }
    return { start, end, extendedEnd: end }
  }

  return { labelValue, tokenValue }
}

function plaintextField(label: string): string {
  const word = label.toLowerCase()
  if (word.startsWith('secret') || word === '密钥' || word === '秘钥') return 'secret'
  if (word === 'token' || word === '令牌' || word === '授权码') return 'token'
  return word.startsWith('api') || word.startsWith('access') ? 'api_key' : 'password'
}

function collectPlaceholderSpans(text: string): [number, number][] {
  const spans: [number, number][] = []
  for (const m of text.matchAll(new RegExp(CREDENTIAL_PLACEHOLDER_RE.source, 'g'))) {
    spans.push([m.index, m.index + m[0].length])
  }
  for (const m of text.matchAll(/\[REDACTED:[A-Z0-9_]+\]/g)) {
    spans.push([m.index, m.index + m[0].length])
  }
  for (const m of text.matchAll(ELEMENT_TOKEN_RE)) {
    spans.push([m.index, m.index + m[0].length])
  }
  return spans
}

function insideSpans(spans: readonly [number, number][], start: number, end: number): boolean {
  for (const [a, b] of spans) {
    if (start >= a && end <= b) return true
    if (a >= end) break
  }
  return false
}

function buildAllowSet(allowlist?: readonly string[]): Set<string> {
  return new Set((allowlist ?? []).map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2))
}

export function scanSensitiveContent(
  text: string,
  options: SensitiveScanOptions = {},
): SensitiveMatch[] {
  const checkCreds = options.credentials ?? true
  const checkPii = options.pii ?? true
  const piiKinds: Record<ToggleablePiiKind, boolean> = {
    ...DEFAULT_PII_KINDS,
    ...(options.piiKinds ?? {}),
  }
  const allowSet = buildAllowSet(options.allowlist)

  const protectedSpans = collectPlaceholderSpans(text)
  const raw: Omit<SensitiveMatch, 'line'>[] = []

  if (checkCreds) {
    const scan = createScanner(text)
    const re = new RegExp(CREDENTIAL_ALL.source, 'gi')
    for (;;) {
      const m = re.exec(text)
      if (!m) break
      const label = LABEL_START_RE.exec(m[0])?.[0]
      if (label) {
        const valueFirst = m.index + m[0].length - 1
        // nextField：如 UI_PASSWORD= UI_ADDR=127.0.0.1，空字段不吞下一字段，从下一字段重新起扫
        if (valueFirst > 0 && (text[valueFirst - 1] === ' ' || text[valueFirst - 1] === '\t')) {
          const lineTail = text.slice(valueFirst, valueFirst + 120)
          if (NEXT_FIELD_RE.test(lineTail)) {
            re.lastIndex = valueFirst
            continue
          }
        }
        const span = scan.labelValue(valueFirst)
        if (!span) continue
        // 检查值本身是否是已知格式令牌（最短令牌 >= 19 个字符或以私钥头开头）
        let at = span.start
        while (at < text.length && QUOTES.includes(text[at]!)) at++
        let tokenKind: TokenKind | null = null
        let tokenSpan: { start: number; end: number; extendedEnd: number } | null = null
        if (span.end - at >= 16 || (text[at] === '-' && text.startsWith('-----', at))) {
          for (const [tk, tre] of TOKEN_AT) {
            tre.lastIndex = at
            const hit = tre.exec(text)
            if (!hit) continue
            const candidateVal = text.slice(at, at + hit[0].length)
            if (tk === 'sk' && !notASlug(candidateVal)) continue
            tokenKind = tk
            tokenSpan = scan.tokenValue(tk, at, hit[0].length)
            break
          }
        }
        if (tokenKind && tokenSpan) {
          re.lastIndex = Math.max(re.lastIndex, tokenSpan.end)
          raw.push({
            category: 'credential',
            kind: tokenKind,
            ...tokenSpan,
            field: TOKEN_FIELDS[tokenKind],
          })
          continue
        }
        if (
          span.end - span.start >= 58 &&
          /^(?:0x[0-9a-f]{56,64}|[0-9a-f]{64})$/i.test(text.slice(span.start, span.end)) &&
          hasWalletCue(text, span.start)
        ) {
          raw.push({
            category: 'credential',
            kind: 'wallet_key',
            ...span,
            field: 'private_key',
          })
          continue
        }
        if (
          isCodeOrNonSecretLabelValue(text, m.index, m.index + label.length, span.start, span.end)
        ) {
          continue
        }
        raw.push({
          category: 'credential',
          kind: 'label',
          ...span,
          field: plaintextField(label),
        })
        continue
      }

      const tokenKind = TOKEN_ANCHORED.find(([, rule]) => rule.test(m[0]))?.[0]
      if (!tokenKind) continue
      const span = scan.tokenValue(tokenKind, m.index, m[0].length)
      const val = text.slice(span.start, span.end)
      if (tokenKind === 'sk' && !notASlug(val)) continue
      if (tokenKind === 'provider_token' && val.includes('_sk_') && !secretValueShape(val)) continue
      if (tokenKind === 'provider_token' && val.startsWith('ark-') && !secretValueShape(val))
        continue
      re.lastIndex = Math.max(re.lastIndex, span.end)
      raw.push({
        category: 'credential',
        kind: tokenKind,
        ...span,
        field: TOKEN_FIELDS[tokenKind],
      })
    }

    // URL 内嵌密码
    if (text.includes('://')) {
      for (const m of text.matchAll(URL_PASSWORD_RE)) {
        const user = m[1] ?? ''
        const pw = m[2] ?? ''
        const pwStart = m.index + m[0].length - pw.length - 1
        const pwEnd = pwStart + pw.length
        const atIdx = m.index + m[0].length - 1
        if (hiddenInUrl(text, user, pw, atIdx)) {
          raw.push({
            category: 'credential',
            kind: 'url_password',
            start: pwStart,
            end: pwEnd,
            extendedEnd: pwEnd,
            field: 'password',
          })
        }
      }
    }

    // HTTP Authorization / Cookie / X-Auth-Key 头
    if (text.includes(' ') || text.includes('\t')) {
      for (const m of text.matchAll(HEADER_SECRET_RE)) {
        const val = m[2] ?? ''
        if (!validHeaderValue(val)) continue
        const valStart = m.index + m[0].length - val.length
        raw.push({
          category: 'credential',
          kind: 'header_secret',
          start: valStart,
          end: valStart + val.length,
          extendedEnd: valStart + val.length,
          field: 'token',
        })
      }
    }
    if (text.includes('-')) {
      for (const m of text.matchAll(X_AUTH_KEY_RE)) {
        const val = m[1] ?? ''
        if (!notAVariable(val)) continue
        const valStart = m.index + m[0].length - val.length
        raw.push({
          category: 'credential',
          kind: 'header_secret',
          start: valStart,
          end: valStart + val.length,
          extendedEnd: valStart + val.length,
          field: 'api_key',
        })
      }
    }

    // 加密钱包私钥与助记词
    if (text.length >= 60) {
      for (const m of text.matchAll(FIXED_WALLET_RE)) {
        raw.push({
          category: 'credential',
          kind: 'wallet_key',
          start: m.index,
          end: m.index + m[0].length,
          extendedEnd: m.index + m[0].length,
          field: 'private_key',
        })
      }
    }
    if (text.includes('[')) {
      for (const m of text.matchAll(SOLANA_KEYPAIR_RE)) {
        const nums = m[0]
          .slice(1, -1)
          .split(',')
          .map((n) => Number(n.trim()))
        if (nums.length === 64 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
          raw.push({
            category: 'credential',
            kind: 'wallet_key',
            start: m.index,
            end: m.index + m[0].length,
            extendedEnd: m.index + m[0].length,
            field: 'private_key',
          })
        }
      }
    }
    if (text.length >= 58) {
      for (const m of text.matchAll(WALLET_HEX_RE)) {
        if (hasWalletCue(text, m.index)) {
          raw.push({
            category: 'credential',
            kind: 'wallet_key',
            start: m.index,
            end: m.index + m[0].length,
            extendedEnd: m.index + m[0].length,
            field: 'private_key',
          })
        }
      }
    }
    if (text.includes(' ') || text.includes('\t')) {
      for (const m of text.matchAll(SEED_PHRASE_RE)) {
        const phrase = m[1] ?? ''
        const words = phrase.split(/[ \t]+/)
        if (
          words.length >= 12 &&
          words.length <= 25 &&
          words.every((w) => BIP39_ENGLISH_WORDS.has(w))
        ) {
          const start = m.index + m[0].length - phrase.length
          raw.push({
            category: 'credential',
            kind: 'seed_phrase',
            start,
            end: start + phrase.length,
            extendedEnd: start + phrase.length,
            field: 'secret',
          })
        }
      }
    }

    // 空间自定义规则
    for (const rule of options.customRules ?? []) {
      let re: RegExp
      try {
        re = compileCustomRule(rule)
      } catch {
        continue
      }
      if (re.test('')) continue
      re.lastIndex = 0
      const label = normalizeRuleKind(rule.kind)
      for (const m of text.matchAll(re)) {
        const g1 = m[1]
        const val = g1 !== undefined ? g1 : m[0]
        if (val.length < 4) continue
        const start = g1 !== undefined ? m.index + m[0].indexOf(g1) : m.index
        raw.push({
          category: 'credential',
          kind: 'custom',
          start,
          end: start + val.length,
          extendedEnd: start + val.length,
          field: 'secret',
          label,
        })
      }
    }
  }

  if (checkPii) {
    if (piiKinds.phone) {
      for (const m of text.matchAll(PHONE_RE)) {
        raw.push({
          category: 'pii',
          kind: 'phone',
          start: m.index,
          end: m.index + m[0].length,
          extendedEnd: m.index + m[0].length,
          field: 'phone',
        })
      }
    }
    if (piiKinds.id_card) {
      for (const m of text.matchAll(ID_CARD_RE)) {
        if (!validChineseId(m[1]!)) continue
        raw.push({
          category: 'pii',
          kind: 'id_card',
          start: m.index,
          end: m.index + m[1]!.length,
          extendedEnd: m.index + m[1]!.length,
          field: 'id_card',
        })
      }
    }
    if (piiKinds.bank_card) {
      for (const m of text.matchAll(BANK_CARD_RE)) {
        if (!validLuhn(m[1]!)) continue
        raw.push({
          category: 'pii',
          kind: 'bank_card',
          start: m.index,
          end: m.index + m[1]!.length,
          extendedEnd: m.index + m[1]!.length,
          field: 'bank_card',
        })
      }
    }
    if (piiKinds.email) {
      for (const m of text.matchAll(EMAIL_RE)) {
        if (!validEmail(m[1]!)) continue
        raw.push({
          category: 'pii',
          kind: 'email',
          start: m.index,
          end: m.index + m[1]!.length,
          extendedEnd: m.index + m[1]!.length,
          field: 'email',
        })
      }
    }
    if (piiKinds.public_ip) {
      for (const m of text.matchAll(IPV4_RE)) {
        const start = m.index
        const end = start + m[1]!.length
        if (!validPublicIpv4(text, start, end)) continue
        raw.push({
          category: 'pii',
          kind: 'public_ip',
          start,
          end,
          extendedEnd: end,
          field: 'ip',
        })
      }
    }
    if (piiKinds.mac) {
      for (const m of text.matchAll(MAC_RE)) {
        const lower = m[1]!.toLowerCase().replace(/[:-]/g, '')
        if (lower === '000000000000' || lower === 'ffffffffffff') continue
        raw.push({
          category: 'pii',
          kind: 'mac',
          start: m.index,
          end: m.index + m[1]!.length,
          extendedEnd: m.index + m[1]!.length,
          field: 'mac',
        })
      }
    }
    if (piiKinds.ssn) {
      for (const m of text.matchAll(SSN_RE)) {
        if (!validSsn(m[1]!)) continue
        raw.push({
          category: 'pii',
          kind: 'ssn',
          start: m.index,
          end: m.index + m[1]!.length,
          extendedEnd: m.index + m[1]!.length,
          field: 'ssn',
        })
      }
    }
    if (piiKinds.iban) {
      for (const m of text.matchAll(IBAN_RE)) {
        if (!validIban(m[1]!)) continue
        raw.push({
          category: 'pii',
          kind: 'iban',
          start: m.index,
          end: m.index + m[1]!.length,
          extendedEnd: m.index + m[1]!.length,
          field: 'iban',
        })
      }
    }
    if (piiKinds.passport) {
      for (const m of text.matchAll(PASSPORT_RE)) {
        const val = m[1]!
        if (!/[A-Z]/.test(val) || !/\d/.test(val)) continue
        const start = m.index + m[0].length - val.length
        raw.push({
          category: 'pii',
          kind: 'passport',
          start,
          end: start + val.length,
          extendedEnd: start + val.length,
          field: 'passport',
        })
      }
    }
  }

  // 过滤占位符内部、白名单、ID 碎片，按起始位置排序去重
  const filtered = raw.filter((m) => {
    if (insideSpans(protectedSpans, m.start, m.end)) return false
    const val = text.slice(m.start, m.end)
    if (allowSet.size > 0 && allowSet.has(val.trim().toLowerCase())) return false
    if (m.category === 'pii' && isIdRange(text, m.start, m.end)) return false
    return true
  })

  filtered.sort((a, b) => a.start - b.start || b.end - a.end)
  const lineAt = lineCounter(text)
  const out: SensitiveMatch[] = []
  let lastEnd = 0
  for (const m of filtered) {
    if (m.start < lastEnd && !options.overlapping) continue
    out.push({ ...m, line: lineAt(m.start) })
    lastEnd = Math.max(lastEnd, m.end)
  }
  return out
}

export function toStoredFindings(matches: readonly SensitiveMatch[]): StoredSensitiveFinding[] {
  return matches.map((m) => ({
    category: m.category,
    kind: m.kind,
    line: m.line,
    ...(m.label ? { label: m.label } : {}),
  }))
}

const SENSITIVE_ANNOTATION_OPENERS = '（【《「『“‘'
const SENSITIVE_ASCII_ALNUM = /[A-Za-z0-9]/

// 按值比对这次写入新增的敏感片段（与 addedPlaintextCredentials 同规则，扩展支持空间设置与 PII）
export function addedSensitiveContent(
  before: string | null,
  after: string,
  options: SensitiveScanOptions = {},
): SensitiveMatch[] {
  const existing =
    before === null
      ? []
      : scanSensitiveContent(before, options).map((m) => before.slice(m.start, m.extendedEnd))
  const exact = new Set(existing)
  const sorted = [...exact].sort()
  const hasPrefix = (prefix: string) => {
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid]! < prefix) lo = mid + 1
      else hi = mid
    }
    return lo < sorted.length && sorted[lo]!.startsWith(prefix)
  }
  const annotated = (value: string) => {
    let cut = -1
    for (let i = 0; i < value.length; i++) {
      if (SENSITIVE_ANNOTATION_OPENERS.includes(value[i]!)) {
        cut = i
        break
      }
    }
    return (
      cut > 0 && exact.has(value.slice(0, cut)) && !SENSITIVE_ASCII_ALNUM.test(value.slice(cut + 1))
    )
  }
  const isExisting = (value: string) =>
    exact.has(value) || annotated(value) || [...VALUE_BREAKS].some((c) => hasPrefix(value + c))
  return scanSensitiveContent(after, options).filter(
    (m) => !isExisting(after.slice(m.start, m.extendedEnd)),
  )
}

// 不可逆打码：stars 替换为 ***（并覆盖凭据值外层引号/粗体）；tag 替换为 [REDACTED:KIND]
export function maskSensitiveContent(
  text: string,
  options: SensitiveScanOptions = {},
  mode: RedactMode = 'stars',
  extraSpans: readonly { start: number; end: number; kind: string }[] = [],
): string {
  const matches = scanSensitiveContent(text, { ...options, overlapping: true })
  const allowSet = buildAllowSet(options.allowlist)
  const protectedSpans = extraSpans.length ? collectPlaceholderSpans(text) : []
  const filteredExtra = extraSpans.filter((s) => {
    if (s.start < 0 || s.end > text.length || s.start >= s.end) return false
    if (insideSpans(protectedSpans, s.start, s.end)) return false
    const val = text.slice(s.start, s.end).trim().toLowerCase()
    return !allowSet.has(val)
  })
  const spans: { start: number; end: number; tag: string; wrap: boolean }[] = [
    ...matches.map((m) => ({
      start: m.start,
      end: m.end,
      tag: (m.label ?? m.kind).toUpperCase(),
      wrap: m.category === 'credential',
    })),
    ...filteredExtra.map((s) => ({
      start: s.start,
      end: s.end,
      tag: s.kind.toUpperCase(),
      wrap: false,
    })),
  ]
  if (!spans.length) return text
  spans.sort((a, b) => a.start - b.start || b.end - a.end)

  const breaks = [...text.matchAll(LINE_BREAK)].map((m) => m.index)
  const lineEnd = (from: number) => {
    let lo = 0
    let hi = breaks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (breaks[mid]! < from) lo = mid + 1
      else hi = mid
    }
    return lo < breaks.length ? breaks[lo]! : text.length
  }

  let out = ''
  let last = 0
  for (const sp of spans) {
    let start = sp.start
    let end = sp.end
    if (mode === 'stars' && sp.wrap) {
      for (let i = 0; i < 3 && start > 0 && QUOTES.includes(text[start - 1]!); i++) start--
      end = Math.max(lineEnd(sp.end), sp.end)
    }
    if (end <= last) continue
    if (start < last) {
      // 重叠片段直接跳过再起替换
      continue
    }
    const replacement = mode === 'tag' ? `[REDACTED:${sp.tag}]` : '***'
    out += `${text.slice(last, start)}${replacement}`
    last = end
  }
  return out + text.slice(last)
}
