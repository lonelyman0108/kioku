import { z } from 'zod'

import { WhenCondition } from './facets'
import { ShortId } from './links'
import { EntryKind, Sensitivity } from './memory'
import { MinScoreSetting, RecallLimitSetting } from './settings'

export const RECALL_VIAS = ['semantic', 'fulltext', 'glossary', 'link'] as const
export const RecallVia = z.enum(RECALL_VIAS).meta({ id: 'RecallVia' })
export type RecallVia = z.infer<typeof RecallVia>

export const RecallCandidate = z
  .object({
    entryId: z.uuid(),
    shortId: ShortId,
    title: z.string(),
    circleId: z.uuid(),
    // 受限会话上下文中隐藏客场记忆圈名称与标识，返回 null
    circleSlug: z.string().nullable(),
    kind: EntryKind,
    matchedWhen: WhenCondition,
    otherVariantsCount: z.number().int(),
    crossGroup: z.boolean().optional(),
    priority: z.number().int(),
    disclosure: z.string().nullable(),
    score: z.number(),
    via: z.array(RecallVia),
    cues: z.array(z.string()),
  })
  .meta({ id: 'RecallCandidate' })
export type RecallCandidate = z.infer<typeof RecallCandidate>

export const RecallBreakdown = z.object({
  semantic: z.number(),
  fulltext: z.number(),
  glossary: z.number(),
  priority: z.number(),
  facet: z.number(),
  link: z.number(),
})
export type RecallBreakdown = z.infer<typeof RecallBreakdown>

export const DebugCandidate = RecallCandidate.extend({
  breakdown: RecallBreakdown,
  rawScore: z.number(),
})
export type DebugCandidate = z.infer<typeof DebugCandidate>

export const CHAT_TYPES = ['direct', 'group', 'channel', 'cron', 'subagent'] as const
export const ChatType = z.enum(CHAT_TYPES).meta({ id: 'ChatType' })
export type ChatType = z.infer<typeof ChatType>

export const PlatformRef = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().max(4000).optional(),
  })
  .meta({ id: 'PlatformRef' })
export type PlatformRef = z.infer<typeof PlatformRef>

export const SessionContextInput = z
  .object({
    chatType: ChatType,
    platform: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_.-]{0,31}$/, '平台标识只能包含小写字母、数字和 _.-')
      .optional(),
    group: PlatformRef.optional(),
    sender: PlatformRef.optional(),
  })
  .superRefine((c, ctx) => {
    if ((c.chatType === 'group' || c.chatType === 'channel') && !c.group) {
      ctx.addIssue({ code: 'custom', path: ['group'], message: '群聊与频道须带上群' })
    }
    if (c.chatType === 'direct' && !c.sender) {
      ctx.addIssue({ code: 'custom', path: ['sender'], message: '私聊须带上发言人' })
    }
    if ((c.group || c.sender) && !c.platform) {
      ctx.addIssue({ code: 'custom', path: ['platform'], message: '带群或发言人时须带上平台' })
    }
  })
  .meta({ id: 'SessionContext' })
export type SessionContextInput = z.infer<typeof SessionContextInput>

// 客户端当前所在项目与设备标识
export const LifecycleProject = z
  .object({
    dirName: z.string().max(128).optional(),
    repoName: z.string().max(128).optional(),
  })
  .meta({ id: 'LifecycleProject' })
export type LifecycleProject = z.infer<typeof LifecycleProject>

export const RecallRequest = z
  .object({
    query: z.string().min(1).max(4000),
    limit: z.number().int().min(1).max(50).optional(),
    // 显式切面覆盖仅影响存在感排序，绝不放宽静态安全授权场域
    facets: WhenCondition.optional(),
    crossCircle: z.boolean().default(true),
    includeSubjects: z.boolean().default(true),
    project: LifecycleProject.optional(),
    context: SessionContextInput.optional(),
  })
  .meta({ id: 'RecallRequest' })
export type RecallRequest = z.infer<typeof RecallRequest>

export const SubjectFacts = z
  .object({
    role: z.enum(['sender', 'group']),
    name: z.string().nullable(),
    facts: z.array(
      z.object({
        shortId: ShortId.optional(),
        content: z.string(),
        crossGroup: z.boolean().optional(),
        updatedAt: z.string(),
      }),
    ),
  })
  .meta({ id: 'SubjectFacts' })
export type SubjectFacts = z.infer<typeof SubjectFacts>

export const RecallResponse = z
  .object({
    candidates: z.array(RecallCandidate),
    subjects: z.array(SubjectFacts),
  })
  .meta({ id: 'RecallResponse' })
export type RecallResponse = z.infer<typeof RecallResponse>

export const RecentEntry = z.object({
  shortId: ShortId,
  title: z.string(),
  circleSlug: z.string().nullable(),
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  updatedAt: z.string(),
})
export type RecentEntry = z.infer<typeof RecentEntry>

export const BootPersonaTrait = z.object({
  traitKey: z.string(),
  title: z.string(),
  content: z.string(),
})
export type BootPersonaTrait = z.infer<typeof BootPersonaTrait>

export const BootEntry = z
  .object({
    shortId: ShortId,
    title: z.string(),
    circleId: z.uuid(),
    circleSlug: z.string().nullable(),
    kind: EntryKind,
    content: z.string(),
  })
  .meta({ id: 'BootEntry' })
export type BootEntry = z.infer<typeof BootEntry>

export const BootResponse = z
  .object({
    personaTraits: z.array(BootPersonaTrait).default([]),
    entries: z.array(BootEntry),
    // 超出字数预算未展开的词条短 ID 列表
    omitted: z.array(ShortId),
  })
  .meta({ id: 'BootResponse' })
export type BootResponse = z.infer<typeof BootResponse>

export const LIFECYCLE_EVENTS = ['session.start', 'prompt.submit', 'turn.end'] as const
export const LifecycleEventName = z.enum(LIFECYCLE_EVENTS)

export const SessionStartEvent = z
  .object({
    event: z.literal('session.start'),
    sessionId: z.string().max(200).optional(),
    deviceKey: z.string().trim().max(128).optional(),
    context: SessionContextInput.optional(),
    project: LifecycleProject.optional(),
  })
  .meta({ id: 'SessionStartEvent' })

export const PromptSubmitEvent = z
  .object({
    event: z.literal('prompt.submit'),
    sessionId: z.string().max(200).optional(),
    deviceKey: z.string().trim().max(128).optional(),
    project: LifecycleProject.optional(),
    context: SessionContextInput.optional(),
    prompt: z.string().min(1).max(20_000),
  })
  .meta({ id: 'PromptSubmitEvent' })

export const TurnEndEvent = z
  .object({
    event: z.literal('turn.end'),
    sessionId: z.string().min(1).max(200),
    deviceKey: z.string().trim().max(128).optional(),
    project: LifecycleProject.optional(),
    context: SessionContextInput.optional(),
    user: z.string().min(1).max(20_000),
    reply: z.string().max(20_000),
  })
  .superRefine((e, ctx) => {
    if (!e.context) return
    if (e.context.chatType === 'cron' || e.context.chatType === 'subagent') {
      ctx.addIssue({
        code: 'custom',
        path: ['context', 'chatType'],
        message: '只缓冲私聊、群聊、频道与不带会话上下文的对话',
      })
    }
    if ((e.context.chatType === 'group' || e.context.chatType === 'channel') && !e.context.sender) {
      ctx.addIssue({
        code: 'custom',
        path: ['context', 'sender'],
        message: '群聊与频道须带上本轮的发言人',
      })
    }
  })
  .meta({ id: 'TurnEndEvent' })

export const LifecycleEvent = z.discriminatedUnion('event', [
  SessionStartEvent,
  PromptSubmitEvent,
  TurnEndEvent,
])
export type LifecycleEvent = z.infer<typeof LifecycleEvent>
export type TurnEndEvent = z.infer<typeof TurnEndEvent>

export const HostOutput = z
  .object({
    mode: z.enum(['none', 'stdout_json', 'stdout_text', 'return_value']),
    value: z.unknown(),
  })
  .meta({ id: 'HostOutput' })
export type HostOutput = z.infer<typeof HostOutput>

export const LifecycleResponse = z
  .object({
    hostOutput: HostOutput,
    shortIds: z.array(ShortId),
  })
  .meta({ id: 'LifecycleResponse' })
export type LifecycleResponse = z.infer<typeof LifecycleResponse>

export const READ_DENIALS = [
  'deleted',
  'expired',
  'kind',
  'circle',
  'sensitivity',
  'secret',
  'realm',
  'client',
  'origin',
  'owner',
  'group_lock',
  'persona',
] as const
export const ReadDenial = z.enum(READ_DENIALS)
export type ReadDenial = z.infer<typeof ReadDenial>

export const RecallDebugRequest = z.object({
  query: z.string().trim().min(1).max(4000),
  minScore: MinScoreSetting.optional(),
  limit: RecallLimitSetting.optional(),
  facets: WhenCondition.optional(),
  crossCircle: z.boolean().default(true),
})
export type RecallDebugRequest = z.infer<typeof RecallDebugRequest>

export const FlippedTerm = z.object({
  dimensionKey: z.string(),
  slug: z.string(),
  label: z.string(),
  alias: z.string(),
})
export type FlippedTerm = z.infer<typeof FlippedTerm>

export const RecallDebug = z.object({
  injected: z.array(DebugCandidate),
  others: z.array(DebugCandidate),
  minScore: z.number(),
  limit: z.number().int(),
  block: z.string(),
  semantic: z.boolean(),
  resolvedFacets: WhenCondition,
  flippedTerms: z.array(FlippedTerm),
  filtered: z.array(
    z.object({
      shortId: ShortId,
      title: z.string(),
      circleSlug: z.string().nullable(),
      kind: EntryKind,
      sensitivity: Sensitivity,
      reason: ReadDenial,
    }),
  ),
})
export type RecallDebug = z.infer<typeof RecallDebug>

export const BootPreviewRequest = z.object({
  project: LifecycleProject.optional(),
  deviceKey: z.string().trim().max(128).optional(),
  sessionId: z.string().max(200).optional(),
})
export type BootPreviewRequest = z.infer<typeof BootPreviewRequest>

export const SESSION_EXTRAS = ['summaries', 'recent', 'related'] as const
export const SessionExtra = z.enum(SESSION_EXTRAS)
export type SessionExtra = z.infer<typeof SessionExtra>

export const SessionSummary = z.object({
  shortId: ShortId.optional(),
  content: z.string(),
  createdAt: z.iso.datetime(),
})
export type SessionSummary = z.infer<typeof SessionSummary>

export const BootPreview = z.object({
  runtimeFamily: z.string(),
  limit: z.number().int().nullable(),
  context: z.string(),
  resolvedFacets: WhenCondition,
  personaTraits: z.array(BootPersonaTrait),
  entries: z.array(
    z.object({
      shortId: ShortId,
      title: z.string(),
      circleId: z.uuid(),
      circleSlug: z.string().nullable(),
      chars: z.number().int(),
    }),
  ),
  omitted: z.array(z.object({ shortId: ShortId, title: z.string() })),
  summaries: z.array(SessionSummary),
  recent: z.array(RecentEntry),
  related: z.array(RecallCandidate),
  dropped: z.array(SessionExtra),
})
export type BootPreview = z.infer<typeof BootPreview>

export const RECALL_SOURCES = [
  'session.start',
  'prompt.submit',
  'mcp.search',
  'rest.recall',
] as const
export const RecallSource = z.enum(RECALL_SOURCES)
export type RecallSource = z.infer<typeof RecallSource>

export const EntryRecallStat = z.object({
  recent: z.number().int(),
  total: z.number().int(),
  lastRecalledAt: z.string().nullable(),
})
export type EntryRecallStat = z.infer<typeof EntryRecallStat>

export const RecalledEntry = EntryRecallStat.extend({
  id: z.uuid(),
  shortId: ShortId,
  title: z.string(),
  kind: EntryKind,
  sensitivity: Sensitivity,
})
export type RecalledEntry = z.infer<typeof RecalledEntry>

export const NeverRecalledEntry = z.object({
  id: z.uuid(),
  shortId: ShortId,
  title: z.string(),
  kind: EntryKind,
  sensitivity: Sensitivity,
  createdAt: z.string(),
})
export type NeverRecalledEntry = z.infer<typeof NeverRecalledEntry>

export const ClientRecallVolume = z.object({
  clientId: z.uuid(),
  name: z.string().nullable(),
  total: z.number().int(),
  sources: z.array(z.object({ source: RecallSource, count: z.number().int() })),
})
export type ClientRecallVolume = z.infer<typeof ClientRecallVolume>

export const RecallStats = z.object({
  retentionDays: z.number().int(),
  recordingSince: z.string(),
  clients: z.array(ClientRecallVolume),
  top: z.array(RecalledEntry),
  never: z.array(NeverRecalledEntry),
  neverTotal: z.number().int(),
})
export type RecallStats = z.infer<typeof RecallStats>

export const RecallEventView = z.object({
  id: z.number().int(),
  clientId: z.uuid(),
  clientName: z.string().nullable(),
  keyName: z.string().nullable(),
  source: RecallSource,
  query: z.string().nullable(),
  createdAt: z.string(),
  hits: z.array(
    z.object({
      targetCircleId: z.uuid(),
      targetCircleSlug: z.string().nullable(),
      shortId: ShortId.nullable(),
      title: z.string().nullable(),
      rank: z.number().int(),
      score: z.number(),
      via: z.array(RecallVia),
    }),
  ),
})
export type RecallEventView = z.infer<typeof RecallEventView>

export const RecallEventQuery = z.object({
  clientId: z.uuid().optional(),
  cursor: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
})
export type RecallEventQuery = z.infer<typeof RecallEventQuery>

export const RecallEventList = z.object({
  items: z.array(RecallEventView),
  nextCursor: z.string().nullable(),
})
export type RecallEventList = z.infer<typeof RecallEventList>
