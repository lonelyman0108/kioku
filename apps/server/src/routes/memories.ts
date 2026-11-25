import { createRoute, z } from '@hono/zod-openapi'
import {
  CreateEntryRequest,
  EntryDetailResponse,
  EntryHistoryResponse,
  EntryListQuery,
  EntryListResponse,
  ErrorResponse,
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
  summary: '读取单条记忆的历史版本快照列表',
  request: { params: ShortIdParams },
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
      c.json(await entries.history(c.req.valid('param').shortId), 200),
    )
}
