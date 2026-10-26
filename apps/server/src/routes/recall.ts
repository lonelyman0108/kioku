import { createRoute } from '@hono/zod-openapi'
import {
  BootResponse,
  ErrorResponse,
  LifecycleEvent,
  LifecycleResponse,
  RecallRequest,
  RecallResponse,
} from '@kioku/contracts'

import { requireKey } from '../auth/middleware'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { handleLifecycle } from '../lifecycle/lifecycle'
import { recallScopeForKey } from '../memory/context'
import { boot } from '../recall/boot'
import { embedQuery, recall } from '../recall/recall'

const security = [{ bearer: [] }]
const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('Key 无效', ErrorResponse),
}

const recallRoute = createRoute({
  method: 'post',
  path: '/recall',
  tags: ['recall'],
  summary: '按一段文本召回候选记忆（只返回 URI 与线索，正文用 GET /memories 读）',
  security,
  request: { body: jsonBody(RecallRequest) },
  responses: { 200: jsonResponse('候选', RecallResponse), ...errors },
})

const bootRoute = createRoute({
  method: 'get',
  path: '/boot',
  tags: ['recall'],
  summary: '会话开始时应注入的启动节点',
  security,
  responses: { 200: jsonResponse('启动节点', BootResponse), ...errors },
})

const lifecycleRoute = createRoute({
  method: 'post',
  path: '/lifecycle/event',
  tags: ['lifecycle'],
  summary: '插件转发宿主的生命周期事件，返回宿主可直接使用的输出',
  security,
  request: { body: jsonBody(LifecycleEvent) },
  responses: { 200: jsonResponse('宿主输出', LifecycleResponse), ...errors },
})

export function recallRoutes(deps: Deps) {
  const app = router()
  for (const path of ['/recall', '/boot', '/lifecycle/event']) app.use(path, requireKey(deps))
  return app
    .openapi(recallRoute, async (c) => {
      const scope = recallScopeForKey(deps, c.get('key'))
      const { query, limit } = c.req.valid('json')
      const semantic = await embedQuery(await scope.embedder(), query)
      const candidates = await scope.run((tx, personaIds) =>
        recall(tx, scope.access, semantic, query, { limit, personaIds }),
      )
      return c.json({ candidates }, 200)
    })
    .openapi(bootRoute, async (c) => {
      const scope = recallScopeForKey(deps, c.get('key'))
      return c.json(await scope.run((tx, personaIds) => boot(tx, scope.access, personaIds)), 200)
    })
    .openapi(lifecycleRoute, async (c) => {
      const key = c.get('key')
      const scope = recallScopeForKey(deps, key)
      return c.json(await handleLifecycle(scope, key.app.runtimeFamily, c.req.valid('json')), 200)
    })
}
