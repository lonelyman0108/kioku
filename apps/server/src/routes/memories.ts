import { createRoute, z } from '@hono/zod-openapi'
import {
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
  UpdateEntryRequest,
} from '@kioku/contracts'

import type { EntryService } from '../memory/service'
import { jsonBody, jsonResponse, router } from '../http/openapi'

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
}
