import { z } from 'zod'

import {
  ArchivedHistoryNote,
  BootMode,
  CaptureIntegrity,
  ChangeSummary,
  Disclosure,
  EntryContent,
  EntryDetailResponse,
  EntryKind,
  EntrySummary,
  EntryTitle,
  HygieneSweepFixKind,
  SceneSlugList,
  TopicList,
} from './entries'
import { ShortId } from './links'

export const DREAM_KINDS = [
  'distill_episode',
  'merge_duplicates',
  'mark_stale',
  'update',
  'tidy',
  'link_entries',
  'adjust_boot_mode',
] as const
export const DreamSuggestionKind = z.enum(DREAM_KINDS).meta({ id: 'DreamSuggestionKind' })
export type DreamSuggestionKind = z.infer<typeof DreamSuggestionKind>

export const DREAM_KIND_NAMES: Record<DreamSuggestionKind, string> = {
  distill_episode: '提炼会话摘要',
  merge_duplicates: '合并重复记忆',
  mark_stale: '标记过时记忆',
  update: '更新记忆内容',
  tidy: '规范与精简',
  link_entries: '补全双链',
  adjust_boot_mode: '调整启动加载',
}

export const DREAM_MODES = ['standard', 'tidy', 'cross_memory'] as const
export const DreamMode = z.enum(DREAM_MODES)
export type DreamMode = z.infer<typeof DreamMode>

export const DREAM_SCOPES = ['incremental', 'full_corpus'] as const
export const DreamScope = z.enum(DREAM_SCOPES)
export type DreamScope = z.infer<typeof DreamScope>

export const ProposedLinkItem = z.object({
  targetShortId: ShortId,
  targetTitle: z.string().max(160).optional(),
  relation: z.string().trim().max(64).nullable().optional(),
  anchorHeading: z.string().trim().max(120).nullable().optional(),
  reason: z.string().trim().max(240).nullable().optional(),
})
export type ProposedLinkItem = z.infer<typeof ProposedLinkItem>

export const DREAM_STATUSES = ['pending', 'applied', 'rejected'] as const
export const DreamSuggestionStatus = z.enum(DREAM_STATUSES)
export type DreamSuggestionStatus = z.infer<typeof DreamSuggestionStatus>

export const DREAM_TRIGGERS = ['scheduled', 'manual'] as const
export const DreamTrigger = z.enum(DREAM_TRIGGERS)
export type DreamTrigger = z.infer<typeof DreamTrigger>

export const DREAM_OUTCOMES = ['ok', 'partial', 'skipped', 'cancelled', 'failed'] as const
export const DreamOutcome = z.enum(DREAM_OUTCOMES)
export type DreamOutcome = z.infer<typeof DreamOutcome>

export const EMBEDDING_BACKFILL_OUTCOMES = ['ok', 'cancelled', 'failed'] as const
export const EmbeddingBackfillOutcome = z.enum(EMBEDDING_BACKFILL_OUTCOMES)
export type EmbeddingBackfillOutcome = z.infer<typeof EmbeddingBackfillOutcome>

export const EmbeddingBackfillRunSummary = z.object({
  id: z.string(),
  outcome: EmbeddingBackfillOutcome,
  processed: z.number().int().min(0),
  total: z.number().int().min(0),
  updated: z.number().int().min(0),
  model: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
})
export type EmbeddingBackfillRunSummary = z.infer<typeof EmbeddingBackfillRunSummary>

export const EmbeddingBackfillState = z.object({
  running: z.boolean(),
  processed: z.number().int().min(0),
  total: z.number().int().min(0),
  model: z.string().nullable(),
  lastFinishedAt: z.string().nullable(),
  lastOutcome: EmbeddingBackfillOutcome.nullable(),
  lastUpdatedCount: z.number().int().min(0),
  lastError: z.string().nullable(),
  recentRuns: z.array(EmbeddingBackfillRunSummary).optional(),
})
export type EmbeddingBackfillState = z.infer<typeof EmbeddingBackfillState>

export const CancelTaskResponse = z.object({
  cancelled: z.boolean(),
})
export type CancelTaskResponse = z.infer<typeof CancelTaskResponse>

export const DreamProgress = z.object({
  mode: DreamMode,
  stage: z.string().optional(),
  processed: z.number().int().min(0),
  total: z.number().int().min(0),
  suggested: z.number().int().min(0),
  failed: z.number().int().min(0),
})
export type DreamProgress = z.infer<typeof DreamProgress>

export const DreamFailedItem = z.object({
  shortId: ShortId,
  title: z.string(),
  kind: z.string(),
  reason: z.string(),
})
export type DreamFailedItem = z.infer<typeof DreamFailedItem>

export const DreamRunSummary = z.object({
  id: z.string(),
  trigger: DreamTrigger,
  mode: DreamMode.optional(),
  outcome: DreamOutcome,
  considered: z.number().int(),
  suggested: z.number().int(),
  error: z.string().nullable(),
  failedItems: z.array(DreamFailedItem).optional(),
  retriedCount: z.number().int().min(0).optional(),
  abortedReason: z.string().nullable().optional(),
  createdAt: z.string(),
})
export type DreamRunSummary = z.infer<typeof DreamRunSummary>

export const DreamModeScheduleState = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int(),
  lastRunAt: z.string().nullable(),
})
export type DreamModeScheduleState = z.infer<typeof DreamModeScheduleState>

export const DreamState = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int(),
  schedules: z
    .object({
      standard: DreamModeScheduleState,
      crossMemory: DreamModeScheduleState,
      tidy: DreamModeScheduleState,
    })
    .optional(),
  running: z.boolean(),
  progress: DreamProgress.nullable().optional(),
  lastRunAt: z.string().nullable(),
  lastOutcome: DreamOutcome.nullable(),
  lastError: z.string().nullable(),
  recentRuns: z.array(DreamRunSummary),
})
export type DreamState = z.infer<typeof DreamState>

export const DreamEntrySnapshot = z.object({
  id: z.uuid(),
  shortId: ShortId,
  kind: EntryKind,
  title: z.string(),
  summary: z.string().nullable().optional(),
  content: z.string(),
  disclosure: z.string().nullable(),
  isPinned: z.boolean(),
  bootMode: BootMode.optional(),
  envs: z.array(z.string()),
  realms: z.array(z.string()),
  projects: z.array(z.string()),
  runtimes: z.array(z.string()),
  topics: z.array(z.string()),
  deviceKey: z.string().nullable().optional(),
  verifiedAt: z.string().nullable().optional(),
  lastChangeSummary: z.string().nullable().optional(),
  version: z.number().int(),
  updatedAt: z.string(),
})
export type DreamEntrySnapshot = z.infer<typeof DreamEntrySnapshot>

export const DreamSuggestionView = z.object({
  id: z.uuid(),
  kind: DreamSuggestionKind,
  entryIds: z.array(z.uuid()),
  entryVersions: z.array(z.number().int()),
  keepId: z.uuid().nullable(),
  entries: z.array(DreamEntrySnapshot),
  proposedTitle: z.string().nullable(),
  proposedSummary: z.string().nullable().optional(),
  proposedContent: z.string().nullable(),
  proposedDisclosure: z.string().nullable(),
  proposedChangeSummary: z.string().nullable().optional(),
  archivedNotes: z.array(ArchivedHistoryNote).nullable().optional(),
  proposedTopics: z.array(z.string()).nullable(),
  proposedEnvs: z.array(z.string()).nullable(),
  proposedRealms: z.array(z.string()).nullable(),
  proposedProjects: z.array(z.string()).nullable(),
  proposedRuntimes: z.array(z.string()).nullable(),
  proposedLinks: z.array(ProposedLinkItem).nullable().optional(),
  proposedBootMode: BootMode.nullable().optional(),
  affectedBacklinkCount: z.number().int().min(0).optional(),
  reason: z.string(),
  status: DreamSuggestionStatus,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
})
export type DreamSuggestionView = z.infer<typeof DreamSuggestionView>

export const InboxResponse = z.object({
  items: z.array(DreamSuggestionView),
  pendingCount: z.number().int(),
  tidyPendingCount: z.number().int().min(0),
  dreamState: DreamState,
  embeddingBackfill: EmbeddingBackfillState.optional(),
})
export type InboxResponse = z.infer<typeof InboxResponse>

// 应用建议时可选附带编辑后的草稿字段（编辑后应用或分项应用）
export const ApplySuggestionRequest = z.object({
  title: EntryTitle.optional(),
  summary: EntrySummary.nullable().optional(),
  content: EntryContent.optional(),
  disclosure: Disclosure.nullable().optional(),
  changeSummary: ChangeSummary.nullable().optional(),
  applyArchivedNotes: z.boolean().optional(),
  topics: TopicList.optional(),
  envs: SceneSlugList.optional(),
  realms: SceneSlugList.optional(),
  projects: SceneSlugList.optional(),
  runtimes: SceneSlugList.optional(),
  isPinned: z.boolean().optional(),
  bootMode: BootMode.optional(),
  proposedLinks: z.array(ProposedLinkItem).optional(),
})
export type ApplySuggestionRequest = z.infer<typeof ApplySuggestionRequest>

export const ApplySuggestionResponse = z.object({
  entry: z
    .object({
      id: z.uuid(),
      shortId: ShortId,
      title: z.string(),
      version: z.number().int().optional(),
      previousVersion: z.number().int().optional(),
    })
    .nullable(),
  redirectedBacklinkCount: z.number().int().min(0).optional(),
})
export type ApplySuggestionResponse = z.infer<typeof ApplySuggestionResponse>

export const TriggerDreamRequest = z.object({
  mode: DreamMode.default('standard'),
  scope: DreamScope.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  all: z.boolean().optional(),
  pinnedFirst: z.boolean().optional(),
  targetShortIds: z.array(ShortId).min(1).max(200).optional(),
})
export type TriggerDreamRequest = z.infer<typeof TriggerDreamRequest>

export const TriggerDreamResponse = z.object({
  started: z.boolean(),
  runId: z.string().nullable(),
  reason: z.string().nullable().optional(),
})
export type TriggerDreamResponse = z.infer<typeof TriggerDreamResponse>

// ---- 编辑页主动单条规范整理与深度查重关联契约 ----

export const SingleTidyPreviewResponse = z.object({
  shortId: ShortId,
  baseVersion: z.number().int().min(1),
  needed: z.boolean(),
  reason: z.string(),
  preCleanedFixes: z.array(HygieneSweepFixKind),
  before: z.object({
    title: z.string(),
    summary: z.string().nullable(),
    content: z.string(),
  }),
  proposed: z.object({
    title: z.string(),
    summary: z.string().nullable(),
    content: z.string(),
    changeSummary: z.string(),
    archivedNotes: z.array(ArchivedHistoryNote),
  }),
  integrity: CaptureIntegrity,
})
export type SingleTidyPreviewResponse = z.infer<typeof SingleTidyPreviewResponse>

export const SingleTidyApplyRequest = z.object({
  expectedVersion: z.number().int().min(1),
  title: EntryTitle,
  summary: EntrySummary.nullable(),
  content: EntryContent,
  changeSummary: ChangeSummary.nullable().optional(),
  archivedNotes: z.array(ArchivedHistoryNote).max(20).optional(),
  applyArchivedNotes: z.boolean().optional(),
  stageToInbox: z.boolean().optional(),
  reason: z.string().trim().max(300).optional(),
})
export type SingleTidyApplyRequest = z.infer<typeof SingleTidyApplyRequest>

export const SingleTidyApplyResponse = z.object({
  stagedSuggestionId: z.uuid().nullable(),
  entry: EntryDetailResponse.nullable(),
})
export type SingleTidyApplyResponse = z.infer<typeof SingleTidyApplyResponse>

export const SingleCrossCheckResponse = z.object({
  shortId: ShortId,
  consideredNeighbors: z.number().int().min(0),
  createdCount: z.number().int().min(0),
  suggestions: z.array(DreamSuggestionView),
  retriedCount: z.number().int().min(0).optional(),
})
export type SingleCrossCheckResponse = z.infer<typeof SingleCrossCheckResponse>

// ---- 待处理建议单轮无状态按说明修订契约 ----

export const REVISABLE_DREAM_KINDS = [
  'distill_episode',
  'update',
  'merge_duplicates',
  'tidy',
] as const
export const RevisableDreamKind = z.enum(REVISABLE_DREAM_KINDS)
export type RevisableDreamKind = z.infer<typeof RevisableDreamKind>

export const REVISE_INSTRUCTION_MAX = 500

export const ReviseSuggestionRequest = z.object({
  instruction: z
    .string()
    .trim()
    .min(1, '请输入修订说明')
    .max(REVISE_INSTRUCTION_MAX, `修订说明最多 ${REVISE_INSTRUCTION_MAX} 个字符`),
  title: EntryTitle.optional(),
  summary: EntrySummary.nullable().optional(),
  content: EntryContent.optional(),
  disclosure: Disclosure.nullable().optional(),
  changeSummary: ChangeSummary.nullable().optional(),
  topics: TopicList.optional(),
  envs: SceneSlugList.optional(),
  realms: SceneSlugList.optional(),
  projects: SceneSlugList.optional(),
  runtimes: SceneSlugList.optional(),
  bootMode: BootMode.optional(),
})
export type ReviseSuggestionRequest = z.infer<typeof ReviseSuggestionRequest>

export const ReviseSuggestionResponse = z.object({
  proposedTitle: z.string().nullable(),
  proposedSummary: z.string().nullable(),
  proposedContent: z.string(),
  proposedDisclosure: z.string().nullable(),
  proposedChangeSummary: z.string().nullable(),
  proposedTopics: z.array(z.string()).nullable(),
  proposedEnvs: z.array(z.string()).nullable(),
  proposedRealms: z.array(z.string()).nullable(),
  proposedProjects: z.array(z.string()).nullable(),
  proposedRuntimes: z.array(z.string()).nullable(),
  proposedBootMode: BootMode.nullable(),
  reason: z.string(),
  integrity: CaptureIntegrity,
})
export type ReviseSuggestionResponse = z.infer<typeof ReviseSuggestionResponse>
