import { z } from 'zod'

import { ConversationInfo, ExtractionRunInfo, OriginScope } from './conversations'
import { DISCLOSURE_MAX, ENTRY_CONTENT_MAX, EntryTitle, TOPICS_MAX, TopicTag } from './entries'
import { WhenCondition } from './facets'
import { ShortId } from './links'
import { Provenance, Sensitivity, SubjectKind } from './memory'
import { SessionContextInput } from './recall'

export const SubjectIdentity = z.object({
  platform: z.string(),
  externalId: z.string(),
  displayName: z.string().nullable(),
})
export type SubjectIdentity = z.infer<typeof SubjectIdentity>

export const SubjectInfo = z.object({
  id: z.uuid(),
  kind: SubjectKind,
  displayName: z.string(),
  nameLocked: z.boolean(),
  account: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  identities: z.array(SubjectIdentity),
  factCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type SubjectInfo = z.infer<typeof SubjectInfo>

export const SubjectListQuery = z.object({
  kind: SubjectKind.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
})
export type SubjectListQuery = z.infer<typeof SubjectListQuery>

export const SubjectList = z.object({
  items: z.array(SubjectInfo),
  nextCursor: z.string().nullable(),
})
export type SubjectList = z.infer<typeof SubjectList>

export const SubjectFact = z.object({
  id: z.uuid(),
  shortId: ShortId,
  content: z.string(),
  provenance: Provenance,
  scope: OriginScope,
  conversationId: z.uuid().nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type SubjectFact = z.infer<typeof SubjectFact>

export const SupersededFact = SubjectFact.extend({
  supersededAt: z.iso.datetime(),
  supersededBy: z.string().nullable(),
})
export type SupersededFact = z.infer<typeof SupersededFact>

export const BINDING_STATUSES = [
  'pending',
  'merged',
  'confirmed',
  'rejected',
  'cancelled',
  'expired',
] as const
export const BindingStatus = z.enum(BINDING_STATUSES)
export type BindingStatus = z.infer<typeof BindingStatus>

const MemberRef = z.object({ id: z.uuid(), displayName: z.string() })

export const SubjectBinding = z.object({
  id: z.uuid(),
  status: BindingStatus,
  subject: z.object({ id: z.uuid(), displayName: z.string() }),
  incoming: z
    .object({ id: z.uuid(), displayName: z.string(), identities: z.array(SubjectIdentity) })
    .nullable(),
  redeemedBy: SubjectIdentity,
  issuedBy: z.object({ platform: z.string(), externalId: z.string() }),
  issuedAt: z.iso.datetime(),
  client: z.object({ id: z.uuid(), name: z.string() }),
  confirmer: MemberRef.nullable(),
  decidedBy: MemberRef.nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  note: z.string().nullable(),
  canConfirm: z.boolean(),
  canReject: z.boolean(),
})
export type SubjectBinding = z.infer<typeof SubjectBinding>

export const BindCodeRequest = z
  .object({ context: SessionContextInput })
  .meta({ id: 'BindCodeRequest' })
export type BindCodeRequest = z.infer<typeof BindCodeRequest>

export const BindCode = z
  .object({
    code: z.string(),
    expiresAt: z.iso.datetime(),
    expiresInSeconds: z.number().int(),
  })
  .meta({ id: 'BindCode' })
export type BindCode = z.infer<typeof BindCode>

export const BindRequest = z
  .object({
    code: z.string().max(64),
    context: SessionContextInput,
    confirm: z.boolean().default(false),
  })
  .meta({ id: 'BindRequest' })
export type BindRequest = z.infer<typeof BindRequest>

export const BindTarget = z
  .object({
    platform: z.string(),
    displayName: z.string().nullable(),
    accountHint: z.string(),
  })
  .meta({ id: 'BindTarget' })
export type BindTarget = z.infer<typeof BindTarget>

export const BindResult = z
  .object({
    status: z.enum(['preview', 'merged', 'pending']),
    target: BindTarget.optional(),
    needsApproval: z.boolean(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'BindResult' })
export type BindResult = z.infer<typeof BindResult>

export const VoidBindCodeRequest = z
  .object({
    code: z.string().max(64),
    context: SessionContextInput,
  })
  .meta({ id: 'VoidBindCodeRequest' })
export type VoidBindCodeRequest = z.infer<typeof VoidBindCodeRequest>

export const SubjectDetail = SubjectInfo.extend({
  facts: z.array(SubjectFact),
  supersededFacts: z.array(SupersededFact),
  conversations: z.array(ConversationInfo),
  runs: z.array(ExtractionRunInfo),
  bindings: z.array(SubjectBinding),
})
export type SubjectDetail = z.infer<typeof SubjectDetail>

export const UpdateSubjectRequest = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),
    linkedToMe: z.boolean().optional(),
  })
  .refine((v) => v.displayName !== undefined || v.linkedToMe !== undefined, {
    message: '没有要修改的内容',
  })
export type UpdateSubjectRequest = z.infer<typeof UpdateSubjectRequest>

export const MergeSubjectRequest = z.object({ from: z.uuid() })
export type MergeSubjectRequest = z.infer<typeof MergeSubjectRequest>

export const DeleteFactQuery = z.object({ version: z.coerce.number().int() })
export type DeleteFactQuery = z.infer<typeof DeleteFactQuery>

export const ReactivateFactRequest = z.object({ version: z.number().int() })
export type ReactivateFactRequest = z.infer<typeof ReactivateFactRequest>

// 对话页弹窗新建：将联系人的某条事实提炼升级为指定记忆圈的正式词条
export const PromoteFactRequest = z.object({
  targetCircleId: z.uuid(),
  sensitivity: Sensitivity.default('internal'),
  title: EntryTitle.optional(),
  content: z.string().trim().min(1).max(ENTRY_CONTENT_MAX).optional(),
  when: WhenCondition.default({}),
  topics: z.array(TopicTag).max(TOPICS_MAX).default([]),
  priority: z.number().int().min(0).max(99).default(2),
  disclosure: z.string().trim().max(DISCLOSURE_MAX).nullable().optional(),
})
export type PromoteFactRequest = z.infer<typeof PromoteFactRequest>
