import { z } from 'zod'

import { Provenance, SubjectKind } from './memory'

// 会话：某个应用在一个群里、和一个人私聊，或不带会话上下文时（例如本机的 Claude Code）的那一串对话，挂着会话摘要。
// 按（应用、群）、（应用、私聊的人）、（应用、所属成员）认一个会话，插件给的会话标识只做记录。
// 联系人回答「关于谁」，会话回答「在哪聊的、聊了什么」：群在两边都出现。
// 看得到哪些：群聊、私聊的会话所有成员都看得到（和联系人一样）；不带会话上下文的会话只有所属成员本人看得到
export const CONVERSATION_KINDS = ['group', 'direct', 'none'] as const
export const ConversationKind = z.enum(CONVERSATION_KINDS)
export type ConversationKind = z.infer<typeof ConversationKind>

// 记忆从哪里来：全局、某个应用、某个群、和某个人的私聊。name 是应用或联系人现在的名字，删掉了的为 null
export const OriginScope = z.object({
  kind: z.enum(['global', 'app', 'group', 'direct']),
  id: z.uuid().nullable(),
  name: z.string().nullable(),
})
export type OriginScope = z.infer<typeof OriginScope>

const SubjectRef = z.object({ id: z.uuid(), kind: SubjectKind, displayName: z.string() })

// 会话列表的一项
export const ConversationInfo = z.object({
  id: z.uuid(),
  kind: ConversationKind,
  app: z.object({ id: z.uuid(), name: z.string() }),
  // 群聊是那个群，私聊是那个人；不带会话上下文的为 null
  subject: SubjectRef.nullable(),
  // 不带会话上下文的会话归哪个成员（只有本人看得到，所以就是当前账号）；群聊、私聊为 null
  owner: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  // 列表上的名字：群名或私聊的人的名字，不带会话上下文的是所属成员的名字
  displayName: z.string(),
  createdAt: z.iso.datetime(),
  // 最近一次生命周期事件的时间，列表按它从新到旧排
  lastActiveAt: z.iso.datetime(),
  // 最新一段摘要的开头（压成一行，最多 120 个字）与它的时间；还没有摘要时为 null
  latestSummary: z.object({ excerpt: z.string(), createdAt: z.iso.datetime() }).nullable(),
  // 现在有效、当前账号读得到的摘要条数
  summaryCount: z.number().int(),
})
export type ConversationInfo = z.infer<typeof ConversationInfo>

// 按应用或联系人筛：应用面板里的「会话」按应用；联系人详情里参与的会话见 SubjectDetail.conversations。
// cursor 是上一页返回的 nextCursor，换了筛选就要从头翻
export const ConversationListQuery = z.object({
  appId: z.uuid().optional(),
  // 群聊是那个群、私聊是那个人的会话
  subjectId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
})
export type ConversationListQuery = z.infer<typeof ConversationListQuery>

export const ConversationList = z.object({
  items: z.array(ConversationInfo),
  // 为 null 表示已经是最后一页
  nextCursor: z.string().nullable(),
})
export type ConversationList = z.infer<typeof ConversationList>

// 一段会话摘要，到期自动失效。群聊、私聊的摘要来自未确认来源，确认之后来源改成本人
export const ConversationSummary = z.object({
  id: z.uuid(),
  content: z.string(),
  provenance: Provenance,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
})
export type ConversationSummary = z.infer<typeof ConversationSummary>

// 一批抽取的记录：给了模型几轮、写下了什么、用了多少，失败时的原因
export const ExtractionRunInfo = z.object({
  id: z.number().int(),
  createdAt: z.iso.datetime(),
  app: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  scope: OriginScope,
  // 这一批是哪个会话的；会话已经删掉、或者当前账号看不到时为 null
  conversationId: z.uuid().nullable(),
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

// 在这个会话里听到、记在联系人身上的一条事实。删除走联系人的接口，带上 version
export const ConversationFact = z.object({
  id: z.uuid(),
  content: z.string(),
  provenance: Provenance,
  subject: SubjectRef,
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type ConversationFact = z.infer<typeof ConversationFact>

// 会话详情：摘要的时间线、在这里记下的事实与抽取记录，都是新的在前、现在有效、当前账号读得到的
export const ConversationDetail = ConversationInfo.extend({
  summaries: z.array(ConversationSummary),
  facts: z.array(ConversationFact),
  runs: z.array(ExtractionRunInfo),
})
export type ConversationDetail = z.infer<typeof ConversationDetail>
