import { createRoute } from '@hono/zod-openapi'
import {
  EmbeddingCoverage,
  EmbeddingRebuildResult,
  EmbeddingSettingsView,
  EmbeddingTestResult,
  ErrorResponse,
  UpdateEmbeddingSettings,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'

import { requireConsole } from '../auth/middleware'
import { accounts, EMBEDDING_DIMENSIONS } from '../db/schema'
import { embeddingCoverage } from '../embedding/coverage'
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

const status = createRoute({
  method: 'get',
  path: '/settings/embedding/status',
  tags: ['settings'],
  summary: '整个实例的向量覆盖率：应当有向量的记忆里有多少已经生成',
  responses: { 200: jsonResponse('覆盖率', EmbeddingCoverage), 403: forbidden },
})

const rebuild = createRoute({
  method: 'post',
  path: '/settings/embedding/rebuild',
  tags: ['settings'],
  summary: '在后台检查全部记忆，补齐缺少或过时的向量',
  responses: {
    202: jsonResponse('已排队', EmbeddingRebuildResult),
    400: jsonResponse('还没有保存嵌入设置', ErrorResponse),
    403: forbidden,
  },
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
      void deps.jobs?.enqueueBackfill()
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
    .openapi(status, async (c) => {
      const view = await embeddingSettingsView(deps.db)
      const coverage = await embeddingCoverage(deps.db, view.model)
      return c.json({ configured: view.configured, model: view.model, ...coverage }, 200)
    })
    .openapi(rebuild, async (c) => {
      if (!(await embeddingSettingsView(deps.db)).configured) {
        return c.json({ error: '还没有保存嵌入设置' }, 400)
      }
      // 入队失败时如实返回 queued: false，不让管理员以为补齐已经在跑
      const queued = deps.jobs ? await deps.jobs.enqueueBackfill() : false
      return c.json({ queued }, 202)
    })
}
