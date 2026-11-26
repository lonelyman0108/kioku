import { z } from 'zod'

export const EXPORT_FORMATS = ['json', 'markdown'] as const
export const ExportFormat = z.enum(EXPORT_FORMATS)
export type ExportFormat = z.infer<typeof ExportFormat>

export const MODEL_KINDS = ['embedding', 'chat_llm'] as const
export const ModelKind = z.enum(MODEL_KINDS)
export type ModelKind = z.infer<typeof ModelKind>

export const REASONING_EFFORTS = ['default', 'off', 'low', 'medium', 'high'] as const
export const ReasoningEffort = z.enum(REASONING_EFFORTS)
export type ReasoningEffort = z.infer<typeof ReasoningEffort>

export const TaskReasoningEffort = z.object({
  fast: ReasoningEffort.optional(),
  organize: ReasoningEffort.optional(),
})
export type TaskReasoningEffort = z.infer<typeof TaskReasoningEffort>

const ModelBaseUrl = z
  .string()
  .trim()
  .min(1, '请填写接口地址')
  .max(500, '接口地址最多 500 个字符')
  .refine(
    (v) => /^https?:\/\/[^\s/?#@\\]+(?:\/[^\s?#\\]*)?$/i.test(v),
    '接口地址须以 http:// 或 https:// 开头，不含查询参数与 #',
  )
  .transform((v) => v.replace(/\/+$/, ''))

const ModelName = z
  .string()
  .trim()
  .min(1, '请填写模型名称')
  .max(200, '模型名称最多 200 个字符')
  .regex(/^\P{Cc}*$/u, '模型名称不能含控制字符')

const ModelApiKey = z.string().trim().max(1024, 'API Key 最多 1024 个字符')

export const ModelEndpointConfig = z.object({
  baseUrl: z.string(),
  model: z.string(),
  hasApiKey: z.boolean(),
  enabled: z.boolean(),
  reasoningEffort: ReasoningEffort.optional(),
  taskReasoningEffort: TaskReasoningEffort.optional(),
})
export type ModelEndpointConfig = z.infer<typeof ModelEndpointConfig>

export const ModelEndpointInput = z.object({
  baseUrl: ModelBaseUrl,
  model: ModelName,
  // undefined 表示保留原密钥，null 或空字符串表示清除密钥，非空字符串表示覆盖
  apiKey: ModelApiKey.nullable().optional(),
  enabled: z.boolean().default(true),
  reasoningEffort: ReasoningEffort.optional(),
  taskReasoningEffort: TaskReasoningEffort.nullable().optional(),
})
export type ModelEndpointInput = z.infer<typeof ModelEndpointInput>

export const DREAM_INTERVAL_HOURS_MIN = 1
export const DREAM_INTERVAL_HOURS_MAX = 168
export const DEFAULT_DREAM_INTERVAL_HOURS = 24

export const DreamSettingsConfig = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(DREAM_INTERVAL_HOURS_MIN).max(DREAM_INTERVAL_HOURS_MAX),
})
export type DreamSettingsConfig = z.infer<typeof DreamSettingsConfig>

export const EmbeddingCoverage = z.object({
  total: z.number().int(),
  embedded: z.number().int(),
  model: z.string().nullable(),
})
export type EmbeddingCoverage = z.infer<typeof EmbeddingCoverage>

export const ModelsSettingsResponse = z.object({
  embedding: ModelEndpointConfig.nullable(),
  chatLlm: ModelEndpointConfig.nullable(),
  dream: DreamSettingsConfig,
  embeddingCoverage: EmbeddingCoverage,
  hasMasterKey: z.boolean(),
})
export type ModelsSettingsResponse = z.infer<typeof ModelsSettingsResponse>

export const UpdateModelsSettingsRequest = z.object({
  embedding: ModelEndpointInput.nullable().optional(),
  chatLlm: ModelEndpointInput.nullable().optional(),
  dream: DreamSettingsConfig.partial().optional(),
})
export type UpdateModelsSettingsRequest = z.infer<typeof UpdateModelsSettingsRequest>

export const TestModelRequest = z.object({
  kind: ModelKind,
  baseUrl: ModelBaseUrl,
  model: ModelName,
  apiKey: ModelApiKey.optional(),
  useSavedKey: z.boolean().default(false),
  reasoningEffort: ReasoningEffort.optional(),
})
export type TestModelRequest = z.infer<typeof TestModelRequest>

export const TestModelResponse = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int(),
  dimensions: z.number().int().optional(),
  error: z.string().optional(),
})
export type TestModelResponse = z.infer<typeof TestModelResponse>

export const RebuildEmbeddingsResponse = z.object({
  queued: z.number().int(),
})
export type RebuildEmbeddingsResponse = z.infer<typeof RebuildEmbeddingsResponse>
