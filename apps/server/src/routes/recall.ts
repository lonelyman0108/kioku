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
import { lifecycleEvent, recallRequest } from '../lifecycle/handlers'
import { recallScopeForKey } from '../memory/context'

const security = [{ bearer: [] }]
const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('Key 无效', ErrorResponse),
}

const recallRoute = createRoute({
  method: 'post',
  path: '/recall',
  tags: ['recall'],
  summary:
    '按一段文本召回候选记忆（只返回 URI 与线索，正文用 GET /memories 读）；带了会话上下文时按它收紧权限，并附上当前发言人与本群的事实',
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
  summary:
    '插件转发宿主的生命周期事件，返回宿主可直接使用的输出；turn.end 把这一轮对话放进会话缓冲，攒批后抽取',
  security,
  request: { body: jsonBody(LifecycleEvent) },
  responses: { 200: jsonResponse('宿主输出', LifecycleResponse), ...errors },
})

export function recallRoutes(deps: Deps) {
  const app = router()
  for (const path of ['/recall', '/boot', '/lifecycle/event']) app.use(path, requireKey(deps))
  return app
    .openapi(recallRoute, async (c) => {
      const key = c.get('key')
      const result = await recallRequest(deps, key, c.req.valid('json'), (session) =>
        recallScopeForKey(deps, key, session),
      )
      return c.json(result, 200)
    })
    .openapi(bootRoute, async (c) =>
      c.json(await recallScopeForKey(deps, c.get('key')).boot(), 200),
    )
    .openapi(lifecycleRoute, async (c) => {
      const key = c.get('key')
      // 响应只有 LifecycleResponse 的字段，多带的那几项不发给接入方
      const { hostOutput, nodeUris } = await lifecycleEvent(
        deps,
        key,
        c.req.valid('json'),
        (session) => recallScopeForKey(deps, key, session),
      )
      return c.json({ hostOutput, nodeUris }, 200)
    })
}
