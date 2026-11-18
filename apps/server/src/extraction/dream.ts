import { createHash } from 'node:crypto'

import {
  ENTRY_TITLE_MAX,
  normalizeWhen,
  TOPICS_MAX,
  TUNING_DEFAULTS,
  VARIANTS_MAX,
  whenSignature,
  type DreamRunEntry,
  type DreamRunList,
  type DreamSkipReason,
  type DreamSuggestionKind,
  type DreamTrigger,
  type VariantInput,
  type WhenCondition,
} from '@kioku/contracts'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'

import {
  looksLikePlaintextCredential,
  maskPlaintextCredentials,
  mentionsPlaceholder,
} from '../credential/placeholders'
import { loadOutboundRedactor } from '../credential/privacy'
import type { MasterKey } from '../crypto/keyring'
import { errorText, loggableError, withCircle, type Db, type Tx } from '../db/client'
import {
  circleMembers,
  circles,
  dreamMarks,
  dreamRuns,
  dreamSuggestions,
  entries,
  entryEmbeddings,
  entryRecallStats,
  entryVariants,
  subjects,
} from '../db/schema'
import { loadEmbeddingModels } from '../embedding/settings'
import { listVocabulary } from '../memory/facets'
import { momentSql, stillValid } from '../memory/filter'
import {
  DREAM_SCOPE_KEY,
  dreamScopeCondition,
  parseDreamScope,
  resolveDreamScopeOwners,
  type ParsedDreamScope,
} from '../memory/scopes'
import { resolveDreamScopes } from '../memory/suggestions'
import type { ResolvedChatProfile } from '../models/types'
import { anyTermQuery, clipChars, inlineText, oneLine, searchTerms } from '../recall/recall'
import { loadCircleSettings } from '../settings/advanced'
import { extractionUsage } from './budget'
import {
  DREAM_PARSE_ERROR,
  dreamMessages,
  parseDream,
  type DreamCandidate,
  type DreamPromptItem,
  type DreamPromptMode,
  type DreamPromptScope,
} from './dreamPrompt'
import {
  DISCLOSURE_CHARS,
  disclosureProblem,
  draftProblem,
  factProblem,
  mergedNodeProblem,
} from './dreamText'
import { profilesChatModel, type ChatModel } from './provider'
import { loadDreamConfig } from './settings'

// Dream：按记忆圈各作用域整理记忆，生成建议进待处理，成员确认后才写入。
// 机密（secret）词条从不传给模型；成员可通过 circle_members.dream_private 控制个人词条与本机摘要开关。

export const DREAM_MAX_CALLS = TUNING_DEFAULTS['dream.maxCalls']
export const DREAM_MAX_TOKENS = 60_000
export const DREAM_CHANGED_PER_CALL = 20
export const DREAM_EPISODE_EXPIRING_DAYS = 7

const NEIGHBORS_PER_CALL = 20
const INPUT_CHARS = 16_000
const NODE_CHARS = 1_500
const FACT_CHARS = 300
const NEIGHBORS_EACH = 3
const FACT_NEIGHBORS_EACH = 6
const EPISODE_NEIGHBORS_EACH = 4
const REASON_CHARS = 200
const PROMOTE_MIN_RECALLS = 3

const SHARED_FAILED = '共享范围出错，本次已停止（原因见出错的范围）'
export const DREAM_ERROR_WORDINGS: readonly (readonly [string, ...string[]])[] = [
  [DREAM_PARSE_ERROR],
  [SHARED_FAILED, '共享的范围出错，这次停下了（原因见出错的那个范围）'],
]
const plainDreamError = (stored: string) =>
  DREAM_ERROR_WORDINGS.find((wordings) => wordings.includes(stored))?.[0] ?? null
const HIDDEN_ERROR = '整理出错（原因仅实例管理员可见）'

type EntryRow = typeof entries.$inferSelect
type VariantRow = typeof entryVariants.$inferSelect

const isFact = (row: EntryRow) => row.kind === 'fact'

// 候选条件：未删除、有效期内、非 secret，且属于正式词条、联系人/群事实、talk 未确认摘要或本机摘要（未确认或 7 天内到期）
function candidateBase(at?: Date): SQL {
  const now = momentSql(at)
  const expiringWindow = sql`${entries.expiresAt} <= ${now} + make_interval(days => ${DREAM_EPISODE_EXPIRING_DAYS})`
  return and(
    isNull(entries.deletedAt),
    stillValid(at),
    ne(entries.sensitivity, 'secret'),
    or(
      eq(entries.kind, 'entry'),
      and(eq(entries.kind, 'fact'), isNull(entries.ownerAccountId)),
      and(
        eq(entries.kind, 'episode'),
        isNull(entries.ownerAccountId),
        eq(entries.provenance, 'untrusted'),
      ),
      and(
        eq(entries.kind, 'episode'),
        isNotNull(entries.ownerAccountId),
        isNotNull(entries.conversationId),
        or(
          eq(entries.provenance, 'untrusted'),
          and(ne(entries.provenance, 'untrusted'), isNotNull(entries.expiresAt), expiringWindow),
        ),
      ),
    ),
  )!
}

// 允许 Dream 整理其个人/本机作用域内容的成员：仍在圈中且开启 dreamPrivate
async function allowedOwners(db: Db | Tx, circleId: string, owner?: string): Promise<string[]> {
  const rows = await db
    .select({ id: circleMembers.accountId })
    .from(circleMembers)
    .where(
      and(
        eq(circleMembers.circleId, circleId),
        eq(circleMembers.dreamPrivate, true),
        owner ? eq(circleMembers.accountId, owner) : undefined,
      ),
    )
  return rows.map((m) => m.id)
}

async function lockedSwitch(tx: Tx, circleId: string, owner: string): Promise<boolean | null> {
  const [row] = await tx
    .select({ on: circleMembers.dreamPrivate })
    .from(circleMembers)
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, owner)))
    .for('share')
  return row ? row.on : null
}

function candidate(owners: readonly string[], at?: Date): SQL {
  return and(
    candidateBase(at),
    sql`(${entries.ownerAccountId} is null or ${entries.ownerAccountId} = any(${sql.param([...owners])}::uuid[]))`,
  )!
}

export interface DreamOutcome {
  outcome: 'done' | 'skipped' | 'failed'
  reason: DreamSkipReason | null
}

export interface DreamOptions {
  circleId: string
  runId: string
  trigger: DreamTrigger
  now?: Date
  modelFor?: (profiles: readonly ResolvedChatProfile[]) => ChatModel
  afterBatch?: (scope: string) => Promise<void>
}

type RunFields = Omit<
  typeof dreamRuns.$inferInsert,
  'id' | 'circleId' | 'runId' | 'trigger' | 'createdAt'
>

interface Progress {
  summarized: boolean
  scope: PendingScope | null
}

export async function dreamCircle(
  db: Db,
  masterKey: MasterKey | null,
  options: DreamOptions,
): Promise<DreamOutcome> {
  const progress: Progress = { summarized: false, scope: null }
  const [circle] = await db
    .select({ id: circles.id, kind: circles.kind, name: circles.name })
    .from(circles)
    .where(eq(circles.id, options.circleId))
  if (!circle) return { outcome: 'skipped', reason: null }
  try {
    return await dreamOnce(db, masterKey, options, progress)
  } catch (err) {
    const error = `整理出错：${errorText(err)}`
    const at = progress.scope
    if (progress.summarized && !at) {
      console.error('Dream 整理出错', loggableError(err))
      return { outcome: 'failed', reason: null }
    }
    try {
      await withCircle(db, options.circleId, (tx) =>
        recordRun(
          tx,
          options,
          progress.summarized && at
            ? { scope: at.key, ownerAccountId: at.owner, error }
            : { error },
        ),
      )
    } catch (recordErr) {
      console.error('Dream 整理出错', loggableError(err))
      console.error('Dream 的运行记录也写不进去', recordErr)
      throw err
    }
    return { outcome: 'failed', reason: null }
  }
}

async function dreamOnce(
  db: Db,
  masterKey: MasterKey | null,
  options: DreamOptions,
  progress: Progress,
): Promise<DreamOutcome> {
  const { circleId } = options
  const now = options.now ?? new Date()
  const record = (fields: RunFields) =>
    withCircle(db, circleId, (tx) => recordRun(tx, options, fields))
  const summarize = async (fields: RunFields) => {
    await record(fields)
    progress.summarized = true
  }
  const skip = async (reason: DreamSkipReason): Promise<DreamOutcome> => {
    await summarize({ skipped: reason })
    return { outcome: 'skipped', reason }
  }

  const profiles = await loadDreamConfig(db, masterKey)
  if (!profiles?.length) return skip('no-model')
  const model = (options.modelFor ?? profilesChatModel)(profiles)
  const overBudget = async () => {
    const usage = await extractionUsage(db, circleId)
    return usage.usedTokens >= usage.monthlyTokens
  }
  if (await overBudget()) return skip('budget')

  const settings = await loadCircleSettings(db, circleId)
  const maxCalls = settings.values['dream.maxCalls']
  const tuning = {
    maxSuggestions: settings.values['dream.maxSuggestions'],
    rules: settings.prompts.dreamRules,
  }

  const queue = await pendingScopes(db, circleId, now)
  if (!queue.length) return skip('idle')

  const activeModel = (await loadEmbeddingModels(db)).active?.model ?? null
  const redactForLlm = await loadOutboundRedactor(db, masterKey, circleId)
  let requested = 0

  const runSegment = async (
    scopes: PendingScope[],
    limit: { calls: number; tokens: number },
    stopOnFailure: boolean,
  ) => {
    const pending = [...scopes]
    let calls = 0
    let tokens = 0
    let failed = false
    let left = false
    while (pending.length && calls < limit.calls && tokens < limit.tokens) {
      const scope = pending[0]!
      progress.scope = scope
      if (requested > 0 && (await overBudget())) {
        await record({ scope: scope.key, ownerAccountId: scope.owner, skipped: 'budget' })
        break
      }
      pending.shift()
      const result = await dreamScope(db, model, options, scope, {
        activeModel,
        now,
        redactForLlm,
        ...tuning,
      })
      progress.scope = null
      if (!result) continue
      calls++
      requested++
      tokens += result.tokens
      if (result.failed) {
        failed = true
        if (stopOnFailure) break
        continue
      }
      if (result.again) pending.push(scope)
      else if (result.more) left = true
    }
    progress.scope = null
    return { calls, tokens, failed, more: pending.length > 0 || left }
  }

  // 共享作用域不扣除个人留量：先运行所有共享作用域，再使用剩余额度整理成员私有/本机作用域
  const sharedScopes = queue.filter((s) => s.owner === null)
  const ownedScopes = queue.filter((s) => s.owner !== null)

  const shared = await runSegment(sharedScopes, { calls: maxCalls, tokens: DREAM_MAX_TOKENS }, true)
  await summarize(
    shared.failed
      ? { error: SHARED_FAILED }
      : shared.calls
        ? { more: shared.more }
        : { skipped: 'idle' },
  )
  if (shared.failed) return { outcome: 'failed', reason: null }

  const owned = await runSegment(
    ownedScopes,
    {
      calls: maxCalls - shared.calls,
      tokens: Math.max(DREAM_MAX_TOKENS - shared.tokens, 0),
    },
    false,
  )
  if (owned.failed) return { outcome: 'failed', reason: null }
  if (!shared.calls && !owned.calls) return { outcome: 'skipped', reason: 'idle' }
  return { outcome: 'done', reason: null }
}

async function recordRun(tx: Tx, options: DreamOptions, fields: RunFields): Promise<void> {
  await tx.insert(dreamRuns).values({
    circleId: options.circleId,
    runId: options.runId,
    trigger: options.trigger,
    ...fields,
  })
}

interface PendingScope {
  key: string
  scope: ParsedDreamScope
  owner: string | null
}

const UNMARKED = sql`not exists (
  select 1 from ${dreamMarks}
  where ${dreamMarks.entryId} = ${entries.id} and ${dreamMarks.version} = ${entries.version})`

async function pendingScopes(db: Db, circleId: string, now: Date): Promise<PendingScope[]> {
  return withCircle(db, circleId, async (tx) => {
    const owners = await allowedOwners(tx, circleId)
    const ownerSet = new Set(owners)
    const rows = await tx.execute<{ scope: string; last_at: Date | null }>(sql`
      with pending as (
        select distinct ${DREAM_SCOPE_KEY} as scope from ${entries}
        where ${candidate(owners, now)} and ${UNMARKED} and ${DREAM_SCOPE_KEY} is not null
      ), last as (
        select ${dreamRuns.scope} as scope, max(${dreamRuns.createdAt}) as last_at from ${dreamRuns}
        where ${dreamRuns.scope} is not null and ${dreamRuns.skipped} is null group by ${dreamRuns.scope}
      )
      select pending.scope, last.last_at from pending
      left join last on last.scope = pending.scope
      order by last.last_at nulls first, pending.scope`)
    const ownerMap = await resolveDreamScopeOwners(
      tx,
      rows.map((r) => r.scope),
    )
    const list: (PendingScope & { lastAt: number })[] = []
    for (const r of rows) {
      const parsed = parseDreamScope(r.scope)
      if (!parsed) continue
      const owner = ownerMap.get(r.scope) ?? null
      if (owner !== null && !ownerSet.has(owner)) continue
      list.push({
        key: r.scope,
        scope: parsed,
        owner,
        lastAt: r.last_at ? new Date(r.last_at).getTime() : -1,
      })
    }
    list.sort((a, b) => {
      const aOwned = a.owner !== null ? 1 : 0
      const bOwned = b.owner !== null ? 1 : 0
      if (aOwned !== bOwned) return aOwned - bOwned
      if (a.lastAt !== b.lastAt) return a.lastAt - b.lastAt
      return a.key.localeCompare(b.key)
    })
    return list.map(({ key, scope, owner }) => ({ key, scope, owner }))
  })
}

interface PickedVariant {
  when: WhenCondition
  whenSignature: string
  content: string
}

interface Picked {
  row: EntryRow
  fresh: boolean
  truncated: boolean
  variants: PickedVariant[]
}

function clipPicked(row: EntryRow, vRows: readonly VariantRow[], fresh: boolean): Picked {
  const maxPerVariant = row.kind === 'entry' ? NODE_CHARS : FACT_CHARS
  let truncated = false
  const variants: PickedVariant[] = vRows.map((v) => {
    const raw = v.content ?? ''
    const chars = [...raw]
    if (chars.length > maxPerVariant) truncated = true
    return {
      when: normalizeWhen(v.when),
      whenSignature: v.whenSignature,
      content: chars.length > maxPerVariant ? chars.slice(0, maxPerVariant).join('') : raw,
    }
  })
  return {
    row,
    fresh,
    truncated,
    variants: variants.length ? variants : [{ when: {}, whenSignature: '{}', content: '' }],
  }
}

const totalCharsOf = (picked: Picked) =>
  picked.variants.reduce((acc, v) => acc + v.content.length, 0)

async function loadVariantsFor(
  tx: Tx,
  entryIds: readonly string[],
): Promise<Map<string, VariantRow[]>> {
  const map = new Map<string, VariantRow[]>()
  if (!entryIds.length) return map
  const rows = await tx
    .select()
    .from(entryVariants)
    .where(inArray(entryVariants.entryId, [...entryIds]))
    .orderBy(asc(entryVariants.sortOrder), asc(entryVariants.id))
  for (const v of rows) {
    const bucket = map.get(v.entryId) ?? []
    bucket.push(v)
    map.set(v.entryId, bucket)
  }
  return map
}

async function loadBatch(
  tx: Tx,
  pending: PendingScope,
  activeModel: string | null,
  owners: readonly string[],
  now: Date,
): Promise<{ changed: Picked[]; neighbors: Picked[]; more: boolean }> {
  const inScope = and(dreamScopeCondition(pending.scope), candidate(owners, now))!
  const candidateRows = await tx
    .select()
    .from(entries)
    .where(and(inScope, UNMARKED))
    .orderBy(asc(entries.updatedAt), asc(entries.id))
    .limit(DREAM_CHANGED_PER_CALL + 1)

  const changedSliced = candidateRows.slice(0, DREAM_CHANGED_PER_CALL)
  const changedVariantMap = await loadVariantsFor(
    tx,
    changedSliced.map((r) => r.id),
  )

  let used = 0
  const changed: Picked[] = []
  for (const row of changedSliced) {
    const item = clipPicked(row, changedVariantMap.get(row.id) ?? [], true)
    const chars = totalCharsOf(item)
    if (changed.length && used + chars > INPUT_CHARS) break
    used += chars
    changed.push(item)
  }

  const seen = new Set(changed.map((c) => c.row.id))
  const neighborRows: EntryRow[] = []
  const queueRow = (row: EntryRow) => {
    if (seen.has(row.id) || neighborRows.length >= NEIGHBORS_PER_CALL) return false
    seen.add(row.id)
    neighborRows.push(row)
    return true
  }

  if (pending.scope.kind === 'talk') {
    const subjectIds = [
      ...new Set(changed.filter((c) => isFact(c.row)).map((c) => c.row.subjectId!)),
    ]
    if (subjectIds.length) {
      const others = await tx
        .select()
        .from(entries)
        .where(
          and(
            inScope,
            eq(entries.kind, 'fact'),
            inArray(entries.subjectId, subjectIds),
            notInArray(entries.id, [...seen]),
          ),
        )
        .orderBy(desc(entries.updatedAt), asc(entries.id))
        .limit(NEIGHBORS_PER_CALL * FACT_NEIGHBORS_EACH)
      for (const subjectId of subjectIds) {
        for (const o of others
          .filter((r) => r.subjectId === subjectId)
          .slice(0, FACT_NEIGHBORS_EACH)) {
          queueRow(o)
        }
      }
    }
  } else if (pending.scope.kind === 'local_session') {
    const others = await tx
      .select()
      .from(entries)
      .where(and(inScope, notInArray(entries.id, [...seen])))
      .orderBy(desc(entries.updatedAt), asc(entries.id))
      .limit(EPISODE_NEIGHBORS_EACH)
    for (const o of others) queueRow(o)
  } else {
    if (activeModel) {
      await tx.execute(sql.raw('set local hnsw.ef_search = 200'))
      await tx.execute(sql.raw('set local hnsw.iterative_scan = relaxed_order'))
    }
    for (const c of changed) {
      if (neighborRows.length >= NEIGHBORS_PER_CALL) break
      const primaryText = c.variants.map((v) => v.content).join('\n')
      const found = await nearby(tx, inScope, c.row, primaryText, [...seen], activeModel)
      for (const row of found) {
        if (neighborRows.length >= NEIGHBORS_PER_CALL) break
        queueRow(row)
      }
    }
  }

  const neighborVariantMap = await loadVariantsFor(
    tx,
    neighborRows.map((r) => r.id),
  )
  const neighbors: Picked[] = []
  for (const row of neighborRows) {
    const item = clipPicked(row, neighborVariantMap.get(row.id) ?? [], false)
    const chars = totalCharsOf(item)
    if (used + chars > INPUT_CHARS) continue
    used += chars
    neighbors.push(item)
  }

  return { changed, neighbors, more: candidateRows.length > changed.length }
}

async function nearby(
  tx: Tx,
  inScope: SQL,
  row: EntryRow,
  textForFts: string,
  exclude: string[],
  activeModel: string | null,
): Promise<EntryRow[]> {
  if (activeModel) {
    const [own] = await tx
      .select({ vector: sql<string>`${entryEmbeddings.embedding}::text` })
      .from(entryEmbeddings)
      .where(and(eq(entryEmbeddings.entryId, row.id), eq(entryEmbeddings.model, activeModel)))
      .limit(1)
    if (own) {
      const found = await tx
        .select({ row: entries })
        .from(entryEmbeddings)
        .innerJoin(entries, eq(entries.id, entryEmbeddings.entryId))
        .where(
          and(
            eq(entryEmbeddings.model, activeModel),
            inScope,
            exclude.length ? notInArray(entries.id, exclude) : undefined,
          ),
        )
        .orderBy(sql`${entryEmbeddings.embedding} <=> ${own.vector}::vector`)
        .limit(NEIGHBORS_EACH * 3)
      const unique: EntryRow[] = []
      const seenIds = new Set<string>()
      for (const f of found) {
        if (seenIds.has(f.row.id)) continue
        seenIds.add(f.row.id)
        unique.push(f.row)
        if (unique.length >= NEIGHBORS_EACH) break
      }
      if (unique.length) return unique
    }
  }

  const [lexemes] = await tx.execute<{ terms: string[] }>(
    sql`select tsvector_to_array(to_tsvector('kioku_zh', ${textForFts})) as terms`,
  )
  const terms = searchTerms(lexemes?.terms ?? []).slice(0, 32)
  if (!terms.length) return []
  const query = sql`${anyTermQuery(terms)}::tsquery`
  return tx
    .select()
    .from(entries)
    .where(
      and(
        inScope,
        sql`exists (
          select 1 from ${entryVariants}
          where ${entryVariants.entryId} = ${entries.id} and ${entryVariants.fts} @@ ${query}
        )`,
        exclude.length ? notInArray(entries.id, exclude) : undefined,
      ),
    )
    .orderBy(
      desc(
        sql`(select max(ts_rank(${entryVariants.fts}, ${query})) from ${entryVariants} where ${entryVariants.entryId} = ${entries.id})`,
      ),
      asc(entries.id),
    )
    .limit(NEIGHBORS_EACH)
}

async function loadVocabSummary(tx: Tx, circleId: string): Promise<string | null> {
  const vocab = await listVocabulary(tx, circleId)
  const byDim = new Map<string, string[]>()
  for (const term of vocab.terms) {
    const bucket = byDim.get(term.dimensionKey) ?? []
    bucket.push(term.label !== term.slug ? `${term.slug}(${term.label})` : term.slug)
    byDim.set(term.dimensionKey, bucket)
  }
  const lines: string[] = []
  for (const dim of vocab.dimensions) {
    const terms = byDim.get(dim.key)
    if (terms?.length) lines.push(`- ${dim.key}（${dim.name}）：${terms.slice(0, 30).join(', ')}`)
    else if (!dim.builtin) lines.push(`- ${dim.key}（${dim.name}）`)
  }
  return lines.length ? lines.join('\n') : null
}

async function scopeTitle(
  tx: Tx,
  circleId: string,
  circleName: string,
  pending: PendingScope,
  vocabSummary: string | null,
): Promise<DreamPromptScope> {
  const resolved = (await resolveDreamScopes(tx, circleId, circleName, [pending.key]))(pending.key)
  const name = (value: string | null) => clipChars(inlineText(value ?? ''), 40, '…')
  switch (resolved.kind) {
    case 'circle':
      return {
        title: `记忆圈「${name(resolved.name)}」内的共享正式词条`,
        mode: 'entry',
        vocabSummary,
      }
    case 'personal':
      return {
        title: '一位成员个人圈中的习惯、偏好与私人正式词条',
        mode: 'entry',
        vocabSummary,
      }
    case 'talk': {
      const origin = resolved.origin
      const where =
        origin?.kind === 'group'
          ? `群「${name(origin.name)}」的聊天`
          : origin?.kind === 'direct'
            ? `和「${name(origin.name)}」的私聊`
            : '对话'
      return { title: `${where}里记下的事实与未确认会话摘要`, mode: 'talk' }
    }
    case 'local_session':
      return {
        title: `本机开发会话（${name(resolved.name)}）产生的会话摘要`,
        mode: 'local_session',
      }
  }
}

interface ScopeResult {
  tokens: number
  more: boolean
  again: boolean
  failed: boolean
}

async function dreamScope(
  db: Db,
  model: ChatModel,
  options: DreamOptions,
  pending: PendingScope,
  context: {
    activeModel: string | null
    now: Date
    maxSuggestions: number
    rules: readonly string[]
    redactForLlm: (text: string) => Promise<string>
  },
): Promise<ScopeResult | null> {
  const { circleId } = options
  const owner = pending.owner
  const { batch, prompt, names, recallCounts } = await withCircle(db, circleId, async (tx) => {
    const [circleRow] = await tx
      .select({ name: circles.name })
      .from(circles)
      .where(eq(circles.id, circleId))
      .limit(1)
    const owners = await allowedOwners(tx, circleId)
    const batch = await loadBatch(tx, pending, context.activeModel, owners, context.now)
    const pickedIds = [...batch.changed, ...batch.neighbors].map((p) => p.row.id)
    const subjectIds = [
      ...new Set(
        [...batch.changed, ...batch.neighbors].flatMap((p) =>
          p.row.subjectId ? [p.row.subjectId] : [],
        ),
      ),
    ]
    const [names, recallCounts, vocabSummary] = await Promise.all([
      subjectIds.length
        ? tx
            .select({ id: subjects.id, name: subjects.displayName })
            .from(subjects)
            .where(inArray(subjects.id, subjectIds))
        : Promise.resolve([]),
      loadRecallCounts(tx, pickedIds),
      pending.scope.kind === 'circle' || pending.scope.kind === 'personal'
        ? loadVocabSummary(tx, circleId)
        : Promise.resolve(null),
    ])
    const prompt = await scopeTitle(tx, circleId, circleRow?.name ?? '', pending, vocabSummary)
    return { batch, prompt, names, recallCounts }
  })

  if (!batch.changed.length) return null
  await options.afterBatch?.(pending.key)
  if (owner && !(await allowedOwners(db, circleId, owner)).length) return null

  const subjectName = new Map(names.map((n) => [n.id, n.name]))
  const picked = [...batch.changed, ...batch.neighbors]
  const byHandle = new Map(picked.map((p, i) => [`M${i + 1}`, p]))
  const expiringCutoffMs = context.now.getTime() + DREAM_EPISODE_EXPIRING_DAYS * 86_400_000

  const items: DreamPromptItem[] = await Promise.all(
    [...byHandle].map(async ([handle, p]) => {
      const recallCount = recallCounts.get(p.row.id) ?? 0
      const redactedVariants = await Promise.all(
        p.variants.map(async (v) => ({
          when: v.when,
          content: await context.redactForLlm(v.content),
        })),
      )
      const expiringSoon =
        p.row.kind === 'episode' &&
        p.row.expiresAt !== null &&
        p.row.expiresAt.getTime() <= expiringCutoffMs
      return {
        handle,
        fresh: p.fresh,
        kind: p.row.kind,
        shortId: p.row.shortId,
        title: p.row.title,
        topics: [...p.row.topics],
        subject: p.row.subjectId
          ? clipChars(oneLine(subjectName.get(p.row.subjectId) ?? ''), 40, '…') || null
          : null,
        trusted: p.row.provenance !== 'untrusted',
        visibility: prompt.mode === 'entry' ? p.row.sensitivity : null,
        ...(recallCount > 0 ? { recallCount } : {}),
        ...(p.row.kind === 'entry' ? { priority: p.row.priority } : {}),
        ...(expiringSoon ? { expiringSoon: true } : {}),
        updated: p.row.updatedAt.toISOString().slice(0, 10),
        truncated: p.truncated,
        variants: redactedVariants,
      }
    }),
  )

  const counts = { changed: batch.changed.length, considered: picked.length }
  const record = (tx: Tx, fields: RunFields) =>
    recordRun(tx, options, { scope: pending.key, ownerAccountId: owner, ...counts, ...fields })

  // 合并联系人时只改词条的 subjectId 与 originScope 而不加版本号：对照读到时的快照，变动的行不写标记，下次继续整理
  const mark = async (tx: Tx): Promise<number> => {
    const currentRows = await tx
      .select({ id: entries.id, subjectId: entries.subjectId, originScope: entries.originScope })
      .from(entries)
      .where(
        inArray(
          entries.id,
          batch.changed.map((c) => c.row.id),
        ),
      )
      .for('share', { skipLocked: true })
    const current = new Map(currentRows.map((r) => [r.id, r]))
    const stayed = batch.changed.filter(({ row }) => {
      const found = current.get(row.id)
      return (
        found !== undefined &&
        found.subjectId === row.subjectId &&
        found.originScope === row.originScope
      )
    })
    if (stayed.length) {
      await tx
        .insert(dreamMarks)
        .values(stayed.map((c) => ({ circleId, entryId: c.row.id, version: c.row.version })))
        .onConflictDoUpdate({
          target: dreamMarks.entryId,
          set: { version: sql`excluded.version` },
        })
    }
    return batch.changed.length - stayed.length
  }

  let completion
  try {
    completion = await model.complete(
      dreamMessages(prompt, items, context.now.toISOString().slice(0, 10), context.rules),
    )
  } catch (err) {
    await withCircle(db, circleId, (tx) =>
      record(tx, { model: model.model, error: (err as Error).message }),
    )
    return { tokens: 0, more: batch.more, again: false, failed: true }
  }

  const usage = {
    model: completion.model ?? model.model,
    promptTokens: completion.usage.promptTokens,
    completionTokens: completion.usage.completionTokens,
  }
  const tokens = usage.promptTokens + usage.completionTokens
  let candidates: (DreamCandidate | null)[] = []
  let unparsed: string | null = null
  try {
    candidates = parseDream(completion.content)
  } catch (err) {
    unparsed = (err as Error).message
  }

  let dropped = Math.max(0, candidates.length - context.maxSuggestions)
  const proposals = new Map<string, Proposal>()
  for (const candidate of candidates.slice(0, context.maxSuggestions)) {
    const proposal = validate(candidate, byHandle, prompt.mode, recallCounts)
    if (!proposal) dropped++
    else if (!proposals.has(proposal.fingerprint)) proposals.set(proposal.fingerprint, proposal)
  }
  const attempted = candidates.length - dropped
  let saved: boolean
  let held = 0
  try {
    saved = await withCircle(db, circleId, async (tx) => {
      if (owner) {
        const on = await lockedSwitch(tx, circleId, owner)
        if (on === null) return false
        if (!on) {
          await record(tx, { ...usage, skipped: 'opted-out' })
          return false
        }
      }
      if (unparsed) {
        held = await mark(tx)
        await record(tx, { ...usage, more: batch.more || held > 0, error: unparsed })
        return true
      }
      const inserted = proposals.size
        ? await tx
            .insert(dreamSuggestions)
            .values(
              [...proposals.values()].map((p) => ({
                circleId,
                scope: pending.key,
                ownerAccountId: owner,
                ...p,
              })),
            )
            .onConflictDoNothing({
              target: [dreamSuggestions.circleId, dreamSuggestions.fingerprint],
            })
            .returning({ id: dreamSuggestions.id })
        : []
      held = await mark(tx)
      await record(tx, {
        ...usage,
        suggested: inserted.length,
        known: attempted - inserted.length,
        dropped,
        more: batch.more || held > 0,
      })
      return true
    })
  } catch (err) {
    await withCircle(db, circleId, (tx) =>
      record(tx, { ...usage, error: `写入失败：${errorText(err)}` }),
    )
    return { tokens, more: batch.more, again: false, failed: true }
  }

  return {
    tokens,
    more: saved && (batch.more || held > 0),
    again: saved && batch.more && held === 0,
    failed: false,
  }
}

interface Proposal {
  kind: DreamSuggestionKind
  entryIds: string[]
  versions: number[]
  keepId: string | null
  title: string | null
  content: string | null
  variants: VariantInput[] | null
  when: WhenCondition | null
  topics: string[] | null
  disclosure: string | null
  verdict: 'confirm' | 'delete' | null
  targetPriority: number | null
  reason: string
  fingerprint: string
}

async function loadRecallCounts(tx: Tx, entryIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (!entryIds.length) return counts
  const stats = await tx
    .select({ entryId: entryRecallStats.entryId, count: entryRecallStats.count })
    .from(entryRecallStats)
    .where(inArray(entryRecallStats.entryId, [...entryIds]))
  for (const row of stats) {
    counts.set(row.entryId, (counts.get(row.entryId) ?? 0) + row.count)
  }
  return counts
}

export function suggestionFingerprint(
  kind: DreamSuggestionKind,
  list: readonly { id: string; version: number }[],
): string {
  const parts = list.map((m) => `${m.id}:${m.version}`).sort()
  return createHash('sha256')
    .update(`${kind}\n${parts.join('\n')}`)
    .digest('hex')
}

function cleanReason(reason: string): string | null {
  const text = maskPlaintextCredentials(oneLine(reason))
  if (!text || mentionsPlaceholder(text)) return null
  return clipChars(text, REASON_CHARS, '…')
}

function cleanTitle(title: string | null | undefined): string | null {
  const text = title ? oneLine(title).trim() : ''
  if (!text || [...text].length > ENTRY_TITLE_MAX) return null
  if (looksLikePlaintextCredential(text) || mentionsPlaceholder(text)) return null
  return text
}

function hasWhenKeys(when: WhenCondition): boolean {
  return Object.values(when).some((arr) => Array.isArray(arr) && arr.length > 0)
}

function validateVariantList(
  raw: readonly VariantInput[],
  sourceContents: readonly (string | null)[],
): VariantInput[] | null {
  if (!raw.length || raw.length > VARIANTS_MAX) return null
  const out: VariantInput[] = []
  const seenSig = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]!
    const when = normalizeWhen(item.when)
    const sig = whenSignature(when)
    if (seenSig.has(sig)) return null
    seenSig.add(sig)
    const content = item.content.trim()
    if (mergedNodeProblem(content, sourceContents)) return null
    out.push({ when, content, sortOrder: item.sortOrder ?? i })
  }
  return out
}

function validateDraft(
  candidate: Extract<DreamCandidate, { kind: 'distill' | 'distill_episode' }>,
) {
  const title = cleanTitle(candidate.title)
  const topicsRaw = candidate.topics
    ?.map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, TOPICS_MAX)
  const topics = topicsRaw?.length ? [...new Set(topicsRaw)] : null
  const rawDisclosure = candidate.disclosure
    ? clipChars(oneLine(candidate.disclosure), DISCLOSURE_CHARS)
    : ''
  const disclosure = rawDisclosure && !disclosureProblem(rawDisclosure) ? rawDisclosure : null
  const targetPriority = candidate.targetPriority ?? null

  if (candidate.variants?.length) {
    if (candidate.variants.length > VARIANTS_MAX) return null
    const variants: VariantInput[] = []
    const seenSig = new Set<string>()
    for (let i = 0; i < candidate.variants.length; i++) {
      const v = candidate.variants[i]!
      const when = normalizeWhen(v.when)
      const sig = whenSignature(when)
      if (seenSig.has(sig)) return null
      seenSig.add(sig)
      const content = v.content.trim()
      if (draftProblem(content)) return null
      variants.push({ when, content, sortOrder: v.sortOrder ?? i })
    }
    return {
      title,
      content: null,
      variants,
      when: null,
      topics,
      disclosure,
      targetPriority,
    }
  }

  const content = (candidate.content ?? '').trim()
  if (draftProblem(content)) return null
  const normWhen = candidate.when ? normalizeWhen(candidate.when) : {}
  return {
    title,
    content,
    variants: null,
    when: hasWhenKeys(normWhen) ? normWhen : null,
    topics,
    disclosure,
    targetPriority,
  }
}

function validate(
  candidate: DreamCandidate | null,
  byHandle: ReadonlyMap<string, Picked>,
  mode: DreamPromptMode,
  recallCounts: ReadonlyMap<string, number>,
): Proposal | null {
  if (!candidate) return null
  const picked: Picked[] = []
  for (const handle of candidate.entries) {
    const found = byHandle.get(handle.trim().toUpperCase())
    if (!found) return null
    if (!picked.includes(found)) picked.push(found)
  }
  if (!picked.length || !picked.some((p) => p.fresh)) return null
  const reason = cleanReason(candidate.reason)
  if (!reason) return null

  const rows = picked.map((p) => p.row)
  const sourceContents = picked.flatMap((p) => p.variants.map((v) => v.content))
  const proposal = (fields: Partial<Proposal>, ordered = rows): Proposal => ({
    kind: candidate.kind,
    entryIds: ordered.map((r) => r.id),
    versions: ordered.map((r) => r.version),
    keepId: null,
    title: null,
    content: null,
    variants: null,
    when: null,
    topics: null,
    disclosure: null,
    verdict: null,
    targetPriority: null,
    reason,
    fingerprint: suggestionFingerprint(candidate.kind, ordered),
    ...fields,
  })

  switch (candidate.kind) {
    case 'merge': {
      if (mode === 'local_session' || picked.length < 2 || picked.some((p) => p.truncated)) {
        return null
      }
      const keep = candidate.keep ? byHandle.get(candidate.keep.trim().toUpperCase()) : picked[0]
      if (!keep || !picked.includes(keep)) return null
      const ordered = [keep.row, ...rows.filter((r) => r !== keep.row)]
      if (
        new Set(rows.map((r) => r.sensitivity)).size !== 1 ||
        new Set(rows.map((r) => r.originScope)).size !== 1
      ) {
        return null
      }
      if (mode === 'talk') {
        if (!rows.every(isFact) || new Set(rows.map((r) => r.subjectId)).size !== 1) return null
        const content = oneLine(candidate.content)
        if (factProblem(content)) return null
        return proposal({ keepId: keep.row.id, content }, ordered)
      }
      if (!rows.every((r) => r.kind === 'entry') || picked.some((p) => p.variants.length !== 1)) {
        return null
      }
      const content = candidate.content.trim()
      if (mergedNodeProblem(content, sourceContents)) return null
      return proposal({ keepId: keep.row.id, content }, ordered)
    }

    case 'merge_variants': {
      if (mode !== 'entry' || picked.length < 2 || picked.some((p) => p.truncated)) return null
      if (!rows.every((r) => r.kind === 'entry')) return null
      const keep = candidate.keep ? byHandle.get(candidate.keep.trim().toUpperCase()) : picked[0]
      if (!keep || !picked.includes(keep)) return null
      if (
        new Set(rows.map((r) => r.sensitivity)).size !== 1 ||
        new Set(rows.map((r) => r.originScope)).size !== 1
      ) {
        return null
      }
      const ordered = [keep.row, ...rows.filter((r) => r !== keep.row)]
      const variants = validateVariantList(candidate.variants, sourceContents)
      if (!variants) return null
      return proposal({ keepId: keep.row.id, variants }, ordered)
    }

    case 'facet_tag': {
      if (mode !== 'entry' || picked.length !== 1) return null
      const target = picked[0]!
      if (target.row.kind !== 'entry' || target.variants.length !== 1) return null
      const when = normalizeWhen(candidate.when)
      if (!hasWhenKeys(when)) return null
      if (whenSignature(when) === target.variants[0]!.whenSignature) return null
      return proposal({ keepId: target.row.id, when })
    }

    case 'generalize': {
      if (mode !== 'entry' || picked.some((p) => p.truncated)) return null
      if (!rows.every((r) => r.kind === 'entry')) return null
      const keep = candidate.keep ? byHandle.get(candidate.keep.trim().toUpperCase()) : picked[0]
      if (!keep || !picked.includes(keep)) return null
      if (
        new Set(rows.map((r) => r.sensitivity)).size !== 1 ||
        new Set(rows.map((r) => r.originScope)).size !== 1
      ) {
        return null
      }
      const ordered = [keep.row, ...rows.filter((r) => r !== keep.row)]
      const variants = validateVariantList(candidate.variants, sourceContents)
      if (!variants) return null
      return proposal({ keepId: keep.row.id, variants }, ordered)
    }

    case 'distill': {
      if (mode !== 'talk' || picked.length < 2 || !rows.every(isFact)) return null
      const draft = validateDraft(candidate)
      if (!draft) return null
      return proposal(draft)
    }

    case 'distill_episode': {
      if (
        mode !== 'local_session' ||
        picked.length < 1 ||
        !rows.every((r) => r.kind === 'episode' && r.provenance !== 'untrusted')
      ) {
        return null
      }
      const draft = validateDraft(candidate)
      if (!draft) return null
      return proposal(draft)
    }

    case 'stale': {
      if (mode === 'local_session' || picked.length !== 1) return null
      if (mode === 'talk' ? !isFact(rows[0]!) : rows[0]!.kind !== 'entry') return null
      return proposal({})
    }

    case 'review': {
      if (mode === 'entry' || picked.length !== 1) return null
      const row = rows[0]!
      if (row.provenance !== 'untrusted' || (row.kind !== 'fact' && row.kind !== 'episode')) {
        return null
      }
      return proposal({ verdict: candidate.verdict })
    }

    case 'promote': {
      if (mode !== 'entry' || picked.length !== 1) return null
      const row = rows[0]!
      if (row.kind !== 'entry') return null
      if (row.priority <= candidate.targetPriority) return null
      if ((recallCounts.get(row.id) ?? 0) < PROMOTE_MIN_RECALLS) return null
      return proposal({ targetPriority: candidate.targetPriority })
    }
  }
}

// ---- 定时与运行记录 ----

export async function dreamsDue(db: Db, now = new Date()): Promise<string[]> {
  const today = sql`date_trunc('day', ${now.toISOString()}::timestamptz, 'UTC')`
  const due: string[] = []
  for (const { id } of await db.select({ id: circles.id }).from(circles)) {
    const [done] = await withCircle(db, id, (tx) =>
      tx
        .select({ id: dreamRuns.id })
        .from(dreamRuns)
        .where(and(eq(dreamRuns.trigger, 'scheduled'), sql`${dreamRuns.createdAt} >= ${today}`))
        .limit(1),
    )
    if (!done) due.push(id)
  }
  return due
}

const visibleRun = (accountId: string) =>
  or(isNull(dreamRuns.ownerAccountId), eq(dreamRuns.ownerAccountId, accountId))

export async function dreamRunOutcome(
  db: Db,
  circleId: string,
  runId: string,
  accountId: string,
): Promise<DreamOutcome | null> {
  const rows = await withCircle(db, circleId, (tx) =>
    tx
      .select({ scope: dreamRuns.scope, skipped: dreamRuns.skipped, error: dreamRuns.error })
      .from(dreamRuns)
      .where(and(eq(dreamRuns.runId, runId), visibleRun(accountId))),
  )
  if (!rows.some((r) => r.scope === null)) return null
  if (rows.some((r) => r.error && r.error !== DREAM_PARSE_ERROR)) {
    return { outcome: 'failed', reason: null }
  }
  if (rows.some((r) => !r.skipped)) return { outcome: 'done', reason: null }
  const reasons = rows.map((r) => r.skipped as DreamSkipReason)
  return { outcome: 'skipped', reason: reasons.find((r) => r !== 'idle') ?? 'idle' }
}

export async function dreamRunList(
  db: Db,
  circleId: string,
  viewer: { accountId: string; admin: boolean },
  limit = 10,
): Promise<DreamRunList> {
  return withCircle(db, circleId, async (tx) => {
    const [[circleRow], rows] = await Promise.all([
      tx.select({ name: circles.name }).from(circles).where(eq(circles.id, circleId)).limit(1),
      tx
        .select()
        .from(dreamRuns)
        .where(visibleRun(viewer.accountId))
        .orderBy(desc(dreamRuns.createdAt), desc(dreamRuns.id))
        .limit(limit * 12),
    ])
    const named = await resolveDreamScopes(
      tx,
      circleId,
      circleRow?.name ?? '',
      rows.flatMap((r) => (r.scope ? [r.scope] : [])),
    )
    const runs = new Map<string, DreamRunList['runs'][number]>()
    for (const row of rows) {
      let run = runs.get(row.runId)
      if (!run) {
        if (runs.size >= limit) continue
        run = {
          runId: row.runId,
          trigger: row.trigger as DreamTrigger,
          at: row.createdAt.toISOString(),
          entries: [],
        }
        runs.set(row.runId, run)
      }
      run.entries.unshift(entryOf(row, named, viewer.admin))
      run.at = row.createdAt.toISOString() < run.at ? row.createdAt.toISOString() : run.at
    }
    return { runs: [...runs.values()] }
  })
}

function entryOf(
  row: typeof dreamRuns.$inferSelect,
  named: (key: string) => DreamRunEntry['scope'],
  admin: boolean,
): DreamRunEntry {
  return {
    scope: row.scope ? named(row.scope) : null,
    model: row.model,
    tokens: row.promptTokens + row.completionTokens,
    changed: row.changed,
    considered: row.considered,
    suggested: row.suggested,
    known: row.known,
    dropped: row.dropped,
    more: row.more,
    skipped: (row.skipped as DreamSkipReason | null) ?? null,
    error: row.error
      ? (plainDreamError(row.error) ?? (admin ? row.error : HIDDEN_ERROR))
      : row.error,
  }
}
