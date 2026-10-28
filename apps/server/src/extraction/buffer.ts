import type { TurnEndEvent } from '@kioku/contracts'
import { and, count, eq, lt, sql } from 'drizzle-orm'

import type { KeySession } from '../access/session'
import { withSpace, type Db } from '../db/client'
import { conversationTurns, spaces } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import { accessForKey } from '../memory/context'

// 攒满这么多轮就马上排一次抽取；不满时等会话空闲这么久再抽取
export const BATCH_TURNS = 10
export const IDLE_SECONDS = 600
// 每个会话最多留这么多轮：抽取一直失败（例如模型出错）时丢掉最早的，缓冲不会无限长
export const MAX_BUFFERED_TURNS = 100
// 缓冲里放了这么久的对话直接删：正常情况下早就抽取完了，留下的是抽取不了的
export const BUFFER_TTL_HOURS = 24

// 一个会话的缓冲：按应用与会话分
export interface BufferedSession {
  spaceId: string
  appId: string
  sessionId: string
}

// 把一轮对话放进会话缓冲，返回是否放进去了，并按轮数或空闲时间排抽取任务（同一个会话只排一个，
// 空闲计时从最后一轮算起）。Key 写不了对象层与情节层时，抽取出的东西也写不进去，不必存下别人的话
export async function bufferTurn(
  deps: Deps,
  key: KeyPrincipal,
  session: KeySession,
  input: TurnEndEvent,
): Promise<boolean> {
  const access = accessForKey(key, session)
  if (!access.writeLayers.has('subject') && !access.writeLayers.has('episode')) return false
  const { context } = session
  const target: BufferedSession = {
    spaceId: key.spaceId,
    appId: key.app.id,
    sessionId: input.sessionId,
  }
  const buffered = await withSpace(deps.db, key.spaceId, async (tx) => {
    await tx.insert(conversationTurns).values({
      spaceId: key.spaceId,
      appId: key.app.id,
      keyId: key.keyId,
      sessionId: input.sessionId,
      // 契约保证 turn.end 是私聊、群聊或频道，并且带着发言人
      chatType: context.chatType!,
      groupSubjectId: context.groupSubjectId ?? null,
      senderSubjectId: context.senderSubjectId!,
      senderName: session.subjects.find((s) => s.role === 'sender')?.name ?? null,
      userText: input.user,
      replyText: input.reply,
    })
    const inSession = and(
      eq(conversationTurns.appId, key.app.id),
      eq(conversationTurns.sessionId, input.sessionId),
    )
    await tx.execute(sql`
      delete from ${conversationTurns}
      where ${inSession} and ${conversationTurns.id} <= (
        select ${conversationTurns.id} from ${conversationTurns} where ${inSession}
        order by ${conversationTurns.id} desc offset ${MAX_BUFFERED_TURNS} limit 1
      )`)
    const [row] = await tx.select({ n: count() }).from(conversationTurns).where(inSession)
    return row!.n
  })
  void deps.jobs?.enqueueExtraction(target, buffered >= BATCH_TURNS ? 0 : IDLE_SECONDS)
  return true
}

// 丢掉一个会话的缓冲，返回删了几轮。upTo 给了时只删到这一轮（含），之后新进来的留着
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
          eq(conversationTurns.sessionId, target.sessionId),
          upTo === undefined ? undefined : sql`${conversationTurns.id} <= ${upTo}`,
        ),
      )
      .returning({ id: conversationTurns.id }),
  )
  return gone.length
}

// 删掉放了超过 BUFFER_TTL_HOURS 的对话。内容表开了 RLS，逐个空间处理
export async function pruneConversationTurns(db: Db): Promise<number> {
  const all = await db.select({ id: spaces.id }).from(spaces)
  let removed = 0
  for (const space of all) {
    const gone = await withSpace(db, space.id, (tx) =>
      tx
        .delete(conversationTurns)
        .where(
          lt(
            conversationTurns.createdAt,
            sql`now() - make_interval(hours => ${BUFFER_TTL_HOURS}::int)`,
          ),
        )
        .returning({ id: conversationTurns.id }),
    )
    removed += gone.length
  }
  return removed
}
