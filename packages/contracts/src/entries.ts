import { z } from 'zod'

import { CREDENTIAL_PLACEHOLDER_PREFIX, EntryLinkDirection, ShortId } from './links'

export const ENTRY_KINDS = ['entry', 'episode'] as const
export const EntryKind = z.enum(ENTRY_KINDS).meta({ id: 'EntryKind' })
export type EntryKind = z.infer<typeof EntryKind>

export const BUILTIN_ENVS = ['mac', 'linux', 'win'] as const
export const BuiltinEnv = z.enum(BUILTIN_ENVS)
export type BuiltinEnv = z.infer<typeof BuiltinEnv>

export const ENTRY_TABS = ['all', 'pinned', 'episodes', 'trash'] as const
export const EntryTab = z.enum(ENTRY_TABS)
export type EntryTab = z.infer<typeof EntryTab>

export const BROWSE_GROUP_BY = ['topic', 'project', 'env', 'realm', 'runtime', 'kind'] as const
export const BrowseGroupBy = z.enum(BROWSE_GROUP_BY).meta({ id: 'BrowseGroupBy' })
export type BrowseGroupBy = z.infer<typeof BrowseGroupBy>

export const ENTRY_EVENT_TYPES = ['create', 'update', 'delete', 'undelete', 'restore'] as const
export const EntryEventType = z.enum(ENTRY_EVENT_TYPES)
export type EntryEventType = z.infer<typeof EntryEventType>

export const ENTRY_TITLE_MAX = 200
export const DISCLOSURE_MAX = 500
export const ENTRY_CONTENT_MAX = 100_000
export const TOPICS_MAX = 32
export const SCENE_TAGS_MAX = 16

export const SCENE_SLUG_PATTERN = /^[a-z0-9._\-\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]{1,64}$/

export const SceneSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SCENE_SLUG_PATTERN, '标签只能包含小写字母、数字、中文、._-，长度 1 到 64 个字符')
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '标签不能包含凭据占位符')

export function normalizeSlugList(values: readonly string[] | null | undefined): string[] {
  if (!values?.length) return []
  const set = new Set<string>()
  for (const raw of values) {
    const clean = raw.trim().toLowerCase()
    if (clean) set.add(clean)
  }
  return [...set].sort()
}

export const SceneSlugList = z
  .array(SceneSlug)
  .max(SCENE_TAGS_MAX, `最多填写 ${SCENE_TAGS_MAX} 项`)
  .transform((list) => normalizeSlugList(list))

export const TopicTag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, '主题标签不能为空')
  .max(64, '主题标签最多 64 个字符')
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+$/u, '主题标签不能包含空白或控制字符')
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '凭据占位符只能写在正文里')

export const TopicList = z
  .array(TopicTag)
  .max(TOPICS_MAX, `主题标签最多 ${TOPICS_MAX} 个`)
  .transform((list) => normalizeSlugList(list))

export const EntryTitle = z
  .string()
  .trim()
  .min(1, '标题不能为空')
  .max(ENTRY_TITLE_MAX, `标题最多 ${ENTRY_TITLE_MAX} 个字符`)
  .regex(/^\P{Cc}*$/u, '标题不能含控制字符')
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '凭据占位符只能写在正文里')

export const Disclosure = z
  .string()
  .trim()
  .max(DISCLOSURE_MAX, `触发场景最多 ${DISCLOSURE_MAX} 个字符`)
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '凭据占位符只能写在正文里')

const VALID_TO_FORMAT =
  'ISO 8601 时间，须带时区（例如 2026-12-31T23:59:00+08:00 或 2026-12-31T15:59:00Z）'
export const ValidTo = z.iso.datetime({ offset: true }).describe(VALID_TO_FORMAT)

export const EntryContent = z
  .string()
  .min(1, '正文不能为空')
  .max(ENTRY_CONTENT_MAX, `正文最多 ${ENTRY_CONTENT_MAX} 个字符`)

// 从项目信息或原始路径名归一化为项目标识
export function normalizeProjectSlug(
  input:
    { repoName?: string | undefined; dirName?: string | undefined } | string | null | undefined,
): string | null {
  const raw = typeof input === 'string' ? input : (input?.repoName ?? input?.dirName)
  if (!raw) return null
  const tail = raw.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  const slug = tail
    .toLowerCase()
    .replace(/[^a-z0-9._\-\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || null
}

// 构造全文索引附加词串（供 entries.search_tags 写入，保持 generated fts 列纯不可变表达式）
export function buildSearchTags(input: {
  shortId?: string | undefined
  topics?: readonly string[] | undefined
  envs?: readonly string[] | undefined
  realms?: readonly string[] | undefined
  projects?: readonly string[] | undefined
  runtimes?: readonly string[] | undefined
}): string {
  const tokens = new Set<string>()
  if (input.shortId) tokens.add(input.shortId.trim().toLowerCase())
  for (const list of [input.topics, input.envs, input.realms, input.projects, input.runtimes]) {
    if (!list) continue
    for (const item of list) {
      const clean = item.trim().toLowerCase()
      if (clean) tokens.add(clean)
    }
  }
  return [...tokens].join(' ')
}

// ---- 标题与 Markdown 首行提取 ----

const HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CONTROL_RE = /\p{Cc}+/gu

function clipTitle(text: string): string {
  if (text.length <= ENTRY_TITLE_MAX) return text
  let out = ''
  for (const point of text) {
    if (out.length + point.length > ENTRY_TITLE_MAX) break
    out += point
  }
  return out.trim()
}

// 提取正文第一个 # 标题（忽略围栏代码块内及含凭据占位符的标题行）
export function firstMarkdownHeading(content: string): string | null {
  let fence: string | null = null
  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const [, marker, info = ''] = FENCE_RE.exec(line) ?? []
    if (fence !== null) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && /^[ \t]*$/.test(info)) fence = null
      continue
    }
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = marker
      continue
    }
    const heading = HEADING_RE.exec(line)?.[1]?.replace(CONTROL_RE, ' ').trim()
    if (heading) return heading.includes(CREDENTIAL_PLACEHOLDER_PREFIX) ? null : clipTitle(heading)
  }
  return null
}

// 计算词条标题：显式标题优先，其次正文首个 # 标题，均无则回退短 ID
export function deriveEntryTitle(
  explicitTitle: string | null | undefined,
  content: string,
  shortId: string,
): string {
  const trimmed = explicitTitle?.trim()
  if (trimmed) return clipTitle(trimmed)
  return firstMarkdownHeading(content) ?? shortId
}

// ---- 词条读写与列表契约 ----

export const EntryLinkNeighbor = z
  .object({
    shortId: ShortId,
    title: z.string(),
    kind: EntryKind,
    direction: EntryLinkDirection,
  })
  .meta({ id: 'EntryLinkNeighbor' })
export type EntryLinkNeighbor = z.infer<typeof EntryLinkNeighbor>

export const CredentialRefStatus = z.object({
  slug: z.string(),
  field: z.string().nullable(),
  available: z.boolean(),
  label: z.string().nullable(),
})
export type CredentialRefStatus = z.infer<typeof CredentialRefStatus>

export const EntryView = z
  .object({
    id: z.uuid(),
    shortId: ShortId,
    kind: EntryKind,
    title: z.string(),
    content: z.string(),
    disclosure: z.string().nullable(),
    isPinned: z.boolean(),
    envs: z.array(z.string()),
    realms: z.array(z.string()),
    projects: z.array(z.string()),
    runtimes: z.array(z.string()),
    topics: z.array(z.string()),
    deviceKey: z.string().nullable(),
    projectSlug: z.string().nullable(),
    validTo: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
  })
  .meta({ id: 'EntryView' })
export type EntryView = z.infer<typeof EntryView>

export const EntryListItem = z
  .object({
    id: z.uuid(),
    shortId: ShortId,
    kind: EntryKind,
    title: z.string(),
    disclosure: z.string().nullable(),
    isPinned: z.boolean(),
    envs: z.array(z.string()),
    realms: z.array(z.string()),
    projects: z.array(z.string()),
    runtimes: z.array(z.string()),
    topics: z.array(z.string()),
    validTo: z.string().nullable(),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    snippet: z.string().optional(),
    score: z.number().optional(),
  })
  .meta({ id: 'EntryListItem' })
export type EntryListItem = z.infer<typeof EntryListItem>

export const EntryListQuery = z.object({
  tab: EntryTab.default('all'),
  q: z.string().trim().max(2000).optional(),
  env: SceneSlug.optional(),
  realm: SceneSlug.optional(),
  project: SceneSlug.optional(),
  runtime: SceneSlug.optional(),
  topic: TopicTag.optional(),
  mode: z.enum(['list', 'lookup']).default('list'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(256).optional(),
})
export type EntryListQuery = z.infer<typeof EntryListQuery>

export const EntryFacetsSummary = z.object({
  projects: z.array(z.string()),
  envs: z.array(z.string()),
  realms: z.array(z.string()),
  topics: z.array(z.string()),
})
export type EntryFacetsSummary = z.infer<typeof EntryFacetsSummary>

export const EntryTabCounts = z.object({
  all: z.number().int(),
  pinned: z.number().int(),
  episodes: z.number().int(),
  trash: z.number().int(),
})
export type EntryTabCounts = z.infer<typeof EntryTabCounts>

export const EntryListResponse = z.object({
  items: z.array(EntryListItem),
  nextCursor: z.string().nullable(),
  facets: EntryFacetsSummary,
  counts: EntryTabCounts,
})
export type EntryListResponse = z.infer<typeof EntryListResponse>

export const EntryDetailResponse = z.object({
  entry: EntryView,
  outboundLinks: z.array(EntryLinkNeighbor),
  backlinks: z.array(EntryLinkNeighbor),
  credentialRefs: z.array(CredentialRefStatus),
})
export type EntryDetailResponse = z.infer<typeof EntryDetailResponse>

export const CreateEntryRequest = z.object({
  title: EntryTitle.optional(),
  content: EntryContent,
  disclosure: Disclosure.nullable().optional(),
  isPinned: z.boolean().default(false),
  envs: SceneSlugList.default([]),
  realms: SceneSlugList.default([]),
  projects: SceneSlugList.default([]),
  runtimes: SceneSlugList.default([]),
  topics: TopicList.default([]),
  validTo: ValidTo.nullable().optional(),
})
export type CreateEntryRequest = z.infer<typeof CreateEntryRequest>

export const UpdateEntryRequest = z.object({
  expectedVersion: z.number().int().min(1).optional(),
  title: EntryTitle.optional(),
  content: EntryContent.optional(),
  disclosure: Disclosure.nullable().optional(),
  isPinned: z.boolean().optional(),
  envs: SceneSlugList.optional(),
  realms: SceneSlugList.optional(),
  projects: SceneSlugList.optional(),
  runtimes: SceneSlugList.optional(),
  topics: TopicList.optional(),
  validTo: ValidTo.nullable().optional(),
  promoteToEntry: z.boolean().optional(),
})
export type UpdateEntryRequest = z.infer<typeof UpdateEntryRequest>

export const RestoreEntryRequest = z.object({
  version: z.number().int().min(1).optional(),
})
export type RestoreEntryRequest = z.infer<typeof RestoreEntryRequest>

export const EntrySnapshot = z.object({
  kind: EntryKind,
  title: z.string(),
  content: z.string(),
  disclosure: z.string().nullable(),
  isPinned: z.boolean(),
  envs: z.array(z.string()),
  realms: z.array(z.string()),
  projects: z.array(z.string()),
  runtimes: z.array(z.string()),
  topics: z.array(z.string()),
  validTo: z.string().nullable(),
  version: z.number().int(),
})
export type EntrySnapshot = z.infer<typeof EntrySnapshot>

export const EntryHistoryItem = z.object({
  id: z.number().int(),
  eventType: EntryEventType,
  actor: z.string(),
  snapshot: EntrySnapshot,
  createdAt: z.string(),
})
export type EntryHistoryItem = z.infer<typeof EntryHistoryItem>

export const EntryHistoryResponse = z.object({
  items: z.array(EntryHistoryItem),
})
export type EntryHistoryResponse = z.infer<typeof EntryHistoryResponse>

// ---- 分组浏览契约（供 MCP kioku_browse 使用）----

export const BrowseEntriesQuery = z.object({
  groupBy: BrowseGroupBy.default('project'),
  kind: EntryKind.optional(),
  topic: TopicTag.optional(),
  project: SceneSlug.optional(),
  env: SceneSlug.optional(),
  realm: SceneSlug.optional(),
  runtime: SceneSlug.optional(),
  pinnedOnly: z.boolean().optional(),
  query: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
export type BrowseEntriesQuery = z.infer<typeof BrowseEntriesQuery>

export const EntryBrowseItem = z.object({
  shortId: ShortId,
  title: z.string(),
  kind: EntryKind,
  isPinned: z.boolean(),
  topics: z.array(z.string()),
  envs: z.array(z.string()),
  realms: z.array(z.string()),
  projects: z.array(z.string()),
  runtimes: z.array(z.string()),
  disclosure: z.string().nullable(),
})
export type EntryBrowseItem = z.infer<typeof EntryBrowseItem>

export const EntryBrowseGroup = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
  items: z.array(EntryBrowseItem),
})
export type EntryBrowseGroup = z.infer<typeof EntryBrowseGroup>

export const EntryBrowseResponse = z.object({
  groupBy: BrowseGroupBy,
  groups: z.array(EntryBrowseGroup),
  truncated: z.boolean(),
})
export type EntryBrowseResponse = z.infer<typeof EntryBrowseResponse>
