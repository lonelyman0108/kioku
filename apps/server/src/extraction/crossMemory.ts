import { createHash } from 'node:crypto'

import {
  normalizeShortId,
  normalizeSlugList,
  parseEpisodeSignals,
  PINNED_FULL_SOFT_WARN_CHARS,
  type DreamFailedItem,
  type DreamOutcome,
  type DreamProgress,
  type DreamScope,
  type DreamSuggestionKind,
  type SingleCrossCheckResponse,
} from '@kioku/contracts'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { hasOverlap, momentSql, stillValidSql, textArraySql } from '../access/scope'
import type { MasterKey } from '../crypto/keyring'
import { databaseNow, withTx, type Db } from '../db/client'
import {
  dreamSuggestions,
  EMBEDDING_DIMENSIONS,
  entries,
  entryEmbeddings,
  entryLinks,
} from '../db/schema'
import { MemoryError } from '../memory/errors'
import { chatComplete, ModelClientError, type ModelConnection } from '../models/client'
import { CHAT_LLM_SETTING_KEY, loadResolvedModel } from '../models/store'
import { anyTermQuery, clipChars, searchTerms } from '../recall/recall'
import { CaptureAbortedError } from './capture'
import {
  BatchResilienceGuard,
  computeDynamicOutputTokens,
  hydrateDreamSuggestions,
  insertDreamProposal,
  suggestionFingerprint,
  toPromptItem,
  type DreamExecutionResult,
} from './dream'
import {
  buildBootAuditMessages,
  buildClusterAuditMessages,
  buildEpisodeReconcileMessages,
  buildHabitDistillMessages,
  buildLinkAuditMessages,
  buildOutlineSummary,
  buildSemanticRepairMessages,
  canFlowRealmInto,
  evaluateDreamResponse,
  sameRealms,
  type BrokenLinkHint,
  type DreamPromptItem,
  type HabitDistillProvenance,
  type ParsedDreamProposal,
} from './dreamPrompt'

type EntryRow = typeof entries.$inferSelect

const CLUSTER_COSINE_THRESHOLD = 0.84
const LINK_COSINE_MIN = 0.7
const CLUSTER_MAX_SIZE = 4
const CLUSTER_ITEM_CHAR_LIMIT = 8_000
const CLUSTER_TOTAL_CHAR_BUDGET = 24_000
const LINK_SEED_CONTENT_LIMIT = 1_200
const LINK_CANDIDATES_MAX = 8
const EPISODE_TARGETS_MAX = 3
const EPISODE_FACT_VECTOR_MIN_COSINE = 0.62
const EPISODE_FACT_VECTOR_LIMIT = 6
const HABIT_COSINE_THRESHOLD = 0.78
const HABIT_CLUSTER_MAX_SIZE = 6
const HABIT_CANDIDATES_MAX = 120
const HABIT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
const HABIT_SESSION_GAP_MS = 2 * 60 * 60 * 1000
const HABIT_MIN_DISTINCT_SESSIONS = 2
const HABIT_TARGETS_MAX = 3
const HABIT_TARGET_MIN_COSINE = 0.55
const BOOT_AUDIT_BATCH_SIZE = 6
const DEFAULT_MAX_CROSS_CALLS = 12
const SINGLE_CROSS_MAX_CALLS = 4
const CROSS_TIMEOUT_MS = 180_000
const CROSS_HTTP_RETRIES = 2
const CROSS_DYNAMIC_OUTPUT_TOKENS_MIN = 6_000
const CROSS_DYNAMIC_OUTPUT_TOKENS_MAX = 16_384
const CROSS_LINKS_MAX_TOKENS = 2_500
const CROSS_BOOT_TRIM_MAX_TOKENS = 3_000

export function computeCrossMemoryTaskMaxTokens(
  kind: 'cluster' | 'habit' | 'episode' | 'links' | 'boot_trim',
  targetChars = 0,
): number {
  if (kind === 'links') return CROSS_LINKS_MAX_TOKENS
  if (kind === 'boot_trim') return CROSS_BOOT_TRIM_MAX_TOKENS
  return computeDynamicOutputTokens(targetChars, {
    min: CROSS_DYNAMIC_OUTPUT_TOKENS_MIN,
    max: CROSS_DYNAMIC_OUTPUT_TOKENS_MAX,
    overhead: 2_000,
  })
}

export function selectTopTwoClusterRows<T extends { id: string }>(
  rows: readonly T[],
  edges: readonly { a: string; b: string; score: number }[],
): T[] {
  if (rows.length <= 2) return [...rows]
  const indexById = new Map(rows.map((r, idx) => [r.id, idx]))
  let bestPair: [number, number] | null = null
  let bestScore = -Infinity
  for (const edge of edges) {
    const idxA = indexById.get(edge.a)
    const idxB = indexById.get(edge.b)
    if (idxA === undefined || idxB === undefined || idxA === idxB) continue
    if (edge.score > bestScore) {
      bestScore = edge.score
      bestPair = idxA < idxB ? [idxA, idxB] : [idxB, idxA]
    }
  }
  if (bestPair) {
    return [rows[bestPair[0]]!, rows[bestPair[1]]!]
  }
  return rows.slice(0, 2)
}

// 3–4 条簇审阅命中输出长度截断时，降级选取簇内相似度最高的两条重试一次
export async function runClusterTaskWithTopTwoFallback<T extends { id: string }, R>(
  rows: readonly T[],
  edges: readonly { a: string; b: string; score: number }[],
  execute: (clusterRows: readonly T[]) => Promise<R>,
  options: {
    signal?: AbortSignal | undefined
    guard?: Pick<BatchResilienceGuard, 'isAborted' | 'waitIfCooling'> | undefined
    onFallback?: ((topTwo: readonly T[], err: ModelClientError) => void) | undefined
  } = {},
): Promise<R> {
  try {
    return await execute(rows)
  } catch (err) {
    if (
      rows.length > 2 &&
      err instanceof ModelClientError &&
      err.category === 'length_limit' &&
      !options.signal?.aborted &&
      !options.guard?.isAborted
    ) {
      if (options.guard) {
        await options.guard.waitIfCooling(options.signal)
        if (options.signal?.aborted || options.guard.isAborted) throw err
      }
      const topTwo = selectTopTwoClusterRows(rows, edges)
      options.onFallback?.(topTwo, err)
      return execute(topTwo)
    }
    throw err
  }
}

type VectorPairRow = {
  entry_a: string
  entry_b: string
  sim: number
}

type RankedFtsRow = {
  id: string
  rank: number
}

function shareAny(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0
  const set = new Set(b)
  let count = 0
  for (const v of a) {
    if (set.has(v)) count++
  }
  return count
}

interface ExistingSuggestionsIndex {
  fingerprints: Set<string>
  updateRecords: { entryId: string; version: number; fingerprint: string }[]
  distillRecords: {
    entryIds: string[]
    entryVersions: number[]
    entryIdSet: Set<string>
    fingerprint: string
  }[]
}

async function loadExistingSuggestions(db: Db): Promise<ExistingSuggestionsIndex> {
  const rows = await db
    .select({
      fingerprint: dreamSuggestions.fingerprint,
      kind: dreamSuggestions.kind,
      entryIds: dreamSuggestions.entryIds,
      entryVersions: dreamSuggestions.entryVersions,
    })
    .from(dreamSuggestions)
  const fingerprints = new Set<string>()
  const updateRecords: ExistingSuggestionsIndex['updateRecords'] = []
  const distillRecords: ExistingSuggestionsIndex['distillRecords'] = []
  for (const r of rows) {
    fingerprints.add(r.fingerprint)
    if (r.kind === 'update' && r.entryIds.length === 1 && r.entryVersions.length === 1) {
      updateRecords.push({
        entryId: r.entryIds[0]!,
        version: r.entryVersions[0]!,
        fingerprint: r.fingerprint,
      })
    } else if (
      r.kind === 'distill_episode' &&
      r.entryIds.length > 0 &&
      r.entryIds.length === r.entryVersions.length
    ) {
      distillRecords.push({
        entryIds: r.entryIds,
        entryVersions: r.entryVersions,
        entryIdSet: new Set(r.entryIds),
        fingerprint: r.fingerprint,
      })
    }
  }
  return { fingerprints, updateRecords, distillRecords }
}

// 估算一组会话摘要覆盖的独立会话次数：不同设备或项目直接记为独立会话，同设备同项目需相邻两次落桶间隔 ≥ 2 小时（避免单次长会话多次落桶误判，也避免跨 UTC 零点误拆）
export function countDistinctHabitSessions(
  rows: readonly Pick<EntryRow, 'deviceKey' | 'projectSlug' | 'createdAt'>[],
): number {
  if (!rows.length) return 0
  const byBucket = new Map<string, number[]>()
  for (const row of rows) {
    const key = `${row.deviceKey?.trim().toLowerCase() ?? ''}\0${row.projectSlug?.trim().toLowerCase() ?? ''}`
    let list = byBucket.get(key)
    if (!list) {
      list = []
      byBucket.set(key, list)
    }
    list.push(row.createdAt.getTime())
  }
  let total = 0
  for (const timestamps of byBucket.values()) {
    timestamps.sort((a, b) => a - b)
    let prev = timestamps[0]!
    total++
    for (let i = 1; i < timestamps.length; i++) {
      const ts = timestamps[i]!
      if (ts - prev >= HABIT_SESSION_GAP_MS) {
        total++
      }
      prev = ts
    }
  }
  return total
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const va = a[i]!
    const vb = b[i]!
    if (!Number.isFinite(va) || !Number.isFinite(vb)) return 0
    dot += va * vb
    normA += va * va
    normB += vb * vb
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return Number.isFinite(denom) && denom > 0 ? dot / denom : 0
}

export function computeNormalizedCentroid(
  vectors: readonly (readonly number[])[],
): number[] | null {
  if (!vectors.length) return null
  const dim = vectors[0]!.length
  if (!dim) return null
  const sum = new Array<number>(dim).fill(0)
  let count = 0
  for (const vec of vectors) {
    if (vec.length !== dim || !vec.every((v) => Number.isFinite(v))) continue
    for (let i = 0; i < dim; i++) sum[i]! += vec[i]!
    count++
  }
  if (!count) return null
  let norm = 0
  for (let i = 0; i < dim; i++) norm += sum[i]! * sum[i]!
  const scale = Math.sqrt(norm)
  if (!Number.isFinite(scale) || scale <= 0) return null
  const out = sum.map((v) => v / scale)
  return out.every((v) => Number.isFinite(v)) ? out : null
}

export function habitClusterDiscriminator(
  rows: readonly Pick<EntryRow, 'id' | 'version'>[],
): string {
  const key = rows
    .map((r) => `${r.id}:${r.version}`)
    .sort()
    .join(',')
  return `habit:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

// 对同场域且带偏好信号的会话摘要边做受限团聚簇（簇内成对相似且同场域），并强制要求至少跨 HABIT_MIN_DISTINCT_SESSIONS 次独立会话
export function buildHabitClusters<
  T extends Pick<EntryRow, 'id' | 'realms' | 'deviceKey' | 'projectSlug' | 'createdAt'>,
>(episodes: readonly T[], edges: readonly { a: string; b: string; score: number }[]): T[][] {
  const byId = new Map(episodes.map((ep) => [ep.id, ep]))
  const sorted = [...edges].sort((x, y) => y.score - x.score)
  const assigned = new Set<string>()
  const adj = new Map<string, { id: string; score: number }[]>()
  const edgeKeys = new Set<string>()
  const pairKey = (x: string, y: string) => (x < y ? `${x}\0${y}` : `${y}\0${x}`)

  for (const e of sorted) {
    if (e.score < HABIT_COSINE_THRESHOLD) continue
    const ra = byId.get(e.a)
    const rb = byId.get(e.b)
    if (!ra || !rb || ra.id === rb.id) continue
    if (!sameRealms(ra.realms, rb.realms)) continue
    edgeKeys.add(pairKey(e.a, e.b))
    if (!adj.has(e.a)) adj.set(e.a, [])
    if (!adj.has(e.b)) adj.set(e.b, [])
    adj.get(e.a)!.push({ id: e.b, score: e.score })
    adj.get(e.b)!.push({ id: e.a, score: e.score })
  }

  const tryBuildFrom = (startId: string): T[] | null => {
    if (assigned.has(startId)) return null
    const startRow = byId.get(startId)
    if (!startRow) return null
    const members: T[] = [startRow]
    const memberSet = new Set<string>([startId])
    const queue = [...(adj.get(startId) ?? [])].sort((x, y) => y.score - x.score)
    for (const next of queue) {
      if (members.length >= HABIT_CLUSTER_MAX_SIZE) break
      if (assigned.has(next.id) || memberSet.has(next.id)) continue
      const row = byId.get(next.id)
      if (!row || !sameRealms(startRow.realms, row.realms)) continue
      if (!members.every((m) => edgeKeys.has(pairKey(m.id, row.id)))) continue
      members.push(row)
      memberSet.add(next.id)
    }
    return members.length >= 2 && countDistinctHabitSessions(members) >= HABIT_MIN_DISTINCT_SESSIONS
      ? members
      : null
  }

  const clusters: { rows: T[]; peak: number }[] = []
  for (const e of sorted) {
    if (e.score < HABIT_COSINE_THRESHOLD) continue
    if (assigned.has(e.a) && assigned.has(e.b)) continue
    const members = tryBuildFrom(e.a) ?? tryBuildFrom(e.b)
    if (members) {
      for (const m of members) assigned.add(m.id)
      clusters.push({ rows: members, peak: e.score })
    }
  }
  return clusters.sort((a, b) => b.peak - a.peak).map((c) => c.rows)
}

async function loadOutboundLinksMap(
  db: Db,
  entryIds: readonly string[],
): Promise<{
  outboundByEntryId: Map<string, Set<string>>
  brokenByEntryId: Map<string, BrokenLinkHint[]>
}> {
  const outboundByEntryId = new Map<string, Set<string>>()
  const brokenByEntryId = new Map<string, BrokenLinkHint[]>()
  if (!entryIds.length) return { outboundByEntryId, brokenByEntryId }

  const links = await db
    .select({
      sourceEntryId: entryLinks.sourceEntryId,
      targetShortId: entryLinks.targetShortId,
    })
    .from(entryLinks)
    .where(inArray(entryLinks.sourceEntryId, [...entryIds]))

  if (!links.length) return { outboundByEntryId, brokenByEntryId }

  const targetShorts = [...new Set(links.map((l) => l.targetShortId))]
  const targets = await db
    .select({ shortId: entries.shortId, title: entries.title, deletedAt: entries.deletedAt })
    .from(entries)
    .where(inArray(entries.shortId, targetShorts))
  const targetMap = new Map(targets.map((t) => [t.shortId, t]))

  for (const link of links) {
    let set = outboundByEntryId.get(link.sourceEntryId)
    if (!set) {
      set = new Set()
      outboundByEntryId.set(link.sourceEntryId, set)
    }
    set.add(link.targetShortId)

    const target = targetMap.get(link.targetShortId)
    if (!target || target.deletedAt !== null) {
      const list = brokenByEntryId.get(link.sourceEntryId) ?? []
      list.push({
        targetShortId: link.targetShortId,
        status: target ? 'deleted' : 'missing',
        targetTitle: target ? target.title : null,
      })
      brokenByEntryId.set(link.sourceEntryId, list)
    }
  }

  return { outboundByEntryId, brokenByEntryId }
}

// 复用已有 1024 维 pgvector 嵌入，在 SQL 侧直接算余弦相似度（零 LLM 成本）
async function findVectorPairsForSeeds(
  db: Db,
  seedIds: readonly string[],
  minCosine: number,
  limit = 200,
): Promise<VectorPairRow[]> {
  if (!seedIds.length) return []
  const seedArray = sql`array[${sql.join(
    seedIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`
  const rows = await db.execute<VectorPairRow>(sql`
    select
      a.entry_id::text as entry_a,
      b.entry_id::text as entry_b,
      (1 - (a.embedding <=> b.embedding))::float8 as sim
    from entry_embeddings a
    join entry_embeddings b
      on a.model = b.model
     and a.entry_id <> b.entry_id
    join entries ea
      on ea.id = a.entry_id
     and ea.deleted_at is null
     and ea.kind = 'entry'
     and (ea.valid_to is null or ea.valid_to > statement_timestamp())
    join entries eb
      on eb.id = b.entry_id
     and eb.deleted_at is null
     and eb.kind = 'entry'
     and (eb.valid_to is null or eb.valid_to > statement_timestamp())
    where a.entry_id = any(${seedArray})
      and (1 - (a.embedding <=> b.embedding)) >= ${minCosine}
    order by sim desc
    limit ${limit}
  `)
  return [...rows]
}

// 查带信号向量的 episode 与场域兼容的活跃正式词条（kind = 'entry'）的余弦近邻，供事实反向对账使用
async function findEpisodeFormalVectorNeighbors(
  db: Db,
  episodeIds: readonly string[],
  now: Date,
  minCosine = EPISODE_FACT_VECTOR_MIN_COSINE,
  limitPerEpisode = EPISODE_FACT_VECTOR_LIMIT,
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>()
  if (!episodeIds.length) return out
  const epArray = sql`array[${sql.join(
    episodeIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`
  const maxDist = 1 - minCosine
  const nowRef = momentSql(now)
  const rows = await db.execute<{ episode_id: string; formal_id: string; sim: number }>(sql`
    with ranked as (
      select
        a.entry_id::text as episode_id,
        b.entry_id::text as formal_id,
        (1 - (a.embedding <=> b.embedding))::float8 as sim,
        row_number() over (
          partition by a.entry_id, a.model
          order by (a.embedding <=> b.embedding) asc
        ) as rn
      from entry_embeddings a
      join entries ea
        on ea.id = a.entry_id
       and ea.deleted_at is null
      join entry_embeddings b
        on a.model = b.model
       and a.entry_id <> b.entry_id
      join entries eb
        on eb.id = b.entry_id
       and eb.deleted_at is null
       and eb.kind = 'entry'
       and (eb.valid_to is null or eb.valid_to > ${nowRef})
       and (
         cardinality(ea.realms) = 0
         or (cardinality(eb.realms) > 0 and eb.realms <@ ea.realms)
       )
      where a.entry_id = any(${epArray})
        and (a.embedding <=> b.embedding) <= ${maxDist}
    )
    select episode_id, formal_id, sim
    from ranked
    where rn <= ${limitPerEpisode}
    order by episode_id, sim desc
  `)
  for (const r of rows) {
    if (!Number.isFinite(r.sim)) continue
    let map = out.get(r.episode_id)
    if (!map) {
      map = new Map()
      out.set(r.episode_id, map)
    }
    const prev = map.get(r.formal_id) ?? 0
    if (r.sim > prev) map.set(r.formal_id, r.sim)
  }
  return out
}

// 用习惯聚簇中心向量检索场域兼容的活跃正式词条（SQL 前置场域流向过滤 + HNSW iterative_scan，防止窄场域目标被全局词条饿死）
async function findFormalTargetsByCentroid(
  db: Db,
  model: string,
  centroid: readonly number[],
  donorRealms: readonly string[],
  now: Date,
  minCosine = HABIT_TARGET_MIN_COSINE,
  limit = 12,
): Promise<{ entryId: string; sim: number }[]> {
  if (centroid.length !== EMBEDDING_DIMENSIONS || !centroid.every((v) => Number.isFinite(v))) {
    return []
  }
  const literal = `[${centroid.join(',')}]`
  const maxDist = 1 - minCosine
  const nowRef = momentSql(now)
  const normalizedRealms = normalizeSlugList(donorRealms)
  const realmCond = normalizedRealms.length
    ? sql`and cardinality(e.realms) > 0 and e.realms <@ ${textArraySql(normalizedRealms)}`
    : sql``

  return withTx(db, async (tx) => {
    await tx.execute(sql.raw('set local hnsw.ef_search = 200'))
    await tx.execute(sql.raw('set local hnsw.iterative_scan = relaxed_order'))
    const rows = await tx.execute<{ entry_id: string; sim: number }>(sql`
      select
        e.id::text as entry_id,
        (1 - (ee.embedding <=> ${literal}::vector))::float8 as sim
      from entry_embeddings ee
      join entries e
        on e.id = ee.entry_id
       and e.deleted_at is null
       and e.kind = 'entry'
       and (e.valid_to is null or e.valid_to > ${nowRef})
      where ee.model = ${model}
        and (ee.embedding <=> ${literal}::vector) <= ${maxDist}
        ${realmCond}
      order by ee.embedding <=> ${literal}::vector asc
      limit ${limit}
    `)
    return [...rows]
      .filter((r) => Number.isFinite(r.sim))
      .map((r) => ({ entryId: r.entry_id, sim: r.sim }))
  })
}

// 按全文检索相关性（ts_rank_cd）为单个种子找 Top-N 邻居，用于未嵌入词条兜底与 episode 反向对账
async function findRankedFtsCandidates(
  db: Db,
  seed: EntryRow,
  excludeIds: ReadonlySet<string>,
  limit = 8,
): Promise<string[]> {
  const factSignalText =
    seed.kind === 'episode' ? parseEpisodeSignals(seed.disclosure).facts.join(' ') : ''
  // 仅按标题、概要与事实信号做全文匹配，不把 projects/topics 塞进 OR 查询（项目亲和在确认相关度后单独加权）
  const queryText = `${seed.title} ${seed.summary ?? ''} ${factSignalText}`.trim().slice(0, 600)
  if (!queryText) return []
  const [lex] = await db.execute<{ terms: string[] }>(
    sql`select tsvector_to_array(to_tsvector('kioku_zh', ${queryText})) as terms`,
  )
  const terms = searchTerms(lex?.terms ?? []).slice(0, 20)
  if (!terms.length) return []
  const tsQuery = anyTermQuery(terms)
  const rows = await db.execute<RankedFtsRow>(sql`
    select id::text as id, ts_rank_cd(fts, ${tsQuery}::tsquery)::float8 as rank
    from entries
    where deleted_at is null
      and kind = 'entry'
      and (valid_to is null or valid_to > statement_timestamp())
      and fts @@ ${tsQuery}::tsquery
    order by rank desc, updated_at desc
    limit ${limit + excludeIds.size}
  `)
  const out: string[] = []
  for (const r of rows) {
    if (excludeIds.has(r.id)) continue
    out.push(r.id)
    if (out.length >= limit) break
  }
  return out
}

function hasDisjointNonEmpty(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && b.length > 0 && !hasOverlap(a, b)
}

// 查重合并安全守卫：必须同场域，且不得跨互斥环境、互斥项目或互斥客户端合并（防止合并为污染并集）
function canClusterEntries(a: EntryRow, b: EntryRow): boolean {
  if (!sameRealms(a.realms, b.realms)) return false
  if (hasDisjointNonEmpty(a.envs, b.envs)) return false
  if (hasDisjointNonEmpty(a.projects, b.projects)) return false
  if (hasDisjointNonEmpty(a.runtimes, b.runtimes)) return false
  return true
}

// 对高相似且场景兼容的词条边做受限并查集聚类，严格控制每簇 2–4 条避免上下文爆炸
function buildDuplicateClusters(
  edges: readonly { a: string; b: string; score: number }[],
  byId: ReadonlyMap<string, EntryRow>,
): EntryRow[][] {
  const sorted = [...edges].sort((x, y) => y.score - x.score)
  const assigned = new Set<string>()
  const adj = new Map<string, { id: string; score: number }[]>()
  for (const e of sorted) {
    const ra = byId.get(e.a)
    const rb = byId.get(e.b)
    if (!ra || !rb) continue
    if (!canClusterEntries(ra, rb)) continue
    if (!adj.has(e.a)) adj.set(e.a, [])
    if (!adj.has(e.b)) adj.set(e.b, [])
    adj.get(e.a)!.push({ id: e.b, score: e.score })
    adj.get(e.b)!.push({ id: e.a, score: e.score })
  }

  const clusters: { rows: EntryRow[]; peak: number }[] = []
  for (const e of sorted) {
    if (assigned.has(e.a) && assigned.has(e.b)) continue
    const startId = !assigned.has(e.a) ? e.a : e.b
    const startRow = byId.get(startId)
    if (!startRow) continue
    const members: EntryRow[] = [startRow]
    const memberSet = new Set<string>([startId])
    const queue = [...(adj.get(startId) ?? [])].sort((x, y) => y.score - x.score)
    for (const next of queue) {
      if (members.length >= CLUSTER_MAX_SIZE) break
      if (assigned.has(next.id) || memberSet.has(next.id)) continue
      const row = byId.get(next.id)
      if (!row || !members.every((m) => canClusterEntries(m, row))) continue
      members.push(row)
      memberSet.add(next.id)
    }
    if (members.length >= 2) {
      for (const m of members) assigned.add(m.id)
      clusters.push({ rows: members, peak: e.score })
    }
  }
  return clusters.sort((a, b) => b.peak - a.peak).map((c) => c.rows)
}

function toClusterPromptItem(
  row: EntryRow,
  outbound: ReadonlySet<string> | undefined,
  perItemLimit: number,
): DreamPromptItem {
  const base = toPromptItem(row, perItemLimit)
  const overCap = row.content.length > perItemLimit
  return {
    ...base,
    bootMode: row.bootMode,
    outboundShortIds: outbound ? [...outbound] : [],
    ...(overCap ? { outline: buildOutlineSummary(row.content), truncated: true } : {}),
  }
}

const TASK_ALLOWED_KINDS: Record<
  'cluster' | 'habit' | 'episode' | 'links' | 'boot_trim',
  ReadonlySet<DreamSuggestionKind>
> = {
  cluster: new Set(['merge_duplicates', 'link_entries', 'update', 'mark_stale']),
  habit: new Set(['update', 'distill_episode']),
  episode: new Set(['update', 'distill_episode']),
  links: new Set(['link_entries']),
  boot_trim: new Set(['adjust_boot_mode']),
}

async function runSingleLlmMicroTask(
  conn: ModelConnection,
  messages: ReturnType<typeof buildClusterAuditMessages>,
  catalog: ReadonlyMap<string, DreamPromptItem>,
  guard: BatchResilienceGuard,
  options: {
    allowedKinds: ReadonlySet<DreamSuggestionKind>
    maxTokens: number
    maxRetries: number
    retryBaseMs?: number | undefined
    signal?: AbortSignal | undefined
    onRetry: () => void
  },
): Promise<
  { status: 'ok'; proposals: ParsedDreamProposal[] } | { status: 'invalid'; reason: string }
> {
  const res = await chatComplete(conn, messages, {
    temperature: 0.15,
    jsonMode: true,
    maxTokens: options.maxTokens,
    timeoutMs: CROSS_TIMEOUT_MS,
    stream: true,
    taskKind: 'organize',
    maxRetries: options.maxRetries,
    ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onRetry: ({ error }) => {
      options.onRetry()
      if (error.category === 'rate_limit') guard.recordRateLimit(error)
    },
  })
  guard.recordSuccess()

  let evaluated = evaluateDreamResponse(res.content, catalog, {
    allowedKinds: options.allowedKinds,
  })
  if (evaluated.status === 'invalid' && !options.signal?.aborted && !guard.isAborted) {
    await guard.waitIfCooling(options.signal)
    if (!options.signal?.aborted && !guard.isAborted) {
      options.onRetry()
      const repairMessages = buildSemanticRepairMessages(
        messages,
        `上次输出解析失败（${evaluated.reason}）。请严格只输出单个合法 JSON 对象：{"suggestions":[...]}，没有建议时输出 {"suggestions":[]}。`,
      )
      const repaired = await chatComplete(conn, repairMessages, {
        temperature: 0,
        jsonMode: true,
        maxTokens: options.maxTokens,
        timeoutMs: CROSS_TIMEOUT_MS,
        stream: true,
        taskKind: 'organize',
        maxRetries: 0,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      guard.recordSuccess()
      evaluated = evaluateDreamResponse(repaired.content, catalog, {
        allowedKinds: options.allowedKinds,
      })
    }
  }
  return evaluated
}

export interface CrossMemoryOptions {
  scope?: DreamScope | undefined
  targetShortIds?: readonly string[] | undefined
  maxCalls?: number | undefined
  retryBaseMs?: number | undefined
  cooldownFallbackMs?: number | undefined
  signal?: AbortSignal | undefined
  onProgress?: ((progress: DreamProgress) => void) | undefined
}

interface CrossMemoryRunOutput {
  result: Omit<DreamExecutionResult, 'mode'>
  insertedIds: string[]
  consideredNeighbors: number
}

// 四阶段漏斗跨记忆整理引擎：
// Stage 0 场域与双轨范围 → Stage 1 零 LLM 多路候选图（pgvector + 同项目 + 相关性 FTS + 1 跳邻居 + 断链）
// → Stage 2 按优先级拆分 Micro-Task（查重簇 > 跨会话重复偏好拾遗 > 摘要对账 > 缺链与断链 > 常驻减肥）→ Stage 3 去重入收件箱
export async function runCrossMemoryFunnel(
  db: Db,
  conn: ModelConnection,
  options: CrossMemoryOptions = {},
): Promise<CrossMemoryRunOutput> {
  const scope: DreamScope =
    options.scope ?? (options.targetShortIds?.length ? 'incremental' : 'full_corpus')
  const maxCalls = Math.max(1, options.maxCalls ?? DEFAULT_MAX_CROSS_CALLS)
  const targetShortSet = options.targetShortIds?.length
    ? new Set(options.targetShortIds.map(normalizeShortId))
    : null

  const now = await databaseNow(db)
  const allActive = await db
    .select()
    .from(entries)
    .where(and(isNull(entries.deletedAt), stillValidSql(now)))
    .orderBy(desc(entries.updatedAt))

  const formalEntries = allActive.filter((r) => r.kind === 'entry')
  const activeEpisodes = allActive.filter((r) => r.kind === 'episode')
  const byId = new Map(allActive.map((r) => [r.id, r]))

  // Stage 0：确定种子集；跨会话重复偏好拾遗独立于 dreamCheckedVersion 水位，扫描最近 14 天带偏好信号的活跃摘要
  const seedFormal: EntryRow[] = targetShortSet
    ? formalEntries.filter((r) => targetShortSet.has(r.shortId))
    : scope === 'full_corpus'
      ? formalEntries
      : formalEntries.filter((r) => r.version > r.dreamCheckedVersion)
  const seedEpisodes: EntryRow[] = targetShortSet
    ? activeEpisodes.filter((r) => targetShortSet.has(r.shortId))
    : activeEpisodes.filter((r) => scope === 'full_corpus' || r.version > r.dreamCheckedVersion)

  const habitSourceEpisodes = targetShortSet ? seedEpisodes : activeEpisodes
  const habitCutoffMs = now.getTime() - HABIT_WINDOW_MS
  const habitCandidateEpisodes = habitSourceEpisodes
    .filter(
      (ep) =>
        ep.createdAt.getTime() >= habitCutoffMs &&
        parseEpisodeSignals(ep.disclosure).directives.length > 0,
    )
    .slice(0, HABIT_CANDIDATES_MAX)

  if (!seedFormal.length && !seedEpisodes.length && habitCandidateEpisodes.length < 2) {
    return {
      result: {
        outcome: 'skipped',
        considered: 0,
        suggested: 0,
        error: null,
        failedItems: [],
        retriedCount: 0,
        abortedReason: null,
      },
      insertedIds: [],
      consideredNeighbors: 0,
    }
  }

  // Stage 1：零 LLM 候选图构建
  const seedFormalIds = seedFormal.map((r) => r.id)
  const [vectorPairs, linkMaps, existingSuggestions] = await Promise.all([
    findVectorPairsForSeeds(db, seedFormalIds, LINK_COSINE_MIN, 240),
    loadOutboundLinksMap(
      db,
      formalEntries.map((r) => r.id),
    ),
    loadExistingSuggestions(db),
  ])
  const existingFingerprints = existingSuggestions.fingerprints

  const highSimEdges: { a: string; b: string; score: number }[] = []
  const mediumNeighborsBySeed = new Map<string, Map<string, number>>()
  const vectorCoveredSeeds = new Set<string>()
  const consideredNeighborIds = new Set<string>()

  const addMediumCand = (seedId: string, candId: string, score: number) => {
    if (seedId === candId) return
    const seed = byId.get(seedId)
    const cand = byId.get(candId)
    if (!seed || !cand || cand.kind !== 'entry') return
    if (!canFlowRealmInto(seed.realms, cand.realms)) return
    const outbound = linkMaps.outboundByEntryId.get(seedId)
    if (outbound?.has(cand.shortId)) return
    let map = mediumNeighborsBySeed.get(seedId)
    if (!map) {
      map = new Map()
      mediumNeighborsBySeed.set(seedId, map)
    }
    const prev = map.get(candId) ?? 0
    if (score > prev) map.set(candId, score)
    consideredNeighborIds.add(candId)
  }

  for (const pair of vectorPairs) {
    vectorCoveredSeeds.add(pair.entry_a)
    const rowA = byId.get(pair.entry_a)
    const rowB = byId.get(pair.entry_b)
    if (pair.sim >= CLUSTER_COSINE_THRESHOLD && rowA && rowB && canClusterEntries(rowA, rowB)) {
      highSimEdges.push({ a: pair.entry_a, b: pair.entry_b, score: pair.sim })
      consideredNeighborIds.add(pair.entry_b)
    } else if (pair.sim >= LINK_COSINE_MIN) {
      addMediumCand(pair.entry_a, pair.entry_b, pair.sim)
    }
  }

  // 补充同项目候选进入关联图（不再使用易受主题灌水影响的 sharedTopics >= 2 启发式）
  for (const seed of seedFormal) {
    if (!seed.projects.length) continue
    for (const other of formalEntries) {
      if (other.id === seed.id || !other.projects.length) continue
      const sharedProjects = shareAny(seed.projects, other.projects)
      if (!sharedProjects) continue
      const heuristicScore = Math.min(0.8, 0.7 + sharedProjects * 0.05)
      addMediumCand(seed.id, other.id, heuristicScore)
    }
  }

  // 对缺失向量命中且尚未找到邻居的种子，用相关性排序（ts_rank_cd）FTS 补充近邻
  const ftsProbeSeeds = seedFormal.filter(
    (s) => !vectorCoveredSeeds.has(s.id) && !mediumNeighborsBySeed.get(s.id)?.size,
  )
  for (const seed of ftsProbeSeeds.slice(0, 12)) {
    const ftsIds = await findRankedFtsCandidates(db, seed, new Set([seed.id]), 6)
    for (let idx = 0; idx < ftsIds.length; idx++) {
      const candId = ftsIds[idx]!
      const score = 0.78 - idx * 0.02
      addMediumCand(seed.id, candId, score)
      // 单条/多选指定查重时，若无向量嵌入，把同场域且场景不互斥的 Top-2 强相关 FTS 邻居纳入簇查重
      if (targetShortSet && idx < 2) {
        const candRow = byId.get(candId)
        if (candRow && canClusterEntries(seed, candRow)) {
          highSimEdges.push({ a: seed.id, b: candId, score: 0.84 })
        }
      }
    }
  }

  // 构建 5 类有序 Micro-Task 队列（优先级：高相似查重簇 > 跨会话重复偏好拾遗 > 近期 episode 反向对账 > 缺失双链与断链 > 全文常驻减肥）
  type MicroTask =
    | { kind: 'cluster'; stage: string; rows: EntryRow[] }
    | {
        kind: 'habit'
        stage: string
        episodes: EntryRow[]
        targets: EntryRow[]
        realms: string[]
        clusterDiscriminator: string
        provenance: HabitDistillProvenance
      }
    | { kind: 'episode'; stage: string; episode: EntryRow; targets: EntryRow[] }
    | {
        kind: 'links'
        stage: string
        seed: EntryRow
        candidates: EntryRow[]
        broken: BrokenLinkHint[]
      }
    | { kind: 'boot_trim'; stage: string; rows: EntryRow[] }

  const tasks: MicroTask[] = []

  // Task A：高相似重复簇（2–4 条）
  const clusters = buildDuplicateClusters(highSimEdges, byId)
  for (const cluster of clusters) {
    const fp = suggestionFingerprint(
      'merge_duplicates',
      cluster.map((r) => r.id),
      cluster.map((r) => r.version),
    )
    if (existingFingerprints.has(fp)) continue
    tasks.push({ kind: 'cluster', stage: '查重与冲突审阅', rows: cluster })
  }

  // Task E：同场域跨会话重复偏好拾遗（≥ 2 次独立会话触发，优先匹配既有习惯词条，已应用/驳回后按稳定簇指纹彻底抑制复发）
  const habitClusteredEpisodeIds = new Set<string>()
  const seenHabitClusterDiscs = new Set<string>()
  if (habitCandidateEpisodes.length >= 2) {
    const habitEmbRows = await db
      .select({
        entryId: entryEmbeddings.entryId,
        model: entryEmbeddings.model,
        embedding: entryEmbeddings.embedding,
      })
      .from(entryEmbeddings)
      .where(
        inArray(
          entryEmbeddings.entryId,
          habitCandidateEpisodes.map((ep) => ep.id),
        ),
      )

    const byModelRealm = new Map<
      string,
      { model: string; items: { row: EntryRow; vec: number[] }[] }
    >()
    for (const emb of habitEmbRows) {
      const row = byId.get(emb.entryId)
      if (!row || !emb.embedding.length) continue
      const realmKey = normalizeSlugList(row.realms).join(',')
      const groupKey = `${emb.model}\0${realmKey}`
      let bucket = byModelRealm.get(groupKey)
      if (!bucket) {
        bucket = { model: emb.model, items: [] }
        byModelRealm.set(groupKey, bucket)
      }
      bucket.items.push({ row, vec: emb.embedding })
    }

    for (const { model, items } of byModelRealm.values()) {
      if (items.length < 2) continue
      const edges: { a: string; b: string; score: number }[] = []
      const vecById = new Map(items.map((it) => [it.row.id, it.vec]))
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const sim = cosineSimilarity(items[i]!.vec, items[j]!.vec)
          if (sim >= HABIT_COSINE_THRESHOLD) {
            edges.push({ a: items[i]!.row.id, b: items[j]!.row.id, score: sim })
          }
        }
      }
      if (!edges.length) continue

      const habitClusters = buildHabitClusters(
        items.map((it) => it.row),
        edges,
      )
      for (const clusterRows of habitClusters) {
        // 无论该簇是否已被历史建议覆盖，均标记已归入习惯簇，防止仅含偏好的已驳回摘要绕回 Task C 重复弹出
        for (const r of clusterRows) habitClusteredEpisodeIds.add(r.id)

        const clusterDisc = habitClusterDiscriminator(clusterRows)
        if (seenHabitClusterDiscs.has(clusterDisc)) continue
        seenHabitClusterDiscs.add(clusterDisc)

        const clusterIds = clusterRows.map((r) => r.id)
        const clusterVersions = clusterRows.map((r) => r.version)
        if (
          existingFingerprints.has(
            suggestionFingerprint('distill_episode', clusterIds, clusterVersions, clusterDisc),
          )
        ) {
          continue
        }

        // 若该簇此前已生成过 update 或 distill_episode（无论目标词条后续版本是否递增、是否仍在 Top-3 或仅选了簇内子集），一律跳过避免循环
        const matchedExistingByDisc =
          existingSuggestions.updateRecords.some(
            (u) =>
              suggestionFingerprint('update', [u.entryId], [u.version], clusterDisc) ===
              u.fingerprint,
          ) ||
          existingSuggestions.distillRecords.some(
            (d) =>
              suggestionFingerprint('distill_episode', d.entryIds, d.entryVersions, clusterDisc) ===
              d.fingerprint,
          )
        if (matchedExistingByDisc) continue

        // 若该簇已被某条历史/待处理/已驳回提炼建议覆盖，且剩余未覆盖摘要不足 2 次独立会话，则不再重复弹出
        const suppressedByExisting = existingSuggestions.distillRecords.some((d) => {
          const overlap = clusterRows.filter((r) => d.entryIdSet.has(r.id)).length
          if (overlap < 2) return false
          const remaining = clusterRows.filter((r) => !d.entryIdSet.has(r.id))
          return countDistinctHabitSessions(remaining) < HABIT_MIN_DISTINCT_SESSIONS
        })
        if (suppressedByExisting) continue

        const clusterRealms = normalizeSlugList(clusterRows[0]!.realms)
        const clusterProjects = normalizeSlugList(
          clusterRows.flatMap((r) => (r.projectSlug ? [r.projectSlug, ...r.projects] : r.projects)),
        )
        const centroid = computeNormalizedCentroid(
          clusterRows.map((r) => vecById.get(r.id)).filter((v): v is number[] => Boolean(v)),
        )
        let scoredTargets: EntryRow[] = []
        if (centroid) {
          const rawHits = await findFormalTargetsByCentroid(db, model, centroid, clusterRealms, now)
          scoredTargets = rawHits
            .map((hit) => {
              const entry = byId.get(hit.entryId)
              if (!entry || entry.kind !== 'entry') return null
              if (!canFlowRealmInto(entry.realms, clusterRealms)) return null
              let score = hit.sim
              if (entry.bootMode === 'full') score += 0.12
              else if (entry.bootMode === 'index') score += 0.05
              if (clusterProjects.length && shareAny(entry.projects, clusterProjects) > 0) {
                score += 0.06
              }
              return { entry, score }
            })
            .filter((x): x is { entry: EntryRow; score: number } => x !== null)
            .sort((a, b) => b.score - a.score)
            .slice(0, HABIT_TARGETS_MAX)
            .map((x) => x.entry)
        }

        const dates = clusterRows.map((r) => r.createdAt.toISOString().slice(0, 10)).sort()
        const firstDate = dates[0] ?? null
        const lastDate = dates.at(-1) ?? null
        const dateRange =
          firstDate && lastDate
            ? firstDate === lastDate
              ? firstDate
              : `${firstDate} 至 ${lastDate}`
            : null
        const devices = [
          ...new Set(
            clusterRows.map((r) => r.deviceKey?.trim()).filter((v): v is string => Boolean(v)),
          ),
        ]
        const distinctSessions = countDistinctHabitSessions(clusterRows)

        for (const t of scoredTargets) consideredNeighborIds.add(t.id)
        tasks.push({
          kind: 'habit',
          stage: '跨会话偏好拾遗',
          episodes: clusterRows,
          targets: scoredTargets,
          realms: clusterRealms,
          clusterDiscriminator: clusterDisc,
          provenance: {
            realms: clusterRealms,
            episodeCount: clusterRows.length,
            distinctSessions,
            projects: clusterProjects,
            devices,
            dateRange,
          },
        })
      }
    }
  }

  // Task C：近期 episode 反向对账与吸收（带 facts 信号且有向量的摘要优先使用信号向量召回常青目标；仅含偏好且已建信号向量的单次摘要交由 Task E 跨会话克制把关）
  const directiveOnlySeedIds = seedEpisodes
    .filter((ep) => {
      if (habitClusteredEpisodeIds.has(ep.id)) return false
      const sig = parseEpisodeSignals(ep.disclosure)
      return sig.directives.length > 0 && sig.facts.length === 0
    })
    .map((ep) => ep.id)
  const embeddedDirectiveOnlyIds = new Set<string>()
  if (directiveOnlySeedIds.length) {
    const embCheck = await db
      .select({ entryId: entryEmbeddings.entryId })
      .from(entryEmbeddings)
      .where(inArray(entryEmbeddings.entryId, directiveOnlySeedIds))
    for (const r of embCheck) embeddedDirectiveOnlyIds.add(r.entryId)
  }

  const taskCEpisodes = seedEpisodes
    .filter((ep) => {
      const sig = parseEpisodeSignals(ep.disclosure)
      if (habitClusteredEpisodeIds.has(ep.id) && sig.facts.length === 0) return false
      if (embeddedDirectiveOnlyIds.has(ep.id)) return false
      return true
    })
    .slice(0, 6)
  const factEpisodeIds = taskCEpisodes
    .filter((ep) => parseEpisodeSignals(ep.disclosure).facts.length > 0)
    .map((ep) => ep.id)
  const episodeVectorNeighbors = await findEpisodeFormalVectorNeighbors(db, factEpisodeIds, now)

  for (const ep of taskCEpisodes) {
    const sameRealmEntries = formalEntries.filter((e) => canFlowRealmInto(e.realms, ep.realms))
    const vecMap = episodeVectorNeighbors.get(ep.id)
    const rankedFts = await findRankedFtsCandidates(db, ep, new Set([ep.id]), 8)
    const ftsRank = new Map(rankedFts.map((id, i) => [id, 10 - i]))
    const epProjects = normalizeSlugList(
      ep.projectSlug ? [ep.projectSlug, ...ep.projects] : ep.projects,
    )
    const scoredTargets = sameRealmEntries
      .map((entry) => {
        const vecSim = vecMap?.get(entry.id) ?? 0
        const ftsScore = ftsRank.get(entry.id) ?? 0
        const base = (vecSim > 0 ? vecSim * 18 : 0) + ftsScore
        if (base <= 0) return { entry, score: 0 }
        let s = base
        if (epProjects.length && shareAny(entry.projects, epProjects) > 0) s += 6
        if (entry.bootMode === 'full') s += 2
        else if (entry.bootMode === 'index') s += 1
        return { entry, score: s }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, EPISODE_TARGETS_MAX)
      .map((x) => x.entry)

    if (
      !scoredTargets.length &&
      existingFingerprints.has(suggestionFingerprint('distill_episode', [ep.id], [ep.version]))
    ) {
      continue
    }

    tasks.push({
      kind: 'episode',
      stage: '会话摘要对账',
      episode: ep,
      targets: scoredTargets,
    })
  }

  // Task B：缺失双链与断链重连（按候选质量与断链存在度排序）
  const linkTaskCandidates: {
    seed: EntryRow
    candidates: EntryRow[]
    broken: BrokenLinkHint[]
    priority: number
  }[] = []
  for (const seed of seedFormal) {
    const broken = linkMaps.brokenByEntryId.get(seed.id) ?? []
    const candMap = mediumNeighborsBySeed.get(seed.id)
    const rankedCands = candMap
      ? [...candMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, LINK_CANDIDATES_MAX)
          .map(([id]) => byId.get(id))
          .filter((r): r is EntryRow => r !== undefined)
      : []
    if (!rankedCands.length && !broken.length) continue
    const topSim = candMap ? Math.max(...candMap.values(), 0) : 0
    linkTaskCandidates.push({
      seed,
      candidates: rankedCands,
      broken,
      priority: topSim + (broken.length ? 0.5 : 0),
    })
  }
  linkTaskCandidates.sort((a, b) => b.priority - a.priority)
  for (const item of linkTaskCandidates) {
    tasks.push({
      kind: 'links',
      stage: '双链关联巡检',
      seed: item.seed,
      candidates: item.candidates,
      broken: item.broken,
    })
  }

  // Task D：常驻层减肥与防漂移巡检（跳过单条定向查重）
  if (!targetShortSet || targetShortSet.size > 1) {
    const oversizedPinned = seedFormal.filter(
      (r) => r.bootMode === 'full' && r.content.length > PINNED_FULL_SOFT_WARN_CHARS,
    )
    for (let i = 0; i < oversizedPinned.length; i += BOOT_AUDIT_BATCH_SIZE) {
      const slice = oversizedPinned.slice(i, i + BOOT_AUDIT_BATCH_SIZE)
      const unchecked = slice.filter(
        (r) =>
          !existingFingerprints.has(
            suggestionFingerprint('adjust_boot_mode', [r.id], [r.version], 'boot:index'),
          ) &&
          !existingFingerprints.has(
            suggestionFingerprint('adjust_boot_mode', [r.id], [r.version], 'boot:none'),
          ),
      )
      if (unchecked.length) {
        tasks.push({ kind: 'boot_trim', stage: '常驻层巡检', rows: unchecked })
      }
    }
  }

  const scheduled = tasks.slice(0, maxCalls)
  if (!scheduled.length) {
    return {
      result: {
        outcome: 'skipped',
        considered: 0,
        suggested: 0,
        error: null,
        failedItems: [],
        retriedCount: 0,
        abortedReason: null,
      },
      insertedIds: [],
      consideredNeighbors: consideredNeighborIds.size,
    }
  }

  const guard = new BatchResilienceGuard(options.cooldownFallbackMs)
  const failedItems: DreamFailedItem[] = []
  const failedShortSet = new Set<string>()
  const insertedIds: string[] = []
  let considered = 0
  let suggested = 0
  let succeededTasks = 0
  let failedTasks = 0
  let retriedCount = 0

  const appendFailure = (row: EntryRow, kind: string, reason: string) => {
    if (failedItems.length >= 50 || failedShortSet.has(row.shortId)) return
    failedShortSet.add(row.shortId)
    failedItems.push({
      shortId: row.shortId,
      title: clipChars(row.title, 120),
      kind,
      reason: clipChars(reason, 240),
    })
  }

  for (let idx = 0; idx < scheduled.length && !options.signal?.aborted && !guard.isAborted; idx++) {
    const task = scheduled[idx]!
    try {
      await guard.waitIfCooling(options.signal)
    } catch {
      break
    }
    if (options.signal?.aborted || guard.isAborted) break

    options.onProgress?.({
      mode: 'cross_memory',
      stage: task.stage,
      processed: idx,
      total: scheduled.length,
      suggested,
      failed: failedTasks,
    })

    const taskRows: EntryRow[] = []
    if (task.kind === 'cluster') {
      taskRows.push(...task.rows)
    } else if (task.kind === 'habit') {
      taskRows.push(...task.episodes, ...task.targets)
    } else if (task.kind === 'episode') {
      taskRows.push(task.episode, ...task.targets)
    } else if (task.kind === 'links') {
      taskRows.push(task.seed)
    } else {
      taskRows.push(...task.rows)
    }

    const executeMicroTask = async () => {
      const microTaskRetries = targetShortSet?.size === 1 ? 1 : CROSS_HTTP_RETRIES
      if (task.kind === 'cluster') {
        return runClusterTaskWithTopTwoFallback(
          task.rows,
          highSimEdges,
          (clusterRows) => {
            const perItemLimit = Math.min(
              CLUSTER_ITEM_CHAR_LIMIT,
              Math.floor(CLUSTER_TOTAL_CHAR_BUDGET / Math.max(1, clusterRows.length)),
            )
            const promptItems = clusterRows.map((r) =>
              toClusterPromptItem(r, linkMaps.outboundByEntryId.get(r.id), perItemLimit),
            )
            const clusterCatalog = new Map<string, DreamPromptItem>()
            for (const p of promptItems) clusterCatalog.set(p.shortId, p)
            const clusterMessages = buildClusterAuditMessages(promptItems)
            const targetChars = promptItems.reduce((sum, p) => sum + p.content.length, 0)
            const clusterMaxTokens = computeCrossMemoryTaskMaxTokens('cluster', targetChars)
            return runSingleLlmMicroTask(conn, clusterMessages, clusterCatalog, guard, {
              allowedKinds: TASK_ALLOWED_KINDS.cluster,
              maxTokens: clusterMaxTokens,
              maxRetries: microTaskRetries,
              retryBaseMs: options.retryBaseMs,
              signal: options.signal,
              onRetry: () => {
                retriedCount++
              },
            })
          },
          {
            signal: options.signal,
            guard,
            onFallback: () => {
              retriedCount++
            },
          },
        )
      }

      const catalog = new Map<string, DreamPromptItem>()
      let messages: ReturnType<typeof buildClusterAuditMessages>
      let maxTokens: number

      if (task.kind === 'habit') {
        const epItems = task.episodes.map((r) => toPromptItem(r, 1_500))
        const targetItems = task.targets.map((r) =>
          toClusterPromptItem(r, linkMaps.outboundByEntryId.get(r.id), 4_000),
        )
        for (const p of epItems) catalog.set(p.shortId, p)
        for (const p of targetItems) catalog.set(p.shortId, p)
        messages = buildHabitDistillMessages(epItems, targetItems, task.provenance)
        const targetChars =
          epItems.reduce((sum, p) => sum + p.content.length, 0) +
          targetItems.reduce((sum, p) => sum + p.content.length, 0)
        maxTokens = computeCrossMemoryTaskMaxTokens('habit', targetChars)
      } else if (task.kind === 'episode') {
        const epItem = toPromptItem(task.episode, 3_000)
        const targetItems = task.targets.map((r) =>
          toClusterPromptItem(r, linkMaps.outboundByEntryId.get(r.id), 4_000),
        )
        catalog.set(epItem.shortId, epItem)
        for (const p of targetItems) catalog.set(p.shortId, p)
        messages = buildEpisodeReconcileMessages(epItem, targetItems)
        const targetChars =
          epItem.content.length + targetItems.reduce((sum, p) => sum + p.content.length, 0)
        maxTokens = computeCrossMemoryTaskMaxTokens('episode', targetChars)
      } else if (task.kind === 'links') {
        const seedItem: DreamPromptItem = {
          ...toPromptItem(task.seed, LINK_SEED_CONTENT_LIMIT),
          bootMode: task.seed.bootMode,
          outboundShortIds: [...(linkMaps.outboundByEntryId.get(task.seed.id) ?? [])],
        }
        const candItems = task.candidates.map((r) => ({
          ...toPromptItem(r, 400),
          bootMode: r.bootMode,
        }))
        catalog.set(seedItem.shortId, seedItem)
        for (const c of candItems) catalog.set(c.shortId, c)
        messages = buildLinkAuditMessages(seedItem, candItems, task.broken)
        maxTokens = computeCrossMemoryTaskMaxTokens('links')
      } else {
        const pinnedItems = task.rows.map((r) => ({
          ...toPromptItem(r, 2_000),
          bootMode: r.bootMode,
        }))
        for (const p of pinnedItems) catalog.set(p.shortId, p)
        messages = buildBootAuditMessages(pinnedItems)
        maxTokens = computeCrossMemoryTaskMaxTokens('boot_trim')
      }

      return runSingleLlmMicroTask(conn, messages, catalog, guard, {
        allowedKinds: TASK_ALLOWED_KINDS[task.kind],
        maxTokens,
        maxRetries: microTaskRetries,
        retryBaseMs: options.retryBaseMs,
        signal: options.signal,
        onRetry: () => {
          retriedCount++
        },
      })
    }

    considered += taskRows.length
    try {
      const evaluated = await executeMicroTask()

      if (evaluated.status === 'invalid') {
        failedTasks++
        for (const r of taskRows) appendFailure(r, 'cross_memory', evaluated.reason)
      } else {
        for (const prop of evaluated.proposals) {
          let normalizedProp = prop
          if (task.kind === 'habit') {
            if (prop.kind === 'distill_episode') {
              const chosenEps = prop.entryIds
                .map((id) => byId.get(id))
                .filter((r): r is EntryRow => r !== undefined && r.kind === 'episode')
              if (
                chosenEps.length < 2 ||
                countDistinctHabitSessions(chosenEps) < HABIT_MIN_DISTINCT_SESSIONS
              ) {
                continue
              }
            } else if (prop.kind === 'update') {
              const target = prop.entryIds[0] ? byId.get(prop.entryIds[0]) : undefined
              if (!target || !canFlowRealmInto(target.realms, task.realms)) continue
            }
            normalizedProp = { ...prop, actionDiscriminator: task.clusterDiscriminator }
          }
          const id = await insertDreamProposal(db, normalizedProp, byId)
          if (id) {
            insertedIds.push(id)
            suggested++
          }
        }
        succeededTasks++
      }
    } catch (err) {
      if (options.signal?.aborted) {
        considered = Math.max(0, considered - taskRows.length)
        break
      }
      guard.recordFailure(err)
      failedTasks++
      const reason = err instanceof Error ? err.message : String(err)
      for (const r of taskRows) appendFailure(r, 'cross_memory', reason)
    }

    options.onProgress?.({
      mode: 'cross_memory',
      stage: task.stage,
      processed: idx + 1,
      total: scheduled.length,
      suggested,
      failed: failedTasks,
    })
  }

  if (options.signal?.aborted && !guard.isAborted) {
    return {
      result: {
        outcome: 'cancelled',
        considered,
        suggested,
        error: null,
        failedItems,
        retriedCount,
        abortedReason: '已手动取消',
      },
      insertedIds,
      consideredNeighbors: consideredNeighborIds.size,
    }
  }

  const abortedReason = guard.abortedReason ?? (options.signal?.aborted ? '任务已中止' : null)
  let outcome: DreamOutcome = 'ok'
  let error: string | null = null
  if (failedTasks > 0 || abortedReason) {
    outcome = succeededTasks > 0 ? 'partial' : 'failed'
    error =
      abortedReason ??
      (failedItems.length
        ? `${failedItems[0]!.shortId}：${failedItems[0]!.reason}`.slice(0, 400)
        : '跨记忆整理部分任务失败')
  }

  return {
    result: {
      outcome,
      considered,
      suggested,
      error,
      failedItems,
      retriedCount,
      abortedReason,
    },
    insertedIds,
    consideredNeighbors: consideredNeighborIds.size,
  }
}

// 编辑页主动单条深度查重与关联：不占全局 dream 锁，直接以当前词条为锚点跑 Stage 1 + Task A/B 并返回关联待处理卡片
export async function runSingleCrossCheck(
  db: Db,
  masterKey: MasterKey | null,
  rawShortId: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<SingleCrossCheckResponse> {
  const shortId = normalizeShortId(rawShortId)
  const [target] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.shortId, shortId), isNull(entries.deletedAt)))
    .limit(1)
  if (!target) throw new MemoryError(404, '记忆不存在或已移入回收站')
  if (target.kind !== 'entry') {
    throw new MemoryError(400, '会话摘要不支持直接查重与关联，请先提炼为正式记忆')
  }
  const now = await databaseNow(db)
  if (target.validTo !== null && target.validTo <= now) {
    throw new MemoryError(400, '已过期的记忆不支持查重与关联，请先调整有效期')
  }

  const conn = await loadResolvedModel(db, masterKey, CHAT_LLM_SETTING_KEY)
  if (!conn) throw new MemoryError(400, '尚未配置或启用对话模型')

  const funnel = await runCrossMemoryFunnel(db, conn, {
    scope: 'incremental',
    targetShortIds: [shortId],
    maxCalls: SINGLE_CROSS_MAX_CALLS,
    signal: options.signal,
  })

  if (options.signal?.aborted) {
    throw new CaptureAbortedError()
  }
  if (funnel.result.outcome === 'failed' && funnel.result.error) {
    throw new MemoryError(502, `查重与关联失败：${funnel.result.error}`)
  }

  const warnings: string[] = []
  if (funnel.result.outcome === 'partial') {
    const seen = new Set<string>()
    const addWarning = (raw: string | null | undefined) => {
      const text = raw?.trim()
      if (!text || seen.has(text)) return
      seen.add(text)
      warnings.push(text)
    }
    addWarning(funnel.result.abortedReason)
    for (const item of funnel.result.failedItems) {
      addWarning(item.reason)
    }
    if (warnings.length === 0) {
      addWarning(funnel.result.error ?? '部分关联检查未完成')
    }
  }

  // 返回本次新生成与该词条当前所有待处理建议，便于抽屉内联审阅
  const pendingRows = await db
    .select()
    .from(dreamSuggestions)
    .where(
      and(
        eq(dreamSuggestions.status, 'pending'),
        sql`${target.id}::uuid = any(${dreamSuggestions.entryIds})`,
      ),
    )
    .orderBy(desc(dreamSuggestions.createdAt))
    .limit(20)

  const suggestions = await hydrateDreamSuggestions(db, pendingRows)

  return {
    shortId,
    consideredNeighbors: funnel.consideredNeighbors,
    createdCount: funnel.insertedIds.length,
    suggestions,
    ...(funnel.result.retriedCount > 0 ? { retriedCount: funnel.result.retriedCount } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
