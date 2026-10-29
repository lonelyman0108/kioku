import { z } from 'zod'

const BaseUrl = z.url({ protocol: /^https?$/, error: '接口地址要以 http:// 或 https:// 开头' })

// 嵌入渠道：同一个模型的一个接口。按顺序请求，前一个出错时换下一个；不同模型的向量不能混着比，所以一组渠道只能是同一个模型
export const EmbeddingChannelView = z.object({
  id: z.string(),
  baseUrl: z.string(),
  // 请求这个接口时用的模型名；服务商给模型改名时只改这里，不用重新生成向量
  model: z.string(),
  hasApiKey: z.boolean(),
})
export type EmbeddingChannelView = z.infer<typeof EmbeddingChannelView>

export const EmbeddingSetupView = z.object({
  // 模型标识：向量按它存，换模型才会变
  model: z.string(),
  channels: z.array(EmbeddingChannelView),
})
export type EmbeddingSetupView = z.infer<typeof EmbeddingSetupView>

export const EmbeddingSettingsView = z.object({
  // 固定值，向量表按它建列；只用于展示
  dimensions: z.number().int(),
  // 召回与写入正在用的模型；还没配置时为 null
  active: EmbeddingSetupView.nullable(),
  // 正在换过去的模型：后台补齐它的向量，召回仍用 active，补齐后切过去
  next: EmbeddingSetupView.nullable(),
})
export type EmbeddingSettingsView = z.infer<typeof EmbeddingSettingsView>

export const EmbeddingChannelInput = z.object({
  // 已有的渠道带上 id：不填 Key 时沿用它保存的 Key（接口主机没变才行）
  id: z.string().min(1).max(32).optional(),
  // OpenAI 兼容接口的根地址，例如 https://api.example.com/v1；只收 http 与 https
  baseUrl: BaseUrl,
  model: z.string().min(1).max(128),
  // 不填表示沿用已保存的 Key；填 null 表示这个渠道不用 Key
  apiKey: z.string().min(1).nullable().optional(),
})
export type EmbeddingChannelInput = z.infer<typeof EmbeddingChannelInput>

export const UpdateEmbeddingSettings = z.object({
  model: z.string().min(1).max(128),
  channels: z.array(EmbeddingChannelInput).min(1).max(5),
})
export type UpdateEmbeddingSettings = z.infer<typeof UpdateEmbeddingSettings>

// 排进了队列才返回；服务没有启动后台任务（例如只提供 API 的测试环境）或入队失败时是 503 与错误信息
export const EmbeddingRebuildResult = z.object({ queued: z.literal(true) })
export type EmbeddingRebuildResult = z.infer<typeof EmbeddingRebuildResult>

export const EmbeddingChannelTest = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int(),
  error: z.string().nullable(),
  // 和同一组里第一个通了的渠道的向量的余弦相似度，低于 0.99 多半不是同一个模型；第一个通了的为 null
  similarity: z.number().nullable(),
})
export type EmbeddingChannelTest = z.infer<typeof EmbeddingChannelTest>

// 逐个渠道请求同一段文本：维度不对算失败
export const EmbeddingTestResult = z.object({
  active: z.array(EmbeddingChannelTest).nullable(),
  next: z.array(EmbeddingChannelTest).nullable(),
})
export type EmbeddingTestResult = z.infer<typeof EmbeddingTestResult>

const ModelProgress = z.object({ model: z.string(), embedded: z.number().int() })

// 整个实例的向量进度：应当有向量的记忆里，各模型已经生成了多少
export const EmbeddingStatus = z.object({
  // 应当有向量的记忆：没删除、不是 secret、有正文的策展记忆
  eligible: z.number().int(),
  active: ModelProgress.nullable(),
  next: ModelProgress.nullable(),
  // 最近一次生成向量出错；之后同一个模型补齐一遍没出错就清掉
  lastError: z.object({ model: z.string(), message: z.string(), at: z.string() }).nullable(),
})
export type EmbeddingStatus = z.infer<typeof EmbeddingStatus>

// 抽取模型：OpenAI 兼容的 chat completions 接口（例如 new-api），在实例设置里配。
// 没配时不从对话里抽取事实，对话缓冲到期后直接丢弃
export const ExtractionSettingsView = z.object({
  configured: z.boolean(),
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  hasApiKey: z.boolean(),
})
export type ExtractionSettingsView = z.infer<typeof ExtractionSettingsView>

export const UpdateExtractionSettings = z.object({
  baseUrl: BaseUrl,
  model: z.string().min(1).max(128),
  // 不填表示沿用已保存的 Key；填 null 表示清除
  apiKey: z.string().min(1).nullable().optional(),
})
export type UpdateExtractionSettings = z.infer<typeof UpdateExtractionSettings>

export const ExtractionTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int(),
  error: z.string().nullable(),
})
export type ExtractionTestResult = z.infer<typeof ExtractionTestResult>

// 主密钥：标识是哈希，推不出密钥本身，用来核对配的是哪一把。轮换期间配着旧的那把，
// 后台把还是旧密钥包装的数据密钥换成新的包装，remaining 都是 0 之后就可以去掉 KIOKU_MASTER_KEY_PREVIOUS
export const MasterKeyStatus = z.object({
  configured: z.boolean(),
  currentId: z.string().nullable(),
  previousId: z.string().nullable(),
  remaining: z.object({
    memories: z.number().int(),
    credentials: z.number().int(),
    settings: z.number().int(),
  }),
  // 轮换出的错（例如有记录用旧主密钥也解不开）；换完之后清掉
  lastError: z.object({ message: z.string(), at: z.string() }).nullable(),
})
export type MasterKeyStatus = z.infer<typeof MasterKeyStatus>

// 召回事件明细保留多少天：清理任务删掉更早的明细，删之前把次数并入每条记忆的累计统计
export const DEFAULT_RECALL_RETENTION_DAYS = 30
export const RecallSettings = z.object({
  retentionDays: z.number().int().min(1).max(365),
})
export type RecallSettings = z.infer<typeof RecallSettings>

// 保留期：删掉的记忆（连同历史、向量、关键词、凭据引用与召回统计）、被推翻的抽取事实、过期的会话摘要，
// 以及抽取记录、Dream 的运行记录与处理过的建议、凭据事件、已删除的凭据与凭据源，过了这么多天由每天一次的清理硬删除。
// 和召回事件明细的保留天数是两回事
export const DEFAULT_RETENTION_DAYS = 30
export const RetentionSettings = z.object({
  days: z.number().int().min(1).max(3650),
})
export type RetentionSettings = z.infer<typeof RetentionSettings>

// 一次清理每一类删了多少
export const RetentionCounts = z.object({
  deletedMemories: z.number().int(),
  supersededFacts: z.number().int(),
  expiredSummaries: z.number().int(),
  // 记忆整行已经不在的历史事件（例如删账号时数据库连带删掉的记忆留下的）
  orphanEvents: z.number().int(),
  // 事件留着、快照里的正文抹掉了的：已删账号的画像层与私人层快照，记忆已经不在的导入事件
  scrubbedSnapshots: z.number().int(),
  extractionRuns: z.number().int(),
  dreamRuns: z.number().int(),
  // Dream 的建议：处理过的（执行或拒绝的）、没处理但已经作废的，涉及的记忆改过、删掉或过期之后清掉
  dreamSuggestions: z.number().int(),
  credentialEvents: z.number().int(),
  deletedCredentials: z.number().int(),
  deletedProviders: z.number().int(),
})
export type RetentionCounts = z.infer<typeof RetentionCounts>

// 一次清理没做完（有一类出错，或者到了时间）时下一个小时再试；同一天（UTC）最多试这么多次，第二天再来
export const RETENTION_DAILY_TRIES = 3

export const RetentionStatus = z.object({
  // 最近一次完整做完的清理：开始的时间、按多少天算的、是不是在暂停中（只清了删账号留下的历史）、每一类删了多少
  lastRun: z
    .object({
      at: z.string(),
      days: z.number().int(),
      paused: z.boolean(),
      counts: RetentionCounts,
    })
    .nullable(),
  // 最近一次尝试，只记它自己做了什么：开始的时间、是不是在暂停中、做完了没有、删了多少，
  // 以及这一天（UTC）同一种（暂停中与否）试到第几次
  lastAttempt: z
    .object({
      at: z.string(),
      paused: z.boolean(),
      complete: z.boolean(),
      counts: RetentionCounts,
      tries: z.number().int(),
    })
    .nullable(),
  // 最近一次清理出的错（有一类没删成也算）；之后整次做完、没出错就清掉
  lastError: z.object({ message: z.string(), at: z.string() }).nullable(),
})
export type RetentionStatus = z.infer<typeof RetentionStatus>

// 暂停按天数的清理的原因：从备份恢复（恢复出的已删除记录早已到期）、保留期第一次生效（升级之前删掉的都还能撤销）
export const RETENTION_PAUSE_REASONS = ['restored', 'started'] as const
export const RetentionPauseReason = z.enum(RETENTION_PAUSE_REASONS)
export type RetentionPauseReason = z.infer<typeof RetentionPauseReason>

export const RetentionView = RetentionSettings.extend({
  // 暂停到起点加上保留天数为止：这段时间里到期的都是起点之前删掉的，留一个完整的保留期去找回。
  // 调保留天数时结束时间跟着变；删账号留下的历史照常清理。没有暂停（或者已经结束）时为 null
  pause: z
    .object({ reason: RetentionPauseReason, since: z.string(), until: z.string() })
    .nullable(),
  status: RetentionStatus,
})
export type RetentionView = z.infer<typeof RetentionView>

// 提前结束暂停之后：queued 为马上排上了一次清理；没排上时下一次定时清理（每小时）照样会做
export const RetentionResumed = RetentionView.extend({ queued: z.boolean() })
export type RetentionResumed = z.infer<typeof RetentionResumed>

// 备份到兼容S3的对象存储：每天到了设定的钟点（UTC）做一份全实例的加密备份传上去，存储桶里只留最近的几份。
// Secret Access Key 用主密钥加密后存库，不返回
const BackupRun = z.object({
  at: z.string(),
  // 存储桶里的对象名
  object: z.string(),
  bytes: z.number().int(),
})

export const BackupStatus = z.object({
  lastSuccess: BackupRun.nullable(),
  // 最近一次出的错（备份没做成，或者做成了但删旧的出错）；之后整次成功就清掉
  lastError: z.object({ message: z.string(), at: z.string() }).nullable(),
})
export type BackupStatus = z.infer<typeof BackupStatus>

export const BackupSettingsView = z.object({
  configured: z.boolean(),
  endpoint: z.string().nullable(),
  region: z.string().nullable(),
  bucket: z.string().nullable(),
  prefix: z.string().nullable(),
  accessKeyId: z.string().nullable(),
  hasSecret: z.boolean(),
  hour: z.number().int().nullable(),
  keep: z.number().int().nullable(),
  status: BackupStatus,
})
export type BackupSettingsView = z.infer<typeof BackupSettingsView>

// 存储桶名按对象存储通行的规则；前缀是存储桶里的目录（可以为空），备份文件放在它下面
const BucketName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    '存储桶名只用小写字母、数字、点和连字符，3 到 63 个字',
  )
const ObjectPrefix = z
  .string()
  .max(200)
  .regex(
    /^([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)?$/,
    '前缀是存储桶里的目录，例如 kioku 或 backups/kioku：只用字母、数字和 . _ - /，首尾不带 /',
  )

// 对象地址是在接口地址后面接上存储桶与对象名拼出来的，接口地址不能带查询串与片段
const StorageEndpoint = BaseUrl.refine(
  (value) => !/[?#]/.test(value),
  '接口地址不要带 ? 和 # 后面的部分',
)

export const UpdateBackupSettings = z.object({
  endpoint: StorageEndpoint,
  region: z.string().min(1).max(64).default('us-east-1'),
  bucket: BucketName,
  prefix: ObjectPrefix.default(''),
  accessKeyId: z.string().min(1).max(256),
  // 不填表示沿用已保存的（接口主机没变时）
  secretAccessKey: z.string().min(1).max(256).optional(),
  // 每天几点（UTC）做备份
  hour: z.number().int().min(0).max(23),
  // 存储桶里留几份，更早的删掉
  keep: z.number().int().min(1).max(365),
})
export type UpdateBackupSettings = z.infer<typeof UpdateBackupSettings>

export const BackupObject = z.object({
  object: z.string(),
  bytes: z.number().int(),
  at: z.string(),
})
export type BackupObject = z.infer<typeof BackupObject>

export const BackupObjectList = z.object({ objects: z.array(BackupObject) })
export type BackupObjectList = z.infer<typeof BackupObjectList>

export const BackupTestResult = z.object({ ok: z.boolean(), error: z.string().nullable() })
export type BackupTestResult = z.infer<typeof BackupTestResult>

// 立即备份排进后台任务后的编号：管理界面按它查这一次做得怎么样
export const BackupQueued = z.object({ runId: z.string() })
export type BackupQueued = z.infer<typeof BackupQueued>

// 一次立即备份的状态：排着、正在做、做完了。做完了的结果：做成、没做成（原因见设置里的最近错误）、
// 没做（开始时设置已经清掉）
export const BackupRunStatus = z.object({
  state: z.enum(['queued', 'running', 'finished']),
  outcome: z.enum(['done', 'failed', 'skipped']).nullable(),
})
export type BackupRunStatus = z.infer<typeof BackupRunStatus>
