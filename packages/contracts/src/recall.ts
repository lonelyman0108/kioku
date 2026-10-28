import { z } from 'zod'

import { Layer, Sensitivity } from './memory'

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

// 各路的得分，调试台用：相似度与全文都已压到 0–1，关键词与 priority 是加上去的分
export const RecallBreakdown = z.object({
  semantic: z.number(),
  fulltext: z.number(),
  glossary: z.number(),
  priority: z.number(),
})
export type RecallBreakdown = z.infer<typeof RecallBreakdown>

export const DebugCandidate = RecallCandidate.extend({ breakdown: RecallBreakdown })
export type DebugCandidate = z.infer<typeof DebugCandidate>

export const RecallRequest = z.object({
  query: z.string().min(1).max(4000),
  limit: z.number().int().min(1).max(50).default(8),
})
export type RecallRequest = z.infer<typeof RecallRequest>

export const RecallResponse = z.object({ candidates: z.array(RecallCandidate) })
export type RecallResponse = z.infer<typeof RecallResponse>

// 最近更新的策展记忆：只有 URI 与 disclosure，不含正文，会话开始时列给模型
export const RecentMemory = z.object({
  uri: z.string(),
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  updatedAt: z.string(),
})
export type RecentMemory = z.infer<typeof RecentMemory>

export const BootEntry = z.object({ uri: z.string(), layer: Layer, content: z.string() })
export const BootResponse = z.object({
  entries: z.array(BootEntry),
  // 超出字数预算没放进来的节点，模型可以按需用 kioku_get 读取
  omitted: z.array(z.string()),
})
export type BootResponse = z.infer<typeof BootResponse>

export const LIFECYCLE_EVENTS = ['session.start', 'prompt.submit'] as const
export const LifecycleEventName = z.enum(LIFECYCLE_EVENTS)

// 宿主当前所在的项目：目录名与 git 仓库名。会话开始时用它们召回与当前项目相关的记忆
export const LifecycleProject = z.object({
  dirName: z.string().max(128).optional(),
  repoName: z.string().max(128).optional(),
})
export type LifecycleProject = z.infer<typeof LifecycleProject>

// 按事件区分字段：prompt.submit 缺 prompt 时直接 400，不让插件的字段错误变成悄无声息的「没有召回」
export const LifecycleEvent = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('session.start'),
    sessionId: z.string().max(200).optional(),
    project: LifecycleProject.optional(),
  }),
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

// 一条记忆这次读不到的原因：deleted、expired 已删除或失效；layer 层不在可读范围；sensitivity 超出最高敏感级；
// secret 只能按 URI 显式读取；origin 来源作用域不在范围；owner 别的成员的画像或私人层；persona 不在人格继承链上；
// app 别的应用的应用层；override 被继承链上更近的人格同一相对路径的节点覆盖
export const READ_DENIALS = [
  'deleted',
  'expired',
  'layer',
  'sensitivity',
  'secret',
  'origin',
  'owner',
  'persona',
  'app',
  'override',
] as const
export const ReadDenial = z.enum(READ_DENIALS)
export type ReadDenial = z.infer<typeof ReadDenial>

export const RecallDebugRequest = z.object({ query: z.string().trim().min(1).max(4000) })
export type RecallDebugRequest = z.infer<typeof RecallDebugRequest>

// 召回调试台：按一把 Key 模拟每轮输入时的召回
export const RecallDebug = z.object({
  // 会注入的：和每轮输入时一样，过了阈值的前几条
  injected: z.array(DebugCandidate),
  // 没注入的：没过阈值或排在后面的
  others: z.array(DebugCandidate),
  minScore: z.number(),
  // 注入的 <recall> 块，原样就是宿主收到的文字
  block: z.string(),
  // 这次有没有走向量这一路（嵌入接口没配、出错或超时时没有）
  semantic: z.boolean(),
  // 管理界面里搜得到、这把 Key 却读不到的记忆，以及原因
  filtered: z.array(
    z.object({ uri: z.string(), layer: Layer, sensitivity: Sensitivity, reason: ReadDenial }),
  ),
})
export type RecallDebug = z.infer<typeof RecallDebug>

export const BootPreviewRequest = z.object({
  project: LifecycleProject.optional(),
  // 会话 id 会写进召回块：不给时用一个随机的 UUID，长度和真实会话差不多，临近字数上限时预览才准
  sessionId: z.string().max(200).optional(),
})
export type BootPreviewRequest = z.infer<typeof BootPreviewRequest>

// 启动预览：按一把 Key 模拟会话开始时注入的内容
export const BootPreview = z.object({
  runtimeFamily: z.string(),
  // 宿主能完整接收的字数；没有限制的宿主为 null
  limit: z.number().int().nullable(),
  // 原样就是宿主收到的文字
  context: z.string(),
  // 展开的启动节点与各自占的字数（含标题）
  entries: z.array(z.object({ uri: z.string(), layer: Layer, chars: z.number().int() })),
  // 超出预算、只列出 URI 的启动节点
  omitted: z.array(z.string()),
  recent: z.array(RecentMemory),
  related: z.array(RecallCandidate),
  // 放不下、没有附上的附加块
  dropped: z.array(z.enum(['recent', 'related'])),
})
export type BootPreview = z.infer<typeof BootPreview>

// 召回事件的来路：会话开始的项目召回、每轮输入的召回、MCP 搜索、REST 召回。管理界面里的搜索与调试不记
export const RECALL_SOURCES = [
  'session.start',
  'prompt.submit',
  'mcp.search',
  'rest.recall',
] as const
export const RecallSource = z.enum(RECALL_SOURCES)
export type RecallSource = z.infer<typeof RecallSource>
