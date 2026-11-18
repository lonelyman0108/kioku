import type {
  ApplyDreamSuggestion,
  DreamApplied,
  DreamScope,
  DreamSuggestionKind,
  DreamSuggestionList,
  DreamSuggestionQuery,
  DreamVerdict,
  MemberRole,
  VariantInput,
  WhenCondition,
} from '@kioku/contracts'
import { normalizeWhen } from '@kioku/contracts'
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm'

import { canModify, type Access } from '../access/access'
import { withCircle, type Db, type Tx } from '../db/client'
import {
  decodeTimeCursor,
  encodeTimeCursor,
  fromMicros,
  INVALID_CURSOR,
  microsOf,
  UUID,
} from '../db/paging'
import {
  accounts,
  circles,
  conversations,
  dreamSuggestions,
  entries,
  entryVariants,
  subjects,
} from '../db/schema'
import {
  disclosureProblem,
  draftProblem,
  factProblem,
  mergedNodeProblem,
} from '../extraction/dreamText'
import { oneLine } from '../recall/text'
import { readableConditions } from './filter'
import { parseDreamScope, scopeNames } from './scopes'
import {
  MemoryError,
  suggestionCurrent,
  type EntryRow,
  type EntryService,
  type LockedSuggestion,
  type SuggestionAction,
} from './service'

// 待处理里的「建议」：Dream 提出、还没处理的建议。查看者看得到的（涉及的每条词条按管理读取都读得到），
// 并且涉及的词条都还是生成建议时的那一版、没删除、现在有效

const PAGE_SIZE = 50
type SuggestionRow = typeof dreamSuggestions.$inferSelect

interface Involved {
  row: EntryRow
  when: WhenCondition
  content: string
  subjectName: string | null
  subjectKind: (typeof subjects.$inferSelect)['kind'] | null
}

function openSuggestions(access: Access, now?: Date) {
  return and(
    eq(dreamSuggestions.status, 'pending'),
    suggestionCurrent(dreamSuggestions.entryIds, dreamSuggestions.versions, {
      ...(now ? { at: now } : {}),
      extra: readableConditions(access, { ...(now ? { now } : {}), management: true }),
    }),
  )
}

export async function openSuggestionCount(tx: Tx, access: Access): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(dreamSuggestions)
    .where(openSuggestions(access))
  return row?.n ?? 0
}

export async function resolveDreamScopes(
  tx: Tx,
  circleId: string,
  circleName: string,
  keys: readonly string[],
): Promise<(key: string) => DreamScope> {
  const parsed = keys.map((k) => ({ key: k, scope: parseDreamScope(k) }))
  const originKeys = parsed.flatMap((p) =>
    p.scope?.kind === 'talk' && p.scope.origin ? [p.scope.origin] : [],
  )
  const accountIds = parsed.flatMap((p) =>
    p.scope?.kind === 'personal' && p.scope.id ? [p.scope.id] : [],
  )
  const convIds = parsed.flatMap((p) =>
    p.scope?.kind === 'local_session' && p.scope.id ? [p.scope.id] : [],
  )

  const [originResolver, accRows, convRows] = await Promise.all([
    scopeNames(tx, originKeys),
    accountIds.length
      ? tx
          .select({ id: accounts.id, name: accounts.displayName })
          .from(accounts)
          .where(inArray(accounts.id, accountIds))
      : [],
    convIds.length
      ? tx
          .select({
            id: conversations.id,
            deviceKey: conversations.deviceKey,
            projectSlug: conversations.projectSlug,
          })
          .from(conversations)
          .where(inArray(conversations.id, convIds))
      : [],
  ])

  const accNames = new Map(accRows.map((a) => [a.id, a.name]))
  const convNames = new Map(
    convRows.map((c) => [c.id, [c.deviceKey, c.projectSlug].filter(Boolean).join(' / ') || c.id]),
  )

  return (key: string): DreamScope => {
    const s = parseDreamScope(key)
    if (!s) return { kind: 'circle', id: circleId, name: circleName, origin: null }
    switch (s.kind) {
      case 'circle':
        return { kind: 'circle', id: circleId, name: circleName, origin: null }
      case 'personal':
        return {
          kind: 'personal',
          id: s.id,
          name: (s.id && accNames.get(s.id)) ?? null,
          origin: null,
        }
      case 'talk': {
        const origin = s.origin ? originResolver(s.origin) : null
        return { kind: 'talk', id: null, name: origin?.name ?? null, origin }
      }
      case 'local_session':
        return {
          kind: 'local_session',
          id: s.id,
          name: (s.id && convNames.get(s.id)) ?? null,
          origin: null,
        }
      default:
        return { kind: 'circle', id: circleId, name: circleName, origin: null }
    }
  }
}

export async function listSuggestions(
  db: Db,
  circleId: string,
  service: EntryService,
  role: MemberRole,
  query: DreamSuggestionQuery,
): Promise<DreamSuggestionList> {
  const after = decodeTimeCursor(query.cursor, UUID)
  if (after === 'invalid') throw new MemoryError(400, INVALID_CURSOR)
  const access = service.access
  return withCircle(
    db,
    circleId,
    async (tx, now) => {
      const [circleRow] = await tx
        .select({ name: circles.name })
        .from(circles)
        .where(eq(circles.id, circleId))
        .limit(1)
      const open = openSuggestions(access, now)
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
          entry: entries,
          subjectName: subjects.displayName,
          subjectKind: subjects.kind,
        })
        .from(page)
        .innerJoin(dreamSuggestions, eq(dreamSuggestions.id, page.id))
        .innerJoin(entries, sql`${entries.id} = any(${dreamSuggestions.entryIds})`)
        .leftJoin(subjects, eq(subjects.id, entries.subjectId))
        .orderBy(desc(page.createdAt), desc(page.id))

      const entryIds = [...new Set(rows.map((r) => r.entry.id))]
      const vRows = entryIds.length
        ? await tx
            .select({
              entryId: entryVariants.entryId,
              when: entryVariants.when,
              content: entryVariants.content,
            })
            .from(entryVariants)
            .where(inArray(entryVariants.entryId, entryIds))
        : []
      const primaryVariant = new Map<string, { when: WhenCondition; content: string }>()
      for (const v of vRows) {
        if (!primaryVariant.has(v.entryId)) {
          primaryVariant.set(v.entryId, {
            when: normalizeWhen(v.when),
            content: v.content ?? '',
          })
        }
      }

      const found = new Map<
        string,
        { suggestion: SuggestionRow; micros: string; involved: Map<string, Involved> }
      >()
      for (const r of rows) {
        let item = found.get(r.suggestion.id)
        if (!item) {
          item = { suggestion: r.suggestion, micros: r.micros, involved: new Map() }
          found.set(r.suggestion.id, item)
        }
        const pv = primaryVariant.get(r.entry.id)
        item.involved.set(r.entry.id, {
          row: r.entry,
          when: pv?.when ?? {},
          content: pv?.content ?? '',
          subjectName: r.subjectName,
          subjectKind: r.subjectKind,
        })
      }

      const all = [...found.values()]
      const shown = all.slice(0, PAGE_SIZE)
      const named = await resolveDreamScopes(
        tx,
        circleId,
        circleRow?.name ?? '',
        shown.map((e) => e.suggestion.scope),
      )
      const last = shown.at(-1)

      return {
        items: shown.map(({ suggestion: s, involved }) => {
          const involvedEntries = s.entryIds.map((id) => involved.get(id)!)
          return {
            id: s.id,
            kind: s.kind as DreamSuggestionKind,
            scope: named(s.scope),
            reason: s.reason,
            entries: involvedEntries.map(({ row, when, content, subjectName, subjectKind }) => ({
              id: row.id,
              shortId: row.shortId,
              title: row.title,
              kind: row.kind,
              sensitivity: row.sensitivity,
              provenance: row.provenance,
              topics: [...row.topics],
              when,
              content,
              subject:
                row.subjectId && subjectName && subjectKind
                  ? { id: row.subjectId, kind: subjectKind, displayName: subjectName }
                  : null,
              updatedAt: row.updatedAt.toISOString(),
            })),
            keepId: s.keepId,
            title: s.title,
            content: s.content,
            variants: (s.variants as VariantInput[] | null) ?? null,
            when: (s.when as WhenCondition | null) ?? null,
            topics: s.topics ?? null,
            disclosure: s.disclosure,
            verdict: s.verdict as DreamVerdict | null,
            targetPriority: s.targetPriority ?? null,
            actionable:
              role !== 'viewer' && involvedEntries.every(({ row }) => canModify(access, row)),
            createdAt: s.createdAt.toISOString(),
          }
        }),
        total: after ? null : (rows[0]?.total ?? 0),
        nextCursor:
          all.length > PAGE_SIZE && last ? encodeTimeCursor(last.micros, last.suggestion.id) : null,
      }
    },
    { accessMode: 'read only' },
  )
}

function lockSuggestion(id: string, edits: ApplyDreamSuggestion = {}) {
  return async (tx: Tx): Promise<LockedSuggestion | null> => {
    const [row] = await tx
      .select()
      .from(dreamSuggestions)
      .where(eq(dreamSuggestions.id, id))
      .for('update')
    if (!row) return null
    return {
      entries: row.entryIds.map((entryId, i) => ({ id: entryId, version: row.versions[i]! })),
      pending: row.status === 'pending',
      action: (sources) => actionOf(row, edits, sources),
    }
  }
}

function actionOf(
  row: SuggestionRow,
  edits: ApplyDreamSuggestion,
  sources: readonly (EntryRow & { primaryContent: string | null })[],
): SuggestionAction {
  const extra = (allowed: (keyof ApplyDreamSuggestion)[]) =>
    (Object.keys(edits) as (keyof ApplyDreamSuggestion)[]).some(
      (key) => edits[key] !== undefined && !allowed.includes(key),
    )
  const check = (problem: string | null) => {
    if (problem) throw new MemoryError(400, problem)
  }
  const sourceContents = sources.map((s) => s.primaryContent)

  switch (row.kind as DreamSuggestionKind) {
    case 'merge': {
      if (extra(['content'])) throw new MemoryError(400, '合并时只能修改合并后的正文')
      const text = edits.content ?? row.content ?? ''
      if (parseDreamScope(row.scope)?.kind === 'talk') {
        const content = oneLine(text)
        check(factProblem(content))
        return { kind: 'merge', keepId: row.keepId!, content }
      }
      const content = text.trim()
      check(mergedNodeProblem(content, sourceContents))
      return { kind: 'merge', keepId: row.keepId!, content }
    }
    case 'merge_variants': {
      if (extra(['variants'])) throw new MemoryError(400, '合并多变体建议只能修改切片列表')
      const variants = edits.variants ?? (row.variants as VariantInput[] | null) ?? []
      if (!variants.length) throw new MemoryError(400, '多变体建议至少包含一个切片')
      for (const v of variants) check(mergedNodeProblem(v.content, sourceContents))
      return { kind: 'merge_variants', keepId: row.keepId!, variants }
    }
    case 'generalize': {
      if (extra(['variants'])) throw new MemoryError(400, '泛化上浮建议只能修改切片列表')
      const variants = edits.variants ?? (row.variants as VariantInput[] | null) ?? []
      if (!variants.length) throw new MemoryError(400, '泛化上浮建议至少包含一个切片')
      for (const v of variants) check(mergedNodeProblem(v.content, sourceContents))
      return { kind: 'generalize', targetId: row.keepId ?? row.entryIds[0]!, variants }
    }
    case 'facet_tag': {
      if (extra(['when'])) throw new MemoryError(400, '补标建议只能修改切面条件')
      const when = normalizeWhen(edits.when ?? (row.when as WhenCondition | null) ?? {})
      return { kind: 'facet_tag', targetId: row.keepId ?? row.entryIds[0]!, when }
    }
    case 'distill':
    case 'distill_episode': {
      const variants = edits.variants ?? (row.variants as VariantInput[] | null) ?? undefined
      const content = edits.content ?? row.content ?? undefined
      if (variants?.length) {
        for (const v of variants) check(draftProblem(v.content))
      } else {
        check(draftProblem((content ?? '').trim()))
      }
      const disclosure =
        edits.disclosure === undefined
          ? row.disclosure
          : edits.disclosure
            ? oneLine(edits.disclosure)
            : null
      if (disclosure) check(disclosureProblem(disclosure))
      const when = edits.when ?? (row.when as WhenCondition | null) ?? undefined
      const topics = edits.topics ?? row.topics ?? undefined
      const title = edits.title ?? row.title ?? undefined
      const priority = edits.priority ?? row.targetPriority ?? undefined
      return {
        kind: row.kind as 'distill' | 'distill_episode',
        draft: {
          ...(title ? { title } : {}),
          ...(variants?.length
            ? { variants }
            : { content: (content ?? '').trim(), ...(when ? { when } : {}) }),
          ...(topics ? { topics } : {}),
          disclosure,
          ...(priority !== undefined ? { priority } : {}),
        },
      }
    }
    case 'stale':
      if (extra([])) throw new MemoryError(400, '这条建议没有可修改的内容')
      return { kind: 'stale' }
    case 'review':
      if (extra([])) throw new MemoryError(400, '这条建议没有可修改的内容')
      return { kind: 'review', verdict: row.verdict as DreamVerdict }
    case 'promote': {
      if (extra(['priority'])) throw new MemoryError(400, '晋升建议只能修改目标优先级')
      const priority = edits.priority ?? row.targetPriority ?? 1
      return { kind: 'promote', priority }
    }
  }
}

function settle(id: string, status: 'applied' | 'rejected', accountId: string) {
  return async (tx: Tx) => {
    await tx
      .update(dreamSuggestions)
      .set({ status, decidedBy: accountId, decidedAt: new Date() })
      .where(eq(dreamSuggestions.id, id))
  }
}

export async function applySuggestion(
  service: EntryService,
  suggestionId: string,
  edits: ApplyDreamSuggestion,
  accountId: string,
): Promise<DreamApplied> {
  const created = await service.applySuggestion(
    lockSuggestion(suggestionId, edits),
    settle(suggestionId, 'applied', accountId),
    { source: 'dream', suggestionId },
  )
  return {
    entry: created && { id: created.id, shortId: created.shortId, title: created.title },
  }
}

export async function rejectSuggestion(
  service: EntryService,
  suggestionId: string,
  accountId: string,
): Promise<void> {
  await service.rejectSuggestion(
    lockSuggestion(suggestionId),
    settle(suggestionId, 'rejected', accountId),
  )
}
