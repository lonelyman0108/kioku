import {
  TUNING_DEFAULTS,
  type EntryKind,
  type Sensitivity,
  type TuningValues,
  type TurnEndEvent,
} from '@kioku/contracts'
import { and, count, eq, sql } from 'drizzle-orm'

import { sensitivityRank } from '../access/access'
import type { KeySession } from '../access/session'
import { withCircle, type Db, type Tx } from '../db/client'
import { circles, conversationTurns } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import { normalizeProjectSlug } from '../memory/facets'
import { loadCircleSettings } from '../settings/advanced'
import { hasExtractionModel } from './settings'

export const BATCH_TURNS = TUNING_DEFAULTS['extraction.batchTurns']
export const IDLE_SECONDS = TUNING_DEFAULTS['extraction.idleMinutes'] * 60
export const MAX_BUFFERED_TURNS = 100
export const BUFFER_IDLE_HOURS = 24

// 无上下文缓冲作用域按 JSON 数组编码，避免用户名/设备/项目名内包含冒号导致冲突
export function noContextScope(ownerAccountId: string, deviceKey = '', projectSlug = ''): string {
  return JSON.stringify(['none', ownerAccountId, deviceKey, projectSlug])
}

export function parseNoContextScope(
  scope: string,
): { ownerAccountId: string; deviceKey: string; projectSlug: string } | null {
  try {
    const parsed: unknown = JSON.parse(scope)
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 4 ||
      parsed[0] !== 'none' ||
      typeof parsed[1] !== 'string' ||
      typeof parsed[2] !== 'string' ||
      typeof parsed[3] !== 'string'
    ) {
      return null
    }
    return { ownerAccountId: parsed[1], deviceKey: parsed[2], projectSlug: parsed[3] }
  } catch {
    return null
  }
}

export interface BufferedSession {
  circleId: string
  clientId: string
  scope: string
}

// 这些写权限写不写得下几轮对话抽取出的东西：带会话上下文写事实或摘要；不带上下文仅写摘要且须支持 private
export function canWriteTurns(
  write: { writeKinds: Iterable<EntryKind>; maxSensitivity: Sensitivity },
  withContext: boolean,
): boolean {
  const kinds = new Set(write.writeKinds)
  if (!withContext) {
    return (
      kinds.has('episode') && sensitivityRank(write.maxSensitivity) >= sensitivityRank('private')
    )
  }
  return kinds.has('fact') || kinds.has('episode')
}

export async function bufferTurn(
  deps: Deps,
  key: KeyPrincipal,
  session: KeySession,
  input: TurnEndEvent,
): Promise<void> {
  if (!(await hasExtractionModel(deps.db))) return
  const { context } = session
  const deviceKey = (input.deviceKey ?? '').trim()
  const projectSlug = normalizeProjectSlug(input.project) ?? ''
  const scope = !context.chatType
    ? noContextScope(key.client.ownerAccountId, deviceKey, projectSlug)
    : context.groupSubjectId
      ? `group:${context.groupSubjectId}`
      : `direct:${context.senderSubjectId!}`
  const target: BufferedSession = { circleId: key.circleId, clientId: key.client.id, scope }
  const { buffered, values } = await withCircle(deps.db, key.circleId, async (tx) => {
    await tx.insert(conversationTurns).values({
      circleId: key.circleId,
      clientId: key.client.id,
      keyId: key.keyId,
      scope,
      sessionId: input.sessionId,
      chatType: context.chatType ?? 'none',
      groupSubjectId: context.groupSubjectId ?? null,
      senderSubjectId: context.senderSubjectId ?? null,
      ownerAccountId: context.chatType ? null : key.client.ownerAccountId,
      senderName: session.subjects.find((s) => s.role === 'sender')?.name ?? null,
      userText: input.user,
      replyText: input.reply,
    })
    const buffered = await trimBatch(tx, key.client.id, scope)
    return { buffered, values: (await loadCircleSettings(tx, key.circleId)).values }
  })
  void deps.jobs?.enqueueExtraction(target as never, extractionDelay(buffered, values))
}

export async function trimBatch(tx: Tx, clientId: string, scope: string): Promise<number> {
  const inBatch = and(eq(conversationTurns.clientId, clientId), eq(conversationTurns.scope, scope))
  await tx.execute(sql`
    delete from ${conversationTurns}
    where ${inBatch} and ${conversationTurns.id} <= (
      select ${conversationTurns.id} from ${conversationTurns} where ${inBatch}
      order by ${conversationTurns.id} desc offset ${MAX_BUFFERED_TURNS} limit 1
    )`)
  const [row] = await tx.select({ n: count() }).from(conversationTurns).where(inBatch)
  return row!.n
}

export function extractionDelay(
  buffered: number,
  values: Pick<TuningValues, 'extraction.batchTurns' | 'extraction.idleMinutes'> = TUNING_DEFAULTS,
): number {
  return buffered >= values['extraction.batchTurns'] ? 0 : values['extraction.idleMinutes'] * 60
}

export async function dropBuffered(db: Db, target: BufferedSession): Promise<number> {
  const gone = await withCircle(db, target.circleId, (tx) =>
    tx
      .delete(conversationTurns)
      .where(
        and(
          eq(conversationTurns.clientId, target.clientId),
          eq(conversationTurns.scope, target.scope),
        ),
      )
      .returning({ id: conversationTurns.id }),
  )
  return gone.length
}

export async function pruneConversationTurns(db: Db): Promise<number> {
  const all = await db.select({ id: circles.id }).from(circles)
  let removed = 0
  for (const circle of all) {
    const [row] = await withCircle(db, circle.id, (tx) =>
      tx.execute<{ removed: number }>(sql`
        with idle as (
          select ${conversationTurns.clientId} as client_id, ${conversationTurns.scope} as scope
          from ${conversationTurns}
          group by ${conversationTurns.clientId}, ${conversationTurns.scope}
          having max(${conversationTurns.createdAt}) < now() - make_interval(hours => ${BUFFER_IDLE_HOURS}::int)
        ),
        gone as (
          delete from ${conversationTurns} t using idle
          where t.client_id = idle.client_id and t.scope = idle.scope
          returning 1
        )
        select count(*)::int as removed from gone`),
    )
    removed += row?.removed ?? 0
  }
  return removed
}
