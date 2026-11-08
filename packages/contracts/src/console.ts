import { z } from 'zod'

import { UriPrefix } from './memories'
import { LAYERS, Layer, Provenance, Sensitivity } from './memory'
import { RecallCandidate } from './recall'
import { SubjectBinding } from './subjects'

// 管理界面专用的接口：记忆列表、搜索与空间概览。只按成员本人的权限返回，Key 用不了

export const MEMORY_LIST_SORTS = ['updated', 'priority', 'uri'] as const
export const MemoryListSort = z.enum(MEMORY_LIST_SORTS)
export type MemoryListSort = z.infer<typeof MemoryListSort>

// 所有筛选都是可选的；cursor 是上一页返回的 nextCursor，换了筛选或排序就要从头翻
export const MemoryListQuery = z.object({
  // 位置：这个坐标前缀本身与它下面各级，例如 user://projects、persona://default
  under: UriPrefix.optional(),
  layer: Layer.optional(),
  sensitivity: Sensitivity.optional(),
  provenance: Provenance.optional(),
  personaId: z.uuid().optional(),
  appId: z.uuid().optional(),
  // 在标题、坐标与 disclosure 里按子串查找，不区分大小写
  q: z.string().trim().min(1).max(200).optional(),
  // true 只列要补 disclosure 的：没写、又不进启动上下文（会进的每次会话开始都注入，不靠它被想起），
  // 和概览的 missingDisclosure 同一个条件；false 列别的那些。查询参数按字符串 'true' / 'false' 传
  missingDisclosure: z.enum(['true', 'false']).optional(),
  // true 只列正文像有明文密码或 Token、提示没被忽略的（规则见 PLAINTEXT_CREDENTIAL；secret 的正文是密文，不算），
  // false 列别的那些，ignored 只列提示被忽略了的
  plaintext: z.enum(['true', 'false', 'ignored']).optional(),
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
  title: z.string(),
  layer: Layer,
  sensitivity: Sensitivity,
  provenance: Provenance,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  personaId: z.uuid().nullable(),
  appId: z.uuid().nullable(),
  version: z.number().int(),
  updatedAt: z.string(),
  // 有效到；null 表示一直有效。列表只列现在有效的，过期的在「已过期」里
  validTo: z.string().nullable(),
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

// 标题、坐标或关键词直接命中的记忆，给快速跳转用
export const MemoryMatch = z.object({
  uri: z.string(),
  title: z.string(),
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
  // 应当有向量的记忆：现在有效（没删除、没过期）、不是 secret、有正文、成员读得到的策展记忆
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
  // 恢复此版本时连标题一起恢复
  title: z.string().nullable(),
  layer: Layer,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  glossary: z.array(z.string()),
  content: z.string().nullable(),
  version: z.number().int(),
  deleted: z.boolean(),
  // 这一版的有效到；null 表示一直有效
  validTo: z.string().nullable(),
})
export type MemorySnapshot = z.infer<typeof MemorySnapshot>

// 谁做的：管理界面里是成员，通过 Key 写入时是 Key 与它所属的应用
export const EventActor = z.object({
  accountName: z.string().nullable(),
  keyName: z.string().nullable(),
  appName: z.string().nullable(),
})
export type EventActor = z.infer<typeof EventActor>

// 这个事件是测试台真实模式写下的：操作的账号（账号已经删掉时为 null）与那次运行的标记
export const BenchMark = z.object({ accountName: z.string().nullable(), run: z.string() })
export type BenchMark = z.infer<typeof BenchMark>

// 事件类型：create、import、update、move、delete、expire（让出 URI 的过期记录）、restore、undelete、
// reactivate（让过期的记忆重新生效）、convert_credential（转存为凭据）、ignore_plaintext、unignore_plaintext、
// access（读到 secret 的正文，只在历史里，不进活动）。access 与忽略明文提示不改记忆，after 为 null
export const HistoryEvent = z.object({
  id: z.number().int(),
  type: z.string(),
  provenance: Provenance,
  createdAt: z.string(),
  actor: EventActor,
  // access 经由哪里：console、export、rest、kioku_get 等；其他事件为 null
  via: z.string().nullable(),
  before: MemorySnapshot.nullable(),
  after: MemorySnapshot.nullable(),
  // 这次改动之后，这条记忆离开了你的可见范围（例如被移进了别的成员的本人，或改成了 secret）：
  // 只给改前的版本，after 为 null，也不能拿来恢复
  left: z.boolean(),
})
export type HistoryEvent = z.infer<typeof HistoryEvent>

export const MemoryHistoryQuery = z.object({ id: z.uuid() })

export const MemoryHistory = z.object({
  memory: z.object({
    id: z.uuid(),
    uri: z.string(),
    title: z.string(),
    layer: Layer,
    sensitivity: Sensitivity,
    version: z.number().int(),
    deletedAt: z.string().nullable(),
    // 有效到；null 表示一直有效。已经过去时这条记忆过期了，不再召回、不进 boot
    validTo: z.string().nullable(),
    // 过期之后让出了 URI（同一个 URI 上写了新的记忆，它被软删除），见 ExpiredMemory.released
    released: z.boolean(),
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

// 用户删掉的记忆（删除时还有效），能撤销删除。删掉之后才到期的也在这里，撤销删除只清删除标记，
// 之后回到已过期里；过期之后被让出 URI 的不在这里，在已过期里重新生效
export const DeletedMemory = z.object({
  id: z.uuid(),
  uri: z.string(),
  title: z.string(),
  layer: Layer,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  version: z.number().int(),
  deletedAt: z.string(),
  // 有效到；null 表示一直有效，已经过去时这条删掉之后又过期了
  validTo: z.string().nullable(),
  // 撤销删除会撞上 URI 冲突（返回 409）：这个 URI 现在被别的记忆占着，要先把那条移走或删掉。
  // 规则和撤销删除时一样，只说被占用、不说是哪条；调用方没有权限撤销的一律为 false
  uriTaken: z.boolean(),
})
export type DeletedMemory = z.infer<typeof DeletedMemory>

// 已删除的记忆过了保留期由每天一次的清理永久删除，之后只能从备份找回。days 是保留天数，所有成员都有；
// paused 是按天数的清理正暂停着（从备份恢复或保留期第一次生效之后，这期间一条都不删），所有成员都有，不带时间；
// pausedUntil 是暂停到什么时候，和实例设置里的保留期一样只给实例管理员（减去天数就是恢复的时间），
// 别人与没有暂停时为 null。一条已删除的记忆最早在「删除时间加保留天数」与暂停结束的时间里晚的那个之后清除；
// 暂停中又不知道到什么时候的，只能说至少还要多久
export const DeletionRetention = z.object({
  days: z.number().int(),
  paused: z.boolean(),
  pausedUntil: z.string().nullable(),
})
export type DeletionRetention = z.infer<typeof DeletionRetention>

export const DeletedMemoryList = z.object({
  items: z.array(DeletedMemory),
  nextCursor: z.string().nullable(),
  retention: DeletionRetention,
})
export type DeletedMemoryList = z.infer<typeof DeletedMemoryList>

// 已过期的记忆：有效期已过、不再召回的策展记忆，能让它重新生效。用户删掉的（删除时还有效）不在这里，在已删除里
export const ExpiredMemory = z.object({
  id: z.uuid(),
  uri: z.string(),
  title: z.string(),
  layer: Layer,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  version: z.number().int(),
  // 什么时候过期的
  expiredAt: z.string(),
  // 过期之后让出了 URI：同一个 URI 上写了新的记忆，它被软删除。重新生效时一并撤销删除；
  // URI 还被那条新的占着时不行，要先把那条移走或删掉
  released: z.boolean(),
  // 让出时软删除的时间，没让出的为 null。让出的和已删除的记忆一样过了保留期永久清除，按这个时间算；
  // 没让出的过期记忆一直留着，由人决定要不要重新生效
  deletedAt: z.string().nullable(),
})
export type ExpiredMemory = z.infer<typeof ExpiredMemory>

export const ExpiredMemoryList = z.object({
  items: z.array(ExpiredMemory),
  nextCursor: z.string().nullable(),
  // 让出了 URI 的什么时候永久清除，见 DeletionRetention
  retention: DeletionRetention,
})
export type ExpiredMemoryList = z.infer<typeof ExpiredMemoryList>

// 变更记录里的事件类型：访问事件（access）不进变更记录，不在这里
export const ACTIVITY_TYPES = [
  'create',
  'import',
  'sync',
  'update',
  'move',
  'delete',
  'expire',
  'restore',
  'undelete',
  'reactivate',
  'confirm',
  'convert_credential',
  'ignore_plaintext',
  'unignore_plaintext',
] as const
export const ActivityType = z.enum(ACTIVITY_TYPES)
export type ActivityType = z.infer<typeof ActivityType>

// 一次改动改了哪些字段
export const ACTIVITY_FIELDS = [
  'content',
  'title',
  'disclosure',
  'priority',
  'sensitivity',
  'layer',
  'uri',
  'glossary',
  'validTo',
] as const
export const ActivityField = z.enum(ACTIVITY_FIELDS)
export type ActivityField = z.infer<typeof ActivityField>
// 按改动的字段筛选时，none 指没有改动任何字段的事件（新建、删除、超出可见范围的等）
export const ActivityFieldFilter = z.enum([...ACTIVITY_FIELDS, 'none'])
export type ActivityFieldFilter = z.infer<typeof ActivityFieldFilter>

// 操作者的标识，筛选与计数按它分组：成员 account:<账号 id>；通过访问密钥写入的按应用分组 app:<应用 id>
// （访问密钥的名字只给应用所有者与空间所有者，所以不按访问密钥分）；测试台写下的 bench；
// 访问密钥连同应用已经删除的，或者没有操作者的，记为 unknown
const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const ACTIVITY_ACTOR_PATTERN = new RegExp(
  `^(?:account:${UUID_TEXT}|app:${UUID_TEXT}|bench|unknown)$`,
)
export const ActivityActorKey = z.string().regex(ACTIVITY_ACTOR_PATTERN, '操作者的写法不对')
export type ActivityActorKey = z.infer<typeof ActivityActorKey>

// 字段的前后值：标量字段给改前与改后；正文只给增删的行数，机密的（有一边看不到正文）两个都是 null；
// 关键词给增删的词
export const ActivityFieldChange = z.discriminatedUnion('field', [
  z.object({
    field: z.literal('content'),
    added: z.number().int().nullable(),
    removed: z.number().int().nullable(),
  }),
  z.object({
    field: z.literal('glossary'),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
  z.object({ field: z.literal('priority'), before: z.number().int(), after: z.number().int() }),
  z.object({ field: z.literal('layer'), before: Layer, after: Layer }),
  z.object({ field: z.literal('sensitivity'), before: Sensitivity, after: Sensitivity }),
  z.object({
    field: z.enum(['title', 'disclosure', 'uri', 'validTo']),
    before: z.string().nullable(),
    after: z.string().nullable(),
  }),
])
export type ActivityFieldChange = z.infer<typeof ActivityFieldChange>

// 多个值的查询参数用逗号连起来写在一个参数里，例如 type=create,update
const commaList = <T extends z.ZodType<unknown, string>>(item: T, max: number) =>
  z
    .string()
    .max(max * 48)
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(item).min(1).max(max))

// 变更记录的跨度最多这么多天（按天计数要一天一行）
export const ACTIVITY_MAX_SPAN_DAYS = 400

// IANA 时区名，例如 Asia/Shanghai、Etc/GMT-8。浏览器给的名字，服务端按它把时间分到天里。
// 只拒绝「+08」「UTC+8」这类裸偏移写法：PostgreSQL 按 POSIX 读它们，正负号和浏览器的意思相反。
// IANA 的 Etc/GMT±N 在浏览器和 PostgreSQL 里是同一个意思（Etc/GMT+8 都是 UTC−8），照收。
// 名字认不认得以 PostgreSQL 的时区库为准（pg_timezone_names），由服务端再查一次，不认识的回 400，
// 错误体带 code（ACTIVITY_UNKNOWN_TIME_ZONE），界面据此退回 UTC
const TIME_ZONE_REGION = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/
export const TimeZoneName = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => tz === 'UTC' || TIME_ZONE_REGION.test(tz), '时区只收地区名，例如 Asia/Shanghai')
export const ACTIVITY_UNKNOWN_TIME_ZONE = 'unknown_time_zone'

// 变更记录的筛选，列表、按天计数与筛选计数共用。时间是不早于 from、早于 to；
// 多个值的参数之间是「或」，各个参数之间是「且」。q 在列表显示的标题与坐标里按子串查找，不区分大小写
const ACTIVITY_FILTER = {
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  actor: commaList(ActivityActorKey, 50).optional(),
  // 不含这些操作者。操作者的全集随数据变，界面上取消勾选的写在这里；和 actor 可以同时给
  exceptActor: commaList(ActivityActorKey, 50).optional(),
  type: commaList(ActivityType, ACTIVITY_TYPES.length).optional(),
  layer: commaList(Layer, LAYERS.length).optional(),
  field: commaList(ActivityFieldFilter, ACTIVITY_FIELDS.length + 1).optional(),
  q: z.string().trim().min(1).max(100).optional(),
}

function checkSpan(
  v: { from?: string | undefined; to?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if (!v.from || !v.to) return
  const span = Date.parse(v.to) - Date.parse(v.from)
  if (span < 0) ctx.addIssue({ code: 'custom', path: ['to'], message: '结束时间不能早于开始时间' })
  // 界面按本地日历截到 400 天，跨过夏令时回拨的 400 个本地日会多出一两个小时：服务端多留一天的余量
  else if (span > (ACTIVITY_MAX_SPAN_DAYS + 1) * 86_400_000) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: `时间跨度最多 ${ACTIVITY_MAX_SPAN_DAYS} 天`,
    })
  }
}

export const ActivityFilter = z.object(ACTIVITY_FILTER).superRefine(checkSpan)
export type ActivityFilter = z.infer<typeof ActivityFilter>

export const ActivityQuery = z
  .object({ ...ACTIVITY_FILTER, ...PageQuery.shape })
  .superRefine(checkSpan)
export type ActivityQuery = z.infer<typeof ActivityQuery>

export const ActivityDaysQuery = z
  .object({ ...ACTIVITY_FILTER, tz: TimeZoneName })
  .superRefine(checkSpan)
export type ActivityDaysQuery = z.infer<typeof ActivityDaysQuery>

// 按天的条数，只列有改动的日子，按日期从早到晚；day 是这个时区里的日期（YYYY-MM-DD）
export const ActivityDays = z.object({
  days: z.array(z.object({ day: z.string(), count: z.number().int() })),
})
export type ActivityDays = z.infer<typeof ActivityDays>

// 筛选计数：每一组在「除了这一组以外的全部筛选」下计算，只列条数不为零的值；total 是全部筛选下的总条数
export const ActivityFacets = z.object({
  total: z.number().int(),
  actors: z.array(
    z.object({
      key: ActivityActorKey,
      kind: z.enum(['account', 'app', 'bench', 'unknown']),
      // 账号的显示名、应用名；测试台、未知的，以及已经删除的账号为 null
      name: z.string().nullable(),
      count: z.number().int(),
    }),
  ),
  types: z.array(z.object({ type: ActivityType, count: z.number().int() })),
  layers: z.array(z.object({ layer: Layer, count: z.number().int() })),
  fields: z.array(z.object({ field: ActivityFieldFilter, count: z.number().int() })),
})
export type ActivityFacets = z.infer<typeof ActivityFacets>

export const ActivityItem = z.object({
  id: z.number().int(),
  type: z.string(),
  memoryId: z.uuid(),
  // 记忆现在的坐标与标题；离开了你的可见范围的（left 为 true），是改动之前的
  uri: z.string(),
  title: z.string(),
  // 记忆现在的归属与敏感级；离开的是改动之前的
  layer: Layer,
  sensitivity: Sensitivity,
  createdAt: z.string(),
  actor: EventActor,
  actorKey: ActivityActorKey,
  // 这次改了哪些字段（ACTIVITY_FIELDS）；离开的事件为空
  changes: z.array(z.string()),
  // 各字段的前后值，和 changes 同一个顺序；离开的事件为空
  fieldChanges: z.array(ActivityFieldChange),
  // 改动前后的版本号，没有的一边为 null；离开的没有改后的
  versionBefore: z.number().int().nullable(),
  versionAfter: z.number().int().nullable(),
  // 见 HistoryEvent.left
  left: z.boolean(),
  // 记忆现在已经删除（包括过期后让出 URI 的）：那个 URI 上可能已经是别的记忆了。离开了可见范围的一律为 false
  deleted: z.boolean(),
  // 记忆现在已经过期：按 URI 读不到它，那个 URI 上可能是别的成员的记忆。离开了可见范围的一律为 false
  expired: z.boolean(),
  // 测试台写下的：真实客户端写的为 null
  bench: BenchMark.nullable(),
})
export type ActivityItem = z.infer<typeof ActivityItem>

export const ActivityList = z.object({
  items: z.array(ActivityItem),
  nextCursor: z.string().nullable(),
})
export type ActivityList = z.infer<typeof ActivityList>

// 变更记录里的一条改动，带前后快照（详情里对比正文用）。可见性和列表、历史同一套规则：看不到的是 404，
// 离开的没有改后的快照；机密的快照里没有正文
export const ActivityEvent = z.object({
  item: ActivityItem,
  before: MemorySnapshot.nullable(),
  after: MemorySnapshot.nullable(),
})
export type ActivityEvent = z.infer<typeof ActivityEvent>

export const ActivityEventParams = z.object({
  spaceId: z.uuid(),
  eventId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

// 恢复到某个事件之后的那一版：只改正文、标题、disclosure、priority 与关键词。
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

// 让过期的策展记忆重新生效：清掉有效期，一直有效；过期之后让出了 URI 的一并撤销删除。
// 抽取的记忆不在这里：被推翻的事实在对象页上重新生效，会话摘要按设计到期。
// expectedVersion 是界面上看到的版本号，期间被改过就返回 409
export const ReactivateRequest = z.object({
  memoryId: z.uuid(),
  expectedVersion: z.number().int(),
})
export type ReactivateRequest = z.infer<typeof ReactivateRequest>

// 抽取预算（每个空间）：每月最多用多少 token（UTC 自然月，抽取用的，不含嵌入）、每个对象每天最多写几条事实。
// 用到八成时概览提醒；用完之后只写会话摘要、不再抽取事实，下个月恢复
export const DEFAULT_EXTRACTION_MONTHLY_TOKENS = 2_000_000
export const DEFAULT_EXTRACTION_DAILY_WRITES = 20
export const ExtractionBudget = z.object({
  monthlyTokens: z.number().int().min(0).max(1_000_000_000),
  dailyWritesPerSubject: z.number().int().min(0).max(1000),
})
export type ExtractionBudget = z.infer<typeof ExtractionBudget>

export const ExtractionUsage = ExtractionBudget.extend({
  // 本月已经用掉的 token，从 periodStart 算起
  usedTokens: z.number().int(),
  periodStart: z.string(),
})
export type ExtractionUsage = z.infer<typeof ExtractionUsage>

// 备份的情况：只给实例管理员看，没配、出错或者好几天没做成时概览提醒
export const OverviewBackup = z.object({
  configured: z.boolean(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.object({ message: z.string(), at: z.string() }).nullable(),
})
export type OverviewBackup = z.infer<typeof OverviewBackup>

// 待处理的五类各有多少条：导航角标与概览共用。每一类和对应的列表同一个条件，调用方看不到的不算
export const InboxCounts = z.object({
  // 等查看者本人确认的账号绑定
  bindings: z.number().int(),
  // 待确认内容：不可信来源写下的联系人事实与会话摘要（待审队列）
  review: z.number().int(),
  // Dream 的建议：还没处理、还作数的
  dreamSuggestions: z.number().int(),
  // 正文疑似明文、提示没被忽略的记忆
  plaintext: z.number().int(),
  // 查看者自己的凭据里没删除、快到期、已到期或标了需要轮换的（一条凭据只算一次），
  // 和凭据列表的 attention 筛选同一个条件（CredentialListQuery）。别的成员的凭据不算，空间所有者也一样
  credentials: z.number().int(),
  total: z.number().int(),
})
export type InboxCounts = z.infer<typeof InboxCounts>

export const SpaceOverview = z.object({
  // 成员读得到的记下的记忆（通用、人格、应用、本人），按归属与敏感级分组
  counts: z.array(LayerCount),
  total: z.number().int(),
  // 成员读得到、现在有效的来自对话的记忆（联系人的事实、会话摘要），同样分组；不算在 counts 与 total 里
  extractedCounts: z.array(LayerCount),
  // 要补 disclosure 的记忆数，和列表的 missingDisclosure 筛选同一个条件
  missingDisclosure: z.number().int(),
  // 正文像有明文密码或 Token、该换成凭据占位符的记忆数，提示被忽略的不算
  plaintextCredentials: z.number().int(),
  // 从没被召回过的记忆数，和召回分析页同一个口径（见 RecallStats 的 never）
  neverRecalled: z.number().int(),
  embedding: EmbeddingCoverage,
  // 本月抽取用掉的 token 与预算，用到八成时概览提醒
  extraction: ExtractionUsage,
  apps: z.array(OverviewApp),
  // 最近的改动，和活动流同样的可见性
  recent: z.array(ActivityItem),
  // 不是实例管理员时为 null
  backup: OverviewBackup.nullable(),
  // 等查看者本人确认的绑定：别的平台账号想并进标记成他的对象
  pendingBindings: z.array(SubjectBinding),
  inbox: InboxCounts,
})
export type SpaceOverview = z.infer<typeof SpaceOverview>
