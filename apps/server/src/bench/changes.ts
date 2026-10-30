import { TurnEndEvent, type BenchChanges } from '@kioku/contracts'
import { and, asc, eq, gt, gte, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

import { logInternalError, withSpace } from '../db/client'
import {
  conversationTurns,
  credentialEvents,
  credentials,
  memoryEvents,
  subjectIdentities,
  subjects,
} from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import type { MemoryService } from '../memory/service'
import type { ResolvedStep } from './executor'

// 「真执行会改什么」。回滚模式按 created_at = now() 认这个事务写下的行：事务里 now() 固定，这几张表都用默认值，
// 别的事务提交的行时间不同（读已提交隔离下它们读得到），事件再加 Key 过滤，id 水位把它们分到每一步。不用 xmin：
// savepoint 里写的行是子事务的 xid。真实模式没有共同的事务，按事件 context 里这次运行的标记认；
// 对象与对话缓冲没有标记，这个模式不列
export interface ChangeTracker {
  collect(step: ResolvedStep): Promise<BenchChanges | null>
}

type RunWindow = { kind: 'transaction' } | { kind: 'marked'; run: string; since: Date }

const NOW = sql`now()`

export function changeTracker(
  deps: Deps,
  key: KeyPrincipal,
  memory: MemoryService,
  window: RunWindow,
): ChangeTracker {
  let lastMemoryEvent = 0
  let lastCredentialEvent = 0
  let lastTurn = 0
  const seenSubjects = new Set<string>()
  const seenIdentities = new Set<string>()

  // 这次运行写下的事件
  const written = (columns: {
    createdAt: AnyPgColumn
    actorKeyId: AnyPgColumn
    context: AnyPgColumn
  }): SQL | undefined =>
    window.kind === 'transaction'
      ? and(eq(columns.createdAt, NOW), eq(columns.actorKeyId, key.keyId))
      : and(
          gte(columns.createdAt, window.since),
          sql`${columns.context} -> 'bench' ->> 'run' = ${window.run}`,
        )

  async function collect(step: ResolvedStep): Promise<BenchChanges> {
    const events = await memory.eventChanges(
      and(written(memoryEvents), gt(memoryEvents.id, lastMemoryEvent))!,
    )
    lastMemoryEvent = Math.max(lastMemoryEvent, events.lastId)
    return withSpace(deps.db, key.spaceId, async (tx) => {
      const credentialRows = await tx
        .select({
          id: credentialEvents.id,
          type: credentialEvents.eventType,
          context: credentialEvents.context,
          identifier: credentials.identifier,
        })
        .from(credentialEvents)
        .innerJoin(credentials, eq(credentials.id, credentialEvents.credentialId))
        .where(and(written(credentialEvents), gt(credentialEvents.id, lastCredentialEvent)))
        .orderBy(asc(credentialEvents.id))
      lastCredentialEvent = credentialRows.at(-1)?.id ?? lastCredentialEvent
      const changes: BenchChanges = {
        memories: events.memories,
        hiddenReleased: events.hiddenReleased,
        hiddenOther: events.hiddenOther,
        credentials: credentialRows.map((r) => ({
          type: r.type,
          identifier: r.identifier,
          fields: stringList(r.context.fields),
          changes: stringList(r.context.changes),
        })),
        subjects: null,
        identities: null,
        turns: null,
        turn: null,
      }
      if (window.kind !== 'transaction') return changes

      // id 是 uuid，没有水位，只记下已经报过的；一次运行最多几十行
      const newSubjects = (
        await tx.select({ id: subjects.id }).from(subjects).where(eq(subjects.createdAt, NOW))
      ).filter((s) => !seenSubjects.has(s.id))
      for (const s of newSubjects) seenSubjects.add(s.id)
      const newIdentities = (
        await tx
          .select({
            id: subjectIdentities.id,
            kind: subjectIdentities.kind,
            platform: subjectIdentities.platform,
            externalId: subjectIdentities.externalId,
          })
          .from(subjectIdentities)
          .where(eq(subjectIdentities.createdAt, NOW))
      ).filter((i) => !seenIdentities.has(i.id))
      for (const i of newIdentities) seenIdentities.add(i.id)
      // 对话缓冲只数这个事务写下的行，不读正文：缓冲里有群里别人的话，没有读取的接口
      const turns = await tx
        .select({ id: conversationTurns.id })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.createdAt, NOW),
            eq(conversationTurns.keyId, key.keyId),
            gt(conversationTurns.id, lastTurn),
          ),
        )
        .orderBy(asc(conversationTurns.id))
      lastTurn = turns.at(-1)?.id ?? lastTurn
      return {
        ...changes,
        subjects: newSubjects.length,
        identities: newIdentities.map(({ kind, platform, externalId }) => ({
          kind,
          platform,
          externalId,
        })),
        turns: turns.length,
        turn: turns.length ? echoedTurn(step) : null,
      }
    })
  }

  return {
    collect: async (step) => {
      try {
        return await collect(step)
      } catch (err) {
        // 列不出来不影响步骤本身的结果，例如根事务已经中止
        logInternalError('测试台读这一步的改动失败', err)
        return null
      }
    },
  }
}

// 这一步传入的这一轮
function echoedTurn(step: ResolvedStep): BenchChanges['turn'] {
  if (step.kind !== 'lifecycle') return null
  const parsed = TurnEndEvent.safeParse(step.body)
  if (!parsed.success) return null
  const { sessionId, user, reply } = parsed.data
  return { sessionId, user, reply }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
