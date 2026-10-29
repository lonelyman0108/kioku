import { createRoute, z } from '@hono/zod-openapi'
import {
  ApplyDreamSuggestion,
  DreamApplied,
  DreamQueued,
  DreamRunList,
  DreamRunStatus,
  DreamSuggestionList,
  DreamSuggestionQuery,
  ErrorResponse,
} from '@kioku/contracts'

import { isInstanceAdmin, memberRole } from '../auth/middleware'
import { dreamRunList } from '../extraction/dream'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleMemberFor } from '../memory/context'
import { applySuggestion, listSuggestions, rejectSuggestion } from '../memory/suggestions'

const SpaceParams = z.object({ spaceId: z.uuid() })
const SuggestionParams = SpaceParams.extend({ suggestionId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const notFound = jsonResponse('不存在，或者涉及的记忆有读不到的', ErrorResponse)
const noJobs = jsonResponse('服务没有启动后台任务，或入队失败', ErrorResponse)
const EDITORS = '需要 owner 或 editor 角色'

const list = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/dream/suggestions',
  tags: ['review'],
  summary: 'Dream 的建议：还没处理、涉及的记忆都没改过的，新的在前',
  request: { params: SpaceParams, query: DreamSuggestionQuery },
  responses: {
    200: jsonResponse('建议', DreamSuggestionList),
    400: jsonResponse('翻页参数无效', ErrorResponse),
    403: forbidden,
  },
})

const apply = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/dream/suggestions/{suggestionId}/apply',
  tags: ['review'],
  summary:
    '按建议执行（合并、提炼可以先改）：涉及的记忆在建议生成之后改过就不执行，写入的来源记为执行的成员',
  request: { params: SuggestionParams, body: jsonBody(ApplyDreamSuggestion) },
  responses: {
    200: jsonResponse('已执行；提炼时带上新建的记忆', DreamApplied),
    400: jsonResponse('修改不合规则，或者没过写入检查', ErrorResponse),
    403: forbidden,
    404: notFound,
    409: jsonResponse('已经处理过，涉及的记忆改过了，或者 URI 已被占用', ErrorResponse),
  },
})

const reject = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/dream/suggestions/{suggestionId}/reject',
  tags: ['review'],
  summary: '拒绝一条建议：记下来，涉及的记忆没改过之前同样的建议不再提',
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
  path: '/spaces/{spaceId}/dream/runs',
  tags: ['review'],
  summary: '现在整理一次：排进后台任务，返回任务编号，按编号查这一次做得怎么样',
  request: { params: SpaceParams },
  responses: { 202: jsonResponse('已排队', DreamQueued), 403: forbidden, 503: noJobs },
})

const runs = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/dream/runs',
  tags: ['review'],
  summary: '最近几次整理：每个范围用了多少 token、提了几条建议，没整理的原因',
  request: { params: SpaceParams },
  responses: { 200: jsonResponse('运行记录', DreamRunList), 403: forbidden },
})

const status = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/dream/runs/{runId}',
  tags: ['review'],
  summary: '一次整理的状态：排着、正在整理、做完了（整理过了、没整理、出错了）',
  request: { params: SpaceParams.extend({ runId: z.uuid() }) },
  responses: {
    200: jsonResponse('状态', DreamRunStatus),
    403: forbidden,
    404: jsonResponse('没有这次整理', ErrorResponse),
    503: noJobs,
  },
})

// 成员都能看，处理建议与手动整理要 owner 或 editor
export function dreamRoutes(deps: Deps) {
  const member = (spaceId: string, accountId: string) => memberRole(deps, spaceId, accountId)
  return router()
    .openapi(list, async (c) => {
      const { spaceId } = c.req.valid('param')
      const { role, service } = await consoleMemberFor(deps, spaceId, c.get('console').accountId)
      return c.json(
        await listSuggestions(deps.db, spaceId, service, role, c.req.valid('query')),
        200,
      )
    })
    .openapi(apply, async (c) => {
      const { spaceId, suggestionId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, spaceId, accountId)
      if (role === 'viewer') return c.json({ error: EDITORS }, 403)
      return c.json(
        await applySuggestion(service, suggestionId, c.req.valid('json'), accountId),
        200,
      )
    })
    .openapi(reject, async (c) => {
      const { spaceId, suggestionId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const { role, service } = await consoleMemberFor(deps, spaceId, accountId)
      if (role === 'viewer') return c.json({ error: EDITORS }, 403)
      await rejectSuggestion(service, suggestionId, accountId)
      return c.body(null, 204)
    })
    .openapi(start, async (c) => {
      const { spaceId } = c.req.valid('param')
      const role = await member(spaceId, c.get('console').accountId)
      if (!role) return c.json({ error: '不是该空间成员' }, 403)
      if (role === 'viewer') return c.json({ error: EDITORS }, 403)
      const runId = await deps.jobs?.enqueueDream(spaceId)
      if (!runId) return c.json({ error: '没有排进后台任务，稍后再试' }, 503)
      return c.json({ runId }, 202)
    })
    .openapi(runs, async (c) => {
      const { spaceId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      if (!(await member(spaceId, accountId))) return c.json({ error: '不是该空间成员' }, 403)
      const admin = await isInstanceAdmin(deps.db, accountId)
      return c.json(await dreamRunList(deps.db, spaceId, { accountId, admin }), 200)
    })
    .openapi(status, async (c) => {
      const { spaceId, runId } = c.req.valid('param')
      if (!(await member(spaceId, c.get('console').accountId))) {
        return c.json({ error: '不是该空间成员' }, 403)
      }
      if (!deps.jobs) return c.json({ error: '服务没有启动后台任务' }, 503)
      const found = await deps.jobs.dreamRun(spaceId, runId)
      if (!found) return c.json({ error: '没有这次整理' }, 404)
      return c.json(found, 200)
    })
}
