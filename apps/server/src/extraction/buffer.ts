import type { TurnEndEvent } from '@kioku/contracts'
import { and, count, eq, lte, sql } from 'drizzle-orm'

import type { KeySession } from '../access/session'
import { withSpace, type Db } from '../db/client'
import { conversationTurns, spaces } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import { extractionSettingsView } from './settings'

// 攒满这么多轮就马上排一次抽取；不满时等这一批空闲这么久再抽取
export const BATCH_TURNS = 10
export const IDLE_SECONDS = 600
// 每一批最多留这么多轮：抽取一直失败（例如模型出错）时丢掉最早的，缓冲不会无限长
export const MAX_BUFFERED_TURNS = 100
// 一批空闲这么久就整批删掉：正常情况下早就抽取完了，留下的是抽取不了的
export const BUFFER_IDLE_HOURS = 24

// 一批缓冲：按应用与来源作用域分（本群，或与此人的私聊），抽取写下的记忆都在这个作用域里
export interface BufferedSession {
  spaceId: string
  appId: string
  scope: string
}

// turn.end 能不能进缓冲：会话上下文只会把 Key 能写的层收紧到对象层与情节层，Key 两层都写不了时，
// 抽取出的东西写不进去，不必存下别人的话。只看 Key，不用先解析会话（解析会建对象）
export function canBufferTurns(key: KeyPrincipal): boolean {
  return key.scopes.writeLayers.some((layer) => layer === 'subject' || layer === 'episode')
}

// 把一轮对话放进缓冲，按轮数或空闲时间排抽取任务（同一批只排一个，空闲计时从最后一轮算起）。
// 没配抽取模型时不存：不抽取就没有理由留着别人的话
export async function bufferTurn(
  deps: Deps,
  key: KeyPrincipal,
  session: KeySession,
  input: TurnEndEvent,
): Promise<void> {
  if (!(await extractionSettingsView(deps.db)).configured) return
  const { context } = session
  // 契约保证 turn.end 是私聊、群聊或频道，并且带着发言人
  const scope = context.groupSubjectId
    ? `group:${context.groupSubjectId}`
    : `direct:${context.senderSubjectId!}`
  const target: BufferedSession = { spaceId: key.spaceId, appId: key.app.id, scope }
  const buffered = await withSpace(deps.db, key.spaceId, async (tx) => {
    await tx.insert(conversationTurns).values({
      spaceId: key.spaceId,
      appId: key.app.id,
      keyId: key.keyId,
      scope,
      sessionId: input.sessionId,
      chatType: context.chatType!,
      groupSubjectId: context.groupSubjectId ?? null,
      senderSubjectId: context.senderSubjectId!,
      senderName: session.subjects.find((s) => s.role === 'sender')?.name ?? null,
      userText: input.user,
      replyText: input.reply,
    })
    const inBatch = and(eq(conversationTurns.appId, key.app.id), eq(conversationTurns.scope, scope))
    await tx.execute(sql`
      delete from ${conversationTurns}
      where ${inBatch} and ${conversationTurns.id} <= (
        select ${conversationTurns.id} from ${conversationTurns} where ${inBatch}
        order by ${conversationTurns.id} desc offset ${MAX_BUFFERED_TURNS} limit 1
      )`)
    const [row] = await tx.select({ n: count() }).from(conversationTurns).where(inBatch)
    return row!.n
  })
  // 两轮同时进来时，后入队的可能把「马上」改回「等空闲」，这一批最多晚一个空闲时长：
  // 下一轮进来或空闲到点时照样处理，不丢对话
  void deps.jobs?.enqueueExtraction(target, buffered >= BATCH_TURNS ? 0 : IDLE_SECONDS)
}

// 丢掉一批缓冲，返回删了几轮。upTo 给了时只删到这一轮（含）为止：抽取期间新进来的留给它们排的任务
export async function dropBuffered(
  db: Db,
  target: BufferedSession,
  upTo?: number,
): Promise<number> {
  const gone = await withSpace(db, target.spaceId, (tx) =>
    tx
      .delete(conversationTurns)
      .where(
        and(
          eq(conversationTurns.appId, target.appId),
          eq(conversationTurns.scope, target.scope),
          upTo === undefined ? undefined : lte(conversationTurns.id, upTo),
        ),
      )
      .returning({ id: conversationTurns.id }),
  )
  return gone.length
}

// 整批删掉空闲超过 BUFFER_IDLE_HOURS 的缓冲（最后一轮在那之前），还在聊的不动。内容表开了 RLS，逐个空间处理
export async function pruneConversationTurns(db: Db): Promise<number> {
  const all = await db.select({ id: spaces.id }).from(spaces)
  let removed = 0
  for (const space of all) {
    const [row] = await withSpace(db, space.id, (tx) =>
      tx.execute<{ removed: number }>(sql`
        with idle as (
          select ${conversationTurns.appId} as app_id, ${conversationTurns.scope} as scope
          from ${conversationTurns}
          group by ${conversationTurns.appId}, ${conversationTurns.scope}
          having max(${conversationTurns.createdAt}) < now() - make_interval(hours => ${BUFFER_IDLE_HOURS}::int)
        ),
        gone as (
          delete from ${conversationTurns} t using idle
          where t.app_id = idle.app_id and t.scope = idle.scope
          returning 1
        )
        select count(*)::int as removed from gone`),
    )
    removed += row?.removed ?? 0
  }
  return removed
}
