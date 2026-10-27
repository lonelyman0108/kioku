import { createRoute, z } from '@hono/zod-openapi'
import {
  ActivityList,
  ConsoleSearchRequest,
  ConsoleSearchResponse,
  CreateMemoryRequest,
  DeletedMemoryList,
  DomainSummary,
  ErrorResponse,
  MemoryChildren,
  MemoryHistory,
  MemoryHistoryQuery,
  MemoryList,
  MemoryListQuery,
  MemoryUri,
  MemoryView,
  MoveMemoryRequest,
  PageQuery,
  RestoreRequest,
  UndeleteRequest,
  UpdateMemoryRequest,
} from '@kioku/contracts'
import type { Context } from 'hono'

import { memberRole, requireKey } from '../auth/middleware'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { memoryServiceForConsole, memoryServiceForKey, recallForConsole } from '../memory/context'
import { MemoryError, type MemoryService } from '../memory/service'

// 快速跳转最多列出的直接命中数
const MATCH_LIMIT = 10

// URI 里有 :// 和 /，放在查询参数里，省去路径编码的麻烦
const UriQuery = z.object({ uri: MemoryUri })
// 删除时可以带上读取时的 id 与版本号：删除后在同一个 URI 重建的、或期间被改过的记忆，不会被当成同一条删掉
const DeleteQuery = UriQuery.extend({
  expectedId: z.uuid().optional(),
  expectedVersion: z.coerce.number().int().optional(),
})
const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('未登录或凭据无效', ErrorResponse),
  403: jsonResponse('没有权限', ErrorResponse),
  404: jsonResponse('不存在或不可见', ErrorResponse),
  409: jsonResponse('冲突', ErrorResponse),
}

interface RouteSet {
  // 路径前缀，例如 '' 或 '/spaces/{spaceId}'
  prefix: string
  params: z.ZodObject
  tag: string
  security: { bearer: string[] }[] | undefined
  resolve: (c: Context<AppEnv>) => Promise<MemoryService>
}

// 同一套记忆接口挂两次：接入方用 API Key 访问 /memories，管理界面用登录会话访问 /spaces/{spaceId}/memories。
// 两边共用同一个服务层，只是权限来源不同
function memoryRouteSet(set: RouteSet) {
  const base = `${set.prefix}/memories`
  const common = { tags: [set.tag], ...(set.security ? { security: set.security } : {}) }
  const params = set.params
  const get = createRoute({
    ...common,
    method: 'get',
    path: base,
    summary: '按 URI 读取一条记忆',
    request: { params, query: UriQuery },
    responses: { 200: jsonResponse('记忆', MemoryView), ...errors },
  })
  const children = createRoute({
    ...common,
    method: 'get',
    path: `${base}/children`,
    summary: '列出一个节点或 domain 根下的直接子节点',
    request: { params, query: z.object({ of: z.string().min(1) }) },
    responses: { 200: jsonResponse('子节点', MemoryChildren), ...errors },
  })
  const domains = createRoute({
    ...common,
    method: 'get',
    path: `${base}/domains`,
    summary: '列出可见的 domain 及节点数',
    request: { params },
    responses: { 200: jsonResponse('domain 列表', z.array(DomainSummary)), ...errors },
  })
  const create = createRoute({
    ...common,
    method: 'post',
    path: base,
    summary: '新建策展记忆',
    request: { params, body: jsonBody(CreateMemoryRequest) },
    responses: { 201: jsonResponse('已创建', MemoryView), ...errors },
  })
  const update = createRoute({
    ...common,
    method: 'patch',
    path: base,
    summary: '修改记忆正文、敏感级、priority、disclosure 或 glossary',
    request: { params, body: jsonBody(UpdateMemoryRequest) },
    responses: { 200: jsonResponse('已修改', MemoryView), ...errors },
  })
  const remove = createRoute({
    ...common,
    method: 'delete',
    path: base,
    summary: '删除记忆（保留历史事件）',
    request: { params, query: DeleteQuery },
    responses: { 204: { description: '已删除' }, ...errors },
  })
  const move = createRoute({
    ...common,
    method: 'post',
    path: `${base}/move`,
    summary: '修改记忆的 URI',
    request: { params, body: jsonBody(MoveMemoryRequest) },
    responses: { 200: jsonResponse('已移动', MemoryView), ...errors },
  })

  const service = set.resolve
  return router()
    .openapi(get, async (c) => c.json(await (await service(c)).get(c.req.valid('query').uri), 200))
    .openapi(children, async (c) =>
      c.json(await (await service(c)).children(c.req.valid('query').of), 200),
    )
    .openapi(domains, async (c) => c.json(await (await service(c)).domains(), 200))
    .openapi(create, async (c) => c.json(await (await service(c)).create(c.req.valid('json')), 201))
    .openapi(update, async (c) => c.json(await (await service(c)).update(c.req.valid('json')), 200))
    .openapi(remove, async (c) => {
      const { uri, ...expected } = c.req.valid('query')
      await (await service(c)).delete(uri, expected)
      return c.body(null, 204)
    })
    .openapi(move, async (c) => c.json(await (await service(c)).move(c.req.valid('json')), 200))
}

export function memoryRoutes(deps: Deps) {
  const app = router()
  // '/memories/*' 同时匹配 /memories 本身；再单独注册 '/memories' 会让鉴权执行两次
  app.use('/memories/*', requireKey(deps))
  app.route(
    '/',
    memoryRouteSet({
      prefix: '',
      params: z.object({}),
      tag: 'memories',
      security: [{ bearer: [] }],
      resolve: async (c) => memoryServiceForKey(deps, c.get('key')),
    }),
  )
  // 会话鉴权已在 app.ts 对 /v1/spaces/* 统一注册
  app.route(
    '/',
    memoryRouteSet({
      prefix: '/spaces/{spaceId}',
      params: z.object({ spaceId: z.uuid() }),
      tag: 'console',
      security: undefined,
      resolve: async (c) => {
        const { service } = await consoleMember(deps, c)
        return service
      },
    }),
  )
  app.route('/', consoleOnlyRoutes(deps))
  return app
}

async function consoleMember(deps: Deps, c: Context<AppEnv>) {
  const spaceId = c.req.param('spaceId')!
  const accountId = c.get('console').accountId
  const role = await memberRole(deps, spaceId, accountId)
  if (!role) throw new MemoryError(403, '不是该空间成员')
  return {
    spaceId,
    accountId,
    role,
    service: await memoryServiceForConsole(deps, spaceId, accountId, role),
  }
}

// 只给管理界面的记忆接口：按条件列出、搜索、历史与恢复。Key 有 kioku_list 与召回，用不着这些
function consoleOnlyRoutes(deps: Deps) {
  const params = z.object({ spaceId: z.uuid() })
  const list = createRoute({
    method: 'get',
    path: '/spaces/{spaceId}/memories/list',
    tags: ['console'],
    summary: '按条件列出记忆，分页返回',
    request: { params, query: MemoryListQuery },
    responses: { 200: jsonResponse('记忆列表', MemoryList), ...errors },
  })
  const search = createRoute({
    method: 'post',
    path: '/spaces/{spaceId}/memories/search',
    tags: ['console'],
    summary: '搜索记忆：URI 与关键词的直接命中，加上召回的候选',
    request: { params, body: jsonBody(ConsoleSearchRequest) },
    responses: { 200: jsonResponse('搜索结果', ConsoleSearchResponse), ...errors },
  })
  const history = createRoute({
    method: 'get',
    path: '/spaces/{spaceId}/memories/history',
    tags: ['console'],
    summary: '一条记忆的历史，按管理读取过滤',
    request: { params, query: MemoryHistoryQuery },
    responses: { 200: jsonResponse('历史', MemoryHistory), ...errors },
  })
  const deleted = createRoute({
    method: 'get',
    path: '/spaces/{spaceId}/memories/deleted',
    tags: ['console'],
    summary: '已删除的记忆，最近删除的在前',
    request: { params, query: PageQuery },
    responses: { 200: jsonResponse('已删除的记忆', DeletedMemoryList), ...errors },
  })
  const restore = createRoute({
    method: 'post',
    path: '/spaces/{spaceId}/memories/restore',
    tags: ['console'],
    summary: '恢复到某个事件之后的那一版（只改正文、disclosure、priority 与关键词）',
    request: { params, body: jsonBody(RestoreRequest) },
    responses: { 200: jsonResponse('恢复后的记忆', MemoryView), ...errors },
  })
  const undelete = createRoute({
    method: 'post',
    path: '/spaces/{spaceId}/memories/undelete',
    tags: ['console'],
    summary: '撤销删除',
    request: { params, body: jsonBody(UndeleteRequest) },
    responses: { 200: jsonResponse('恢复后的记忆', MemoryView), ...errors },
  })
  const activity = createRoute({
    method: 'get',
    path: '/spaces/{spaceId}/activity',
    tags: ['console'],
    summary: '空间里记忆的改动，最新的在前',
    request: { params, query: PageQuery },
    responses: { 200: jsonResponse('活动', ActivityList), ...errors },
  })
  return router()
    .openapi(history, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.history(c.req.valid('query').id), 200)
    })
    .openapi(deleted, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.deleted(c.req.valid('query')), 200)
    })
    .openapi(restore, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.restore(c.req.valid('json')), 200)
    })
    .openapi(undelete, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.undelete(c.req.valid('json')), 200)
    })
    .openapi(activity, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.activity(c.req.valid('query')), 200)
    })
    .openapi(list, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.list(c.req.valid('query')), 200)
    })
    .openapi(search, async (c) => {
      const { spaceId, service } = await consoleMember(deps, c)
      const { query, limit } = c.req.valid('json')
      const [matches, candidates] = await Promise.all([
        service.matches(query, MATCH_LIMIT),
        recallForConsole(deps, spaceId, service.access, query, limit),
      ])
      return c.json({ matches, candidates }, 200)
    })
}
