import { z } from 'zod'

import { Slug } from './auth'
import { Layer, Sensitivity } from './memory'

// 从 Lore 导入（管理界面）：映射、去重与同步的规则和命令行是同一份，数据来源换成 Lore 的导出。
// 文件在浏览器里裁到要用的五张表再上传，地址由服务端拉取。计划不含正文，只给元数据

// Lore 导出文件的格式标识，由 Lore 定，别处都引用这个常量
export const LORE_BACKUP_FORMAT = 'lore-backup-v1' // lint-comments: allow

// 要用的五张表。导出里还有 Lore 的接口 Key（app_settings）、事件与 dream 日记，不离开浏览器
export const LORE_BACKUP_TABLES = [
  'nodes',
  'memories',
  'edges',
  'paths',
  'glossary_keywords',
] as const

// 裁剪之后的请求体上限：只算这五张表，废弃版本也没有正文
export const LORE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024
// 浏览器里选的原始文件上限：裁剪之前要整个读进标签页的内存。默认的导出远小于它，带上召回事件的才可能超过
export const LORE_FILE_MAX_BYTES = 256 * 1024 * 1024

// 人格不给时和命令行相同
export const LORE_DEFAULT_PERSONA = { slug: 'default', name: '默认人格' } as const

// 行里的列由服务端逐个校验（只看用到的列，Lore 不同版本的其余列不管）
const Rows = z.array(z.record(z.string(), z.unknown()))

// 上传的导出：多带别的表或别的顶层字段的直接拒绝
const onlyTrimmed = {
  error: (issue: { code?: string }) =>
    issue.code === 'unrecognized_keys' ? '导出里多带了别的内容：只收裁剪过的五张表' : undefined,
}
export const LoreBackupUpload = z.strictObject(
  {
    format: z.literal(LORE_BACKUP_FORMAT, '不是 Lore 的导出文件'),
    created_at: z.string(),
    tables: z.strictObject(
      {
        nodes: Rows,
        memories: Rows,
        edges: Rows,
        paths: Rows,
        glossary_keywords: Rows,
      },
      onlyTrimmed,
    ),
  },
  onlyTrimmed,
)
export type LoreBackupUpload = z.infer<typeof LoreBackupUpload>

// 来源：上传裁剪过的导出（空间 owner），或者由服务端拉取（还要实例管理员）。Token 不保存；
// 地址的规则由服务端检查，报错不带填写的内容
export const LoreImportSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), backup: LoreBackupUpload }),
  z.object({
    kind: z.literal('url'),
    url: z.string().min(1, '要填 Lore 的地址').max(2048, 'Lore 的地址太长'),
    // Lore 没有设置 API_TOKEN 时可以留空
    token: z.string().max(4096, 'Token 太长'),
  }),
])
export type LoreImportSource = z.infer<typeof LoreImportSource>

const LoreImportPersona = z.object({
  slug: Slug,
  name: z.string().trim().min(1, '要填人格的名称').max(64, '人格的名称最多 64 个字'),
})

export const LoreImportPlanRequest = z.object({
  source: LoreImportSource,
  persona: LoreImportPersona.optional(),
})
export type LoreImportPlanRequest = z.infer<typeof LoreImportPlanRequest>

// 选中的节点按 Lore 的 URI 写（别名也算），对不上任何节点时拒绝执行
const SelectedUris = z.array(z.string().max(2048)).max(100_000).default([])

export const LoreImportApplyRequest = LoreImportPlanRequest.extend({
  // 看过的计划的指纹：重新算出的基准计划和它不一致时返回 409，要重看
  fingerprint: z.string().min(1),
  // 导入为 secret 的节点
  secretUris: SelectedUris,
  // 这次不导入的节点：导入过的就是这次不同步。同时标了 secret 时以这里为准
  excludeUris: SelectedUris,
  // 文件比这个空间已写入的数据旧时，确认仍要写
  confirmStale: z.boolean().default(false),
})
export type LoreImportApplyRequest = z.input<typeof LoreImportApplyRequest>

// 写入目标的状态：新建、导入过（之后在 Kioku 里删除或移动了的也算）、Lore 里换了路径（不在新位置再建）
export const LORE_TARGET_STATES = ['new', 'imported', 'moved'] as const
export const LoreTargetState = z.enum(LORE_TARGET_STATES)
export type LoreTargetState = z.infer<typeof LoreTargetState>

export const LorePlanTarget = z.object({
  uri: z.string(),
  layer: Layer,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  state: LoreTargetState,
  // 按启动上下文的挑选条件算：写进去之后每次会话开始都会注入
  boot: z.boolean(),
  // 之前导入的那些记忆现在的样子，state 为 new 时是空的。在 Kioku 里删除了的 uri 为 null
  current: z.array(z.object({ uri: z.string().nullable(), secret: z.boolean() })),
})
export type LorePlanTarget = z.infer<typeof LorePlanTarget>

export const LorePlanNode = z.object({
  uuid: z.string(),
  // Lore 里的主路径与别名
  uri: z.string(),
  aliases: z.array(z.string()),
  targets: z.array(LorePlanTarget),
  // 正文引用的凭据标识
  credentialRefs: z.array(z.string()),
  // 像不像含凭据：路径、正文、disclosure 或关键词分开看。secret 只加密正文，后两项分开才说得清勾上之后还剩什么
  credentialHints: z.object({ path: z.boolean(), content: z.boolean(), extras: z.boolean() }),
})
export type LorePlanNode = z.infer<typeof LorePlanNode>

export const LORE_WARNING_KINDS = [
  // 路径像凭据，没有标 secret
  'credentialPath',
  // 正文里像有明文凭据，没有标 secret
  'credentialContent',
  // 只有 disclosure 或关键词里像有凭据，没有标 secret
  'credentialExtras',
  // 标了 secret，disclosure 或关键词里像有凭据：这两项仍是明文
  'secretExtras',
  // disclosure 太长，写入时截断
  'disclosureTruncated',
] as const
export const LoreWarningKind = z.enum(LORE_WARNING_KINDS)
export type LoreWarningKind = z.infer<typeof LoreWarningKind>

export const LORE_SYNC_STATES = [
  'update',
  'current',
  'edited',
  'moved',
  'deleted',
  'skipped',
  'unmapped',
  'unreadable',
] as const
export const LoreSyncState = z.enum(LORE_SYNC_STATES)
export type LoreSyncState = z.infer<typeof LoreSyncState>

export const LORE_SYNC_CHANGES = ['content', 'priority', 'disclosure', 'glossary'] as const
export const LoreSyncChange = z.enum(LORE_SYNC_CHANGES)
export type LoreSyncChange = z.infer<typeof LoreSyncChange>

export const LoreSyncItem = z.object({
  source: z.string(),
  // 记忆现在的 URI；在 Kioku 里删除了的是导入时的 URI
  uri: z.string(),
  state: LoreSyncState,
  target: z.string().optional(),
  reason: z.string().optional(),
  changes: z.array(LoreSyncChange),
})
export type LoreSyncItem = z.infer<typeof LoreSyncItem>

export const LoreImportPlan = z.object({
  // 这份数据的导出时间
  exportedAt: z.string(),
  // 这个空间已写入的 Lore 数据的时间（各事件记下的导出时间，命令行写的取事件时间），还没写入过时为 null。
  // 拉取来源读的是现在的 Lore，不用比，总是 null
  dataTime: z.string().nullable(),
  // 文件比 dataTime 旧、又有要写入的内容时是 dataTime：/apply 要带 confirmStale 才执行
  staleSince: z.string().nullable(),
  nodeCount: z.number().int(),
  // 旧版本不迁移，只报个数
  previousVersions: z.number().int(),
  // 指纹算的是不带勾选的这份计划：/apply 时原样带回
  fingerprint: z.string(),
  // 这个实例配了主密钥才能标 secret
  secretAvailable: z.boolean(),
  persona: z.object({
    slug: z.string(),
    name: z.string(),
    exists: z.boolean(),
    // 之前的导入写到过的人格：这次的不在里面时，core://soul 会另写一份，之前那份不再同步
    imported: z.array(z.string()),
  }),
  apps: z.array(
    z.object({
      runtime: z.string(),
      apps: z.array(z.object({ slug: z.string(), create: z.boolean(), runtimeFamily: z.string() })),
    }),
  ),
  // 还没有默认人格、这次会设成导入的人格的应用
  appsGivenPersona: z.array(z.string()),
  // 已经在用别的人格：导入的 core://soul 不会进入它们的启动上下文
  appsOtherPersona: z.array(z.string()),
  nodes: z.array(LorePlanNode),
  skipped: z.array(z.object({ source: z.string(), reason: z.string() })),
  droppedKeywords: z.array(
    z.object({ source: z.string(), keyword: z.string(), reason: z.string() }),
  ),
  warnings: z.array(z.object({ uri: z.string(), kind: LoreWarningKind })),
  sync: z.object({
    items: z.array(LoreSyncItem),
    // 导入过、但 Lore 里已经没有这个节点的记忆：Kioku 里保留
    goneFromLore: z.array(z.string()),
  }),
})
export type LoreImportPlan = z.infer<typeof LoreImportPlan>

const LoreFailure = z.object({ uri: z.string(), reason: z.string() })

export const LoreImportResult = z.object({
  personaCreated: z.boolean(),
  appsCreated: z.array(z.string()),
  appsGivenPersona: z.array(z.string()),
  appsOtherPersona: z.array(z.string()),
  created: z.array(z.string()),
  previouslyImported: z.array(z.string()),
  // 这次要求 secret、但之前导入过而且现在还是明文的：要在管理界面改
  secretAlreadyImported: z.array(z.object({ uri: z.string(), current: z.string() })),
  // URI 已被不是导入产生的记忆占用
  occupied: z.array(z.string()),
  movedInLore: z.array(z.object({ uri: z.string(), current: z.string().nullable() })),
  failed: z.array(LoreFailure),
  sync: z.object({ updated: z.array(z.string()), failed: z.array(LoreFailure) }),
})
export type LoreImportResult = z.infer<typeof LoreImportResult>
