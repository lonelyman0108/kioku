import { LORE_BACKUP_FORMAT } from '@kioku/contracts'
import { z } from 'zod'

import { describeIssue, Text, Time } from '../backup/spaceRecords'
import { MemoryError } from '../memory/service'
import { formatUri } from '../memory/uri'
import type { LoreNode, LoreSnapshot } from './lore'

// 把 Lore 的导出（GET /api/backup?action=export）转成和 readLore 相同的 LoreSnapshot，取舍规则也相同：
// 从路径出发做内连接（Lore 删节点只删路径与边，节点和没废弃的正文都留着；引用不到的路径跳过，不报错），
// 同一个节点最早的路径作为 URI，其余是别名。业务范围（priority、正文长度）留给 planImport，超出时只跳过那一个节点。
// 这份数据没有数据库的保证，所以逐字段校验（只看用到的列，Lore 不同版本的其余列不管），
// 主键重复、未来的时间、存不进数据库的字符都拒绝整个文件。报错只说第几行、哪个字段，不带内容

const invalid = (detail: string) => new MemoryError(400, `Lore 导出的内容有误：${detail}`)

// 一张表最多这么多行：请求体已经有上限，这里挡住那个上限之内的空行
const MAX_ROWS = 200_000
// 两台机器的时钟差得再远也不到这么多：超出的按未来的时间拒绝。这个时间会进「近期更新」的排序，
// 也是判断文件新旧的依据，写成很远的将来就一直排在最前、之后的文件都算旧
const CLOCK_SKEW_MS = 24 * 3600_000

const LoreTime = Time.refine((value) => Date.parse(value) <= Date.now() + CLOCK_SKEW_MS, {
  message: '时间在未来',
})
// id 在 Lore 的驱动下一个是字符串（bigserial）、一个是数字（integer），老结构还可能反过来：统一成十进制字符串再连接
const LoreId = z
  .union([z.string().regex(/^\d{1,19}$/), z.number().int().nonnegative()])
  .transform((id) => BigInt(id).toString())
// Lore 的 uuid 列是 text，不要求 UUID 的格式
const LoreUuid = Text.min(1).max(200)

const NodeRow = z.object({ uuid: LoreUuid, created_at: LoreTime })
// 废弃的版本只用来数旧版本：上传时没有正文，拉取时有也不看
const MemoryRow = z.discriminatedUnion('deprecated', [
  z.object({ deprecated: z.literal(true), node_uuid: LoreUuid }),
  z.object({
    deprecated: z.literal(false),
    id: LoreId,
    node_uuid: LoreUuid,
    content: Text.nullable(),
    created_at: LoreTime,
  }),
])
const EdgeRow = z.object({
  id: LoreId,
  child_uuid: LoreUuid,
  priority: z.number().int(),
  disclosure: Text.nullable(),
})
const PathRow = z.object({
  domain: Text.min(1),
  path: Text,
  edge_id: LoreId,
  created_at: LoreTime,
})
const KeywordRow = z.object({ keyword: Text, node_uuid: LoreUuid })

const Table = z.array(z.unknown(), '缺少这张表').max(MAX_ROWS, `超过 ${MAX_ROWS} 行`)
const Backup = z.object({
  created_at: LoreTime,
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

function rowsOf<T>(table: string, rows: unknown[], schema: z.ZodType<T>): T[] {
  return rows.map((row, i) => {
    const parsed = schema.safeParse(row)
    if (!parsed.success) throw invalid(`${table} 第 ${i + 1} 行 ${describeIssue(parsed.error)}`)
    return parsed.data
  })
}

// 按主键放进 Map：重复的主键是数据库不可能给出的，算文件不对
function uniqueBy<T>(table: string, rows: T[], keyOf: (row: T) => string): Map<string, T> {
  const seen = new Map<string, T>()
  rows.forEach((row, i) => {
    const key = keyOf(row)
    if (seen.has(key)) throw invalid(`${table} 第 ${i + 1} 行和前面的行重复`)
    seen.set(key, row)
  })
  return seen
}

// 按码点比较，结果不随行序变。readLore 由数据库按它的排序规则排，只有同一毫秒的别名才可能和这里不同
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export interface ParsedLoreBackup {
  snapshot: LoreSnapshot
  // 导出时间（ISO 8601），判断文件新旧用
  exportedAt: string
}

export function parseLoreBackup(raw: unknown): ParsedLoreBackup {
  if ((raw as { format?: unknown } | null)?.format !== LORE_BACKUP_FORMAT) {
    throw new MemoryError(400, '不是 Lore 的导出文件')
  }
  const backup = Backup.safeParse(raw)
  if (!backup.success) throw invalid(describeIssue(backup.error))
  const { tables } = backup.data

  const nodes = uniqueBy('nodes', rowsOf('nodes', tables.nodes, NodeRow), (n) => n.uuid)
  const edges = uniqueBy('edges', rowsOf('edges', tables.edges, EdgeRow), (e) => e.id)
  const paths = uniqueBy('paths', rowsOf('paths', tables.paths, PathRow), (p) =>
    JSON.stringify([p.domain, p.path]),
  )
  const memories = rowsOf('memories', tables.memories, MemoryRow)
  const keywords = rowsOf('glossary_keywords', tables.glossary_keywords, KeywordRow)

  // 当前版本：没废弃的里最新的一条，时间相同时按 id 的数值
  const current = new Map<string, { content: string | null; at: number; id: bigint }>()
  const versions = new Map<string, number>()
  for (const m of memories) {
    if (m.deprecated) {
      versions.set(m.node_uuid, (versions.get(m.node_uuid) ?? 0) + 1)
      continue
    }
    const candidate = { content: m.content, at: Date.parse(m.created_at), id: BigInt(m.id) }
    const best = current.get(m.node_uuid)
    if (!best || candidate.at > best.at || (candidate.at === best.at && candidate.id > best.id)) {
      current.set(m.node_uuid, candidate)
    }
  }

  const ordered = [...paths.values()]
    .map((p) => ({ ...p, at: Date.parse(p.created_at) }))
    .sort((a, b) => a.at - b.at || compareText(a.domain, b.domain) || compareText(a.path, b.path))
  const result = new Map<string, LoreNode>()
  for (const p of ordered) {
    const edge = edges.get(p.edge_id)
    const node = edge && nodes.get(edge.child_uuid)
    if (!edge || !node) continue
    const uri = formatUri(p.domain, p.path)
    const existing = result.get(node.uuid)
    if (existing) {
      existing.aliases.push(uri)
      continue
    }
    const body = current.get(node.uuid)
    const created = new Date(node.created_at)
    result.set(node.uuid, {
      uuid: node.uuid,
      uri,
      aliases: [],
      priority: edge.priority,
      disclosure: edge.disclosure || null,
      content: body?.content ?? null,
      createdAt: created,
      updatedAt: body ? new Date(body.at) : created,
      previousVersions: versions.get(node.uuid) ?? 0,
      keywords: [],
    })
  }
  for (const k of [...keywords].sort((a, b) => compareText(a.keyword, b.keyword))) {
    result.get(k.node_uuid)?.keywords.push(k.keyword)
  }
  return {
    snapshot: { nodes: [...result.values()], recallEvents: null },
    exportedAt: new Date(backup.data.created_at).toISOString(),
  }
}
