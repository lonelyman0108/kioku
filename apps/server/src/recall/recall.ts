import {
  DEFAULT_CIRCLE_PRIVACY,
  TUNING_DEFAULTS,
  normalizeWhen,
  type CirclePrivacySettings,
  type DebugCandidate,
  type EntryKind,
  type FacetMatchMode,
  type FlippedTerm,
  type RecallCandidate,
  type RecallVia,
  type SubjectKind,
  type WhenCondition,
} from '@kioku/contracts'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'

import type { Access } from '../access/access'
import { maskForOutbound } from '../credential/privacy'
import { nowOf, type Tx } from '../db/client'
import { circles, entries, entryEmbeddings, entryGlossary, entryVariants } from '../db/schema'
import type { Embedder } from '../embedding/provider'
import {
  evaluateVariantFocus,
  loadCircleVocabularies,
  scanQueryIntentFlipping,
  type CircleVocabulary,
  type VariantEvaluation,
} from '../memory/facets'
import { readableConditions } from '../memory/filter'
import { expandOneHopNeighbors, visibleCircleSlug, type OneHopSeed } from '../memory/links'
import { weightsOf, type RecallWeights } from '../settings/advanced'
import { clipChars, inlineText, titleSuffix } from './text'

export { clipChars, inlineText, oneLine, titleSuffix } from './text'

const DEFAULT_WEIGHTS = weightsOf(TUNING_DEFAULTS)
const PER_PATH_LIMIT = 24
export const DEFAULT_MIN_SCORE = TUNING_DEFAULTS['recall.minScore']
export const DEFAULT_RELEVANCE_FLOOR = TUNING_DEFAULTS['recall.relevanceFloor']
const LINK_SEED_LIMIT = 3
const LINK_DECAY = 0.55

const BM25 = { k1: 1.2, b: 0.75, minDocs: 20 }
export const MAX_QUERY_CHARS = 2000
const HNSW_EF_SEARCH = 200
const WORD_START = '\\m'
const WORD_END = '\\M'
const REGEX_META = '([.^$*+?()\\[\\]{}|\\\\-])'
const ESCAPE_MATCH = '\\\\\\1'

export interface RecallOptions {
  limit: number
  minScore?: number
  relevanceFloor?: number
  trustedOnly?: boolean
  kinds?: EntryKind[]
  crossCircle?: boolean
  focus?: WhenCondition
  weights?: RecallWeights
  disableFlipping?: boolean
}

interface VariantHitRow {
  variantId: string
  entryId: string
  circleId: string
  circleSlug: string
  shortId: string
  title: string
  kind: EntryKind
  originScope: string
  subjectKind: SubjectKind | null
  priority: number
  disclosure: string | null
  when: WhenCondition
}

interface HitAccumulator {
  row: VariantHitRow
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

export function searchTerms(lexemes: string[]): string[] {
  const longer = lexemes.filter((t) => [...t].length > 1)
  return longer.length ? longer : lexemes
}

export function anyTermQuery(terms: string[]): string {
  return terms.map((t) => `'${t.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`).join(' | ')
}

const QUERY_EMBED_TIMEOUT_MS = 30_000
const QUERY_EMBED_CHANNEL_TIMEOUT_MS = 10_000

export async function embedQuery(
  embedder: Embedder | null,
  query: string,
  redactor:
    CirclePrivacySettings | ((text: string) => Promise<string> | string) = DEFAULT_CIRCLE_PRIVACY,
): Promise<QueryVector | null> {
  if (!embedder) return null
  try {
    const normalized = normalizeQuery(query)
    const masked =
      typeof redactor === 'function'
        ? await redactor(normalized)
        : maskForOutbound(normalized, redactor)
    const [vector] = await embedder.embed([masked], {
      signal: AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS),
      timeoutMs: QUERY_EMBED_CHANNEL_TIMEOUT_MS,
    })
    return { model: embedder.model, vector: vector! }
  } catch (err) {
    console.warn('召回时嵌入请求失败，跳过向量召回', err)
    return null
  }
}

export interface ScoredCandidate extends DebugCandidate {
  variantId: string
}

export interface RecallScoreMeta {
  candidates: ScoredCandidate[]
  resolvedFacets: WhenCondition
  flippedTerms: FlippedTerm[]
}

export const CANDIDATE_ID = Symbol('recall candidate entry id')
export const CANDIDATE_VARIANT_ID = Symbol('recall candidate variant id')
export type RecordableCandidate = RecallCandidate & {
  readonly [CANDIDATE_ID]: string
  readonly [CANDIDATE_VARIANT_ID]: string
}

export function publicCandidate(c: ScoredCandidate): RecordableCandidate {
  return {
    entryId: c.entryId,
    shortId: c.shortId,
    title: c.title,
    circleId: c.circleId,
    circleSlug: c.circleSlug,
    kind: c.kind,
    matchedWhen: c.matchedWhen,
    otherVariantsCount: c.otherVariantsCount,
    ...(c.crossGroup ? { crossGroup: true } : {}),
    priority: c.priority,
    disclosure: c.disclosure,
    score: c.score,
    via: c.via,
    cues: c.cues,
    [CANDIDATE_ID]: c.entryId,
    [CANDIDATE_VARIANT_ID]: c.variantId,
  }
}

function isCrossGroupFact(
  access: Access,
  row: { kind: EntryKind; subjectKind: SubjectKind | null; originScope: string },
): boolean {
  return (
    row.kind === 'fact' &&
    row.subjectKind === 'person' &&
    row.originScope.startsWith('group:') &&
    access.baseOriginScopes !== null &&
    !access.baseOriginScopes.has(row.originScope) &&
    access.crossGroupPersonScopes.has(row.originScope)
  )
}

export async function recall(
  tx: Tx,
  access: Access,
  semantic: QueryVector | null,
  rawQuery: string,
  options: RecallOptions,
): Promise<RecordableCandidate[]> {
  return (await scoreRecall(tx, access, semantic, rawQuery, options)).map(publicCandidate)
}

export async function scoreRecall(
  tx: Tx,
  access: Access,
  semantic: QueryVector | null,
  rawQuery: string,
  options: RecallOptions,
): Promise<ScoredCandidate[]> {
  return (await scoreRecallWithMeta(tx, access, semantic, rawQuery, options)).candidates
}

export async function scoreRecallWithMeta(
  tx: Tx,
  access: Access,
  semantic: QueryVector | null,
  rawQuery: string,
  options: RecallOptions,
): Promise<RecallScoreMeta> {
  const query = normalizeQuery(rawQuery)
  const baseFocus = normalizeWhen(options.focus ?? {})
  if (!query) {
    return { candidates: [], resolvedFacets: baseFocus, flippedTerms: [] }
  }

  const now = nowOf(tx)
  const visibleCircleIds =
    options.crossCircle === false ? [access.primaryCircleId] : [...access.circles.keys()]
  const vocabularies = await loadCircleVocabularies(tx, visibleCircleIds)

  const flip =
    options.focus !== undefined && !options.disableFlipping
      ? scanQueryIntentFlipping(query, baseFocus, access, vocabularies)
      : {
          queryFocus: baseFocus,
          flippedTerms: [],
          flippedCircleIds: new Set<string>(),
          flippedRealms: new Set<string>(),
        }

  const kinds = options.kinds?.length ? options.kinds : (['entry', 'fact'] as EntryKind[])
  const readable = and(
    readableConditions(access, { now }),
    inArray(entries.kind, kinds),
    options.trustedOnly ? ne(entries.provenance, 'untrusted') : undefined,
    options.crossCircle === false ? eq(entries.circleId, access.primaryCircleId) : undefined,
  )!

  const fields = {
    variantId: entryVariants.id,
    entryId: entries.id,
    circleId: entries.circleId,
    circleSlug: circles.slug,
    shortId: entries.shortId,
    title: entries.title,
    kind: entries.kind,
    originScope: entries.originScope,
    subjectKind: entries.subjectKind,
    priority: entries.priority,
    disclosure: entries.disclosure,
    when: entryVariants.when,
  }

  const hits = new Map<string, HitAccumulator>()
  const hit = (row: VariantHitRow) => {
    let acc = hits.get(row.variantId)
    if (!acc) {
      acc = {
        row: { ...row, when: normalizeWhen(row.when) },
        semantic: 0,
        fulltext: 0,
        cues: new Set(),
        via: new Set(),
      }
      hits.set(row.variantId, acc)
    }
    return acc
  }

  if (semantic) {
    await tx.execute(sql.raw(`set local hnsw.ef_search = ${HNSW_EF_SEARCH}`))
    await tx.execute(sql.raw(`set local hnsw.iterative_scan = relaxed_order`))
    const literal = `[${semantic.vector.join(',')}]`
    const rows = await tx
      .select({
        ...fields,
        similarity: sql<number>`1 - (${entryEmbeddings.embedding} <=> ${literal}::vector)`,
      })
      .from(entryEmbeddings)
      .innerJoin(entryVariants, eq(entryVariants.id, entryEmbeddings.variantId))
      .innerJoin(entries, eq(entries.id, entryVariants.entryId))
      .innerJoin(circles, eq(circles.id, entries.circleId))
      .where(and(readable, eq(entryEmbeddings.model, semantic.model)))
      .orderBy(sql`${entryEmbeddings.embedding} <=> ${literal}::vector`)
      .limit(PER_PATH_LIMIT * 2)
    for (const r of rows) {
      const acc = hit(r)
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
      variant_id: string
      entry_id: string
      circle_id: string
      circle_slug: string
      short_id: string
      title: string
      kind: EntryKind
      origin_scope: string
      subject_kind: SubjectKind | null
      priority: number
      disclosure: string | null
      variant_when: WhenCondition
      score: string
      scale: string
    }>(sql`
      with cand as (
        select ${entryVariants.id} as variant_id, ${entries.id} as entry_id,
          ${entries.circleId} as circle_id, ${circles.slug} as circle_slug,
          ${entries.shortId} as short_id, ${entries.title} as title,
          ${entries.kind} as kind, ${entries.originScope} as origin_scope,
          ${entries.subjectKind} as subject_kind, ${entries.priority} as priority,
          ${entries.disclosure} as disclosure, ${entryVariants.when} as variant_when,
          ${entryVariants.fts} as fts, length(${entryVariants.fts}) as dl
        from ${entryVariants}
        join ${entries} on ${entries.id} = ${entryVariants.entryId}
        join ${circles} on ${circles.id} = ${entries.circleId}
        where ${readable} and ${entryVariants.fts} @@ ${anyTermQuery(terms)}::tsquery
      ),
      tf as (
        select c.variant_id, u.lexeme, coalesce(array_length(u.positions, 1), 1) as n
        from cand c, unnest(c.fts) u
        where u.lexeme in (select json_array_elements_text(${JSON.stringify(terms)}::json))
      ),
      idf as (
        select lexeme,
          ln(1 + (greatest((select count(*) from ${entryVariants} join ${entries} on ${entries.id} = ${entryVariants.entryId} where ${readable}), ${BM25.minDocs}::int) - count(*) + 0.5) / (count(*) + 0.5)) as w
        from tf group by lexeme
      )
      select c.variant_id, c.entry_id, c.circle_id, c.circle_slug, c.short_id, c.title,
        c.kind, c.origin_scope, c.subject_kind, c.priority, c.disclosure, c.variant_when,
        sum(idf.w * tf.n * (${k1} + 1) / (tf.n + ${k1} * (1 - ${b} + ${b} * c.dl / greatest(nullif((select avg(dl) from cand), 0), 1)))) as score,
        (select max(w) from idf) as scale
      from cand c join tf on tf.variant_id = c.variant_id join idf on idf.lexeme = tf.lexeme
      group by c.variant_id, c.entry_id, c.circle_id, c.circle_slug, c.short_id, c.title,
        c.kind, c.origin_scope, c.subject_kind, c.priority, c.disclosure, c.variant_when
      order by score desc, c.priority, c.entry_id, c.variant_id
      limit ${PER_PATH_LIMIT * 2}`)
    for (const r of ftsRows) {
      const acc = hit({
        variantId: r.variant_id,
        entryId: r.entry_id,
        circleId: r.circle_id,
        circleSlug: r.circle_slug,
        shortId: r.short_id,
        title: r.title,
        kind: r.kind,
        originScope: r.origin_scope,
        subjectKind: r.subject_kind,
        priority: r.priority,
        disclosure: r.disclosure,
        when: r.variant_when,
      })
      const score = Number(r.score)
      acc.fulltext = score / (score + 0.7 * Math.max(Math.LN10, Number(r.scale)))
      acc.via.add('fulltext')
    }
  }

  const keyword = entryGlossary.keyword
  const glossaryMatch = sql`case when ${keyword} ~ '^[[:ascii:]]+$'
    then lower(${query}) ~ (${WORD_START} || regexp_replace(lower(${keyword}), ${REGEX_META}, ${ESCAPE_MATCH}, 'g') || ${WORD_END})
    else position(lower(${keyword}) in lower(${query})) > 0 end`
  const glossaryRows = await tx
    .select({ ...fields, keyword })
    .from(entryGlossary)
    .innerJoin(entries, eq(entries.id, entryGlossary.entryId))
    .innerJoin(entryVariants, eq(entryVariants.entryId, entries.id))
    .innerJoin(circles, eq(circles.id, entries.circleId))
    .where(and(readable, glossaryMatch))
    .orderBy(desc(sql`length(${keyword})`), keyword, asc(entryVariants.sortOrder))
    .limit(PER_PATH_LIMIT * 4)
  for (const r of glossaryRows) {
    const acc = hit(r)
    acc.cues.add(r.keyword)
    acc.via.add('glossary')
  }

  const hitEntryIds = [...new Set([...hits.values()].map((h) => h.row.entryId))]
  const variantCountMap = new Map<string, number>()
  if (hitEntryIds.length) {
    const countRows = await tx
      .select({ entryId: entryVariants.entryId, n: sql<number>`count(*)::int` })
      .from(entryVariants)
      .where(inArray(entryVariants.entryId, hitEntryIds))
      .groupBy(entryVariants.entryId)
    for (const r of countRows) variantCountMap.set(r.entryId, Number(r.n))
  }

  const minScore = options.minScore ?? DEFAULT_MIN_SCORE
  const relevanceFloor = options.relevanceFloor ?? DEFAULT_RELEVANCE_FLOOR
  const weights = options.weights ?? DEFAULT_WEIGHTS
  const emptyDims = new Map<string, FacetMatchMode>()

  const bestByEntry = new Map<string, { cand: ScoredCandidate; hasConflict: boolean }>()
  for (const h of hits.values()) {
    const semanticPart = weights.semantic * h.semantic
    const fulltextPart = weights.fulltext * h.fulltext
    const glossaryPart = h.cues.size
      ? weights.glossaryFirst + (h.cues.size > 1 ? weights.glossaryMore : 0)
      : 0
    const sBase = semanticPart + fulltextPart + glossaryPart
    const priorityPart = (weights.priority * Math.max(0, 3 - h.row.priority)) / 3
    const crossGroup = isCrossGroupFact(access, h.row)

    let facetPart = 0
    let hasConflict = false
    if (options.focus !== undefined) {
      const vocab = vocabularies.get(h.row.circleId)
      const ev = evaluateVariantFocus({
        when: h.row.when,
        circleDefaults: vocab?.defaultFacets ?? {},
        focus: flip.queryFocus,
        customDimensions: vocab?.dimensions ?? emptyDims,
        awayCircle: h.row.circleId !== access.primaryCircleId,
        flippedCircle: flip.flippedCircleIds.has(h.row.circleId),
        flippedRealms: flip.flippedRealms,
        crossGroup,
      })
      hasConflict = ev.hasConflict
      facetPart = sBase >= relevanceFloor ? ev.delta : crossGroup ? -0.06 : 0
    } else if (crossGroup) {
      facetPart = -0.06
    }

    const rawScore = sBase + priorityPart + facetPart
    const totalVariants = variantCountMap.get(h.row.entryId) ?? 1
    const candidate: ScoredCandidate = {
      entryId: h.row.entryId,
      variantId: h.row.variantId,
      shortId: h.row.shortId,
      title: h.row.title,
      circleId: h.row.circleId,
      circleSlug: visibleCircleSlug(access, h.row.circleId, h.row.circleSlug),
      kind: h.row.kind,
      matchedWhen: h.row.when,
      otherVariantsCount: Math.max(0, totalVariants - 1),
      ...(crossGroup ? { crossGroup: true } : {}),
      priority: h.row.priority,
      disclosure: h.row.disclosure,
      score: round(rawScore),
      via: [...h.via],
      cues: [...h.cues].sort(),
      breakdown: {
        semantic: round(semanticPart),
        fulltext: round(fulltextPart),
        glossary: round(glossaryPart),
        priority: round(priorityPart),
        facet: round(facetPart),
        link: 0,
      },
      rawScore,
    }

    const prev = bestByEntry.get(h.row.entryId)
    if (
      !prev ||
      rawScore > prev.cand.rawScore ||
      (rawScore === prev.cand.rawScore && prev.hasConflict && !hasConflict)
    ) {
      bestByEntry.set(h.row.entryId, { cand: candidate, hasConflict })
    }
  }

  const finalMap = new Map<string, ScoredCandidate>()
  for (const { cand } of bestByEntry.values()) {
    if (cand.rawScore >= minScore) finalMap.set(cand.entryId, cand)
  }

  const seedsSorted = [...finalMap.values()]
    .sort(
      (a, b) =>
        b.rawScore - a.rawScore || a.priority - b.priority || a.shortId.localeCompare(b.shortId),
    )
    .slice(0, LINK_SEED_LIMIT)

  if (seedsSorted.length > 0 && options.limit > 0) {
    const seedIds = seedsSorted.map((s) => s.entryId)
    const seedVariantRows = await tx
      .select({
        id: entryVariants.id,
        entryId: entryVariants.entryId,
        circleId: entryVariants.circleId,
        when: entryVariants.when,
      })
      .from(entryVariants)
      .where(inArray(entryVariants.entryId, seedIds))

    const activeByEntry = new Map<string, string[]>()
    for (const v of seedVariantRows) {
      const vocab = vocabularies.get(v.circleId)
      if (options.focus !== undefined) {
        const ev = evaluateVariantFocus({
          when: normalizeWhen(v.when),
          circleDefaults: vocab?.defaultFacets ?? {},
          focus: flip.queryFocus,
          customDimensions: vocab?.dimensions ?? emptyDims,
          awayCircle: false,
          flippedCircle: false,
          flippedRealms: new Set(),
          crossGroup: false,
        })
        if (ev.hasConflict) continue
      }
      const list = activeByEntry.get(v.entryId) ?? []
      list.push(v.id)
      activeByEntry.set(v.entryId, list)
    }

    const combinedCustomDims = new Map<string, FacetMatchMode>()
    for (const vocab of vocabularies.values()) {
      for (const [k, mode] of vocab.dimensions) combinedCustomDims.set(k, mode)
    }

    const oneHopSeeds: OneHopSeed[] = seedsSorted.map((s) => ({
      entryId: s.entryId,
      shortId: s.shortId,
      activeVariantIds: activeByEntry.get(s.entryId) ?? [s.variantId],
      score: s.rawScore,
    }))

    const neighbors = await expandOneHopNeighbors(tx, access, oneHopSeeds, {
      decay: LINK_DECAY,
      now,
      ...(options.focus !== undefined
        ? {
            variantAllowed: (when, defaults) =>
              !evaluateVariantFocus({
                when: normalizeWhen(when),
                circleDefaults: normalizeWhen(defaults),
                focus: flip.queryFocus,
                customDimensions: combinedCustomDims,
                awayCircle: false,
                flippedCircle: false,
                flippedRealms: new Set(),
                crossGroup: false,
              }).hasConflict,
          }
        : {}),
    })

    const eligibleNeighbors = neighbors.filter(
      (n) =>
        (options.crossCircle !== false || n.circleId === access.primaryCircleId) &&
        kinds.includes(n.kind) &&
        n.score >= minScore,
    )

    if (eligibleNeighbors.length) {
      const nEntryIds = eligibleNeighbors.map((n) => n.entryId)
      const missingCircleIds = eligibleNeighbors
        .map((n) => n.circleId)
        .filter((id) => !vocabularies.has(id))
      const [nVariantRows, nMetaRows, extraVocabs] = await Promise.all([
        tx
          .select({
            id: entryVariants.id,
            entryId: entryVariants.entryId,
            when: entryVariants.when,
            sortOrder: entryVariants.sortOrder,
          })
          .from(entryVariants)
          .where(inArray(entryVariants.entryId, nEntryIds))
          .orderBy(asc(entryVariants.sortOrder), asc(entryVariants.id)),
        tx
          .select({
            id: entries.id,
            subjectKind: entries.subjectKind,
          })
          .from(entries)
          .where(inArray(entries.id, nEntryIds)),
        missingCircleIds.length
          ? loadCircleVocabularies(tx, missingCircleIds)
          : Promise.resolve(new Map<string, CircleVocabulary>()),
      ])

      for (const [k, v] of extraVocabs) vocabularies.set(k, v)
      const subjectKindByEntry = new Map(nMetaRows.map((m) => [m.id, m.subjectKind]))
      const variantsByNeighbor = new Map<string, (typeof nVariantRows)[number][]>()
      for (const v of nVariantRows) {
        const list = variantsByNeighbor.get(v.entryId) ?? []
        list.push(v)
        variantsByNeighbor.set(v.entryId, list)
      }

      const hasActiveFocus = Object.keys(flip.queryFocus).length > 0

      for (const n of eligibleNeighbors) {
        const nVariants = variantsByNeighbor.get(n.entryId) ?? []
        if (!nVariants.length) continue

        const vocab = vocabularies.get(n.circleId)
        const subjectKind = subjectKindByEntry.get(n.entryId) ?? null
        const crossGroup = isCrossGroupFact(access, {
          kind: n.kind,
          subjectKind,
          originScope: n.originScope,
        })

        let chosen: {
          variant: (typeof nVariantRows)[number]
          eval: VariantEvaluation
        } | null = null

        for (const v of nVariants) {
          const ev = evaluateVariantFocus({
            when: normalizeWhen(v.when),
            circleDefaults: vocab?.defaultFacets ?? {},
            focus: flip.queryFocus,
            customDimensions: vocab?.dimensions ?? emptyDims,
            awayCircle: n.circleId !== access.primaryCircleId,
            flippedCircle: flip.flippedCircleIds.has(n.circleId),
            flippedRealms: flip.flippedRealms,
            crossGroup,
          })
          if (options.focus !== undefined && ev.hasConflict) continue
          const resonates =
            options.focus === undefined ||
            !hasActiveFocus ||
            ev.kHit >= 1 ||
            (Object.keys(ev.effectiveWhen).length === 0 && n.priority <= 2)
          if (!resonates) continue

          if (
            !chosen ||
            ev.kHit > chosen.eval.kHit ||
            (ev.kHit === chosen.eval.kHit && v.sortOrder < chosen.variant.sortOrder)
          ) {
            chosen = { variant: v, eval: ev }
          }
        }

        if (!chosen) continue

        const cue = `关联自 [[${n.seedShortId}]]`
        const existing = finalMap.get(n.entryId)
        if (existing) {
          if (!existing.via.includes('link')) existing.via.push('link')
          existing.breakdown.link = round(n.score)
          if (n.score > existing.rawScore) {
            existing.rawScore = n.score
            existing.score = round(n.score)
          }
          if (!existing.cues.includes(cue)) existing.cues.push(cue)
          continue
        }

        const primaryBefore = bestByEntry.get(n.entryId)?.cand
        const rawScore = n.score
        const matchedWhen = normalizeWhen(chosen.variant.when)
        const entry: ScoredCandidate = {
          entryId: n.entryId,
          variantId: chosen.variant.id,
          shortId: n.shortId,
          title: n.title,
          circleId: n.circleId,
          circleSlug: n.circleSlug,
          kind: n.kind,
          matchedWhen,
          otherVariantsCount: Math.max(0, nVariants.length - 1),
          ...(crossGroup ? { crossGroup: true } : {}),
          priority: n.priority,
          disclosure: n.disclosure,
          score: round(rawScore),
          via: primaryBefore ? [...new Set([...primaryBefore.via, 'link' as const])] : ['link'],
          cues: primaryBefore ? [...new Set([...primaryBefore.cues, cue])] : [cue],
          breakdown: {
            semantic: primaryBefore?.breakdown.semantic ?? 0,
            fulltext: primaryBefore?.breakdown.fulltext ?? 0,
            glossary: primaryBefore?.breakdown.glossary ?? 0,
            priority: primaryBefore?.breakdown.priority ?? 0,
            facet: primaryBefore?.breakdown.facet ?? 0,
            link: round(n.score),
          },
          rawScore,
        }
        finalMap.set(n.entryId, entry)
      }
    }
  }

  const finalCandidates = [...finalMap.values()]
    .sort(
      (a, b) =>
        b.rawScore - a.rawScore || a.priority - b.priority || a.shortId.localeCompare(b.shortId),
    )
    .slice(0, options.limit)

  return {
    candidates: finalCandidates,
    resolvedFacets: flip.queryFocus,
    flippedTerms: flip.flippedTerms,
  }
}

const round = (n: number) => Math.round(n * 100) / 100

const INLINE_CONTENT_CHARS = TUNING_DEFAULTS['recall.chatInlineChars']

function contentHead(content: string, chars: number): string {
  const head = clipChars(content, chars * 4)
  const text = clipChars(inlineText(head), chars, '…')
  if (!text) return ''
  return head !== content && !text.endsWith('…') ? `${text}…` : text
}

export function formatRecallBlock(
  candidates: RecallCandidate[],
  sessionId?: string,
  contents?: ReadonlyMap<string, string>,
  inlineChars = INLINE_CONTENT_CHARS,
  primaryCircleId?: string,
): string {
  if (!candidates.length) return ''
  const safeSession = sessionId?.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128)
  const open = safeSession ? `<recall session_id="${safeSession}">` : '<recall>'
  const lines = candidates.map((c) => {
    const content = contents?.get(c.entryId) ?? contents?.get(c.shortId)
    const cues =
      (content && contentHead(content, inlineChars)) ||
      inlineText(c.cues.length ? c.cues.join(' · ') : (c.disclosure ?? ''))
    const circleTag =
      c.circleSlug && (!primaryCircleId || c.circleId !== primaryCircleId)
        ? ` [${c.circleSlug}]`
        : ''
    const crossTag = c.crossGroup ? ' [其他群印象]' : ''
    return `${c.score.toFixed(2)} | ${c.shortId}${titleSuffix(c.shortId, c.title)}${circleTag}${crossTag}${cues ? ` | ${cues}` : ''}`
  })
  return [open, ...lines, '</recall>'].join('\n')
}
