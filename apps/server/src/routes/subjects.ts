import { createRoute, z } from '@hono/zod-openapi'
import {
  ConsoleEntryView,
  DeleteFactQuery,
  ErrorResponse,
  MergeSubjectRequest,
  PromoteFactRequest,
  ReactivateFactRequest,
  SubjectDetail,
  SubjectInfo,
  SubjectList,
  SubjectListQuery,
  UpdateSubjectRequest,
} from '@kioku/contracts'
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'

import { canRead, type Access } from '../access/access'
import { confirmBinding, rejectBinding, subjectBindingHistory } from '../access/binding'
import {
  participatedConversations,
  runInfos,
  visibleConversationIds,
} from '../access/conversations'
import {
  enqueueMerged,
  isLockBusy,
  linkedToOthers,
  lockSubjects,
  mergeSubjects,
} from '../access/subjects'
import { isInstanceAdmin } from '../auth/middleware'
import { nowOf, withCircle, type Tx } from '../db/client'
import {
  decodeTimeCursor,
  encodeTimeCursor,
  escapeLike,
  fromMicros,
  INVALID_CURSOR,
  microsOf,
  UUID,
} from '../db/paging'
import {
  accounts,
  clients,
  entries,
  entryEvents,
  entryVariants,
  extractionRuns,
  subjectIdentities,
  subjects,
} from '../db/schema'
import { plainRunError } from '../extraction/extract'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleMemberFor, consoleRoleFor } from '../memory/context'
import { momentSql, readableConditions } from '../memory/filter'
import { scopeNames } from '../memory/scopes'
import { parseEntryFacts } from '../memory/service'

const CircleParams = z.object({ circleId: z.uuid() })
const SubjectParams = CircleParams.extend({ subjectId: z.uuid() })
const FactParams = SubjectParams.extend({ factId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('不存在', ErrorResponse)

const PAGE_SIZE = 50
const DETAIL_FACTS = 200
const DETAIL_SUPERSEDED = 50
const DETAIL_RUNS = 20
const DETAIL_BINDINGS = 20
const SUBJECTS_BUSY = '这两个联系人正在被其他操作使用（例如抽取），请稍后重试'

const list = createRoute({
  method: 'get',
  path: '/circles/{circleId}/subjects',
  tags: ['subjects'],
  summary: '列出接入实例遇到过的联系人与群，新的在前',
  request: { params: CircleParams, query: SubjectListQuery },
  responses: {
    200: jsonResponse('联系人列表', SubjectList),
    400: jsonResponse('翻页参数无效', ErrorResponse),
    403: forbidden,
  },
})

const detail = createRoute({
  method: 'get',
  path: '/circles/{circleId}/subjects/{subjectId}',
  tags: ['subjects'],
  summary: '联系人详情：平台账号、记下的事实、参与的会话与最近的抽取记录',
  request: { params: SubjectParams },
  responses: { 200: jsonResponse('联系人详情', SubjectDetail), 403: forbidden, 404: notFound },
})

const update = createRoute({
  method: 'patch',
  path: '/circles/{circleId}/subjects/{subjectId}',
  tags: ['subjects'],
  summary: '改联系人的名字，或把这个人标记为自己（取消自己的标记）',
  request: { params: SubjectParams, body: jsonBody(UpdateSubjectRequest) },
  responses: {
    200: jsonResponse('已修改', SubjectInfo),
    400: jsonResponse('群不能标记为成员', ErrorResponse),
    403: forbidden,
    404: notFound,
    409: jsonResponse('已经标记为别的成员', ErrorResponse),
  },
})

const merge = createRoute({
  method: 'post',
  path: '/circles/{circleId}/subjects/{subjectId}/merge',
  tags: ['subjects'],
  summary:
    '把另一个联系人合并进这个：平台账号、事实与私聊（或群）里记下的内容都归到这个联系人，另一个删掉',
  request: { params: SubjectParams, body: jsonBody(MergeSubjectRequest) },
  responses: {
    200: jsonResponse('合并后的联系人', SubjectInfo),
    400: jsonResponse('人和群不能合并，也不能合并自己', ErrorResponse),
    403: jsonResponse('没有权限，或联系人标记成了别的成员', ErrorResponse),
    404: notFound,
    409: jsonResponse('两个联系人正在被别的操作使用', ErrorResponse),
  },
})

const BindingParams = CircleParams.extend({ bindingId: z.uuid() })

const confirmBindingRoute = createRoute({
  method: 'post',
  path: '/circles/{circleId}/subject-bindings/{bindingId}/confirm',
  tags: ['subjects'],
  summary:
    '确认一次绑定：把收码的对象并进发码的对象，规则同合并联系人。只有发码对象标记成的成员本人能确认',
  request: { params: BindingParams },
  responses: {
    200: jsonResponse('合并后的联系人', SubjectInfo),
    403: jsonResponse('不是被标记的成员本人，或者是 viewer', ErrorResponse),
    404: notFound,
    409: jsonResponse('已经处理过、过了期限，或者期间情况变了（已作废）', ErrorResponse),
  },
})

const rejectBindingRoute = createRoute({
  method: 'post',
  path: '/circles/{circleId}/subject-bindings/{bindingId}/reject',
  tags: ['subjects'],
  summary: '拒绝一次绑定，两边不合并。只有发码对象标记成的成员本人能拒绝',
  request: { params: BindingParams },
  responses: {
    204: { description: '已拒绝' },
    403: jsonResponse('不是被标记的成员本人', ErrorResponse),
    404: notFound,
    409: jsonResponse('已经处理过或过了期限', ErrorResponse),
  },
})

const deleteFact = createRoute({
  method: 'delete',
  path: '/circles/{circleId}/subjects/{subjectId}/facts/{factId}',
  tags: ['subjects'],
  summary: '删掉挂在这个联系人上的一条事实（确认过的也能删）',
  request: { params: FactParams, query: DeleteFactQuery },
  responses: {
    204: { description: '已删除' },
    403: forbidden,
    404: notFound,
    409: jsonResponse('看过之后被改过', ErrorResponse),
  },
})

const reactivateFact = createRoute({
  method: 'post',
  path: '/circles/{circleId}/subjects/{subjectId}/facts/{factId}/reactivate',
  tags: ['subjects'],
  summary: '让挂在这个联系人上的一条被推翻的事实重新生效（推翻它的那条照样有效）',
  request: { params: FactParams, body: jsonBody(ReactivateFactRequest) },
  responses: {
    204: { description: '已重新生效' },
    403: forbidden,
    404: notFound,
    409: jsonResponse('现在是有效的，或看过之后被改过', ErrorResponse),
  },
})

const promoteFact = createRoute({
  method: 'post',
  path: '/circles/{circleId}/subjects/{subjectId}/facts/{factId}/promote',
  tags: ['subjects'],
  summary: '将联系人的某条事实提炼升级为目标记忆圈的正式词条，原事实保留不动',
  request: { params: FactParams, body: jsonBody(PromoteFactRequest) },
  responses: {
    201: jsonResponse('已升级为正式词条', ConsoleEntryView),
    400: jsonResponse('请求不合法', ErrorResponse),
    403: forbidden,
    404: notFound,
  },
})

const readable = (access: Access, now?: Date) =>
  readableConditions(access, { ...(now ? { now } : {}) })

const factsOf = (access: Access, now?: Date) =>
  and(eq(entries.kind, 'fact'), readable(access, now))!

const supersededOf = (access: Access) =>
  and(
    eq(entries.kind, 'fact'),
    isNull(entries.deletedAt),
    lte(entries.validTo, momentSql()),
    readableConditions(access, { management: true }),
  )!

async function supersedingContents(
  tx: Tx,
  access: Access,
  factIds: string[],
): Promise<Map<string, string>> {
  if (!factIds.length) return new Map()
  const links = await tx
    .selectDistinctOn([entryEvents.entryId], {
      factId: entryEvents.entryId,
      by: sql<string>`${entryEvents.context} ->> 'supersededBy'`,
    })
    .from(entryEvents)
    .where(
      and(
        inArray(entryEvents.entryId, factIds),
        sql`(${entryEvents.context} ->> 'supersededBy') is not null`,
      ),
    )
    .orderBy(entryEvents.entryId, desc(entryEvents.id))
  const ids = [...new Set(links.map((l) => l.by).filter((id) => UUID.test(id)))]
  const rows = ids.length
    ? await tx
        .selectDistinctOn([entries.id], { id: entries.id, content: entryVariants.content })
        .from(entries)
        .innerJoin(entryVariants, eq(entryVariants.entryId, entries.id))
        .where(
          and(
            inArray(entries.id, ids),
            eq(entries.kind, 'fact'),
            isNull(entries.deletedAt),
            readableConditions(access, { management: true }),
          ),
        )
        .orderBy(entries.id, asc(entryVariants.sortOrder))
    : []
  const contents = new Map(rows.map((r) => [r.id, r.content ?? '']))
  return new Map(
    links.flatMap((l) => {
      const content = contents.get(l.by)
      return l.factId && content !== undefined ? [[l.factId, content] as const] : []
    }),
  )
}

async function subjectInfos(
  tx: Tx,
  access: Access,
  where: SQL | undefined,
  options: { limit?: number } = {},
) {
  const rows = await tx
    .select({
      id: subjects.id,
      kind: subjects.kind,
      displayName: subjects.displayName,
      accountId: subjects.accountId,
      accountName: accounts.displayName,
      nameLocked: subjects.nameLocked,
      createdAt: subjects.createdAt,
      updatedAt: subjects.updatedAt,
      createdMicros: sql<string>`${microsOf(subjects.createdAt)}::text`,
      factCount: sql<number>`(select count(*)::int from ${entries}
        where ${entries.subjectId} = ${subjects.id} and ${factsOf(access, nowOf(tx))})`,
    })
    .from(subjects)
    .leftJoin(accounts, eq(accounts.id, subjects.accountId))
    .where(where)
    .orderBy(desc(subjects.createdAt), desc(subjects.id))
    .limit(options.limit ?? PAGE_SIZE)
  const ids = rows.map((r) => r.id)
  const identities = ids.length
    ? await tx
        .select()
        .from(subjectIdentities)
        .where(inArray(subjectIdentities.subjectId, ids))
        .orderBy(asc(subjectIdentities.platform), asc(subjectIdentities.externalId))
    : []
  return rows.map((r) => ({
    row: r,
    info: {
      id: r.id,
      kind: r.kind,
      displayName: r.displayName,
      nameLocked: r.nameLocked,
      account: r.accountId ? { id: r.accountId, displayName: r.accountName ?? '' } : null,
      identities: identities
        .filter((i) => i.subjectId === r.id)
        .map((i) => ({
          platform: i.platform,
          externalId: i.externalId,
          displayName: i.displayName,
        })),
      factCount: r.factCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    },
  }))
}

export function subjectRoutes(deps: Deps) {
  return router()
    .openapi(list, async (c) => {
      const { circleId } = c.req.valid('param')
      const query = c.req.valid('query')
      const { service } = await consoleMemberFor(deps, circleId, c.get('console').accountId)
      const after = decodeTimeCursor(query.cursor, UUID)
      if (after === 'invalid') return c.json({ error: INVALID_CURSOR }, 400)
      const needle = query.q ? `%${escapeLike(query.q)}%` : null
      const page = await withCircle(deps.db, circleId, (tx) =>
        subjectInfos(
          tx,
          service.access,
          and(
            query.kind ? eq(subjects.kind, query.kind) : undefined,
            needle
              ? or(
                  ilike(subjects.displayName, needle),
                  sql`exists (select 1 from ${subjectIdentities}
                    where ${subjectIdentities.subjectId} = ${subjects.id}
                      and (${subjectIdentities.externalId} ilike ${needle}
                        or ${subjectIdentities.displayName} ilike ${needle}))`,
                )
              : undefined,
            after
              ? sql`(${subjects.createdAt}, ${subjects.id}) < (${fromMicros(after[0])}, ${after[1]}::uuid)`
              : undefined,
          ),
          { limit: PAGE_SIZE + 1 },
        ),
      )
      const items = page.slice(0, PAGE_SIZE)
      const last = items.at(-1)
      return c.json(
        {
          items: items.map((p) => p.info),
          nextCursor:
            page.length > PAGE_SIZE && last
              ? encodeTimeCursor(last.row.createdMicros, last.row.id)
              : null,
        },
        200,
      )
    })
    .openapi(detail, async (c) => {
      const { circleId, subjectId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, circleId, accountId)
      const access = service.access
      const admin = await isInstanceAdmin(deps.db, accountId)
      const errorOf = (stored: string | null) => {
        if (!stored) return stored
        return plainRunError(stored) ?? (admin ? stored : '抽取失败（原因仅实例管理员可见）')
      }
      const result = await withCircle(deps.db, circleId, async (tx, now) => {
        const [found] = await subjectInfos(tx, access, eq(subjects.id, subjectId))
        if (!found) return null
        const [facts, superseded, conversations, runs, bindings] = await Promise.all([
          tx
            .selectDistinctOn([entries.id], { entry: entries, content: entryVariants.content })
            .from(entries)
            .innerJoin(entryVariants, eq(entryVariants.entryId, entries.id))
            .where(and(eq(entries.subjectId, subjectId), factsOf(access, now)))
            .orderBy(entries.id, asc(entryVariants.sortOrder))
            .limit(DETAIL_FACTS),
          tx
            .selectDistinctOn([entries.id], { entry: entries, content: entryVariants.content })
            .from(entries)
            .innerJoin(entryVariants, eq(entryVariants.entryId, entries.id))
            .where(and(eq(entries.subjectId, subjectId), supersededOf(access)))
            .orderBy(entries.id, asc(entryVariants.sortOrder))
            .limit(DETAIL_SUPERSEDED),
          participatedConversations(tx, access, subjectId),
          tx
            .select({ run: extractionRuns, clientName: clients.name })
            .from(extractionRuns)
            .leftJoin(clients, eq(clients.id, extractionRuns.clientId))
            .where(arrayContains(extractionRuns.subjectIds, [subjectId]))
            .orderBy(desc(extractionRuns.createdAt), desc(extractionRuns.id))
            .limit(DETAIL_RUNS),
          subjectBindingHistory(tx, subjectId, { accountId, role }, DETAIL_BINDINGS),
        ])
        facts.sort(
          (a, b) =>
            b.entry.updatedAt.getTime() - a.entry.updatedAt.getTime() ||
            b.entry.id.localeCompare(a.entry.id),
        )
        superseded.sort(
          (a, b) =>
            (b.entry.validTo?.getTime() ?? 0) - (a.entry.validTo?.getTime() ?? 0) ||
            b.entry.id.localeCompare(a.entry.id),
        )
        const [named, superseding, shown] = await Promise.all([
          scopeNames(tx, [
            ...facts.map((f) => f.entry.originScope),
            ...superseded.map((f) => f.entry.originScope),
          ]),
          supersedingContents(
            tx,
            access,
            superseded.map((f) => f.entry.id),
          ),
          visibleConversationIds(tx, access, [
            ...facts.map((f) => f.entry.conversationId),
            ...superseded.map((f) => f.entry.conversationId),
            ...runs.map((r) => r.run.conversationId),
          ]),
        ])
        const fact = ({ entry: f, content }: (typeof facts)[number]) => ({
          id: f.id,
          shortId: f.shortId,
          content: content ?? '',
          provenance: f.provenance,
          version: f.version,
          scope: named(f.originScope),
          conversationId: f.conversationId && shown.has(f.conversationId) ? f.conversationId : null,
          createdAt: f.createdAt.toISOString(),
          updatedAt: f.updatedAt.toISOString(),
        })
        return {
          ...found.info,
          facts: facts.map(fact),
          supersededFacts: superseded.map((item) => ({
            ...fact(item),
            supersededAt: item.entry.validTo!.toISOString(),
            supersededBy: superseding.get(item.entry.id) ?? null,
          })),
          conversations,
          runs: await runInfos(tx, runs, shown, errorOf),
          bindings,
        }
      })
      if (!result) return c.json({ error: '联系人不存在' }, 404)
      return c.json(result, 200)
    })
    .openapi(update, async (c) => {
      const { circleId, subjectId } = c.req.valid('param')
      const body = c.req.valid('json')
      const me = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, circleId, me)
      const unlinkOnly = body.displayName === undefined && body.linkedToMe === false
      if (role === 'viewer' && !unlinkOnly) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const result = await withCircle(deps.db, circleId, async (tx) => {
        const [row] = await tx
          .select()
          .from(subjects)
          .where(eq(subjects.id, subjectId))
          .for('update')
        if (!row) return { status: 404 as const, error: '联系人不存在' }
        if (role === 'viewer' && row.accountId !== me) {
          return { status: 403 as const, error: '只能取消标记为当前账号的联系人' }
        }
        let accountId = row.accountId
        if (body.linkedToMe !== undefined) {
          if (row.kind !== 'person') {
            return { status: 400 as const, error: '群不能标记为成员本人' }
          }
          if (body.linkedToMe) {
            if (row.accountId && row.accountId !== me) {
              return { status: 409 as const, error: '此人已标记为其他成员' }
            }
            accountId = me
          } else if (row.accountId && row.accountId !== me && role !== 'owner') {
            return { status: 403 as const, error: '只能取消标记为当前账号的联系人' }
          } else {
            accountId = null
          }
        }
        await tx
          .update(subjects)
          .set({
            displayName: body.displayName ?? row.displayName,
            nameLocked: body.displayName !== undefined || row.nameLocked,
            accountId,
            updatedAt: new Date(),
          })
          .where(eq(subjects.id, subjectId))
        const [found] = await subjectInfos(tx, service.access, eq(subjects.id, subjectId))
        return { status: 200 as const, info: found!.info }
      })
      if (result.status !== 200) return c.json({ error: result.error }, result.status)
      return c.json(result.info, 200)
    })
    .openapi(merge, async (c) => {
      const { circleId, subjectId } = c.req.valid('param')
      const { from } = c.req.valid('json')
      const me = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, circleId, me)
      if (role === 'viewer') return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      if (from === subjectId) return c.json({ error: '不能将联系人合并到自身' }, 400)
      const merged = withCircle(deps.db, circleId, async (tx) => {
        const rows = await lockSubjects(tx, [subjectId, from])
        const into = rows.find((r) => r.id === subjectId)
        const gone = rows.find((r) => r.id === from)
        if (!into || !gone) return { status: 404 as const, error: '联系人不存在' }
        if (into.kind !== gone.kind) return { status: 400 as const, error: '人和群不能合并' }
        if (linkedToOthers(rows, me)) {
          return {
            status: 403 as const,
            error: '已标记为其他成员的联系人无法合并。请先让该成员取消标记。',
          }
        }
        const outcome = await mergeSubjects(tx, gone, into)
        const [found] = await subjectInfos(tx, service.access, eq(subjects.id, subjectId))
        return { status: 200 as const, info: found!.info, outcome }
      })
      let result: Awaited<typeof merged>
      try {
        result = await merged
      } catch (err) {
        if (isLockBusy(err)) return c.json({ error: SUBJECTS_BUSY }, 409)
        throw err
      }
      if (result.status !== 200) return c.json({ error: result.error }, result.status)
      await enqueueMerged(deps, circleId, result.outcome)
      return c.json(result.info, 200)
    })
    .openapi(confirmBindingRoute, async (c) => {
      const { circleId, bindingId } = c.req.valid('param')
      const me = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, circleId, me)
      const confirmed = await confirmBinding(deps.db, circleId, bindingId, me, role).catch(
        (err: unknown) => {
          if (isLockBusy(err))
            return { ok: false as const, status: 409 as const, error: SUBJECTS_BUSY }
          throw err
        },
      )
      if (!confirmed.ok) return c.json({ error: confirmed.error }, confirmed.status)
      if (confirmed.outcome) await enqueueMerged(deps, circleId, confirmed.outcome)
      const [found] = await withCircle(deps.db, circleId, (tx) =>
        subjectInfos(tx, service.access, eq(subjects.id, confirmed.subjectId)),
      )
      if (!found) return c.json({ error: '联系人不存在' }, 404)
      return c.json(found.info, 200)
    })
    .openapi(rejectBindingRoute, async (c) => {
      const { circleId, bindingId } = c.req.valid('param')
      const me = c.get('console').accountId
      await consoleRoleFor(deps, me, circleId)
      const rejected = await rejectBinding(deps.db, circleId, bindingId, me)
      if (!rejected.ok) return c.json({ error: rejected.error }, rejected.status)
      return c.body(null, 204)
    })
    .openapi(deleteFact, async (c) => {
      const { circleId, subjectId, factId } = c.req.valid('param')
      const { version } = c.req.valid('query')
      const { role, service } = await consoleMemberFor(deps, circleId, c.get('console').accountId)
      if (role === 'viewer') return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      await service.deleteFact(subjectId, factId, version)
      return c.body(null, 204)
    })
    .openapi(reactivateFact, async (c) => {
      const { circleId, subjectId, factId } = c.req.valid('param')
      const { version } = c.req.valid('json')
      const { role, service } = await consoleMemberFor(deps, circleId, c.get('console').accountId)
      if (role === 'viewer') return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      await service.reactivateFact(subjectId, factId, version)
      return c.body(null, 204)
    })
    .openapi(promoteFact, async (c) => {
      const { circleId, subjectId, factId } = c.req.valid('param')
      const me = c.get('console').accountId
      const body = c.req.valid('json')
      const { service: sourceService } = await consoleMemberFor(deps, circleId, me)
      const sourceFact = await withCircle(deps.db, circleId, async (tx, now) => {
        const [row] = await tx
          .select()
          .from(entries)
          .where(
            and(eq(entries.id, factId), eq(entries.kind, 'fact'), eq(entries.subjectId, subjectId)),
          )
          .limit(1)
        if (
          !row ||
          row.deletedAt !== null ||
          !canRead(sourceService.access, parseEntryFacts(row), { now, management: true })
        ) {
          return null
        }
        const [vRow] = await tx
          .select({ content: entryVariants.content })
          .from(entryVariants)
          .where(eq(entryVariants.entryId, row.id))
          .orderBy(asc(entryVariants.sortOrder))
          .limit(1)
        return { row, content: vRow?.content ?? '' }
      })
      if (!sourceFact) return c.json({ error: '未找到事实' }, 404)

      const { role: targetRole, service: targetService } = await consoleMemberFor(
        deps,
        body.targetCircleId,
        me,
      )
      if (targetRole === 'viewer') {
        return c.json({ error: '需要目标记忆圈的所有者或编辑者角色' }, 403)
      }
      const nextContent = (body.content ?? sourceFact.content).trim()
      if (!nextContent) return c.json({ error: '事实正文不能为空' }, 400)
      const created = await targetService.create({
        circleId: body.targetCircleId,
        ...(body.title !== undefined ? { title: body.title } : {}),
        content: nextContent,
        when: body.when,
        topics: body.topics,
        sensitivity: body.sensitivity,
        priority: body.priority,
        ...(body.disclosure !== undefined && body.disclosure !== null
          ? { disclosure: body.disclosure }
          : {}),
      })
      return c.json(created as ConsoleEntryView, 201)
    })
}
