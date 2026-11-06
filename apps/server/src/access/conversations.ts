import type {
  ConversationDetail,
  ConversationInfo,
  ConversationKind,
  ExtractionRunInfo,
} from '@kioku/contracts'
import { and, desc, eq, exists, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'

import type { Tx } from '../db/client'
import { microsOf } from '../db/paging'
import { accounts, apps, conversations, extractionRuns, memories, subjects } from '../db/schema'
import { readableConditions } from '../memory/filter'
import { scopeNames } from '../memory/scopes'
import { clipChars, oneLine } from '../recall/text'
import type { Access } from './access'

// 会话的读取：对话页的会话列表与详情、联系人详情里参与的会话。
// 看得到哪些：群聊、私聊的会话空间成员都看得到（和联系人一样）；不带会话上下文的会话只有所属成员本人看得到。
// 摘要与事实照记忆的读权限（readableConditions）另外过滤

// 列表里最新一段摘要的开头最多这么多字
const EXCERPT_CHARS = 120
// 详情里各部分最多列这么多条
const DETAIL_SUMMARIES = 100
const DETAIL_FACTS = 200
const DETAIL_RUNS = 20
// 联系人详情里最多列这么多个参与的会话
const PARTICIPATED_LIMIT = 50

// 当前账号看得到的会话
export function visibleConversations(access: Access): SQL {
  return or(
    isNull(conversations.ownerAccountId),
    eq(conversations.ownerAccountId, access.ownerAccountId),
  )!
}

// 来自对话的记忆不分人格，读权限里的人格限制用不上
const readable = (access: Access) => readableConditions(access, { personaIds: [] })

// 挂在会话上的、当前账号读得到的会话摘要
const summariesOf = (access: Access) =>
  and(eq(memories.form, 'extracted'), eq(memories.layer, 'episode'), readable(access))!

// 在会话里听到、记在联系人身上的、现在有效的事实
const factsOf = (access: Access) =>
  and(eq(memories.form, 'extracted'), eq(memories.layer, 'subject'), readable(access))!

export interface ConversationRow {
  info: ConversationInfo
  // 翻页用：最近活动时间的微秒数
  activeMicros: string
}

// 按条件取会话，带上应用、联系人或所属成员的名字、最新一段摘要与摘要条数。按最近活动从新到旧
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
      appName: apps.name,
      subjectKind: subjects.kind,
      subjectName: subjects.displayName,
      ownerName: accounts.displayName,
    })
    .from(conversations)
    .innerJoin(apps, eq(apps.id, conversations.appId))
    .leftJoin(subjects, eq(subjects.id, conversations.subjectId))
    .leftJoin(accounts, eq(accounts.id, conversations.ownerAccountId))
    .where(and(visibleConversations(access), where))
    .orderBy(desc(conversations.lastActiveAt), desc(conversations.id))
    .limit(limit)
  if (!rows.length) return []
  const ids = rows.map((r) => r.conversation.id)
  const inPage = and(inArray(memories.conversationId, ids), summariesOf(access))
  const [counts, latest] = await Promise.all([
    tx
      .select({ id: memories.conversationId, n: sql<number>`count(*)::int` })
      .from(memories)
      .where(inPage)
      .groupBy(memories.conversationId),
    tx
      .selectDistinctOn([memories.conversationId], {
        id: memories.conversationId,
        content: memories.content,
        createdAt: memories.createdAt,
      })
      .from(memories)
      .where(inPage)
      .orderBy(memories.conversationId, desc(memories.createdAt), desc(memories.id)),
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
        kind: c.kind as ConversationKind,
        app: { id: c.appId, name: r.appName },
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

// 联系人参与的会话：群聊时这个群的、私聊时和这个人的会话，以及这个人说过话的群（在那里记下了关于他的事实，
// 或抽取记录涉及他）
export async function participatedConversations(
  tx: Tx,
  access: Access,
  subjectId: string,
): Promise<ConversationInfo[]> {
  const heard = tx
    .select({ one: sql`1` })
    .from(memories)
    .where(
      and(
        eq(memories.conversationId, conversations.id),
        eq(memories.subjectId, subjectId),
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

type RunRow = { run: typeof extractionRuns.$inferSelect; appName: string | null }

// 抽取记录换成界面上的样子。conversationIds 是当前账号看得到的会话，别的会话的 id 不给；
// errorOf 决定失败原因给谁看原文（见 routes/subjects.ts）
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
  return rows.map(({ run, appName }) => ({
    id: run.id,
    createdAt: run.createdAt.toISOString(),
    app: appName ? { id: run.appId, name: appName } : null,
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

// 这些会话里当前账号看得到的那些
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

// 会话详情；看不到与不存在都返回 null
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
      .select()
      .from(memories)
      .where(and(eq(memories.conversationId, id), summariesOf(access)))
      .orderBy(desc(memories.createdAt), desc(memories.id))
      .limit(DETAIL_SUMMARIES),
    tx
      .select({ fact: memories, subjectKind: subjects.kind, subjectName: subjects.displayName })
      .from(memories)
      .innerJoin(subjects, eq(subjects.id, memories.subjectId))
      .where(and(eq(memories.conversationId, id), factsOf(access)))
      .orderBy(desc(memories.updatedAt), desc(memories.id))
      .limit(DETAIL_FACTS),
    tx
      .select({ run: extractionRuns, appName: apps.name })
      .from(extractionRuns)
      .leftJoin(apps, eq(apps.id, extractionRuns.appId))
      .where(eq(extractionRuns.conversationId, id))
      .orderBy(desc(extractionRuns.createdAt), desc(extractionRuns.id))
      .limit(DETAIL_RUNS),
  ])
  return {
    ...found.info,
    summaries: summaries.map((s) => ({
      id: s.id,
      content: s.content ?? '',
      provenance: s.provenance,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt?.toISOString() ?? null,
    })),
    facts: facts.map(({ fact, subjectKind, subjectName }) => ({
      id: fact.id,
      content: fact.content ?? '',
      provenance: fact.provenance,
      subject: { id: fact.subjectId!, kind: subjectKind, displayName: subjectName },
      version: fact.version,
      createdAt: fact.createdAt.toISOString(),
      updatedAt: fact.updatedAt.toISOString(),
    })),
    runs: await runInfos(tx, runs, new Set([id]), errorOf),
  }
}
