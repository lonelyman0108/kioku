import { createRoute, z } from '@hono/zod-openapi'
import {
  ErrorResponse,
  LORE_UPLOAD_MAX_BYTES,
  LoreImportApplyRequest,
  LoreImportPlan,
  LoreImportPlanRequest,
  LoreImportResult,
} from '@kioku/contracts'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { memberRole } from '../auth/middleware'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { MemoryError } from '../memory/errors'

const params = z.object({ circleId: z.uuid() })
const errors = {
  400: jsonResponse('读不了来源（文件不对、Lore 连不上等）或计划有错误', ErrorResponse),
  403: jsonResponse('没有权限', ErrorResponse),
  413: jsonResponse('文件太大', ErrorResponse),
  501: jsonResponse('迁移工具正在适配记忆圈架构', ErrorResponse),
}

function uploadLimit(): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: LORE_UPLOAD_MAX_BYTES + 64 * 1024,
    onError: (c) =>
      c.json(
        {
          error: `请求超过 ${LORE_UPLOAD_MAX_BYTES / 1024 / 1024} MB 上限。上传的导出文件只需保留要用的五张表，并确认文件是 Lore 的导出。`,
        },
        413,
      ),
  })
}

const planRoute = createRoute({
  method: 'post',
  path: '/circles/{circleId}/lore-import/plan',
  tags: ['console'],
  summary: '查看从 Lore 导入的迁移计划',
  middleware: uploadLimit(),
  request: { params, body: jsonBody(LoreImportPlanRequest) },
  responses: { 200: jsonResponse('导入计划', LoreImportPlan), ...errors },
})

const applyRoute = createRoute({
  method: 'post',
  path: '/circles/{circleId}/lore-import/apply',
  tags: ['console'],
  summary: '按计划执行从 Lore 的导入与同步',
  middleware: uploadLimit(),
  request: { params, body: jsonBody(LoreImportApplyRequest) },
  responses: {
    200: jsonResponse('导入与同步的结果', LoreImportResult),
    ...errors,
    409: jsonResponse('计划变了要重看，或者文件比已写入的数据旧而没有确认', ErrorResponse),
    429: jsonResponse('导出导入正忙，稍后再试', ErrorResponse),
    500: jsonResponse('写到一半出错，可能已写入一部分', ErrorResponse),
  },
})

async function assertOwner(deps: Deps, circleId: string, accountId: string): Promise<void> {
  const role = await memberRole(deps, circleId, accountId)
  if (!role) throw new MemoryError(403, '无权访问此记忆圈')
  if (role !== 'owner') throw new MemoryError(403, '仅记忆圈所有者可从 Lore 导入')
}

export function loreImportRoutes(deps: Deps) {
  return router()
    .openapi(planRoute, async (c) => {
      const { circleId } = c.req.valid('param')
      await assertOwner(deps, circleId, c.get('console').accountId)
      return c.json({ error: 'Lore 迁入工具正在适配记忆圈架构' }, 501)
    })
    .openapi(applyRoute, async (c) => {
      const { circleId } = c.req.valid('param')
      await assertOwner(deps, circleId, c.get('console').accountId)
      return c.json({ error: 'Lore 迁入工具正在适配记忆圈架构' }, 501)
    })
}
