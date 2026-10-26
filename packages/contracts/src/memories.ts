import { z } from 'zod'

import { Layer, Provenance, Sensitivity } from './memory'

// URI = domain://path。domain 是小写标识；path 是用 / 分隔的段，每段小写字母、数字、_ 或 -。
// 两个保留 domain：persona://<人格标识>/... 属于人格层，app://<应用标识>/... 属于应用层。
export const URI_PATTERN =
  /^([a-z][a-z0-9_]{0,31}):\/\/([a-z0-9_-]{1,64}(?:\/[a-z0-9_-]{1,64}){0,15})$/
export const MemoryUri = z
  .string()
  .regex(URI_PATTERN, 'URI 格式应为 domain://path，例如 core://agent')
export const DomainOrUri = z.string().min(1)

// 至少两个字：召回按子串匹配关键词，单字几乎会命中所有提示语
export const Keyword = z.string().trim().min(2, '关键词至少两个字').max(64)

export const MemoryView = z.object({
  id: z.uuid(),
  uri: z.string(),
  layer: Layer,
  sensitivity: Sensitivity,
  provenance: Provenance,
  originScope: z.string(),
  // secret 没有显式读取权限时为 null
  content: z.string().nullable(),
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  glossary: z.array(z.string()),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type MemoryView = z.infer<typeof MemoryView>

export const MemorySummary = MemoryView.pick({
  id: true,
  uri: true,
  layer: true,
  sensitivity: true,
  priority: true,
  disclosure: true,
}).extend({ childCount: z.number().int() })
export type MemorySummary = z.infer<typeof MemorySummary>

export const CreateMemoryRequest = z.object({
  uri: MemoryUri,
  content: z.string().min(1).max(20_000),
  // 不填时由 URI 推断：persona:// 与 app:// 按 domain 决定，其余默认 private
  layer: Layer.optional(),
  // 不填时按层取默认值
  sensitivity: Sensitivity.optional(),
  priority: z.number().int().min(0).max(99).default(2),
  disclosure: z.string().max(500).optional(),
  glossary: z.array(Keyword).max(32).default([]),
})
export type CreateMemoryRequest = z.infer<typeof CreateMemoryRequest>

export const UpdateMemoryRequest = z.object({
  uri: MemoryUri,
  // 填了就做乐观并发检查，版本不一致返回 409
  expectedVersion: z.number().int().optional(),
  content: z.string().min(1).max(20_000).optional(),
  sensitivity: Sensitivity.optional(),
  priority: z.number().int().min(0).max(99).optional(),
  disclosure: z.string().max(500).nullable().optional(),
  glossaryAdd: z.array(Keyword).max(32).optional(),
  glossaryRemove: z.array(Keyword).max(32).optional(),
})
export type UpdateMemoryRequest = z.infer<typeof UpdateMemoryRequest>

export const MoveMemoryRequest = z.object({ from: MemoryUri, to: MemoryUri })
export type MoveMemoryRequest = z.infer<typeof MoveMemoryRequest>

export const DomainSummary = z.object({ domain: z.string(), count: z.number().int() })
export type DomainSummary = z.infer<typeof DomainSummary>

export const MemoryChildren = z.object({
  // 为 null 表示列的是 domain 根
  parent: MemoryView.nullable(),
  children: z.array(MemorySummary),
})
export type MemoryChildren = z.infer<typeof MemoryChildren>
