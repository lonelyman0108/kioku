import type { EntryKind, RecallCandidate, RecallVia } from '@kioku/contracts'
import { and, eq, sql } from 'drizzle-orm'

import { hasOverlap, readableEntrySql, type AccessScope, type SceneFocus } from '../access/scope'
import type { MasterKey } from '../crypto/keyring'
import { withTx, type Db } from '../db/client'
import { entries, entryEmbeddings } from '../db/schema'
import { expandOneHopNeighbors } from '../memory/links'
import { embedTexts } from '../models/client'
import { EMBEDDING_SETTING_KEY, loadResolvedModel } from '../models/store'
import { clipChars, inlineText, titleSuffix } from './text'

export { clipChars, inlineText, oneLine, titleSuffix } from './text'

export const MAX_QUERY_CHARS = 2000
export const DEFAULT_RECALL_LIMIT = 8
export const DEFAULT_MIN_SCORE = 0.22
export const RELEVANCE_FLOOR = 0.15

const PER_PATH_LIMIT = 32
const LINK_SEED_LIMIT = 3
const LINK_DECAY = 0.55
const HNSW_EF_SEARCH = 200
const BM25 = { k1: 1.2, b: 0.75, minDocs: 20 }
const WEIGHT_SEMANTIC = 0.65
const WEIGHT_FULLTEXT = 0.35
const PINNED_MICRO_BOOST = 0.04

export interface RecallOptions {
  focus: SceneFocus
  limit?: number
  minScore?: number
  useSemantic?: boolean
  semanticTimeoutMs?: number
  includeLinks?: boolean
}

export interface QueryVector {
  model: string
  vector: number[]
}

export function normalizeQuery(query: string): string {
  return query.trim().slice(0, MAX_QUERY_CHARS)
}

export function searchTerms(lexemes: readonly string[]): string[] {
  const longer = lexemes.filter((t) => [...t].length > 1)
  return longer.length ? longer : [...lexemes]
}

export function anyTermQuery(terms: readonly string[]): string {
  return terms.map((t) => `'${t.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`).join(' | ')
}

export async function embedQuery(
  db: Db,
  masterKey: MasterKey | null,
  query: string,
  timeoutMs = 10_000,
): Promise<QueryVector | null> {
  const conn = await loadResolvedModel(db, masterKey, EMBEDDING_SETTING_KEY).catch(() => null)
  if (!conn) return null
  try {
    const [vector] = await embedTexts(conn, [normalizeQuery(query)], { timeoutMs })
    return vector ? { model: conn.model, vector } : null
  } catch (err) {
    console.warn('召回时嵌入请求失败，自动回退全文检索', err instanceof Error ? err.message : err)
    return null
  }
}

// 场景亲和加分与温和冲突惩罚：匹配加分上限 +0.25；独占维度互斥各 -0.12（上限 -0.20），项目互斥 -0.06
export function computeSceneDelta(
  entry: {
    envs: readonly string[]
    realms: readonly string[]
    projects: readonly string[]
    runtimes: readonly string[]
  },
  focus: SceneFocus,
): { delta: number; matchedCues: string[] } {
  let boost = 0
  let exclusivePenalty = 0
  let projectPenalty = 0
  const matchedCues: string[] = []

  if (entry.projects.length && focus.projects.length) {
    if (hasOverlap(entry.projects, focus.projects)) {
      boost += 0.16
      matchedCues.push(`项目:${focus.projects[0]}`)
    } else {
      projectPenalty = -0.06
    }
  }

  const exclusiveDims: {
    label: string
    entryVals: readonly string[]
    focusVals: readonly string[]
  }[] = [
    { label: '环境', entryVals: entry.envs, focusVals: focus.envs },
    { label: '场域', entryVals: entry.realms, focusVals: focus.realms },
    { label: '客户端', entryVals: entry.runtimes, focusVals: focus.runtimes },
  ]
  for (const dim of exclusiveDims) {
    if (!dim.entryVals.length || !dim.focusVals.length) continue
    if (hasOverlap(dim.entryVals, dim.focusVals)) {
      boost += 0.1
      matchedCues.push(`${dim.label}:${dim.focusVals[0]}`)
    } else {
      exclusivePenalty -= 0.12
    }
  }

  const cappedBoost = Math.min(0.25, boost)
  const cappedExclusivePenalty = Math.max(-0.2, exclusivePenalty)
  return {
    delta: cappedBoost + cappedExclusivePenalty + projectPenalty,
    matchedCues,
  }
}

interface EntryHitRow {
  entryId: string
  shortId: string
  title: string
  summary: string | null
  kind: EntryKind
  isPinned: boolean
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
  disclosure: string | null
  updatedAt: string
  lastChangeSummary: string | null
}

interface HitAccumulator {
  row: EntryHitRow
  semantic: number
  fulltext: number
  via: Set<RecallVia>
}

export async function recallEntries(
  db: Db,
  masterKey: MasterKey | null,
  scope: AccessScope,
  rawQuery: string,
  options: RecallOptions,
): Promise<RecallCandidate[]> {
  const query = normalizeQuery(rawQuery)
  if (!query) return []

  const semantic =
    options.useSemantic === false
      ? null
      : await embedQuery(db, masterKey, query, options.semanticTimeoutMs ?? 10_000)

  const limit = options.limit ?? DEFAULT_RECALL_LIMIT
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE

  return withTx(db, async (tx, now) => {
    const readable = and(readableEntrySql(scope, { now }), eq(entries.kind, 'entry'))!
    const hits = new Map<string, HitAccumulator>()
    const upsert = (row: EntryHitRow): HitAccumulator => {
      let acc = hits.get(row.entryId)
      if (!acc) {
        acc = { row, semantic: 0, fulltext: 0, via: new Set() }
        hits.set(row.entryId, acc)
      }
      return acc
    }

    let vectorHitCount = 0
    if (semantic) {
      await tx.execute(sql.raw(`set local hnsw.ef_search = ${HNSW_EF_SEARCH}`))
      await tx.execute(sql.raw('set local hnsw.iterative_scan = relaxed_order'))
      const literal = `[${semantic.vector.join(',')}]`
      const vecRows = await tx
        .select({
          entryId: entries.id,
          shortId: entries.shortId,
          title: entries.title,
          summary: entries.summary,
          kind: entries.kind,
          isPinned: entries.isPinned,
          envs: entries.envs,
          realms: entries.realms,
          projects: entries.projects,
          runtimes: entries.runtimes,
          disclosure: entries.disclosure,
          updatedAt: entries.updatedAt,
          lastChangeSummary: entries.lastChangeSummary,
          similarity: sql<number>`1 - (${entryEmbeddings.embedding} <=> ${literal}::vector)`,
        })
        .from(entryEmbeddings)
        .innerJoin(entries, eq(entries.id, entryEmbeddings.entryId))
        .where(and(readable, eq(entryEmbeddings.model, semantic.model)))
        .orderBy(sql`${entryEmbeddings.embedding} <=> ${literal}::vector`)
        .limit(PER_PATH_LIMIT)

      vectorHitCount = vecRows.length
      for (const r of vecRows) {
        const acc = upsert({
          entryId: r.entryId,
          shortId: r.shortId,
          title: r.title,
          summary: r.summary,
          kind: r.kind,
          isPinned: r.isPinned,
          envs: r.envs,
          realms: r.realms,
          projects: r.projects,
          runtimes: r.runtimes,
          disclosure: r.disclosure,
          updatedAt: r.updatedAt.toISOString(),
          lastChangeSummary: r.lastChangeSummary,
        })
        acc.semantic = Math.max(0, Number(r.similarity))
        acc.via.add('semantic')
      }
    }

    const [lexemes] = await tx.execute<{ terms: string[] }>(
      sql`select tsvector_to_array(to_tsvector('kioku_zh', ${query})) as terms`,
    )
    const terms = searchTerms(lexemes?.terms ?? [])
    if (terms.length) {
      const k1 = sql`${BM25.k1}::float8`
      const b = sql`${BM25.b}::float8`
      const ftsRows = await tx.execute<{
        entry_id: string
        short_id: string
        title: string
        summary: string | null
        kind: EntryKind
        is_pinned: boolean
        envs: string[]
        realms: string[]
        projects: string[]
        runtimes: string[]
        disclosure: string | null
        updated_at: Date | string
        last_change_summary: string | null
        score: string
        scale: string
      }>(sql`
        with cand as (
          select ${entries.id} as entry_id, ${entries.shortId} as short_id,
            ${entries.title} as title, ${entries.summary} as summary, ${entries.kind} as kind,
            ${entries.isPinned} as is_pinned, ${entries.envs} as envs,
            ${entries.realms} as realms, ${entries.projects} as projects,
            ${entries.runtimes} as runtimes, ${entries.disclosure} as disclosure,
            ${entries.updatedAt} as updated_at, ${entries.lastChangeSummary} as last_change_summary,
            ${entries.fts} as fts, length(${entries.fts}) as dl
          from ${entries}
          where ${readable} and ${entries.fts} @@ ${anyTermQuery(terms)}::tsquery
        ),
        tf as (
          select c.entry_id, u.lexeme,
            coalesce(
              (
                select sum(
                  case w
                    when 'A' then 3.0
                    when 'B' then 2.0
                    when 'C' then 1.0
                    else 0.5
                  end
                )
                from unnest(u.weights) as w
              ),
              coalesce(array_length(u.positions, 1), 1)::float8
            ) as n
          from cand c, unnest(c.fts) u
          where u.lexeme in (select json_array_elements_text(${JSON.stringify(terms)}::json))
        ),
        idf as (
          select lexeme,
            ln(1 + (greatest((select count(*) from ${entries} where ${readable}), ${BM25.minDocs}::int) - count(*) + 0.5) / (count(*) + 0.5)) as w
          from tf group by lexeme
        )
        select c.entry_id, c.short_id, c.title, c.summary, c.kind, c.is_pinned,
          c.envs, c.realms, c.projects, c.runtimes, c.disclosure, c.updated_at, c.last_change_summary,
          sum(idf.w * tf.n * (${k1} + 1) / (tf.n + ${k1} * (1 - ${b} + ${b} * c.dl / greatest(nullif((select avg(dl) from cand), 0), 1)))) as score,
          (select max(w) from idf) as scale
        from cand c join tf on tf.entry_id = c.entry_id join idf on idf.lexeme = tf.lexeme
        group by c.entry_id, c.short_id, c.title, c.summary, c.kind, c.is_pinned,
          c.envs, c.realms, c.projects, c.runtimes, c.disclosure, c.updated_at, c.last_change_summary
        order by score desc, c.is_pinned desc, c.short_id asc
        limit ${PER_PATH_LIMIT}`)

      for (const r of ftsRows) {
        const updatedIso =
          r.updated_at instanceof Date
            ? r.updated_at.toISOString()
            : new Date(r.updated_at).toISOString()
        const acc = upsert({
          entryId: r.entry_id,
          shortId: r.short_id,
          title: r.title,
          summary: r.summary,
          kind: r.kind,
          isPinned: r.is_pinned,
          envs: r.envs ?? [],
          realms: r.realms ?? [],
          projects: r.projects ?? [],
          runtimes: r.runtimes ?? [],
          disclosure: r.disclosure,
          updatedAt: updatedIso,
          lastChangeSummary: r.last_change_summary,
        })
        const raw = Number(r.score)
        acc.fulltext = raw / (raw + 0.7 * Math.max(Math.LN10, Number(r.scale)))
        acc.via.add('fulltext')
      }
    }

    const useAdaptiveHybrid = vectorHitCount > 0
    const scored = new Map<string, RecallCandidate>()

    for (const h of hits.values()) {
      const sBase = useAdaptiveHybrid
        ? WEIGHT_SEMANTIC * h.semantic + WEIGHT_FULLTEXT * h.fulltext
        : h.fulltext
      const pinBoost = h.row.isPinned ? PINNED_MICRO_BOOST : 0
      const scene = computeSceneDelta(h.row, options.focus)
      const scenePart = sBase >= RELEVANCE_FLOOR ? scene.delta : 0
      const score = Number(Math.max(0, sBase + pinBoost + scenePart).toFixed(4))

      const cues: string[] = [...scene.matchedCues]
      if (h.row.summary) {
        cues.push(clipChars(inlineText(h.row.summary), 100))
      } else if (h.row.disclosure) {
        cues.push(clipChars(inlineText(h.row.disclosure), 120))
      }

      scored.set(h.row.entryId, {
        entryId: h.row.entryId,
        shortId: h.row.shortId,
        title: h.row.title,
        summary: h.row.summary,
        kind: h.row.kind,
        isPinned: h.row.isPinned,
        envs: h.row.envs,
        realms: h.row.realms,
        projects: h.row.projects,
        runtimes: h.row.runtimes,
        disclosure: h.row.disclosure,
        updatedAt: h.row.updatedAt,
        lastChangeSummary: h.row.lastChangeSummary,
        score,
        via: [...h.via],
        cues,
      })
    }

    const baseSorted = [...scored.values()].sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.isPinned) - Number(a.isPinned) ||
        a.shortId.localeCompare(b.shortId),
    )

    // 一跳双向双链扩散：取过阈值的最高 K 条种子扩展邻居
    if (options.includeLinks !== false) {
      const seeds = baseSorted
        .filter((c) => c.score >= minScore)
        .slice(0, LINK_SEED_LIMIT)
        .map((c) => ({ entryId: c.entryId, shortId: c.shortId, score: c.score }))

      if (seeds.length) {
        const neighbors = await expandOneHopNeighbors(tx, scope, options.focus, seeds, LINK_DECAY)
        for (const n of neighbors) {
          const linkScore = Number(n.score.toFixed(4))
          const existing = scored.get(n.entryId)
          if (existing) {
            if (!existing.via.includes('link')) existing.via.push('link')
            if (!existing.linkRelation && n.linkRelation) existing.linkRelation = n.linkRelation
            if (linkScore > existing.score) existing.score = linkScore
          } else {
            const relSuffix = n.linkRelation ? `（${inlineText(n.linkRelation)}）` : ''
            const cues = [`关联自 [[${n.viaSeedShortId}]]${relSuffix}`]
            if (n.summary) {
              cues.push(clipChars(inlineText(n.summary), 100))
            } else if (n.disclosure) {
              cues.push(clipChars(inlineText(n.disclosure), 120))
            }
            scored.set(n.entryId, {
              entryId: n.entryId,
              shortId: n.shortId,
              title: n.title,
              summary: n.summary,
              kind: n.kind,
              isPinned: n.isPinned,
              envs: n.envs,
              realms: n.realms,
              projects: n.projects,
              runtimes: n.runtimes,
              disclosure: n.disclosure,
              updatedAt: n.updatedAt,
              lastChangeSummary: n.lastChangeSummary,
              linkRelation: n.linkRelation,
              score: linkScore,
              via: ['link'],
              cues,
            })
          }
        }
      }
    }

    return [...scored.values()]
      .filter((c) => c.score >= minScore)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.isPinned) - Number(a.isPinned) ||
          a.shortId.localeCompare(b.shortId),
      )
      .slice(0, limit)
  })
}

export function formatRecallBlock(
  candidates: readonly RecallCandidate[],
  sessionId?: string,
): string {
  if (!candidates.length) return ''
  const lines = candidates.map((c) => {
    const score = c.score.toFixed(2)
    const label = `${c.shortId}${titleSuffix(c.shortId, c.title)}`
    const tags = [...c.projects, ...c.envs, ...c.realms, ...c.runtimes]
    const scopeHint = tags.length ? ` [${tags.join(', ')}]` : ''
    const updated = c.updatedAt ? ` · 更新 ${c.updatedAt.slice(0, 10)}` : ''
    const cue = c.cues.length ? ` — ${clipChars(c.cues.join('；'), 160)}` : ''
    return `- (${score}) ${label}${scopeHint}${updated}${cue}`
  })
  const attr = sessionId ? ` session_id="${inlineText(sessionId).replace(/"/g, '')}"` : ''
  return `<recall${attr}>\n${lines.join('\n')}\n</recall>`
}
