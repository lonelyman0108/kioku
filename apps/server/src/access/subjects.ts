import { and, arrayContains, asc, count, eq, exists, gt, inArray, or, sql } from 'drizzle-orm'

import { pgErrorCode, type Tx } from '../db/client'
import {
  appGroupPersonas,
  conversationTurns,
  dreamMarks,
  extractionRuns,
  memories,
  subjectBindings,
  subjectIdentities,
  subjects,
} from '../db/schema'
import { extractionDelay, trimBatch } from '../extraction/buffer'
import type { Deps } from '../http/env'
import { subjectScope, TALK_LAYERS } from '../memory/scopes'

// 合并对象：管理界面里成员手动合并，与用绑定码合并（见 binding.ts）共用这里的规则与步骤

export type SubjectRow = typeof subjects.$inferSelect

// 等确认的绑定因为两边的对象被合并而作废时记下的原因
export const MERGED_WHILE_PENDING = '等确认期间对象被合并了'

// 按 id 的顺序锁住几个对象：同时有几次合并涉及同一批对象时不会互相等成死锁。
// 抽取或别的写入正占着这些行时不久等，等锁超过 5 秒就报错（见 isLockBusy），让用户稍后再试
export async function lockSubjects(tx: Tx, ids: string[]): Promise<SubjectRow[]> {
  await tx.execute(sql`set local lock_timeout = '5s'`)
  return tx
    .select()
    .from(subjects)
    .where(inArray(subjects.id, ids))
    .orderBy(asc(subjects.id))
    .for('update')
}

// 等锁超时（55P03）或和别的写入互相等成死锁（40P01）：事务整个回滚、什么都没改，稍后再试就行
export function isLockBusy(err: unknown): boolean {
  const code = pgErrorCode(err)
  return code === '55P03' || code === '40P01'
}

// 合并会把一边的平台账号挂到另一边的标记下：和「只能标记成自己」一样，合并的对象只能是没标记的、
// 或者标记成 member 的，否则别人的私聊就能被当作那个成员的主人私聊。member 为 null 时（没有成员在场，
// 例如没标记的对象直接用绑定码合并）都不能有标记
export function linkedToOthers(rows: readonly SubjectRow[], member: string | null): boolean {
  return rows.some((r) => r.accountId !== null && r.accountId !== member)
}

// 把 from 合并进 into（同种类，两行都已锁住）。from 的私聊（或群）这个来源作用域里记下的内容换成 into 的：
// 仍只在和这个人的私聊（这个群）里可见，合并后用哪个平台账号聊都读得到；别的群里记下的不动。
// 只改归属与作用域，不算改记忆的内容，不记进每条记忆的历史。返回缓冲里有对话被移过来的应用
async function mergeInto(
  tx: Tx,
  from: SubjectRow,
  into: SubjectRow,
): Promise<{ scope: string; apps: string[] }> {
  const oldScope = subjectScope(from.kind, from.id)
  const newScope = subjectScope(into.kind, into.id)
  await tx
    .update(subjectIdentities)
    .set({ subjectId: into.id })
    .where(eq(subjectIdentities.subjectId, from.id))
  // Dream 按记忆记下整理过的版本（dream_marks），这里不加版本，标记留着的话合并之后放到一起的记忆不会被再看，
  // 合并带来的重复也就一直留着。要再看的只有对象层与情节层：别的层的 Dream 范围和对象、来源作用域无关，合并不改变
  // 谁和谁一起看。按合并前的样子找出要放在一起看的：from 自己作用域里的（并进 into 的作用域）与关于 from 的（换成 into），
  // 以及它们要并进去的那边原有的——from 自己的作用域里有记忆时 into 自己作用域里的，关于 from 的记忆所在的作用域里
  // 关于 into 的。from 什么都带不过来时一条也不用再看
  const talk = inArray(memories.layer, [...TALK_LAYERS])
  const inFromScope = and(talk, eq(memories.originScope, oldScope))!
  const aboutFrom = and(talk, eq(memories.subjectId, from.id))!
  const together = or(
    inFromScope,
    aboutFrom,
    and(
      talk,
      eq(memories.originScope, newScope),
      exists(tx.select({ id: memories.id }).from(memories).where(inFromScope)),
    ),
    and(
      talk,
      eq(memories.subjectId, into.id),
      inArray(
        memories.originScope,
        tx.selectDistinct({ scope: memories.originScope }).from(memories).where(aboutFrom),
      ),
    ),
  )!
  // 先按 id 的顺序锁住这些记忆（FOR NO KEY UPDATE）再删标记。Dream 写标记的事务先锁住那一批（FOR SHARE SKIP LOCKED，
  // 见 dream.ts）：它先锁到的，这里等它提交；之后它遇到这里锁着的就跳过、不记，合并的事务开着时两边的都记不上。
  // 加锁与删除要分两条：一条语句只看开始时的快照，等锁期间对方提交的新标记，同一条语句里删不到
  await tx
    .select({ n: count() })
    .from(
      tx
        .select({ id: memories.id })
        .from(memories)
        .where(together)
        .orderBy(asc(memories.id))
        .for('no key update')
        .as('locked'),
    )
  await tx
    .delete(dreamMarks)
    .where(
      inArray(dreamMarks.memoryId, tx.select({ id: memories.id }).from(memories).where(together)),
    )
  await tx.update(memories).set({ subjectId: into.id }).where(eq(memories.subjectId, from.id))
  await tx.update(memories).set({ originScope: newScope }).where(eq(memories.originScope, oldScope))
  // 还没抽取的对话缓冲：发言人、群与批次一起换过来，不然删掉对象时会连带删掉它们
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
    .returning({ appId: conversationTurns.appId })
  await tx
    .update(extractionRuns)
    .set({
      // 两个都在同一批里说过话时，换完会出现两个一样的 id，去重
      subjectIds: sql`array(select distinct unnest(array_replace(${extractionRuns.subjectIds}, ${from.id}::uuid, ${into.id}::uuid)))`,
    })
    .where(arrayContains(extractionRuns.subjectIds, [from.id]))
  await tx.update(extractionRuns).set({ scope: newScope }).where(eq(extractionRuns.scope, oldScope))
  // 按群换人格：两边在同一个应用都有规则时留 into 的，其余的移过来
  await tx
    .delete(appGroupPersonas)
    .where(
      and(
        eq(appGroupPersonas.subjectId, from.id),
        inArray(
          appGroupPersonas.appId,
          tx
            .select({ appId: appGroupPersonas.appId })
            .from(appGroupPersonas)
            .where(eq(appGroupPersonas.subjectId, into.id)),
        ),
      ),
    )
  await tx
    .update(appGroupPersonas)
    .set({ subjectId: into.id })
    .where(eq(appGroupPersonas.subjectId, from.id))
  // 等确认的绑定：要并进来的一边是这两个对象之一时作废（被合并掉的不在了；保留的多了平台账号，
  // 确认时会连这些账号一起并过去，成员看到的已经不是现在的样子），并到被合并掉的对象的也作废。
  // 之后指向被合并掉的对象的记录改指向保留的，对象页里照样找得到
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
  // 只有被合并的那个标记了成员时，标记跟过来；名字与改名锁留 into 的
  await tx
    .update(subjects)
    .set({ accountId: into.accountId ?? from.accountId, updatedAt: new Date() })
    .where(eq(subjects.id, into.id))
  // 被合并掉的对象还没用的绑定码随它删掉（外键级联）
  await tx.delete(subjects).where(eq(subjects.id, from.id))
  return { scope: newScope, apps: [...new Set(moved.map((m) => m.appId))] }
}

// 合并之后要排抽取的批次：移过来的缓冲和原有的并成一批
export interface MergeOutcome {
  scope: string
  batches: { appId: string; turns: number }[]
}

// 合并（检查由调用方在同一个事务里做完）。移过来的缓冲超出上限的删最早的，提交之后用 enqueueMerged 排抽取
export async function mergeSubjects(
  tx: Tx,
  from: SubjectRow,
  into: SubjectRow,
): Promise<MergeOutcome> {
  const { scope, apps } = await mergeInto(tx, from, into)
  const batches = []
  for (const appId of apps) batches.push({ appId, turns: await trimBatch(tx, appId, scope) })
  return { scope, batches }
}

// 合并的事务提交之后排抽取：满一批的马上抽取，不满的等空闲。合并已经成了，排不上只记日志、不报错：
// 这一批等这个作用域的下一轮对话进缓冲时会再排上
export async function enqueueMerged(
  deps: Deps,
  spaceId: string,
  outcome: MergeOutcome,
): Promise<void> {
  for (const { appId, turns } of outcome.batches) {
    try {
      await deps.jobs?.enqueueExtraction(
        { spaceId, appId, scope: outcome.scope },
        extractionDelay(turns),
      )
    } catch (err) {
      console.error('合并之后排抽取失败，这一批等下一轮对话时再排', err)
    }
  }
}
