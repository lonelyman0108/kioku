import { createHash } from 'node:crypto'

import {
  lintEntryHygiene,
  normalizeShortId,
  type DreamEntrySnapshot,
  type DreamFailedItem,
  type DreamMode,
  type DreamOutcome,
  type DreamProgress,
  type DreamRunSummary,
  type DreamScope,
  type DreamSuggestionKind,
  type DreamSuggestionView,
  type DreamTrigger,
  type EmbeddingBackfillState,
  type InboxResponse,
} from '@kioku/contracts'
import { and, asc, desc, eq, gt, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'

import { stillValidSql } from '../access/scope'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { dreamSuggestions, entries, entryLinks } from '../db/schema'
import { abortableSleep, chatComplete, ModelClientError, type ChatMessage } from '../models/client'
import {
  CHAT_LLM_SETTING_KEY,
  loadDreamState,
  loadResolvedModel,
  loadTidyCheckedVersions,
  recordDreamRun,
  saveTidyCheckedVersions,
} from '../models/store'
import { anyTermQuery, clipChars, searchTerms } from '../recall/recall'
import { inlineText } from '../recall/text'
import { runCrossMemoryFunnel } from './crossMemory'
import {
  buildDreamMessages,
  buildSemanticRepairMessages,
  buildTidyMessages,
  evaluateDreamResponse,
  evaluateTidyResponse,
  type DreamPromptItem,
  type ParsedDreamProposal,
} from './dreamPrompt'

const MAX_CALLS_PER_RUN = 4
export const CHANGED_PER_CALL = 8
const MAX_NEIGHBORS_PER_CALL = 15
const NEIGHBORS_PER_ITEM = 5
export const STANDARD_CHANGED_CHAR_BUDGET = 12_000
export const STANDARD_NEIGHBOR_CHAR_BUDGET = 8_000
export const STANDARD_TOTAL_CHAR_BUDGET = 20_000
const ITEM_CONTENT_LIMIT = 1_500
const COMPACT_NEIGHBOR_EXCERPT_LIMIT = 240
export const STANDARD_MAX_SUGGESTIONS_PER_CALL = 5
const STANDARD_OUTPUT_TOKENS_MIN = 6_000
const STANDARD_OUTPUT_TOKENS_MAX = 12_000
const TIDY_OUTPUT_TOKENS_MIN = 6_000
const TIDY_OUTPUT_TOKENS_MAX = 16_384
const TIDY_CONTENT_LIMIT = 16_000
const DEFAULT_TIDY_BATCH_LIMIT = 10
const MAX_TIDY_BATCH_LIMIT = 200
const TIDY_CONCURRENCY = 3
const TIDY_CHAT_TIMEOUT_MS = 240_000
const STANDARD_DREAM_TIMEOUT_MS = 180_000
const DREAM_HTTP_MAX_RETRIES = 2
const RATE_LIMIT_COOLDOWN_FALLBACK_MS = 5_000
const QUOTA_CIRCUIT_BREAKER_THRESHOLD = 3
const MAX_FAILED_ITEMS = 50
const INBOX_ITEMS_LIMIT = 200

export interface DynamicOutputTokensOptions {
  min: number
  max: number
  overhead?: number | undefined
  charsMultiplier?: number | undefined
}

// 按待输出或待改写正文字符数动态估算输出 token 预算，避免固定低值导致中文长文截断
export function computeDynamicOutputTokens(
  targetChars: number,
  options: DynamicOutputTokensOptions,
): number {
  const safeChars = Math.max(0, Number.isFinite(targetChars) ? targetChars : 0)
  const multiplier = options.charsMultiplier ?? 1.6
  const overhead = options.overhead ?? 2_000
  const estimated = Math.ceil(safeChars * multiplier) + overhead
  return Math.max(options.min, Math.min(options.max, estimated))
}

type EntryRow = typeof entries.$inferSelect

export function toPromptItem(
  row: Pick<
    EntryRow,
    | 'id'
    | 'shortId'
    | 'kind'
    | 'title'
    | 'summary'
    | 'content'
    | 'disclosure'
    | 'envs'
    | 'realms'
    | 'projects'
    | 'runtimes'
    | 'topics'
    | 'version'
    | 'updatedAt'
  > & {
    bootMode?: EntryRow['bootMode'] | undefined
    deviceKey?: EntryRow['deviceKey'] | undefined
  },
  contentLimit = ITEM_CONTENT_LIMIT,
): DreamPromptItem {
  const truncated = row.content.length > contentLimit
  const deviceKey = row.deviceKey?.trim() || null
  return {
    id: row.id,
    shortId: row.shortId,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    content: truncated ? clipChars(row.content, contentLimit) : row.content,
    disclosure: row.disclosure,
    ...(row.bootMode ? { bootMode: row.bootMode } : {}),
    envs: row.envs,
    realms: row.realms,
    projects: row.projects,
    runtimes: row.runtimes,
    topics: row.topics,
    ...(deviceKey ? { deviceKey } : {}),
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    truncated,
  }
}

export function suggestionFingerprint(
  kind: DreamSuggestionKind,
  entryIds: readonly string[],
  entryVersions: readonly number[],
  discriminator?: string,
): string {
  const pairs = entryIds.map((id, i) => `${id}:${entryVersions[i]!}`).sort()
  const suffix = discriminator ? `|${discriminator}` : ''
  return createHash('sha256')
    .update(`${kind}|${pairs.join(',')}${suffix}`)
    .digest('hex')
}

export async function insertDreamProposal(
  db: Db,
  prop: ParsedDreamProposal,
  rowById: ReadonlyMap<string, Pick<EntryRow, 'id' | 'version'>>,
): Promise<string | null> {
  const versions = prop.entryIds.map((id) => rowById.get(id)?.version)
  if (versions.some((v) => v === undefined)) return null
  const concreteVersions = versions as number[]
  const fingerprint = suggestionFingerprint(
    prop.kind,
    prop.entryIds,
    concreteVersions,
    prop.actionDiscriminator,
  )
  const inserted = await db
    .insert(dreamSuggestions)
    .values({
      kind: prop.kind,
      entryIds: prop.entryIds,
      entryVersions: concreteVersions,
      keepId: prop.keepId,
      proposedTitle: prop.proposedTitle,
      proposedSummary: prop.proposedSummary,
      proposedContent: prop.proposedContent,
      proposedDisclosure: prop.proposedDisclosure,
      proposedChangeSummary: prop.proposedChangeSummary,
      archivedNotes: prop.archivedNotes,
      proposedTopics: prop.proposedTopics,
      proposedEnvs: prop.proposedEnvs,
      proposedRealms: prop.proposedRealms,
      proposedProjects: prop.proposedProjects,
      proposedRuntimes: prop.proposedRuntimes,
      proposedLinks: prop.proposedLinks,
      proposedBootMode: prop.proposedBootMode,
      reason: prop.reason,
      fingerprint,
      status: 'pending',
    })
    .onConflictDoNothing()
    .returning({ id: dreamSuggestions.id })
  return inserted[0]?.id ?? null
}

export class BatchResilienceGuard {
  private cooldownUntil = 0
  private throttled = false
  private consecutiveQuotaErrors = 0
  abortedReason: string | null = null
  private readonly cooldownFallbackMs: number

  constructor(cooldownFallbackMs = RATE_LIMIT_COOLDOWN_FALLBACK_MS) {
    this.cooldownFallbackMs = cooldownFallbackMs
  }

  get isThrottled(): boolean {
    return this.throttled
  }

  get isAborted(): boolean {
    return this.abortedReason !== null
  }

  recordSuccess(): void {
    this.consecutiveQuotaErrors = 0
  }

  recordRateLimit(err: ModelClientError): void {
    this.throttled = true
    const waitMs = Math.min(60_000, Math.max(10, err.retryAfterMs ?? this.cooldownFallbackMs))
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + waitMs)
  }

  recordFailure(err: unknown): void {
    if (!(err instanceof ModelClientError)) return
    if (err.category === 'rate_limit') {
      this.recordRateLimit(err)
      return
    }
    if (err.category === 'auth' || err.category === 'not_found') {
      this.abortedReason ??= err.message.slice(0, 300)
      return
    }
    if (err.category === 'quota') {
      this.consecutiveQuotaErrors++
      if (this.consecutiveQuotaErrors >= QUOTA_CIRCUIT_BREAKER_THRESHOLD) {
        this.abortedReason ??= `连续 ${this.consecutiveQuotaErrors} 次触发上游额度不足，已中止剩余批次`
      }
    }
  }

  async waitIfCooling(signal?: AbortSignal): Promise<void> {
    while (!this.isAborted && !signal?.aborted) {
      const remaining = this.cooldownUntil - Date.now()
      if (remaining <= 0) break
      await abortableSleep(remaining, signal)
    }
  }
}

function appendFailedItem(
  list: DreamFailedItem[],
  seenShorts: Set<string>,
  item: { shortId: string; title: string; kind: string; reason: string },
): void {
  if (list.length >= MAX_FAILED_ITEMS || seenShorts.has(item.shortId)) return
  seenShorts.add(item.shortId)
  list.push({
    shortId: item.shortId,
    title: clipChars(item.title, 120),
    kind: item.kind,
    reason: clipChars(item.reason, 240),
  })
}

type PromptSourceRow = Parameters<typeof toPromptItem>[0]

function estimatePromptItemChars(item: DreamPromptItem): number {
  return (
    item.title.length +
    (item.summary?.length ?? 0) +
    (item.disclosure?.length ?? 0) +
    item.content.length +
    120
  )
}

function toCompactNeighborPromptItem(row: PromptSourceRow): DreamPromptItem {
  const hasSummary = Boolean(row.summary?.trim())
  const base = toPromptItem(row, hasSummary ? 0 : COMPACT_NEIGHBOR_EXCERPT_LIMIT)
  if (hasSummary) {
    return {
      ...base,
      content: '',
      truncated: row.content.length > 0,
    }
  }
  const excerpt = clipChars(inlineText(row.content), COMPACT_NEIGHBOR_EXCERPT_LIMIT)
  return {
    ...base,
    content: excerpt,
    truncated: row.content.length > COMPACT_NEIGHBOR_EXCERPT_LIMIT || excerpt !== row.content,
  }
}

export interface PackedStandardDreamItems {
  promptChanged: DreamPromptItem[]
  promptNeighbors: DreamPromptItem[]
  changedChars: number
  neighborChars: number
  compactNeighborCount: number
}

// 统一约束增量整理变更项与邻居的总输入字符预算；邻居放不下完整摘录时优先退为概要或紧凑摘录
export function packStandardDreamPromptItems(
  changedRows: readonly PromptSourceRow[],
  neighborRows: readonly PromptSourceRow[],
  budgets: {
    neighborBudget?: number | undefined
    totalBudget?: number | undefined
  } = {},
): PackedStandardDreamItems {
  const neighborBudget = budgets.neighborBudget ?? STANDARD_NEIGHBOR_CHAR_BUDGET
  const totalBudget = budgets.totalBudget ?? STANDARD_TOTAL_CHAR_BUDGET

  const promptChanged = changedRows.map((row) => toPromptItem(row))
  const changedChars = promptChanged.reduce((sum, item) => sum + estimatePromptItemChars(item), 0)
  const remainingForNeighbors = Math.min(neighborBudget, Math.max(0, totalBudget - changedChars))

  const promptNeighbors: DreamPromptItem[] = []
  let neighborChars = 0
  let compactNeighborCount = 0

  for (const row of neighborRows) {
    const remaining = remainingForNeighbors - neighborChars
    if (remaining < 120) break

    const fullItem = toPromptItem(row)
    const fullSize = estimatePromptItemChars(fullItem)
    if (fullSize <= remaining) {
      promptNeighbors.push(fullItem)
      neighborChars += fullSize
      continue
    }

    const compactItem = toCompactNeighborPromptItem(row)
    const compactSize = estimatePromptItemChars(compactItem)
    if (compactSize <= remaining) {
      promptNeighbors.push(compactItem)
      neighborChars += compactSize
      compactNeighborCount++
    }
  }

  return {
    promptChanged,
    promptNeighbors,
    changedChars,
    neighborChars,
    compactNeighborCount,
  }
}

export function buildStandardDreamMessages(
  promptChanged: readonly DreamPromptItem[],
  promptNeighbors: readonly DreamPromptItem[],
): ChatMessage[] {
  const base = buildDreamMessages(promptChanged, promptNeighbors)
  const hint = `## 输出篇幅要求\n单次调用最多输出 ${STANDARD_MAX_SUGGESTIONS_PER_CALL} 条最核心、最高价值的建议（优先处理重复合并与明显事实更新），其余次要调整留待后续批次。`
  const lastIdx = base.length - 1
  if (lastIdx >= 0 && base[lastIdx]!.role === 'user') {
    return [
      ...base.slice(0, lastIdx),
      { role: 'user', content: `${base[lastIdx]!.content}\n\n${hint}` },
    ]
  }
  return [...base, { role: 'user', content: hint }]
}

function isSplittableBatchError(err: unknown): boolean {
  return (
    err instanceof ModelClientError &&
    (err.category === 'length_limit' || err.category === 'context_length')
  )
}

// 批量调用命中输出截断或上下文超限时自动二分递归重试，将失败隔离到单条
export async function executeStandardBatchWithSplit<T>(
  batch: readonly T[],
  runSubBatch: (subBatch: readonly T[]) => Promise<void>,
  options: {
    guard: Pick<BatchResilienceGuard, 'isAborted' | 'waitIfCooling' | 'recordFailure'>
    signal?: AbortSignal | undefined
    onSplit?: ((left: readonly T[], right: readonly T[], err: ModelClientError) => void) | undefined
    onFailure: (subBatch: readonly T[], err: unknown) => void
  },
): Promise<void> {
  const runNode = async (subBatch: readonly T[]): Promise<void> => {
    if (!subBatch.length || options.signal?.aborted || options.guard.isAborted) return
    try {
      await options.guard.waitIfCooling(options.signal)
    } catch {
      return
    }
    if (options.signal?.aborted || options.guard.isAborted) return

    try {
      await runSubBatch(subBatch)
    } catch (err) {
      if (options.signal?.aborted) return
      if (isSplittableBatchError(err) && subBatch.length > 1) {
        const mid = Math.ceil(subBatch.length / 2)
        const left = subBatch.slice(0, mid)
        const right = subBatch.slice(mid)
        options.onSplit?.(left, right, err as ModelClientError)
        await runNode(left)
        if (options.signal?.aborted || options.guard.isAborted) return
        await runNode(right)
        return
      }
      options.guard.recordFailure(err)
      options.onFailure(subBatch, err)
    }
  }

  await runNode(batch)
}

async function findLinkedNeighbors(
  db: Db,
  seedRows: readonly EntryRow[],
  excludeIds: readonly string[],
): Promise<EntryRow[]> {
  if (!seedRows.length) return []
  const seedIds = seedRows.map((r) => r.id)
  const seedShorts = seedRows.map((r) => r.shortId)
  const edges = await db
    .select({
      sourceEntryId: entryLinks.sourceEntryId,
      targetShortId: entryLinks.targetShortId,
    })
    .from(entryLinks)
    .where(
      or(inArray(entryLinks.sourceEntryId, seedIds), inArray(entryLinks.targetShortId, seedShorts)),
    )
    .limit(40)

  const excludeSet = new Set(excludeIds)
  const targetShorts = [...new Set(edges.map((e) => e.targetShortId))]
  const sourceIds = [...new Set(edges.map((e) => e.sourceEntryId))].filter(
    (id) => !excludeSet.has(id),
  )
  if (!targetShorts.length && !sourceIds.length) return []

  return db
    .select()
    .from(entries)
    .where(
      and(
        isNull(entries.deletedAt),
        stillValidSql(),
        eq(entries.kind, 'entry'),
        excludeIds.length ? notInArray(entries.id, [...excludeIds]) : undefined,
        or(
          targetShorts.length ? inArray(entries.shortId, targetShorts) : undefined,
          sourceIds.length ? inArray(entries.id, sourceIds) : undefined,
        ),
      ),
    )
    .orderBy(desc(entries.updatedAt))
    .limit(MAX_NEIGHBORS_PER_CALL)
}

async function findRelevantNeighbors(
  db: Db,
  seedRows: readonly EntryRow[],
  excludeIds: readonly string[],
): Promise<EntryRow[]> {
  if (!seedRows.length) return []
  const linked = await findLinkedNeighbors(db, seedRows, excludeIds)
  const seen = new Set<string>([...excludeIds, ...linked.map((r) => r.id)])
  const targetTotal = Math.min(MAX_NEIGHBORS_PER_CALL, seedRows.length * NEIGHBORS_PER_ITEM)
  let remaining = targetTotal - linked.length
  if (remaining <= 0) return linked.slice(0, MAX_NEIGHBORS_PER_CALL)

  // 优先叠加已有 pgvector 余弦近邻（cos >= 0.72），补足语义近邻
  const vectorNeighbors: EntryRow[] = []
  const formalSeedIds = seedRows.filter((r) => r.kind === 'entry').map((r) => r.id)
  if (formalSeedIds.length) {
    const seedArray = sql`array[${sql.join(
      formalSeedIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`
    const vecRows = await db.execute<{ id: string }>(sql`
      select b.entry_id::text as id
      from entry_embeddings a
      join entry_embeddings b on a.model = b.model and a.entry_id <> b.entry_id
      join entries eb on eb.id = b.entry_id
       and eb.deleted_at is null
       and eb.kind = 'entry'
       and (eb.valid_to is null or eb.valid_to > statement_timestamp())
      where a.entry_id = any(${seedArray})
        and (1 - (a.embedding <=> b.embedding)) >= 0.72
      group by b.entry_id
      order by max(1 - (a.embedding <=> b.embedding)) desc
      limit ${remaining + seen.size}
    `)
    const vecIds = [...vecRows]
      .map((r) => r.id)
      .filter((id) => !seen.has(id))
      .slice(0, remaining)
    if (vecIds.length) {
      const fetched = await db.select().from(entries).where(inArray(entries.id, vecIds))
      const byId = new Map(fetched.map((r) => [r.id, r]))
      for (const id of vecIds) {
        const row = byId.get(id)
        if (!row) continue
        seen.add(row.id)
        vectorNeighbors.push(row)
      }
      remaining = targetTotal - linked.length - vectorNeighbors.length
    }
  }
  if (remaining <= 0) return [...linked, ...vectorNeighbors].slice(0, MAX_NEIGHBORS_PER_CALL)

  const queryText = seedRows
    .map((r) => `${r.title} ${r.topics.join(' ')} ${r.projects.join(' ')}`)
    .join(' ')
    .slice(0, 1000)
  const [lex] = await db.execute<{ terms: string[] }>(
    sql`select tsvector_to_array(to_tsvector('kioku_zh', ${queryText})) as terms`,
  )
  const terms = searchTerms(lex?.terms ?? []).slice(0, 24)
  if (!terms.length) return [...linked, ...vectorNeighbors].slice(0, MAX_NEIGHBORS_PER_CALL)

  const tsQuery = anyTermQuery(terms)
  const ftsNeighbors = await db
    .select()
    .from(entries)
    .where(
      and(
        isNull(entries.deletedAt),
        stillValidSql(),
        eq(entries.kind, 'entry'),
        seen.size ? notInArray(entries.id, [...seen]) : undefined,
        sql`${entries.fts} @@ ${tsQuery}::tsquery`,
      ),
    )
    .orderBy(desc(sql`ts_rank_cd(${entries.fts}, ${tsQuery}::tsquery)`), desc(entries.updatedAt))
    .limit(remaining)

  return [...linked, ...vectorNeighbors, ...ftsNeighbors].slice(0, MAX_NEIGHBORS_PER_CALL)
}

function isModeScheduleDue(
  schedule: { enabled: boolean; intervalHours: number; lastRunAt: string | null },
  now: Date,
): boolean {
  if (!schedule.enabled) return false
  if (!schedule.lastRunAt) return true
  const last = Date.parse(schedule.lastRunAt)
  if (Number.isNaN(last)) return true
  return now.getTime() - last >= schedule.intervalHours * 3600_000
}

export async function getDueScheduledDreamModes(db: Db, now = new Date()): Promise<DreamMode[]> {
  const state = await loadDreamState(db)
  const standard = state.schedules?.standard ?? {
    enabled: state.enabled,
    intervalHours: state.intervalHours,
    lastRunAt: state.lastRunAt,
  }
  const due: DreamMode[] = []
  if (isModeScheduleDue(standard, now)) due.push('standard')
  if (state.schedules?.crossMemory && isModeScheduleDue(state.schedules.crossMemory, now)) {
    due.push('cross_memory')
  }
  if (state.schedules?.tidy && isModeScheduleDue(state.schedules.tidy, now)) {
    due.push('tidy')
  }
  return due
}

export async function isDreamDue(db: Db, now = new Date()): Promise<boolean> {
  return (await getDueScheduledDreamModes(db, now)).length > 0
}

export interface DreamExecutionResult {
  mode: DreamMode
  outcome: DreamOutcome
  considered: number
  suggested: number
  error: string | null
  failedItems: DreamFailedItem[]
  retriedCount: number
  abortedReason: string | null
}

export interface RunDreamOptions {
  runId: string
  trigger: DreamTrigger
  mode?: DreamMode | undefined
  scope?: DreamScope | undefined
  limit?: number | undefined
  all?: boolean | undefined
  pinnedFirst?: boolean | undefined
  targetShortIds?: string[] | undefined
  concurrency?: number | undefined
  retryBaseMs?: number | undefined
  cooldownFallbackMs?: number | undefined
  signal?: AbortSignal | undefined
  onProgress?: ((progress: DreamProgress) => void) | undefined
}

interface TidyCandidateRow {
  id: string
  shortId: string
  kind: EntryRow['kind']
  title: string
  summary: string | null
  content: string
  disclosure: string | null
  isPinned: boolean
  bootMode: EntryRow['bootMode']
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
  topics: string[]
  version: number
  updatedAt: Date
}

interface TidyCandidateSelection {
  activeIds: Set<string>
  candidates: TidyCandidateRow[]
  tidyChecked: Record<string, number>
}

// 规范整理不直接调整常驻层级；忽略 pinned_oversized 避免仅因篇幅偏长反复排队
const TIDY_IGNORED_HYGIENE_CODES = new Set(['pinned_oversized'])

function isTidyCandidate(
  row: {
    id: string
    title: string
    summary: string | null
    content: string
    isPinned: boolean
    bootMode: EntryRow['bootMode']
    envs: readonly string[]
    realms: readonly string[]
    projects: readonly string[]
    runtimes: readonly string[]
    topics: readonly string[]
    version: number
  },
  tidyChecked: Readonly<Record<string, number>>,
  seenFingerprints: ReadonlySet<string>,
): boolean {
  if (row.content.length > TIDY_CONTENT_LIMIT) return false
  if (tidyChecked[row.id] === row.version) return false
  const fp = suggestionFingerprint('tidy', [row.id], [row.version])
  if (seenFingerprints.has(fp)) return false
  const warnings = lintEntryHygiene({
    title: row.title,
    content: row.content,
    summary: row.summary,
    isPinned: row.isPinned,
    bootMode: row.bootMode,
    envs: row.envs,
    realms: row.realms,
    projects: row.projects,
    runtimes: row.runtimes,
    topics: row.topics,
    isUpdate: false,
  }).filter((w) => !TIDY_IGNORED_HYGIENE_CODES.has(w.code))
  return (
    warnings.length > 0 || (!row.summary?.trim() && (row.isPinned || row.content.length >= 400))
  )
}

// 统一计算待规范存量候选：SQL 侧过滤超长正文且剔除 fts 列，与待处理页计数共享判定口径
async function selectTidyCandidates(
  db: Db,
  pinnedFirst = true,
  targetShortIds: readonly string[] | null = null,
): Promise<TidyCandidateSelection> {
  const [activeEntries, existingTidy, tidyChecked] = await Promise.all([
    db
      .select({
        id: entries.id,
        shortId: entries.shortId,
        kind: entries.kind,
        title: entries.title,
        summary: entries.summary,
        content: entries.content,
        disclosure: entries.disclosure,
        isPinned: entries.isPinned,
        bootMode: entries.bootMode,
        envs: entries.envs,
        realms: entries.realms,
        projects: entries.projects,
        runtimes: entries.runtimes,
        topics: entries.topics,
        version: entries.version,
        updatedAt: entries.updatedAt,
      })
      .from(entries)
      .where(
        and(
          isNull(entries.deletedAt),
          stillValidSql(),
          eq(entries.kind, 'entry'),
          sql`char_length(${entries.content}) <= ${TIDY_CONTENT_LIMIT}`,
          targetShortIds?.length ? inArray(entries.shortId, [...targetShortIds]) : undefined,
        ),
      )
      .orderBy(
        ...(pinnedFirst ? [desc(entries.isPinned)] : []),
        desc(entries.updatedAt),
        asc(entries.shortId),
      ),
    db
      .select({ fingerprint: dreamSuggestions.fingerprint })
      .from(dreamSuggestions)
      .where(eq(dreamSuggestions.kind, 'tidy')),
    loadTidyCheckedVersions(db),
  ])

  const seenFingerprints = new Set(existingTidy.map((r) => r.fingerprint))
  // 指定短 ID 重试时跳过静态正则门槛，仅避免重复生成同版本已有建议
  const candidates = targetShortIds?.length
    ? activeEntries.filter(
        (row) => !seenFingerprints.has(suggestionFingerprint('tidy', [row.id], [row.version])),
      )
    : activeEntries.filter((row) => isTidyCandidate(row, tidyChecked, seenFingerprints))

  return {
    activeIds: new Set(activeEntries.map((r) => r.id)),
    candidates,
    tidyChecked,
  }
}

// 待处理页轮询专用轻量计数：仅取判定卫生提醒与指纹所需的最小字段集合
async function countTidyPending(db: Db): Promise<number> {
  const [rows, existingTidy, tidyChecked] = await Promise.all([
    db
      .select({
        id: entries.id,
        title: entries.title,
        summary: entries.summary,
        content: entries.content,
        isPinned: entries.isPinned,
        bootMode: entries.bootMode,
        envs: entries.envs,
        realms: entries.realms,
        projects: entries.projects,
        runtimes: entries.runtimes,
        topics: entries.topics,
        version: entries.version,
      })
      .from(entries)
      .where(
        and(
          isNull(entries.deletedAt),
          stillValidSql(),
          eq(entries.kind, 'entry'),
          sql`char_length(${entries.content}) <= ${TIDY_CONTENT_LIMIT}`,
        ),
      ),
    db
      .select({ fingerprint: dreamSuggestions.fingerprint })
      .from(dreamSuggestions)
      .where(eq(dreamSuggestions.kind, 'tidy')),
    loadTidyCheckedVersions(db),
  ])
  const seenFingerprints = new Set(existingTidy.map((r) => r.fingerprint))
  let count = 0
  for (const row of rows) {
    if (isTidyCandidate(row, tidyChecked, seenFingerprints)) count++
  }
  return count
}

function formatRunFailures(
  total: number,
  failures: readonly { shortId: string; reason: string }[],
  partial: boolean,
  abortedReason: string | null,
): string {
  const abortPrefix = abortedReason ? `${abortedReason}；` : ''
  if (!failures.length) {
    return (abortedReason ?? '整理未完成').slice(0, 400)
  }
  const preview = failures
    .slice(0, 3)
    .map((f) => `${f.shortId}（${f.reason.slice(0, 60)}）`)
    .join('、')
  const suffix = failures.length > 3 ? ` 等 ${failures.length} 条` : ''
  if (partial) {
    return `${abortPrefix}本批 ${total} 条中 ${failures.length} 条失败：${preview}${suffix}`.slice(
      0,
      400,
    )
  }
  if (failures.length === 1) {
    return `${abortPrefix}${failures[0]!.shortId}：${failures[0]!.reason}`.slice(0, 400)
  }
  return `${abortPrefix}本批 ${failures.length} 条均失败：${preview}${suffix}`.slice(0, 400)
}

function buildTidyRepairHint(evaluated: {
  reason: string
  missingLinks?: string[] | undefined
  missingCreds?: string[] | undefined
}): string {
  const missing = [...(evaluated.missingLinks ?? []), ...(evaluated.missingCreds ?? [])]
  if (missing.length) {
    return `上次生成的正文遗漏了原文必须保留的引用标记：${missing.join('、')}。请完整保留所有双链与凭据占位符并重新输出单个合法 JSON 对象。`
  }
  return `上次输出解析失败（${evaluated.reason}）。请严格只输出单个符合要求的合法 JSON 对象，不要包含任何额外说明。`
}

// 统一后台整理：standard 扫描增量变动；tidy 并发规范单条结构；cross_memory 执行四阶段跨记忆查重、补双链与常驻巡检
export async function runDream(
  db: Db,
  masterKey: MasterKey | null,
  options: RunDreamOptions,
): Promise<DreamExecutionResult> {
  const runMode: DreamMode =
    options.mode === 'tidy' || options.mode === 'cross_memory' ? options.mode : 'standard'
  const targetShortIds = options.targetShortIds?.length
    ? [...new Set(options.targetShortIds.map(normalizeShortId))]
    : null

  const finish = async (result: DreamExecutionResult): Promise<DreamExecutionResult> => {
    const summary: DreamRunSummary = {
      id: options.runId,
      trigger: options.trigger,
      mode: result.mode,
      outcome: result.outcome,
      considered: result.considered,
      suggested: result.suggested,
      error: result.error,
      ...(result.failedItems.length ? { failedItems: result.failedItems } : {}),
      ...(result.retriedCount > 0 ? { retriedCount: result.retriedCount } : {}),
      ...(result.abortedReason ? { abortedReason: result.abortedReason } : {}),
      createdAt: new Date().toISOString(),
    }
    await recordDreamRun(db, summary)
    return result
  }

  let totalConsidered = 0
  let totalSuggested = 0
  let totalSucceeded = 0
  let retriedCount = 0
  const failedItems: DreamFailedItem[] = []
  const failedShortSet = new Set<string>()
  const guard = new BatchResilienceGuard(options.cooldownFallbackMs)
  const resolveAbortedReason = (): string | null =>
    guard.abortedReason ?? (options.signal?.aborted ? '任务已中止' : null)

  try {
    const conn = await loadResolvedModel(db, masterKey, CHAT_LLM_SETTING_KEY)
    if (!conn) {
      return finish({
        mode: runMode,
        outcome: 'skipped',
        considered: 0,
        suggested: 0,
        error: '未配置对话模型',
        failedItems: [],
        retriedCount: 0,
        abortedReason: null,
      })
    }

    if (runMode === 'cross_memory') {
      const funnel = await runCrossMemoryFunnel(db, conn, {
        scope: options.scope,
        targetShortIds: targetShortIds ?? undefined,
        retryBaseMs: options.retryBaseMs,
        cooldownFallbackMs: options.cooldownFallbackMs,
        signal: options.signal,
        onProgress: options.onProgress,
      })
      return finish({
        mode: 'cross_memory',
        ...funnel.result,
      })
    }

    if (runMode === 'tidy') {
      const batchLimit = Math.min(
        Math.max(options.limit ?? DEFAULT_TIDY_BATCH_LIMIT, 1),
        MAX_TIDY_BATCH_LIMIT,
      )
      const pinnedFirst = options.pinnedFirst !== false
      const selection = await selectTidyCandidates(db, pinnedFirst, targetShortIds)
      const selected =
        options.all || targetShortIds
          ? selection.candidates
          : selection.candidates.slice(0, batchLimit)

      if (!selected.length) {
        return finish({
          mode: 'tidy',
          outcome: 'skipped',
          considered: 0,
          suggested: 0,
          error: null,
          failedItems: [],
          retriedCount: 0,
          abortedReason: null,
        })
      }

      const tidyChecked = selection.tidyChecked
      let tidyCheckedDirty = false
      let processed = 0
      let succeededCount = 0
      const failures: { shortId: string; reason: string }[] = []

      const emitProgress = () => {
        options.onProgress?.({
          mode: 'tidy',
          processed,
          total: selected.length,
          suggested: totalSuggested,
          failed: failures.length,
        })
      }
      emitProgress()

      const concurrency = Math.min(
        Math.max(options.concurrency ?? TIDY_CONCURRENCY, 1),
        selected.length,
      )
      let cursor = 0

      try {
        const worker = async (workerIndex: number) => {
          while (cursor < selected.length && !options.signal?.aborted && !guard.isAborted) {
            // 任一 worker 触发 429 后降并发为 1，由 0 号 worker 接管剩余队列
            if (workerIndex > 0 && guard.isThrottled) break
            try {
              await guard.waitIfCooling(options.signal)
            } catch {
              break
            }
            if (options.signal?.aborted || guard.isAborted) break
            if (workerIndex > 0 && guard.isThrottled) break
            if (cursor >= selected.length) break

            const row = selected[cursor++]!
            totalConsidered++
            try {
              const promptItem = toPromptItem(row, TIDY_CONTENT_LIMIT)
              const tidyMessages = buildTidyMessages(promptItem)
              const tidyMaxTokens = computeDynamicOutputTokens(promptItem.content.length, {
                min: TIDY_OUTPUT_TOKENS_MIN,
                max: TIDY_OUTPUT_TOKENS_MAX,
                overhead: 2_000,
              })
              const res = await chatComplete(conn, tidyMessages, {
                temperature: 0.1,
                jsonMode: true,
                maxTokens: tidyMaxTokens,
                timeoutMs: TIDY_CHAT_TIMEOUT_MS,
                stream: true,
                taskKind: 'organize',
                maxRetries: DREAM_HTTP_MAX_RETRIES,
                ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
                onRetry: ({ error }) => {
                  retriedCount++
                  if (error.category === 'rate_limit') guard.recordRateLimit(error)
                },
              })
              guard.recordSuccess()

              let evaluated = evaluateTidyResponse(res.content, promptItem)
              if (evaluated.status === 'invalid' && !options.signal?.aborted && !guard.isAborted) {
                await guard.waitIfCooling(options.signal)
                if (!options.signal?.aborted && !guard.isAborted) {
                  retriedCount++
                  const repairMessages = buildSemanticRepairMessages(
                    tidyMessages,
                    buildTidyRepairHint(evaluated),
                  )
                  const repairedRes = await chatComplete(conn, repairMessages, {
                    temperature: 0,
                    jsonMode: true,
                    maxTokens: tidyMaxTokens,
                    timeoutMs: TIDY_CHAT_TIMEOUT_MS,
                    stream: true,
                    taskKind: 'organize',
                    maxRetries: 0,
                    ...(options.signal ? { signal: options.signal } : {}),
                  })
                  guard.recordSuccess()
                  evaluated = evaluateTidyResponse(repairedRes.content, promptItem)
                }
              }

              if (evaluated.status === 'not_needed') {
                tidyChecked[row.id] = row.version
                tidyCheckedDirty = true
                succeededCount++
                totalSucceeded++
              } else if (evaluated.status === 'invalid') {
                failures.push({ shortId: row.shortId, reason: evaluated.reason })
                appendFailedItem(failedItems, failedShortSet, {
                  shortId: row.shortId,
                  title: row.title,
                  kind: 'tidy',
                  reason: evaluated.reason,
                })
              } else {
                const prop = evaluated.proposal
                const versions = [row.version]
                const fingerprint = suggestionFingerprint('tidy', [row.id], versions)
                const inserted = await db
                  .insert(dreamSuggestions)
                  .values({
                    kind: 'tidy',
                    entryIds: prop.entryIds,
                    entryVersions: versions,
                    keepId: null,
                    proposedTitle: prop.proposedTitle,
                    proposedSummary: prop.proposedSummary,
                    proposedContent: prop.proposedContent,
                    proposedDisclosure: prop.proposedDisclosure,
                    proposedChangeSummary: prop.proposedChangeSummary,
                    archivedNotes: prop.archivedNotes,
                    proposedTopics: prop.proposedTopics,
                    proposedEnvs: prop.proposedEnvs,
                    proposedRealms: prop.proposedRealms,
                    proposedProjects: prop.proposedProjects,
                    proposedRuntimes: prop.proposedRuntimes,
                    reason: prop.reason,
                    fingerprint,
                    status: 'pending',
                  })
                  .onConflictDoNothing()
                  .returning({ id: dreamSuggestions.id })
                if (inserted.length) totalSuggested++
                succeededCount++
                totalSucceeded++
              }
            } catch (err) {
              if (options.signal?.aborted) {
                totalConsidered = Math.max(0, totalConsidered - 1)
                break
              }
              guard.recordFailure(err)
              const reason = err instanceof Error ? err.message : String(err)
              failures.push({ shortId: row.shortId, reason })
              appendFailedItem(failedItems, failedShortSet, {
                shortId: row.shortId,
                title: row.title,
                kind: 'tidy',
                reason,
              })
            } finally {
              if (!options.signal?.aborted) {
                processed++
                emitProgress()
              }
            }
          }
        }

        await Promise.all(Array.from({ length: concurrency }, (_, idx) => worker(idx)))
      } finally {
        if (tidyCheckedDirty) {
          // 指定目标重试模式下只加载了部分词条，不裁剪其他已有已检版本记录
          if (targetShortIds) {
            await saveTidyCheckedVersions(db, tidyChecked)
          } else {
            const pruned: Record<string, number> = {}
            for (const [id, ver] of Object.entries(tidyChecked)) {
              if (selection.activeIds.has(id)) pruned[id] = ver
            }
            await saveTidyCheckedVersions(db, pruned)
          }
        }
      }

      if (options.signal?.aborted && !guard.isAborted) {
        return finish({
          mode: 'tidy',
          outcome: 'cancelled',
          considered: totalConsidered,
          suggested: totalSuggested,
          error: null,
          failedItems,
          retriedCount,
          abortedReason: '已手动取消',
        })
      }

      const abortedReason = resolveAbortedReason()
      if (failures.length === 0 && !abortedReason) {
        return finish({
          mode: 'tidy',
          outcome: 'ok',
          considered: totalConsidered,
          suggested: totalSuggested,
          error: null,
          failedItems: [],
          retriedCount,
          abortedReason: null,
        })
      }

      const partial = succeededCount > 0
      return finish({
        mode: 'tidy',
        outcome: partial ? 'partial' : 'failed',
        considered: totalConsidered,
        suggested: totalSuggested,
        error: formatRunFailures(totalConsidered, failures, partial, abortedReason),
        failedItems,
        retriedCount,
        abortedReason,
      })
    }

    const baseStandardFilter = targetShortIds?.length
      ? and(
          isNull(entries.deletedAt),
          stillValidSql(),
          inArray(entries.shortId, [...targetShortIds]),
        )
      : and(
          isNull(entries.deletedAt),
          stillValidSql(),
          gt(entries.version, entries.dreamCheckedVersion),
        )

    const maxStandardCalls = targetShortIds?.length
      ? Math.min(20, Math.max(MAX_CALLS_PER_RUN, Math.ceil(targetShortIds.length / 5)))
      : MAX_CALLS_PER_RUN

    const [uncheckedMeta] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(entries)
      .where(baseStandardFilter)
    const plannedStandardTotal = Math.min(
      uncheckedMeta?.total ?? 0,
      maxStandardCalls * CHANGED_PER_CALL,
    )

    const attemptedIds = new Set<string>()
    let succeededBatches = 0
    let failedCount = 0
    const standardFailures: { shortId: string; reason: string }[] = []

    for (
      let call = 0;
      call < maxStandardCalls && !options.signal?.aborted && !guard.isAborted;
      call++
    ) {
      try {
        await guard.waitIfCooling(options.signal)
      } catch {
        break
      }
      if (options.signal?.aborted || guard.isAborted) break

      const unchecked = await db
        .select()
        .from(entries)
        .where(
          and(
            baseStandardFilter,
            attemptedIds.size ? notInArray(entries.id, [...attemptedIds]) : undefined,
          ),
        )
        .orderBy(asc(entries.updatedAt), asc(entries.id))
        .limit(CHANGED_PER_CALL)

      if (!unchecked.length) break

      const batch: EntryRow[] = []
      let usedChars = 0
      for (const row of unchecked) {
        const size =
          Math.min(row.content.length, ITEM_CONTENT_LIMIT) +
          row.title.length +
          (row.summary?.length ?? 0) +
          (row.disclosure?.length ?? 0) +
          120
        if (usedChars + size > STANDARD_CHANGED_CHAR_BUDGET && batch.length > 0) break
        batch.push(row)
        usedChars += size
      }
      for (const row of batch) attemptedIds.add(row.id)

      options.onProgress?.({
        mode: 'standard',
        processed: totalConsidered,
        total: Math.max(plannedStandardTotal, totalConsidered + batch.length),
        suggested: totalSuggested,
        failed: failedCount,
      })

      await executeStandardBatchWithSplit(
        batch,
        async (subBatch) => {
          const neighbors = await findRelevantNeighbors(
            db,
            subBatch,
            subBatch.map((r) => r.id),
          )
          const packed = packStandardDreamPromptItems(subBatch, neighbors)
          const catalog = new Map<string, DreamPromptItem>()
          const rowById = new Map<string, EntryRow>()
          for (const row of [...subBatch, ...neighbors]) rowById.set(row.id, row)
          for (const item of [...packed.promptChanged, ...packed.promptNeighbors]) {
            catalog.set(item.shortId, item)
          }

          const dreamMessages = buildStandardDreamMessages(
            packed.promptChanged,
            packed.promptNeighbors,
          )
          const batchMaxTokens = computeDynamicOutputTokens(packed.changedChars, {
            min: STANDARD_OUTPUT_TOKENS_MIN,
            max: STANDARD_OUTPUT_TOKENS_MAX,
            overhead: 2_000,
          })

          const res = await chatComplete(conn, dreamMessages, {
            temperature: 0.2,
            jsonMode: true,
            maxTokens: batchMaxTokens,
            timeoutMs: STANDARD_DREAM_TIMEOUT_MS,
            stream: true,
            taskKind: 'organize',
            maxRetries: DREAM_HTTP_MAX_RETRIES,
            ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            onRetry: ({ error }) => {
              retriedCount++
              if (error.category === 'rate_limit') guard.recordRateLimit(error)
            },
          })
          guard.recordSuccess()

          let evaluated = evaluateDreamResponse(res.content, catalog)
          if (evaluated.status === 'invalid' && !options.signal?.aborted && !guard.isAborted) {
            await guard.waitIfCooling(options.signal)
            if (!options.signal?.aborted && !guard.isAborted) {
              retriedCount++
              const repairMessages = buildSemanticRepairMessages(
                dreamMessages,
                `上次输出解析失败（${evaluated.reason}）。请严格只输出单个合法 JSON 对象：{"suggestions":[...]}，没有建议时输出 {"suggestions":[]}。`,
              )
              const repairedRes = await chatComplete(conn, repairMessages, {
                temperature: 0,
                jsonMode: true,
                maxTokens: batchMaxTokens,
                timeoutMs: STANDARD_DREAM_TIMEOUT_MS,
                stream: true,
                taskKind: 'organize',
                maxRetries: 0,
                ...(options.signal ? { signal: options.signal } : {}),
              })
              guard.recordSuccess()
              evaluated = evaluateDreamResponse(repairedRes.content, catalog)
            }
          }

          // 解析仍失败时记入失败明细且绝不推进 dreamCheckedVersion，防止静默跳过
          if (evaluated.status === 'invalid') {
            for (const row of subBatch) {
              standardFailures.push({ shortId: row.shortId, reason: evaluated.reason })
              appendFailedItem(failedItems, failedShortSet, {
                shortId: row.shortId,
                title: row.title,
                kind: 'standard',
                reason: evaluated.reason,
              })
            }
            failedCount += subBatch.length
            totalConsidered += subBatch.length
          } else {
            for (const prop of evaluated.proposals) {
              const insertedId = await insertDreamProposal(db, prop, rowById)
              if (insertedId) totalSuggested++
            }

            for (const row of subBatch) {
              await db
                .update(entries)
                .set({ dreamCheckedVersion: row.version })
                .where(and(eq(entries.id, row.id), eq(entries.version, row.version)))
            }
            succeededBatches++
            totalSucceeded += subBatch.length
            totalConsidered += subBatch.length
          }
        },
        {
          guard,
          signal: options.signal,
          onSplit: () => {
            retriedCount++
          },
          onFailure: (subBatch, err) => {
            const reason = err instanceof Error ? err.message : String(err)
            for (const row of subBatch) {
              standardFailures.push({ shortId: row.shortId, reason })
              appendFailedItem(failedItems, failedShortSet, {
                shortId: row.shortId,
                title: row.title,
                kind: 'standard',
                reason,
              })
            }
            failedCount += subBatch.length
            totalConsidered += subBatch.length
          },
        },
      )

      options.onProgress?.({
        mode: 'standard',
        processed: totalConsidered,
        total: Math.max(plannedStandardTotal, totalConsidered),
        suggested: totalSuggested,
        failed: failedCount,
      })

      if (unchecked.length < CHANGED_PER_CALL && batch.length === unchecked.length) break
    }

    if (options.signal?.aborted && !guard.isAborted) {
      return finish({
        mode: 'standard',
        outcome: 'cancelled',
        considered: totalConsidered,
        suggested: totalSuggested,
        error: null,
        failedItems,
        retriedCount,
        abortedReason: '已手动取消',
      })
    }

    const abortedReason = resolveAbortedReason()
    if (totalConsidered === 0 && failedItems.length === 0 && !abortedReason) {
      return finish({
        mode: 'standard',
        outcome: 'skipped',
        considered: 0,
        suggested: 0,
        error: null,
        failedItems: [],
        retriedCount,
        abortedReason: null,
      })
    }

    if (failedItems.length === 0 && !abortedReason) {
      return finish({
        mode: 'standard',
        outcome: 'ok',
        considered: totalConsidered,
        suggested: totalSuggested,
        error: null,
        failedItems: [],
        retriedCount,
        abortedReason: null,
      })
    }

    const partial = succeededBatches > 0
    return finish({
      mode: 'standard',
      outcome: partial ? 'partial' : 'failed',
      considered: totalConsidered,
      suggested: totalSuggested,
      error: formatRunFailures(totalConsidered, standardFailures, partial, abortedReason),
      failedItems,
      retriedCount,
      abortedReason,
    })
  } catch (err) {
    if (options.signal?.aborted && !guard.isAborted) {
      return finish({
        mode: runMode,
        outcome: 'cancelled',
        considered: totalConsidered,
        suggested: totalSuggested,
        error: null,
        failedItems,
        retriedCount,
        abortedReason: '已手动取消',
      })
    }
    const message = err instanceof Error ? err.message : String(err)
    const abortedReason = resolveAbortedReason()
    return finish({
      mode: runMode,
      outcome: totalSucceeded > 0 ? 'partial' : 'failed',
      considered: totalConsidered,
      suggested: totalSuggested,
      error: message.slice(0, 400),
      failedItems,
      retriedCount,
      abortedReason,
    })
  }
}

function toDreamEntrySnapshot(row: EntryRow): DreamEntrySnapshot {
  return {
    id: row.id,
    shortId: row.shortId,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    content: row.content,
    disclosure: row.disclosure,
    isPinned: row.isPinned,
    bootMode: row.bootMode,
    envs: row.envs,
    realms: row.realms,
    projects: row.projects,
    runtimes: row.runtimes,
    topics: row.topics,
    deviceKey: row.deviceKey?.trim() || null,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    lastChangeSummary: row.lastChangeSummary,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function hydrateDreamSuggestions(
  db: Db,
  rows: readonly (typeof dreamSuggestions.$inferSelect)[],
): Promise<DreamSuggestionView[]> {
  if (!rows.length) return []

  const allEntryIds = [...new Set(rows.flatMap((r) => r.entryIds))]
  const entryRows = allEntryIds.length
    ? await db.select().from(entries).where(inArray(entries.id, allEntryIds))
    : []
  const byId = new Map(entryRows.map((e) => [e.id, toDreamEntrySnapshot(e)]))

  // 统计每条合并建议中被删重词条在全库活跃记忆里的入链数，便于审核卡片提前展示自动重定向数量
  const deletedShortSet = new Set<string>()
  const mergeDeletedBySuggestion = new Map<
    string,
    { deletedShorts: string[]; mergedIds: Set<string> }
  >()
  for (const r of rows) {
    if (r.kind !== 'merge_duplicates') continue
    const keepId = r.keepId ?? r.entryIds[0]
    const mergedIds = new Set(r.entryIds)
    const deletedShorts: string[] = []
    for (const id of r.entryIds) {
      if (id === keepId) continue
      const snap = byId.get(id)
      if (snap) {
        deletedShorts.push(snap.shortId)
        deletedShortSet.add(snap.shortId)
      }
    }
    if (deletedShorts.length) {
      mergeDeletedBySuggestion.set(r.id, { deletedShorts, mergedIds })
    }
  }

  const backlinkSourcesByTarget = new Map<string, Set<string>>()
  if (deletedShortSet.size) {
    const incoming = await db
      .select({
        sourceEntryId: entryLinks.sourceEntryId,
        targetShortId: entryLinks.targetShortId,
      })
      .from(entryLinks)
      .innerJoin(entries, eq(entries.id, entryLinks.sourceEntryId))
      .where(
        and(
          inArray(entryLinks.targetShortId, [...deletedShortSet]),
          isNull(entries.deletedAt),
          eq(entries.kind, 'entry'),
        ),
      )
    for (const row of incoming) {
      let set = backlinkSourcesByTarget.get(row.targetShortId)
      if (!set) {
        set = new Set()
        backlinkSourcesByTarget.set(row.targetShortId, set)
      }
      set.add(row.sourceEntryId)
    }
  }

  return rows.map((r) => {
    let affectedBacklinkCount: number | undefined
    const mergeInfo = mergeDeletedBySuggestion.get(r.id)
    if (mergeInfo) {
      const affectedSources = new Set<string>()
      for (const sid of mergeInfo.deletedShorts) {
        for (const sourceId of backlinkSourcesByTarget.get(sid) ?? []) {
          if (!mergeInfo.mergedIds.has(sourceId)) affectedSources.add(sourceId)
        }
      }
      affectedBacklinkCount = affectedSources.size
    }

    return {
      id: r.id,
      kind: r.kind,
      entryIds: r.entryIds,
      entryVersions: r.entryVersions,
      keepId: r.keepId,
      entries: r.entryIds
        .map((id) => byId.get(id))
        .filter((x): x is DreamEntrySnapshot => x !== undefined),
      proposedTitle: r.proposedTitle,
      proposedSummary: r.proposedSummary,
      proposedContent: r.proposedContent,
      proposedDisclosure: r.proposedDisclosure,
      proposedChangeSummary: r.proposedChangeSummary,
      archivedNotes: r.archivedNotes,
      proposedTopics: r.proposedTopics,
      proposedEnvs: r.proposedEnvs,
      proposedRealms: r.proposedRealms,
      proposedProjects: r.proposedProjects,
      proposedRuntimes: r.proposedRuntimes,
      proposedLinks: r.proposedLinks,
      proposedBootMode: r.proposedBootMode,
      ...(affectedBacklinkCount !== undefined ? { affectedBacklinkCount } : {}),
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    }
  })
}

export async function loadInbox(
  db: Db,
  running = false,
  progress: DreamProgress | null = null,
  embeddingBackfill?: EmbeddingBackfillState,
): Promise<InboxResponse> {
  const [rows, dreamState, tidyPendingCount] = await Promise.all([
    db
      .select()
      .from(dreamSuggestions)
      .where(eq(dreamSuggestions.status, 'pending'))
      .orderBy(desc(dreamSuggestions.createdAt))
      .limit(INBOX_ITEMS_LIMIT),
    loadDreamState(db, running, progress),
    countTidyPending(db),
  ])

  const items = await hydrateDreamSuggestions(db, rows)

  return {
    items,
    pendingCount: items.length,
    tidyPendingCount,
    dreamState,
    ...(embeddingBackfill ? { embeddingBackfill } : {}),
  }
}
