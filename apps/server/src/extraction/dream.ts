import { createHash } from 'node:crypto'

import type {
  DreamEntrySnapshot,
  DreamOutcome,
  DreamRunSummary,
  DreamSuggestionKind,
  DreamSuggestionView,
  DreamTrigger,
  InboxResponse,
} from '@kioku/contracts'
import { and, asc, desc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm'

import { stillValidSql } from '../access/scope'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { dreamSuggestions, entries } from '../db/schema'
import { chatComplete } from '../models/client'
import {
  CHAT_LLM_SETTING_KEY,
  loadDreamState,
  loadResolvedModel,
  recordDreamRun,
} from '../models/store'
import { anyTermQuery, clipChars, searchTerms } from '../recall/recall'
import { buildDreamMessages, parseDreamProposals, type DreamPromptItem } from './dreamPrompt'

const MAX_CALLS_PER_RUN = 4
const CHANGED_PER_CALL = 20
const MAX_NEIGHBORS_PER_CALL = 15
const NEIGHBORS_PER_ITEM = 5
const INPUT_CHAR_BUDGET = 16_000
const ITEM_CONTENT_LIMIT = 1_500

type EntryRow = typeof entries.$inferSelect

function toPromptItem(row: EntryRow): DreamPromptItem {
  const truncated = row.content.length > ITEM_CONTENT_LIMIT
  return {
    id: row.id,
    shortId: row.shortId,
    kind: row.kind,
    title: row.title,
    content: truncated ? clipChars(row.content, ITEM_CONTENT_LIMIT) : row.content,
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

async function findFtsNeighbors(
  db: Db,
  seedRows: readonly EntryRow[],
  excludeIds: readonly string[],
): Promise<EntryRow[]> {
  if (!seedRows.length) return []
  const queryText = seedRows
    .map((r) => `${r.title} ${r.topics.join(' ')} ${r.projects.join(' ')}`)
    .join(' ')
    .slice(0, 1000)
  const [lex] = await db.execute<{ terms: string[] }>(
    sql`select tsvector_to_array(to_tsvector('kioku_zh', ${queryText})) as terms`,
  )
  const terms = searchTerms(lex?.terms ?? []).slice(0, 24)
  if (!terms.length) return []

  return db
    .select()
    .from(entries)
    .where(
      and(
        isNull(entries.deletedAt),
        stillValidSql(),
        eq(entries.kind, 'entry'),
        excludeIds.length ? notInArray(entries.id, [...excludeIds]) : undefined,
        sql`${entries.fts} @@ ${anyTermQuery(terms)}::tsquery`,
      ),
    )
    .orderBy(desc(entries.updatedAt))
    .limit(Math.min(MAX_NEIGHBORS_PER_CALL, seedRows.length * NEIGHBORS_PER_ITEM))
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

// 统一单阶段整理：扫描 version > dream_checked_version 的活跃词条与摘要，生成 4 类待审建议
export async function runDream(
  db: Db,
  masterKey: MasterKey | null,
  options: { runId: string; trigger: DreamTrigger },
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

      const promptChanged = batch.map(toPromptItem)
      const promptNeighbors = neighbors.map(toPromptItem)
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
            proposedContent: prop.proposedContent,
            proposedDisclosure: prop.proposedDisclosure,
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
    content: row.content,
    disclosure: row.disclosure,
    isPinned: row.isPinned,
    envs: row.envs,
    realms: row.realms,
    projects: row.projects,
    runtimes: row.runtimes,
    topics: row.topics,
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
    proposedContent: r.proposedContent,
    proposedDisclosure: r.proposedDisclosure,
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
