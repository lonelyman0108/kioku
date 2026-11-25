import { createRoute } from '@hono/zod-openapi'
import {
  ErrorResponse,
  ExportDataRequest,
  ImportApplyRequest,
  ImportApplyResponse,
  ImportPreviewRequest,
  ImportPreviewResponse,
  TRANSFER_UPLOAD_MAX_BYTES,
} from '@kioku/contracts'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import {
  applyTransferImport,
  exportTransferBundle,
  previewTransferImport,
} from '../transfer/service'

const errors = {
  400: jsonResponse('请求或导入文件内容不合法', ErrorResponse),
  401: jsonResponse('未登录', ErrorResponse),
  413: jsonResponse('上传文件超过大小上限', ErrorResponse),
}

function uploadLimit(): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: TRANSFER_UPLOAD_MAX_BYTES + 64 * 1024,
    onError: (c) =>
      c.json(
        {
          error: `请求体超过 ${TRANSFER_UPLOAD_MAX_BYTES / 1024 / 1024} MB 上限，请确认已裁剪无关表或分批导入`,
        },
        413,
      ),
  })
}

const exportPostRoute = createRoute({
  method: 'post',
  path: '/console/export',
  tags: ['transfer'],
  summary: '导出记忆为 JSON 或 Markdown；选择同时导出托管凭据时使用口令进行 AES-256-GCM 加密',
  request: { body: jsonBody(ExportDataRequest) },
  responses: {
    200: { description: '导出的备份文件' },
    400: errors[400],
    401: errors[401],
  },
})

const previewRoute = createRoute({
  method: 'post',
  path: '/console/import/preview',
  tags: ['transfer'],
  summary: '预览 Kioku 备份或 Lore 导出（文件 / 在线地址），不写入数据库且不回显凭据明文',
  middleware: uploadLimit(),
  request: { body: jsonBody(ImportPreviewRequest) },
  responses: { 200: jsonResponse('导入预览结果', ImportPreviewResponse), ...errors },
})

const applyRoute = createRoute({
  method: 'post',
  path: '/console/import/apply',
  tags: ['transfer'],
  summary: '按预览选择执行导入（仅跳过或重分配短 ID，不覆盖已有记录）',
  middleware: uploadLimit(),
  request: { body: jsonBody(ImportApplyRequest) },
  responses: { 200: jsonResponse('导入完成统计', ImportApplyResponse), ...errors },
})

export function transferRoutes(deps: Deps) {
  return router()
    .openapi(exportPostRoute, async (c) => {
      const body = c.req.valid('json')
      const exported = await exportTransferBundle(deps.db, deps.masterKey, body)
      c.header('Content-Type', exported.contentType)
      c.header('Content-Disposition', `attachment; filename="${exported.filename}"`)
      c.header('Cache-Control', 'no-store')
      return c.body(exported.body, 200)
    })
    .openapi(previewRoute, async (c) => {
      const body = c.req.valid('json')
      const preview = await previewTransferImport(
        deps.db,
        deps.masterKey,
        body.source,
        c.req.raw.signal,
      )
      c.header('Cache-Control', 'no-store')
      return c.json(preview, 200)
    })
    .openapi(applyRoute, async (c) => {
      const body = c.req.valid('json')
      const result = await applyTransferImport(
        deps.db,
        deps.masterKey,
        deps.jobs,
        body,
        c.req.raw.signal,
      )
      c.header('Cache-Control', 'no-store')
      return c.json(result, 200)
    })
}
