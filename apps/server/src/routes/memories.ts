import { createRoute, z } from '@hono/zod-openapi'
import {
  BootPreviewRequest,
  BootPreviewResponse,
  CapturePlanRequest,
  CapturePlanResponse,
  CreateEntryRequest,
  EntryDetailResponse,
  EntryHistoryQuery,
  EntryHistoryResponse,
  EntryListQuery,
  EntryListResponse,
  ErrorResponse,
  HygieneSweepApplyRequest,
  HygieneSweepApplyResponse,
  HygieneSweepPreviewResponse,
  RestoreEntryRequest,
  ShortId,
  SingleCrossCheckResponse,
  SingleTidyApplyRequest,
  SingleTidyApplyResponse,
  SingleTidyPreviewResponse,
  UpdateEntryRequest,
} from '@kioku/contracts'
import { streamSSE } from 'hono/streaming'

import { logInternalError } from '../db/client'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { MemoryError } from '../memory/errors'
import type { EntryService } from '../memory/service'

const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('未登录', ErrorResponse),
  404: jsonResponse('词条不存在', ErrorResponse),
  409: jsonResponse('版本冲突', ErrorResponse),
}

const ShortIdParams = z.object({ shortId: ShortId })
const DeleteQuery = z.object({
  permanent: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  expectedVersion: z.coerce.number().int().min(1).optional(),
})

const listRoute = createRoute({
  method: 'get',
  path: '/console/entries',
  tags: ['console'],
  summary: '列出、搜索或按标签筛选记忆，返回分页列表、动态筛选维度与各标签页计数',
  request: { query: EntryListQuery },
  responses: { 200: jsonResponse('词条列表', EntryListResponse), ...errors },
})

const createRouteDef = createRoute({
  method: 'post',
  path: '/console/entries',
  tags: ['console'],
  summary: '新建记忆词条',
  request: { body: jsonBody(CreateEntryRequest) },
  responses: { 201: jsonResponse('已创建', EntryDetailResponse), ...errors },
})

const captureRoute = createRoute({
  method: 'post',
  path: '/console/entries/capture',
  tags: ['console'],
  summary: '为随手记规划局部补丁归并或新建草案',
  request: { body: jsonBody(CapturePlanRequest) },
  responses: { 200: jsonResponse('归并方案', CapturePlanResponse), ...errors },
})

const hygienePreviewRoute = createRoute({
  method: 'post',
  path: '/console/entries/hygiene/preview',
  tags: ['console'],
  summary: '扫描全库记忆结构与旧路径断链，返回确定性预清洗预览与异常标注清单',
  responses: { 200: jsonResponse('体检预览', HygieneSweepPreviewResponse), ...errors },
})

const hygieneApplyRoute = createRoute({
  method: 'post',
  path: '/console/entries/hygiene/apply',
  tags: ['console'],
  summary: '应用选中的确定性结构预清洗项（保留完整版本历史快照）',
  request: { body: jsonBody(HygieneSweepApplyRequest) },
  responses: { 200: jsonResponse('预清洗结果', HygieneSweepApplyResponse), ...errors },
})

const bootPreviewRoute = createRoute({
  method: 'post',
  path: '/console/boot/preview',
  tags: ['console'],
  summary: '只读预览指定访问密钥与场景下会话启动实际加载的常驻记忆、目录项与排除项',
  request: { body: jsonBody(BootPreviewRequest) },
  responses: { 200: jsonResponse('终端启动加载预览', BootPreviewResponse), ...errors },
})

const detailRoute = createRoute({
  method: 'get',
  path: '/console/entries/{shortId}',
  tags: ['console'],
  summary: '读取单条记忆正文、双链与凭据占位符状态',
  request: { params: ShortIdParams },
  responses: { 200: jsonResponse('词条详情', EntryDetailResponse), ...errors },
})

const updateRoute = createRoute({
  method: 'patch',
  path: '/console/entries/{shortId}',
  tags: ['console'],
  summary: '修改记忆内容、标签、常驻状态，或将会话摘要提炼为正式记忆',
  request: { params: ShortIdParams, body: jsonBody(UpdateEntryRequest) },
  responses: { 200: jsonResponse('已更新', EntryDetailResponse), ...errors },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/console/entries/{shortId}',
  tags: ['console'],
  summary: '移入回收站，或传入 permanent=true 永久删除',
  request: { params: ShortIdParams, query: DeleteQuery },
  responses: { 204: { description: '已删除' }, ...errors },
})

const restoreRoute = createRoute({
  method: 'post',
  path: '/console/entries/{shortId}/restore',
  tags: ['console'],
  summary: '从回收站恢复词条，或按 version 回滚至指定历史版本',
  request: { params: ShortIdParams, body: jsonBody(RestoreEntryRequest) },
  responses: { 200: jsonResponse('已恢复', EntryDetailResponse), ...errors },
})

const historyRoute = createRoute({
  method: 'get',
  path: '/console/entries/{shortId}/history',
  tags: ['console'],
  summary: '读取单条记忆的语义化变更历史与版本快照',
  request: { params: ShortIdParams, query: EntryHistoryQuery },
  responses: { 200: jsonResponse('历史记录', EntryHistoryResponse), ...errors },
})

const singleTidyPreviewRoute = createRoute({
  method: 'post',
  path: '/console/entries/{shortId}/tidy/preview',
  tags: ['console'],
  summary:
    '主动预览单条记忆的规范整理结果（Accept: text/event-stream 时以 SSE 推送阶段进度与心跳）',
  request: { params: ShortIdParams },
  responses: {
    200: { description: '规范整理预览（JSON 或 SSE 流）' },
    ...errors,
  },
})

const singleTidyApplyRoute = createRoute({
  method: 'post',
  path: '/console/entries/{shortId}/tidy/apply',
  tags: ['console'],
  summary: '按乐观锁直接应用单条规范整理结果，或暂存至待处理收件箱',
  request: { params: ShortIdParams, body: jsonBody(SingleTidyApplyRequest) },
  responses: { 200: jsonResponse('已应用或暂存', SingleTidyApplyResponse), ...errors },
})

const singleCrossCheckRoute = createRoute({
  method: 'post',
  path: '/console/entries/{shortId}/cross-check',
  tags: ['console'],
  summary: '以单条记忆为锚点查找重复、冲突与缺失双链，写入收件箱并返回关联建议列表',
  request: { params: ShortIdParams },
  responses: { 200: jsonResponse('查重与关联结果', SingleCrossCheckResponse), ...errors },
})

export function memoryRoutes(entries: EntryService) {
  return router()
    .openapi(listRoute, async (c) =>
      c.json(await entries.listConsole(c.get('console'), c.req.valid('query')), 200),
    )
    .openapi(createRouteDef, async (c) =>
      c.json(await entries.create(c.get('console'), c.req.valid('json')), 201),
    )
    .openapi(captureRoute, async (c) =>
      c.json(
        await entries.planCapture(c.get('console'), c.req.valid('json'), {
          signal: c.req.raw.signal,
        }),
        200,
      ),
    )
    .openapi(hygienePreviewRoute, async (c) => c.json(await entries.previewHygieneSweep(), 200))
    .openapi(hygieneApplyRoute, async (c) =>
      c.json(await entries.applyHygieneSweep(c.req.valid('json')), 200),
    )
    .openapi(bootPreviewRoute, async (c) =>
      c.json(await entries.previewBoot(c.req.valid('json')), 200),
    )
    .openapi(detailRoute, async (c) =>
      c.json(
        await entries.get(c.get('console'), c.req.valid('param').shortId, { includeDeleted: true }),
        200,
      ),
    )
    .openapi(updateRoute, async (c) =>
      c.json(
        await entries.update(c.get('console'), c.req.valid('param').shortId, c.req.valid('json')),
        200,
      ),
    )
    .openapi(deleteRoute, async (c) => {
      const { permanent, expectedVersion } = c.req.valid('query')
      await entries.remove(c.get('console'), c.req.valid('param').shortId, {
        ...(permanent !== undefined ? { permanent } : {}),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      })
      return c.body(null, 204)
    })
    .openapi(restoreRoute, async (c) =>
      c.json(
        await entries.restore(c.get('console'), c.req.valid('param').shortId, c.req.valid('json')),
        200,
      ),
    )
    .openapi(historyRoute, async (c) =>
      c.json(
        await entries.history(c.get('console'), c.req.valid('param').shortId, c.req.valid('query')),
        200,
      ),
    )
    .openapi(singleTidyPreviewRoute, async (c) => {
      const { shortId } = c.req.valid('param')
      const accept = c.req.header('accept') ?? ''
      if (accept.includes('text/event-stream')) {
        c.header('Cache-Control', 'no-cache')
        c.header('X-Accel-Buffering', 'no')
        return streamSSE(c, async (stream) => {
          const controller = new AbortController()
          const onAbort = () => controller.abort()
          if (c.req.raw.signal.aborted) controller.abort()
          else c.req.raw.signal.addEventListener('abort', onAbort, { once: true })
          stream.onAbort(onAbort)
          const heartbeat = setInterval(() => {
            void stream.writeSSE({ event: 'heartbeat', data: '' }).catch(() => {})
          }, 5_000)
          try {
            const result = await entries.previewSingleTidy(shortId, {
              signal: controller.signal,
              onStage: (stage, message) => {
                void stream
                  .writeSSE({ event: 'stage', data: JSON.stringify({ stage, message }) })
                  .catch(() => {})
              },
            })
            if (!controller.signal.aborted) {
              await stream.writeSSE({ event: 'result', data: JSON.stringify(result) })
            }
          } catch (err) {
            if (!controller.signal.aborted) {
              if (!(err instanceof MemoryError)) {
                logInternalError('单条规范整理 SSE 失败', err)
              }
              const message = err instanceof MemoryError ? err.message : '单条规范整理失败'
              const status = err instanceof MemoryError ? err.status : 500
              await stream
                .writeSSE({
                  event: 'error',
                  data: JSON.stringify({ error: message, status }),
                })
                .catch(() => {})
            }
          } finally {
            clearInterval(heartbeat)
            c.req.raw.signal.removeEventListener('abort', onAbort)
          }
        })
      }
      const preview = await entries.previewSingleTidy(shortId, {
        signal: c.req.raw.signal,
      })
      return c.json(SingleTidyPreviewResponse.parse(preview), 200)
    })
    .openapi(singleTidyApplyRoute, async (c) =>
      c.json(
        await entries.applySingleTidy(
          c.get('console'),
          c.req.valid('param').shortId,
          c.req.valid('json'),
        ),
        200,
      ),
    )
    .openapi(singleCrossCheckRoute, async (c) =>
      c.json(
        await entries.crossCheckEntry(c.req.valid('param').shortId, {
          signal: c.req.raw.signal,
        }),
        200,
      ),
    )
}
