import {
  AppConfig,
  CredentialIdentifier,
  ExtractionBudget,
  HostedCredentialSource,
  Layer,
  MemoryForm,
  MemoryTitle,
  MemoryUri,
  Provenance,
  RuntimeFamily,
  Sensitivity,
  Slug,
  SubjectKind,
  VaultCredentialFields,
  VaultEmail,
  VaultItemId,
  VaultServerUrl,
} from '@kioku/contracts'
import { z } from 'zod'

// 空间导出文件解密、解压后的正文：JSON Lines，第一行是文件头，之后每行一条记录，type 说明是什么。
// 记录里的 id 是导出时的 id，只用来在文件里互相指认（人格的继承、应用的默认人格、记忆挂的人格、应用与联系人、
// 按群换人格、凭据指向的密码库连接与限定的应用）；导入时全部重新生成。归属成员的东西（本人的记忆、凭据、密码库连接）
// 只有导出人自己的，不记是谁的：导入后全部归导入人。
// 记忆按导出时的样子写出（secret 是明文，整个文件另用口令加密），不含历史、向量与召回统计；
// 会话与会话摘要不导出，联系人的事实不带听到它的会话。
// 导出时每条记录先按这里的定义检查一遍，写得出来的就一定导入得了
export const SPACE_EXPORT_FORMAT = 'kioku-space-export'
// 文件格式的版本，导出时写这个，导入也只认它。4 是凭据改版之后的格式（密码库连接，凭据来源只剩托管与密码库）；
// 3 带着旧的凭据源，1、2 是记忆架构改版之前按七层写的，都不再能导入；更新的版本同样拒收，旧版本遇到 4 也拒收，
// 不会悄悄丢掉不认识的内容
export const SPACE_EXPORT_VERSION = 4

// 压缩前的正文最多这么大：导出时超出就拒绝，导入时解压超出就停下（挡住压缩炸弹）
export const SPACE_EXPORT_MAX_PLAIN_BYTES = 128 * 1024 * 1024

const Id = z.guid()
// 要写进库的文字，在这里先挡下存不进去的字符，报错时点得出是哪一行、哪个字段：PostgreSQL 的 text 与 jsonb
// 都存不了 NUL；落单的 UTF-16 代理项（JSON 里 "\ud800" 这样的转义解出来的）写进 text 时被悄悄换成 U+FFFD，
// 写进 jsonb（导入事件的快照）时报错，两个只差在代理项上的关键词还会变成同一个
const storable = (s: string) => !s.includes('\0') && !/\p{Cs}/u.test(s)
const UNSTORABLE = '含无法存入数据库的字符（NUL 或落单的代理项）'
export const Text = z.string().refine(storable, UNSTORABLE)

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
export const Time = z.iso.datetime({ offset: true }).refine((value) => {
  const at = new Date(value)
  return !Number.isNaN(at.getTime()) && at.getUTCFullYear() >= 1
}, '不是有效的时间')
const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

// 检查没通过时给人看的说明：哪个字段、什么问题。导出时点名哪一条导入不了、导入时说清第几行不对，都用它
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}：` : ''
  return `${where}${issue?.message ?? '格式错误'}`
}

// 导出人导出时的显示名：导入前告诉导入人这是谁的本人记忆与凭据
const Exporter = z.object({ displayName: Text.max(200) })

export const SpaceExportHeader = z.object({
  format: z.literal(SPACE_EXPORT_FORMAT),
  version: z.literal(SPACE_EXPORT_VERSION),
  createdAt: Time,
  // 做导出的 Kioku 版本，导入出错时提示用
  kioku: Text,
  // dreamPrivate：导出人让不让 Dream 整理他的本人记忆，导入后照样用在导入人身上（本人的记忆归了导入人）
  exporter: Exporter.extend({ dreamPrivate: z.boolean() }),
  // 空间级的设置：名字（导入时没填名字就用它）与抽取预算
  space: z.object({
    name: Text.min(1).max(64),
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
  // 导出人在联系人详情里把这个人标记成了「这是我」：导入后标记成导入人。标记成别的成员的不带过去
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

// 密码库连接：不带令牌与账户密钥，导入后是断开的，要重新登录。账号 id 留着，重新登录时据此认出是同一个账号
export const VaultConnectionRecord = z.object({
  type: z.literal('vault_connection'),
  id: Id,
  // 和连接接口同一个规则：只收 https（本机与不带点的主机名可以是 http），末尾的 / 去掉
  serverUrl: Text.pipe(VaultServerUrl),
  email: Text.pipe(VaultEmail),
  vaultUserId: Text.min(1).max(100),
  defaultCollectionId: Text.max(100).nullable(),
  createdAt: Time,
  updatedAt: Time,
})

// 托管的带着字段值（明文，整个文件另用口令加密）；密码库的带着连接、条目 id 与字段对应
const VaultCredentialRecordSource = z.object({
  kind: z.literal('vault'),
  connectionId: Id,
  itemId: VaultItemId,
  fields: VaultCredentialFields,
})

export const CredentialRecord = z.object({
  type: z.literal('credential'),
  id: Id,
  identifier: CredentialIdentifier,
  name: Text.min(1).max(100),
  description: Text.max(2000).nullable(),
  // 密码库的字段对应照原样写进库；托管的值加密之后才存，不受上面那一条限制
  source: z
    .discriminatedUnion('kind', [HostedCredentialSource, VaultCredentialRecordSource])
    .superRefine((source, ctx) => {
      if (source.kind === 'vault') allStorable(source, ctx)
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
  // global、app:<应用>、group:<联系人>、direct:<联系人>，导入时换成新的 id
  originScope: z.string().regex(new RegExp(`^(global|(app|group|direct):${UUID_TEXT})$`)),
  personaId: Id.nullable(),
  appId: Id.nullable(),
  subjectId: Id.nullable(),
  // 记下的四类的坐标与标题；来自对话的记忆没有
  uri: MemoryUri.nullable(),
  title: MemoryTitle.nullable(),
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
  VaultConnectionRecord,
  CredentialRecord,
  MemoryRecord,
])
export type SpaceExportRecord = z.infer<typeof SpaceExportRecord>
export type PersonaRecord = z.infer<typeof PersonaRecord>
export type AppRecord = z.infer<typeof AppRecord>
export type SubjectRecord = z.infer<typeof SubjectRecord>
export type IdentityRecord = z.infer<typeof IdentityRecord>
export type GroupPersonaRecord = z.infer<typeof GroupPersonaRecord>
export type VaultConnectionRecord = z.infer<typeof VaultConnectionRecord>
export type CredentialRecord = z.infer<typeof CredentialRecord>
export type MemoryRecord = z.infer<typeof MemoryRecord>
