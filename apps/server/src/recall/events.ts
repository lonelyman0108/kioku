import type {
  ClientRecallVolume,
  EntryRecallStat,
  MemberRole,
  NeverRecalledEntry,
  RecallEventList,
  RecallEventQuery,
  RecallEventView,
  RecallSource,
  RecallStats,
  RecallVia,
  RecalledEntry,
} from '@kioku/contracts'
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'

import { canRead, type Access } from '../access/access'
import { maskPlaintextCredentials } from '../credential/placeholders'
import { loggableError, withCircle, withCircles, type Db } from '../db/client'
import { INVALID_CURSOR } from '../db/paging'
import {
  apiKeys,
  circles,
  clients,
  entries,
  entryRecallStats,
  recallEventHits,
  recallEvents,
} from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import { MemoryError } from '../memory/errors'
import { readableConditions } from '../memory/filter'
import { parseEntryFacts } from '../memory/service'
import { settleRecallEvents, trackRecallWrite } from './pending'
import { CANDIDATE_ID, normalizeQuery, type RecordableCandidate } from './recall'
import { loadRecallWindow } from './retention'

export { settleRecallEvents }

export const RECALL_QUERY_CHARS = 200
const DEFAULT_TOP_LIMIT = 20
const DEFAULT_NEVER_LIMIT = 50
const DEFAULT_EVENT_PAGE = 50

export function storedQuery(query: string, recordPrompt: boolean | undefined): string | null {
  if (recordPrompt === false) return null
  return maskPlaintextCredentials(query).slice(0, RECALL_QUERY_CHARS)
}

// 主响应外异步记录主场圈召回事件与命中明细，并在同一多圈写事务内直接累加各目标圈 entry_recall_stats
export function recordRecall(
  deps: Deps,
  key: KeyPrincipal,
  source: RecallSource,
  query: string,
  hits: readonly RecordableCandidate[],
): Promise<void> {
  if (!normalizeQuery(query)) return Promise.resolve()
  const stored = storedQuery(query, key.client.config.recordPrompt)
  const dedupedHits: RecordableCandidate[] = []
  const seenEntries = new Set<string>()
  for (const h of hits) {
    const eid = h[CANDIDATE_ID]
    if (seenEntries.has(eid)) continue
    seenEntries.add(eid)
    dedupedHits.push(h)
  }

  const allCircles = [...new Set([key.circleId, ...dedupedHits.map((h) => h.circleId)])]

  const write = withCircles(deps.db, { read: allCircles, write: allCircles }, async (tx, now) => {
    const [event] = await tx
      .insert(recallEvents)
      .values({
        circleId: key.circleId,
        clientId: key.client.id,
        keyId: key.keyId,
        ownerAccountId: key.client.ownerAccountId,
        source,
        query: stored,
      })
      .returning({ id: recallEvents.id })

    if (!dedupedHits.length) return

    await tx.insert(recallEventHits).values(
      dedupedHits.map((h, i) => ({
        eventId: event!.id,
        circleId: key.circleId,
        targetCircleId: h.circleId,
        entryId: h[CANDIDATE_ID],
        shortId: h.shortId,
        rank: i + 1,
        score: h.score,
        via: h.via,
      })),
    )

    const idsSql = sql.join(
      dedupedHits.map((h) => sql`${h[CANDIDATE_ID]}::uuid`),
      sql`, `,
    )
    await tx.execute(sql`
        insert into ${entryRecallStats} (entry_id, circle_id, count, last_recalled_at)
        select e.id, e.circle_id, 1, ${now.toISOString()}::timestamptz
        from ${entries} e
        where e.id in (${idsSql})
          and e.deleted_at is null
        on conflict (entry_id) do update
        set count = ${entryRecallStats.count} + 1,
            last_recalled_at = greatest(${entryRecallStats.lastRecalledAt}, excluded.last_recalled_at)`)
  }).catch((err: unknown) => console.warn('记录召回事件失败', loggableError(err)))
  trackRecallWrite(write)
  return write
}

export async function loadCircleRecallStats(
  db: Db,
  circleId: string,
  access: Access,
  viewer: { accountId: string; role: MemberRole },
  limits: { top?: number; never?: number } = {},
): Promise<RecallStats> {
  const topLimit = limits.top ?? DEFAULT_TOP_LIMIT
  const neverLimit = limits.never ?? DEFAULT_NEVER_LIMIT
  const {
    settings: { retentionDays },
    recordingSince,
  } = await loadRecallWindow(db, circleId)

  return withCircle(db, circleId, async (tx, now) => {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000)
    const readable = readableConditions(access, { now, management: true })

    const [clientEventRows, topRows, recentHitRows] = await Promise.all([
      tx
        .select({
          clientId: recallEvents.clientId,
          source: recallEvents.source,
          n: count(),
          name: clients.name,
          ownerAccountId: recallEvents.ownerAccountId,
        })
        .from(recallEvents)
        .leftJoin(clients, eq(clients.id, recallEvents.clientId))
        .groupBy(
          recallEvents.clientId,
          recallEvents.source,
          clients.name,
          recallEvents.ownerAccountId,
        ),
      tx
        .select({
          id: entries.id,
          shortId: entries.shortId,
          title: entries.title,
          kind: entries.kind,
          sensitivity: entries.sensitivity,
          total: entryRecallStats.count,
          lastRecalledAt: entryRecallStats.lastRecalledAt,
        })
        .from(entryRecallStats)
        .innerJoin(entries, eq(entries.id, entryRecallStats.entryId))
        .where(and(readable, ne(entries.sensitivity, 'secret'), sql`${entryRecallStats.count} > 0`))
        .orderBy(desc(entryRecallStats.count), asc(entries.shortId))
        .limit(topLimit),
      tx
        .select({ entryId: recallEventHits.entryId, n: count() })
        .from(recallEventHits)
        .innerJoin(recallEvents, eq(recallEvents.id, recallEventHits.eventId))
        .where(
          and(eq(recallEventHits.targetCircleId, circleId), gte(recallEvents.createdAt, cutoff)),
        )
        .groupBy(recallEventHits.entryId),
    ])

    const recentByEntry = new Map(recentHitRows.map((r) => [r.entryId, r.n]))

    const volumes = new Map<string, ClientRecallVolume>()
    for (const row of clientEventRows) {
      if (viewer.role !== 'owner' && row.ownerAccountId !== viewer.accountId) continue
      const volume = volumes.get(row.clientId) ?? {
        clientId: row.clientId,
        name: row.name ?? null,
        total: 0,
        sources: [],
      }
      volume.total += row.n
      volume.sources.push({ source: row.source as RecallSource, count: row.n })
      volumes.set(row.clientId, volume)
    }

    const top: RecalledEntry[] = topRows.map((r) => ({
      id: r.id,
      shortId: r.shortId,
      title: r.title,
      kind: r.kind,
      sensitivity: r.sensitivity,
      recent: recentByEntry.get(r.id) ?? 0,
      total: r.total,
      lastRecalledAt: r.lastRecalledAt.toISOString(),
    }))

    let never: NeverRecalledEntry[] = []
    let neverTotal = 0
    if (recordingSince.getTime() <= cutoff.getTime()) {
      const neverWhere = and(
        readable,
        eq(entries.kind, 'entry'),
        ne(entries.provenance, 'untrusted'),
        ne(entries.sensitivity, 'secret'),
        sql`${entries.priority} > 0`,
        lte(entries.createdAt, cutoff),
        or(isNull(entryRecallStats.count), eq(entryRecallStats.count, 0)),
      )
      const [neverRows, countRow] = await Promise.all([
        tx
          .select({
            id: entries.id,
            shortId: entries.shortId,
            title: entries.title,
            kind: entries.kind,
            sensitivity: entries.sensitivity,
            createdAt: entries.createdAt,
          })
          .from(entries)
          .leftJoin(entryRecallStats, eq(entryRecallStats.entryId, entries.id))
          .where(neverWhere)
          .orderBy(asc(entries.createdAt), asc(entries.shortId))
          .limit(neverLimit),
        tx
          .select({ n: count() })
          .from(entries)
          .leftJoin(entryRecallStats, eq(entryRecallStats.entryId, entries.id))
          .where(neverWhere),
      ])
      neverTotal = countRow[0]?.n ?? 0
      never = neverRows.map((r) => ({
        id: r.id,
        shortId: r.shortId,
        title: r.title,
        kind: r.kind,
        sensitivity: r.sensitivity,
        createdAt: r.createdAt.toISOString(),
      }))
    }

    return {
      retentionDays,
      recordingSince: recordingSince.toISOString(),
      clients: [...volumes.values()].sort((a, b) => b.total - a.total),
      top,
      never,
      neverTotal,
    }
  })
}

export async function listCircleRecallEvents(
  db: Db,
  circleId: string,
  access: Access,
  viewer: { accountId: string; role: MemberRole },
  query: RecallEventQuery,
  limit = DEFAULT_EVENT_PAGE,
): Promise<RecallEventList> {
  let beforeId: number | undefined
  if (query.cursor !== undefined) {
    beforeId = Number(query.cursor)
    if (!Number.isSafeInteger(beforeId) || beforeId <= 0) {
      throw new MemoryError(400, INVALID_CURSOR)
    }
  }

  const eventRows = await withCircle(db, circleId, (tx) =>
    tx
      .select({
        id: recallEvents.id,
        clientId: recallEvents.clientId,
        clientName: clients.name,
        keyName: apiKeys.name,
        source: recallEvents.source,
        query: recallEvents.query,
        createdAt: recallEvents.createdAt,
      })
      .from(recallEvents)
      .leftJoin(clients, eq(clients.id, recallEvents.clientId))
      .leftJoin(apiKeys, eq(apiKeys.id, recallEvents.keyId))
      .where(
        and(
          viewer.role === 'owner' ? undefined : eq(recallEvents.ownerAccountId, viewer.accountId),
          query.clientId ? eq(recallEvents.clientId, query.clientId) : undefined,
          beforeId !== undefined ? lt(recallEvents.id, beforeId) : undefined,
        ),
      )
      .orderBy(desc(recallEvents.id))
      .limit(limit + 1),
  )

  const hasMore = eventRows.length > limit
  const page = hasMore ? eventRows.slice(0, limit) : eventRows
  if (!page.length) return { items: [], nextCursor: null }

  const eventIds = page.map((e) => e.id)
  const hitRows = await withCircle(db, circleId, (tx) =>
    tx
      .select()
      .from(recallEventHits)
      .where(inArray(recallEventHits.eventId, eventIds))
      .orderBy(asc(recallEventHits.rank)),
  )

  const readableCircles = [...access.circles.keys()]
  const targetCircleIds = [...new Set(hitRows.map((h) => h.targetCircleId))].filter((id) =>
    access.circles.has(id),
  )
  const entryIds = [...new Set(hitRows.map((h) => h.entryId))]

  const readableTargetMeta = new Map<
    string,
    { shortId: string; title: string; targetCircleSlug: string | null }
  >()
  const visibleSlugs = new Map<string, string>()

  if (targetCircleIds.length && entryIds.length) {
    await withCircles(db, { read: readableCircles }, async (tx, now) => {
      const [circleRows, entryRows] = await Promise.all([
        tx
          .select({ id: circles.id, slug: circles.slug })
          .from(circles)
          .where(inArray(circles.id, targetCircleIds)),
        tx.select().from(entries).where(inArray(entries.id, entryIds)),
      ])
      for (const c of circleRows) visibleSlugs.set(c.id, c.slug)
      for (const e of entryRows) {
        if (
          e.sensitivity === 'secret' ||
          !canRead(access, parseEntryFacts(e), { now, management: true })
        ) {
          continue
        }
        readableTargetMeta.set(e.id, {
          shortId: e.shortId,
          title: e.title,
          targetCircleSlug: visibleSlugs.get(e.circleId) ?? null,
        })
      }
    })
  }

  const hitsByEvent = new Map<number, RecallEventView['hits']>()
  for (const h of hitRows) {
    const meta = readableTargetMeta.get(h.entryId)
    const bucket = hitsByEvent.get(h.eventId) ?? []
    bucket.push({
      targetCircleId: h.targetCircleId,
      targetCircleSlug: meta?.targetCircleSlug ?? visibleSlugs.get(h.targetCircleId) ?? null,
      shortId: meta ? meta.shortId : null,
      title: meta ? meta.title : null,
      rank: h.rank,
      score: h.score,
      via: h.via as RecallVia[],
    })
    hitsByEvent.set(h.eventId, bucket)
  }

  const items: RecallEventView[] = page.map((e) => ({
    id: e.id,
    clientId: e.clientId,
    clientName: e.clientName ?? null,
    keyName: e.keyName ?? null,
    source: e.source as RecallSource,
    query: e.query,
    createdAt: e.createdAt.toISOString(),
    hits: hitsByEvent.get(e.id) ?? [],
  }))

  return {
    items,
    nextCursor: hasMore ? String(page.at(-1)!.id) : null,
  }
}

export async function loadEntryRecallStat(
  db: Db,
  circleId: string,
  access: Access,
  entryId: string,
): Promise<EntryRecallStat> {
  const {
    settings: { retentionDays },
  } = await loadRecallWindow(db, circleId)

  return withCircle(db, circleId, async (tx, now) => {
    const [entry] = await tx.select().from(entries).where(eq(entries.id, entryId)).limit(1)
    if (!entry || !canRead(access, parseEntryFacts(entry), { now, management: true })) {
      throw new MemoryError(404, '未找到词条')
    }
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000)
    const [statRows, recentRows] = await Promise.all([
      tx
        .select({ count: entryRecallStats.count, lastRecalledAt: entryRecallStats.lastRecalledAt })
        .from(entryRecallStats)
        .where(eq(entryRecallStats.entryId, entryId))
        .limit(1),
      tx
        .select({ n: count() })
        .from(recallEventHits)
        .innerJoin(recallEvents, eq(recallEvents.id, recallEventHits.eventId))
        .where(
          and(
            eq(recallEventHits.targetCircleId, circleId),
            eq(recallEventHits.entryId, entryId),
            gte(recallEvents.createdAt, cutoff),
          ),
        ),
    ])
    const stat = statRows[0]
    return {
      recent: recentRows[0]?.n ?? 0,
      total: stat?.count ?? 0,
      lastRecalledAt: stat?.lastRecalledAt ? stat.lastRecalledAt.toISOString() : null,
    }
  })
}
