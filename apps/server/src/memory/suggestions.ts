import type {
  ApplyDreamSuggestion,
  DreamApplied,
  DreamSuggestionKind,
  DreamSuggestionList,
  DreamSuggestionQuery,
  DreamVerdict,
  MemberRole,
} from '@kioku/contracts'
import { and, desc, eq, sql } from 'drizzle-orm'

import { canModify } from '../access/access'
import { withSpace, type Db, type Tx } from '../db/client'
import {
  decodeTimeCursor,
  encodeTimeCursor,
  fromMicros,
  INVALID_CURSOR,
  microsOf,
  UUID,
} from '../db/paging'
import { dreamSuggestions, memories, subjects } from '../db/schema'
import {
  disclosureProblem,
  draftProblem,
  factProblem,
  mergedNodeProblem,
} from '../extraction/dreamText'
import { oneLine } from '../recall/recall'
import { readableConditions } from './filter'
import { dreamScopeNames, parseDreamScope } from './scopes'
import {
  MemoryError,
  suggestionCurrent,
  type LockedSuggestion,
  type MemoryService,
  type SuggestionAction,
} from './service'
import { formatUri } from './uri'

type MemoryRow = typeof memories.$inferSelect

// 待审里的「建议」：Dream 提出、还没处理的建议。查看者看得到的（涉及的每条记忆按管理读取都读得到），
// 并且涉及的记忆都还是生成建议时的那一版、没删除、现在有效：之后改过的建议作废，不再列出，
// 等下次整理按新的内容再提。执行与拒绝见 MemoryService.applySuggestion、rejectSuggestion

const PAGE_SIZE = 50

type SuggestionRow = typeof dreamSuggestions.$inferSelect

interface Involved {
  row: MemoryRow
  subjectName: string | null
  subjectKind: (typeof subjects.$inferSelect)['kind'] | null
}

export async function listSuggestions(
  db: Db,
  spaceId: string,
  service: MemoryService,
  role: MemberRole,
  query: DreamSuggestionQuery,
): Promise<DreamSuggestionList> {
  const after = decodeTimeCursor(query.cursor, UUID)
  if (after === 'invalid') throw new MemoryError(400, INVALID_CURSOR)
  const access = service.access
  const open = and(
    eq(dreamSuggestions.status, 'pending'),
    suggestionCurrent(dreamSuggestions.memoryIds, dreamSuggestions.versions, {
      extra: readableConditions(access, { personaIds: [], management: true }),
    }),
  )
  return withSpace(db, spaceId, async (tx) => {
    // 这一页的建议、它们涉及的记忆与总数在同一条查询里取：哪些建议还作数、列出来的记忆是哪一版、总数，
    // 都按同一个快照与同一个时钟（数据库的）判断，列出的与总数对得上，取到的记忆也就是判断时的那一版
    const page = tx.$with('page').as(
      tx
        .select({
          id: dreamSuggestions.id,
          createdAt: dreamSuggestions.createdAt,
          micros: sql<string>`${microsOf(dreamSuggestions.createdAt)}::text`.as('micros'),
          total: sql<number>`count(*) over ()`.mapWith(Number).as('total'),
        })
        .from(dreamSuggestions)
        .where(
          and(
            open,
            after
              ? sql`(${dreamSuggestions.createdAt}, ${dreamSuggestions.id}) < (${fromMicros(after[0])}, ${after[1]}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(dreamSuggestions.createdAt), desc(dreamSuggestions.id))
        .limit(PAGE_SIZE + 1),
    )
    const rows = await tx
      .with(page)
      .select({
        suggestion: dreamSuggestions,
        micros: page.micros,
        total: page.total,
        memory: memories,
        subjectName: subjects.displayName,
        subjectKind: subjects.kind,
      })
      .from(page)
      .innerJoin(dreamSuggestions, eq(dreamSuggestions.id, page.id))
      .innerJoin(memories, sql`${memories.id} = any(${dreamSuggestions.memoryIds})`)
      .leftJoin(subjects, eq(subjects.id, memories.subjectId))
      .orderBy(desc(page.createdAt), desc(page.id))
    const found = new Map<
      string,
      { suggestion: SuggestionRow; micros: string; involved: Map<string, Involved> }
    >()
    for (const r of rows) {
      let entry = found.get(r.suggestion.id)
      if (!entry) {
        entry = { suggestion: r.suggestion, micros: r.micros, involved: new Map() }
        found.set(r.suggestion.id, entry)
      }
      entry.involved.set(r.memory.id, {
        row: r.memory,
        subjectName: r.subjectName,
        subjectKind: r.subjectKind,
      })
    }
    const all = [...found.values()]
    const shown = all.slice(0, PAGE_SIZE)
    const named = await dreamScopeNames(
      tx,
      shown.map((e) => e.suggestion.scope),
    )
    const last = shown.at(-1)
    return {
      items: shown.map(({ suggestion: s, involved }) => {
        // 条件里核对过每条涉及的记忆都在、读得到，同一条查询里一定取得到
        const items = s.memoryIds.map((id) => involved.get(id)!)
        return {
          id: s.id,
          kind: s.kind as DreamSuggestionKind,
          scope: named(s.scope),
          reason: s.reason,
          memories: items.map(({ row, subjectName, subjectKind }) => ({
            id: row.id,
            uri: row.domain && row.path ? formatUri(row.domain, row.path) : null,
            layer: row.layer,
            sensitivity: row.sensitivity,
            provenance: row.provenance,
            content: row.content ?? '',
            subject:
              row.subjectId && subjectName && subjectKind
                ? { id: row.subjectId, kind: subjectKind, displayName: subjectName }
                : null,
            updatedAt: row.updatedAt.toISOString(),
          })),
          keepId: s.keepId,
          content: s.content,
          uri: s.uri,
          disclosure: s.disclosure,
          verdict: s.verdict as DreamVerdict | null,
          actionable: role !== 'viewer' && items.every(({ row }) => canModify(access, row)),
          createdAt: s.createdAt.toISOString(),
        }
      }),
      // 总数只在第一页给：翻页时界面用的还是第一页的
      total: after ? null : (rows[0]?.total ?? 0),
      nextCursor:
        all.length > PAGE_SIZE && last ? encodeTimeCursor(last.micros, last.suggestion.id) : null,
    }
  })
}

// 锁住一条建议交给记忆服务；要做的事按建议、成员的修改与锁住的记忆给出（只在确认查看者看得到它之后才取）
function lockSuggestion(id: string, edits: ApplyDreamSuggestion = {}) {
  return async (tx: Tx): Promise<LockedSuggestion | null> => {
    const [row] = await tx
      .select()
      .from(dreamSuggestions)
      .where(eq(dreamSuggestions.id, id))
      .for('update')
    if (!row) return null
    return {
      memories: row.memoryIds.map((memoryId, i) => ({ id: memoryId, version: row.versions[i]! })),
      pending: row.status === 'pending',
      action: (sources) => actionOf(row, edits, sources),
    }
  }
}

// 建议加上成员执行前的修改：合并只能改正文，提炼能改草稿的 URI、层、正文与 disclosure，过时与审核没有能改的。
// 要写进记忆的文字（改过的或原样的）和模型给的过同一套检查（见 extraction/dreamText.ts），不合规返回 400：
// 合并对象与情节里的事实时，合并后的还是一条事实，一句话；合并策展记忆时只能带合并的几条（sources）里本来就有的占位符
function actionOf(
  row: SuggestionRow,
  edits: ApplyDreamSuggestion,
  sources: readonly MemoryRow[],
): SuggestionAction {
  const extra = (allowed: (keyof ApplyDreamSuggestion)[]) =>
    (Object.keys(edits) as (keyof ApplyDreamSuggestion)[]).some(
      (key) => edits[key] !== undefined && !allowed.includes(key),
    )
  const check = (problem: string | null) => {
    if (problem) throw new MemoryError(400, problem)
  }
  switch (row.kind as DreamSuggestionKind) {
    case 'merge': {
      if (extra(['content'])) throw new MemoryError(400, '合并只能改合并后的正文')
      const text = edits.content ?? row.content ?? ''
      if (parseDreamScope(row.scope)?.kind === 'talk') {
        const content = oneLine(text)
        check(factProblem(content))
        return { kind: 'merge', keepId: row.keepId!, content }
      }
      const content = text.trim()
      check(
        mergedNodeProblem(
          content,
          sources.map((s) => s.content),
        ),
      )
      return { kind: 'merge', keepId: row.keepId!, content }
    }
    case 'distill': {
      const content = (edits.content ?? row.content ?? '').trim()
      check(draftProblem(content))
      const disclosure =
        edits.disclosure === undefined
          ? row.disclosure
          : edits.disclosure
            ? oneLine(edits.disclosure)
            : null
      if (disclosure) check(disclosureProblem(disclosure))
      return {
        kind: 'distill',
        draft: {
          uri: edits.uri ?? row.uri!,
          ...(edits.layer ? { layer: edits.layer } : {}),
          content,
          disclosure,
        },
      }
    }
    case 'stale':
      if (extra([])) throw new MemoryError(400, '这条建议没有能改的内容')
      return { kind: 'stale' }
    case 'review':
      if (extra([])) throw new MemoryError(400, '这条建议没有能改的内容')
      return { kind: 'review', verdict: row.verdict as DreamVerdict }
  }
}

// 把建议标成处理过了，记下是谁、什么时候
function settle(id: string, status: 'applied' | 'rejected', accountId: string) {
  return async (tx: Tx) => {
    await tx
      .update(dreamSuggestions)
      .set({ status, decidedBy: accountId, decidedAt: new Date() })
      .where(eq(dreamSuggestions.id, id))
  }
}

export async function applySuggestion(
  service: MemoryService,
  suggestionId: string,
  edits: ApplyDreamSuggestion,
  accountId: string,
): Promise<DreamApplied> {
  const created = await service.applySuggestion(
    lockSuggestion(suggestionId, edits),
    settle(suggestionId, 'applied', accountId),
    { source: 'dream', suggestionId },
  )
  return { memory: created && { id: created.id, uri: created.uri } }
}

export async function rejectSuggestion(
  service: MemoryService,
  suggestionId: string,
  accountId: string,
): Promise<void> {
  await service.rejectSuggestion(
    lockSuggestion(suggestionId),
    settle(suggestionId, 'rejected', accountId),
  )
}
