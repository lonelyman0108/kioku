import { createRoute } from '@hono/zod-openapi'
import {
  EmbeddingSettingsView,
  EmbeddingTestResult,
  ErrorResponse,
  UpdateEmbeddingSettings,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'

import { requireConsole } from '../auth/middleware'
import { accounts, EMBEDDING_DIMENSIONS } from '../db/schema'
import { openAiEmbedder } from '../embedding/provider'
import {
  embeddingSettingsView,
  loadEmbeddingConfig,
  saveEmbeddingConfig,
} from '../embedding/settings'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const forbidden = jsonResponse('需要实例管理员', ErrorResponse)

const view = createRoute({
  method: 'get',
  path: '/settings/embedding',
  tags: ['settings'],
  summary: '嵌入模型设置（不返回 Key）',
  responses: { 200: jsonResponse('设置', EmbeddingSettingsView), 403: forbidden },
})

const update = createRoute({
  method: 'put',
  path: '/settings/embedding',
  tags: ['settings'],
  summary: '修改嵌入模型；之后在后台为全部记忆重新生成向量',
  request: { body: jsonBody(UpdateEmbeddingSettings) },
  responses: {
    200: jsonResponse('已保存', EmbeddingSettingsView),
    400: jsonResponse('无法保存', ErrorResponse),
    403: forbidden,
  },
})

const test = createRoute({
  method: 'post',
  path: '/settings/embedding/test',
  tags: ['settings'],
  summary: '用已保存的设置请求一次嵌入，检查连通性与维度',
  responses: { 200: jsonResponse('测试结果', EmbeddingTestResult), 403: forbidden },
})

export function settingsRoutes(deps: Deps) {
  const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
    const [account] = await deps.db
      .select({ isAdmin: accounts.isAdmin })
      .from(accounts)
      .where(eq(accounts.id, c.get('console').accountId))
    if (!account?.isAdmin) return c.json({ error: '需要实例管理员' }, 403)
    await next()
  })
  const app = router()
  app.use('/settings/*', requireConsole(deps), requireAdmin)

  const current = async () => ({
    ...(await embeddingSettingsView(deps.db)),
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return app
    .openapi(view, async (c) => c.json(await current(), 200))
    .openapi(update, async (c) => {
      try {
        await saveEmbeddingConfig(deps.db, deps.masterKey, c.req.valid('json'))
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400)
      }
      deps.embedder.invalidate()
      deps.jobs?.enqueueBackfill()
      return c.json(await current(), 200)
    })
    .openapi(test, async (c) => {
      const started = Date.now()
      try {
        const config = await loadEmbeddingConfig(deps.db, deps.masterKey)
        if (!config) throw new Error('还没有保存嵌入设置')
        await openAiEmbedder(config).embed(['连通性测试'])
        return c.json({ ok: true, latencyMs: Date.now() - started, error: null }, 200)
      } catch (err) {
        return c.json(
          { ok: false, latencyMs: Date.now() - started, error: (err as Error).message },
          200,
        )
      }
    })
}
