import { z } from 'zod'

import { ShortId } from './links'
import { Provenance, SubjectKind } from './memory'

export const CONVERSATION_KINDS = ['group', 'direct', 'channel', 'none'] as const
export const ConversationKind = z.enum(CONVERSATION_KINDS)
export type ConversationKind = z.infer<typeof ConversationKind>

// 来源作用域：global、某个接入实例（本机无上下文）、某个群或与某人的私聊
export const OriginScope = z.object({
  kind: z.enum(['global', 'client', 'group', 'direct']),
  id: z.uuid().nullable(),
  name: z.string().nullable(),
})
export type OriginScope = z.infer<typeof OriginScope>

const SubjectRef = z.object({ id: z.uuid(), kind: SubjectKind, displayName: z.string() })

export const ConversationInfo = z.object({
  id: z.uuid(),
  circleId: z.uuid(),
  kind: ConversationKind,
  client: z.object({ id: z.uuid(), name: z.string() }),
  // 无上下文会话按设备与项目细分，避免多机多仓库摘要串台
  deviceKey: z.string(),
  projectSlug: z.string(),
  subject: SubjectRef.nullable(),
  owner: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  displayName: z.string(),
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime(),
  latestSummary: z.object({ excerpt: z.string(), createdAt: z.iso.datetime() }).nullable(),
  summaryCount: z.number().int(),
})
export type ConversationInfo = z.infer<typeof ConversationInfo>

export const ConversationListQuery = z.object({
  clientId: z.uuid().optional(),
  subjectId: z.uuid().optional(),
  kind: ConversationKind.optional(),
  cursor: z.string().max(200).optional(),
})
export type ConversationListQuery = z.infer<typeof ConversationListQuery>

export const ConversationList = z.object({
  items: z.array(ConversationInfo),
  nextCursor: z.string().nullable(),
})
export type ConversationList = z.infer<typeof ConversationList>

export const ConversationSummary = z.object({
  id: z.uuid(),
  shortId: ShortId,
  content: z.string(),
  provenance: Provenance,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
})
export type ConversationSummary = z.infer<typeof ConversationSummary>

export const ExtractionRunInfo = z.object({
  id: z.number().int(),
  createdAt: z.iso.datetime(),
  client: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  scope: OriginScope,
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

export const ConversationFact = z.object({
  id: z.uuid(),
  shortId: ShortId,
  content: z.string(),
  provenance: Provenance,
  subject: SubjectRef,
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type ConversationFact = z.infer<typeof ConversationFact>

export const ConversationDetail = ConversationInfo.extend({
  summaries: z.array(ConversationSummary),
  facts: z.array(ConversationFact),
  runs: z.array(ExtractionRunInfo),
})
export type ConversationDetail = z.infer<typeof ConversationDetail>
