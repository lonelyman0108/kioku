import {
  AppConfig,
  CredentialIdentifier,
  CredentialProviderKind,
  CredentialSourceInput,
  DomainLayers,
  ExtractionBudget,
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
// 记忆按导出时的样子写出（secret 是明文，整个文件另用口令加密），不含历史、向量与召回统计
export const SPACE_EXPORT_FORMAT = 'kioku-space-export'
export const SPACE_EXPORT_VERSION = 1

// 压缩前的正文最多这么大：导出时超出就拒绝，导入时解压超出就停下（挡住压缩炸弹）
export const SPACE_EXPORT_MAX_PLAIN_BYTES = 128 * 1024 * 1024

const Id = z.guid()
const Time = z.iso.datetime({ offset: true })
const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export const SpaceExportHeader = z.object({
  format: z.literal(SPACE_EXPORT_FORMAT),
  version: z.literal(SPACE_EXPORT_VERSION),
  createdAt: Time,
  // 做导出的 Kioku 版本，导入出错时提示用
  kioku: z.string(),
  // 空间级的设置：名字（导入时没填名字就用它）、domain 默认层与抽取预算
  space: z.object({
    name: z.string().min(1).max(64),
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
  name: z.string().min(1).max(64),
  extendsId: Id.nullable(),
  description: z.string().max(500).nullable(),
  createdAt: Time,
  updatedAt: Time,
})

export const AppRecord = z.object({
  type: z.literal('app'),
  id: Id,
  slug: Slug,
  name: z.string().min(1).max(64),
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
  displayName: z.string().min(1).max(1000),
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
  platform: z.string().min(1).max(64),
  externalId: z.string().min(1).max(200),
  displayName: z.string().max(1000).nullable(),
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
  name: z.string().min(1).max(100),
  instructions: z.string().max(4000),
  // 已删除的凭据源只在还有导出的凭据绑着它时导出（恢复删除的凭据之后可能这样），导入后照样是已删除
  deletedAt: Time.nullable(),
  createdAt: Time,
  updatedAt: Time,
})

// 来源与新建凭据的接口同一个形状：托管的带着字段值（明文，整个文件另用口令加密），外部的带着条目位置。
// 条目位置与来源字段会代入给 agent 的取值命令，导入时照样按接口的规则检查
export const CredentialRecord = z.object({
  type: z.literal('credential'),
  id: Id,
  identifier: CredentialIdentifier,
  name: z.string().min(1).max(100),
  description: z.string().max(2000).nullable(),
  source: CredentialSourceInput,
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
  content: z.string().min(1).max(20_000),
  priority: z.number().int().min(0).max(99),
  disclosure: z.string().max(500).nullable(),
  // 规则收紧之前写下的单字关键词也照样带过去
  glossary: z.array(z.string().min(1).max(64)).max(256),
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
