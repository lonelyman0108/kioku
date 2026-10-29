import type {
  ApplyDreamSuggestion,
  DreamApplied,
  DreamSuggestionKind,
  DreamSuggestionList,
  DreamSuggestionQuery,
  DreamVerdict,
  MemberRole,
} from '@kioku/contracts'
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm'

import { canModify, canRead, type Access } from '../access/access'
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
import { MAX_FACT_CHARS } from '../extraction/extract'
import { oneLine } from '../recall/recall'
import { readableConditions } from './filter'
import { dreamScopeNames, parseDreamScope } from './scopes'
import {
  isCurrentVersion,
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
    const rows = await tx
      .select({
        suggestion: dreamSuggestions,
        micros: sql<string>`${microsOf(dreamSuggestions.createdAt)}::text`,
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
      .limit(PAGE_SIZE + 1)
    // 总数只在第一页算：翻页时界面用的还是第一页的
    const [total] = after ? [] : await tx.select({ n: count() }).from(dreamSuggestions).where(open)
    const page = rows.slice(0, PAGE_SIZE)
    const ids = [...new Set(page.flatMap((r) => r.suggestion.memoryIds))]
    const found = ids.length
      ? await tx
          .select({ row: memories, subjectName: subjects.displayName, subjectKind: subjects.kind })
          .from(memories)
          .leftJoin(subjects, eq(subjects.id, memories.subjectId))
          .where(inArray(memories.id, ids))
      : []
    const byId = new Map(found.map((f) => [f.row.id, f]))
    const memoryRows = new Map(found.map((f) => [f.row.id, f.row]))
    const named = await dreamScopeNames(
      tx,
      page.map((r) => r.suggestion.scope),
    )
    const now = new Date()
    const last = page.at(-1)
    return {
      items: page.flatMap(({ suggestion: s }) => {
        // 两次查询之间涉及的记忆被改过（例如移进了别人的私人层、改了正文）或清掉了：这条建议作废，不列
        if (!listable(s, memoryRows, access, now)) return []
        const involved = s.memoryIds.map((id) => byId.get(id)!)
        return {
          id: s.id,
          kind: s.kind as DreamSuggestionKind,
          scope: named(s.scope),
          reason: s.reason,
          memories: involved.map(({ row, subjectName, subjectKind }) => ({
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
          actionable: role !== 'viewer' && involved.every(({ row }) => canModify(access, row)),
          createdAt: s.createdAt.toISOString(),
        }
      }),
      total: after ? null : (total?.n ?? 0),
      nextCursor:
        rows.length > PAGE_SIZE && last ? encodeTimeCursor(last.micros, last.suggestion.id) : null,
    }
  })
}

// 一条建议现在还能不能列给查看者：涉及的每条记忆都还作数（isCurrentVersion，和列表的 SQL 条件、执行时的核对是同一条规则），
// 查看者按管理读取也都读得到（canRead，readableConditions 的 JS 版本）。行是在列表的第二次查询里取的
export function listable(
  suggestion: Pick<SuggestionRow, 'memoryIds' | 'versions'>,
  rows: ReadonlyMap<string, MemoryRow>,
  access: Access,
  now: Date,
): boolean {
  return suggestion.memoryIds.every((id, i) => {
    const row = rows.get(id)
    return (
      isCurrentVersion(row, suggestion.versions[i]!, now) &&
      canRead(access, row!, { personaIds: [], management: true })
    )
  })
}

// 锁住一条建议交给记忆服务；要做的事按建议与成员的修改给出（只在确认查看者看得到它之后才取）
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
      action: () => actionOf(row, edits),
    }
  }
}

// 建议加上成员执行前的修改：合并只能改正文，提炼能改草稿的 URI、层、正文与 disclosure，过时与审核没有能改的。
// 合并对象与情节里的事实时，合并后的还是一条事实：一句话，长度和抽取的事实一样有上限
function actionOf(row: SuggestionRow, edits: ApplyDreamSuggestion): SuggestionAction {
  const extra = (allowed: (keyof ApplyDreamSuggestion)[]) =>
    (Object.keys(edits) as (keyof ApplyDreamSuggestion)[]).some(
      (key) => edits[key] !== undefined && !allowed.includes(key),
    )
  switch (row.kind as DreamSuggestionKind) {
    case 'merge': {
      if (extra(['content'])) throw new MemoryError(400, '合并只能改合并后的正文')
      let content = edits.content ?? row.content ?? ''
      if (parseDreamScope(row.scope)?.kind === 'talk') {
        content = oneLine(content)
        if (!content || [...content].length > MAX_FACT_CHARS) {
          throw new MemoryError(400, `合并后的事实是一句话，不超过 ${MAX_FACT_CHARS} 个字`)
        }
      }
      if (!content.trim()) throw new MemoryError(400, '合并后的正文不能为空')
      return { kind: 'merge', keepId: row.keepId!, content }
    }
    case 'distill':
      return {
        kind: 'distill',
        draft: {
          uri: edits.uri ?? row.uri!,
          ...(edits.layer ? { layer: edits.layer } : {}),
          content: edits.content ?? row.content ?? '',
          disclosure: edits.disclosure === undefined ? row.disclosure : edits.disclosure || null,
        },
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
