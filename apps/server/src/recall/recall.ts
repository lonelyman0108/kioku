import type { Layer, RecallCandidate, RecallVia } from '@kioku/contracts'
import { and, desc, eq, sql } from 'drizzle-orm'

import type { Access } from '../access/access'
import type { Tx } from '../db/client'
import { memories, memoryEmbeddings, memoryGlossary } from '../db/schema'
import type { Embedder } from '../embedding/provider'
import { readableConditions } from '../memory/filter'
import { formatUri } from '../memory/uri'

// 多路召回：向量相似度、中文全文检索、glossary 关键词命中。三路都先套同一套读权限过滤，
// 再按加权分数合并。权重是经验值，召回分析做出来之后再调。
// 单独一路命中就应当能过阈值：一个 glossary 关键词 0.3、较好的全文命中约 0.25、相似度 0.4 以上的向量命中。
const WEIGHTS = {
  semantic: 0.6,
  fulltext: 0.35,
  glossaryFirst: 0.3,
  glossaryMore: 0.1,
  priority: 0.06,
}
const PER_PATH_LIMIT = 24
export const DEFAULT_MIN_SCORE = 0.2
// 召回只需要提示语的主要内容；过长的输入会超出嵌入模型的 token 上限，也让全文分词变慢
export const MAX_QUERY_CHARS = 2000
// HNSW 先取近邻、再套权限与空间过滤；开启迭代扫描并放大候选数，过滤后仍能取够结果
const HNSW_EF_SEARCH = 200
// 关键词转成单词边界正则用的片段；作为绑定参数传给 PostgreSQL，避免在 SQL 模板里写反斜杠转义
const WORD_START = '\\m'
const WORD_END = '\\M'
const REGEX_META = '([.^$*+?()\\[\\]{}|\\\\-])'
const ESCAPE_MATCH = '\\\\\\1'

export interface RecallOptions {
  limit: number
  minScore?: number
  // personaIds 用于 persona 层过滤；召回永远不返回 secret
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

export function normalizeQuery(query: string): string {
  return query.trim().slice(0, MAX_QUERY_CHARS)
}

// 查询向量在数据库事务之外算好，避免事务等待外部接口时一直占着连接。
// 嵌入服务不可用时返回 null，召回退化为全文与关键词，不让整个召回失败
export async function embedQuery(
  embedder: Embedder | null,
  query: string,
): Promise<QueryVector | null> {
  if (!embedder) return null
  try {
    const [vector] = await embedder.embed([normalizeQuery(query)])
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
  rawQuery: string,
  options: RecallOptions,
): Promise<RecallCandidate[]> {
  const query = normalizeQuery(rawQuery)
  if (!query) return []
  // 召回只面向有 URI 的策展记忆；抽取记忆另有展示方式，不能在各路里占掉名额
  const readable = and(
    readableConditions(access, { personaIds: options.personaIds }),
    eq(memories.form, 'curated'),
  )
  // 各路都直接取出展示要用的字段，合并时不必再查一次库
  const fields = {
    id: memories.id,
    domain: memories.domain,
    path: memories.path,
    layer: memories.layer,
    priority: memories.priority,
    disclosure: memories.disclosure,
  }
  type Row = {
    id: string
    domain: string | null
    path: string | null
    layer: Layer
    priority: number
    disclosure: string | null
  }
  const hits = new Map<string, Hit & { row: Row }>()
  const hit = (row: Row) => {
    let h = hits.get(row.id)
    if (!h)
      hits.set(row.id, (h = { row, semantic: 0, fulltext: 0, cues: new Set(), via: new Set() }))
    return h
  }

  if (semantic) {
    await tx.execute(sql.raw(`set local hnsw.ef_search = ${HNSW_EF_SEARCH}`))
    await tx.execute(sql.raw(`set local hnsw.iterative_scan = relaxed_order`))
    const literal = `[${semantic.vector.join(',')}]`
    const rows = await tx
      .select({
        ...fields,
        similarity: sql<number>`1 - (${memoryEmbeddings.embedding} <=> ${literal}::vector)`,
      })
      .from(memoryEmbeddings)
      .innerJoin(memories, eq(memories.id, memoryEmbeddings.memoryId))
      .where(and(readable, eq(memoryEmbeddings.model, semantic.model)))
      .orderBy(sql`${memoryEmbeddings.embedding} <=> ${literal}::vector`)
      .limit(PER_PATH_LIMIT)
    for (const r of rows) {
      const h = hit(r)
      h.semantic = Math.max(0, Number(r.similarity))
      h.via.add('semantic')
    }
  }

  // plainto_tsquery 用 & 连接各词、用 <-> 连接复合词的各部分，长句几乎不可能全部命中。
  // 把这些运算符都换成 |，任一词命中即可；结果文本直接转成 tsquery，不再交给分词器切第二遍
  const tsquery = sql`regexp_replace(plainto_tsquery('kioku_zh', ${query})::text, ' (&|<[0-9]+>|<->) ', ' | ', 'g')::tsquery`
  // 归一化参数 32 把 rank 映射到 0–1（rank / (rank + 1)），分数在不同查询之间可比
  const rank = sql<number>`ts_rank_cd(${memories.fts}, ${tsquery}, 32)`
  const ftsRows = await tx
    .select({ ...fields, rank })
    .from(memories)
    .where(and(readable, sql`${memories.fts} @@ ${tsquery}`))
    .orderBy(desc(rank))
    .limit(PER_PATH_LIMIT)
  for (const r of ftsRows) {
    const h = hit(r)
    h.fulltext = Math.min(1, Number(r.rank) * 4)
    h.via.add('fulltext')
  }

  // 关键词按子串匹配，中文没有词边界只能这样；纯 ASCII 的关键词要求按单词边界匹配，
  // 否则 AI 会命中 said、go 会命中 good。长的关键词优先，命中多时保留更具体的
  const keyword = memoryGlossary.keyword
  const glossaryMatch = sql`case when ${keyword} ~ '^[[:ascii:]]+$'
    then lower(${query}) ~ (${WORD_START} || regexp_replace(lower(${keyword}), ${REGEX_META}, ${ESCAPE_MATCH}, 'g') || ${WORD_END})
    else position(lower(${keyword}) in lower(${query})) > 0 end`
  const glossaryRows = await tx
    .select({ ...fields, keyword })
    .from(memoryGlossary)
    .innerJoin(memories, eq(memories.id, memoryGlossary.memoryId))
    .where(and(readable, glossaryMatch))
    .orderBy(desc(sql`length(${keyword})`), keyword)
    .limit(PER_PATH_LIMIT * 4)
  for (const r of glossaryRows) {
    const h = hit(r)
    h.cues.add(r.keyword)
    h.via.add('glossary')
  }

  const minScore = options.minScore ?? DEFAULT_MIN_SCORE
  return (
    [...hits.values()]
      .map((h) => {
        const glossary = h.cues.size
          ? WEIGHTS.glossaryFirst + (h.cues.size > 1 ? WEIGHTS.glossaryMore : 0)
          : 0
        const score =
          WEIGHTS.semantic * h.semantic +
          WEIGHTS.fulltext * h.fulltext +
          glossary +
          (WEIGHTS.priority * Math.max(0, 3 - h.row.priority)) / 3
        return { h, score }
      })
      // 用未取整的分数和阈值比较，取整只用于展示
      .filter(({ score }) => score >= minScore)
      .sort((a, b) => b.score - a.score || a.h.row.priority - b.h.row.priority)
      .slice(0, options.limit)
      .map(({ h, score }) => ({
        uri: formatUri(h.row.domain!, h.row.path!),
        layer: h.row.layer,
        priority: h.row.priority,
        disclosure: h.row.disclosure,
        score: Math.round(score * 100) / 100,
        via: [...h.via],
        cues: [...h.cues].sort(),
      }))
  )
}

// 召回块会原样进入宿主的上下文。disclosure 与关键词可能来自不可信的写入者，
// 压成单行并去掉尖括号，避免伪造 </recall> 闭合标签后注入任意文本
export function inlineText(text: string): string {
  return text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
}

// 与 Lore 的 <recall> 块格式一致：每行「分数 | URI | 线索」
export function formatRecallBlock(candidates: RecallCandidate[], sessionId?: string): string {
  if (!candidates.length) return ''
  const safeSession = sessionId?.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128)
  const open = safeSession ? `<recall session_id="${safeSession}">` : '<recall>'
  const lines = candidates.map((c) => {
    const cues = inlineText(c.cues.length ? c.cues.join(' · ') : (c.disclosure ?? ''))
    return `${c.score.toFixed(2)} | ${c.uri}${cues ? ` | ${cues}` : ''}`
  })
  return [open, ...lines, '</recall>'].join('\n')
}
