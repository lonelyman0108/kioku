import { z } from 'zod'

import { SubjectKind } from './memory'

// 会话：某个应用在一个群里、和一个人私聊，或不带会话上下文时（例如本机的 Claude Code）的那一串对话，挂着会话摘要。
// 按（应用、群）、（应用、私聊的人）、（应用、所属成员）认一个会话，插件给的会话标识只做记录。
// 联系人回答「关于谁」，会话回答「在哪聊的、聊了什么」：群在两边都出现
export const CONVERSATION_KINDS = ['group', 'direct', 'none'] as const
export const ConversationKind = z.enum(CONVERSATION_KINDS)
export type ConversationKind = z.infer<typeof ConversationKind>

export const ConversationInfo = z.object({
  id: z.uuid(),
  kind: ConversationKind,
  // 应用已经删掉时会话跟着删，这里总有
  app: z.object({ id: z.uuid(), name: z.string() }),
  // 群聊是那个群，私聊是那个人；不带会话上下文的为 null，它归所属成员，只有本人看得到
  subject: z.object({ id: z.uuid(), kind: SubjectKind, displayName: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  // 最近一次生命周期事件的时间，列表按它排
  lastActiveAt: z.iso.datetime(),
})
export type ConversationInfo = z.infer<typeof ConversationInfo>
