import { createRoute, z } from '@hono/zod-openapi'
import {
  DeleteFactQuery,
  ErrorResponse,
  MergeSubjectRequest,
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

import type { Access } from '../access/access'
import { confirmBinding, rejectBinding, subjectBindingHistory } from '../access/binding'
import {
  enqueueMerged,
  isLockBusy,
  linkedToOthers,
  lockSubjects,
  mergeSubjects,
} from '../access/subjects'
import { isInstanceAdmin } from '../auth/middleware'
import { withSpace, type Tx } from '../db/client'
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
  apps,
  extractionRuns,
  memories,
  memoryEvents,
  subjectIdentities,
  subjects,
} from '../db/schema'
import { BATCH_MOVED, BUDGET_NO_SUMMARY, NO_USABLE_KEY } from '../extraction/extract'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleMemberFor, consoleRoleFor } from '../memory/context'
import { readableConditions } from '../memory/filter'
import { scopeNames, subjectScope } from '../memory/scopes'

const SpaceParams = z.object({ spaceId: z.uuid() })
const SubjectParams = SpaceParams.extend({ subjectId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('不存在', ErrorResponse)

const PAGE_SIZE = 50
// 服务端自己判断出的失败原因，所有成员都看得到
const PLAIN_RUN_ERRORS = new Set([NO_USABLE_KEY, BUDGET_NO_SUMMARY, BATCH_MOVED])
// 详情里各部分最多列这么多条
const DETAIL_FACTS = 200
const DETAIL_SUPERSEDED = 50
const DETAIL_SUMMARIES = 20
const DETAIL_RUNS = 20
const DETAIL_BINDINGS = 20
// 合并时对象正被抽取或别的写入占着
const SUBJECTS_BUSY = '这两个对象正在被别的操作使用（例如正在抽取），请稍后再试'

const list = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/subjects',
  tags: ['subjects'],
  summary: '列出 bot 遇到过的人与群，新的在前',
  request: { params: SpaceParams, query: SubjectListQuery },
  responses: {
    200: jsonResponse('对象列表', SubjectList),
    400: jsonResponse('翻页参数无效', ErrorResponse),
    403: forbidden,
  },
})

const detail = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/subjects/{subjectId}',
  tags: ['subjects'],
  summary: '对象详情：平台账号、记下的事实、会话摘要与最近的抽取记录',
  request: { params: SubjectParams },
  responses: { 200: jsonResponse('对象详情', SubjectDetail), 403: forbidden, 404: notFound },
})

const update = createRoute({
  method: 'patch',
  path: '/spaces/{spaceId}/subjects/{subjectId}',
  tags: ['subjects'],
  summary: '改对象的名字，或把这个人标记为自己（取消自己的标记）',
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
  path: '/spaces/{spaceId}/subjects/{subjectId}/merge',
  tags: ['subjects'],
  summary:
    '把另一个对象合并进这个：平台账号、事实与私聊（或群）里记下的内容都归到这个对象，另一个删掉',
  request: { params: SubjectParams, body: jsonBody(MergeSubjectRequest) },
  responses: {
    200: jsonResponse('合并后的对象', SubjectInfo),
    400: jsonResponse('人和群不能合并，也不能合并自己', ErrorResponse),
    403: jsonResponse('没有权限，或对象标记成了别的成员', ErrorResponse),
    404: notFound,
    409: jsonResponse('两个对象正在被别的操作使用', ErrorResponse),
  },
})

const BindingParams = SpaceParams.extend({ bindingId: z.uuid() })

const confirmBindingRoute = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/subject-bindings/{bindingId}/confirm',
  tags: ['subjects'],
  summary:
    '确认一次绑定：把收码的对象并进发码的对象，规则同合并对象。只有发码的对象标记成的成员本人能确认',
  request: { params: BindingParams },
  responses: {
    200: jsonResponse('合并后的对象', SubjectInfo),
    403: jsonResponse('不是被标记的成员本人，或者是 viewer', ErrorResponse),
    404: notFound,
    409: jsonResponse('已经处理过、过了期限，或者期间情况变了（已作废）', ErrorResponse),
  },
})

const rejectBindingRoute = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/subject-bindings/{bindingId}/reject',
  tags: ['subjects'],
  summary: '拒绝一次绑定，两边不合并。只有发码的对象标记成的成员本人能拒绝',
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
  path: '/spaces/{spaceId}/subjects/{subjectId}/facts/{factId}',
  tags: ['subjects'],
  summary: '删掉挂在这个对象上的一条事实（确认过的也能删）',
  request: {
    params: SubjectParams.extend({ factId: z.uuid() }),
    query: DeleteFactQuery,
  },
  responses: {
    204: { description: '已删除' },
    403: forbidden,
    404: notFound,
    409: jsonResponse('看过之后被改过', ErrorResponse),
  },
})

const reactivateFact = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/subjects/{subjectId}/facts/{factId}/reactivate',
  tags: ['subjects'],
  summary: '让挂在这个对象上的一条被推翻的事实重新生效（推翻它的那条照样有效）',
  request: {
    params: SubjectParams.extend({ factId: z.uuid() }),
    body: jsonBody(ReactivateFactRequest),
  },
  responses: {
    204: { description: '已重新生效' },
    403: forbidden,
    404: notFound,
    409: jsonResponse('现在是有效的，或看过之后被改过', ErrorResponse),
  },
})

// 对象层与情节层不分人格，读权限里的人格限制用不上
const readable = (access: Access) => readableConditions(access, { personaIds: [] })

// 现在有效、查看者读得到的抽取事实
const factsOf = (access: Access) =>
  and(eq(memories.form, 'extracted'), eq(memories.layer, 'subject'), readable(access))!

// 被推翻的事实：推翻时设了 valid_to、还没删除、按管理读取（不看有效期）看得到的
const supersededOf = (access: Access) =>
  and(
    eq(memories.form, 'extracted'),
    eq(memories.layer, 'subject'),
    isNull(memories.deletedAt),
    lte(memories.validTo, sql`now()`),
    readableConditions(access, { personaIds: [], management: true }),
  )!

// 推翻了这些事实的那几条的正文：推翻时在旧事实的修改事件里记下了新事实的 id（supersededBy），取最近的一次。
// 新的那条已经删掉、或者按管理读取看不到时不给
async function supersedingContents(
  tx: Tx,
  access: Access,
  factIds: string[],
): Promise<Map<string, string>> {
  if (!factIds.length) return new Map()
  const links = await tx
    .selectDistinctOn([memoryEvents.memoryId], {
      factId: memoryEvents.memoryId,
      by: sql<string>`${memoryEvents.context} ->> 'supersededBy'`,
    })
    .from(memoryEvents)
    .where(
      and(
        inArray(memoryEvents.memoryId, factIds),
        sql`(${memoryEvents.context} ->> 'supersededBy') is not null`,
      ),
    )
    .orderBy(memoryEvents.memoryId, desc(memoryEvents.id))
  const ids = [...new Set(links.map((l) => l.by).filter((id) => UUID.test(id)))]
  const rows = ids.length
    ? await tx
        .select({ id: memories.id, content: memories.content })
        .from(memories)
        .where(
          and(
            inArray(memories.id, ids),
            eq(memories.form, 'extracted'),
            isNull(memories.deletedAt),
            readableConditions(access, { personaIds: [], management: true }),
          ),
        )
    : []
  const contents = new Map(rows.map((r) => [r.id, r.content ?? '']))
  return new Map(
    links.flatMap((l) => {
      const content = contents.get(l.by)
      return l.factId && content !== undefined ? [[l.factId, content] as const] : []
    }),
  )
}

// 列表与修改后返回的对象信息：平台账号与事实条数按对象一次查出
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
      factCount: sql<number>`(select count(*)::int from ${memories}
        where ${memories.subjectId} = ${subjects.id} and ${factsOf(access)})`,
    })
    .from(subjects)
    .leftJoin(accounts, eq(accounts.id, subjects.accountId))
    .where(where)
    // 按第一次遇到的时间排：改名、标记都不会让对象在翻页时挪位置
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
      const { spaceId } = c.req.valid('param')
      const query = c.req.valid('query')
      const { service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      const after = decodeTimeCursor(query.cursor, UUID)
      if (after === 'invalid') return c.json({ error: INVALID_CURSOR }, 400)
      const needle = query.q ? `%${escapeLike(query.q)}%` : null
      const page = await withSpace(deps.db, spaceId, (tx) =>
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
      const { spaceId, subjectId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, spaceId, accountId)
      const access = service.access
      const admin = await isInstanceAdmin(deps.db, accountId)
      // 模型接口或数据库报的原文可能带着内部的地址与响应，抽取模型由实例管理员配，原文只给他看
      const errorOf = (error: string | null) =>
        !error || admin || PLAIN_RUN_ERRORS.has(error)
          ? error
          : '抽取失败（原因只有实例管理员看得到）'
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        const [found] = await subjectInfos(tx, access, eq(subjects.id, subjectId))
        if (!found) return null
        // 会话摘要按来源作用域找：群里的，或和这个人的私聊里的
        const scope = subjectScope(found.info.kind, subjectId)
        const [facts, superseded, summaries, runs, bindings] = await Promise.all([
          tx
            .select()
            .from(memories)
            .where(and(eq(memories.subjectId, subjectId), factsOf(access)))
            .orderBy(desc(memories.updatedAt), desc(memories.id))
            .limit(DETAIL_FACTS),
          tx
            .select()
            .from(memories)
            .where(and(eq(memories.subjectId, subjectId), supersededOf(access)))
            .orderBy(desc(memories.validTo), desc(memories.id))
            .limit(DETAIL_SUPERSEDED),
          tx
            .select()
            .from(memories)
            .where(
              and(
                eq(memories.form, 'extracted'),
                eq(memories.layer, 'episode'),
                eq(memories.originScope, scope),
                readable(access),
              ),
            )
            .orderBy(desc(memories.createdAt), desc(memories.id))
            .limit(DETAIL_SUMMARIES),
          tx
            .select({ run: extractionRuns, appName: apps.name })
            .from(extractionRuns)
            .leftJoin(apps, eq(apps.id, extractionRuns.appId))
            .where(arrayContains(extractionRuns.subjectIds, [subjectId]))
            .orderBy(desc(extractionRuns.createdAt), desc(extractionRuns.id))
            .limit(DETAIL_RUNS),
          subjectBindingHistory(tx, subjectId, { accountId, role }, DETAIL_BINDINGS),
        ])
        const [named, superseding] = await Promise.all([
          scopeNames(tx, [
            ...facts.map((f) => f.originScope),
            ...superseded.map((f) => f.originScope),
            ...runs.map((r) => r.run.scope),
          ]),
          supersedingContents(
            tx,
            access,
            superseded.map((f) => f.id),
          ),
        ])
        const fact = (f: (typeof facts)[number]) => ({
          id: f.id,
          content: f.content ?? '',
          provenance: f.provenance,
          version: f.version,
          scope: named(f.originScope),
          createdAt: f.createdAt.toISOString(),
          updatedAt: f.updatedAt.toISOString(),
        })
        return {
          ...found.info,
          facts: facts.map(fact),
          supersededFacts: superseded.map((f) => ({
            ...fact(f),
            supersededAt: f.validTo!.toISOString(),
            supersededBy: superseding.get(f.id) ?? null,
          })),
          summaries: summaries.map((s) => ({
            id: s.id,
            content: s.content ?? '',
            createdAt: s.createdAt.toISOString(),
            expiresAt: s.expiresAt?.toISOString() ?? null,
          })),
          runs: runs.map(({ run, appName }) => ({
            id: run.id,
            createdAt: run.createdAt.toISOString(),
            app: appName ? { id: run.appId, name: appName } : null,
            scope: named(run.scope),
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
          })),
          bindings,
        }
      })
      if (!result) return c.json({ error: '对象不存在' }, 404)
      return c.json(result, 200)
    })
    .openapi(update, async (c) => {
      const { spaceId, subjectId } = c.req.valid('param')
      const body = c.req.valid('json')
      const me = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, spaceId, me)
      // 取消自己的标记谁都可以：被降为 viewer 之后也撤得掉；别的改动要 owner 或 editor
      const unlinkOnly = body.displayName === undefined && body.linkedToMe === false
      if (role === 'viewer' && !unlinkOnly) {
        return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      }
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        // 锁住这一行：两个成员同时标记同一个人时只有一个成功
        const [row] = await tx
          .select()
          .from(subjects)
          .where(eq(subjects.id, subjectId))
          .for('update')
        if (!row) return { status: 404 as const, error: '对象不存在' }
        if (role === 'viewer' && row.accountId !== me) {
          return { status: 403 as const, error: '只能取消标记为自己的' }
        }
        let accountId = row.accountId
        if (body.linkedToMe !== undefined) {
          if (row.kind !== 'person') {
            return { status: 400 as const, error: '只有人能标记为成员本人，群不行' }
          }
          if (body.linkedToMe) {
            if (row.accountId && row.accountId !== me) {
              return { status: 409 as const, error: '这个人已经标记为别的成员' }
            }
            accountId = me
          } else if (row.accountId && row.accountId !== me && role !== 'owner') {
            // 空间 owner 可以取消任何人的标记（例如标错了），别人只能取消自己的
            return { status: 403 as const, error: '只能取消标记为自己的' }
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
      const { spaceId, subjectId } = c.req.valid('param')
      const { from } = c.req.valid('json')
      const me = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, spaceId, me)
      if (role === 'viewer') return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      if (from === subjectId) return c.json({ error: '不能把对象合并进它自己' }, 400)
      const merged = withSpace(deps.db, spaceId, async (tx) => {
        const rows = await lockSubjects(tx, [subjectId, from])
        const into = rows.find((r) => r.id === subjectId)
        const gone = rows.find((r) => r.id === from)
        if (!into || !gone) return { status: 404 as const, error: '对象不存在' }
        if (into.kind !== gone.kind) return { status: 400 as const, error: '人和群不能合并' }
        if (linkedToOthers(rows, me)) {
          return {
            status: 403 as const,
            error: '标记成了别的成员的对象不能合并，要先请那位成员取消标记',
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
      await enqueueMerged(deps, spaceId, result.outcome)
      return c.json(result.info, 200)
    })
    .openapi(confirmBindingRoute, async (c) => {
      const { spaceId, bindingId } = c.req.valid('param')
      const me = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, spaceId, me)
      const confirmed = await confirmBinding(deps.db, spaceId, bindingId, me, role).catch(
        (err: unknown) => {
          if (isLockBusy(err))
            return { ok: false as const, status: 409 as const, error: SUBJECTS_BUSY }
          throw err
        },
      )
      if (!confirmed.ok) return c.json({ error: confirmed.error }, confirmed.status)
      if (confirmed.outcome) await enqueueMerged(deps, spaceId, confirmed.outcome)
      const [found] = await withSpace(deps.db, spaceId, (tx) =>
        subjectInfos(tx, service.access, eq(subjects.id, confirmed.subjectId)),
      )
      if (!found) return c.json({ error: '对象不存在' }, 404)
      return c.json(found.info, 200)
    })
    .openapi(rejectBindingRoute, async (c) => {
      const { spaceId, bindingId } = c.req.valid('param')
      const me = c.get('console').accountId
      // 先确认是成员；拒绝什么角色都可以
      await consoleRoleFor(deps, spaceId, me)
      const rejected = await rejectBinding(deps.db, spaceId, bindingId, me)
      if (!rejected.ok) return c.json({ error: rejected.error }, rejected.status)
      return c.body(null, 204)
    })
    .openapi(deleteFact, async (c) => {
      const { spaceId, subjectId, factId } = c.req.valid('param')
      const { version } = c.req.valid('query')
      const { role, service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      if (role === 'viewer') return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      await service.deleteFact(subjectId, factId, version)
      return c.body(null, 204)
    })
    .openapi(reactivateFact, async (c) => {
      const { spaceId, subjectId, factId } = c.req.valid('param')
      const { version } = c.req.valid('json')
      const { role, service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      if (role === 'viewer') return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      await service.reactivateFact(subjectId, factId, version)
      return c.body(null, 204)
    })
}
