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

// 立即备份排上队的时间（服务器时间）：之后开始的那一次有了结果，最近一次成功或出错的时间就不早于它
export const BackupQueued = z.object({ queuedAt: z.string() })
export type BackupQueued = z.infer<typeof BackupQueued>
