import { z } from 'zod'

import { Layer, PlainLayer, Provenance, Sensitivity } from './memory'

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
// 删除不限最短长度：要能清掉规则收紧之前写入的单字关键词
export const RemovableKeyword = z.string().trim().min(1).max(64)

// 有效到：ISO 8601，要带时区（例如 2026-12-31T23:59:00+08:00）。到了这个时间就不再召回、不进 boot，
// 按 URI 也读不到；历史里照样看得到，管理界面里能让它重新生效。写入时要比现在晚至少一分钟。
// 说明写进 OpenAPI：生成的客户端（例如 Python 的 datetime）不带时区时会被拒绝，要在文档里看得到
const VALID_TO_FORMAT =
  'ISO 8601 的时间，要带时区（例如 2026-12-31T23:59:00+08:00 或 2026-12-31T15:59:00Z），不带时区的会被拒绝；要比现在晚至少一分钟'
export const ValidTo = z.iso.datetime({ offset: true }).describe(VALID_TO_FORMAT)

export const MemoryView = z
  .object({
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
    // 有效到；null 表示一直有效
    validTo: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'MemoryView' })
export type MemoryView = z.infer<typeof MemoryView>

// 树浏览的一个子节点。exists 为 false 表示这一级路径本身没有记忆，只是下面有调用方读得到的后代，
// 像文件系统里的目录一样显示出来；此时 id、layer 等字段为 null
export const MemorySummary = z
  .object({
    uri: z.string(),
    exists: z.boolean(),
    id: z.uuid().nullable(),
    layer: Layer.nullable(),
    sensitivity: Sensitivity.nullable(),
    priority: z.number().int().nullable(),
    disclosure: z.string().nullable(),
    // 这一级下面还有几个可见的下一级路径
    childCount: z.number().int(),
  })
  .meta({ id: 'MemorySummary' })
export type MemorySummary = z.infer<typeof MemorySummary>

export const CreateMemoryRequest = z
  .object({
    uri: MemoryUri,
    content: z.string().min(1).max(20_000),
    // 不填时由 URI 推断：persona:// 与 app:// 按 domain 决定，其余默认 private
    layer: Layer.optional(),
    // 不填时按层取默认值
    sensitivity: Sensitivity.optional(),
    priority: z.number().int().min(0).max(99).default(2),
    disclosure: z.string().max(500).optional(),
    glossary: z.array(Keyword).max(32).default([]),
    // 不填就一直有效
    validTo: ValidTo.optional().describe(
      `有效到：${VALID_TO_FORMAT}。到期后不再召回、不进 boot；不填就一直有效`,
    ),
  })
  .meta({ id: 'CreateMemoryRequest' })
export type CreateMemoryRequest = z.infer<typeof CreateMemoryRequest>

export const UpdateMemoryRequest = z
  .object({
    uri: MemoryUri,
    // 填了就做乐观并发检查，版本不一致返回 409
    expectedVersion: z.number().int().optional(),
    // 填了就核对是不是同一条记忆：删除后在同一个 URI 重建的记忆版本号从 1 重新开始，只看版本号分不出来
    expectedId: z.uuid().optional(),
    content: z.string().min(1).max(20_000).optional(),
    // 改层：只在 base、owner、private 之间；改成人格层或应用层要移动到 persona:// 或 app:// 下
    layer: PlainLayer.optional(),
    sensitivity: Sensitivity.optional(),
    priority: z.number().int().min(0).max(99).optional(),
    disclosure: z.string().max(500).nullable().optional(),
    glossaryAdd: z.array(Keyword).max(32).optional(),
    glossaryRemove: z.array(RemovableKeyword).max(32).optional(),
    // 改有效期；null 清掉，一直有效
    validTo: ValidTo.nullable()
      .optional()
      .describe(`有效到：${VALID_TO_FORMAT}。到期后不再召回、不进 boot；填 null 清掉，一直有效`),
    // 从 secret 降级时正文还像有明文凭据，确认没有、仍要降级。只有管理界面里的空间 owner 能用，Key 不行
    allowPlaintext: z.boolean().optional(),
  })
  .meta({ id: 'UpdateMemoryRequest' })
export type UpdateMemoryRequest = z.infer<typeof UpdateMemoryRequest>

// 移到 persona:// 或 app:// 下时层随 URI 变；从那里移出时要用 layer 指定新的层，
// 普通 domain 之间移动时给了 layer 就顺便改层
export const MoveMemoryRequest = z
  .object({
    from: MemoryUri,
    to: MemoryUri,
    layer: PlainLayer.optional(),
    // 与修改相同：填了就核对 from 上现在是不是这一条、这一版，不是就返回 409
    expectedId: z.uuid().optional(),
    expectedVersion: z.number().int().optional(),
  })
  .meta({ id: 'MoveMemoryRequest' })
export type MoveMemoryRequest = z.infer<typeof MoveMemoryRequest>

export const DomainSummary = z
  .object({ domain: z.string(), count: z.number().int() })
  .meta({ id: 'DomainSummary' })
export type DomainSummary = z.infer<typeof DomainSummary>

export const MemoryChildren = z
  .object({
    // 为 null 表示列的是 domain 根，或这一级路径本身没有可读的记忆
    // 写成并集而不是 .nullable()：OpenAPI 文档里才是 anyOf [$ref, null]，生成客户端的工具认得
    parent: z.union([MemoryView, z.null()]),
    children: z.array(MemorySummary),
    // 这一级超过上限（500 个）时只返回前面的部分
    truncated: z.boolean(),
  })
  .meta({ id: 'MemoryChildren' })
export type MemoryChildren = z.infer<typeof MemoryChildren>
