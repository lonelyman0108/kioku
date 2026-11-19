import type {
  ConversationDetail,
  ConversationInfo,
  ConversationKind,
  ExtractionRunInfo,
  SessionSummary,
} from '@kioku/contracts'
import { and, asc, desc, eq, exists, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm'

import { nowOf, type Tx } from '../db/client'
import { microsOf } from '../db/paging'
import {
  accounts,
  clients,
  conversations,
  entries,
  entryVariants,
  extractionRuns,
  subjects,
} from '../db/schema'
import { readableConditions } from '../memory/filter'
import { scopeNames } from '../memory/scopes'
import { clipChars, oneLine } from '../recall/text'
import type { Access, SessionContext } from './access'

const EXCERPT_CHARS = 120
const DETAIL_SUMMARIES = 100
const DETAIL_FACTS = 200
const DETAIL_RUNS = 20
const PARTICIPATED_LIMIT = 50

export function visibleConversations(access: Access): SQL {
  return or(
    isNull(conversations.ownerAccountId),
    eq(conversations.ownerAccountId, access.ownerAccountId),
  )!
}

const readable = (access: Access, now?: Date) =>
  readableConditions(access, { ...(now ? { now } : {}) })

const summariesOf = (access: Access, now?: Date) =>
  and(eq(entries.kind, 'episode'), readable(access, now))!

const factsOf = (access: Access) => and(eq(entries.kind, 'fact'), readable(access))!

export interface ConversationRow {
  info: ConversationInfo
  activeMicros: string
}

export async function conversationInfos(
  tx: Tx,
  access: Access,
  where: SQL | undefined,
  limit: number,
): Promise<ConversationRow[]> {
  const rows = await tx
    .select({
      conversation: conversations,
      activeMicros: sql<string>`${microsOf(conversations.lastActiveAt)}::text`,
      clientName: clients.name,
      subjectKind: subjects.kind,
      subjectName: subjects.displayName,
      ownerName: accounts.displayName,
    })
    .from(conversations)
    .innerJoin(clients, eq(clients.id, conversations.clientId))
    .leftJoin(subjects, eq(subjects.id, conversations.subjectId))
    .leftJoin(accounts, eq(accounts.id, conversations.ownerAccountId))
    .where(and(visibleConversations(access), where))
    .orderBy(desc(conversations.lastActiveAt), desc(conversations.id))
    .limit(limit)
  if (!rows.length) return []

  const ids = rows.map((r) => r.conversation.id)
  const inPage = and(inArray(entries.conversationId, ids), summariesOf(access, nowOf(tx)))
  const [counts, latest] = await Promise.all([
    tx
      .select({ id: entries.conversationId, n: sql<number>`count(*)::int` })
      .from(entries)
      .where(inPage)
      .groupBy(entries.conversationId),
    tx
      .selectDistinctOn([entries.conversationId], {
        id: entries.conversationId,
        content: entryVariants.content,
        createdAt: entries.createdAt,
      })
      .from(entries)
      .innerJoin(
        entryVariants,
        and(eq(entryVariants.entryId, entries.id), eq(entryVariants.whenSignature, '{}')),
      )
      .where(inPage)
      .orderBy(entries.conversationId, desc(entries.createdAt), desc(entries.id)),
  ])
  const countOf = new Map(counts.map((c) => [c.id, Number(c.n)]))
  const latestOf = new Map(latest.map((l) => [l.id, l]))

  return rows.map((r) => {
    const c = r.conversation
    const newest = latestOf.get(c.id)
    const subject =
      c.subjectId && r.subjectKind && r.subjectName !== null
        ? { id: c.subjectId, kind: r.subjectKind, displayName: r.subjectName }
        : null
    const owner =
      c.ownerAccountId && r.ownerName !== null
        ? { id: c.ownerAccountId, displayName: r.ownerName }
        : null
    return {
      activeMicros: r.activeMicros,
      info: {
        id: c.id,
        circleId: c.circleId,
        kind: c.kind as ConversationKind,
        client: { id: c.clientId, name: r.clientName },
        deviceKey: c.deviceKey,
        projectSlug: c.projectSlug,
        subject,
        owner,
        displayName: subject?.displayName ?? owner?.displayName ?? '',
        createdAt: c.createdAt.toISOString(),
        lastActiveAt: c.lastActiveAt.toISOString(),
        latestSummary: newest
          ? {
              excerpt: clipChars(oneLine(newest.content ?? ''), EXCERPT_CHARS, '…'),
              createdAt: newest.createdAt.toISOString(),
            }
          : null,
        summaryCount: countOf.get(c.id) ?? 0,
      },
    }
  })
}

export async function participatedConversations(
  tx: Tx,
  access: Access,
  subjectId: string,
): Promise<ConversationInfo[]> {
  const heard = tx
    .select({ one: sql`1` })
    .from(entries)
    .where(
      and(
        eq(entries.conversationId, conversations.id),
        eq(entries.subjectId, subjectId),
        factsOf(access),
      ),
    )
  const ran = tx
    .select({ one: sql`1` })
    .from(extractionRuns)
    .where(
      and(
        eq(extractionRuns.conversationId, conversations.id),
        sql`${subjectId}::uuid = any(${extractionRuns.subjectIds})`,
      ),
    )
  const rows = await conversationInfos(
    tx,
    access,
    or(eq(conversations.subjectId, subjectId), exists(heard), exists(ran)),
    PARTICIPATED_LIMIT,
  )
  return rows.map((r) => r.info)
}

type RunRow = { run: typeof extractionRuns.$inferSelect; clientName: string | null }

export async function runInfos(
  tx: Tx,
  rows: RunRow[],
  visibleIds: ReadonlySet<string>,
  errorOf: (stored: string | null) => string | null,
): Promise<ExtractionRunInfo[]> {
  const named = await scopeNames(
    tx,
    rows.map((r) => r.run.scope),
  )
  return rows.map(({ run, clientName }) => ({
    id: run.id,
    createdAt: run.createdAt.toISOString(),
    client: clientName ? { id: run.clientId, name: clientName } : null,
    scope: named(run.scope),
    conversationId:
      run.conversationId && visibleIds.has(run.conversationId) ? run.conversationId : null,
    turns: run.turns,
    skippedTurns: run.skippedTurns,
    added: run.added,
    updated: run.updated,
    unchanged: run.unchanged,
    dropped: run.dropped,
    limited: run.limited,
    summarized: run.summarized,
    summaryOnly: run.summaryOnly,
    error: errorOf(run.error),
  }))
}

export async function visibleConversationIds(
  tx: Tx,
  access: Access,
  ids: (string | null)[],
): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (!wanted.length) return new Set()
  const rows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(inArray(conversations.id, wanted), visibleConversations(access)))
  return new Set(rows.map((r) => r.id))
}

export async function conversationDetail(
  tx: Tx,
  access: Access,
  id: string,
  errorOf: (stored: string | null) => string | null,
): Promise<ConversationDetail | null> {
  const [found] = await conversationInfos(tx, access, eq(conversations.id, id), 1)
  if (!found) return null
  const [summaries, facts, runs] = await Promise.all([
    tx
      .select({
        id: entries.id,
        shortId: entries.shortId,
        content: entryVariants.content,
        provenance: entries.provenance,
        createdAt: entries.createdAt,
        expiresAt: entries.expiresAt,
      })
      .from(entries)
      .innerJoin(
        entryVariants,
        and(eq(entryVariants.entryId, entries.id), eq(entryVariants.whenSignature, '{}')),
      )
      .where(and(eq(entries.conversationId, id), summariesOf(access)))
      .orderBy(desc(entries.createdAt), desc(entries.id))
      .limit(DETAIL_SUMMARIES),
    tx
      .selectDistinctOn([entries.id], {
        fact: entries,
        content: entryVariants.content,
        subjectKind: subjects.kind,
        subjectName: subjects.displayName,
      })
      .from(entries)
      .innerJoin(subjects, eq(subjects.id, entries.subjectId))
      .innerJoin(entryVariants, eq(entryVariants.entryId, entries.id))
      .where(and(eq(entries.conversationId, id), factsOf(access)))
      .orderBy(entries.id, asc(entryVariants.sortOrder))
      .limit(DETAIL_FACTS),
    tx
      .select({ run: extractionRuns, clientName: clients.name })
      .from(extractionRuns)
      .leftJoin(clients, eq(clients.id, extractionRuns.clientId))
      .where(eq(extractionRuns.conversationId, id))
      .orderBy(desc(extractionRuns.createdAt), desc(extractionRuns.id))
      .limit(DETAIL_RUNS),
  ])
  return {
    ...found.info,
    summaries: summaries.map((s) => ({
      id: s.id,
      shortId: s.shortId,
      content: s.content ?? '',
      provenance: s.provenance,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt?.toISOString() ?? null,
    })),
    facts: facts.map(({ fact, content, subjectKind, subjectName }) => ({
      id: fact.id,
      shortId: fact.shortId,
      content: content ?? '',
      provenance: fact.provenance,
      subject: { id: fact.subjectId!, kind: subjectKind, displayName: subjectName },
      version: fact.version,
      createdAt: fact.createdAt.toISOString(),
      updatedAt: fact.updatedAt.toISOString(),
    })),
    runs: await runInfos(tx, runs, new Set([id]), errorOf),
  }
}

// ---- 会话的建立 ----

export type ConversationRef =
  | { kind: 'group' | 'direct' | 'channel'; subjectId: string }
  | { kind: 'none'; ownerAccountId: string; deviceKey: string; projectSlug: string }

export function conversationRefOf(
  context: SessionContext,
  clientOwnerAccountId: string,
  options: { deviceKey?: string | null; projectSlug?: string | null } = {},
): ConversationRef | null {
  if (!context.chatType) {
    return {
      kind: 'none',
      ownerAccountId: clientOwnerAccountId,
      deviceKey: (options.deviceKey ?? '').trim(),
      projectSlug: (options.projectSlug ?? '').trim(),
    }
  }
  if (context.chatType === 'group' || context.chatType === 'channel') {
    return context.groupSubjectId
      ? { kind: context.chatType, subjectId: context.groupSubjectId }
      : null
  }
  if (context.chatType === 'direct') {
    return context.senderSubjectId ? { kind: 'direct', subjectId: context.senderSubjectId } : null
  }
  return null
}

const refValues = (circleId: string, clientId: string, ref: ConversationRef) => ({
  circleId,
  clientId,
  kind: ref.kind,
  deviceKey: ref.kind === 'none' ? ref.deviceKey : '',
  projectSlug: ref.kind === 'none' ? ref.projectSlug : '',
  subjectId: ref.kind === 'none' ? null : ref.subjectId,
  ownerAccountId: ref.kind === 'none' ? ref.ownerAccountId : null,
})

const refConflict = (ref: ConversationRef) =>
  ref.kind === 'none'
    ? {
        target: [
          conversations.clientId,
          conversations.ownerAccountId,
          conversations.deviceKey,
          conversations.projectSlug,
        ],
        targetWhere: sql`${conversations.kind} = 'none'`,
      }
    : {
        target: [conversations.clientId, conversations.subjectId],
        targetWhere: sql`${conversations.kind} <> 'none'`,
      }

const refMatch = (clientId: string, ref: ConversationRef) =>
  and(
    eq(conversations.clientId, clientId),
    ref.kind === 'none'
      ? and(
          eq(conversations.kind, 'none'),
          eq(conversations.ownerAccountId, ref.ownerAccountId),
          eq(conversations.deviceKey, ref.deviceKey),
          eq(conversations.projectSlug, ref.projectSlug),
        )
      : and(ne(conversations.kind, 'none'), eq(conversations.subjectId, ref.subjectId)),
  )!

export async function touchConversation(
  tx: Tx,
  circleId: string,
  clientId: string,
  ref: ConversationRef,
): Promise<void> {
  const conflict = refConflict(ref)
  await tx
    .insert(conversations)
    .values(refValues(circleId, clientId, ref))
    .onConflictDoUpdate({
      ...conflict,
      set: { lastActiveAt: sql`now()` },
      setWhere: sql`${conversations.lastActiveAt} < now() - interval '1 minute' or ${conversations.lastActiveAt} > now()`,
    })
}

export async function ensureConversation(
  tx: Tx,
  circleId: string,
  clientId: string,
  ref: ConversationRef,
): Promise<string> {
  const conflict = refConflict(ref)
  const [created] = await tx
    .insert(conversations)
    .values(refValues(circleId, clientId, ref))
    .onConflictDoNothing({ target: conflict.target, where: conflict.targetWhere })
    .returning({ id: conversations.id })
  if (created) return created.id
  return (await findConversation(tx, clientId, ref))!
}

export async function findConversation(
  tx: Tx,
  clientId: string,
  ref: ConversationRef,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(refMatch(clientId, ref))
  return row?.id ?? null
}

export async function latestSummaries(
  tx: Tx,
  access: Access,
  clientId: string,
  ref: ConversationRef,
  limit: number,
): Promise<SessionSummary[]> {
  const rows = await tx
    .select({
      shortId: entries.shortId,
      content: entryVariants.content,
      createdAt: entries.createdAt,
    })
    .from(entries)
    .innerJoin(conversations, eq(conversations.id, entries.conversationId))
    .innerJoin(
      entryVariants,
      and(eq(entryVariants.entryId, entries.id), eq(entryVariants.whenSignature, '{}')),
    )
    .where(and(refMatch(clientId, ref), summariesOf(access)))
    .orderBy(desc(entries.createdAt), desc(entries.id))
    .limit(limit)
  return rows.map((r) => ({
    shortId: r.shortId,
    content: r.content ?? '',
    createdAt: r.createdAt.toISOString(),
  }))
}
