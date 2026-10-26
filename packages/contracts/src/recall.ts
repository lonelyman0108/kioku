import { z } from 'zod'

import { Layer } from './memory'

export const RECALL_VIAS = ['semantic', 'fulltext', 'glossary'] as const
export const RecallVia = z.enum(RECALL_VIAS)
export type RecallVia = z.infer<typeof RecallVia>

export const RecallCandidate = z.object({
  uri: z.string(),
  layer: Layer,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  score: z.number(),
  via: z.array(RecallVia),
  // 命中的 glossary 关键词，展示给模型作为线索
  cues: z.array(z.string()),
})
export type RecallCandidate = z.infer<typeof RecallCandidate>

export const RecallRequest = z.object({
  query: z.string().min(1).max(4000),
  limit: z.number().int().min(1).max(50).default(8),
})
export type RecallRequest = z.infer<typeof RecallRequest>

export const RecallResponse = z.object({ candidates: z.array(RecallCandidate) })
export type RecallResponse = z.infer<typeof RecallResponse>

export const BootEntry = z.object({ uri: z.string(), layer: Layer, content: z.string() })
export const BootResponse = z.object({
  entries: z.array(BootEntry),
  // 超出字数预算没放进来的节点，模型可以按需用 kioku_get 读取
  omitted: z.array(z.string()),
})
export type BootResponse = z.infer<typeof BootResponse>

export const LIFECYCLE_EVENTS = ['session.start', 'prompt.submit'] as const
export const LifecycleEventName = z.enum(LIFECYCLE_EVENTS)

// 按事件区分字段：prompt.submit 缺 prompt 时直接 400，不让插件的字段错误变成悄无声息的「没有召回」
export const LifecycleEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('session.start'), sessionId: z.string().max(200).optional() }),
  z.object({
    event: z.literal('prompt.submit'),
    sessionId: z.string().max(200).optional(),
    prompt: z.string().min(1).max(20_000),
  }),
])
export type LifecycleEvent = z.infer<typeof LifecycleEvent>

export const HostOutput = z.object({
  // stdout_json / stdout_text：插件原样写到标准输出；return_value：插件把 value 交给宿主 API
  mode: z.enum(['none', 'stdout_json', 'stdout_text', 'return_value']),
  value: z.unknown(),
})
export type HostOutput = z.infer<typeof HostOutput>

export const LifecycleResponse = z.object({
  hostOutput: HostOutput,
  nodeUris: z.array(z.string()),
})
export type LifecycleResponse = z.infer<typeof LifecycleResponse>
