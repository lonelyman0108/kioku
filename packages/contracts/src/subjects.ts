import { z } from 'zod'

import { Provenance, SubjectKind } from './memory'

// 管理界面的对象页：bot 遇到的人与群、各自的平台账号、从对话里记下的事实与抽取记录

export const SubjectIdentity = z.object({
  platform: z.string(),
  externalId: z.string(),
  // 平台上的显示名，随上报更新；人的显示名在群里可能是群名片
  displayName: z.string().nullable(),
})
export type SubjectIdentity = z.infer<typeof SubjectIdentity>

export const SubjectInfo = z.object({
  id: z.uuid(),
  kind: SubjectKind,
  displayName: z.string(),
  // 关联的空间成员：对象就是这个成员本人（「这是我」），他的应用把这个人的私聊算作主人私聊
  account: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  identities: z.array(SubjectIdentity),
  // 现在有效、查看者读得到的事实条数
  factCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type SubjectInfo = z.infer<typeof SubjectInfo>

// cursor 是上一页返回的 nextCursor，换了筛选就要从头翻
export const SubjectListQuery = z.object({
  kind: SubjectKind.optional(),
  // 按名字、平台账号或平台上的显示名查找，不区分大小写
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
})
export type SubjectListQuery = z.infer<typeof SubjectListQuery>

export const SubjectList = z.object({
  items: z.array(SubjectInfo),
  nextCursor: z.string().nullable(),
})
export type SubjectList = z.infer<typeof SubjectList>

// 记忆从哪里来：全局、某个应用、某个群、和某个人的私聊。name 是应用或对象现在的名字，删掉了的为 null
export const OriginScope = z.object({
  kind: z.enum(['global', 'app', 'group', 'direct']),
  id: z.uuid().nullable(),
  name: z.string().nullable(),
})
export type OriginScope = z.infer<typeof OriginScope>

export const SubjectFact = z.object({
  id: z.uuid(),
  content: z.string(),
  provenance: Provenance,
  scope: OriginScope,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type SubjectFact = z.infer<typeof SubjectFact>

// 情节层里的会话摘要，到期自动失效
export const ConversationSummary = z.object({
  id: z.uuid(),
  content: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
})
export type ConversationSummary = z.infer<typeof ConversationSummary>

export const ExtractionRunInfo = z.object({
  id: z.number().int(),
  createdAt: z.iso.datetime(),
  app: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  scope: OriginScope,
  turns: z.number().int(),
  skippedTurns: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  dropped: z.number().int(),
  limited: z.number().int(),
  summarized: z.boolean(),
  summaryOnly: z.boolean(),
  error: z.string().nullable(),
})
export type ExtractionRunInfo = z.infer<typeof ExtractionRunInfo>

// 对象详情：事实是挂在这个对象上的；会话摘要是群里（或和这个人的私聊里）的；抽取记录是涉及它的最近几批
export const SubjectDetail = SubjectInfo.extend({
  facts: z.array(SubjectFact),
  summaries: z.array(ConversationSummary),
  runs: z.array(ExtractionRunInfo),
})
export type SubjectDetail = z.infer<typeof SubjectDetail>

// 改名之后，平台上的显示名再变也不跟着改。linkedToMe 只能把人关联到自己（或取消自己的关联）：
// 关联到别的成员会让陌生人的私聊被当作那个成员的主人私聊
export const UpdateSubjectRequest = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),
    linkedToMe: z.boolean().optional(),
  })
  .refine((v) => v.displayName !== undefined || v.linkedToMe !== undefined, {
    message: '没有要改的内容',
  })
export type UpdateSubjectRequest = z.infer<typeof UpdateSubjectRequest>
