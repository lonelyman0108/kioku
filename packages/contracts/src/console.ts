import { z } from 'zod'

import { TopicTag } from './entries'
import { FacetDimensionKey, FacetTermSlug, WhenCondition } from './facets'
import { ShortId } from './links'
import { EntryKind, Provenance, Sensitivity } from './memory'
import { RecallCandidate } from './recall'
import { SensitiveCategory, StoredSensitiveFinding } from './sensitive'
import { SubjectBinding } from './subjects'
import { UpdateNotice } from './system'

export const ENTRY_LIST_SORTS = ['updated', 'priority', 'shortId'] as const
export const EntryListSort = z.enum(ENTRY_LIST_SORTS)
export type EntryListSort = z.infer<typeof EntryListSort>

export const EntryListQuery = z.object({
  kind: EntryKind.optional(),
  sensitivity: Sensitivity.optional(),
  provenance: Provenance.optional(),
  topic: TopicTag.optional(),
  dimensionKey: FacetDimensionKey.optional(),
  termSlug: FacetTermSlug.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  missingDisclosure: z.enum(['true', 'false']).optional(),
  plaintext: z.enum(['true', 'false', 'ignored']).optional(),
  sensitiveCategory: SensitiveCategory.optional(),
  updatedAfter: z.iso.datetime({ offset: true }).optional(),
  updatedBefore: z.iso.datetime({ offset: true }).optional(),
  sort: EntryListSort.default('updated'),
  cursor: z.string().max(4000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type EntryListQuery = z.infer<typeof EntryListQuery>

export const EntryListItem = z.object({
  id: z.uuid(),
  shortId: ShortId,
  circleId: z.uuid(),
  title: z.string(),
  kind: EntryKind,
  sensitivity: Sensitivity,
  provenance: Provenance,
  topics: z.array(z.string()),
  realms: z.array(z.string()),
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  variantCount: z.number().int(),
  variantsWhen: z.array(WhenCondition),
  version: z.number().int(),
  updatedAt: z.string(),
  validTo: z.string().nullable(),
  sensitiveCredential: z.boolean().optional(),
  sensitivePii: z.boolean().optional(),
  sensitiveFindings: z.array(StoredSensitiveFinding).optional(),
})
export type EntryListItem = z.infer<typeof EntryListItem>

export const EntryList = z.object({
  items: z.array(EntryListItem),
  nextCursor: z.string().nullable(),
})
export type EntryList = z.infer<typeof EntryList>

export const ConsoleSearchRequest = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(30).default(10),
})
export type ConsoleSearchRequest = z.infer<typeof ConsoleSearchRequest>

export const EntryMatch = z.object({
  shortId: ShortId,
  title: z.string(),
  circleId: z.uuid(),
  circleSlug: z.string(),
  kind: EntryKind,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  topics: z.array(z.string()),
})
export type EntryMatch = z.infer<typeof EntryMatch>

export const ConsoleSearchResponse = z.object({
  matches: z.array(EntryMatch),
  candidates: z.array(RecallCandidate),
})
export type ConsoleSearchResponse = z.infer<typeof ConsoleSearchResponse>

export const KindCount = z.object({
  kind: EntryKind,
  sensitivity: Sensitivity,
  count: z.number().int(),
})
export type KindCount = z.infer<typeof KindCount>

export const EmbeddingCoverage = z.object({
  configured: z.boolean(),
  model: z.string().nullable(),
  // 应当有向量的切片数：未过期、未删除、非机密且为 entry 或 fact 的切片
  eligible: z.number().int(),
  embedded: z.number().int(),
})
export type EmbeddingCoverage = z.infer<typeof EmbeddingCoverage>

export const OverviewClient = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  runtimeFamily: z.string(),
  ownerAccountId: z.uuid(),
  keys: z
    .object({
      active: z.number().int(),
      lastUsedAt: z.string().nullable(),
    })
    .nullable(),
})
export type OverviewClient = z.infer<typeof OverviewClient>

export const VariantSnapshot = z.object({
  when: WhenCondition,
  content: z.string().nullable(),
})
export type VariantSnapshot = z.infer<typeof VariantSnapshot>

export const EntrySnapshot = z.object({
  shortId: ShortId,
  title: z.string().nullable(),
  kind: EntryKind,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  topics: z.array(z.string()),
  realms: z.array(z.string()),
  glossary: z.array(z.string()),
  variants: z.array(VariantSnapshot),
  version: z.number().int(),
  deleted: z.boolean(),
  validTo: z.string().nullable(),
})
export type EntrySnapshot = z.infer<typeof EntrySnapshot>

export const EventActor = z.object({
  accountName: z.string().nullable(),
  keyName: z.string().nullable(),
  clientName: z.string().nullable(),
})
export type EventActor = z.infer<typeof EventActor>

export const BenchMark = z.object({ accountName: z.string().nullable(), run: z.string() })
export type BenchMark = z.infer<typeof BenchMark>

export const HistoryEvent = z.object({
  id: z.number().int(),
  type: z.string(),
  provenance: Provenance,
  createdAt: z.string(),
  actor: EventActor,
  via: z.string().nullable(),
  before: EntrySnapshot.nullable(),
  after: EntrySnapshot.nullable(),
  left: z.boolean(),
})
export type HistoryEvent = z.infer<typeof HistoryEvent>

export const EntryHistoryQuery = z.object({ id: z.uuid() })

export const EntryHistory = z.object({
  entry: z.object({
    id: z.uuid(),
    shortId: ShortId,
    title: z.string(),
    kind: EntryKind,
    sensitivity: Sensitivity,
    version: z.number().int(),
    deletedAt: z.string().nullable(),
    validTo: z.string().nullable(),
  }),
  events: z.array(HistoryEvent),
  truncated: z.boolean(),
})
export type EntryHistory = z.infer<typeof EntryHistory>

export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type PageQuery = z.infer<typeof PageQuery>

export const DeletedEntry = z.object({
  id: z.uuid(),
  shortId: ShortId,
  title: z.string(),
  kind: EntryKind,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  version: z.number().int(),
  deletedAt: z.string(),
  validTo: z.string().nullable(),
})
export type DeletedEntry = z.infer<typeof DeletedEntry>

export const DeletionRetention = z.object({
  days: z.number().int(),
  paused: z.boolean(),
  pausedUntil: z.string().nullable(),
})
export type DeletionRetention = z.infer<typeof DeletionRetention>

export const DeletedEntryList = z.object({
  items: z.array(DeletedEntry),
  nextCursor: z.string().nullable(),
  retention: DeletionRetention,
})
export type DeletedEntryList = z.infer<typeof DeletedEntryList>

export const ExpiredEntry = z.object({
  id: z.uuid(),
  shortId: ShortId,
  title: z.string(),
  kind: EntryKind,
  sensitivity: Sensitivity,
  priority: z.number().int(),
  disclosure: z.string().nullable(),
  version: z.number().int(),
  expiredAt: z.string(),
})
export type ExpiredEntry = z.infer<typeof ExpiredEntry>

export const ExpiredEntryList = z.object({
  items: z.array(ExpiredEntry),
  nextCursor: z.string().nullable(),
})
export type ExpiredEntryList = z.infer<typeof ExpiredEntryList>

export const ACTIVITY_TYPES = [
  'create',
  'import',
  'sync',
  'update',
  'transfer_out',
  'transfer_in',
  'delete',
  'restore',
  'undelete',
  'reactivate',
  'confirm',
  'convert_credential',
  'protect',
  'redact',
  'ignore_plaintext',
  'unignore_plaintext',
] as const
export const ActivityType = z.enum(ACTIVITY_TYPES)
export type ActivityType = z.infer<typeof ActivityType>

export const ACTIVITY_FIELDS = [
  'content',
  'title',
  'variants',
  'topics',
  'disclosure',
  'priority',
  'sensitivity',
  'glossary',
  'validTo',
] as const
export const ActivityField = z.enum(ACTIVITY_FIELDS)
export type ActivityField = z.infer<typeof ActivityField>

export const ActivityFieldFilter = z.enum([...ACTIVITY_FIELDS, 'none'])
export type ActivityFieldFilter = z.infer<typeof ActivityFieldFilter>

const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const ACTIVITY_ACTOR_PATTERN = new RegExp(
  `^(?:account:${UUID_TEXT}|client:${UUID_TEXT}|bench|unknown)$`,
)
export const ActivityActorKey = z.string().regex(ACTIVITY_ACTOR_PATTERN, '操作者的写法不对')
export type ActivityActorKey = z.infer<typeof ActivityActorKey>

export const ActivityFieldChange = z.discriminatedUnion('field', [
  z.object({
    field: z.literal('content'),
    added: z.number().int().nullable(),
    removed: z.number().int().nullable(),
  }),
  z.object({
    field: z.literal('glossary'),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
  z.object({
    field: z.literal('topics'),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
  z.object({
    field: z.literal('variants'),
    added: z.number().int(),
    removed: z.number().int(),
    modified: z.number().int(),
  }),
  z.object({ field: z.literal('priority'), before: z.number().int(), after: z.number().int() }),
  z.object({ field: z.literal('sensitivity'), before: Sensitivity, after: Sensitivity }),
  z.object({
    field: z.enum(['title', 'disclosure', 'validTo']),
    before: z.string().nullable(),
    after: z.string().nullable(),
  }),
])
export type ActivityFieldChange = z.infer<typeof ActivityFieldChange>

const commaList = <T extends z.ZodType<unknown, string>>(item: T, max: number) =>
  z
    .string()
    .max(max * 48)
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(item).min(1).max(max))

export const ACTIVITY_MAX_SPAN_DAYS = 400

const TIME_ZONE_REGION = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/
export const TimeZoneName = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => tz === 'UTC' || TIME_ZONE_REGION.test(tz), '时区只收地区名，例如 Asia/Shanghai')
export const ACTIVITY_UNKNOWN_TIME_ZONE = 'unknown_time_zone'

const ACTIVITY_FILTER = {
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  actor: commaList(ActivityActorKey, 50).optional(),
  exceptActor: commaList(ActivityActorKey, 50).optional(),
  type: commaList(ActivityType, ACTIVITY_TYPES.length).optional(),
  kind: commaList(EntryKind, 3).optional(),
  field: commaList(ActivityFieldFilter, ACTIVITY_FIELDS.length + 1).optional(),
  q: z.string().trim().min(1).max(100).optional(),
}

function checkSpan(
  v: { from?: string | undefined; to?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if (!v.from || !v.to) return
  const span = Date.parse(v.to) - Date.parse(v.from)
  if (span < 0) ctx.addIssue({ code: 'custom', path: ['to'], message: '结束时间不能早于开始时间' })
  else if (span > (ACTIVITY_MAX_SPAN_DAYS + 1) * 86_400_000) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: `时间跨度最多 ${ACTIVITY_MAX_SPAN_DAYS} 天`,
    })
  }
}

export const ActivityFilter = z.object(ACTIVITY_FILTER).superRefine(checkSpan)
export type ActivityFilter = z.infer<typeof ActivityFilter>

export const ActivityQuery = z
  .object({ ...ACTIVITY_FILTER, ...PageQuery.shape })
  .superRefine(checkSpan)
export type ActivityQuery = z.infer<typeof ActivityQuery>

export const ActivityDaysQuery = z
  .object({ ...ACTIVITY_FILTER, tz: TimeZoneName })
  .superRefine(checkSpan)
export type ActivityDaysQuery = z.infer<typeof ActivityDaysQuery>

export const ActivityDays = z.object({
  days: z.array(z.object({ day: z.string(), count: z.number().int() })),
})
export type ActivityDays = z.infer<typeof ActivityDays>

export const ActivityFacets = z.object({
  total: z.number().int(),
  actors: z.array(
    z.object({
      key: ActivityActorKey,
      kind: z.enum(['account', 'client', 'bench', 'unknown']),
      name: z.string().nullable(),
      count: z.number().int(),
    }),
  ),
  types: z.array(z.object({ type: ActivityType, count: z.number().int() })),
  kinds: z.array(z.object({ kind: EntryKind, count: z.number().int() })),
  fields: z.array(z.object({ field: ActivityFieldFilter, count: z.number().int() })),
})
export type ActivityFacets = z.infer<typeof ActivityFacets>

export const ActivityItem = z.object({
  id: z.number().int(),
  type: z.string(),
  entryId: z.uuid(),
  shortId: ShortId,
  title: z.string(),
  kind: EntryKind,
  sensitivity: Sensitivity,
  createdAt: z.string(),
  actor: EventActor,
  actorKey: ActivityActorKey,
  changes: z.array(z.string()),
  fieldChanges: z.array(ActivityFieldChange),
  versionBefore: z.number().int().nullable(),
  versionAfter: z.number().int().nullable(),
  left: z.boolean(),
  deleted: z.boolean(),
  expired: z.boolean(),
  bench: BenchMark.nullable(),
})
export type ActivityItem = z.infer<typeof ActivityItem>

export const ActivityList = z.object({
  items: z.array(ActivityItem),
  nextCursor: z.string().nullable(),
})
export type ActivityList = z.infer<typeof ActivityList>

export const ActivityEvent = z.object({
  item: ActivityItem,
  before: EntrySnapshot.nullable(),
  after: EntrySnapshot.nullable(),
})
export type ActivityEvent = z.infer<typeof ActivityEvent>

export const ActivityEventParams = z.object({
  circleId: z.uuid(),
  eventId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

export const RestoreRequest = z.object({
  entryId: z.uuid(),
  eventId: z.number().int().positive(),
  expectedVersion: z.number().int(),
})
export type RestoreRequest = z.infer<typeof RestoreRequest>

export const GlossaryIndex = z.object({
  entries: z.array(z.object({ keyword: z.string(), shortIds: z.array(ShortId) })),
  truncated: z.boolean(),
})
export type GlossaryIndex = z.infer<typeof GlossaryIndex>

export const UndeleteRequest = z.object({ entryId: z.uuid() })
export type UndeleteRequest = z.infer<typeof UndeleteRequest>

export const ReactivateRequest = z.object({
  entryId: z.uuid(),
  expectedVersion: z.number().int(),
})
export type ReactivateRequest = z.infer<typeof ReactivateRequest>

export const DEFAULT_EXTRACTION_MONTHLY_TOKENS = 2_000_000
export const DEFAULT_EXTRACTION_DAILY_WRITES = 20
export const ExtractionBudget = z.object({
  monthlyTokens: z.number().int().min(0).max(1_000_000_000),
  dailyWritesPerSubject: z.number().int().min(0).max(1000),
})
export type ExtractionBudget = z.infer<typeof ExtractionBudget>

export const ExtractionUsage = ExtractionBudget.extend({
  usedTokens: z.number().int(),
  periodStart: z.string(),
})
export type ExtractionUsage = z.infer<typeof ExtractionUsage>

export const OverviewBackup = z.object({
  configured: z.boolean(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.object({ message: z.string(), at: z.string() }).nullable(),
})
export type OverviewBackup = z.infer<typeof OverviewBackup>

export const InboxCounts = z.object({
  bindings: z.number().int(),
  review: z.number().int(),
  dreamSuggestions: z.number().int(),
  plaintext: z.number().int(),
  credentials: z.number().int(),
  total: z.number().int(),
})
export type InboxCounts = z.infer<typeof InboxCounts>

export const CircleOverview = z.object({
  counts: z.array(KindCount),
  total: z.number().int(),
  extractedCounts: z.array(KindCount),
  missingDisclosure: z.number().int(),
  plaintextCredentials: z.number().int(),
  neverRecalled: z.number().int(),
  embedding: EmbeddingCoverage,
  extraction: ExtractionUsage,
  clients: z.array(OverviewClient),
  recent: z.array(ActivityItem),
  backup: OverviewBackup.nullable(),
  update: UpdateNotice.nullable(),
  pendingBindings: z.array(SubjectBinding),
  inbox: InboxCounts,
})
export type CircleOverview = z.infer<typeof CircleOverview>
