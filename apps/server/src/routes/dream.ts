import { createRoute, z } from '@hono/zod-openapi'
import {
  ApplySuggestionRequest,
  ApplySuggestionResponse,
  CancelTaskResponse,
  ClearDreamQueueResponse,
  ErrorResponse,
  InboxResponse,
  normalizeShortId,
  RemoveQueuedDreamResponse,
  RetryDreamRunRequest,
  ReviseSuggestionRequest,
  ReviseSuggestionResponse,
  TriggerDreamRequest,
  TriggerDreamResponse,
  type DreamMode,
  type DreamRunSummary,
} from '@kioku/contracts'

import { loadInbox } from '../extraction/dream'
import { reviseSuggestion } from '../extraction/reviseSuggestion'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import type { DreamEnqueueOptions } from '../jobs/queue'
import { MemoryError } from '../memory/errors'
import type { EntryService } from '../memory/service'
import {
  CHAT_LLM_SETTING_KEY,
  loadDreamState,
  loadStoredModel,
  markDreamRunRetried,
} from '../models/store'

const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('未登录', ErrorResponse),
  404: jsonResponse('资源不存在', ErrorResponse),
  409: jsonResponse('建议已处理或关联记忆已变动', ErrorResponse),
}

const SuggestionParams = z.object({ id: z.uuid() })
const QueuedJobParams = z.object({ id: z.string().min(1) })
const RunIdParams = z.object({ runId: z.string().min(1) })

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

const reviseRoute = createRoute({
  method: 'post',
  path: '/console/inbox/{id}/revise',
  tags: ['dream'],
  summary: '按单句说明无状态修订一条待处理整理建议草稿（不写入数据库）',
  request: { params: SuggestionParams, body: jsonBody(ReviseSuggestionRequest) },
  responses: { 200: jsonResponse('修订后的建议草稿', ReviseSuggestionResponse), ...errors },
})

const triggerRoute = createRoute({
  method: 'post',
  path: '/console/dream/run',
  tags: ['dream'],
  summary: '立即触发或排队一次后台记忆整理（支持常规整理、规范整理与查重关联）',
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
  summary: '取消当前正在执行中的后台记忆整理任务',
  responses: { 200: jsonResponse('取消结果', CancelTaskResponse), ...errors },
})

const removeQueuedRoute = createRoute({
  method: 'delete',
  path: '/console/dream/queue/{id}',
  tags: ['dream'],
  summary: '从等待队列中移出一条尚未开始执行的整理任务',
  request: { params: QueuedJobParams },
  responses: { 200: jsonResponse('移出结果', RemoveQueuedDreamResponse), ...errors },
})

const clearQueueRoute = createRoute({
  method: 'delete',
  path: '/console/dream/queue',
  tags: ['dream'],
  summary: '清空全部等待中的整理任务（不影响正在执行的任务）',
  responses: { 200: jsonResponse('清空结果', ClearDreamQueueResponse), ...errors },
})

const retryRunRoute = createRoute({
  method: 'post',
  path: '/console/dream/runs/{runId}/retry',
  tags: ['dream'],
  summary: '按原参数或失败项子集重试一条历史整理记录',
  request: {
    params: RunIdParams,
    body: {
      required: false,
      content: { 'application/json': { schema: RetryDreamRunRequest } },
    },
  },
  responses: { 200: jsonResponse('重试入队结果', TriggerDreamResponse), ...errors },
})

function inferRunMode(run: DreamRunSummary): DreamMode {
  if (run.mode === 'tidy' || run.mode === 'cross_memory' || run.mode === 'standard') {
    return run.mode
  }
  const firstKind = run.failedItems?.[0]?.kind
  if (firstKind === 'tidy') return 'tidy'
  if (firstKind === 'cross_memory') return 'cross_memory'
  return 'standard'
}

function buildRetryOptions(
  run: DreamRunSummary,
  requestedScope: RetryDreamRunRequest['scope'],
): { ok: true; options: DreamEnqueueOptions } | { ok: false; reason: string } {
  const mode = inferRunMode(run)
  const failedShortIds = [
    ...new Set((run.failedItems ?? []).map((item) => normalizeShortId(item.shortId))),
  ]
  const effectiveScope =
    requestedScope ??
    (run.outcome === 'partial' && failedShortIds.length > 0 ? 'failed_only' : 'full')

  if (effectiveScope === 'failed_only') {
    if (!failedShortIds.length) {
      return { ok: false, reason: '该记录没有可单独重试的失败项' }
    }
    return {
      ok: true,
      options: {
        mode,
        targetShortIds: failedShortIds,
        ...(mode === 'tidy' && run.params?.pinnedFirst !== undefined
          ? { pinnedFirst: run.params.pinnedFirst }
          : {}),
      },
    }
  }

  if (run.params) {
    return {
      ok: true,
      options: {
        mode,
        ...(run.params.scope !== undefined ? { scope: run.params.scope } : {}),
        ...(run.params.limit !== undefined ? { limit: run.params.limit } : {}),
        ...(run.params.all !== undefined ? { all: run.params.all } : {}),
        ...(run.params.pinnedFirst !== undefined ? { pinnedFirst: run.params.pinnedFirst } : {}),
        ...(run.params.targetShortIds?.length ? { targetShortIds: run.params.targetShortIds } : {}),
      },
    }
  }

  // 兼容旧历史记录未存 params 时的默认兜底参数
  if (mode === 'cross_memory') {
    return { ok: true, options: { mode: 'cross_memory', scope: 'full_corpus' } }
  }
  if (mode === 'tidy') {
    return {
      ok: true,
      options: {
        mode: 'tidy',
        limit: run.trigger === 'scheduled' ? 20 : 10,
        pinnedFirst: true,
      },
    }
  }
  return { ok: true, options: { mode: 'standard' } }
}

export function dreamRoutes(deps: Deps, entries: EntryService) {
  return router()
    .openapi(inboxRoute, async (c) => {
      const snapshot = deps.jobs?.getDreamQueueSnapshot?.()
      const running = snapshot ? snapshot.running : ((await deps.jobs?.isDreamRunning()) ?? false)
      const progress = snapshot
        ? snapshot.progress
        : running
          ? ((await deps.jobs?.getDreamProgress?.()) ?? null)
          : null
      const runtime = snapshot
        ? {
            activeJobId: snapshot.activeJobId,
            activeTask: snapshot.activeTask,
            queued: snapshot.queued,
            queueLimit: snapshot.queueLimit,
          }
        : undefined
      const embeddingBackfill = deps.jobs?.getEmbeddingBackfillState?.()
      return c.json(await loadInbox(deps.db, running, progress, embeddingBackfill, runtime), 200)
    })
    .openapi(cancelRoute, async (c) => {
      const cancelled = (await deps.jobs?.cancelDream?.()) ?? false
      return c.json({ cancelled }, 200)
    })
    .openapi(removeQueuedRoute, async (c) => {
      const { id } = c.req.valid('param')
      const removed = (await deps.jobs?.removeQueuedDream?.(id)) ?? false
      return c.json({ removed }, 200)
    })
    .openapi(clearQueueRoute, async (c) => {
      const removed = (await deps.jobs?.clearDreamQueue?.()) ?? 0
      return c.json({ removed }, 200)
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
    .openapi(reviseRoute, async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      return c.json(
        await reviseSuggestion(deps.db, deps.masterKey, id, body, {
          signal: c.req.raw.signal,
        }),
        200,
      )
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
        return c.json(
          {
            started: false,
            status: 'rejected' as const,
            position: 0,
            jobId: null,
            runId: null,
            reason: '尚未配置或启用对话模型',
          },
          200,
        )
      }
      if (!deps.jobs) {
        return c.json(
          {
            started: false,
            status: 'rejected' as const,
            position: 0,
            jobId: null,
            runId: null,
            reason: '后台任务队列未启用',
          },
          200,
        )
      }
      const result = await deps.jobs.enqueueDream(options)
      return c.json(result, 200)
    })
    .openapi(retryRunRoute, async (c) => {
      const { runId } = c.req.valid('param')
      let body: RetryDreamRunRequest = {}
      const rawText = await c.req.text()
      if (rawText.trim()) {
        let json: unknown
        try {
          json = JSON.parse(rawText)
        } catch {
          throw new MemoryError(400, '请求体不是合法的 JSON')
        }
        const parsed = RetryDreamRunRequest.safeParse(json)
        if (!parsed.success) {
          throw new MemoryError(400, parsed.error.issues[0]?.message ?? '请求参数不合法')
        }
        body = parsed.data
      }

      const chat = await loadStoredModel(deps.db, CHAT_LLM_SETTING_KEY)
      if (!chat?.enabled) {
        return c.json(
          {
            started: false,
            status: 'rejected' as const,
            position: 0,
            jobId: null,
            runId: null,
            reason: '尚未配置或启用对话模型',
          },
          200,
        )
      }
      if (!deps.jobs) {
        return c.json(
          {
            started: false,
            status: 'rejected' as const,
            position: 0,
            jobId: null,
            runId: null,
            reason: '后台任务队列未启用',
          },
          200,
        )
      }

      const state = await loadDreamState(deps.db)
      const targetRun = state.recentRuns.find((item) => item.id === runId)
      if (!targetRun) {
        throw new MemoryError(404, '整理记录不存在')
      }
      if (
        targetRun.outcome !== 'failed' &&
        targetRun.outcome !== 'partial' &&
        targetRun.outcome !== 'cancelled'
      ) {
        throw new MemoryError(400, '仅失败、部分完成或已取消的整理记录支持重试')
      }

      const retrySpec = buildRetryOptions(targetRun, body.scope)
      if (!retrySpec.ok) {
        return c.json(
          {
            started: false,
            status: 'rejected' as const,
            position: 0,
            jobId: null,
            runId: null,
            reason: retrySpec.reason,
          },
          200,
        )
      }

      const result = await deps.jobs.enqueueDream(retrySpec.options)
      if (result.started && result.jobId) {
        await markDreamRunRetried(deps.db, targetRun.id, result.jobId)
      }
      return c.json(result, 200)
    })
}
