import { z } from 'zod'

import { BootMode, EntryKind, SceneSlug } from './entries'
import { ShortId } from './links'

export const RECALL_VIAS = ['semantic', 'fulltext', 'link'] as const
export const RecallVia = z.enum(RECALL_VIAS).meta({ id: 'RecallVia' })
export type RecallVia = z.infer<typeof RecallVia>

// 客户端当前所在项目与设备信息
export const LifecycleProject = z
  .object({
    dirName: z.string().max(128).optional(),
    repoName: z.string().max(128).optional(),
  })
  .meta({ id: 'LifecycleProject' })
export type LifecycleProject = z.infer<typeof LifecycleProject>

// 兼容已部署插件可能附带的 context 字段，除识别 cron/subagent 外其余字段静默忽略
export const OptionalLifecycleContext = z
  .looseObject({
    chatType: z.string().max(32).optional(),
  })
  .nullish()
export type OptionalLifecycleContext = z.infer<typeof OptionalLifecycleContext>

export const LIFECYCLE_EVENTS = ['session.start', 'prompt.submit', 'turn.end'] as const
export const LifecycleEventName = z.enum(LIFECYCLE_EVENTS)

export const SessionStartEvent = z
  .object({
    event: z.literal('session.start'),
    sessionId: z.string().max(200).optional(),
    deviceKey: z.string().trim().max(128).optional(),
    project: LifecycleProject.optional(),
    env: SceneSlug.optional(),
    realm: SceneSlug.optional(),
    runtime: SceneSlug.optional(),
    context: OptionalLifecycleContext,
  })
  .meta({ id: 'SessionStartEvent' })
export type SessionStartEvent = z.infer<typeof SessionStartEvent>

export const PromptSubmitEvent = z
  .object({
    event: z.literal('prompt.submit'),
    sessionId: z.string().max(200).optional(),
    deviceKey: z.string().trim().max(128).optional(),
    project: LifecycleProject.optional(),
    env: SceneSlug.optional(),
    realm: SceneSlug.optional(),
    runtime: SceneSlug.optional(),
    context: OptionalLifecycleContext,
    prompt: z.string().min(1).max(20_000),
  })
  .meta({ id: 'PromptSubmitEvent' })
export type PromptSubmitEvent = z.infer<typeof PromptSubmitEvent>

export const TurnEndEvent = z
  .object({
    event: z.literal('turn.end'),
    sessionId: z.string().min(1).max(200),
    deviceKey: z.string().trim().max(128).optional(),
    project: LifecycleProject.optional(),
    context: OptionalLifecycleContext,
    user: z.string().min(1).max(20_000),
    reply: z.string().max(20_000),
  })
  .meta({ id: 'TurnEndEvent' })
export type TurnEndEvent = z.infer<typeof TurnEndEvent>

export const LifecycleEventRequest = z.discriminatedUnion('event', [
  SessionStartEvent,
  PromptSubmitEvent,
  TurnEndEvent,
])
export type LifecycleEventRequest = z.infer<typeof LifecycleEventRequest>
export const LifecycleEvent = LifecycleEventRequest
export type LifecycleEvent = LifecycleEventRequest

export const HostOutput = z
  .object({
    mode: z.enum(['none', 'stdout_json', 'stdout_text', 'return_value']),
    value: z.unknown(),
  })
  .meta({ id: 'HostOutput' })
export type HostOutput = z.infer<typeof HostOutput>

export const LifecycleEventResponse = z
  .object({
    hostOutput: HostOutput,
    shortIds: z.array(ShortId),
  })
  .meta({ id: 'LifecycleEventResponse' })
export type LifecycleEventResponse = z.infer<typeof LifecycleEventResponse>
export const LifecycleResponse = LifecycleEventResponse
export type LifecycleResponse = LifecycleEventResponse

// ---- 启动加载与召回契约 ----

export const BOOT_OMIT_REASONS = ['index', 'oversized', 'budget'] as const
export const BootOmitReason = z.enum(BOOT_OMIT_REASONS)
export type BootOmitReason = z.infer<typeof BootOmitReason>

export const BOOT_BUCKETS = ['exact', 'context', 'global'] as const
export const BootBucket = z.enum(BOOT_BUCKETS)
export type BootBucket = z.infer<typeof BootBucket>

export const BOOT_EXCLUDE_REASONS = [
  'realm_forbidden',
  'scene_conflict',
  'project_mismatch',
  'expired',
] as const
export const BootExcludeReason = z.enum(BOOT_EXCLUDE_REASONS)
export type BootExcludeReason = z.infer<typeof BootExcludeReason>

export const BootEntry = z
  .object({
    shortId: ShortId,
    title: z.string(),
    kind: EntryKind,
    bootMode: BootMode.optional(),
    bucket: BootBucket.optional(),
    content: z.string(),
    summary: z.string().nullable().optional(),
    envs: z.array(z.string()).optional(),
    realms: z.array(z.string()).optional(),
    projects: z.array(z.string()).optional(),
    runtimes: z.array(z.string()).optional(),
    updatedAt: z.string().optional(),
    lastChangeSummary: z.string().nullable().optional(),
    version: z.number().int().optional(),
    charCount: z.number().int().optional(),
  })
  .meta({ id: 'BootEntry' })
export type BootEntry = z.infer<typeof BootEntry>

export const BootOmittedItem = z
  .object({
    shortId: ShortId,
    title: z.string(),
    bootMode: BootMode.optional(),
    reason: BootOmitReason.optional(),
    summary: z.string().nullable().optional(),
    disclosure: z.string().nullable().optional(),
    envs: z.array(z.string()).optional(),
    realms: z.array(z.string()).optional(),
    projects: z.array(z.string()).optional(),
    runtimes: z.array(z.string()).optional(),
    updatedAt: z.string().optional(),
    lastChangeSummary: z.string().nullable().optional(),
    charCount: z.number().int().optional(),
  })
  .meta({ id: 'BootOmittedItem' })
export type BootOmittedItem = z.infer<typeof BootOmittedItem>

export const SessionSummary = z
  .object({
    shortId: ShortId,
    title: z.string(),
    content: z.string(),
    createdAt: z.string(),
  })
  .meta({ id: 'SessionSummary' })
export type SessionSummary = z.infer<typeof SessionSummary>

export const RecentEntry = z
  .object({
    shortId: ShortId,
    title: z.string(),
    isPinned: z.boolean(),
    summary: z.string().nullable().optional(),
    disclosure: z.string().nullable(),
    envs: z.array(z.string()).optional(),
    realms: z.array(z.string()).optional(),
    projects: z.array(z.string()).optional(),
    runtimes: z.array(z.string()).optional(),
    lastChangeSummary: z.string().nullable().optional(),
    updatedAt: z.string(),
  })
  .meta({ id: 'RecentEntry' })
export type RecentEntry = z.infer<typeof RecentEntry>

export const BootResponse = z
  .object({
    entries: z.array(BootEntry),
    episodes: z.array(SessionSummary).default([]),
    omitted: z.array(ShortId),
    omittedItems: z.array(BootOmittedItem).optional(),
  })
  .meta({ id: 'BootResponse' })
export type BootResponse = z.infer<typeof BootResponse>

export const RecallRequest = z
  .object({
    query: z.string().trim().min(1).max(4000),
    limit: z.number().int().min(1).max(50).optional(),
    env: SceneSlug.optional(),
    realm: SceneSlug.optional(),
    project: z.union([SceneSlug, LifecycleProject]).optional(),
    runtime: SceneSlug.optional(),
    context: OptionalLifecycleContext,
  })
  .meta({ id: 'RecallRequest' })
export type RecallRequest = z.infer<typeof RecallRequest>

export const RecallCandidate = z
  .object({
    entryId: z.uuid(),
    shortId: ShortId,
    title: z.string(),
    kind: EntryKind,
    isPinned: z.boolean(),
    envs: z.array(z.string()),
    realms: z.array(z.string()),
    projects: z.array(z.string()),
    runtimes: z.array(z.string()),
    summary: z.string().nullable().optional(),
    disclosure: z.string().nullable(),
    updatedAt: z.string().optional(),
    lastChangeSummary: z.string().nullable().optional(),
    linkRelation: z.string().nullable().optional(),
    score: z.number(),
    via: z.array(RecallVia),
    cues: z.array(z.string()),
  })
  .meta({ id: 'RecallCandidate' })
export type RecallCandidate = z.infer<typeof RecallCandidate>

export const RecallResponse = z
  .object({
    candidates: z.array(RecallCandidate),
  })
  .meta({ id: 'RecallResponse' })
export type RecallResponse = z.infer<typeof RecallResponse>

// ---- 控制台终端启动加载预览契约（只读）----

export const BootPreviewRequest = z.object({
  keyId: z.uuid().optional(),
  project: z.string().trim().max(128).optional(),
  runtime: SceneSlug.optional(),
  env: SceneSlug.optional(),
  realm: SceneSlug.optional(),
})
export type BootPreviewRequest = z.infer<typeof BootPreviewRequest>

export const BootPreviewExpandedItem = z.object({
  shortId: ShortId,
  title: z.string(),
  bootMode: BootMode,
  bucket: BootBucket,
  charCount: z.number().int(),
  envs: z.array(z.string()),
  realms: z.array(z.string()),
  projects: z.array(z.string()),
  runtimes: z.array(z.string()),
})
export type BootPreviewExpandedItem = z.infer<typeof BootPreviewExpandedItem>

export const BootPreviewCatalogItem = z.object({
  shortId: ShortId,
  title: z.string(),
  bootMode: BootMode,
  reason: BootOmitReason,
  summary: z.string().nullable(),
  charCount: z.number().int(),
  envs: z.array(z.string()),
  realms: z.array(z.string()),
  projects: z.array(z.string()),
  runtimes: z.array(z.string()),
})
export type BootPreviewCatalogItem = z.infer<typeof BootPreviewCatalogItem>

export const BootPreviewExcludedItem = z.object({
  shortId: ShortId,
  title: z.string(),
  bootMode: BootMode,
  reason: BootExcludeReason,
  detail: z.string(),
  envs: z.array(z.string()),
  realms: z.array(z.string()),
  projects: z.array(z.string()),
  runtimes: z.array(z.string()),
})
export type BootPreviewExcludedItem = z.infer<typeof BootPreviewExcludedItem>

export const BootPreviewResponse = z.object({
  keyName: z.string().nullable(),
  runtimeFamily: z.string().nullable(),
  focus: z.object({
    envs: z.array(z.string()),
    realms: z.array(z.string()),
    projects: z.array(z.string()),
    runtimes: z.array(z.string()),
  }),
  fullBudget: z.number().int(),
  catalogBudget: z.number().int(),
  hostLimit: z.number().int().nullable(),
  usedFullChars: z.number().int(),
  usedCatalogChars: z.number().int(),
  globalUsedChars: z.number().int(),
  globalCapChars: z.number().int(),
  totalRenderedChars: z.number().int(),
  expanded: z.array(BootPreviewExpandedItem),
  indexed: z.array(BootPreviewCatalogItem),
  demoted: z.array(BootPreviewCatalogItem),
  excluded: z.array(BootPreviewExcludedItem),
})
export type BootPreviewResponse = z.infer<typeof BootPreviewResponse>
