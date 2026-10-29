import {
  AppConfig,
  CredentialIdentifier,
  CredentialProviderKind,
  DomainLayers,
  ExternalCredentialSource,
  ExtractionBudget,
  HostedCredentialSource,
  Layer,
  MemoryForm,
  MemoryUri,
  Provenance,
  RuntimeFamily,
  Sensitivity,
  Slug,
  SubjectKind,
} from '@kioku/contracts'
import { z } from 'zod'

// 空间导出文件解密、解压后的正文：JSON Lines，第一行是文件头，之后每行一条记录，type 说明是什么。
// 记录里的 id 是导出时的 id，只用来在文件里互相指认（人格的继承、应用的默认人格、记忆挂的人格、应用与对象、
// 按群换人格、凭据绑的凭据源与限定的应用）；导入时全部重新生成。归属成员的东西（画像、私人层、凭据、凭据源）
// 只有导出人自己的，不记是谁的：导入后全部归导入人。
// 记忆按导出时的样子写出（secret 是明文，整个文件另用口令加密），不含历史、向量与召回统计。
// 导出时每条记录先按这里的定义检查一遍，写得出来的就一定导入得了
export const SPACE_EXPORT_FORMAT = 'kioku-space-export'
export const SPACE_EXPORT_VERSION = 1

// 压缩前的正文最多这么大：导出时超出就拒绝，导入时解压超出就停下（挡住压缩炸弹）
export const SPACE_EXPORT_MAX_PLAIN_BYTES = 128 * 1024 * 1024

const Id = z.guid()
// 要写进库的文字，在这里先挡下存不进去的字符，报错时点得出是哪一行、哪个字段：PostgreSQL 的 text 与 jsonb
// 都存不了 NUL；落单的 UTF-16 代理项（JSON 里 "\ud800" 这样的转义解出来的）写进 text 时被悄悄换成 U+FFFD，
// 写进 jsonb（导入事件的快照）时报错，两个只差在代理项上的关键词还会变成同一个
const storable = (s: string) => !s.includes('\0') && !/\p{Cs}/u.test(s)
const UNSTORABLE = '含有存不进数据库的字符（NUL 或落单的代理项）'
const Text = z.string().refine(storable, UNSTORABLE)

// 用接口的定义检查的部分（外部凭据的来源）不管上面这一条：其中的字符串（包括键）逐个查
function allStorable(value: unknown, ctx: z.RefinementCtx, path: (string | number)[] = []): void {
  if (typeof value === 'string') {
    if (!storable(value)) ctx.addIssue({ code: 'custom', path, message: UNSTORABLE })
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => allStorable(item, ctx, [...path, i]))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (!storable(key)) ctx.addIssue({ code: 'custom', path, message: UNSTORABLE })
      allStorable(item, ctx, [...path, key])
    }
  }
}
// 时间：格式对、确实是个日期，年份在 PostgreSQL 存得下的范围里（没有公元 0 年）
const Time = z.iso.datetime({ offset: true }).refine((value) => {
  const at = new Date(value)
  return !Number.isNaN(at.getTime()) && at.getUTCFullYear() >= 1
}, '不是有效的时间')
const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

// 检查没通过时给人看的说明：哪个字段、什么问题。导出时点名哪一条导入不了、导入时说清第几行不对，都用它
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}：` : ''
  return `${where}${issue?.message ?? '格式不对'}`
}

export const SpaceExportHeader = z.object({
  format: z.literal(SPACE_EXPORT_FORMAT),
  version: z.literal(SPACE_EXPORT_VERSION),
  createdAt: Time,
  // 做导出的 Kioku 版本，导入出错时提示用
  kioku: Text,
  // 导出人导出时的显示名：导入前告诉导入人这是谁的画像、私人层与凭据。
  // dreamPrivate：导出人让不让 Dream 整理他的画像层与私人层，导入后照样用在导入人身上（这两层归了导入人）。
  // 有这一项之前导出的文件没有它，那时还关不掉，按开着
  exporter: z.object({ displayName: Text.max(200), dreamPrivate: z.boolean().default(true) }),
  // 空间级的设置：名字（导入时没填名字就用它）、domain 默认层与抽取预算
  space: z.object({
    name: Text.min(1).max(64),
    domainLayers: DomainLayers.shape.defaults,
    extractionMonthlyTokens: ExtractionBudget.shape.monthlyTokens,
    extractionDailyWrites: ExtractionBudget.shape.dailyWritesPerSubject,
  }),
})
export type SpaceExportHeader = z.infer<typeof SpaceExportHeader>

export const PersonaRecord = z.object({
  type: z.literal('persona'),
  id: Id,
  slug: Slug,
  name: Text.min(1).max(64),
  extendsId: Id.nullable(),
  description: Text.max(500).nullable(),
  createdAt: Time,
  updatedAt: Time,
})

export const AppRecord = z.object({
  type: z.literal('app'),
  id: Id,
  slug: Slug,
  name: Text.min(1).max(64),
  runtimeFamily: RuntimeFamily,
  defaultPersonaId: Id.nullable(),
  config: AppConfig,
  createdAt: Time,
  updatedAt: Time,
})

export const SubjectRecord = z.object({
  type: z.literal('subject'),
  id: Id,
  kind: SubjectKind,
  displayName: Text.min(1).max(1000),
  nameLocked: z.boolean(),
  // 导出人在对象页里把这个人标记成了「这是我」：导入后标记成导入人。标记成别的成员的不带过去
  linkedToExporter: z.boolean(),
  createdAt: Time,
  updatedAt: Time,
})

export const IdentityRecord = z.object({
  type: z.literal('identity'),
  subjectId: Id,
  kind: SubjectKind,
  platform: Text.min(1).max(64),
  externalId: Text.min(1).max(200),
  displayName: Text.max(1000).nullable(),
  createdAt: Time,
})

export const GroupPersonaRecord = z.object({
  type: z.literal('groupPersona'),
  appId: Id,
  subjectId: Id,
  personaId: Id,
  createdAt: Time,
})

export const ProviderRecord = z.object({
  type: z.literal('provider'),
  id: Id,
  kind: CredentialProviderKind,
  name: Text.min(1).max(100),
  instructions: Text.max(4000),
  // 已删除的凭据源只在还有导出的凭据绑着它时导出（恢复删除的凭据之后可能这样），导入后照样是已删除
  deletedAt: Time.nullable(),
  createdAt: Time,
  updatedAt: Time,
})

// 来源和新建凭据的接口同一个形状，用同一份定义检查：托管的带着字段值（明文，整个文件另用口令加密），
// 外部的带着条目位置与字段对应（条目位置与来源字段会代入给 agent 的取值命令）

export const CredentialRecord = z.object({
  type: z.literal('credential'),
  id: Id,
  identifier: CredentialIdentifier,
  name: Text.min(1).max(100),
  description: Text.max(2000).nullable(),
  // 外部的条目位置与字段对应照原样写进库；托管的值加密之后才存，不受上面那一条限制
  source: z
    .discriminatedUnion('kind', [HostedCredentialSource, ExternalCredentialSource])
    .superRefine((source, ctx) => {
      if (source.kind === 'external') allStorable(source, ctx)
    }),
  // 只给这些应用用；null 表示不限定。导出里没有的应用（已经删掉的）导入时去掉
  appIds: z.array(Id).max(100).nullable(),
  createdAt: Time,
  updatedAt: Time,
})

export const MemoryRecord = z.object({
  type: z.literal('memory'),
  id: Id,
  form: MemoryForm,
  layer: Layer,
  sensitivity: Sensitivity,
  provenance: Provenance,
  // global、app:<应用>、group:<对象>、direct:<对象>，导入时换成新的 id
  originScope: z.string().regex(new RegExp(`^(global|(app|group|direct):${UUID_TEXT})$`)),
  personaId: Id.nullable(),
  appId: Id.nullable(),
  subjectId: Id.nullable(),
  // 策展记忆的 URI；抽取的记忆没有
  uri: MemoryUri.nullable(),
  content: Text.min(1).max(20_000),
  priority: z.number().int().min(0).max(99),
  disclosure: Text.max(500).nullable(),
  // 规则收紧之前写下的单字关键词也照样带过去
  glossary: z.array(Text.min(1).max(64)).max(256),
  validFrom: Time,
  validTo: Time.nullable(),
  expiresAt: Time.nullable(),
  // 导出时的版本号：导入后从 1 开始，导入事件里记下之前有过几版
  version: z.number().int().min(1),
  createdAt: Time,
  updatedAt: Time,
})

export const SpaceExportRecord = z.discriminatedUnion('type', [
  PersonaRecord,
  AppRecord,
  SubjectRecord,
  IdentityRecord,
  GroupPersonaRecord,
  ProviderRecord,
  CredentialRecord,
  MemoryRecord,
])
export type SpaceExportRecord = z.infer<typeof SpaceExportRecord>
export type PersonaRecord = z.infer<typeof PersonaRecord>
export type AppRecord = z.infer<typeof AppRecord>
export type SubjectRecord = z.infer<typeof SubjectRecord>
export type IdentityRecord = z.infer<typeof IdentityRecord>
export type GroupPersonaRecord = z.infer<typeof GroupPersonaRecord>
export type ProviderRecord = z.infer<typeof ProviderRecord>
export type CredentialRecord = z.infer<typeof CredentialRecord>
export type MemoryRecord = z.infer<typeof MemoryRecord>
