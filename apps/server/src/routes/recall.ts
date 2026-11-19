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
    '按一段文本召回候选词条（只返回短 ID 与线索，正文用 GET /entries 读）；带了会话上下文或切面时按它收紧权限并调制排序，并附上当前发言人与本群的事实',
  security,
  request: { body: jsonBody(RecallRequest) },
  responses: { 200: jsonResponse('候选', RecallResponse), ...errors },
})

const bootRoute = createRoute({
  method: 'get',
  path: '/boot',
  tags: ['recall'],
  summary: '会话开始时应注入的人格特质与启动词条',
  security,
  responses: { 200: jsonResponse('启动词条', BootResponse), ...errors },
})

const lifecycleRoute = createRoute({
  method: 'post',
  path: '/lifecycle/event',
  tags: ['lifecycle'],
  summary:
    '插件转发宿主的生命周期事件，返回宿主可直接使用的输出与短 ID 列表；turn.end 把这一轮对话放进会话缓冲，攒批后抽取',
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
      const result = await recallRequest(deps, key, c.req.valid('json'), (session, options) =>
        recallScopeForKey(deps, key, session, options),
      )
      return c.json(result, 200)
    })
    .openapi(bootRoute, async (c) =>
      c.json(await recallScopeForKey(deps, c.get('key')).boot(), 200),
    )
    .openapi(lifecycleRoute, async (c) => {
      const key = c.get('key')
      // 响应只有 LifecycleResponse 的字段，内部辅助字段不发给接入方
      const { hostOutput, shortIds } = await lifecycleEvent(
        deps,
        key,
        c.req.valid('json'),
        (session, options) => recallScopeForKey(deps, key, session, options),
      )
      return c.json({ hostOutput, shortIds }, 200)
    })
}
