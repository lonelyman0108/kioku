import { z } from 'zod'

import { ApiKey, BaseUrl } from './secret'

// 支持的接口格式：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Gemini 与 Ollama 原生
export const MODEL_FORMATS = [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
  'ollama',
] as const
export const ModelFormat = z.enum(MODEL_FORMATS)
export type ModelFormat = z.infer<typeof ModelFormat>

export const MODEL_PROFILE_KINDS = ['chat', 'embedding'] as const
export const ModelProfileKind = z.enum(MODEL_PROFILE_KINDS)
export type ModelProfileKind = z.infer<typeof ModelProfileKind>

// 各协议支持的能力矩阵：Anthropic 与 OpenAI Responses 不提供嵌入接口
export const FORMAT_CAPABILITIES: Record<ModelFormat, { chat: boolean; embedding: boolean }> = {
  'openai-chat': { chat: true, embedding: true },
  'openai-responses': { chat: true, embedding: false },
  anthropic: { chat: true, embedding: false },
  gemini: { chat: true, embedding: true },
  ollama: { chat: true, embedding: true },
}

export function supportsModelKind(format: ModelFormat, kind: ModelProfileKind): boolean {
  return FORMAT_CAPABILITIES[format][kind]
}

// 统一思考强度档位：default 表示请求不带思考参数，交给上游默认行为
export const THINKING_LEVELS = ['default', 'off', 'minimal', 'low', 'medium', 'high'] as const
export const ThinkingLevel = z.enum(THINKING_LEVELS)
export type ThinkingLevel = z.infer<typeof ThinkingLevel>

// OpenAI Chat 兼容接口下的思考参数风格：auto（默认用 reasoning_effort，default 档不传）、
// reasoning_effort、enable_thinking（通义/DeepSeek/GLM 等布尔开关）、none（强制不传思考参数）
export const THINKING_STYLES = ['auto', 'reasoning_effort', 'enable_thinking', 'none'] as const
export const ThinkingStyle = z.enum(THINKING_STYLES)
export type ThinkingStyle = z.infer<typeof ThinkingStyle>

export const MAX_PROVIDER_PROFILES = 50
export const MAX_FALLBACK_MODELS = 5

const OptionalLabel = z.string().trim().max(80, '别名最多 80 个字符').nullable().optional()
const ModelName = z.string().trim().min(1, '请填写模型名').max(128, '模型名最多 128 个字符')
const ProfileId = z.string().min(1).max(32)

export const ChatModelProfileInput = z.object({
  id: ProfileId.optional(),
  kind: z.literal('chat'),
  label: OptionalLabel,
  model: ModelName,
  thinking: ThinkingLevel.default('default'),
  thinkingStyle: ThinkingStyle.default('auto'),
  maxTokens: z.number().int().min(1).max(1_000_000).nullable().optional(),
})
export type ChatModelProfileInput = z.infer<typeof ChatModelProfileInput>

export const EmbeddingModelProfileInput = z.object({
  id: ProfileId.optional(),
  kind: z.literal('embedding'),
  label: OptionalLabel,
  model: ModelName,
})
export type EmbeddingModelProfileInput = z.infer<typeof EmbeddingModelProfileInput>

export const ModelProfileInput = z.discriminatedUnion('kind', [
  ChatModelProfileInput,
  EmbeddingModelProfileInput,
])
export type ModelProfileInput = z.infer<typeof ModelProfileInput>

export const ChatModelProfileView = z.object({
  id: z.string(),
  kind: z.literal('chat'),
  label: z.string().nullable(),
  model: z.string(),
  thinking: ThinkingLevel,
  thinkingStyle: ThinkingStyle,
  maxTokens: z.number().int().nullable(),
})
export type ChatModelProfileView = z.infer<typeof ChatModelProfileView>

export const EmbeddingModelProfileView = z.object({
  id: z.string(),
  kind: z.literal('embedding'),
  label: z.string().nullable(),
  model: z.string(),
})
export type EmbeddingModelProfileView = z.infer<typeof EmbeddingModelProfileView>

export const ModelProfileView = z.discriminatedUnion('kind', [
  ChatModelProfileView,
  EmbeddingModelProfileView,
])
export type ModelProfileView = z.infer<typeof ModelProfileView>

export const UpsertModelProvider = z
  .object({
    name: z.string().trim().min(1, '请填写服务商名称').max(80, '服务商名称最多 80 个字符'),
    format: ModelFormat,
    baseUrl: BaseUrl,
    // 不填表示沿用已保存的 Key（接口主机未变时）；填 null 表示清除 Key
    apiKey: ApiKey.nullable().optional(),
    profiles: z
      .array(ModelProfileInput)
      .min(1, '至少添加一个模型')
      .max(MAX_PROVIDER_PROFILES, `单个服务商最多添加 ${MAX_PROVIDER_PROFILES} 个模型`),
  })
  .superRefine((input, ctx) => {
    const ids = new Set<string>()
    for (const [index, profile] of input.profiles.entries()) {
      if (!supportsModelKind(input.format, profile.kind)) {
        ctx.addIssue({
          code: 'custom',
          path: ['profiles', index, 'kind'],
          message: `接口格式「${input.format}」不支持嵌入模型`,
        })
      }
      if (profile.id) {
        if (ids.has(profile.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['profiles', index, 'id'],
            message: '模型条目编号重复',
          })
        }
        ids.add(profile.id)
      }
    }
  })
export type UpsertModelProvider = z.infer<typeof UpsertModelProvider>

export const ModelProviderView = z.object({
  id: z.string(),
  name: z.string(),
  format: ModelFormat,
  baseUrl: z.string(),
  hasApiKey: z.boolean(),
  profiles: z.array(ModelProfileView),
})
export type ModelProviderView = z.infer<typeof ModelProviderView>

const uniqueProfileIds = (max: number, min = 0) =>
  z
    .array(ProfileId)
    .min(min, min > 0 ? `至少选择 ${min} 个模型` : undefined)
    .max(max, `最多选择 ${max} 个备选模型`)
    .refine((ids) => new Set(ids).size === ids.length, '不能重复选择同一模型条目')

export const UpdateExtractionBinding = z.object({
  profileIds: uniqueProfileIds(MAX_FALLBACK_MODELS),
})
export type UpdateExtractionBinding = z.infer<typeof UpdateExtractionBinding>

export const DREAM_BINDING_MODES = ['inherit', 'custom'] as const
export const DreamBindingMode = z.enum(DREAM_BINDING_MODES)
export type DreamBindingMode = z.infer<typeof DreamBindingMode>

export const UpdateDreamBinding = z.object({
  mode: DreamBindingMode,
  profileIds: uniqueProfileIds(MAX_FALLBACK_MODELS).default([]),
})
export type UpdateDreamBinding = z.infer<typeof UpdateDreamBinding>

export const PRIVACY_BINDING_MODES = ['off', 'http', 'model'] as const
export const PrivacyBindingMode = z.enum(PRIVACY_BINDING_MODES)
export type PrivacyBindingMode = z.infer<typeof PrivacyBindingMode>

export const UpdatePrivacyBinding = z
  .object({
    mode: PrivacyBindingMode,
    baseUrl: z.string().trim().max(500).nullable().optional(),
    apiKey: ApiKey.nullable().optional(),
    profileIds: uniqueProfileIds(MAX_FALLBACK_MODELS).default([]),
    minScore: z.number().min(0).max(1).default(0.6),
  })
  .superRefine((input, ctx) => {
    if (input.mode === 'http' && !input.baseUrl?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: '请填写隐私识别模型服务地址',
      })
    }
    if (input.mode === 'model' && input.profileIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['profileIds'],
        message: '请至少选择一个对话模型',
      })
    }
  })
export type UpdatePrivacyBinding = z.infer<typeof UpdatePrivacyBinding>

export const ExtractionBindingView = z.object({
  configured: z.boolean(),
  profileIds: z.array(z.string()),
})
export type ExtractionBindingView = z.infer<typeof ExtractionBindingView>

export const DreamBindingView = z.object({
  configured: z.boolean(),
  mode: DreamBindingMode,
  profileIds: z.array(z.string()),
})
export type DreamBindingView = z.infer<typeof DreamBindingView>

export const PrivacyBindingView = z.object({
  mode: PrivacyBindingMode,
  configured: z.boolean(),
  baseUrl: z.string().nullable(),
  hasApiKey: z.boolean(),
  profileIds: z.array(z.string()),
  minScore: z.number().min(0).max(1),
})
export type PrivacyBindingView = z.infer<typeof PrivacyBindingView>

export const ModelBindingsView = z.object({
  extraction: ExtractionBindingView,
  dream: DreamBindingView,
  privacy: PrivacyBindingView,
})
export type ModelBindingsView = z.infer<typeof ModelBindingsView>

export const ModelRegistryView = z.object({
  providers: z.array(ModelProviderView),
  bindings: ModelBindingsView,
})
export type ModelRegistryView = z.infer<typeof ModelRegistryView>

export const ModelProfileTestResult = z.object({
  profileId: z.string().nullable(),
  providerName: z.string().nullable(),
  model: z.string().nullable(),
  ok: z.boolean(),
  latencyMs: z.number().int().min(0),
  error: z.string().nullable(),
  findings: z.number().int().min(0).nullable().optional(),
})
export type ModelProfileTestResult = z.infer<typeof ModelProfileTestResult>

export const ModelChainTestResult = z.object({
  ok: z.boolean(),
  results: z.array(ModelProfileTestResult),
})
export type ModelChainTestResult = z.infer<typeof ModelChainTestResult>
