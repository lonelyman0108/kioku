import { createRoute, z } from '@hono/zod-openapi'
import {
  CreateMemoryRequest,
  DomainSummary,
  ErrorResponse,
  MemoryChildren,
  MemoryUri,
  MemoryView,
  MoveMemoryRequest,
  UpdateMemoryRequest,
} from '@kioku/contracts'

import { requireKey } from '../auth/middleware'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { memoryServiceForKey } from '../memory/context'

// URI 里有 :// 和 /，放在查询参数里，省去路径编码的麻烦
const UriQuery = z.object({ uri: MemoryUri })
const security = [{ bearer: [] }]
const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('Key 无效', ErrorResponse),
  403: jsonResponse('没有权限', ErrorResponse),
  404: jsonResponse('不存在或不可见', ErrorResponse),
  409: jsonResponse('冲突', ErrorResponse),
}

const get = createRoute({
  method: 'get',
  path: '/memories',
  tags: ['memories'],
  summary: '按 URI 读取一条记忆',
  security,
  request: { query: UriQuery },
  responses: { 200: jsonResponse('记忆', MemoryView), ...errors },
})

const children = createRoute({
  method: 'get',
  path: '/memories/children',
  tags: ['memories'],
  summary: '列出一个节点或 domain 根下的直接子节点',
  security,
  request: { query: z.object({ of: z.string().min(1) }) },
  responses: { 200: jsonResponse('子节点', MemoryChildren), ...errors },
})

const domains = createRoute({
  method: 'get',
  path: '/memories/domains',
  tags: ['memories'],
  summary: '列出可见的 domain 及节点数',
  security,
  responses: { 200: jsonResponse('domain 列表', z.array(DomainSummary)), ...errors },
})

const create = createRoute({
  method: 'post',
  path: '/memories',
  tags: ['memories'],
  summary: '新建策展记忆',
  security,
  request: { body: jsonBody(CreateMemoryRequest) },
  responses: { 201: jsonResponse('已创建', MemoryView), ...errors },
})

const update = createRoute({
  method: 'patch',
  path: '/memories',
  tags: ['memories'],
  summary: '修改记忆正文、敏感级、priority、disclosure 或 glossary',
  security,
  request: { body: jsonBody(UpdateMemoryRequest) },
  responses: { 200: jsonResponse('已修改', MemoryView), ...errors },
})

const remove = createRoute({
  method: 'delete',
  path: '/memories',
  tags: ['memories'],
  summary: '删除记忆（保留历史事件）',
  security,
  request: { query: UriQuery },
  responses: { 204: { description: '已删除' }, ...errors },
})

const move = createRoute({
  method: 'post',
  path: '/memories/move',
  tags: ['memories'],
  summary: '修改记忆的 URI',
  security,
  request: { body: jsonBody(MoveMemoryRequest) },
  responses: { 200: jsonResponse('已移动', MemoryView), ...errors },
})

export function memoryRoutes(deps: Deps) {
  const app = router()
  // '/memories/*' 同时匹配 /memories 本身；再单独注册 '/memories' 会让鉴权执行两次
  app.use('/memories/*', requireKey(deps))
  const service = (key: Parameters<typeof memoryServiceForKey>[1]) => memoryServiceForKey(deps, key)
  return app
    .openapi(get, async (c) =>
      c.json(await service(c.get('key')).get(c.req.valid('query').uri), 200),
    )
    .openapi(children, async (c) =>
      c.json(await service(c.get('key')).children(c.req.valid('query').of), 200),
    )
    .openapi(domains, async (c) => c.json(await service(c.get('key')).domains(), 200))
    .openapi(create, async (c) =>
      c.json(await service(c.get('key')).create(c.req.valid('json')), 201),
    )
    .openapi(update, async (c) =>
      c.json(await service(c.get('key')).update(c.req.valid('json')), 200),
    )
    .openapi(remove, async (c) => {
      await service(c.get('key')).delete(c.req.valid('query').uri)
      return c.body(null, 204)
    })
    .openapi(move, async (c) => c.json(await service(c.get('key')).move(c.req.valid('json')), 200))
}
