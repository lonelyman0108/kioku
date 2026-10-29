import { createRoute, z } from '@hono/zod-openapi'
import {
  DeleteFactQuery,
  ErrorResponse,
  MergeSubjectRequest,
  SubjectDetail,
  SubjectInfo,
  SubjectList,
  SubjectListQuery,
  UpdateSubjectRequest,
} from '@kioku/contracts'
import { and, arrayContains, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'

import type { Access } from '../access/access'
import { isInstanceAdmin } from '../auth/middleware'
import { pgErrorCode, withSpace, type Tx } from '../db/client'
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
  appGroupPersonas,
  apps,
  conversationTurns,
  extractionRuns,
  memories,
  subjectIdentities,
  subjects,
} from '../db/schema'
import { extractionDelay, trimBatch } from '../extraction/buffer'
import { BATCH_MOVED, BUDGET_NO_SUMMARY, NO_USABLE_KEY } from '../extraction/extract'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'
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

type SubjectRow = typeof subjects.$inferSelect

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
  // 只有被合并的那个标记了成员时，标记跟过来；名字与改名锁留 into 的
  await tx
    .update(subjects)
    .set({ accountId: into.accountId ?? from.accountId, updatedAt: new Date() })
    .where(eq(subjects.id, into.id))
  await tx.delete(subjects).where(eq(subjects.id, from.id))
  return { scope: newScope, apps: [...new Set(moved.map((m) => m.appId))] }
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
      const { service } = await consoleMemberFor(deps, spaceId, accountId)
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
            version: f.version,
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
            error: errorOf(run.error),
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
        // 抽取或别的写入正占着这些行时不久等，返回让用户稍后再试
        await tx.execute(sql`set local lock_timeout = '5s'`)
        // 按 id 的顺序锁住两边：同时有两次合并涉及同一对对象时不会互相等成死锁
        const rows = await tx
          .select()
          .from(subjects)
          .where(inArray(subjects.id, [subjectId, from]))
          .orderBy(asc(subjects.id))
          .for('update')
        const into = rows.find((r) => r.id === subjectId)
        const gone = rows.find((r) => r.id === from)
        if (!into || !gone) return { status: 404 as const, error: '对象不存在' }
        if (into.kind !== gone.kind) return { status: 400 as const, error: '人和群不能合并' }
        // 合并会把一边的平台账号挂到另一边的标记下：和「只能标记成自己」一样，
        // 两边都只能是没标记的或标记成自己的，否则别人的私聊就能被当作那个成员的主人私聊
        if ([into.accountId, gone.accountId].some((a) => a !== null && a !== me)) {
          return {
            status: 403 as const,
            error: '标记成了别的成员的对象不能合并，要先请那位成员取消标记',
          }
        }
        const { scope, apps } = await mergeInto(tx, gone, into)
        // 移过来的缓冲和原有的并成一批：超出上限的删最早的，满一批就马上抽取
        const batches = []
        for (const appId of apps) batches.push({ appId, turns: await trimBatch(tx, appId, scope) })
        const [found] = await subjectInfos(tx, service.access, eq(subjects.id, subjectId))
        return { status: 200 as const, info: found!.info, scope, batches }
      })
      let result: Awaited<typeof merged>
      try {
        result = await merged
      } catch (err) {
        // 等锁超时（55P03）或和别的写入互相等成死锁（40P01）：都没改动，稍后再试就行
        const code = pgErrorCode(err)
        if (code === '55P03' || code === '40P01') {
          return c.json({ error: '这两个对象正在被别的操作使用（例如正在抽取），请稍后再试' }, 409)
        }
        throw err
      }
      if (result.status !== 200) return c.json({ error: result.error }, result.status)
      for (const { appId, turns } of result.batches) {
        await deps.jobs?.enqueueExtraction(
          { spaceId, appId, scope: result.scope },
          extractionDelay(turns),
        )
      }
      return c.json(result.info, 200)
    })
    .openapi(deleteFact, async (c) => {
      const { spaceId, subjectId, factId } = c.req.valid('param')
      const { version } = c.req.valid('query')
      const { role, service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      if (role === 'viewer') return c.json({ error: '需要 owner 或 editor 角色' }, 403)
      await service.deleteFact(subjectId, factId, version)
      return c.body(null, 204)
    })
}
