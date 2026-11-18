import { createRoute, z } from '@hono/zod-openapi'
import {
  ApplyDreamSuggestion,
  DreamApplied,
  DreamMemberSettings,
  DreamQueued,
  DreamRunList,
  DreamRunStatus,
  DreamSuggestionList,
  DreamSuggestionQuery,
  ErrorResponse,
} from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'

import { isInstanceAdmin, memberRole } from '../auth/middleware'
import { circleMembers } from '../db/schema'
import { dreamRunList, dreamRunOutcome } from '../extraction/dream'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'
import { applySuggestion, listSuggestions, rejectSuggestion } from '../memory/suggestions'

const CircleParams = z.object({ circleId: z.uuid() })
const SuggestionParams = CircleParams.extend({ suggestionId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('不存在，或者涉及的词条有读不到的', ErrorResponse)
const noJobs = jsonResponse('服务没有启动后台任务，或入队失败', ErrorResponse)
const EDITORS = '需要记忆圈所有者或编辑者角色'

const list = createRoute({
  method: 'get',
  path: '/circles/{circleId}/dream/suggestions',
  tags: ['review'],
  summary: 'Dream 的建议：还没处理、涉及的词条都没改过的，新的在前',
  request: { params: CircleParams, query: DreamSuggestionQuery },
  responses: {
    200: jsonResponse('建议', DreamSuggestionList),
    400: jsonResponse('翻页参数无效', ErrorResponse),
    403: forbidden,
  },
})

const apply = createRoute({
  method: 'post',
  path: '/circles/{circleId}/dream/suggestions/{suggestionId}/apply',
  tags: ['review'],
  summary: '按建议执行：涉及的词条在建议生成之后改过就不执行，写入的来源记为执行的成员',
  request: { params: SuggestionParams, body: jsonBody(ApplyDreamSuggestion) },
  responses: {
    200: jsonResponse('已执行；提炼时带上新建的词条', DreamApplied),
    400: jsonResponse('修改不合规则，或者没过写入检查', ErrorResponse),
    403: forbidden,
    404: notFound,
    409: jsonResponse('已经处理过，或者涉及的词条改过了', ErrorResponse),
  },
})

const reject = createRoute({
  method: 'post',
  path: '/circles/{circleId}/dream/suggestions/{suggestionId}/reject',
  tags: ['review'],
  summary: '拒绝一条建议：记下来，涉及的词条没改过之前同样的建议不再提',
  request: { params: SuggestionParams },
  responses: {
    204: { description: '已拒绝' },
    403: forbidden,
    404: notFound,
    409: jsonResponse('已经处理过', ErrorResponse),
  },
})

const start = createRoute({
  method: 'post',
  path: '/circles/{circleId}/dream/runs',
  tags: ['review'],
  summary: '现在整理一次：排进后台任务，返回任务编号，按编号查这一次做得怎么样',
  request: { params: CircleParams },
  responses: { 202: jsonResponse('已排队', DreamQueued), 403: forbidden, 503: noJobs },
})

const runs = createRoute({
  method: 'get',
  path: '/circles/{circleId}/dream/runs',
  tags: ['review'],
  summary: '最近几次整理：每个范围用了多少 token、提了几条建议，没整理的原因',
  request: { params: CircleParams },
  responses: { 200: jsonResponse('运行记录', DreamRunList), 403: forbidden },
})

const status = createRoute({
  method: 'get',
  path: '/circles/{circleId}/dream/runs/{runId}',
  tags: ['review'],
  summary:
    '一次整理的状态：排着、正在整理、做完了（整理过了、没整理、出错了）；共享的内容整理完就算做完，结果按共享部分的汇总与查看者有权限的部分算',
  request: { params: CircleParams.extend({ runId: z.uuid() }) },
  responses: {
    200: jsonResponse('状态', DreamRunStatus),
    403: forbidden,
    404: jsonResponse('没有这次整理', ErrorResponse),
    503: noJobs,
  },
})

const mySettings = createRoute({
  method: 'get',
  path: '/circles/{circleId}/me/dream',
  tags: ['review'],
  summary: '自己在这个记忆圈里的 Dream 设置：让不让 Dream 整理自己的私密/本地内容',
  request: { params: CircleParams },
  responses: { 200: jsonResponse('设置', DreamMemberSettings), 403: forbidden },
})

const saveMySettings = createRoute({
  method: 'put',
  path: '/circles/{circleId}/me/dream',
  tags: ['review'],
  summary:
    '改自己的 Dream 设置（只改得了自己的）：关掉之后个人范围内内容不再发给抽取模型，已经生成的建议留着',
  request: { params: CircleParams, body: jsonBody(DreamMemberSettings) },
  responses: {
    200: jsonResponse('已保存', DreamMemberSettings),
    400: jsonResponse('请求不合法', ErrorResponse),
    403: forbidden,
  },
})

export function dreamRoutes(deps: Deps) {
  const member = (circleId: string, accountId: string) => memberRole(deps, circleId, accountId)
  const mine = (circleId: string, accountId: string) =>
    and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, accountId))
  return router()
    .openapi(list, async (c) => {
      const { circleId } = c.req.valid('param')
      const { role, service } = await consoleMemberFor(deps, circleId, c.get('console').accountId)
      return c.json(
        await listSuggestions(deps.db, circleId, service, role, c.req.valid('query')),
        200,
      )
    })
    .openapi(apply, async (c) => {
      const { circleId, suggestionId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, circleId, accountId)
      if (role === 'viewer') return c.json({ error: EDITORS }, 403)
      return c.json(
        await applySuggestion(service, suggestionId, c.req.valid('json'), accountId),
        200,
      )
    })
    .openapi(reject, async (c) => {
      const { circleId, suggestionId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, circleId, accountId)
      if (role === 'viewer') return c.json({ error: EDITORS }, 403)
      await rejectSuggestion(service, suggestionId, accountId)
      return c.body(null, 204)
    })
    .openapi(start, async (c) => {
      const { circleId } = c.req.valid('param')
      const role = await member(circleId, c.get('console').accountId)
      if (!role) return c.json({ error: '无权访问此记忆圈' }, 403)
      if (role === 'viewer') return c.json({ error: EDITORS }, 403)
      const runId = await deps.jobs?.enqueueDream(circleId)
      if (!runId) return c.json({ error: '未能加入后台任务，请稍后重试' }, 503)
      return c.json({ runId }, 202)
    })
    .openapi(runs, async (c) => {
      const { circleId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      if (!(await member(circleId, accountId))) return c.json({ error: '无权访问此记忆圈' }, 403)
      const admin = await isInstanceAdmin(deps.db, accountId)
      return c.json(await dreamRunList(deps.db, circleId, { accountId, admin }), 200)
    })
    .openapi(status, async (c) => {
      const { circleId, runId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      if (!(await member(circleId, accountId))) {
        return c.json({ error: '无权访问此记忆圈' }, 403)
      }
      if (!deps.jobs) return c.json({ error: '服务未启动后台任务' }, 503)
      const found = await deps.jobs.dreamRun(circleId, runId)
      if (!found) return c.json({ error: '此次整理不存在' }, 404)
      if (found.state === 'queued') return c.json(found, 200)
      const seen = await dreamRunOutcome(deps.db, circleId, runId, accountId)
      if (seen) return c.json({ state: 'finished' as const, ...seen }, 200)
      return c.json(
        found.state === 'running'
          ? { state: 'running' as const, outcome: null, reason: null }
          : { state: 'finished' as const, outcome: 'failed' as const, reason: null },
        200,
      )
    })
    .openapi(mySettings, async (c) => {
      const { circleId } = c.req.valid('param')
      const [row] = await deps.db
        .select({ includePrivate: circleMembers.dreamPrivate })
        .from(circleMembers)
        .where(mine(circleId, c.get('console').accountId))
      if (!row) return c.json({ error: '无权访问此记忆圈' }, 403)
      return c.json(row, 200)
    })
    .openapi(saveMySettings, async (c) => {
      const { circleId } = c.req.valid('param')
      const [row] = await deps.db
        .update(circleMembers)
        .set({ dreamPrivate: c.req.valid('json').includePrivate })
        .where(mine(circleId, c.get('console').accountId))
        .returning({ includePrivate: circleMembers.dreamPrivate })
      if (!row) return c.json({ error: '无权访问此记忆圈' }, 403)
      return c.json(row, 200)
    })
}
