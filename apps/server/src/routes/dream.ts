import { createRoute, z } from '@hono/zod-openapi'
import {
  ApplySuggestionRequest,
  ApplySuggestionResponse,
  CancelTaskResponse,
  ErrorResponse,
  InboxResponse,
  TriggerDreamRequest,
  TriggerDreamResponse,
} from '@kioku/contracts'

import { loadInbox } from '../extraction/dream'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { MemoryError } from '../memory/errors'
import type { EntryService } from '../memory/service'
import { CHAT_LLM_SETTING_KEY, loadStoredModel } from '../models/store'

const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('未登录', ErrorResponse),
  404: jsonResponse('整理建议不存在', ErrorResponse),
  409: jsonResponse('建议已处理或关联记忆已变动', ErrorResponse),
}

const SuggestionParams = z.object({ id: z.uuid() })

const inboxRoute = createRoute({
  method: 'get',
  path: '/console/inbox',
  tags: ['dream'],
  summary: '获取待处理的整理建议列表及最近整理状态',
  responses: { 200: jsonResponse('待处理建议', InboxResponse), ...errors },
})

const applyRoute = createRoute({
  method: 'post',
  path: '/console/inbox/{id}/apply',
  tags: ['dream'],
  summary: '应用一条整理建议（可选提交编辑后的草稿字段或分项覆盖）',
  request: { params: SuggestionParams, body: jsonBody(ApplySuggestionRequest) },
  responses: { 200: jsonResponse('已应用', ApplySuggestionResponse), ...errors },
})

const dismissRoute = createRoute({
  method: 'post',
  path: '/console/inbox/{id}/dismiss',
  tags: ['dream'],
  summary: '忽略一条整理建议',
  request: { params: SuggestionParams },
  responses: { 204: { description: '已忽略' }, ...errors },
})

const triggerRoute = createRoute({
  method: 'post',
  path: '/console/dream/run',
  tags: ['dream'],
  summary: '立即触发一次后台记忆整理（支持常规整理或规范与精简批次）',
  request: {
    body: {
      required: false,
      content: { 'application/json': { schema: TriggerDreamRequest } },
    },
  },
  responses: { 200: jsonResponse('触发结果', TriggerDreamResponse), ...errors },
})

const cancelRoute = createRoute({
  method: 'post',
  path: '/console/dream/cancel',
  tags: ['dream'],
  summary: '取消当前正在排队或执行中的后台记忆整理任务',
  responses: { 200: jsonResponse('取消结果', CancelTaskResponse), ...errors },
})

export function dreamRoutes(deps: Deps, entries: EntryService) {
  return router()
    .openapi(inboxRoute, async (c) => {
      const running = (await deps.jobs?.isDreamRunning()) ?? false
      const progress = running ? ((await deps.jobs?.getDreamProgress?.()) ?? null) : null
      const embeddingBackfill = deps.jobs?.getEmbeddingBackfillState?.()
      return c.json(await loadInbox(deps.db, running, progress, embeddingBackfill), 200)
    })
    .openapi(cancelRoute, async (c) => {
      const cancelled = (await deps.jobs?.cancelDream?.()) ?? false
      return c.json({ cancelled }, 200)
    })
    .openapi(applyRoute, async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      return c.json(await entries.applySuggestion(id, body), 200)
    })
    .openapi(dismissRoute, async (c) => {
      await entries.dismissSuggestion(c.req.valid('param').id)
      return c.body(null, 204)
    })
    .openapi(triggerRoute, async (c) => {
      let options: TriggerDreamRequest = { mode: 'standard' }
      const rawText = await c.req.text()
      if (rawText.trim()) {
        let json: unknown
        try {
          json = JSON.parse(rawText)
        } catch {
          throw new MemoryError(400, '请求体不是合法的 JSON')
        }
        const parsed = TriggerDreamRequest.safeParse(json)
        if (!parsed.success) {
          throw new MemoryError(400, parsed.error.issues[0]?.message ?? '请求参数不合法')
        }
        options = parsed.data
      }

      const chat = await loadStoredModel(deps.db, CHAT_LLM_SETTING_KEY)
      if (!chat?.enabled) {
        return c.json({ started: false, runId: null, reason: '尚未配置或启用对话模型' }, 200)
      }
      if (!deps.jobs) {
        return c.json({ started: false, runId: null, reason: '后台任务队列未启用' }, 200)
      }
      const runId = await deps.jobs.enqueueDream(options)
      return c.json(
        {
          started: runId !== null,
          runId,
          ...(runId === null ? { reason: '已有整理任务在排队或执行中' } : {}),
        },
        200,
      )
    })
}
