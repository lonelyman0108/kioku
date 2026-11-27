import { createRoute, z } from '@hono/zod-openapi'
import {
  BootResponse,
  ErrorResponse,
  LifecycleEventRequest,
  LifecycleEventResponse,
  normalizeProjectSlug,
  RecallRequest,
  RecallResponse,
  SceneSlug,
} from '@kioku/contracts'

import { synthesizeFocus } from '../access/scope'
import { requireKey } from '../auth/middleware'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { handleLifecycleEvent } from '../lifecycle/handlers'
import { compileBoot } from '../recall/boot'
import { recallEntries } from '../recall/recall'

const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('访问密钥无效', ErrorResponse),
}

const lifecycleRoute = createRoute({
  method: 'post',
  path: '/lifecycle/event',
  tags: ['agent'],
  security: [{ bearer: [] }],
  summary: '处理插件生命周期事件（session.start / prompt.submit / turn.end）',
  request: { body: jsonBody(LifecycleEventRequest) },
  responses: { 200: jsonResponse('宿主输出', LifecycleEventResponse), ...errors },
})

const bootRoute = createRoute({
  method: 'get',
  path: '/boot',
  tags: ['agent'],
  security: [{ bearer: [] }],
  summary: '加载当前终端透镜对应的常驻词条与近期会话摘要',
  request: {
    query: z.object({
      project: z.string().max(128).optional(),
      deviceKey: z.string().max(128).optional(),
      env: SceneSlug.optional(),
      realm: SceneSlug.optional(),
      runtime: SceneSlug.optional(),
    }),
  },
  responses: { 200: jsonResponse('启动加载内容', BootResponse), ...errors },
})

const recallRoute = createRoute({
  method: 'post',
  path: '/recall',
  tags: ['agent'],
  security: [{ bearer: [] }],
  summary: '按混合检索引擎召回记忆候选',
  request: { body: jsonBody(RecallRequest) },
  responses: { 200: jsonResponse('召回结果', RecallResponse), ...errors },
})

export function recallRoutes(deps: Deps) {
  const app = router()
  app.use('/lifecycle/event', requireKey(deps))
  app.use('/boot', requireKey(deps))
  app.use('/recall', requireKey(deps))

  app.openapi(lifecycleRoute, async (c) =>
    c.json(await handleLifecycleEvent(deps, c.get('key'), c.req.valid('json')), 200),
  )

  app.openapi(bootRoute, async (c) => {
    const key = c.get('key')
    const query = c.req.valid('query')
    const focus = synthesizeFocus(key, {
      project: query.project,
      env: query.env,
      realm: query.realm,
      runtime: query.runtime,
    })
    const projectSlug = normalizeProjectSlug(query.project) ?? ''
    const result = await compileBoot(deps.db, key, {
      focus,
      projectSlug,
      ...(query.deviceKey !== undefined ? { deviceKey: query.deviceKey } : {}),
    })
    return c.json(result, 200)
  })

  app.openapi(recallRoute, async (c) => {
    const key = c.get('key')
    const body = c.req.valid('json')
    const focus = synthesizeFocus(key, {
      env: body.env,
      realm: body.realm,
      project: body.project,
      runtime: body.runtime,
    })
    const candidates = await recallEntries(deps.db, deps.masterKey, key, body.query, {
      focus,
      ...(body.limit !== undefined ? { limit: body.limit } : {}),
    })
    return c.json({ candidates }, 200)
  })

  return app
}
