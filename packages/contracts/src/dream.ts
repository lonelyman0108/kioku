import { z } from 'zod'

import {
  ArchivedHistoryNote,
  ChangeSummary,
  Disclosure,
  EntryContent,
  EntryKind,
  EntrySummary,
  EntryTitle,
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
] as const
export const DreamSuggestionKind = z.enum(DREAM_KINDS).meta({ id: 'DreamSuggestionKind' })
export type DreamSuggestionKind = z.infer<typeof DreamSuggestionKind>

export const DREAM_KIND_NAMES: Record<DreamSuggestionKind, string> = {
  distill_episode: '提炼会话摘要',
  merge_duplicates: '合并重复记忆',
  mark_stale: '标记过时记忆',
  update: '更新记忆内容',
  tidy: '规范与精简',
}

export const DREAM_STATUSES = ['pending', 'applied', 'rejected'] as const
export const DreamSuggestionStatus = z.enum(DREAM_STATUSES)
export type DreamSuggestionStatus = z.infer<typeof DreamSuggestionStatus>

export const DREAM_TRIGGERS = ['scheduled', 'manual'] as const
export const DreamTrigger = z.enum(DREAM_TRIGGERS)
export type DreamTrigger = z.infer<typeof DreamTrigger>

export const DREAM_OUTCOMES = ['ok', 'partial', 'skipped', 'failed'] as const
export const DreamOutcome = z.enum(DREAM_OUTCOMES)
export type DreamOutcome = z.infer<typeof DreamOutcome>

export const DreamProgress = z.object({
  mode: z.enum(['standard', 'tidy']),
  processed: z.number().int().min(0),
  total: z.number().int().min(0),
  suggested: z.number().int().min(0),
  failed: z.number().int().min(0),
})
export type DreamProgress = z.infer<typeof DreamProgress>

export const DreamRunSummary = z.object({
  id: z.string(),
  trigger: DreamTrigger,
  outcome: DreamOutcome,
  considered: z.number().int(),
  suggested: z.number().int(),
  error: z.string().nullable(),
  createdAt: z.string(),
})
export type DreamRunSummary = z.infer<typeof DreamRunSummary>

export const DreamState = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int(),
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
  envs: z.array(z.string()),
  realms: z.array(z.string()),
  projects: z.array(z.string()),
  runtimes: z.array(z.string()),
  topics: z.array(z.string()),
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
})
export type ApplySuggestionResponse = z.infer<typeof ApplySuggestionResponse>

export const TriggerDreamRequest = z.object({
  mode: z.enum(['standard', 'tidy']).default('standard'),
  limit: z.number().int().min(1).max(200).optional(),
  all: z.boolean().optional(),
  pinnedFirst: z.boolean().optional(),
})
export type TriggerDreamRequest = z.infer<typeof TriggerDreamRequest>

export const TriggerDreamResponse = z.object({
  started: z.boolean(),
  runId: z.string().nullable(),
  reason: z.string().nullable().optional(),
})
export type TriggerDreamResponse = z.infer<typeof TriggerDreamResponse>
