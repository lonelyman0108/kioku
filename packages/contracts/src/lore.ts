import { z } from 'zod'

import { Slug } from './auth'
import { CredentialFieldName, PlaintextKind } from './credentials'
import { WhenCondition } from './facets'
import { ShortId } from './links'
import { CircleKind, Sensitivity } from './memory'

// 从 Lore 导入：将 Lore 节点按记忆圈、话题标签、切面与独立人格迁入，并写入 legacy_uris 映射兜底

export const LORE_BACKUP_FORMAT = 'lore-backup-v1' // lint-comments: allow

export const LORE_BACKUP_TABLES = [
  'nodes',
  'memories',
  'edges',
  'paths',
  'glossary_keywords',
] as const

export const LORE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024
export const LORE_FILE_MAX_BYTES = 256 * 1024 * 1024

export const LORE_DEFAULT_PERSONA = { slug: 'default', name: '默认人格' } as const

const Rows = z.array(z.record(z.string(), z.unknown()))

const onlyTrimmed = {
  error: (issue: { code?: string }) =>
    issue.code === 'unrecognized_keys' ? '导出文件含多余内容：只接受裁剪后的五张表' : undefined,
}
export const LoreBackupUpload = z.strictObject(
  {
    format: z.literal(LORE_BACKUP_FORMAT, '不是 Lore 的导出文件'),
    created_at: z.string(),
    tables: z.strictObject(
      {
        nodes: Rows,
        memories: Rows,
        edges: Rows,
        paths: Rows,
        glossary_keywords: Rows,
      },
      onlyTrimmed,
    ),
  },
  onlyTrimmed,
)
export type LoreBackupUpload = z.infer<typeof LoreBackupUpload>

export const LoreImportSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), backup: LoreBackupUpload }),
  z.object({
    kind: z.literal('url'),
    url: z.string().min(1, '请填写 Lore 地址').max(2048, 'Lore 地址过长'),
    token: z.string().max(4096, 'API Token 过长'),
  }),
])
export type LoreImportSource = z.infer<typeof LoreImportSource>

const LoreImportPersona = z.object({
  slug: Slug,
  name: z.string().trim().min(1, '请填写人格名称').max(64, '人格名称最多 64 个字'),
})

export const LoreImportPlanRequest = z.object({
  source: LoreImportSource,
  targetCircleId: z.uuid().optional(),
  persona: LoreImportPersona.optional(),
})
export type LoreImportPlanRequest = z.infer<typeof LoreImportPlanRequest>

const SelectedUris = z.array(z.string().max(2048)).max(100_000).default([])

export const LoreImportApplyRequest = LoreImportPlanRequest.extend({
  fingerprint: z.string().min(1),
  secretUris: SelectedUris,
  excludeUris: SelectedUris,
  confirmStale: z.boolean().default(false),
  convertPlaintext: z
    .array(
      z.object({
        source: z.string().max(2048),
        index: z.number().int().min(0),
        credentialId: z.uuid(),
        field: CredentialFieldName,
      }),
    )
    .max(100_000)
    .default([]),
})
export type LoreImportApplyRequest = z.input<typeof LoreImportApplyRequest>

export const LORE_TARGET_STATES = ['new', 'imported', 'moved'] as const
export const LoreTargetState = z.enum(LORE_TARGET_STATES)
export type LoreTargetState = z.infer<typeof LoreTargetState>

export const LorePlanTarget = z.object({
  legacyUri: z.string(),
  targetCircleKind: CircleKind,
  targetCircleId: z.uuid(),
  title: z.string(),
  topics: z.array(z.string()),
  when: WhenCondition,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  state: LoreTargetState,
  boot: z.boolean(),
  current: z.array(z.object({ shortId: ShortId.nullable(), secret: z.boolean() })),
})
export type LorePlanTarget = z.infer<typeof LorePlanTarget>

export const LorePlaintextSpot = z.object({
  index: z.number().int(),
  line: z.number().int(),
  kind: PlaintextKind,
  credential: z
    .object({ id: z.uuid(), identifier: z.string(), name: z.string(), field: z.string() })
    .nullable(),
})
export type LorePlaintextSpot = z.infer<typeof LorePlaintextSpot>

export const LorePlanNode = z.object({
  uuid: z.string(),
  uri: z.string(),
  aliases: z.array(z.string()),
  targets: z.array(LorePlanTarget),
  credentialRefs: z.array(z.string()),
  credentialHints: z.object({ path: z.boolean(), content: z.boolean(), extras: z.boolean() }),
  plaintext: z.array(LorePlaintextSpot),
})
export type LorePlanNode = z.infer<typeof LorePlanNode>

export const LORE_WARNING_KINDS = [
  'credentialPath',
  'credentialContent',
  'credentialExtras',
  'secretExtras',
  'disclosureTruncated',
] as const
export const LoreWarningKind = z.enum(LORE_WARNING_KINDS)
export type LoreWarningKind = z.infer<typeof LoreWarningKind>

export const LORE_SYNC_STATES = [
  'update',
  'current',
  'edited',
  'moved',
  'deleted',
  'skipped',
  'unmapped',
  'unreadable',
] as const
export const LoreSyncState = z.enum(LORE_SYNC_STATES)
export type LoreSyncState = z.infer<typeof LoreSyncState>

export const LORE_SYNC_CHANGES = ['content', 'title', 'priority', 'disclosure', 'glossary'] as const
export const LoreSyncChange = z.enum(LORE_SYNC_CHANGES)
export type LoreSyncChange = z.infer<typeof LoreSyncChange>

export const LoreSyncItem = z.object({
  source: z.string(),
  legacyUri: z.string(),
  shortId: ShortId,
  title: z.string(),
  state: LoreSyncState,
  target: z.string().optional(),
  reason: z.string().optional(),
  changes: z.array(LoreSyncChange),
})
export type LoreSyncItem = z.infer<typeof LoreSyncItem>

export const LoreImportPlan = z.object({
  exportedAt: z.string(),
  dataTime: z.string().nullable(),
  staleSince: z.string().nullable(),
  nodeCount: z.number().int(),
  previousVersions: z.number().int(),
  fingerprint: z.string(),
  secretAvailable: z.boolean(),
  credentialMatch: z
    .object({
      unavailableConnections: z.number().int(),
      unreadableCredentials: z.number().int(),
    })
    .nullable(),
  persona: z.object({
    slug: z.string(),
    name: z.string(),
    exists: z.boolean(),
    imported: z.array(z.string()),
  }),
  clients: z.array(
    z.object({
      runtime: z.string(),
      clients: z.array(
        z.object({ slug: z.string(), create: z.boolean(), runtimeFamily: z.string() }),
      ),
    }),
  ),
  clientsGivenPersona: z.array(z.string()),
  clientsOtherPersona: z.array(z.string()),
  nodes: z.array(LorePlanNode),
  skipped: z.array(z.object({ source: z.string(), reason: z.string() })),
  droppedKeywords: z.array(
    z.object({ source: z.string(), keyword: z.string(), reason: z.string() }),
  ),
  warnings: z.array(z.object({ legacyUri: z.string(), kind: LoreWarningKind })),
  sync: z.object({
    items: z.array(LoreSyncItem),
    goneFromLore: z.array(z.string()),
  }),
})
export type LoreImportPlan = z.infer<typeof LoreImportPlan>

const LoreFailure = z.object({ source: z.string(), reason: z.string() })

export const LoreImportResult = z.object({
  personaUsed: z.boolean(),
  personaCreated: z.boolean(),
  clientsCreated: z.array(z.string()),
  clientsGivenPersona: z.array(z.string()),
  clientsOtherPersona: z.array(z.string()),
  created: z.array(ShortId),
  previouslyImported: z.array(ShortId),
  secretAlreadyImported: z.array(z.object({ legacyUri: z.string(), shortId: ShortId })),
  movedInLore: z.array(z.object({ legacyUri: z.string(), shortId: ShortId.nullable() })),
  failed: z.array(LoreFailure),
  sync: z.object({ updated: z.array(ShortId), failed: z.array(LoreFailure) }),
  plaintextConverted: z.array(ShortId).default([]),
  plaintextKept: z.array(LoreFailure).default([]),
})
export type LoreImportResult = z.infer<typeof LoreImportResult>
