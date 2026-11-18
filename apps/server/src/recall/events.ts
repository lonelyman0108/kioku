import type { RecallSource } from '@kioku/contracts'
import { sql } from 'drizzle-orm'

import { maskPlaintextCredentials } from '../credential/placeholders'
import { loggableError, withCircles } from '../db/client'
import { entries, entryRecallStats, recallEventHits, recallEvents } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import { CANDIDATE_ID, normalizeQuery, type RecordableCandidate } from './recall'

export const RECALL_QUERY_CHARS = 200

export function storedQuery(query: string, recordPrompt: boolean | undefined): string | null {
  if (recordPrompt === false) return null
  return maskPlaintextCredentials(query).slice(0, RECALL_QUERY_CHARS)
}

const pending = new Set<Promise<void>>()

export async function settleRecallEvents(): Promise<void> {
  await Promise.all([...pending])
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
  })
    .catch((err: unknown) => console.warn('记录召回事件失败', loggableError(err)))
    .finally(() => pending.delete(write))
  pending.add(write)
  return write
}
