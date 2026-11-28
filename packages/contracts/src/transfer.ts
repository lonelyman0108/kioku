import { z } from 'zod'

import { AllowedRealms } from './auth'
import {
  CredentialDescription,
  CredentialExtraFields,
  CredentialFieldMetaList,
  CredentialFieldName,
  CredentialKind,
  CredentialLabel,
  CredentialSecretValue,
  CredentialSlug,
} from './credentials'
import {
  BootMode,
  ChangeSummary,
  Disclosure,
  EntryContent,
  EntryKind,
  EntrySummary,
  EntryTitle,
  SceneSlugList,
  TopicList,
  ValidTo,
} from './entries'
import { extractCredentialPlaceholders, ShortId } from './links'
import { ExportFormat } from './settings'

export const KIOKU_EXPORT_FORMAT = 'kioku-export-json'
export const KIOKU_EXPORT_SCHEMA_VERSION = 2

export const LORE_BACKUP_FORMAT = 'lore-backup-v1' // lint-comments: allow
export const LORE_BACKUP_TABLES = [
  'nodes',
  'memories',
  'edges',
  'paths',
  'glossary_keywords',
] as const

export const TRANSFER_UPLOAD_MAX_BYTES = 32 * 1024 * 1024
export const TRANSFER_PASSPHRASE_MIN = 10
export const TRANSFER_PASSPHRASE_MAX = 256
export const TRANSFER_ENTRIES_MAX = 50_000
export const TRANSFER_CREDENTIALS_MAX = 5_000

// ---- 轻量明文密钥匹配与前缀提醒（服务端导入预览与前端编辑器共用，仅提示、不阻断）----

export interface SecretPrefixMatch {
  label: string
}

export interface SecretMatch {
  label: string
  kind: CredentialKind
  start: number
  end: number
  match: string
  suggestedField: string
}

const SECRET_LABEL_ORDER = [
  '私钥块',
  'AWS 访问凭证',
  'GitHub 令牌',
  'Slack 令牌',
  'OpenAI / 服务密钥',
  'Anthropic 密钥',
  'Kioku 访问密钥',
  '数据库连接串',
  'Bearer JWT 令牌',
] as const

const PEM_HEADER_RE = /-----BEGIN ([A-Z0-9 ]{0,32})PRIVATE KEY-----/g
const PEM_BLOCK_SCAN_MAX = 16_384

const SIMPLE_SECRET_RULES: readonly {
  label: (typeof SECRET_LABEL_ORDER)[number]
  kind: CredentialKind
  suggestedField: string
  pattern: RegExp
}[] = [
  {
    label: 'AWS 访问凭证',
    kind: 'api',
    suggestedField: 'token',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    label: 'GitHub 令牌',
    kind: 'api',
    suggestedField: 'token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    label: 'Slack 令牌',
    kind: 'api',
    suggestedField: 'token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    label: 'Anthropic 密钥',
    kind: 'api',
    suggestedField: 'token',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    label: 'OpenAI / 服务密钥',
    kind: 'api',
    suggestedField: 'token',
    pattern: /\bsk-(?!ant-)(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    label: 'Kioku 访问密钥',
    kind: 'api',
    suggestedField: 'token',
    pattern: /\bkioku_[A-Za-z0-9_-]{16,}\b/g,
  },
]

const DB_CONN_URI_RE =
  /\b(?:postgres(?:ql)?|mysql2?|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/([^/\s:@"'`<>]*):([^/\s@"'`<>]+)@(\[[0-9a-fA-F:]+\]|[^/\s:?#"'`<>]+)(?:[^\s"'`<>)\]]*)/gi
const TRAILING_PUNCT_CHARS = new Set('.,;:!?。，；！？）》」】])')
const BEARER_JWT_RE =
  /\b[Bb]earer[ \t]+(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,})\b/g
const JWT_DOC_SAMPLE_SIG = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

function trimTrailingPunctuation(raw: string): string {
  let end = raw.length
  while (end > 0 && TRAILING_PUNCT_CHARS.has(raw[end - 1]!)) end--
  return end === raw.length ? raw : raw.slice(0, end)
}

const PLACEHOLDER_PASSWORDS = new Set([
  'pass',
  'password',
  'passwd',
  'pwd',
  'secret',
  'secretkey',
  'secret_key',
  'yourpassword',
  'your_password',
  'your-password',
  'mypassword',
  'my_password',
  'my-password',
  'changeme',
  'change_me',
  'change-me',
  'changeit',
  'example',
  'placeholder',
  'replace_me',
  'replace-me',
  'test',
  'testing',
  'demo',
  'dummy',
  'sample',
  'root',
  'admin',
  'user',
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'redis',
  'mongo',
  'mongodb',
  'amqp',
  'guest',
  'kioku',
  '1234',
  '12345',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  'password123',
  'pass123',
  'pass1234',
  'admin123',
])

const PLACEHOLDER_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'host.docker.internal',
  'host',
  'hostname',
  'db-host',
  'db_host',
  'your-host',
  'your_host',
  'example.com',
  'example.org',
  'example.net',
  'test.com',
  'localhost.localdomain',
])

const PLACEHOLDER_HOST_SUFFIXES = [
  '.example.com',
  '.example.org',
  '.example.net',
  '.example',
  '.local',
  '.localhost',
  '.test',
  '.invalid',
] as const

function safeDecodeUriPart(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function isPlaceholderPassword(rawUser: string, rawPassword: string): boolean {
  const decoded = safeDecodeUriPart(rawPassword).trim()
  const lower = decoded.toLowerCase()
  if (lower.length < 4) return true
  if (/^[<${[]/.test(decoded) || decoded.includes('{{') || decoded.includes('}}')) return true
  if (/^[*.xX_\-?]+$/.test(decoded)) return true
  if (PLACEHOLDER_PASSWORDS.has(lower)) return true
  if (
    lower.includes('changeme') ||
    lower.includes('placeholder') ||
    lower.includes('your_pass') ||
    lower.includes('your-pass') ||
    lower.includes('replace_me') ||
    lower.includes('replace-me') ||
    lower.includes('example')
  ) {
    return true
  }
  const userLower = safeDecodeUriPart(rawUser).trim().toLowerCase()
  if (userLower && userLower === lower && lower.length <= 12) return true
  return false
}

function isPlaceholderHost(rawHost: string): boolean {
  const host = rawHost
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase()
  if (!host) return true
  if (PLACEHOLDER_HOSTS.has(host)) return true
  return PLACEHOLDER_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

function overlapsAny(
  start: number,
  end: number,
  ranges: readonly { start: number; end: number }[],
): boolean {
  return ranges.some((r) => start < r.end && end > r.start)
}

export function findSecretMatches(content: string): SecretMatch[] {
  if (!content) return []
  const placeholderRanges = extractCredentialPlaceholders(content).map((p) => ({
    start: p.start,
    end: p.end,
  }))

  const candidates: SecretMatch[] = []

  const pemRe = new RegExp(PEM_HEADER_RE.source, 'g')
  let pemHit: RegExpExecArray | null
  while ((pemHit = pemRe.exec(content)) !== null) {
    const start = pemHit.index
    const keyKind = pemHit[1] ?? ''
    const endMarker = `-----END ${keyKind}PRIVATE KEY-----`
    const searchEnd = Math.min(content.length, start + PEM_BLOCK_SCAN_MAX)
    const endIdx = content.indexOf(endMarker, start + pemHit[0].length)
    const end =
      endIdx !== -1 && endIdx + endMarker.length <= searchEnd
        ? endIdx + endMarker.length
        : start + pemHit[0].length
    if (!overlapsAny(start, end, placeholderRanges)) {
      candidates.push({
        label: '私钥块',
        kind: 'ssh',
        start,
        end,
        match: content.slice(start, end),
        suggestedField: 'private_key',
      })
    }
    pemRe.lastIndex = end
  }

  for (const rule of SIMPLE_SECRET_RULES) {
    const re = new RegExp(rule.pattern.source, 'g')
    let hit: RegExpExecArray | null
    while ((hit = re.exec(content)) !== null) {
      const start = hit.index
      const end = start + hit[0].length
      if (!overlapsAny(start, end, placeholderRanges)) {
        candidates.push({
          label: rule.label,
          kind: rule.kind,
          start,
          end,
          match: hit[0],
          suggestedField: rule.suggestedField,
        })
      }
    }
  }

  const dbRe = new RegExp(DB_CONN_URI_RE.source, 'gi')
  let dbHit: RegExpExecArray | null
  while ((dbHit = dbRe.exec(content)) !== null) {
    const rawFull = dbHit[0]
    const trimmed = trimTrailingPunctuation(rawFull)
    const start = dbHit.index
    const end = start + trimmed.length
    const user = dbHit[1] ?? ''
    const password = dbHit[2] ?? ''
    const host = dbHit[3] ?? ''
    const authSegment = `${user}:${password}@${host}`
    if (authSegment.includes('{{cred:') || authSegment.includes('${')) continue
    if (overlapsAny(start, end, placeholderRanges)) continue
    if (isPlaceholderHost(host) || isPlaceholderPassword(user, password)) continue
    candidates.push({
      label: '数据库连接串',
      kind: 'database',
      start,
      end,
      match: trimmed,
      suggestedField: 'url',
    })
  }

  const jwtRe = new RegExp(BEARER_JWT_RE.source, 'g')
  let jwtHit: RegExpExecArray | null
  while ((jwtHit = jwtRe.exec(content)) !== null) {
    const token = jwtHit[1]!
    const sig = token.split('.')[2] ?? ''
    if (sig === JWT_DOC_SAMPLE_SIG || /^([A-Za-z0-9_-])\1+$/.test(sig)) continue
    const start = jwtHit.index + jwtHit[0].length - token.length
    const end = start + token.length
    if (overlapsAny(start, end, placeholderRanges)) continue
    candidates.push({
      label: 'Bearer JWT 令牌',
      kind: 'api',
      start,
      end,
      match: token,
      suggestedField: 'token',
    })
  }

  candidates.sort((a, b) => a.start - b.start || b.end - a.end)
  const resolved: SecretMatch[] = []
  let lastEnd = -1
  for (const item of candidates) {
    if (item.start < lastEnd) continue
    resolved.push(item)
    lastEnd = item.end
  }
  return resolved
}

export function detectSecretPrefixes(content: string): SecretPrefixMatch[] {
  if (!content) return []
  const labels = new Set(findSecretMatches(content).map((m) => m.label))
  if (!labels.size) return []
  const matched: SecretPrefixMatch[] = []
  for (const label of SECRET_LABEL_ORDER) {
    if (labels.has(label)) matched.push({ label })
  }
  return matched
}

// ---- Kioku 导出与加密凭据包 ----

const Base64String = z
  .string()
  .min(1)
  .max(TRANSFER_UPLOAD_MAX_BYTES)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, '不是合法的 Base64 字符串')

export const ExportPassphrase = z
  .string()
  .min(TRANSFER_PASSPHRASE_MIN, `加密口令至少 ${TRANSFER_PASSPHRASE_MIN} 个字符`)
  .max(TRANSFER_PASSPHRASE_MAX, `加密口令最多 ${TRANSFER_PASSPHRASE_MAX} 个字符`)

export const EncryptedCredentialsBundle = z.object({
  kdf: z.literal('scrypt'),
  params: z.object({
    n: z.number().int().min(16_384).max(131_072),
    r: z.number().int().min(1).max(16),
    p: z.number().int().min(1).max(8),
  }),
  salt: Base64String,
  iv: Base64String,
  tag: Base64String,
  ciphertext: Base64String,
})
export type EncryptedCredentialsBundle = z.infer<typeof EncryptedCredentialsBundle>

export const ExportedCredentialRecord = z.object({
  slug: CredentialSlug,
  label: CredentialLabel,
  description: CredentialDescription.nullable().optional(),
  kind: CredentialKind.optional(),
  primaryField: CredentialFieldName.optional(),
  fieldMeta: CredentialFieldMetaList.optional(),
  passkeyManualOnly: z.boolean().optional(),
  allowedRealms: AllowedRealms.nullable().optional(),
  value: CredentialSecretValue,
  fields: CredentialExtraFields.optional(),
})
export type ExportedCredentialRecord = z.infer<typeof ExportedCredentialRecord>

export const KiokuExportEntry = z.object({
  shortId: ShortId,
  kind: EntryKind.default('entry'),
  title: EntryTitle,
  summary: EntrySummary.nullable().optional(),
  content: EntryContent,
  disclosure: Disclosure.nullable().optional(),
  isPinned: z.boolean().default(false),
  bootMode: BootMode.optional(),
  envs: SceneSlugList.default([]),
  realms: SceneSlugList.default([]),
  projects: SceneSlugList.default([]),
  runtimes: SceneSlugList.default([]),
  topics: TopicList.default([]),
  deviceKey: z.string().max(128).nullable().optional(),
  projectSlug: z.string().max(128).nullable().optional(),
  validTo: ValidTo.nullable().optional(),
  verifiedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  lastChangeSummary: ChangeSummary.nullable().optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
})
export type KiokuExportEntry = z.infer<typeof KiokuExportEntry>

export const KiokuExportBundle = z.object({
  format: z.literal(KIOKU_EXPORT_FORMAT, '不是 Kioku 导出文件'),
  schemaVersion: z.literal(KIOKU_EXPORT_SCHEMA_VERSION, '不支持的导出文件格式版本').optional(),
  exportedAt: z.iso.datetime({ offset: true }),
  count: z.number().int().min(0),
  entries: z.array(KiokuExportEntry).max(TRANSFER_ENTRIES_MAX),
  encryptedCredentials: EncryptedCredentialsBundle.nullable().optional(),
})
export type KiokuExportBundle = z.infer<typeof KiokuExportBundle>

export const ExportDataRequest = z
  .object({
    format: ExportFormat.default('json'),
    includeCredentials: z.boolean().default(false),
    passphrase: z.string().max(TRANSFER_PASSPHRASE_MAX).optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.includeCredentials) return
    if (val.format !== 'json') {
      ctx.addIssue({
        code: 'custom',
        path: ['format'],
        message: '包含加密凭据的导出仅支持 JSON 格式',
      })
      return
    }
    const parsed = ExportPassphrase.safeParse(val.passphrase ?? '')
    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['passphrase'],
        message: parsed.error.issues[0]?.message ?? '请设置加密口令',
      })
    }
  })
export type ExportDataRequest = z.infer<typeof ExportDataRequest>

// ---- Lore 导出文件裁剪格式 ----

const LoreRows = z.array(z.record(z.string(), z.unknown()))
const loreStrictError = {
  error: (issue: { code?: string }) =>
    issue.code === 'unrecognized_keys' ? '导出文件含多余内容：只接受裁剪后的五张表' : undefined,
}

export const LoreBackupUpload = z.strictObject(
  {
    format: z.literal(LORE_BACKUP_FORMAT, '不是 Lore 的导出文件'),
    created_at: z.string(),
    tables: z.strictObject(
      {
        nodes: LoreRows,
        memories: LoreRows,
        edges: LoreRows,
        paths: LoreRows,
        glossary_keywords: LoreRows,
      },
      loreStrictError,
    ),
  },
  loreStrictError,
)
export type LoreBackupUpload = z.infer<typeof LoreBackupUpload>

// ---- 统一两步导入契约（预览 + 确认应用）----

export const IMPORT_CONFLICT_STRATEGIES = ['skip', 'reallocate'] as const
export const ImportConflictStrategy = z.enum(IMPORT_CONFLICT_STRATEGIES)
export type ImportConflictStrategy = z.infer<typeof ImportConflictStrategy>

export const ImportSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('kioku'),
    bundle: KiokuExportBundle,
    includeCredentials: z.boolean().default(false),
    passphrase: z.string().max(TRANSFER_PASSPHRASE_MAX).optional(),
  }),
  z.object({
    kind: z.literal('lore-file'),
    backup: LoreBackupUpload,
  }),
  z.object({
    kind: z.literal('lore-url'),
    url: z.string().trim().min(1, '请填写 Lore 地址').max(2048, 'Lore 地址过长'),
    token: z.string().max(4096, 'API Token 过长').default(''),
  }),
])
export type ImportSource = z.infer<typeof ImportSource>

export const IMPORT_CONFLICT_KINDS = ['none', 'short_id_exists', 'same_title_exists'] as const
export const ImportConflictKind = z.enum(IMPORT_CONFLICT_KINDS)
export type ImportConflictKind = z.infer<typeof ImportConflictKind>

export const ImportPreviewItem = z.object({
  key: z.string(),
  sourceRef: z.string(),
  shortId: ShortId.nullable(),
  kind: EntryKind,
  title: z.string(),
  contentPreview: z.string(),
  secretHintLabels: z.array(z.string()),
  isPinned: z.boolean(),
  bootMode: BootMode.optional(),
  envs: z.array(z.string()),
  realms: z.array(z.string()),
  projects: z.array(z.string()),
  runtimes: z.array(z.string()),
  topics: z.array(z.string()),
  disclosure: z.string().nullable(),
  conflict: ImportConflictKind,
  skippedReason: z.string().nullable(),
})
export type ImportPreviewItem = z.infer<typeof ImportPreviewItem>

export const ImportPreviewCredential = z.object({
  slug: CredentialSlug,
  label: z.string(),
  description: z.string().nullable(),
  kind: CredentialKind.optional(),
  fieldCount: z.number().int().min(0).optional(),
  allowedRealms: z.array(z.string()).nullable(),
  exists: z.boolean(),
})
export type ImportPreviewCredential = z.infer<typeof ImportPreviewCredential>

export const ImportPreviewRequest = z.object({
  source: ImportSource,
})
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequest>

export const ImportPreviewResponse = z.object({
  sourceKind: z.enum(['kioku', 'lore']),
  exportedAt: z.string().nullable(),
  items: z.array(ImportPreviewItem),
  credentials: z.array(ImportPreviewCredential),
  hasEncryptedCredentials: z.boolean(),
  credentialsDecrypted: z.boolean(),
  hasMasterKey: z.boolean(),
  summary: z.object({
    total: z.number().int(),
    ready: z.number().int(),
    conflicts: z.number().int(),
    skipped: z.number().int(),
    credentialTotal: z.number().int(),
    credentialReady: z.number().int(),
    credentialConflicts: z.number().int(),
  }),
})
export type ImportPreviewResponse = z.infer<typeof ImportPreviewResponse>

export const ImportApplyRequest = z.object({
  source: ImportSource,
  conflictStrategy: ImportConflictStrategy.default('skip'),
  excludeKeys: z.array(z.string().max(2048)).max(TRANSFER_ENTRIES_MAX).default([]),
  excludeCredentialSlugs: z.array(CredentialSlug).max(TRANSFER_CREDENTIALS_MAX).default([]),
})
export type ImportApplyRequest = z.infer<typeof ImportApplyRequest>

export const ImportApplyResponse = z.object({
  createdEntries: z.number().int(),
  reallocatedEntries: z.number().int(),
  skippedEntries: z.number().int(),
  createdCredentials: z.number().int(),
  skippedCredentials: z.number().int(),
})
export type ImportApplyResponse = z.infer<typeof ImportApplyResponse>
