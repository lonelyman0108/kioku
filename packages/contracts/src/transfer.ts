import { z } from 'zod'

import { AllowedRealms } from './auth'
import {
  CredentialDescription,
  CredentialExtraFields,
  CredentialLabel,
  CredentialSecretValue,
  CredentialSlug,
} from './credentials'
import {
  Disclosure,
  EntryContent,
  EntryKind,
  EntryTitle,
  SceneSlugList,
  TopicList,
  ValidTo,
} from './entries'
import { ShortId } from './links'
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

// ---- 轻量明文密钥前缀提醒（服务端导入预览与前端编辑器共用，仅提示、不阻断）----

export interface SecretPrefixMatch {
  label: string
}

const SECRET_PREFIX_RULES: readonly { label: string; pattern: RegExp }[] = [
  { label: '私钥块', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { label: 'AWS 访问凭证', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    label: 'GitHub 令牌',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  { label: 'Slack 令牌', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'OpenAI / 服务密钥', pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: 'Anthropic 密钥', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'Kioku 访问密钥', pattern: /\bkioku_[A-Za-z0-9_-]{16,}\b/ },
]

export function detectSecretPrefixes(content: string): SecretPrefixMatch[] {
  if (!content) return []
  const matched: SecretPrefixMatch[] = []
  for (const rule of SECRET_PREFIX_RULES) {
    if (rule.pattern.test(content)) matched.push({ label: rule.label })
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
  allowedRealms: AllowedRealms.nullable().optional(),
  value: CredentialSecretValue,
  fields: CredentialExtraFields.optional(),
})
export type ExportedCredentialRecord = z.infer<typeof ExportedCredentialRecord>

export const KiokuExportEntry = z.object({
  shortId: ShortId,
  kind: EntryKind.default('entry'),
  title: EntryTitle,
  content: EntryContent,
  disclosure: Disclosure.nullable().optional(),
  isPinned: z.boolean().default(false),
  envs: SceneSlugList.default([]),
  realms: SceneSlugList.default([]),
  projects: SceneSlugList.default([]),
  runtimes: SceneSlugList.default([]),
  topics: TopicList.default([]),
  deviceKey: z.string().max(128).nullable().optional(),
  projectSlug: z.string().max(128).nullable().optional(),
  validTo: ValidTo.nullable().optional(),
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
