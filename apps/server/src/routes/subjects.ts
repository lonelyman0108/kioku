import { createRoute, z } from '@hono/zod-openapi'
import {
  ErrorResponse,
  SubjectDetail,
  SubjectInfo,
  SubjectList,
  SubjectListQuery,
  UpdateSubjectRequest,
  type OriginScope,
} from '@kioku/contracts'
import { and, arrayContains, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'

import type { Access } from '../access/access'
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
import { accounts, apps, extractionRuns, memories, subjectIdentities, subjects } from '../db/schema'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'
import { readableConditions } from '../memory/filter'

const SpaceParams = z.object({ spaceId: z.uuid() })
const SubjectParams = SpaceParams.extend({ subjectId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('不存在', ErrorResponse)

const PAGE_SIZE = 50
// 详情里各部分最多列这么多条
const DETAIL_FACTS = 200
const DETAIL_SUMMARIES = 20
const DETAIL_RUNS = 20

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

// 对象层与情节层不分人格，读权限里的人格限制用不上
const readable = (access: Access) => readableConditions(access, { personaIds: [] })

// 现在有效、查看者读得到的抽取事实
const factsOf = (access: Access) =>
  and(eq(memories.form, 'extracted'), eq(memories.layer, 'subject'), readable(access))!

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

// 来源作用域（global、app:<id>、group:<对象>、direct:<对象>）换成带名字的形式；应用或对象删掉了时名字为空
async function scopeNames(tx: Tx, scopes: string[]): Promise<(scope: string) => OriginScope> {
  const parse = (scope: string) => {
    const [kind, id] = scope.split(':', 2) as [string, string | undefined]
    return { kind, id: id && UUID.test(id) ? id : null }
  }
  const parsed = scopes.map(parse)
  const appIds = [...new Set(parsed.filter((p) => p.kind === 'app' && p.id).map((p) => p.id!))]
  const subjectIds = [
    ...new Set(
      parsed.filter((p) => (p.kind === 'group' || p.kind === 'direct') && p.id).map((p) => p.id!),
    ),
  ]
  const [appRows, subjectRows] = await Promise.all([
    appIds.length
      ? tx.select({ id: apps.id, name: apps.name }).from(apps).where(inArray(apps.id, appIds))
      : [],
    subjectIds.length
      ? tx
          .select({ id: subjects.id, name: subjects.displayName })
          .from(subjects)
          .where(inArray(subjects.id, subjectIds))
      : [],
  ])
  const names = new Map([...appRows, ...subjectRows].map((r) => [r.id, r.name]))
  return (scope) => {
    const { kind, id } = parse(scope)
    if (kind === 'app' || kind === 'group' || kind === 'direct') {
      return { kind, id, name: id ? (names.get(id) ?? null) : null }
    }
    return { kind: 'global', id: null, name: null }
  }
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
      const { role, service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      const access = service.access
      const result = await withSpace(deps.db, spaceId, async (tx) => {
        const [found] = await subjectInfos(tx, access, eq(subjects.id, subjectId))
        if (!found) return null
        // 会话摘要按来源作用域找：群里的，或和这个人的私聊里的
        const scope = `${found.info.kind === 'group' ? 'group' : 'direct'}:${subjectId}`
        const [facts, summaries, runs] = await Promise.all([
          tx
            .select()
            .from(memories)
            .where(and(eq(memories.subjectId, subjectId), factsOf(access)))
            .orderBy(desc(memories.updatedAt), desc(memories.id))
            .limit(DETAIL_FACTS),
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
        ])
        const named = await scopeNames(tx, [
          ...facts.map((f) => f.originScope),
          ...runs.map((r) => r.run.scope),
        ])
        return {
          ...found.info,
          facts: facts.map((f) => ({
            id: f.id,
            content: f.content ?? '',
            provenance: f.provenance,
            scope: named(f.originScope),
            createdAt: f.createdAt.toISOString(),
            updatedAt: f.updatedAt.toISOString(),
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
            // 失败原因里可能有模型接口返回的原文，只给 owner 与 editor 看
            error: run.error && role === 'viewer' ? '抽取失败' : run.error,
          })),
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
}
