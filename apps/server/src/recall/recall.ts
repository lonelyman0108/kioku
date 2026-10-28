import type { Layer, RecallCandidate, RecallVia } from '@kioku/contracts'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'

import type { Access } from '../access/access'
import type { Tx } from '../db/client'
import { memories, memoryEmbeddings, memoryGlossary } from '../db/schema'
import type { Embedder } from '../embedding/provider'
import { readableConditions } from '../memory/filter'
import { formatUri } from '../memory/uri'

// 多路召回：向量相似度、中文全文检索、glossary 关键词命中。三路都先套同一套读权限过滤，
// 再按加权分数合并。权重是经验值，召回分析做出来之后再调。
// 单独一路命中就应当能过阈值：一个 glossary 关键词 0.3、全文命中两个较具体的词约 0.23、相似度 0.4 以上的向量命中。
const WEIGHTS = {
  semantic: 0.6,
  fulltext: 0.35,
  glossaryFirst: 0.3,
  glossaryMore: 0.1,
  priority: 0.06,
}
const PER_PATH_LIMIT = 24
export const DEFAULT_MIN_SCORE = 0.2
// 全文按 BM25 打分：k1 让同一个词出现多次的加分逐渐饱和，b 让长正文不因为词多而占便宜（长度按不同词的个数算）。
// 库里记忆太少时每个词都显得常见、idf 分不出高低，可读记忆不到 minDocs 条时按 minDocs 条算
const BM25 = { k1: 1.2, b: 0.75, minDocs: 20 }
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
  // 只收受信来源（不含 untrusted 写入的）
  trustedOnly?: boolean
  // 只收这些层
  layers?: Layer[]
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

// 「帮」「上」「做」这类单字几乎每条正文都有，留着只会带进不相关的记忆；查询里还有更长的词时去掉
export function searchTerms(lexemes: string[]): string[] {
  const longer = lexemes.filter((t) => [...t].length > 1)
  return longer.length ? longer : lexemes
}

// 任一词命中即可的 tsquery。词里可能有单引号（例如 o'reilly），引号与反斜杠都要转义
export function anyTermQuery(terms: string[]): string {
  return terms.map((t) => `'${t.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`).join(' | ')
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
    options.trustedOnly ? ne(memories.provenance, 'untrusted') : undefined,
    options.layers ? inArray(memories.layer, options.layers) : undefined,
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

  // 全文：查询切出的词任一命中即可（整句全部命中几乎不可能），按 BM25 打分。
  // 不用 ts_rank_cd：它随命中次数一直涨，长正文反复出现几个常见词就排到前面，压到 0–1 时又都封顶，分不出高低。
  // BM25 的 idf 让少见的词更重；词的出现次数（df）从命中的记忆里数，任何含这个词的可读记忆都会命中
  const [lexemes] = await tx.execute<{ terms: string[] }>(
    sql`select tsvector_to_array(to_tsvector('kioku_zh', ${query})) as terms`,
  )
  const terms = searchTerms(lexemes?.terms ?? [])
  if (terms.length) {
    const k1 = sql.raw(String(BM25.k1))
    const b = sql.raw(String(BM25.b))
    const minDocs = sql.raw(String(BM25.minDocs))
    const ftsRows = await tx.execute<Row & { score: string; scale: string }>(sql`
      with cand as (
        select ${memories.id} as id, ${memories.domain} as domain, ${memories.path} as path,
          ${memories.layer} as layer, ${memories.priority} as priority,
          ${memories.disclosure} as disclosure, ${memories.fts} as fts, length(${memories.fts}) as dl
        from ${memories}
        where ${readable} and ${memories.fts} @@ ${anyTermQuery(terms)}::tsquery
      ),
      tf as (
        select c.id, u.lexeme, coalesce(array_length(u.positions, 1), 1) as n
        from cand c, unnest(c.fts) u
        where u.lexeme in (select json_array_elements_text(${JSON.stringify(terms)}::json))
      ),
      idf as (
        select lexeme,
          ln(1 + (greatest((select count(*) from ${memories} where ${readable}), ${minDocs}) - count(*) + 0.5) / (count(*) + 0.5)) as w
        from tf group by lexeme
      )
      select c.id, c.domain, c.path, c.layer, c.priority, c.disclosure,
        sum(idf.w * tf.n * (${k1} + 1) / (tf.n + ${k1} * (1 - ${b} + ${b} * c.dl / (select avg(dl) from cand)))) as score,
        (select max(w) from idf) as scale
      from cand c join tf on tf.id = c.id join idf on idf.lexeme = tf.lexeme
      group by c.id, c.domain, c.path, c.layer, c.priority, c.disclosure
      order by score desc
      limit ${PER_PATH_LIMIT}`)
    for (const r of ftsRows) {
      const h = hit(r)
      // 压到 0–1：只命中查询里最具体的那个词一次约 0.5，命中的具体词越多越接近 1，不封顶。
      // 尺度是这个词的 idf，分数不随库里记忆的多少整体变高变低；至少按出现在一成记忆里的词算（ln 10），
      // 查询里全是常见词时不会把只命中常见词的记忆抬上来
      const score = Number(r.score)
      h.fulltext = score / (score + Math.max(Math.LN10, Number(r.scale)))
      h.via.add('fulltext')
    }
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
