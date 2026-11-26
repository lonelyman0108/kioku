import { createHash } from 'node:crypto'

import {
  lintEntryHygiene,
  type DreamEntrySnapshot,
  type DreamOutcome,
  type DreamRunSummary,
  type DreamSuggestionKind,
  type DreamSuggestionView,
  type DreamTrigger,
  type InboxResponse,
} from '@kioku/contracts'
import { and, asc, desc, eq, gt, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'

import { stillValidSql } from '../access/scope'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { dreamSuggestions, entries, entryLinks } from '../db/schema'
import { chatComplete } from '../models/client'
import {
  CHAT_LLM_SETTING_KEY,
  loadDreamState,
  loadResolvedModel,
  loadTidyCheckedVersions,
  recordDreamRun,
  saveTidyCheckedVersions,
} from '../models/store'
import { anyTermQuery, clipChars, searchTerms } from '../recall/recall'
import {
  buildDreamMessages,
  buildTidyMessages,
  evaluateTidyResponse,
  parseDreamProposals,
  type DreamPromptItem,
} from './dreamPrompt'

const MAX_CALLS_PER_RUN = 4
const CHANGED_PER_CALL = 20
const MAX_NEIGHBORS_PER_CALL = 15
const NEIGHBORS_PER_ITEM = 5
const INPUT_CHAR_BUDGET = 16_000
const ITEM_CONTENT_LIMIT = 1_500
const TIDY_CONTENT_LIMIT = 16_000
const DEFAULT_TIDY_BATCH_LIMIT = 8

type EntryRow = typeof entries.$inferSelect

function toPromptItem(row: EntryRow, contentLimit = ITEM_CONTENT_LIMIT): DreamPromptItem {
  const truncated = row.content.length > contentLimit
  return {
    id: row.id,
    shortId: row.shortId,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    content: truncated ? clipChars(row.content, contentLimit) : row.content,
    disclosure: row.disclosure,
    envs: row.envs,
    realms: row.realms,
    projects: row.projects,
    runtimes: row.runtimes,
    topics: row.topics,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    truncated,
  }
}

export function suggestionFingerprint(
  kind: DreamSuggestionKind,
  entryIds: readonly string[],
  entryVersions: readonly number[],
): string {
  const pairs = entryIds.map((id, i) => `${id}:${entryVersions[i]!}`).sort()
  return createHash('sha256')
    .update(`${kind}|${pairs.join(',')}`)
    .digest('hex')
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

async function findFtsNeighbors(
  db: Db,
  seedRows: readonly EntryRow[],
  excludeIds: readonly string[],
): Promise<EntryRow[]> {
  if (!seedRows.length) return []
  const linked = await findLinkedNeighbors(db, seedRows, excludeIds)
  const seen = new Set<string>([...excludeIds, ...linked.map((r) => r.id)])
  const remaining =
    Math.min(MAX_NEIGHBORS_PER_CALL, seedRows.length * NEIGHBORS_PER_ITEM) - linked.length
  if (remaining <= 0) return linked.slice(0, MAX_NEIGHBORS_PER_CALL)

  const queryText = seedRows
    .map((r) => `${r.title} ${r.topics.join(' ')} ${r.projects.join(' ')}`)
    .join(' ')
    .slice(0, 1000)
  const [lex] = await db.execute<{ terms: string[] }>(
    sql`select tsvector_to_array(to_tsvector('kioku_zh', ${queryText})) as terms`,
  )
  const terms = searchTerms(lex?.terms ?? []).slice(0, 24)
  if (!terms.length) return linked

  const ftsNeighbors = await db
    .select()
    .from(entries)
    .where(
      and(
        isNull(entries.deletedAt),
        stillValidSql(),
        eq(entries.kind, 'entry'),
        seen.size ? notInArray(entries.id, [...seen]) : undefined,
        sql`${entries.fts} @@ ${anyTermQuery(terms)}::tsquery`,
      ),
    )
    .orderBy(desc(entries.updatedAt))
    .limit(remaining)

  return [...linked, ...ftsNeighbors].slice(0, MAX_NEIGHBORS_PER_CALL)
}

export async function isDreamDue(db: Db, now = new Date()): Promise<boolean> {
  const state = await loadDreamState(db)
  if (!state.enabled) return false
  if (!state.lastRunAt) return true
  const last = Date.parse(state.lastRunAt)
  if (Number.isNaN(last)) return true
  return now.getTime() - last >= state.intervalHours * 3600_000
}

export interface DreamExecutionResult {
  outcome: DreamOutcome
  considered: number
  suggested: number
  error: string | null
}

export interface RunDreamOptions {
  runId: string
  trigger: DreamTrigger
  mode?: 'standard' | 'tidy' | undefined
  limit?: number | undefined
  pinnedFirst?: boolean | undefined
}

// 统一后台整理：standard 扫描增量变动并查重/核对双链矛盾；tidy 按完整正文分批规范标题、概要与历史流水
export async function runDream(
  db: Db,
  masterKey: MasterKey | null,
  options: RunDreamOptions,
): Promise<DreamExecutionResult> {
  const finish = async (result: DreamExecutionResult): Promise<DreamExecutionResult> => {
    const summary: DreamRunSummary = {
      id: options.runId,
      trigger: options.trigger,
      outcome: result.outcome,
      considered: result.considered,
      suggested: result.suggested,
      error: result.error,
      createdAt: new Date().toISOString(),
    }
    await recordDreamRun(db, summary)
    return result
  }

  const conn = await loadResolvedModel(db, masterKey, CHAT_LLM_SETTING_KEY)
  if (!conn) {
    return finish({
      outcome: 'skipped',
      considered: 0,
      suggested: 0,
      error: '未配置对话模型',
    })
  }

  let totalConsidered = 0
  let totalSuggested = 0

  try {
    if (options.mode === 'tidy') {
      const batchLimit = Math.min(Math.max(options.limit ?? DEFAULT_TIDY_BATCH_LIMIT, 1), 20)
      const pinnedFirst = options.pinnedFirst !== false

      const activeEntries = await db
        .select()
        .from(entries)
        .where(and(isNull(entries.deletedAt), stillValidSql(), eq(entries.kind, 'entry')))
        .orderBy(
          ...(pinnedFirst ? [desc(entries.isPinned)] : []),
          desc(entries.updatedAt),
          asc(entries.shortId),
        )

      const existingTidy = await db
        .select({ fingerprint: dreamSuggestions.fingerprint })
        .from(dreamSuggestions)
        .where(eq(dreamSuggestions.kind, 'tidy'))
      const seenFingerprints = new Set(existingTidy.map((r) => r.fingerprint))
      const tidyChecked = await loadTidyCheckedVersions(db)
      let tidyCheckedDirty = false

      const candidates = activeEntries
        .filter((row) => {
          if (row.content.length > TIDY_CONTENT_LIMIT) return false
          if (tidyChecked[row.id] === row.version) return false
          const fp = suggestionFingerprint('tidy', [row.id], [row.version])
          if (seenFingerprints.has(fp)) return false
          const warnings = lintEntryHygiene({
            title: row.title,
            content: row.content,
            summary: row.summary,
            isPinned: row.isPinned,
            isUpdate: false,
          })
          return (
            warnings.length > 0 ||
            (!row.summary?.trim() && (row.isPinned || row.content.length >= 400))
          )
        })
        .slice(0, batchLimit)

      for (const row of candidates) {
        totalConsidered++
        const promptItem = toPromptItem(row, TIDY_CONTENT_LIMIT)
        const res = await chatComplete(conn, buildTidyMessages(promptItem), {
          temperature: 0.1,
          jsonMode: true,
          maxTokens: 4_000,
        })
        const evaluated = evaluateTidyResponse(res.content, promptItem)
        if (evaluated.status === 'not_needed') {
          tidyChecked[row.id] = row.version
          tidyCheckedDirty = true
          continue
        }
        if (evaluated.status !== 'proposal') continue
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
      }

      if (tidyCheckedDirty) {
        const activeIds = new Set(activeEntries.map((r) => r.id))
        const pruned: Record<string, number> = {}
        for (const [id, ver] of Object.entries(tidyChecked)) {
          if (activeIds.has(id)) pruned[id] = ver
        }
        await saveTidyCheckedVersions(db, pruned)
      }

      return finish({
        outcome: totalConsidered === 0 ? 'skipped' : 'ok',
        considered: totalConsidered,
        suggested: totalSuggested,
        error: null,
      })
    }

    for (let call = 0; call < MAX_CALLS_PER_RUN; call++) {
      const unchecked = await db
        .select()
        .from(entries)
        .where(
          and(
            isNull(entries.deletedAt),
            stillValidSql(),
            gt(entries.version, entries.dreamCheckedVersion),
          ),
        )
        .orderBy(asc(entries.updatedAt), asc(entries.id))
        .limit(CHANGED_PER_CALL)

      if (!unchecked.length) break

      const batch: EntryRow[] = []
      let usedChars = 0
      for (const row of unchecked) {
        const size = Math.min(row.content.length, ITEM_CONTENT_LIMIT) + row.title.length + 120
        if (usedChars + size > INPUT_CHAR_BUDGET && batch.length > 0) break
        batch.push(row)
        usedChars += size
      }

      const neighbors = await findFtsNeighbors(
        db,
        batch,
        batch.map((r) => r.id),
      )

      const promptChanged = batch.map((r) => toPromptItem(r))
      const promptNeighbors = neighbors.map((r) => toPromptItem(r))
      const catalog = new Map<string, DreamPromptItem>()
      const rowById = new Map<string, EntryRow>()
      for (const row of [...batch, ...neighbors]) rowById.set(row.id, row)
      for (const item of [...promptChanged, ...promptNeighbors]) catalog.set(item.shortId, item)

      const res = await chatComplete(conn, buildDreamMessages(promptChanged, promptNeighbors), {
        temperature: 0.2,
        jsonMode: true,
        maxTokens: 2_000,
      })
      const proposals = parseDreamProposals(res.content, catalog)

      for (const prop of proposals) {
        const versions = prop.entryIds.map((id) => rowById.get(id)!.version)
        const fingerprint = suggestionFingerprint(prop.kind, prop.entryIds, versions)
        const inserted = await db
          .insert(dreamSuggestions)
          .values({
            kind: prop.kind,
            entryIds: prop.entryIds,
            entryVersions: versions,
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
            reason: prop.reason,
            fingerprint,
            status: 'pending',
          })
          .onConflictDoNothing()
          .returning({ id: dreamSuggestions.id })
        if (inserted.length) totalSuggested++
      }

      for (const row of batch) {
        await db
          .update(entries)
          .set({ dreamCheckedVersion: row.version })
          .where(and(eq(entries.id, row.id), eq(entries.version, row.version)))
      }
      totalConsidered += batch.length

      if (unchecked.length < CHANGED_PER_CALL) break
    }

    return finish({
      outcome: totalConsidered === 0 ? 'skipped' : 'ok',
      considered: totalConsidered,
      suggested: totalSuggested,
      error: null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return finish({
      outcome: 'failed',
      considered: totalConsidered,
      suggested: totalSuggested,
      error: message.slice(0, 400),
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
    envs: row.envs,
    realms: row.realms,
    projects: row.projects,
    runtimes: row.runtimes,
    topics: row.topics,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    lastChangeSummary: row.lastChangeSummary,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function loadInbox(db: Db, running = false): Promise<InboxResponse> {
  const [rows, dreamState] = await Promise.all([
    db
      .select()
      .from(dreamSuggestions)
      .where(eq(dreamSuggestions.status, 'pending'))
      .orderBy(desc(dreamSuggestions.createdAt))
      .limit(100),
    loadDreamState(db, running),
  ])

  const allEntryIds = [...new Set(rows.flatMap((r) => r.entryIds))]
  const entryRows = allEntryIds.length
    ? await db.select().from(entries).where(inArray(entries.id, allEntryIds))
    : []
  const byId = new Map(entryRows.map((e) => [e.id, toDreamEntrySnapshot(e)]))

  const items: DreamSuggestionView[] = rows.map((r) => ({
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
    reason: r.reason,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  }))

  return {
    items,
    pendingCount: items.length,
    dreamState,
  }
}
