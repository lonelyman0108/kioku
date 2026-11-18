import type { TuningValues } from '@kioku/contracts'
import { and, arrayContains, asc, count, eq, exists, gt, inArray, or, sql } from 'drizzle-orm'

import { loggableError, pgErrorCode, type Tx } from '../db/client'
import {
  clientGroupRules,
  conversations,
  conversationTurns,
  dreamMarks,
  entries,
  extractionRuns,
  subjectBindings,
  subjectIdentities,
  subjects,
} from '../db/schema'
import { extractionDelay, trimBatch } from '../extraction/buffer'
import type { Deps } from '../http/env'
import { subjectScope, TALK_KINDS } from '../memory/scopes'
import { loadCircleSettings } from '../settings/advanced'

export type SubjectRow = typeof subjects.$inferSelect

export const MERGED_WHILE_PENDING = '待确认期间联系人已被合并'

export async function lockSubjects(tx: Tx, ids: string[]): Promise<SubjectRow[]> {
  await tx.execute(sql`set local lock_timeout = '5s'`)
  return tx
    .select()
    .from(subjects)
    .where(inArray(subjects.id, ids))
    .orderBy(asc(subjects.id))
    .for('update')
}

export function isLockBusy(err: unknown): boolean {
  const code = pgErrorCode(err)
  return code === '55P03' || code === '40P01'
}

export function linkedToOthers(rows: readonly SubjectRow[], member: string | null): boolean {
  return rows.some((r) => r.accountId !== null && r.accountId !== member)
}

async function mergeInto(
  tx: Tx,
  from: SubjectRow,
  into: SubjectRow,
): Promise<{ scope: string; clients: string[] }> {
  const oldScope = subjectScope(from.kind, from.id)
  const newScope = subjectScope(into.kind, into.id)
  await tx
    .update(subjectIdentities)
    .set({ subjectId: into.id })
    .where(eq(subjectIdentities.subjectId, from.id))

  const talk = inArray(entries.kind, [...TALK_KINDS])
  const inFromScope = and(talk, eq(entries.originScope, oldScope))!
  const aboutFrom = and(talk, eq(entries.subjectId, from.id))!
  const together = or(
    inFromScope,
    aboutFrom,
    and(
      talk,
      eq(entries.originScope, newScope),
      exists(tx.select({ id: entries.id }).from(entries).where(inFromScope)),
    ),
    and(
      talk,
      eq(entries.subjectId, into.id),
      inArray(
        entries.originScope,
        tx.selectDistinct({ scope: entries.originScope }).from(entries).where(aboutFrom),
      ),
    ),
  )!

  await tx
    .select({ n: count() })
    .from(
      tx
        .select({ id: entries.id })
        .from(entries)
        .where(together)
        .orderBy(asc(entries.id))
        .for('no key update')
        .as('locked'),
    )
  await tx
    .delete(dreamMarks)
    .where(inArray(dreamMarks.entryId, tx.select({ id: entries.id }).from(entries).where(together)))
  await tx.update(entries).set({ subjectId: into.id }).where(eq(entries.subjectId, from.id))
  await tx.update(entries).set({ originScope: newScope }).where(eq(entries.originScope, oldScope))

  await tx
    .update(conversationTurns)
    .set({ senderSubjectId: into.id })
    .where(eq(conversationTurns.senderSubjectId, from.id))
  await tx
    .update(conversationTurns)
    .set({ groupSubjectId: into.id })
    .where(eq(conversationTurns.groupSubjectId, from.id))
  const moved = await tx
    .update(conversationTurns)
    .set({ scope: newScope })
    .where(eq(conversationTurns.scope, oldScope))
    .returning({ clientId: conversationTurns.clientId })

  await mergeConversations(tx, from, into)

  await tx
    .update(extractionRuns)
    .set({
      subjectIds: sql`array(select distinct unnest(array_replace(${extractionRuns.subjectIds}, ${from.id}::uuid, ${into.id}::uuid)))`,
    })
    .where(arrayContains(extractionRuns.subjectIds, [from.id]))
  await tx.update(extractionRuns).set({ scope: newScope }).where(eq(extractionRuns.scope, oldScope))

  // 合并群按群规则：同 client 下单群隔离锁取逻辑或（OR）防脱锁，人格优先保留 into 的规则
  const fromRules = await tx
    .select()
    .from(clientGroupRules)
    .where(eq(clientGroupRules.groupSubjectId, from.id))
  if (fromRules.length) {
    const intoRules = await tx
      .select()
      .from(clientGroupRules)
      .where(eq(clientGroupRules.groupSubjectId, into.id))
    const intoByClient = new Map(intoRules.map((r) => [r.clientId, r]))
    const now = new Date()
    for (const fr of fromRules) {
      const ir = intoByClient.get(fr.clientId)
      if (ir) {
        await tx
          .update(clientGroupRules)
          .set({
            isolateGroupMemory: ir.isolateGroupMemory || fr.isolateGroupMemory,
            personaId: ir.personaId ?? fr.personaId,
            updatedAt: now,
          })
          .where(
            and(
              eq(clientGroupRules.clientId, ir.clientId),
              eq(clientGroupRules.groupSubjectId, into.id),
            ),
          )
        await tx
          .delete(clientGroupRules)
          .where(
            and(
              eq(clientGroupRules.clientId, fr.clientId),
              eq(clientGroupRules.groupSubjectId, from.id),
            ),
          )
      } else {
        await tx
          .update(clientGroupRules)
          .set({ groupSubjectId: into.id, updatedAt: now })
          .where(
            and(
              eq(clientGroupRules.clientId, fr.clientId),
              eq(clientGroupRules.groupSubjectId, from.id),
            ),
          )
      }
    }
  }

  await tx
    .update(subjectBindings)
    .set({ status: 'cancelled', decidedAt: sql`now()`, note: MERGED_WHILE_PENDING })
    .where(
      and(
        eq(subjectBindings.status, 'pending'),
        gt(subjectBindings.expiresAt, sql`now()`),
        or(
          eq(subjectBindings.subjectId, from.id),
          inArray(subjectBindings.fromSubjectId, [from.id, into.id]),
        ),
      ),
    )
  await tx
    .update(subjectBindings)
    .set({ subjectId: into.id })
    .where(eq(subjectBindings.subjectId, from.id))
  await tx
    .update(subjectBindings)
    .set({ fromSubjectId: into.id })
    .where(eq(subjectBindings.fromSubjectId, from.id))

  await tx
    .update(subjects)
    .set({ accountId: into.accountId ?? from.accountId, updatedAt: new Date() })
    .where(eq(subjects.id, into.id))
  await tx.delete(subjects).where(eq(subjects.id, from.id))
  return { scope: newScope, clients: [...new Set(moved.map((m) => m.clientId))] }
}

async function mergeConversations(tx: Tx, from: SubjectRow, into: SubjectRow): Promise<void> {
  const gone = await tx.select().from(conversations).where(eq(conversations.subjectId, from.id))
  for (const c of gone) {
    const [kept] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.clientId, c.clientId), eq(conversations.subjectId, into.id)))
    if (!kept) {
      await tx.update(conversations).set({ subjectId: into.id }).where(eq(conversations.id, c.id))
      continue
    }
    await tx
      .update(entries)
      .set({ conversationId: kept.id })
      .where(eq(entries.conversationId, c.id))
    await tx
      .update(extractionRuns)
      .set({ conversationId: kept.id })
      .where(eq(extractionRuns.conversationId, c.id))
    await tx
      .update(conversations)
      .set({
        lastActiveAt: sql`greatest(${conversations.lastActiveAt}, ${c.lastActiveAt.toISOString()}::timestamptz)`,
      })
      .where(eq(conversations.id, kept.id))
    await tx.delete(conversations).where(eq(conversations.id, c.id))
  }
}

export interface MergeOutcome {
  scope: string
  batches: { clientId: string; turns: number }[]
}

export async function mergeSubjects(
  tx: Tx,
  from: SubjectRow,
  into: SubjectRow,
): Promise<MergeOutcome> {
  const { scope, clients } = await mergeInto(tx, from, into)
  const batches = []
  for (const clientId of clients) {
    batches.push({ clientId, turns: await trimBatch(tx, clientId, scope) })
  }
  return { scope, batches }
}

export async function enqueueMerged(
  deps: Deps,
  circleId: string,
  outcome: MergeOutcome,
): Promise<void> {
  if (!deps.jobs || !outcome.batches.length) return
  let values: TuningValues | undefined
  for (const { clientId, turns } of outcome.batches) {
    try {
      values ??= (await loadCircleSettings(deps.db, circleId)).values
      await deps.jobs.enqueueExtraction(
        { circleId, clientId, scope: outcome.scope } as never,
        extractionDelay(turns, values),
      )
    } catch (err) {
      console.error('合并之后排抽取失败，这一批等下一轮对话时再排', loggableError(err))
    }
  }
}
