import { z } from 'zod'

const BaseUrl = z.url({ protocol: /^https?$/, error: '接口地址须以 http:// 或 https:// 开头' })

// 粘贴来的密钥：去掉首尾的空白（多带一个换行很常见），别的只收可打印的 ASCII（空格到 ~）。换行、零宽字符、全角符号放过去的话，
// 它进请求头时 fetch 直接报错，进签名时算出来的签名对不上，都看不出是密钥的问题。name 是这个密钥叫什么
const pastedSecret = (name: string) =>
  z
    .string()
    .trim()
    .min(1, `${name} 不能只有空白`)
    .regex(
      /^[\x20-\x7e]+$/,
      `${name} 只能包含英文字母、数字和半角符号，请检查粘贴的内容是否含换行、零宽字符或全角符号`,
    )
const ApiKey = pastedSecret('Key')

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
  apiKey: ApiKey.nullable().optional(),
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
  // 应当有向量的记忆：现在有效（没删除、没过期）、不是 secret、有正文的策展记忆，与概览的覆盖率同一个口径
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
  apiKey: ApiKey.nullable().optional(),
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
    // 密码库连接保存的令牌与账户密钥
    vaultConnections: z.number().int(),
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
// 以及抽取记录、凭据事件、已删除的凭据、断开的密码库连接、Dream 的运行记录与处理过的建议、处理完的绑定记录，
// 过了这么多天由每天一次的清理硬删除。和召回事件明细的保留天数是两回事
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
  // 事件留着、快照里的正文抹掉了的：已删账号的本人记忆的快照，记忆已经不在的导入事件
  scrubbedSnapshots: z.number().int(),
  extractionRuns: z.number().int(),
  credentialEvents: z.number().int(),
  deletedCredentials: z.number().int(),
  // 以下几类是后来加的，带默认值：之前记下的清理结果里没有它们，读出来当作 0
  dreamRuns: z.number().int().default(0),
  // Dream 的建议：处理过的（执行或拒绝的）、没处理但已经作废的，涉及的记忆改过、删掉或过期之后清掉
  dreamSuggestions: z.number().int().default(0),
  // 处理完的绑定记录（合并了、确认、拒绝、作废或过期的）
  subjectBindings: z.number().int().default(0),
  // 读到 secret 正文的访问事件：和凭据的访问记录一样按时间清
  accessEvents: z.number().int().default(0),
  // 断开超过保留期、也没有凭据（含已删除的）指着的密码库连接
  vaultConnections: z.number().int().default(0),
  // 离开空间满 30 天的成员：这个空间里他的本人记忆、凭据与密码库连接一起删掉，一个成员算一个
  departedMembers: z.number().int().default(0),
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
    '存储桶名只能包含小写字母、数字、点和连字符，长度 3 到 63 个字符',
  )
const ObjectPrefix = z
  .string()
  .max(200)
  .regex(
    /^([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)?$/,
    '前缀是存储桶中的目录，例如 kioku 或 backups/kioku：只能包含字母、数字和 . _ - /，首尾不带 /',
  )

// 对象地址是在接口地址后面接上存储桶与对象名拼出来的，接口地址不能带查询串与片段
const StorageEndpoint = BaseUrl.refine(
  (value) => !/[?#]/.test(value),
  '接口地址不能包含 ? 和 # 及其后面的部分',
)

export const UpdateBackupSettings = z.object({
  endpoint: StorageEndpoint,
  region: z.string().min(1).max(64).default('us-east-1'),
  bucket: BucketName,
  prefix: ObjectPrefix.default(''),
  accessKeyId: pastedSecret('Access Key ID').max(256),
  // 不填表示沿用已保存的（接口主机没变时）
  secretAccessKey: pastedSecret('Secret Access Key').max(256).optional(),
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

// 高级设置：召回、启动加载、抽取与整理的参数，以及提示词的补充。
// 数值按「内置 → 实例 → 空间 → 应用」逐级覆盖，每一级只存覆盖了的项，缺省沿用上一级；
// 召回与启动加载三级都能覆盖，抽取与整理只到空间，召回权重只在实例。
// 提示词的补充不覆盖、只叠加：代码里的固定部分在前，然后是实例的补充，再然后是空间或应用的补充。
// 设置项用带点的扁平键（「recall.limit」），存储、接口与界面都用同一套键
const intIn = (min: number, max: number) => z.number().int().min(min).max(max)
// 0 到 1，最多两位小数
const unit = z
  .number()
  .min(0)
  .max(1)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, '最多两位小数')

export const RecallLimitSetting = intIn(1, 20)
export const MinScoreSetting = unit

const TUNING_SHAPE = {
  // 每轮召回：过了最低分之后最多注入几条
  'recall.limit': RecallLimitSetting,
  'recall.minScore': MinScoreSetting,
  // 联系人直连：每个联系人最多附几条事实；0 为不附
  'recall.subjectFacts': intIn(0, 20),
  // 读不了正文的宿主（群聊机器人）的召回块每条附多少字正文
  'recall.chatInlineChars': intIn(50, 1000),
  // 各路加到总分上的权重
  'recallWeights.semantic': unit,
  'recallWeights.fulltext': unit,
  'recallWeights.glossaryFirst': unit,
  'recallWeights.glossaryMore': unit,
  'recallWeights.priority': unit,
  // 启动加载展开节点的字数预算；宿主自身有上限时取两者中较小的
  'boot.charBudget': intIn(2000, 40000),
  // 会话开始时附带的三块内容：同一会话的会话摘要、近期更新的记忆、与当前项目相关的记忆
  'boot.summaries.enabled': z.boolean(),
  'boot.summaries.count': intIn(0, 20),
  'boot.recent.enabled': z.boolean(),
  'boot.recent.count': intIn(0, 20),
  'boot.related.enabled': z.boolean(),
  'boot.related.count': intIn(0, 20),
  // 攒满几轮马上抽取；不满时空闲几分钟后抽取；会话摘要留几天
  'extraction.batchTurns': intIn(1, 50),
  'extraction.idleMinutes': intIn(1, 120),
  'extraction.episodeTtlDays': intIn(1, 365),
  // 每次整理最多请求模型几次（其中固定留 2 次给本人的记忆，所以至少 3 次）；每次请求最多收几条建议
  'dream.maxCalls': intIn(3, 30),
  'dream.maxSuggestions': intIn(1, 50),
}
export type TuningKey = keyof typeof TUNING_SHAPE

export const TuningValues = z.object(TUNING_SHAPE)
export type TuningValues = z.infer<typeof TuningValues>

export const TUNING_DEFAULTS: TuningValues = {
  'recall.limit': 8,
  'recall.minScore': 0.2,
  'recall.subjectFacts': 8,
  'recall.chatInlineChars': 300,
  'recallWeights.semantic': 0.6,
  'recallWeights.fulltext': 0.35,
  'recallWeights.glossaryFirst': 0.3,
  'recallWeights.glossaryMore': 0.1,
  'recallWeights.priority': 0.06,
  'boot.charBudget': 16000,
  'boot.summaries.enabled': true,
  'boot.summaries.count': 3,
  'boot.recent.enabled': true,
  'boot.recent.count': 5,
  'boot.related.enabled': true,
  'boot.related.count': 5,
  'extraction.batchTurns': 10,
  'extraction.idleMinutes': 10,
  'extraction.episodeTtlDays': 30,
  'dream.maxCalls': 8,
  'dream.maxSuggestions': 20,
}

const RECALL_KEYS = [
  'recall.limit',
  'recall.minScore',
  'recall.subjectFacts',
  'recall.chatInlineChars',
] as const
const WEIGHT_KEYS = [
  'recallWeights.semantic',
  'recallWeights.fulltext',
  'recallWeights.glossaryFirst',
  'recallWeights.glossaryMore',
  'recallWeights.priority',
] as const
const BOOT_KEYS = [
  'boot.charBudget',
  'boot.summaries.enabled',
  'boot.summaries.count',
  'boot.recent.enabled',
  'boot.recent.count',
  'boot.related.enabled',
  'boot.related.count',
] as const
const EXTRACTION_KEYS = [
  'extraction.batchTurns',
  'extraction.idleMinutes',
  'extraction.episodeTtlDays',
] as const
const DREAM_KEYS = ['dream.maxCalls', 'dream.maxSuggestions'] as const

// 各级能覆盖的数值项
export const APP_TUNING_KEYS = [...RECALL_KEYS, ...BOOT_KEYS] as const
export const SPACE_TUNING_KEYS = [...APP_TUNING_KEYS, ...EXTRACTION_KEYS, ...DREAM_KEYS] as const
export const TUNING_KEYS = [
  ...RECALL_KEYS,
  ...WEIGHT_KEYS,
  ...BOOT_KEYS,
  ...EXTRACTION_KEYS,
  ...DREAM_KEYS,
] as const satisfies readonly TuningKey[]
export const TuningKeyEnum = z.enum(TUNING_KEYS)

export const PROMPT_SUPPLEMENT_MAX_CHARS = 2000
// 提示词的补充：至多 2,000 字（按字符数），换行与制表符以外的控制字符不收，存不进数据库的落单代理项也不收
export const PromptSupplement = z
  .string()
  .refine(
    (s) => [...s].length <= PROMPT_SUPPLEMENT_MAX_CHARS,
    `补充至多 ${PROMPT_SUPPLEMENT_MAX_CHARS} 字`,
  )
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s), '补充不能包含换行与制表符以外的控制字符')
  .refine((s) => !/\p{Cs}/u.test(s), '补充含无法存入数据库的字符')

// 补充的键。实例四段都有；空间只有抽取与整理的规则；应用只有一段使用指引，
// 按应用的运行时接在编码 Agent 或群聊机器人的指引后面
export const INSTANCE_PROMPT_KEYS = [
  'prompts.agentGuidance',
  'prompts.chatGuidance',
  'prompts.extractionRules',
  'prompts.dreamRules',
] as const
export const SPACE_PROMPT_KEYS = ['prompts.extractionRules', 'prompts.dreamRules'] as const
export const APP_PROMPT_KEYS = ['prompts.guidance'] as const
export type InstancePromptKey = (typeof INSTANCE_PROMPT_KEYS)[number]

type Shape = Record<string, z.ZodType>
const pickTuning = <K extends TuningKey>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, TUNING_SHAPE[k]])) as Pick<typeof TUNING_SHAPE, K>
const promptShape = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, PromptSupplement])) as Record<K, typeof PromptSupplement>
const optionalShape = <S extends Shape>(shape: S) =>
  Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof S]: z.ZodOptional<S[K]>
  }
// 修改时只带要改的项，null 为恢复（去掉这一级的覆盖）；不认识的键拒收，不悄悄忽略
const patchOf = <S extends Shape>(shape: S) =>
  z.strictObject(
    Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.nullable().optional()])) as {
      [K in keyof S]: z.ZodOptional<z.ZodNullable<S[K]>>
    },
  )

const INSTANCE_SHAPE = { ...pickTuning(TUNING_KEYS), ...promptShape(INSTANCE_PROMPT_KEYS) }
const SPACE_SHAPE = { ...pickTuning(SPACE_TUNING_KEYS), ...promptShape(SPACE_PROMPT_KEYS) }
const APP_SHAPE = { ...pickTuning(APP_TUNING_KEYS), ...promptShape(APP_PROMPT_KEYS) }

// 各级存下的覆盖：只有覆盖了的项
export const InstanceAdvanced = z.object(optionalShape(INSTANCE_SHAPE))
export type InstanceAdvanced = z.infer<typeof InstanceAdvanced>
export const SpaceAdvanced = z.object(optionalShape(SPACE_SHAPE))
export type SpaceAdvanced = z.infer<typeof SpaceAdvanced>
export const AppAdvanced = z.object(optionalShape(APP_SHAPE))
export type AppAdvanced = z.infer<typeof AppAdvanced>

export const UpdateInstanceAdvanced = patchOf(INSTANCE_SHAPE)
export type UpdateInstanceAdvanced = z.infer<typeof UpdateInstanceAdvanced>
export const UpdateSpaceAdvanced = patchOf(SPACE_SHAPE)
export type UpdateSpaceAdvanced = z.infer<typeof UpdateSpaceAdvanced>
export const UpdateAppAdvanced = patchOf(APP_SHAPE)
export type UpdateAppAdvanced = z.infer<typeof UpdateAppAdvanced>

// 生效值来自哪一级
export const SettingSource = z.enum(['builtin', 'instance', 'space', 'app'])
export type SettingSource = z.infer<typeof SettingSource>
export const TuningSources = z.record(TuningKeyEnum, SettingSource)
export type TuningSources = z.infer<typeof TuningSources>

const Count = z.number().int().min(0)

// 实例：内置值、实例的覆盖、生效值，每项被几个空间、几个应用覆盖，以及四段提示词的固定部分
// （抽取与整理各有两种场景，固定部分按场景列出，补充接在每一种后面）
export const InstanceAdvancedView = z.object({
  builtin: TuningValues,
  overrides: InstanceAdvanced,
  effective: TuningValues,
  overriddenBy: z.record(TuningKeyEnum, z.object({ spaces: Count, apps: Count })),
  fixedPrompts: z.object(
    Object.fromEntries(INSTANCE_PROMPT_KEYS.map((k) => [k, z.array(z.string())])) as Record<
      InstancePromptKey,
      z.ZodArray<z.ZodString>
    >,
  ),
})
export type InstanceAdvancedView = z.infer<typeof InstanceAdvancedView>

// 空间里覆盖了设置的应用：覆盖的数值项与值；使用指引的补充只说有没有，内容在应用的设置里看
export const AppAdvancedSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  overrides: AppAdvanced.omit({ 'prompts.guidance': true }),
  hasGuidance: z.boolean(),
})
export type AppAdvancedSummary = z.infer<typeof AppAdvancedSummary>

// 空间：空间的覆盖，按「内置 → 实例 → 空间」的生效值与来源，实例级的生效值（「沿用实例」显示它），
// 实例的抽取与整理规则的补充（预览全文用），以及有覆盖的应用。canEdit：当前账号是空间所有者
export const SpaceAdvancedView = z.object({
  overrides: SpaceAdvanced,
  effective: TuningValues,
  sources: TuningSources,
  instance: TuningValues,
  instancePrompts: z.object({
    'prompts.extractionRules': z.string().nullable(),
    'prompts.dreamRules': z.string().nullable(),
  }),
  // 抽取与整理规则的固定部分，按场景列出（同实例视图的 fixedPrompts）
  fixedPrompts: z.object({
    'prompts.extractionRules': z.array(z.string()),
    'prompts.dreamRules': z.array(z.string()),
  }),
  apps: z.array(AppAdvancedSummary),
  // 客户端自身能完整接收的字数（不可调）：启动加载的字数预算取它与设置里更小的；没列出的客户端不限
  hostLimits: z.array(z.object({ runtimeFamily: z.string(), chars: z.number().int() })),
  canEdit: z.boolean(),
})
export type SpaceAdvancedView = z.infer<typeof SpaceAdvancedView>

// 应用：应用的覆盖，按四级的生效值与来源，不算应用这一级时的生效值（「沿用空间」显示它），
// 以及使用指引：按应用的运行时是编码 Agent 还是群聊机器人，固定部分与实例的补充。canEdit：当前账号是应用所有者
export const AppAdvancedView = z.object({
  overrides: AppAdvanced,
  effective: TuningValues,
  sources: TuningSources,
  inherited: TuningValues,
  guidance: z.object({
    kind: z.enum(['agent', 'chat']),
    fixed: z.string(),
    instance: z.string().nullable(),
  }),
  canEdit: z.boolean(),
})
export type AppAdvancedView = z.infer<typeof AppAdvancedView>
