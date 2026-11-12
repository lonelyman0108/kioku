import type {
  ConversationDetail,
  ConversationInfo,
  ConversationKind,
  ExtractionRunInfo,
  SessionSummary,
} from '@kioku/contracts'
import { and, desc, eq, exists, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm'

import { nowOf, type Tx } from '../db/client'
import { microsOf } from '../db/paging'
import { accounts, apps, conversations, extractionRuns, memories, subjects } from '../db/schema'
import { readableConditions } from '../memory/filter'
import { scopeNames } from '../memory/scopes'
import { clipChars, oneLine } from '../recall/text'
import type { Access, SessionContext } from './access'

// 会话的读取：对话页的会话列表与详情、联系人详情里参与的会话；文件末尾是会话的建立。
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

// 来自对话的记忆不分人格，读权限里的人格限制用不上。now 是判断有效期的时刻（事务开头取的数据库时间，
// 不给时同样默认用它，见 momentSql）：一个片段在几条语句里用时，几条拿同一个时刻比
const readable = (access: Access, now?: Date) =>
  readableConditions(access, { personaIds: [], ...(now ? { now } : {}) })

// 挂在会话上的、当前账号读得到的会话摘要
const summariesOf = (access: Access, now?: Date) =>
  and(eq(memories.form, 'extracted'), eq(memories.layer, 'episode'), readable(access, now))!

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
  // 条数与最新一段在两条语句里算，拿同一个时刻比
  const inPage = and(inArray(memories.conversationId, ids), summariesOf(access, nowOf(tx)))
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

// ---- 会话的建立 ----

// 一个会话按（应用、群）、（应用、私聊的人）、（应用、所属成员）认；频道和群一样按群认
export type ConversationRef =
  { kind: 'group' | 'direct'; subjectId: string } | { kind: 'none'; ownerAccountId: string }

// 一次请求的会话上下文落在哪个会话上。不带会话上下文的归应用所有者；定时任务与子 Agent 不算会话
export function conversationRefOf(
  context: SessionContext,
  appOwnerAccountId: string,
): ConversationRef | null {
  if (!context.chatType) return { kind: 'none', ownerAccountId: appOwnerAccountId }
  if (context.chatType === 'group' || context.chatType === 'channel') {
    return context.groupSubjectId ? { kind: 'group', subjectId: context.groupSubjectId } : null
  }
  if (context.chatType === 'direct') {
    return context.senderSubjectId ? { kind: 'direct', subjectId: context.senderSubjectId } : null
  }
  return null
}

const refValues = (spaceId: string, appId: string, ref: ConversationRef) => ({
  spaceId,
  appId,
  kind: ref.kind,
  subjectId: ref.kind === 'none' ? null : ref.subjectId,
  ownerAccountId: ref.kind === 'none' ? ref.ownerAccountId : null,
})
// 两个唯一索引各管一种：群聊、私聊按联系人，不带会话上下文的按所属成员（空值不算重复）
const refTarget = (ref: ConversationRef) =>
  ref.kind === 'none'
    ? [conversations.appId, conversations.ownerAccountId]
    : [conversations.appId, conversations.subjectId]
const refMatch = (appId: string, ref: ConversationRef) =>
  and(
    eq(conversations.appId, appId),
    ref.kind === 'none'
      ? eq(conversations.ownerAccountId, ref.ownerAccountId)
      : eq(conversations.subjectId, ref.subjectId),
  )!

// 生命周期事件来时建立会话，已有的更新最近活动。时间都用数据库的 now()：测试台按 created_at = now()
// 认这个事务写下的行，并发的两次请求也只建出一个（唯一索引上的 on conflict）。
// 每轮都有好几个生命周期事件：最近活动早于一分钟以前才更新，否则不写这一行（列表的先后最多差一分钟）。
// 最近活动在将来（时钟偏差、合并联系人时带过来的时间）也更新，否则它一直停在那里
export async function touchConversation(
  tx: Tx,
  spaceId: string,
  appId: string,
  ref: ConversationRef,
): Promise<void> {
  await tx
    .insert(conversations)
    .values(refValues(spaceId, appId, ref))
    .onConflictDoUpdate({
      target: refTarget(ref),
      set: { lastActiveAt: sql`now()` },
      setWhere: sql`${conversations.lastActiveAt} < now() - interval '1 minute' or ${conversations.lastActiveAt} > now()`,
    })
}

// 抽取写入时这一批的会话：没有就建（例如会话被删掉之后这一批才抽取），不推进最近活动
export async function ensureConversation(
  tx: Tx,
  spaceId: string,
  appId: string,
  ref: ConversationRef,
): Promise<string> {
  const [created] = await tx
    .insert(conversations)
    .values(refValues(spaceId, appId, ref))
    .onConflictDoNothing({ target: refTarget(ref) })
    .returning({ id: conversations.id })
  if (created) return created.id
  return (await findConversation(tx, appId, ref))!
}

// 已有的会话，不建
export async function findConversation(
  tx: Tx,
  appId: string,
  ref: ConversationRef,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(refMatch(appId, ref))
  return row?.id ?? null
}

// 一个会话最近的几段会话摘要，新的在前：不带会话上下文的会话开始时附上，接着上次的话题。
// 会被当作指令级上下文，只收受信来源写下的（不带会话上下文的摘要都是）；读权限照这次的 Key
export async function latestSummaries(
  tx: Tx,
  access: Access,
  appId: string,
  ref: ConversationRef,
  limit: number,
): Promise<SessionSummary[]> {
  const rows = await tx
    .select({ content: memories.content, createdAt: memories.createdAt })
    .from(memories)
    .innerJoin(conversations, eq(conversations.id, memories.conversationId))
    .where(and(refMatch(appId, ref), summariesOf(access), ne(memories.provenance, 'untrusted')))
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .limit(limit)
  return rows.map((r) => ({ content: r.content ?? '', createdAt: r.createdAt.toISOString() }))
}
