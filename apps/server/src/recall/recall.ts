import type { RecallCandidate, RecallVia } from '@kioku/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'

import type { Access } from '../access/access'
import type { Tx } from '../db/client'
import { memories, memoryEmbeddings, memoryGlossary } from '../db/schema'
import type { Embedder } from '../embedding/provider'
import { readableConditions } from '../memory/filter'
import { formatUri } from '../memory/uri'

// 多路召回：向量相似度、中文全文检索、glossary 关键词命中。三路都先套同一套读权限过滤，
// 再按加权分数合并。权重是经验值，召回分析做出来之后再调。
const WEIGHTS = { semantic: 0.6, fulltext: 0.25, glossary: 0.3, priority: 0.06 }
const PER_PATH_LIMIT = 24
export const DEFAULT_MIN_SCORE = 0.25

export interface RecallOptions {
  limit: number
  minScore?: number
  // 召回只返回非 secret；personaIds 用于 persona 层过滤
  personaIds: string[]
}

interface Hit {
  semantic: number
  fulltext: number
  cues: Set<string>
  via: Set<RecallVia>
}

export interface QueryVector {
  model: string
  vector: number[]
}

// 查询向量在数据库事务之外算好，避免事务等待外部接口时一直占着连接。
// 嵌入服务不可用时返回 null，召回退化为全文与关键词，不让整个召回失败
export async function embedQuery(
  embedder: Embedder | null,
  query: string,
): Promise<QueryVector | null> {
  if (!embedder) return null
  try {
    const [vector] = await embedder.embed([query])
    return { model: embedder.model, vector: vector! }
  } catch (err) {
    console.warn('召回时嵌入请求失败，跳过向量召回', err)
    return null
  }
}

export async function recall(
  tx: Tx,
  access: Access,
  semantic: QueryVector | null,
  query: string,
  options: RecallOptions,
): Promise<RecallCandidate[]> {
  const readable = readableConditions(access, { personaIds: options.personaIds })
  const hits = new Map<string, Hit>()
  const hit = (id: string) => {
    let h = hits.get(id)
    if (!h) hits.set(id, (h = { semantic: 0, fulltext: 0, cues: new Set(), via: new Set() }))
    return h
  }

  if (semantic) {
    const literal = `[${semantic.vector.join(',')}]`
    const rows = await tx
      .select({
        id: memories.id,
        similarity: sql<number>`1 - (${memoryEmbeddings.embedding} <=> ${literal}::vector)`,
      })
      .from(memoryEmbeddings)
      .innerJoin(memories, eq(memories.id, memoryEmbeddings.memoryId))
      .where(and(readable, eq(memoryEmbeddings.model, semantic.model)))
      .orderBy(sql`${memoryEmbeddings.embedding} <=> ${literal}::vector`)
      .limit(PER_PATH_LIMIT)
    for (const r of rows) {
      const h = hit(r.id)
      h.semantic = Math.max(0, Number(r.similarity))
      h.via.add('semantic')
    }
  }

  // plainto_tsquery 把词用 & 连接，长句几乎不可能全部命中，改成 | 让任一词命中即可
  const tsquery = sql`to_tsquery('kioku_zh', replace(plainto_tsquery('kioku_zh', ${query})::text, '&', '|'))`
  const ftsRows = await tx
    .select({ id: memories.id, rank: sql<number>`ts_rank_cd(${memories.fts}, ${tsquery})` })
    .from(memories)
    .where(and(readable, sql`${memories.fts} @@ ${tsquery}`))
    .orderBy(sql`ts_rank_cd(${memories.fts}, ${tsquery}) desc`)
    .limit(PER_PATH_LIMIT)
  const maxRank = Math.max(0, ...ftsRows.map((r) => Number(r.rank)))
  for (const r of ftsRows) {
    const h = hit(r.id)
    h.fulltext = maxRank > 0 ? Number(r.rank) / maxRank : 0
    h.via.add('fulltext')
  }

  const glossaryRows = await tx
    .select({ id: memoryGlossary.memoryId, keyword: memoryGlossary.keyword })
    .from(memoryGlossary)
    .innerJoin(memories, eq(memories.id, memoryGlossary.memoryId))
    .where(and(readable, sql`position(lower(${memoryGlossary.keyword}) in lower(${query})) > 0`))
    .limit(PER_PATH_LIMIT * 4)
  for (const r of glossaryRows) {
    const h = hit(r.id)
    h.cues.add(r.keyword)
    h.via.add('glossary')
  }

  if (!hits.size) return []
  const rows = await tx
    .select({
      id: memories.id,
      domain: memories.domain,
      path: memories.path,
      layer: memories.layer,
      priority: memories.priority,
      disclosure: memories.disclosure,
    })
    .from(memories)
    .where(and(readable, inArray(memories.id, [...hits.keys()])))

  const minScore = options.minScore ?? DEFAULT_MIN_SCORE
  return rows
    .filter((r) => r.domain && r.path)
    .map((r) => {
      const h = hits.get(r.id)!
      const score =
        WEIGHTS.semantic * h.semantic +
        WEIGHTS.fulltext * h.fulltext +
        WEIGHTS.glossary * Math.min(1, h.cues.size / 2) +
        (WEIGHTS.priority * Math.max(0, 3 - r.priority)) / 3
      return {
        uri: formatUri(r.domain!, r.path!),
        layer: r.layer,
        priority: r.priority,
        disclosure: r.disclosure,
        score: Math.round(score * 100) / 100,
        via: [...h.via],
        cues: [...h.cues].sort(),
      }
    })
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score || a.priority - b.priority || a.uri.localeCompare(b.uri))
    .slice(0, options.limit)
}

// 与 Lore 的 <recall> 块格式一致：每行「分数 | URI | 线索」
export function formatRecallBlock(candidates: RecallCandidate[], sessionId?: string): string {
  if (!candidates.length) return ''
  const open = sessionId ? `<recall session_id="${sessionId.replace(/"/g, '')}">` : '<recall>'
  const lines = candidates.map((c) => {
    const cues = c.cues.length ? c.cues.join(' · ') : (c.disclosure ?? '')
    return `${c.score.toFixed(2)} | ${c.uri}${cues ? ` | ${cues}` : ''}`
  })
  return [open, ...lines, '</recall>'].join('\n')
}
