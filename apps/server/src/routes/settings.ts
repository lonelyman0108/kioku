import { createRoute, z } from '@hono/zod-openapi'
import {
  CancelTaskResponse,
  ErrorResponse,
  ExportFormat,
  ModelsSettingsResponse,
  RebuildEmbeddingsResponse,
  TestModelRequest,
  TestModelResponse,
  UpdateModelsSettingsRequest,
} from '@kioku/contracts'

import { getEmbeddingCoverage, purgeStaleEmbeddings } from '../embedding/worker'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { testModelConnection } from '../models/client'
import {
  CHAT_LLM_SETTING_KEY,
  EMBEDDING_SETTING_KEY,
  isDreamConfiguredByUser,
  loadDreamState,
  loadSavedModelApiKey,
  loadStoredModel,
  saveModelEndpoint,
  toPublicModelEndpoint,
  updateDreamConfig,
} from '../models/store'
import { exportTransferBundle } from '../transfer/service'

const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('未登录', ErrorResponse),
}

const getModelsRoute = createRoute({
  method: 'get',
  path: '/console/settings/models',
  tags: ['settings'],
  summary: '读取嵌入模型、对话模型、定时整理与向量覆盖率配置',
  responses: { 200: jsonResponse('模型设置', ModelsSettingsResponse), ...errors },
})

const putModelsRoute = createRoute({
  method: 'put',
  path: '/console/settings/models',
  tags: ['settings'],
  summary: '保存嵌入模型、对话模型与定时整理配置；更换嵌入模型时清理旧向量并触发补齐',
  request: { body: jsonBody(UpdateModelsSettingsRequest) },
  responses: { 200: jsonResponse('更新后的模型设置', ModelsSettingsResponse), ...errors },
})

const testModelRoute = createRoute({
  method: 'post',
  path: '/console/settings/models/test',
  tags: ['settings'],
  summary: '测试嵌入模型或对话模型连通性',
  request: { body: jsonBody(TestModelRequest) },
  responses: { 200: jsonResponse('测试结果', TestModelResponse), ...errors },
})

const backfillRoute = createRoute({
  method: 'post',
  path: '/console/settings/embedding/backfill',
  tags: ['settings'],
  summary: '触发缺失向量的后台补齐任务',
  responses: { 200: jsonResponse('入队结果', RebuildEmbeddingsResponse), ...errors },
})

const cancelBackfillRoute = createRoute({
  method: 'post',
  path: '/console/settings/embedding/backfill/cancel',
  tags: ['settings'],
  summary: '取消当前正在排队或执行中的向量补齐任务',
  responses: { 200: jsonResponse('取消结果', CancelTaskResponse), ...errors },
})

const exportRoute = createRoute({
  method: 'get',
  path: '/console/export',
  tags: ['settings'],
  summary: '导出全部未删除记忆为 JSON 或 Markdown 文件（不含任何加密凭据值）',
  request: { query: z.object({ format: ExportFormat.default('json') }) },
  responses: {
    200: { description: '导出的记忆文件内容' },
    ...errors,
  },
})

async function buildModelsSettings(deps: Deps): Promise<ModelsSettingsResponse> {
  const [embedding, chatLlm, dreamState, embeddingCoverage] = await Promise.all([
    loadStoredModel(deps.db, EMBEDDING_SETTING_KEY),
    loadStoredModel(deps.db, CHAT_LLM_SETTING_KEY),
    loadDreamState(deps.db),
    getEmbeddingCoverage(deps.db, deps.masterKey),
  ])
  return {
    embedding: toPublicModelEndpoint(embedding),
    chatLlm: toPublicModelEndpoint(chatLlm),
    dream: {
      enabled: dreamState.enabled,
      intervalHours: dreamState.intervalHours,
      ...(dreamState.schedules
        ? {
            crossMemory: {
              enabled: dreamState.schedules.crossMemory.enabled,
              intervalHours: dreamState.schedules.crossMemory.intervalHours,
            },
            tidy: {
              enabled: dreamState.schedules.tidy.enabled,
              intervalHours: dreamState.schedules.tidy.intervalHours,
            },
          }
        : {}),
    },
    embeddingCoverage,
    hasMasterKey: Boolean(deps.masterKey),
  }
}

export function settingsRoutes(deps: Deps) {
  return router()
    .openapi(getModelsRoute, async (c) => c.json(await buildModelsSettings(deps), 200))
    .openapi(putModelsRoute, async (c) => {
      const body = c.req.valid('json')
      let triggerBackfill = false

      if (body.embedding !== undefined) {
        const { previous, next } = await saveModelEndpoint(
          deps.db,
          deps.masterKey,
          EMBEDDING_SETTING_KEY,
          body.embedding,
        )
        const modelChanged =
          previous?.model !== next?.model ||
          previous?.baseUrl !== next?.baseUrl ||
          previous?.enabled !== next?.enabled
        if (modelChanged) {
          await deps.jobs?.cancelEmbeddingBackfill?.()
          await purgeStaleEmbeddings(deps.db, next?.enabled ? next.model : null)
          if (next?.enabled) triggerBackfill = true
        }
      }

      let chatNewlyEnabled = false
      if (body.chatLlm !== undefined) {
        const { previous, next } = await saveModelEndpoint(
          deps.db,
          deps.masterKey,
          CHAT_LLM_SETTING_KEY,
          body.chatLlm,
        )
        chatNewlyEnabled = !previous?.enabled && Boolean(next?.enabled)
      }

      if (body.dream !== undefined) {
        await updateDreamConfig(deps.db, body.dream, { markConfiguredByUser: true })
      } else if (chatNewlyEnabled && !(await isDreamConfiguredByUser(deps.db))) {
        // 首次启用对话模型且用户未手工配置过定时整理时，联动默认开启增量整理（24h）
        await updateDreamConfig(deps.db, { enabled: true }, { markConfiguredByUser: false })
      }

      if (triggerBackfill) {
        void deps.jobs?.enqueueBackfill()
      }

      return c.json(await buildModelsSettings(deps), 200)
    })
    .openapi(testModelRoute, async (c) => {
      const body = c.req.valid('json')
      let apiKey: string | null = body.apiKey?.trim() || null
      if (!apiKey && body.useSavedKey) {
        const key = body.kind === 'embedding' ? EMBEDDING_SETTING_KEY : CHAT_LLM_SETTING_KEY
        apiKey = await loadSavedModelApiKey(deps.db, deps.masterKey, key)
      }
      const result = await testModelConnection(body.kind, {
        baseUrl: body.baseUrl,
        model: body.model,
        apiKey,
        ...(body.kind === 'chat_llm' && body.reasoningEffort !== undefined
          ? { reasoningEffort: body.reasoningEffort }
          : {}),
      })
      return c.json(result, 200)
    })
    .openapi(backfillRoute, async (c) => {
      const coverage = await getEmbeddingCoverage(deps.db, deps.masterKey)
      if (!coverage.model) {
        return c.json({ error: '尚未配置或启用嵌入模型' }, 400)
      }
      const missing = Math.max(0, coverage.total - coverage.embedded)
      const enqueued = await deps.jobs?.enqueueBackfill({ total: missing, model: coverage.model })
      return c.json({ queued: enqueued === false ? 0 : missing }, 200)
    })
    .openapi(cancelBackfillRoute, async (c) => {
      const cancelled = (await deps.jobs?.cancelEmbeddingBackfill?.()) ?? false
      return c.json({ cancelled }, 200)
    })
    .openapi(exportRoute, async (c) => {
      const { format } = c.req.valid('query')
      const exported = await exportTransferBundle(deps.db, deps.masterKey, {
        format,
        includeCredentials: false,
      })
      c.header('Content-Type', exported.contentType)
      c.header('Content-Disposition', `attachment; filename="${exported.filename}"`)
      c.header('Cache-Control', 'no-store')
      return c.body(exported.body, 200)
    })
}
