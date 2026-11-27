import {
  bootModeToPinned,
  CREDENTIAL_PLACEHOLDER_PREFIX,
  DISCLOSURE_MAX,
  ENTRY_CONTENT_MAX,
  firstMarkdownHeading,
  LORE_BACKUP_FORMAT,
  normalizeProjectSlug,
  normalizeSlugList,
  SCENE_SLUG_PATTERN,
  stripDuplicateLeadingHeading,
  stripLegacyGlossaryLines,
  TOPICS_MAX,
  TopicTag,
  type BootMode,
} from '@kioku/contracts'
import { z } from 'zod'

import { MemoryError } from '../memory/errors'

const MAX_ROWS = 200_000
const CLOCK_SKEW_MS = 24 * 3600_000

const SafeText = z.string().refine((v) => !v.includes('\0'), '不能包含空字符')
const IsoTime = SafeText.refine((v) => !Number.isNaN(Date.parse(v)), '时间格式不正确').refine(
  (v) => Date.parse(v) <= Date.now() + CLOCK_SKEW_MS,
  '时间在未来',
)
const LoreId = z
  .union([z.string().regex(/^\d{1,19}$/), z.number().int().nonnegative()])
  .transform((id) => BigInt(id).toString())
const LoreUuid = SafeText.min(1).max(200)

const NodeRow = z.object({ uuid: LoreUuid, created_at: IsoTime })
const MemoryRow = z.discriminatedUnion('deprecated', [
  z.object({ deprecated: z.literal(true), node_uuid: LoreUuid }),
  z.object({
    deprecated: z.literal(false),
    id: LoreId,
    node_uuid: LoreUuid,
    content: SafeText.nullable(),
    created_at: IsoTime,
  }),
])
const EdgeRow = z.object({
  id: LoreId,
  child_uuid: LoreUuid,
  priority: z.number().int(),
  disclosure: SafeText.nullable(),
})
const PathRow = z.object({
  domain: SafeText.min(1),
  path: SafeText,
  edge_id: LoreId,
  created_at: IsoTime,
})
const KeywordRow = z.object({ keyword: SafeText, node_uuid: LoreUuid })

const Table = z.array(z.unknown(), '缺少这张表').max(MAX_ROWS, `超过 ${MAX_ROWS} 行`)
const BackupSchema = z.object({
  created_at: IsoTime,
  tables: z.object(
    {
      nodes: Table,
      memories: Table,
      edges: Table,
      paths: Table,
      glossary_keywords: Table,
    },
    '缺少 tables',
  ),
})

function invalid(detail: string): MemoryError {
  return new MemoryError(400, `Lore 导出的内容有误：${detail}`)
}

function describeIssue(err: z.ZodError): string {
  const issue = err.issues[0]
  if (!issue) return '格式无效'
  const path = issue.path.length ? `${issue.path.join('.')} ` : ''
  return `${path}${issue.message}`
}

function rowsOf<T>(table: string, rows: unknown[], schema: z.ZodType<T>): T[] {
  return rows.map((row, i) => {
    const parsed = schema.safeParse(row)
    if (!parsed.success) throw invalid(`${table} 第 ${i + 1} 行 ${describeIssue(parsed.error)}`)
    return parsed.data
  })
}

function uniqueBy<T>(table: string, rows: T[], keyOf: (row: T) => string): Map<string, T> {
  const seen = new Map<string, T>()
  rows.forEach((row, i) => {
    const key = keyOf(row)
    if (seen.has(key)) throw invalid(`${table} 第 ${i + 1} 行与前面重复`)
    seen.set(key, row)
  })
  return seen
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function truncateSafe(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

const LORE_IMPORT_TOPICS_MAX = 5

function cleanTopic(raw: string): string | null {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, '-')
  if (!normalized || normalized.includes(CREDENTIAL_PLACEHOLDER_PREFIX)) return null
  const parsed = TopicTag.safeParse(normalized)
  return parsed.success ? parsed.data : null
}

function mapLoreUri(
  domain: string,
  path: string,
): {
  runtimes: string[]
  projects: string[]
  topics: string[]
  fallbackTitle: string
} {
  const d = domain.trim().toLowerCase()
  const segments = path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
  const fallbackTitle = segments.at(-1) ?? d
  const runtimes: string[] = []
  const projects: string[] = []
  const rawTopics: string[] = []

  if (d === 'core' && segments[0]?.toLowerCase() === 'agent' && segments[1]) {
    const candidate = segments[1].trim().toLowerCase()
    if (
      candidate !== 'generic' &&
      candidate !== 'mcp' &&
      SCENE_SLUG_PATTERN.test(candidate) &&
      !candidate.includes(CREDENTIAL_PLACEHOLDER_PREFIX)
    ) {
      runtimes.push(candidate)
    } else {
      rawTopics.push(candidate)
    }
    rawTopics.push('agent', ...segments.slice(2))
  } else if ((d === 'projects' || d === 'project') && segments[0]) {
    const project = normalizeProjectSlug(segments[0])
    if (project && SCENE_SLUG_PATTERN.test(project)) {
      projects.push(project)
    } else {
      rawTopics.push(segments[0])
    }
    rawTopics.push(...segments.slice(1))
  } else {
    rawTopics.push(d, ...segments)
  }

  const topics: string[] = []
  for (const seg of rawTopics) {
    const t = cleanTopic(seg)
    if (t && !topics.includes(t)) topics.push(t)
    if (topics.length >= LORE_IMPORT_TOPICS_MAX) break
  }

  return {
    runtimes: normalizeSlugList(runtimes),
    projects: normalizeSlugList(projects),
    topics: normalizeSlugList(topics),
    fallbackTitle,
  }
}

export interface ParsedLoreEntry {
  key: string
  uri: string
  title: string
  content: string
  disclosure: string | null
  isPinned: boolean
  bootMode: BootMode
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
  topics: string[]
  createdAt: Date
  updatedAt: Date
  skippedReason: string | null
}

export interface ParsedLoreResult {
  exportedAt: string
  entries: ParsedLoreEntry[]
}

export function parseLoreToEntries(raw: unknown): ParsedLoreResult {
  if ((raw as { format?: unknown } | null)?.format !== LORE_BACKUP_FORMAT) {
    throw new MemoryError(400, '不是 Lore 的导出文件')
  }
  const backup = BackupSchema.safeParse(raw)
  if (!backup.success) throw invalid(describeIssue(backup.error))
  const { tables } = backup.data

  const nodes = uniqueBy('nodes', rowsOf('nodes', tables.nodes, NodeRow), (n) => n.uuid)
  const edges = uniqueBy('edges', rowsOf('edges', tables.edges, EdgeRow), (e) => e.id)
  const paths = uniqueBy('paths', rowsOf('paths', tables.paths, PathRow), (p) =>
    JSON.stringify([p.domain, p.path]),
  )
  const memories = rowsOf('memories', tables.memories, MemoryRow)
  // 校验旧版导出表结构兼容性，但不再将无向量时代的 glossary_keywords 灌入 entries.topics
  rowsOf('glossary_keywords', tables.glossary_keywords, KeywordRow)

  const currentByNode = new Map<string, { content: string | null; at: number; id: bigint }>()
  for (const m of memories) {
    if (m.deprecated) continue
    const candidate = { content: m.content, at: Date.parse(m.created_at), id: BigInt(m.id) }
    const best = currentByNode.get(m.node_uuid)
    if (!best || candidate.at > best.at || (candidate.at === best.at && candidate.id > best.id)) {
      currentByNode.set(m.node_uuid, candidate)
    }
  }

  const ordered = [...paths.values()]
    .map((p) => ({ ...p, at: Date.parse(p.created_at) }))
    .sort((a, b) => a.at - b.at || compareText(a.domain, b.domain) || compareText(a.path, b.path))

  const seenNodes = new Set<string>()
  const result: ParsedLoreEntry[] = []

  for (const p of ordered) {
    const edge = edges.get(p.edge_id)
    const node = edge && nodes.get(edge.child_uuid)
    if (!edge || !node || seenNodes.has(node.uuid)) continue
    seenNodes.add(node.uuid)

    const uri = `${p.domain}://${p.path}`
    const body = currentByNode.get(node.uuid)
    const content = body?.content ?? ''
    const mapped = mapLoreUri(p.domain, p.path)
    const mergedTopics = mapped.topics.slice(0, Math.min(LORE_IMPORT_TOPICS_MAX, TOPICS_MAX))

    let skippedReason: string | null = null
    if (!content.trim()) {
      skippedReason = '节点正文为空'
    } else if (content.length > ENTRY_CONTENT_MAX) {
      skippedReason = `正文超过 ${ENTRY_CONTENT_MAX} 字上限`
    }

    const heading = content ? firstMarkdownHeading(content) : null
    const title = (heading ?? mapped.fallbackTitle).slice(0, 200) || uri
    const cleanedContent = content
      ? stripLegacyGlossaryLines(stripDuplicateLeadingHeading(title, content)).content
      : ''
    const rawDisclosure = edge.disclosure?.trim() ?? ''
    const disclosure =
      rawDisclosure && !rawDisclosure.includes(CREDENTIAL_PLACEHOLDER_PREFIX)
        ? truncateSafe(rawDisclosure, DISCLOSURE_MAX)
        : null

    const createdAt = new Date(node.created_at)
    const updatedAt = body ? new Date(body.at) : createdAt

    const bootMode: BootMode = edge.priority <= 0 ? 'full' : edge.priority === 1 ? 'index' : 'none'

    result.push({
      key: uri,
      uri,
      title,
      content: cleanedContent,
      disclosure,
      isPinned: bootModeToPinned(bootMode),
      bootMode,
      envs: [],
      realms: [],
      projects: mapped.projects,
      runtimes: mapped.runtimes,
      topics: mergedTopics,
      createdAt,
      updatedAt,
      skippedReason,
    })
  }

  return {
    exportedAt: new Date(backup.data.created_at).toISOString(),
    entries: result,
  }
}
