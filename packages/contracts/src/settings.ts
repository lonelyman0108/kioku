import { z } from 'zod'

export const EmbeddingSettingsView = z.object({
  configured: z.boolean(),
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  // 固定值，向量表按它建列；只用于展示
  dimensions: z.number().int(),
  hasApiKey: z.boolean(),
})
export type EmbeddingSettingsView = z.infer<typeof EmbeddingSettingsView>

export const UpdateEmbeddingSettings = z.object({
  // OpenAI 兼容接口的根地址，例如 https://api.example.com/v1
  baseUrl: z.url(),
  model: z.string().min(1).max(128),
  // 不填表示沿用已保存的 Key；填 null 表示清除
  apiKey: z.string().min(1).nullable().optional(),
})
export type UpdateEmbeddingSettings = z.infer<typeof UpdateEmbeddingSettings>

// 排进了队列才返回；服务没有启动后台任务（例如只提供 API 的测试环境）或入队失败时是 503 与错误信息
export const EmbeddingRebuildResult = z.object({ queued: z.literal(true) })
export type EmbeddingRebuildResult = z.infer<typeof EmbeddingRebuildResult>

export const EmbeddingTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int(),
  error: z.string().nullable(),
})
export type EmbeddingTestResult = z.infer<typeof EmbeddingTestResult>

// 抽取模型：OpenAI 兼容的 chat completions 接口（例如 new-api），和嵌入接口一样在实例设置里配。
// 没配时不从对话里抽取事实，对话缓冲到期后直接丢弃
export const ExtractionSettingsView = EmbeddingSettingsView.omit({ dimensions: true })
export type ExtractionSettingsView = z.infer<typeof ExtractionSettingsView>

export const UpdateExtractionSettings = UpdateEmbeddingSettings
export type UpdateExtractionSettings = z.infer<typeof UpdateExtractionSettings>

export const ExtractionTestResult = EmbeddingTestResult
export type ExtractionTestResult = z.infer<typeof ExtractionTestResult>

// 召回事件明细保留多少天：清理任务删掉更早的明细，删之前把次数并入每条记忆的累计统计
export const DEFAULT_RECALL_RETENTION_DAYS = 30
export const RecallSettings = z.object({
  retentionDays: z.number().int().min(1).max(365),
})
export type RecallSettings = z.infer<typeof RecallSettings>
