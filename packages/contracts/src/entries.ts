import { z } from 'zod'

import { HygieneWarning } from './hygiene'
import {
  CREDENTIAL_PLACEHOLDER_PREFIX,
  EntryLinkDirection,
  extractCredentialPlaceholders,
  extractTargetShortIds,
  ShortId,
} from './links'

export const ENTRY_KINDS = ['entry', 'episode'] as const
export const EntryKind = z.enum(ENTRY_KINDS).meta({ id: 'EntryKind' })
export type EntryKind = z.infer<typeof EntryKind>

export const BOOT_MODES = ['none', 'index', 'full'] as const
export const BootMode = z.enum(BOOT_MODES).meta({ id: 'BootMode' })
export type BootMode = z.infer<typeof BootMode>

export function bootModeToPinned(mode: BootMode): boolean {
  return mode !== 'none'
}

// 兼容同时存在 bootMode 与旧版 isPinned 字段的读写模型：显式 bootMode 优先，否则由 isPinned 推导
export function resolveBootMode(
  input: { bootMode?: BootMode | null | undefined; isPinned?: boolean | undefined },
  fallback: BootMode = 'none',
): BootMode {
  if (input.bootMode !== undefined && input.bootMode !== null) return input.bootMode
  if (input.isPinned !== undefined) return input.isPinned ? 'full' : 'none'
  return fallback
}

export function effectiveBootMode(row: {
  bootMode?: BootMode | null | undefined
  isPinned: boolean
}): BootMode {
  return row.bootMode ?? (row.isPinned ? 'full' : 'none')
}

export const BUILTIN_ENVS = ['mac', 'linux', 'win'] as const
export const BuiltinEnv = z.enum(BUILTIN_ENVS)
export type BuiltinEnv = z.infer<typeof BuiltinEnv>

export const ENTRY_TABS = ['all', 'pinned', 'regular', 'episodes', 'trash'] as const
export const EntryTab = z.enum(ENTRY_TABS)
export type EntryTab = z.infer<typeof EntryTab>

export const BROWSE_GROUP_BY = ['topic', 'project', 'env', 'realm', 'runtime', 'kind'] as const
export const BrowseGroupBy = z.enum(BROWSE_GROUP_BY).meta({ id: 'BrowseGroupBy' })
export type BrowseGroupBy = z.infer<typeof BrowseGroupBy>

export const ENTRY_EVENT_TYPES = [
  'create',
  'update',
  'delete',
  'undelete',
  'restore',
  'archive_note',
] as const
export const EntryEventType = z.enum(ENTRY_EVENT_TYPES)
export type EntryEventType = z.infer<typeof EntryEventType>

export const ENTRY_TITLE_MAX = 200
export const ENTRY_TITLE_NEW_MAX = 80
export const ENTRY_SUMMARY_MAX = 300
export const CHANGE_SUMMARY_MAX = 300
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

export const MERGE_FALLBACK_TOPICS_MAX = 5

// 合并重复词条且未指定新主题时，按出现频次与保留词条优先收敛主题上限，避免并集无限膨胀
export function mergeFallbackTopics(
  keepTopics: readonly string[],
  allTopicLists: readonly (readonly string[])[],
  limit = MERGE_FALLBACK_TOPICS_MAX,
): string[] {
  const keepSet = new Set(normalizeSlugList(keepTopics))
  const counts = new Map<string, number>()
  for (const list of allTopicLists) {
    for (const tag of normalizeSlugList(list)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      const aKeep = keepSet.has(a[0]) ? 1 : 0
      const bKeep = keepSet.has(b[0]) ? 1 : 0
      if (bKeep !== aKeep) return bKeep - aKeep
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    })
    .slice(0, Math.max(0, limit))
    .map(([tag]) => tag)
    .sort()
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

export const NewEntryTitle = z
  .string()
  .trim()
  .min(1, '标题不能为空')
  .max(ENTRY_TITLE_NEW_MAX, `新建标题最多 ${ENTRY_TITLE_NEW_MAX} 个字符`)
  .regex(/^\P{Cc}*$/u, '标题不能含控制字符')
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '凭据占位符只能写在正文里')

export const EntrySummary = z
  .string()
  .trim()
  .max(ENTRY_SUMMARY_MAX, `现行概要最多 ${ENTRY_SUMMARY_MAX} 个字符`)
  .regex(/^(?:[\r\n]|\P{Cc})*$/u, '现行概要不能含控制字符')
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '凭据占位符只能写在正文里')
  .transform((v) => v.replace(/[\r\n]+/g, ' ').trim())

export const ChangeSummary = z
  .string()
  .trim()
  .max(CHANGE_SUMMARY_MAX, `变更说明最多 ${CHANGE_SUMMARY_MAX} 个字符`)
  .regex(/^\P{Cc}*$/u, '变更说明不能含控制字符')
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '凭据占位符只能写在正文里')

export const Disclosure = z
  .string()
  .trim()
  .max(DISCLOSURE_MAX, `触发场景最多 ${DISCLOSURE_MAX} 个字符`)
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '凭据占位符只能写在正文里')

export interface EpisodeSignals {
  directives: string[]
  facts: string[]
}

export const EPISODE_SIGNAL_ITEMS_MAX = 5
export const EPISODE_SIGNAL_ITEM_MAX_CHARS = 100

const EPISODE_DIRECTIVES_PREFIX = '偏好：'
const EPISODE_FACTS_PREFIX = '事实：'
const EPISODE_SIGNAL_SEP = ' | '
const EPISODE_ITEM_SEP = '；'
const EPISODE_CRED_PLACEHOLDER_RE = /\{\{cred:[^}]*\}\}/gi
const EPISODE_CRED_PREFIX_RE = /\{\{cred:/gi
const EPISODE_CTRL_RE = /\p{Cc}+/gu

function cleanEpisodeSignalItems(raw: readonly string[] | undefined): string[] {
  if (!raw?.length) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const cleaned = item
      .replace(EPISODE_CRED_PLACEHOLDER_RE, '')
      .replace(EPISODE_CRED_PREFIX_RE, '')
      .replace(EPISODE_CTRL_RE, ' ')
      .replace(/[；;|｜]/g, '，')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned || cleaned.includes(CREDENTIAL_PLACEHOLDER_PREFIX)) continue
    const clipped = [...cleaned].slice(0, EPISODE_SIGNAL_ITEM_MAX_CHARS).join('').trim()
    const key = clipped.toLowerCase()
    if (!clipped || seen.has(key)) continue
    seen.add(key)
    out.push(clipped)
    if (out.length >= EPISODE_SIGNAL_ITEMS_MAX) break
  }
  return out
}

function packSignalSection(prefix: string, items: readonly string[], maxChars: number): string {
  if (!items.length || maxChars <= prefix.length) return ''
  const kept: string[] = []
  let len = prefix.length
  for (const item of items) {
    const sepLen = kept.length > 0 ? EPISODE_ITEM_SEP.length : 0
    if (len + sepLen + item.length <= maxChars) {
      kept.push(item)
      len += sepLen + item.length
    } else if (kept.length === 0) {
      const avail = maxChars - prefix.length
      if (avail > 0) kept.push([...item].slice(0, avail).join('').trim())
      break
    } else {
      break
    }
  }
  return kept.length ? `${prefix}${kept.join(EPISODE_ITEM_SEP)}` : ''
}

// 将会话摘要分拣出的行为偏好与确认事实序列化为人类可读的单行结构文本，复用 disclosure 列零 DDL 落库
export function serializeEpisodeSignals(
  signals:
    | {
        directives?: readonly string[] | undefined
        facts?: readonly string[] | undefined
      }
    | null
    | undefined,
): string | null {
  if (!signals) return null
  const directives = cleanEpisodeSignalItems(signals.directives)
  const facts = cleanEpisodeSignalItems(signals.facts)
  if (!directives.length && !facts.length) return null

  if (directives.length && !facts.length) {
    return packSignalSection(EPISODE_DIRECTIVES_PREFIX, directives, DISCLOSURE_MAX) || null
  }
  if (!directives.length && facts.length) {
    return packSignalSection(EPISODE_FACTS_PREFIX, facts, DISCLOSURE_MAX) || null
  }

  const directiveBudget = Math.min(280, DISCLOSURE_MAX - EPISODE_SIGNAL_SEP.length - 40)
  const dirPart = packSignalSection(EPISODE_DIRECTIVES_PREFIX, directives, directiveBudget)
  const remaining = DISCLOSURE_MAX - (dirPart ? dirPart.length + EPISODE_SIGNAL_SEP.length : 0)
  const factPart = packSignalSection(EPISODE_FACTS_PREFIX, facts, remaining)
  const parts = [dirPart, factPart].filter(Boolean)
  return parts.length ? parts.join(EPISODE_SIGNAL_SEP) : null
}

// 解析 episode.disclosure 中的结构化偏好与事实要点；旧版自由文本或空值安全返回空数组
export function parseEpisodeSignals(raw: string | null | undefined): EpisodeSignals {
  if (!raw?.trim()) return { directives: [], facts: [] }
  const directives: string[] = []
  const facts: string[] = []
  const segments = raw
    .split(/\s*\|\s*|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const seg of segments) {
    if (seg.startsWith(EPISODE_DIRECTIVES_PREFIX)) {
      const body = seg.slice(EPISODE_DIRECTIVES_PREFIX.length)
      directives.push(
        ...body
          .split(EPISODE_ITEM_SEP)
          .map((x) => x.trim())
          .filter(Boolean),
      )
    } else if (seg.startsWith(EPISODE_FACTS_PREFIX)) {
      const body = seg.slice(EPISODE_FACTS_PREFIX.length)
      facts.push(
        ...body
          .split(EPISODE_ITEM_SEP)
          .map((x) => x.trim())
          .filter(Boolean),
      )
    }
  }
  return {
    directives: cleanEpisodeSignalItems(directives),
    facts: cleanEpisodeSignalItems(facts),
  }
}

export function hasEpisodeSignals(raw: string | null | undefined): boolean {
  const parsed = parseEpisodeSignals(raw)
  return parsed.directives.length > 0 || parsed.facts.length > 0
}

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

// 同时提取 repoName 与 dirName 归一化标识（去重最多 2 个），避免 worktree 或改目录名漏匹配
export function extractProjectSlugs(
  input:
    { repoName?: string | undefined; dirName?: string | undefined } | string | null | undefined,
): string[] {
  if (!input) return []
  if (typeof input === 'string') {
    const slug = normalizeProjectSlug(input)
    return slug ? [slug] : []
  }
  const slugs: string[] = []
  const repo = normalizeProjectSlug(input.repoName)
  if (repo) slugs.push(repo)
  const dir = normalizeProjectSlug(input.dirName)
  if (dir && !slugs.includes(dir)) slugs.push(dir)
  return slugs
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
    relation: z.string().nullable().optional(),
    contextSnippet: z.string().nullable().optional(),
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

export const EntryDiffMeta = z.object({
  changedFields: z.array(z.string()),
  contentCharsBefore: z.number().int(),
  contentCharsAfter: z.number().int(),
})
export type EntryDiffMeta = z.infer<typeof EntryDiffMeta>

export const ENTRY_ACTOR_KINDS = [
  'console',
  'agent',
  'dream',
  'extraction',
  'capture',
  'system',
] as const
export const EntryActorKind = z.enum(ENTRY_ACTOR_KINDS)
export type EntryActorKind = z.infer<typeof EntryActorKind>

export const EntryActorMeta = z.object({
  kind: EntryActorKind,
  label: z.string(),
  runtimeFamily: z.string().nullable().optional(),
})
export type EntryActorMeta = z.infer<typeof EntryActorMeta>

export const ArchivedHistoryNote = z.object({
  occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
  note: ChangeSummary.min(1, '历史说明不能为空'),
})
export type ArchivedHistoryNote = z.infer<typeof ArchivedHistoryNote>

export const EntryRecentHistoryItem = z.object({
  id: z.number().int(),
  version: z.number().int().nullable(),
  eventType: EntryEventType,
  actor: z.string(),
  actorMeta: EntryActorMeta.optional(),
  changeSummary: z.string().nullable(),
  diffMeta: EntryDiffMeta.nullable().optional(),
  occurredAt: z.string().nullable().optional(),
  createdAt: z.string(),
})
export type EntryRecentHistoryItem = z.infer<typeof EntryRecentHistoryItem>

export const EntryView = z
  .object({
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
    deviceKey: z.string().nullable(),
    projectSlug: z.string().nullable(),
    validTo: z.string().nullable(),
    verifiedAt: z.string().nullable().optional(),
    lastChangeSummary: z.string().nullable().optional(),
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
    summary: z.string().nullable().optional(),
    disclosure: z.string().nullable(),
    isPinned: z.boolean(),
    bootMode: BootMode.optional(),
    envs: z.array(z.string()),
    realms: z.array(z.string()),
    projects: z.array(z.string()),
    runtimes: z.array(z.string()),
    topics: z.array(z.string()),
    validTo: z.string().nullable(),
    verifiedAt: z.string().nullable().optional(),
    lastChangeSummary: z.string().nullable().optional(),
    charCount: z.number().int().optional(),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    snippet: z.string().optional(),
    score: z.number().optional(),
  })
  .meta({ id: 'EntryListItem' })
export type EntryListItem = z.infer<typeof EntryListItem>

export const PINNED_GROUPS = ['global_full', 'scoped_full', 'index'] as const
export const PinnedGroup = z.enum(PINNED_GROUPS)
export type PinnedGroup = z.infer<typeof PinnedGroup>

export const PROJECT_SCOPES = ['assigned', 'unassigned'] as const
export const ProjectScope = z.enum(PROJECT_SCOPES)
export type ProjectScope = z.infer<typeof ProjectScope>

export const EntryListQuery = z.object({
  tab: EntryTab.default('all'),
  pinnedGroup: PinnedGroup.optional(),
  q: z.string().trim().max(2000).optional(),
  env: SceneSlug.optional(),
  realm: SceneSlug.optional(),
  project: SceneSlug.optional(),
  projectScope: ProjectScope.optional(),
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
  runtimes: z.array(z.string()).optional(),
  topics: z.array(z.string()),
})
export type EntryFacetsSummary = z.infer<typeof EntryFacetsSummary>

export const EntryTabCounts = z.object({
  all: z.number().int(),
  pinned: z.number().int(),
  regular: z.number().int(),
  episodes: z.number().int(),
  trash: z.number().int(),
  pinnedChars: z.number().int().optional(),
  globalFullPinnedCount: z.number().int().optional(),
  globalFullPinnedChars: z.number().int().optional(),
  scopedFullPinnedCount: z.number().int().optional(),
  indexPinnedCount: z.number().int().optional(),
})
export type EntryTabCounts = z.infer<typeof EntryTabCounts>

export const EntryListResponse = z.object({
  items: z.array(EntryListItem),
  nextCursor: z.string().nullable(),
  facets: EntryFacetsSummary,
  counts: EntryTabCounts,
  linkedTitles: z.record(z.string(), z.string()).optional(),
})
export type EntryListResponse = z.infer<typeof EntryListResponse>

export const EntryDetailResponse = z.object({
  entry: EntryView,
  outboundLinks: z.array(EntryLinkNeighbor),
  backlinks: z.array(EntryLinkNeighbor),
  credentialRefs: z.array(CredentialRefStatus),
  recentHistory: z.array(EntryRecentHistoryItem).optional(),
  warnings: z.array(HygieneWarning).optional(),
  pendingSuggestionCount: z.number().int().min(0).optional(),
  linkedTitles: z.record(z.string(), z.string()).optional(),
})
export type EntryDetailResponse = z.infer<typeof EntryDetailResponse>

export const EntryPatchInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('replace'),
    oldText: z.string().min(1, '待替换片段不能为空'),
    newText: z.string().min(1, '替换内容不能为空'),
  }),
  z.object({
    kind: z.literal('insert_under_heading'),
    heading: z.string().trim().min(1, '目标小节不能为空').max(200),
    text: z.string().min(1, '插入内容不能为空'),
  }),
  z.object({
    kind: z.literal('append'),
    text: z.string().min(1, '追加内容不能为空'),
  }),
])
export type EntryPatchInput = z.infer<typeof EntryPatchInput>

export const CreateEntryRequest = z.object({
  title: NewEntryTitle.optional(),
  summary: EntrySummary.nullable().optional(),
  content: EntryContent,
  disclosure: Disclosure.nullable().optional(),
  changeSummary: ChangeSummary.nullable().optional(),
  isPinned: z.boolean().default(false),
  bootMode: BootMode.optional(),
  envs: SceneSlugList.default([]),
  realms: SceneSlugList.optional(),
  projects: SceneSlugList.default([]),
  runtimes: SceneSlugList.default([]),
  topics: TopicList.default([]),
  validTo: ValidTo.nullable().optional(),
})
export type CreateEntryRequest = z.infer<typeof CreateEntryRequest>

export const UpdateEntryRequest = z
  .object({
    expectedVersion: z.number().int().min(1).optional(),
    title: EntryTitle.optional(),
    summary: EntrySummary.nullable().optional(),
    content: EntryContent.optional(),
    patch: EntryPatchInput.optional(),
    disclosure: Disclosure.nullable().optional(),
    changeSummary: ChangeSummary.nullable().optional(),
    verified: z.boolean().optional(),
    isPinned: z.boolean().optional(),
    bootMode: BootMode.optional(),
    envs: SceneSlugList.optional(),
    realms: SceneSlugList.optional(),
    projects: SceneSlugList.optional(),
    runtimes: SceneSlugList.optional(),
    topics: TopicList.optional(),
    validTo: ValidTo.nullable().optional(),
    promoteToEntry: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.content !== undefined && val.patch !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['patch'],
        message: '正文整体替换与局部补丁不能同时传入',
      })
    }
  })
export type UpdateEntryRequest = z.infer<typeof UpdateEntryRequest>

export const RestoreEntryRequest = z.object({
  version: z.number().int().min(1).optional(),
  expectedVersion: z.number().int().min(1).optional(),
})
export type RestoreEntryRequest = z.infer<typeof RestoreEntryRequest>

export const EntrySnapshot = z.object({
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
  validTo: z.string().nullable(),
  verifiedAt: z.string().nullable().optional(),
  version: z.number().int(),
})
export type EntrySnapshot = z.infer<typeof EntrySnapshot>

export const EntryHistoryItem = z.object({
  id: z.number().int(),
  eventType: EntryEventType,
  actor: z.string(),
  actorMeta: EntryActorMeta.optional(),
  changeSummary: z.string().nullable().optional(),
  diffMeta: EntryDiffMeta.nullable().optional(),
  occurredAt: z.string().nullable().optional(),
  snapshot: EntrySnapshot.optional(),
  version: z.number().int().nullable().optional(),
  createdAt: z.string(),
})
export type EntryHistoryItem = z.infer<typeof EntryHistoryItem>

export const EntryHistoryResponse = z.object({
  items: z.array(EntryHistoryItem),
  linkedTitles: z.record(z.string(), z.string()).optional(),
})
export type EntryHistoryResponse = z.infer<typeof EntryHistoryResponse>

export const EntryHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  version: z.coerce.number().int().min(1).optional(),
  includeSnapshots: z
    .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional())
    .optional(),
})
export type EntryHistoryQuery = z.infer<typeof EntryHistoryQuery>

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
  summary: z.string().nullable().optional(),
  kind: EntryKind,
  isPinned: z.boolean(),
  bootMode: BootMode.optional(),
  topics: z.array(z.string()),
  envs: z.array(z.string()),
  realms: z.array(z.string()),
  projects: z.array(z.string()),
  runtimes: z.array(z.string()),
  disclosure: z.string().nullable(),
  updatedAt: z.string().optional(),
  lastChangeSummary: z.string().nullable().optional(),
  contentLength: z.number().int().optional(),
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

// ---- 随手记归并契约与局部 Markdown 补丁工具 ----

export const CAPTURE_TEXT_MAX = 8_000
export const CAPTURE_ACTIONS = ['update', 'create', 'noop'] as const
export const CaptureAction = z.enum(CAPTURE_ACTIONS)
export type CaptureAction = z.infer<typeof CaptureAction>

export const CAPTURE_PATCH_KINDS = [
  'insert_under_heading',
  'append',
  'replace',
  'create',
  'noop',
] as const
export const CapturePatchKind = z.enum(CAPTURE_PATCH_KINDS)
export type CapturePatchKind = z.infer<typeof CapturePatchKind>

export const CapturePlanRequest = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, '请输入要记录的内容')
      .max(CAPTURE_TEXT_MAX, `随手记内容最多 ${CAPTURE_TEXT_MAX} 个字符`),
    targetShortId: ShortId.optional(),
    mode: z.enum(['auto', 'append', 'refine']).default('auto'),
    heading: z.string().trim().max(200).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'refine' && !val.targetShortId) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetShortId'],
        message: '按说明微调必须指定目标记忆',
      })
    }
  })
export type CapturePlanRequest = z.infer<typeof CapturePlanRequest>

export const CaptureCandidate = z.object({
  shortId: ShortId,
  title: z.string(),
  summary: z.string().nullable().optional(),
  disclosure: z.string().nullable(),
  isPinned: z.boolean(),
  envs: z.array(z.string()).optional(),
  realms: z.array(z.string()).optional(),
  projects: z.array(z.string()),
  runtimes: z.array(z.string()).optional(),
  topics: z.array(z.string()),
  version: z.number().int(),
  score: z.number(),
  headings: z.array(z.string()),
  content: z.string(),
})
export type CaptureCandidate = z.infer<typeof CaptureCandidate>

export const CaptureIntegrity = z.object({
  intact: z.boolean(),
  linksBefore: z.number().int(),
  linksAfter: z.number().int(),
  missingLinks: z.array(z.string()),
  credsBefore: z.number().int(),
  credsAfter: z.number().int(),
  missingCreds: z.array(z.string()),
  severeShrink: z.boolean(),
})
export type CaptureIntegrity = z.infer<typeof CaptureIntegrity>

export const CaptureProposedNew = z.object({
  title: z.string(),
  content: z.string(),
  disclosure: z.string().nullable(),
  topics: z.array(z.string()),
  envs: z.array(z.string()),
  realms: z.array(z.string()),
  projects: z.array(z.string()),
  runtimes: z.array(z.string()),
  isPinned: z.boolean(),
})
export type CaptureProposedNew = z.infer<typeof CaptureProposedNew>

export const CapturePlanResponse = z.object({
  mode: z.enum(['llm', 'manual']),
  fallbackReason: z.string().nullable(),
  action: CaptureAction,
  patchKind: CapturePatchKind,
  patchHeading: z.string().nullable(),
  reason: z.string(),
  targetShortId: ShortId.nullable(),
  targetVersion: z.number().int().nullable(),
  beforeContent: z.string().nullable(),
  proposedContent: z.string().nullable(),
  integrity: CaptureIntegrity.nullable(),
  proposedTitle: EntryTitle.nullable().optional(),
  proposedSummary: EntrySummary.nullable().optional(),
  proposedDisclosure: Disclosure.nullable().optional(),
  proposedEnvs: SceneSlugList.nullable().optional(),
  proposedProjects: SceneSlugList.nullable().optional(),
  proposedRealms: SceneSlugList.nullable().optional(),
  proposedRuntimes: SceneSlugList.nullable().optional(),
  proposedChangeSummary: ChangeSummary.nullable().optional(),
  proposedNew: CaptureProposedNew,
  candidates: z.array(CaptureCandidate),
})
export type CapturePlanResponse = z.infer<typeof CapturePlanResponse>

const H2_HEADING_RE = /^ {0,3}##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/

// 提取正文中的二级标题（跳过围栏代码块），供随手记按小节插入使用
export function extractMarkdownHeadings(content: string): string[] {
  const headings: string[] = []
  const seen = new Set<string>()
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
    const heading = H2_HEADING_RE.exec(line)?.[1]?.trim()
    if (heading && !seen.has(heading)) {
      seen.add(heading)
      headings.push(heading)
    }
  }
  return headings
}

function formatAppendSnippet(note: string): string {
  const trimmed = note.replace(/\r\n/g, '\n').trim()
  if (!trimmed) return ''
  // 多行或已带列表/标题前缀时保持原结构，单行普通文本格式化为无序列表项
  if (trimmed.includes('\n') || /^([-*+]\s|\d+\.\s|#{1,6}\s|> )/.test(trimmed)) {
    return trimmed
  }
  return `- ${trimmed}`
}

function stripOuterBlankLines(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]!.trim() === '') start++
  while (end > start && lines[end - 1]!.trim() === '') end--
  return lines.slice(start, end)
}

// 确定性将一条记录追加到指定二级小节末尾（或文档末尾），不改写任何既有段落
export function applyMarkdownAppend(
  content: string,
  note: string,
  heading?: string | null,
): { content: string; matchedHeading: string | null } {
  const snippet = formatAppendSnippet(note)
  if (!snippet) return { content, matchedHeading: null }

  const normalizedContent = content.replace(/\r\n/g, '\n')
  const want = heading
    ?.trim()
    .replace(/^#{1,6}[ \t]+/, '')
    .trim()
  if (!want) {
    const base = normalizedContent.trimEnd()
    return {
      content: base ? `${base}\n${snippet}` : snippet,
      matchedHeading: null,
    }
  }

  const lines = normalizedContent.split('\n')
  let fence: string | null = null
  let matchIndex = -1
  let matchedName: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
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
    const h = H2_HEADING_RE.exec(line)?.[1]?.trim()
    if (!h) continue
    if (h === want || (matchIndex === -1 && h.toLowerCase() === want.toLowerCase())) {
      matchIndex = i
      matchedName = h
      if (h === want) break
    }
  }

  if (matchIndex === -1) {
    const base = normalizedContent.trimEnd()
    return {
      content: base ? `${base}\n${snippet}` : snippet,
      matchedHeading: null,
    }
  }

  // 找到该二级标题下直到下一个同级/更高级标题之间的最后一行非空内容
  let insertAt = lines.length
  fence = null
  for (let i = matchIndex + 1; i < lines.length; i++) {
    const line = lines[i]!
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
    if (/^ {0,3}#{1,2}[ \t]+/.test(line)) {
      insertAt = i
      break
    }
  }

  while (insertAt > matchIndex + 1 && lines[insertAt - 1]!.trim() === '') {
    insertAt--
  }
  lines.splice(insertAt, 0, snippet)
  return { content: lines.join('\n'), matchedHeading: matchedName }
}

export type CaptureLocalPatch =
  | { kind: 'insert_under_heading'; heading: string; text: string }
  | { kind: 'append'; text: string }
  | { kind: 'replace'; oldText: string; newText: string }

export type ApplyCapturePatchResult =
  | { ok: true; content: string; matchedHeading: string | null }
  | { ok: false; reason: string; unchanged?: boolean; overflow?: boolean }

function finishPatchedContent(
  beforeNormalized: string,
  nextContent: string,
  matchedHeading: string | null,
): ApplyCapturePatchResult {
  if (nextContent === beforeNormalized) {
    return { ok: false, reason: '修改后正文与原文一致', unchanged: true }
  }
  if (nextContent.length > ENTRY_CONTENT_MAX) {
    return {
      ok: false,
      reason: `归并后正文超过 ${ENTRY_CONTENT_MAX} 字符上限`,
      overflow: true,
    }
  }
  return { ok: true, content: nextContent, matchedHeading }
}

// 将局部补丁确定性应用到完整正文，避免整篇重写误删无关内容
export function applyCapturePatch(
  content: string,
  patch: CaptureLocalPatch,
): ApplyCapturePatchResult {
  const normalized = content.replace(/\r\n/g, '\n')

  if (patch.kind === 'append') {
    const text = patch.text.replace(/\r\n/g, '\n').trim()
    if (!text) return { ok: false, reason: '追加内容为空' }
    const res = applyMarkdownAppend(normalized, text, null)
    return finishPatchedContent(normalized, res.content, null)
  }

  if (patch.kind === 'insert_under_heading') {
    const text = patch.text.replace(/\r\n/g, '\n').trim()
    if (!text) return { ok: false, reason: '插入内容为空' }
    const res = applyMarkdownAppend(normalized, text, patch.heading)
    if (!res.matchedHeading) {
      return { ok: false, reason: `未找到小节「${patch.heading}」` }
    }
    return finishPatchedContent(normalized, res.content, res.matchedHeading)
  }

  const oldNorm = patch.oldText.replace(/\r\n/g, '\n')
  const newNorm = patch.newText.replace(/\r\n/g, '\n')
  if (!oldNorm.trim()) return { ok: false, reason: '待替换片段为空' }
  if (!newNorm.trim()) return { ok: false, reason: '替换内容为空' }

  const firstIdx = normalized.indexOf(oldNorm)
  if (firstIdx !== -1) {
    if (normalized.indexOf(oldNorm, firstIdx + 1) !== -1) {
      return { ok: false, reason: '待替换片段在正文中出现多处，无法唯一定位' }
    }
    const next =
      normalized.slice(0, firstIdx) + newNorm + normalized.slice(firstIdx + oldNorm.length)
    return finishPatchedContent(normalized, next, null)
  }

  // 容忍首尾空白差异的单行/多行精确行匹配
  const contentLines = normalized.split('\n')
  const oldLines = stripOuterBlankLines(oldNorm.split('\n')).map((l) => l.trim())
  if (!oldLines.length) return { ok: false, reason: '未匹配到待替换片段' }

  const matches: number[] = []
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let allEqual = true
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j]!.trim() !== oldLines[j]) {
        allEqual = false
        break
      }
    }
    if (allEqual) matches.push(i)
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: matches.length === 0 ? '未在正文中找到待替换片段' : '待替换片段存在多处匹配',
    }
  }
  const start = matches[0]!
  const nextLines = [...contentLines]
  const replacementLines = stripOuterBlankLines(newNorm.split('\n'))
  nextLines.splice(start, oldLines.length, ...replacementLines)
  return finishPatchedContent(normalized, nextLines.join('\n'), null)
}

// 校验归并前后的双链、凭据占位符与篇幅变化，防止误删既有引用
export function checkCaptureIntegrity(before: string, after: string): CaptureIntegrity {
  const linksBeforeList = extractTargetShortIds(before)
  const linksAfterSet = new Set(extractTargetShortIds(after))
  const missingLinks = linksBeforeList.filter((id) => !linksAfterSet.has(id))

  const credKey = (p: { slug: string; field: string | null }) =>
    p.field ? `${p.slug}#${p.field}` : p.slug
  const credsBeforeSet = new Set(extractCredentialPlaceholders(before).map(credKey))
  const credsAfterSet = new Set(extractCredentialPlaceholders(after).map(credKey))
  const missingCreds = [...credsBeforeSet].filter((k) => !credsAfterSet.has(k))

  const severeShrink = before.length >= 200 && after.length < Math.floor(before.length * 0.5)
  const intact = missingLinks.length === 0 && missingCreds.length === 0 && !severeShrink

  return {
    intact,
    linksBefore: linksBeforeList.length,
    linksAfter: linksAfterSet.size,
    missingLinks,
    credsBefore: credsBeforeSet.size,
    credsAfter: credsAfterSet.size,
    missingCreds,
    severeShrink,
  }
}

// ---- Markdown 二级小节直取与大纲提取 ----

export interface MarkdownOutlineSection {
  heading: string
  charCount: number
  preview: string
}

interface SectionSpan {
  heading: string
  startLine: number
  endLine: number
}

function scanH2Sections(lines: readonly string[]): SectionSpan[] {
  const spans: SectionSpan[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
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
    const h2 = H2_HEADING_RE.exec(line)?.[1]?.trim()
    if (h2) {
      if (spans.length && spans[spans.length - 1]!.endLine === lines.length) {
        spans[spans.length - 1]!.endLine = i
      }
      spans.push({ heading: h2, startLine: i, endLine: lines.length })
    } else if (/^ {0,3}#[ \t]+/.test(line) && spans.length) {
      if (spans[spans.length - 1]!.endLine === lines.length) {
        spans[spans.length - 1]!.endLine = i
      }
    }
  }
  return spans
}

export function extractMarkdownOutline(content: string): MarkdownOutlineSection[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const spans = scanH2Sections(lines)
  return spans.map((span) => {
    const bodyLines = lines.slice(span.startLine + 1, span.endLine)
    const bodyText = bodyLines.join('\n').trim()
    let firstNonEmpty = ''
    let fence: string | null = null
    for (const raw of bodyLines) {
      const [, marker, info = ''] = FENCE_RE.exec(raw) ?? []
      if (fence !== null) {
        const closes =
          marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
        if (closes && /^[ \t]*$/.test(info)) fence = null
        continue
      }
      if (marker && !(marker[0] === '`' && info.includes('`'))) {
        fence = marker
        continue
      }
      const trimmed = raw.trim()
      if (trimmed) {
        firstNonEmpty = trimmed
        break
      }
    }
    const preview = firstNonEmpty.replace(/^(?:[-*+]|\d+\.|#{1,6}|>)\s+/, '').slice(0, 80)
    return {
      heading: span.heading,
      charCount: bodyText.length,
      preview,
    }
  })
}

export function extractMarkdownSection(
  content: string,
  query: string,
): { heading: string; content: string } | null {
  const want = query
    .trim()
    .replace(/^#{1,6}[ \t]+/, '')
    .trim()
  if (!want) return null
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const spans = scanH2Sections(lines)
  if (!spans.length) return null

  const lowerWant = want.toLowerCase()
  const matched =
    spans.find((s) => s.heading === want) ??
    spans.find((s) => s.heading.toLowerCase() === lowerWant) ??
    spans.find((s) => s.heading.toLowerCase().includes(lowerWant))
  if (!matched) return null

  return {
    heading: matched.heading,
    content: lines.slice(matched.startLine, matched.endLine).join('\n').trim(),
  }
}

// ---- 存量确定性预清洗与结构体检契约 ----

export const HYGIENE_SWEEP_FIX_KINDS = [
  'strip_duplicate_heading',
  'strip_legacy_glossary',
  'rewrite_legacy_links',
] as const
export const HygieneSweepFixKind = z.enum(HYGIENE_SWEEP_FIX_KINDS)
export type HygieneSweepFixKind = z.infer<typeof HygieneSweepFixKind>

export const HygieneSweepRewrite = z.object({
  raw: z.string(),
  replacement: z.string(),
  targetShortId: ShortId,
  targetTitle: z.string(),
})
export type HygieneSweepRewrite = z.infer<typeof HygieneSweepRewrite>

export const HygieneSweepCandidate = z.object({
  id: z.uuid(),
  shortId: ShortId,
  title: z.string(),
  isPinned: z.boolean(),
  version: z.number().int(),
  fixes: z.array(HygieneSweepFixKind),
  rewrites: z.array(HygieneSweepRewrite),
  unresolvedRefs: z.array(z.string()),
  beforeChars: z.number().int(),
  afterChars: z.number().int(),
})
export type HygieneSweepCandidate = z.infer<typeof HygieneSweepCandidate>

export const HygieneSweepFlag = z.object({
  id: z.uuid(),
  shortId: ShortId,
  title: z.string(),
  isPinned: z.boolean(),
  charCount: z.number().int(),
  reason: z.string(),
})
export type HygieneSweepFlag = z.infer<typeof HygieneSweepFlag>

export const HygieneSweepBrokenLinkTarget = z.object({
  targetShortId: ShortId,
  status: z.enum(['missing', 'deleted']),
  targetTitle: z.string().nullable(),
})
export type HygieneSweepBrokenLinkTarget = z.infer<typeof HygieneSweepBrokenLinkTarget>

export const HygieneSweepBrokenLink = z.object({
  id: z.uuid(),
  shortId: ShortId,
  title: z.string(),
  isPinned: z.boolean(),
  targets: z.array(HygieneSweepBrokenLinkTarget),
})
export type HygieneSweepBrokenLink = z.infer<typeof HygieneSweepBrokenLink>

export const HygieneSweepPreviewResponse = z.object({
  totalScanned: z.number().int(),
  dirtyTitleCount: z.number().int(),
  deterministicCandidates: z.array(HygieneSweepCandidate),
  suspectTruncated: z.array(HygieneSweepFlag),
  suspectObsolete: z.array(HygieneSweepFlag),
  brokenLinks: z.array(HygieneSweepBrokenLink).optional(),
})
export type HygieneSweepPreviewResponse = z.infer<typeof HygieneSweepPreviewResponse>

export const HygieneSweepApplyRequest = z.object({
  shortIds: z.array(ShortId).max(500).optional(),
})
export type HygieneSweepApplyRequest = z.infer<typeof HygieneSweepApplyRequest>

export const HygieneSweepApplyResponse = z.object({
  applied: z.number().int(),
  skipped: z.number().int(),
  appliedShortIds: z.array(ShortId),
})
export type HygieneSweepApplyResponse = z.infer<typeof HygieneSweepApplyResponse>
