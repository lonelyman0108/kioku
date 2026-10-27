import { z } from 'zod'

import { Layer, Provenance, Sensitivity } from './memory'
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
  // true 只列没写 disclosure 的，false 只列写了的；查询参数是字符串，不做转换，OpenAPI 文档里才写得出来
  missingDisclosure: z.enum(['true', 'false']).optional(),
  sort: MemoryListSort.default('updated'),
  cursor: z.string().max(1000).optional(),
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

export const SpaceOverview = z.object({
  // 成员读得到的策展记忆，按层与敏感级分组
  counts: z.array(LayerCount),
  total: z.number().int(),
  missingDisclosure: z.number().int(),
  embedding: EmbeddingCoverage,
  apps: z.array(OverviewApp),
})
export type SpaceOverview = z.infer<typeof SpaceOverview>
