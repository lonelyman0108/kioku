import { z } from 'zod'

import { OriginScope } from './conversations'
import { EntryTitle, TopicTag, TOPICS_MAX, VariantInput, VARIANTS_MAX } from './entries'
import { WhenCondition } from './facets'
import { ShortId } from './links'
import { EntryKind, Provenance, Sensitivity, SubjectKind } from './memory'

// 后台整理任务（Dream）：按组审视词条、事实与到期摘要，生成建议进待处理确认，不直接改库。
// 新增：facet_tag（漏标补标）、merge_variants（同主题独立卡合并为多变体词条）、
// generalize（跨项目共性去标上浮）、distill_episode（到期会话摘要沉淀重要事实或词条）
export const DREAM_SUGGESTION_KINDS = [
  'merge',
  'merge_variants',
  'facet_tag',
  'generalize',
  'distill',
  'distill_episode',
  'stale',
  'review',
  'promote',
] as const
export const DreamSuggestionKind = z.enum(DREAM_SUGGESTION_KINDS)
export type DreamSuggestionKind = z.infer<typeof DreamSuggestionKind>

export const DREAM_VERDICTS = ['confirm', 'delete'] as const
export const DreamVerdict = z.enum(DREAM_VERDICTS)
export type DreamVerdict = z.infer<typeof DreamVerdict>

export const DREAM_SCOPE_KINDS = ['circle', 'personal', 'talk', 'local_session'] as const
export const DreamScope = z.object({
  kind: z.enum(DREAM_SCOPE_KINDS),
  id: z.uuid().nullable(),
  name: z.string().nullable(),
  origin: OriginScope.nullable(),
})
export type DreamScope = z.infer<typeof DreamScope>

export const DreamEntryRef = z.object({
  id: z.uuid(),
  shortId: ShortId,
  title: z.string(),
  kind: EntryKind,
  sensitivity: Sensitivity,
  provenance: Provenance,
  topics: z.array(z.string()),
  when: WhenCondition.default({}),
  content: z.string(),
  subject: z.object({ id: z.uuid(), kind: SubjectKind, displayName: z.string() }).nullable(),
  updatedAt: z.iso.datetime(),
})
export type DreamEntryRef = z.infer<typeof DreamEntryRef>

export const DreamSuggestion = z.object({
  id: z.uuid(),
  kind: DreamSuggestionKind,
  scope: DreamScope,
  reason: z.string(),
  entries: z.array(DreamEntryRef),
  keepId: z.uuid().nullable(),
  // 建议写入的草稿：标题、正文、多变体切片、主题与切面、触发场景、审核结论、目标优先级
  title: z.string().nullable(),
  content: z.string().nullable(),
  variants: z.array(VariantInput).nullable(),
  when: WhenCondition.nullable(),
  topics: z.array(TopicTag).nullable(),
  disclosure: z.string().nullable(),
  verdict: DreamVerdict.nullable(),
  targetPriority: z.number().int().min(0).max(99).nullable().optional(),
  actionable: z.boolean(),
  createdAt: z.iso.datetime(),
})
export type DreamSuggestion = z.infer<typeof DreamSuggestion>

export const DreamSuggestionQuery = z.object({
  cursor: z.string().max(200).optional(),
})
export type DreamSuggestionQuery = z.infer<typeof DreamSuggestionQuery>

export const DreamSuggestionList = z.object({
  items: z.array(DreamSuggestion),
  total: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
})
export type DreamSuggestionList = z.infer<typeof DreamSuggestionList>

export const ApplyDreamSuggestion = z.object({
  title: EntryTitle.optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  variants: z.array(VariantInput).min(1).max(VARIANTS_MAX).optional(),
  when: WhenCondition.optional(),
  topics: z.array(TopicTag).max(TOPICS_MAX).optional(),
  disclosure: z.string().trim().max(500).nullable().optional(),
  priority: z.number().int().min(0).max(99).optional(),
})
export type ApplyDreamSuggestion = z.infer<typeof ApplyDreamSuggestion>

export const DreamApplied = z.object({
  entry: z.object({ id: z.uuid(), shortId: ShortId, title: z.string() }).nullable(),
})
export type DreamApplied = z.infer<typeof DreamApplied>

export const DREAM_TRIGGERS = ['scheduled', 'manual'] as const
export const DreamTrigger = z.enum(DREAM_TRIGGERS)
export type DreamTrigger = z.infer<typeof DreamTrigger>

export const DREAM_SKIP_REASONS = ['no-model', 'budget', 'idle', 'opted-out'] as const
export const DreamSkipReason = z.enum(DREAM_SKIP_REASONS)
export type DreamSkipReason = z.infer<typeof DreamSkipReason>

export const DreamRunEntry = z.object({
  scope: DreamScope.nullable(),
  model: z.string().nullable(),
  tokens: z.number().int(),
  changed: z.number().int(),
  considered: z.number().int(),
  suggested: z.number().int(),
  known: z.number().int(),
  dropped: z.number().int(),
  more: z.boolean(),
  skipped: DreamSkipReason.nullable(),
  error: z.string().nullable(),
})
export type DreamRunEntry = z.infer<typeof DreamRunEntry>

export const DreamRunInfo = z.object({
  runId: z.uuid(),
  trigger: DreamTrigger,
  at: z.iso.datetime(),
  entries: z.array(DreamRunEntry),
})
export type DreamRunInfo = z.infer<typeof DreamRunInfo>

export const DreamRunList = z.object({ runs: z.array(DreamRunInfo) })
export type DreamRunList = z.infer<typeof DreamRunList>

export const DreamMemberSettings = z.object({ includePrivate: z.boolean() })
export type DreamMemberSettings = z.infer<typeof DreamMemberSettings>

export const DreamQueued = z.object({ runId: z.uuid() })
export type DreamQueued = z.infer<typeof DreamQueued>

export const DreamRunStatus = z.object({
  state: z.enum(['queued', 'running', 'finished']),
  outcome: z.enum(['done', 'skipped', 'failed']).nullable(),
  reason: DreamSkipReason.nullable(),
})
export type DreamRunStatus = z.infer<typeof DreamRunStatus>
