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

export const EmbeddingTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int(),
  error: z.string().nullable(),
})
export type EmbeddingTestResult = z.infer<typeof EmbeddingTestResult>
