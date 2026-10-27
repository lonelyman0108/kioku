import { z } from 'zod'

import { Layer, PlainLayer, Provenance, Sensitivity } from './memory'
import { RecallCandidate } from './recall'

// 管理界面专用的接口：记忆列表、搜索与空间概览。只按成员本人的权限返回，Key 用不了

export const MEMORY_LIST_SORTS = ['updated', 'priority', 'uri'] as const
export const MemoryListSort = z.enum(MEMORY_LIST_SORTS)
export type MemoryListSort = z.infer<typeof MemoryListSort>

// 所有筛选都是可选的；cursor 是上一页返回的 nextCursor，换了筛选或排序就要从头翻
export const MemoryListQuery = z.object({
  domain: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/, 'domain 格式不对')
    .optional(),
  layer: Layer.optional(),
  sensitivity: Sensitivity.optional(),
  provenance: Provenance.optional(),
  personaId: z.uuid().optional(),
  appId: z.uuid().optional(),
  // 在 URI 与 disclosure 里按子串查找，不区分大小写
  q: z.string().trim().min(1).max(200).optional(),
  // true 只列没写 disclosure 的，false 只列写了的；查询参数按字符串 'true' / 'false' 传
  missingDisclosure: z.enum(['true', 'false']).optional(),
  // 更新时间在这个范围里：不早于 updatedAfter，早于 updatedBefore
  updatedAfter: z.iso.datetime({ offset: true }).optional(),
  updatedBefore: z.iso.datetime({ offset: true }).optional(),
  sort: MemoryListSort.default('updated'),
  // 游标里有上一页最后一条的 URI，最长的 URI 编码后约 1500 个字符
  cursor: z.string().max(4000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type MemoryListQuery = z.infer<typeof MemoryListQuery>

export const MemoryListItem = z.object({
  id: z.uuid(),
  uri: z.string(),
  layer: Layer,
  sensitivity: Sensitivity,
  provenance: Provenance,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  personaId: z.uuid().nullable(),
  appId: z.uuid().nullable(),
  version: z.number().int(),
  updatedAt: z.string(),
})
export type MemoryListItem = z.infer<typeof MemoryListItem>

export const MemoryList = z.object({
  items: z.array(MemoryListItem),
  // 为 null 表示已经是最后一页
  nextCursor: z.string().nullable(),
})
export type MemoryList = z.infer<typeof MemoryList>

export const ConsoleSearchRequest = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(30).default(10),
})
export type ConsoleSearchRequest = z.infer<typeof ConsoleSearchRequest>

// URI 或关键词直接命中的记忆，给快速跳转用
export const MemoryMatch = z.object({
  uri: z.string(),
  layer: Layer,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
})
export type MemoryMatch = z.infer<typeof MemoryMatch>

export const ConsoleSearchResponse = z.object({
  matches: z.array(MemoryMatch),
  // 召回的候选，和接入方的召回同一套打分；永远不含 secret
  candidates: z.array(RecallCandidate),
})
export type ConsoleSearchResponse = z.infer<typeof ConsoleSearchResponse>

export const LayerCount = z.object({
  layer: Layer,
  sensitivity: Sensitivity,
  count: z.number().int(),
})
export type LayerCount = z.infer<typeof LayerCount>

export const EmbeddingCoverage = z.object({
  configured: z.boolean(),
  model: z.string().nullable(),
  // 应当有向量的记忆：没删除、不是 secret、有正文的策展记忆
  eligible: z.number().int(),
  // 其中已经有当前模型向量的
  embedded: z.number().int(),
})
export type EmbeddingCoverage = z.infer<typeof EmbeddingCoverage>

export const OverviewApp = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  runtimeFamily: z.string(),
  ownerAccountId: z.uuid(),
  // 只有应用主人与空间 owner 能看到 Key 的情况，其他人为 null
  keys: z
    .object({
      active: z.number().int(),
      lastUsedAt: z.string().nullable(),
    })
    .nullable(),
})
export type OverviewApp = z.infer<typeof OverviewApp>

// 历史里的一个版本：事件前后记下的整条记忆里，界面要用的部分。secret 的快照没有正文
export const MemorySnapshot = z.object({
  uri: z.string(),
  layer: Layer,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  glossary: z.array(z.string()),
  content: z.string().nullable(),
  version: z.number().int(),
  deleted: z.boolean(),
})
export type MemorySnapshot = z.infer<typeof MemorySnapshot>

// 谁做的：管理界面里是成员，通过 Key 写入时是 Key 与它所属的应用
export const EventActor = z.object({
  accountName: z.string().nullable(),
  keyName: z.string().nullable(),
  appName: z.string().nullable(),
})
export type EventActor = z.infer<typeof EventActor>

// 事件类型：create、import、update、move、delete、expire（让出 URI 的过期记录）、restore、undelete
export const HistoryEvent = z.object({
  id: z.number().int(),
  type: z.string(),
  provenance: Provenance,
  createdAt: z.string(),
  actor: EventActor,
  before: MemorySnapshot.nullable(),
  after: MemorySnapshot.nullable(),
  // 这次改动之后，这条记忆离开了你的可见范围（例如被改进了别的成员的私人层，或改成了 secret）：
  // 只给改前的版本，after 为 null，也不能拿来恢复
  left: z.boolean(),
})
export type HistoryEvent = z.infer<typeof HistoryEvent>

export const MemoryHistoryQuery = z.object({ id: z.uuid() })

export const MemoryHistory = z.object({
  memory: z.object({
    id: z.uuid(),
    uri: z.string(),
    layer: Layer,
    sensitivity: Sensitivity,
    version: z.number().int(),
    deletedAt: z.string().nullable(),
  }),
  // 从早到晚；成员看不到的版本所在的事件不列出
  events: z.array(HistoryEvent),
  // 事件太多时只列最近的那些，更早的没有列出
  truncated: z.boolean(),
})
export type MemoryHistory = z.infer<typeof MemoryHistory>

export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type PageQuery = z.infer<typeof PageQuery>

export const DeletedMemory = z.object({
  id: z.uuid(),
  uri: z.string(),
  layer: Layer,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  version: z.number().int(),
  deletedAt: z.string(),
})
export type DeletedMemory = z.infer<typeof DeletedMemory>

export const DeletedMemoryList = z.object({
  items: z.array(DeletedMemory),
  nextCursor: z.string().nullable(),
})
export type DeletedMemoryList = z.infer<typeof DeletedMemoryList>

export const ActivityItem = z.object({
  id: z.number().int(),
  type: z.string(),
  memoryId: z.uuid(),
  // 记忆现在的 URI；离开了你的可见范围的（left 为 true），是改动之前的 URI
  uri: z.string(),
  createdAt: z.string(),
  actor: EventActor,
  // 这次改了哪些字段：content、disclosure、priority、sensitivity、layer、uri、glossary；离开的事件为空
  changes: z.array(z.string()),
  // 见 HistoryEvent.left
  left: z.boolean(),
  // 记忆现在已经删除（包括过期后让出 URI 的）：那个 URI 上可能已经是别的记忆了。离开了可见范围的一律为 false
  deleted: z.boolean(),
})
export type ActivityItem = z.infer<typeof ActivityItem>

export const ActivityList = z.object({
  items: z.array(ActivityItem),
  nextCursor: z.string().nullable(),
})
export type ActivityList = z.infer<typeof ActivityList>

// 恢复到某个事件之后的那一版：只改正文、disclosure、priority 与关键词。
// expectedVersion 是界面上看到的当前版本号，期间被改过就返回 409
export const RestoreRequest = z.object({
  memoryId: z.uuid(),
  eventId: z.number().int().positive(),
  expectedVersion: z.number().int(),
})
export type RestoreRequest = z.infer<typeof RestoreRequest>

// 成员看得到的记忆的关键词：阅读正文时，出现别的记忆的关键词就标出来、点了跳过去
export const GlossaryIndex = z.object({
  entries: z.array(z.object({ keyword: z.string(), uris: z.array(z.string()) })),
  // 关键词太多时只给前面的一部分
  truncated: z.boolean(),
})
export type GlossaryIndex = z.infer<typeof GlossaryIndex>

export const UndeleteRequest = z.object({ memoryId: z.uuid() })
export type UndeleteRequest = z.infer<typeof UndeleteRequest>

export const SpaceOverview = z.object({
  // 成员读得到的策展记忆，按层与敏感级分组
  counts: z.array(LayerCount),
  total: z.number().int(),
  missingDisclosure: z.number().int(),
  embedding: EmbeddingCoverage,
  apps: z.array(OverviewApp),
  // 最近的改动，和活动流同样的可见性
  recent: z.array(ActivityItem),
})
export type SpaceOverview = z.infer<typeof SpaceOverview>

// 空间的 domain 默认层：管理界面新建记忆时按 domain 带出层。只是默认值，通过 Key 写入不受影响
export const DomainLayers = z.object({
  defaults: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'domain 格式不对'), PlainLayer)
    .refine((r) => Object.keys(r).length <= 64, '最多配置 64 个 domain')
    .refine((r) => !('persona' in r) && !('app' in r), 'persona 与 app 的层由 URI 决定，不用配置'),
})
export type DomainLayers = z.infer<typeof DomainLayers>
