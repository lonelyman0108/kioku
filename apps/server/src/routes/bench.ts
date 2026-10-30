import { createRoute, z } from '@hono/zod-openapi'
import {
  BENCH_MAX_REQUEST_BYTES,
  BenchRunRequest,
  BenchRunResult,
  BenchScenarioList,
  BenchToolList,
  ErrorResponse,
} from '@kioku/contracts'
import { bodyLimit } from 'hono/body-limit'

import { keyToSimulate } from '../access/simulate'
import { benchTools, runBench } from '../bench/inProcess'
import { BENCH_SCENARIOS } from '../bench/scenarios'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleRoleFor } from '../memory/context'

const KeyParams = z.object({ spaceId: z.uuid(), appId: z.uuid(), keyId: z.uuid() })
const errors = {
  403: jsonResponse('没有权限', ErrorResponse),
  404: jsonResponse('应用或 Key 不存在，或 Key 已作废', ErrorResponse),
}

const toolsRoute = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/apps/{appId}/keys/{keyId}/bench/tools',
  tags: ['bench'],
  summary: '测试台：真实 MCP 服务端的工具列表（只给应用主人）',
  request: { params: KeyParams },
  responses: { 200: jsonResponse('工具列表', BenchToolList), ...errors },
})

const runRoute = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/apps/{appId}/keys/{keyId}/bench/run',
  tags: ['bench'],
  summary: '测试台：按这把 Key 执行一串步骤，默认放进事务、结束时回滚（只给应用主人）',
  middleware: [
    bodyLimit({
      maxSize: BENCH_MAX_REQUEST_BYTES,
      onError: (c) => c.json({ error: '请求体太大，减少步骤或清空重放之后再试' }, 413),
    }),
  ],
  request: { params: KeyParams, body: jsonBody(BenchRunRequest) },
  responses: {
    200: jsonResponse('每一步的结果', BenchRunResult),
    400: jsonResponse('请求不合法', ErrorResponse),
    413: jsonResponse('请求体太大', ErrorResponse),
    429: jsonResponse('同时运行的回滚太多', ErrorResponse),
    ...errors,
  },
})

const scenariosRoute = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/bench/scenarios',
  tags: ['bench'],
  summary: '测试台：内置的场景预设',
  request: { params: z.object({ spaceId: z.uuid() }) },
  responses: {
    200: jsonResponse('场景', BenchScenarioList),
    403: jsonResponse('不是该空间成员', ErrorResponse),
  },
})

// 测试台是管理界面的接口（Cookie 会话）：tags 不用接入方的那几个，不进 Python SDK 的 OpenAPI
export function benchRoutes(deps: Deps) {
  return router()
    .openapi(toolsRoute, async (c) => {
      const found = await keyToSimulate(deps, c.req.valid('param'), c.get('console').accountId)
      if ('error' in found) return c.json({ error: found.error }, found.status)
      return c.json({ tools: await benchTools(deps, found.key) }, 200)
    })
    .openapi(runRoute, async (c) => {
      const accountId = c.get('console').accountId
      const found = await keyToSimulate(deps, c.req.valid('param'), accountId)
      if ('error' in found) return c.json({ error: found.error }, found.status)
      return c.json(await runBench(deps, found.key, accountId, c.req.valid('json')), 200)
    })
    .openapi(scenariosRoute, async (c) => {
      await consoleRoleFor(deps, c.req.valid('param').spaceId, c.get('console').accountId)
      return c.json({ scenarios: [...BENCH_SCENARIOS] }, 200)
    })
}
