import { z } from 'zod'

import { MAX_FALLBACK_MODELS, ModelFormat } from './models'
import { ApiKey, BaseUrl, pastedSecret } from './secret'

export { ApiKey, BaseUrl, pastedSecret }

export const EmbeddingChannelView = z.object({
  id: z.string(),
  profileId: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  format: ModelFormat,
  baseUrl: z.string(),
  model: z.string(),
  label: z.string().nullable(),
  hasApiKey: z.boolean(),
})
export type EmbeddingChannelView = z.infer<typeof EmbeddingChannelView>

export const EmbeddingSetupView = z.object({
  model: z.string(),
  profileIds: z.array(z.string()),
  channels: z.array(EmbeddingChannelView),
})
export type EmbeddingSetupView = z.infer<typeof EmbeddingSetupView>

export const EmbeddingSettingsView = z.object({
  dimensions: z.number().int(),
  active: EmbeddingSetupView.nullable(),
  next: EmbeddingSetupView.nullable(),
})
export type EmbeddingSettingsView = z.infer<typeof EmbeddingSettingsView>

export const UpdateEmbeddingSettings = z.object({
  model: z.string().trim().min(1, '请填写模型标识').max(128),
  profileIds: z
    .array(z.string().min(1).max(32))
    .min(1, '至少选择一个嵌入模型')
    .max(MAX_FALLBACK_MODELS, `最多选择 ${MAX_FALLBACK_MODELS} 个备选模型`)
    .refine((ids) => new Set(ids).size === ids.length, '不能重复选择同一模型条目'),
})
export type UpdateEmbeddingSettings = z.infer<typeof UpdateEmbeddingSettings>

export const EmbeddingRebuildResult = z.object({ queued: z.literal(true) })
export type EmbeddingRebuildResult = z.infer<typeof EmbeddingRebuildResult>

export const EmbeddingChannelTest = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int(),
  error: z.string().nullable(),
  similarity: z.number().nullable(),
})
export type EmbeddingChannelTest = z.infer<typeof EmbeddingChannelTest>

export const EmbeddingTestResult = z.object({
  active: z.array(EmbeddingChannelTest).nullable(),
  next: z.array(EmbeddingChannelTest).nullable(),
})
export type EmbeddingTestResult = z.infer<typeof EmbeddingTestResult>

const ModelProgress = z.object({ model: z.string(), embedded: z.number().int() })

export const EmbeddingStatus = z.object({
  eligible: z.number().int(),
  active: ModelProgress.nullable(),
  next: ModelProgress.nullable(),
  lastError: z.object({ model: z.string(), message: z.string(), at: z.string() }).nullable(),
})
export type EmbeddingStatus = z.infer<typeof EmbeddingStatus>

export const MasterKeyStatus = z.object({
  configured: z.boolean(),
  currentId: z.string().nullable(),
  previousId: z.string().nullable(),
  remaining: z.object({
    entries: z.number().int(),
    credentials: z.number().int(),
    vaultConnections: z.number().int(),
    settings: z.number().int(),
  }),
  lastError: z.object({ message: z.string(), at: z.string() }).nullable(),
})
export type MasterKeyStatus = z.infer<typeof MasterKeyStatus>

export const DEFAULT_RECALL_RETENTION_DAYS = 30
export const RecallSettings = z.object({
  retentionDays: z.number().int().min(1).max(365),
})
export type RecallSettings = z.infer<typeof RecallSettings>

export const DEFAULT_RETENTION_DAYS = 30
export const RetentionSettings = z.object({
  days: z.number().int().min(1).max(3650),
})
export type RetentionSettings = z.infer<typeof RetentionSettings>

export const RetentionCounts = z.object({
  deletedEntries: z.number().int(),
  supersededFacts: z.number().int(),
  expiredEpisodes: z.number().int(),
  orphanEvents: z.number().int(),
  scrubbedSnapshots: z.number().int(),
  extractionRuns: z.number().int(),
  credentialEvents: z.number().int(),
  deletedCredentials: z.number().int(),
  dreamRuns: z.number().int().default(0),
  dreamSuggestions: z.number().int().default(0),
  subjectBindings: z.number().int().default(0),
  accessEvents: z.number().int().default(0),
  vaultConnections: z.number().int().default(0),
  departedMembers: z.number().int().default(0),
})
export type RetentionCounts = z.infer<typeof RetentionCounts>

export const RETENTION_DAILY_TRIES = 3

export const RetentionStatus = z.object({
  lastRun: z
    .object({
      at: z.string(),
      days: z.number().int(),
      paused: z.boolean(),
      counts: RetentionCounts,
    })
    .nullable(),
  lastAttempt: z
    .object({
      at: z.string(),
      paused: z.boolean(),
      complete: z.boolean(),
      counts: RetentionCounts,
      tries: z.number().int(),
    })
    .nullable(),
  lastError: z.object({ message: z.string(), at: z.string() }).nullable(),
})
export type RetentionStatus = z.infer<typeof RetentionStatus>

export const RETENTION_PAUSE_REASONS = ['restored', 'started'] as const
export const RetentionPauseReason = z.enum(RETENTION_PAUSE_REASONS)
export type RetentionPauseReason = z.infer<typeof RetentionPauseReason>

export const RetentionView = RetentionSettings.extend({
  pause: z
    .object({ reason: RetentionPauseReason, since: z.string(), until: z.string() })
    .nullable(),
  status: RetentionStatus,
})
export type RetentionView = z.infer<typeof RetentionView>

export const RetentionResumed = RetentionView.extend({ queued: z.boolean() })
export type RetentionResumed = z.infer<typeof RetentionResumed>

const BackupRun = z.object({
  at: z.string(),
  object: z.string(),
  bytes: z.number().int(),
})

export const BackupStatus = z.object({
  lastSuccess: BackupRun.nullable(),
  lastError: z.object({ message: z.string(), at: z.string() }).nullable(),
})
export type BackupStatus = z.infer<typeof BackupStatus>

export const BackupSettingsView = z.object({
  configured: z.boolean(),
  endpoint: z.string().nullable(),
  region: z.string().nullable(),
  bucket: z.string().nullable(),
  prefix: z.string().nullable(),
  accessKeyId: z.string().nullable(),
  hasSecret: z.boolean(),
  hour: z.number().int().nullable(),
  keep: z.number().int().nullable(),
  status: BackupStatus,
})
export type BackupSettingsView = z.infer<typeof BackupSettingsView>

const BucketName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    '存储桶名只能包含小写字母、数字、点和连字符，长度 3 到 63 个字符',
  )
const ObjectPrefix = z
  .string()
  .max(200)
  .regex(
    /^([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)?$/,
    '前缀是存储桶中的目录，例如 kioku 或 backups/kioku：只能包含字母、数字和 . _ - /，首尾不带 /',
  )

const StorageEndpoint = BaseUrl.refine(
  (value) => !/[?#]/.test(value),
  '接口地址不能包含 ? 和 # 及其后面的部分',
)

export const UpdateBackupSettings = z.object({
  endpoint: StorageEndpoint,
  region: z.string().min(1).max(64).default('us-east-1'),
  bucket: BucketName,
  prefix: ObjectPrefix.default(''),
  accessKeyId: pastedSecret('Access Key ID').max(256),
  secretAccessKey: pastedSecret('Secret Access Key').max(256).optional(),
  hour: z.number().int().min(0).max(23),
  keep: z.number().int().min(1).max(365),
})
export type UpdateBackupSettings = z.infer<typeof UpdateBackupSettings>

export const BackupObject = z.object({
  object: z.string(),
  bytes: z.number().int(),
  at: z.string(),
})
export type BackupObject = z.infer<typeof BackupObject>

export const BackupObjectList = z.object({ objects: z.array(BackupObject) })
export type BackupObjectList = z.infer<typeof BackupObjectList>

export const BackupTestResult = z.object({ ok: z.boolean(), error: z.string().nullable() })
export type BackupTestResult = z.infer<typeof BackupTestResult>

export const BackupQueued = z.object({ runId: z.string() })
export type BackupQueued = z.infer<typeof BackupQueued>

export const BackupRunStatus = z.object({
  state: z.enum(['queued', 'running', 'finished']),
  outcome: z.enum(['done', 'failed', 'skipped']).nullable(),
})
export type BackupRunStatus = z.infer<typeof BackupRunStatus>

const intIn = (min: number, max: number) => z.number().int().min(min).max(max)
const unit = z
  .number()
  .min(0)
  .max(1)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, '最多两位小数')

export const RecallLimitSetting = intIn(1, 20)
export const MinScoreSetting = unit

// 高级设置：按「内置 → 实例 → 记忆圈 → 接入实例」逐级覆盖
const TUNING_SHAPE = {
  'recall.limit': RecallLimitSetting,
  'recall.minScore': MinScoreSetting,
  // 相关性基础分门槛：达到后才叠加切面亲和调制
  'recall.relevanceFloor': unit,
  'recall.subjectFacts': intIn(0, 20),
  'recall.chatInlineChars': intIn(50, 1000),
  'recallWeights.semantic': unit,
  'recallWeights.fulltext': unit,
  'recallWeights.glossaryFirst': unit,
  'recallWeights.glossaryMore': unit,
  'recallWeights.priority': unit,
  'boot.charBudget': intIn(2000, 40000),
  'boot.summaries.enabled': z.boolean(),
  'boot.summaries.count': intIn(0, 20),
  'boot.recent.enabled': z.boolean(),
  'boot.recent.count': intIn(0, 20),
  'boot.related.enabled': z.boolean(),
  'boot.related.count': intIn(0, 20),
  'extraction.batchTurns': intIn(1, 50),
  'extraction.idleMinutes': intIn(1, 120),
  'extraction.episodeTtlDays': intIn(1, 365),
  'dream.maxCalls': intIn(3, 30),
  'dream.maxSuggestions': intIn(1, 50),
}
export type TuningKey = keyof typeof TUNING_SHAPE

export const TuningValues = z.object(TUNING_SHAPE)
export type TuningValues = z.infer<typeof TuningValues>

export const TUNING_DEFAULTS: TuningValues = {
  'recall.limit': 8,
  'recall.minScore': 0.2,
  'recall.relevanceFloor': 0.12,
  'recall.subjectFacts': 8,
  'recall.chatInlineChars': 300,
  'recallWeights.semantic': 0.6,
  'recallWeights.fulltext': 0.35,
  'recallWeights.glossaryFirst': 0.3,
  'recallWeights.glossaryMore': 0.1,
  'recallWeights.priority': 0.06,
  'boot.charBudget': 16000,
  'boot.summaries.enabled': true,
  'boot.summaries.count': 3,
  'boot.recent.enabled': true,
  'boot.recent.count': 5,
  'boot.related.enabled': true,
  'boot.related.count': 5,
  'extraction.batchTurns': 10,
  'extraction.idleMinutes': 10,
  'extraction.episodeTtlDays': 30,
  'dream.maxCalls': 8,
  'dream.maxSuggestions': 20,
}

export const RECALL_KEYS = [
  'recall.limit',
  'recall.minScore',
  'recall.relevanceFloor',
  'recall.subjectFacts',
  'recall.chatInlineChars',
] as const
export const WEIGHT_KEYS = [
  'recallWeights.semantic',
  'recallWeights.fulltext',
  'recallWeights.glossaryFirst',
  'recallWeights.glossaryMore',
  'recallWeights.priority',
] as const
export const BOOT_KEYS = [
  'boot.charBudget',
  'boot.summaries.enabled',
  'boot.summaries.count',
  'boot.recent.enabled',
  'boot.recent.count',
  'boot.related.enabled',
  'boot.related.count',
] as const
export const EXTRACTION_KEYS = [
  'extraction.batchTurns',
  'extraction.idleMinutes',
  'extraction.episodeTtlDays',
] as const
export const DREAM_KEYS = ['dream.maxCalls', 'dream.maxSuggestions'] as const

export const CLIENT_TUNING_KEYS = [...RECALL_KEYS, ...BOOT_KEYS] as const
export const CIRCLE_TUNING_KEYS = [
  ...CLIENT_TUNING_KEYS,
  ...EXTRACTION_KEYS,
  ...DREAM_KEYS,
] as const
export const TUNING_KEYS = [
  ...RECALL_KEYS,
  ...WEIGHT_KEYS,
  ...BOOT_KEYS,
  ...EXTRACTION_KEYS,
  ...DREAM_KEYS,
] as const satisfies readonly TuningKey[]
export const TuningKeyEnum = z.enum(TUNING_KEYS)

export const PROMPT_SUPPLEMENT_MAX_CHARS = 2000
export const PromptSupplement = z
  .string()
  .refine(
    (s) => [...s].length <= PROMPT_SUPPLEMENT_MAX_CHARS,
    `补充至多 ${PROMPT_SUPPLEMENT_MAX_CHARS} 字`,
  )
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s), '补充不能包含换行与制表符以外的控制字符')
  .refine((s) => !/\p{Cs}/u.test(s), '补充含无法存入数据库的字符')

export const INSTANCE_PROMPT_KEYS = [
  'prompts.agentGuidance',
  'prompts.chatGuidance',
  'prompts.extractionRules',
  'prompts.dreamRules',
] as const
export const CIRCLE_PROMPT_KEYS = ['prompts.extractionRules', 'prompts.dreamRules'] as const
export const CLIENT_PROMPT_KEYS = ['prompts.guidance'] as const
export type InstancePromptKey = (typeof INSTANCE_PROMPT_KEYS)[number]

type Shape = Record<string, z.ZodType>
const pickTuning = <K extends TuningKey>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, TUNING_SHAPE[k]])) as Pick<typeof TUNING_SHAPE, K>
const promptShape = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, PromptSupplement])) as Record<K, typeof PromptSupplement>
const optionalShape = <S extends Shape>(shape: S) =>
  Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof S]: z.ZodOptional<S[K]>
  }
const patchOf = <S extends Shape>(shape: S) =>
  z.strictObject(
    Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.nullable().optional()])) as {
      [K in keyof S]: z.ZodOptional<z.ZodNullable<S[K]>>
    },
  )

const INSTANCE_SHAPE = { ...pickTuning(TUNING_KEYS), ...promptShape(INSTANCE_PROMPT_KEYS) }
const CIRCLE_SHAPE = { ...pickTuning(CIRCLE_TUNING_KEYS), ...promptShape(CIRCLE_PROMPT_KEYS) }
const CLIENT_SHAPE = { ...pickTuning(CLIENT_TUNING_KEYS), ...promptShape(CLIENT_PROMPT_KEYS) }

export const InstanceAdvanced = z.object(optionalShape(INSTANCE_SHAPE))
export type InstanceAdvanced = z.infer<typeof InstanceAdvanced>
export const CircleAdvanced = z.object(optionalShape(CIRCLE_SHAPE))
export type CircleAdvanced = z.infer<typeof CircleAdvanced>
export const ClientAdvanced = z.object(optionalShape(CLIENT_SHAPE))
export type ClientAdvanced = z.infer<typeof ClientAdvanced>

export const UpdateInstanceAdvanced = patchOf(INSTANCE_SHAPE)
export type UpdateInstanceAdvanced = z.infer<typeof UpdateInstanceAdvanced>
export const UpdateCircleAdvanced = patchOf(CIRCLE_SHAPE)
export type UpdateCircleAdvanced = z.infer<typeof UpdateCircleAdvanced>
export const UpdateClientAdvanced = patchOf(CLIENT_SHAPE)
export type UpdateClientAdvanced = z.infer<typeof UpdateClientAdvanced>

export const SettingSource = z.enum(['builtin', 'instance', 'circle', 'client'])
export type SettingSource = z.infer<typeof SettingSource>
export const TuningSources = z.record(TuningKeyEnum, SettingSource)
export type TuningSources = z.infer<typeof TuningSources>

const Count = z.number().int().min(0)

export const InstanceAdvancedView = z.object({
  builtin: TuningValues,
  overrides: InstanceAdvanced,
  effective: TuningValues,
  overriddenBy: z.record(TuningKeyEnum, z.object({ circles: Count, clients: Count })),
  fixedPrompts: z.object(
    Object.fromEntries(INSTANCE_PROMPT_KEYS.map((k) => [k, z.array(z.string())])) as Record<
      InstancePromptKey,
      z.ZodArray<z.ZodString>
    >,
  ),
})
export type InstanceAdvancedView = z.infer<typeof InstanceAdvancedView>

export const ClientAdvancedSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  overrides: ClientAdvanced.omit({ 'prompts.guidance': true }),
  hasGuidance: z.boolean(),
})
export type ClientAdvancedSummary = z.infer<typeof ClientAdvancedSummary>

export const CircleAdvancedView = z.object({
  overrides: CircleAdvanced,
  effective: TuningValues,
  sources: TuningSources,
  instance: TuningValues,
  instancePrompts: z.object({
    'prompts.extractionRules': z.string().nullable(),
    'prompts.dreamRules': z.string().nullable(),
  }),
  fixedPrompts: z.object({
    'prompts.extractionRules': z.array(z.string()),
    'prompts.dreamRules': z.array(z.string()),
  }),
  clients: z.array(ClientAdvancedSummary),
  clientLimits: z.array(z.object({ runtimeFamily: z.string(), chars: z.number().int() })),
  canEdit: z.boolean(),
})
export type CircleAdvancedView = z.infer<typeof CircleAdvancedView>

export const ClientAdvancedView = z.object({
  overrides: ClientAdvanced,
  effective: TuningValues,
  sources: TuningSources,
  inherited: TuningValues,
  guidance: z.object({
    kind: z.enum(['agent', 'chat']),
    fixed: z.string(),
    instance: z.string().nullable(),
  }),
  canEdit: z.boolean(),
})
export type ClientAdvancedView = z.infer<typeof ClientAdvancedView>
