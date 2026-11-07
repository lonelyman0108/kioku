import { z } from 'zod'

import { CURATED_LAYERS, Layer, NAMESPACED_LAYERS, Provenance, Sensitivity } from './memory'

// 坐标（代码与 MCP 里叫 uri）= 开头://位置/标识，存成 domain 与 path 两列。开头只有四种，就是记下的四类归属
// （CURATED_LAYERS）：core://、user://，以及 persona://<人格标识>/、app://<应用标识>/，后两种开头之后的第一段是人格或应用的标识，
// 之后至少还要有一段。位置是开头与标识之间的各级，可以没有；标识是最后一段。每段是小写字母、数字、_ 或 -，最长 64 个字符，
// 开头之后最多 16 段（人格与应用的标识也算一段）。第一组是开头（domain），第二组是开头之后的整段（path）
const URI_SEGMENT = '[a-z0-9_-]{1,64}'
export const URI_PATTERN = new RegExp(
  `^(?!(?:${NAMESPACED_LAYERS.join('|')})://${URI_SEGMENT}$)` +
    `(${CURATED_LAYERS.join('|')})://(${URI_SEGMENT}(?:/${URI_SEGMENT}){0,15})$`,
)
// 接受坐标的工具和接口都会原样返回它，agent 照着改：四种开头各放什么都写清楚
export const URI_FORMAT_MESSAGE =
  '坐标（URI）只能用这四种开头：core:// 放通用的记忆，所有应用都用得到（例如 core://agent）；' +
  'user:// 放本人的习惯、偏好与私人事务（例如 user://preferences/reply_style）；' +
  'persona://<人格标识>/ 放某个人格的设定（例如 persona://default/soul）；' +
  'app://<应用标识>/ 放某个应用独有的内容（例如 app://claudecode/agent）。' +
  '开头之后是可省略的位置与最后一段标识，用 / 分隔，每段只用小写字母、数字、_ 或 -'
export const MemoryUri = z.string().regex(URI_PATTERN, URI_FORMAT_MESSAGE)
export const DomainOrUri = z.string().min(1)

// 坐标前缀：四种开头之一，后面至少一段，例如 user://projects、persona://default（只有人格标识也行）。
// 目录浏览与列表的位置筛选用它，匹配它本身与下面各级
export const URI_PREFIX_PATTERN = new RegExp(
  `^(${CURATED_LAYERS.join('|')})://(${URI_SEGMENT}(?:/${URI_SEGMENT}){0,15})$`,
)
export const UriPrefix = z
  .string()
  .regex(URI_PREFIX_PATTERN, '位置格式应为 开头://各级，例如 user://projects、persona://default')

// 标题：记下的记忆给人看的名字，目录、列表、搜索与历史都显示它；改标题不改坐标。
// 去掉首尾空白之后 1–80 个字符，不含控制字符（换行、制表符也算）
export const MEMORY_TITLE_MAX = 80
export const MemoryTitle = z
  .string()
  .trim()
  .min(1, '标题不能为空')
  .max(MEMORY_TITLE_MAX, `标题最多 ${MEMORY_TITLE_MAX} 个字符`)
  .regex(/^\P{Cc}*$/u, '标题不能含控制字符')

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
    title: z.string(),
    layer: Layer,
    sensitivity: Sensitivity,
    provenance: Provenance,
    originScope: z.string(),
    // 测试台读 secret 时为 null；管理界面见 ConsoleMemoryView
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

// 管理界面读到的记忆。接入方的 MemoryView 不变，下面两个字段只给管理界面
export const ConsoleMemoryView = MemoryView.extend({
  // secret 有正文、这次没给（content 为 null），要显式查看（reveal），查看记一次访问
  contentHidden: z.boolean(),
  // 现在的正文疑似明文，而且这段正文的提示被忽略了；正文改了就不再算
  plaintextIgnored: z.boolean(),
})
export type ConsoleMemoryView = z.infer<typeof ConsoleMemoryView>

// 显式查看 secret 的正文，记一条访问事件
export const RevealMemoryRequest = z.object({ memoryId: z.uuid() })
export type RevealMemoryRequest = z.infer<typeof RevealMemoryRequest>

// 忽略或撤销忽略明文提示。expectedVersion 是看到提示时的版本：期间正文被改过，就不能替新的正文做决定，返回 409
export const PlaintextIgnoreRequest = z.object({
  memoryId: z.uuid(),
  expectedVersion: z.number().int(),
})
export type PlaintextIgnoreRequest = z.infer<typeof PlaintextIgnoreRequest>

// 目录浏览的一个子节点。exists 为 false 表示这一级本身没有记忆，只是下面有调用方读得到的后代，
// 像文件系统里的目录一样显示出来；此时 id、title、layer 等字段为 null
export const MemorySummary = z
  .object({
    uri: z.string(),
    exists: z.boolean(),
    id: z.uuid().nullable(),
    title: z.string().nullable(),
    layer: Layer.nullable(),
    sensitivity: Sensitivity.nullable(),
    priority: z.number().int().nullable(),
    disclosure: z.string().nullable(),
    // 这一级下面还有几个可见的下一级路径
    childCount: z.number().int(),
  })
  .meta({ id: 'MemorySummary' })
export type MemorySummary = z.infer<typeof MemorySummary>

// 正文里有这次新增的疑似明文（规则见 contracts 的 PLAINTEXT_CREDENTIAL，「新增」见 addedPlaintextCredentials）时，
// 写入默认被拒（400，MemoryWriteError 带上行号与类别）；写入后是 secret 的不拦。放行的标记两边各有各的：
// Key 的请求只有 plaintextOk，管理界面的请求（ConsoleCreateMemoryRequest、ConsoleUpdateMemoryRequest）只有
// ignorePlaintext 与 allowPlaintext。给错一边的标记由 schema 去掉
const KeyPlaintextFlags = {
  // 确认不是凭据，照常写入；这条记忆进待处理的「疑似明文凭据」，由人看过之后忽略或转存。
  // 只放行新增的疑似明文，不放行从 secret 降级
  plaintextOk: z
    .boolean()
    .optional()
    .describe(
      '正文里新增的疑似明文确实不是凭据时设为 true：照常写入，这条记忆进待处理。是凭据时先存成凭据，正文写占位符',
    ),
}

const ConsolePlaintextFlags = {
  // 确认不是凭据：照常写入，同时把写入后的正文记为「已忽略」（和忽略明文提示的效果相同，管整段正文），不进待处理。
  // 写入之前的正文里已有没处理的疑似明文时只放行写入，不记忽略：旧的那几处还要有人处理。
  // 结果是 secret 或正文没有疑似明文时也不记
  ignorePlaintext: z.boolean().optional(),
  // 不处理疑似明文，照样写入，这条记忆进待处理（由空间 owner 转存）。能改这条记忆的成员都能用。
  // 从 secret 降级时正文还像有明文凭据，确认没有、仍要降级，也用它：这一处只给空间 owner
  allowPlaintext: z.boolean().optional(),
}

// 归属由坐标的开头决定，不另外传
export const CreateMemoryRequest = z
  .object({
    uri: MemoryUri,
    // 不填时取正文里第一个 # 标题，没有就用标识（坐标的最后一段）
    title: MemoryTitle.optional(),
    content: z.string().min(1).max(20_000),
    // 不填时按归属取默认值；本人不收公开
    sensitivity: Sensitivity.optional(),
    priority: z.number().int().min(0).max(99).default(2),
    disclosure: z.string().max(500).optional(),
    glossary: z.array(Keyword).max(32).default([]),
    // 不填就一直有效
    validTo: ValidTo.optional().describe(
      `有效到：${VALID_TO_FORMAT}。到期后不再召回、不进 boot；不填就一直有效`,
    ),
    ...KeyPlaintextFlags,
  })
  .meta({ id: 'CreateMemoryRequest' })
export type CreateMemoryRequest = z.infer<typeof CreateMemoryRequest>

// 管理界面的新建：没有 plaintextOk，多 ignorePlaintext 与 allowPlaintext
export const ConsoleCreateMemoryRequest = CreateMemoryRequest.omit({ plaintextOk: true }).extend(
  ConsolePlaintextFlags,
)
export type ConsoleCreateMemoryRequest = z.infer<typeof ConsoleCreateMemoryRequest>

export const UpdateMemoryRequest = z
  .object({
    uri: MemoryUri,
    // 填了就做乐观并发检查，版本不一致返回 409
    expectedVersion: z.number().int().optional(),
    // 填了就核对是不是同一条记忆：删除后在同一个 URI 重建的记忆版本号从 1 重新开始，只看版本号分不出来
    expectedId: z.uuid().optional(),
    // 改标题不改坐标；改标识或归属要移动
    title: MemoryTitle.optional(),
    content: z.string().min(1).max(20_000).optional(),
    sensitivity: Sensitivity.optional(),
    priority: z.number().int().min(0).max(99).optional(),
    disclosure: z.string().max(500).nullable().optional(),
    glossaryAdd: z.array(Keyword).max(32).optional(),
    glossaryRemove: z.array(RemovableKeyword).max(32).optional(),
    // 改有效期；null 清掉，一直有效
    validTo: ValidTo.nullable()
      .optional()
      .describe(`有效到：${VALID_TO_FORMAT}。到期后不再召回、不进 boot；填 null 清掉，一直有效`),
    ...KeyPlaintextFlags,
  })
  .meta({ id: 'UpdateMemoryRequest' })
export type UpdateMemoryRequest = z.infer<typeof UpdateMemoryRequest>

// 管理界面的修改：同 ConsoleCreateMemoryRequest
export const ConsoleUpdateMemoryRequest = UpdateMemoryRequest.omit({ plaintextOk: true }).extend(
  ConsolePlaintextFlags,
)
export type ConsoleUpdateMemoryRequest = z.infer<typeof ConsoleUpdateMemoryRequest>

// 移动改的是坐标：换开头就是改归属，换最后一段就是改标识。标题不变，只有标题就是原来的标识时按新坐标重新取
export const MoveMemoryRequest = z
  .object({
    from: MemoryUri,
    to: MemoryUri,
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
    // 为 null 表示列的是开头这一级（例如 core://），或这一级本身没有可读的记忆
    // 写成并集而不是 .nullable()：OpenAPI 文档里才是 anyOf [$ref, null]，生成客户端的工具认得
    parent: z.union([MemoryView, z.null()]),
    children: z.array(MemorySummary),
    // 这一级超过上限（500 个）时只返回前面的部分
    truncated: z.boolean(),
  })
  .meta({ id: 'MemoryChildren' })
export type MemoryChildren = z.infer<typeof MemoryChildren>

export const ConsoleMemoryChildren = MemoryChildren.extend({
  parent: z.union([ConsoleMemoryView, z.null()]),
})
export type ConsoleMemoryChildren = z.infer<typeof ConsoleMemoryChildren>
