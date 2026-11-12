import { createRoute } from '@hono/zod-openapi'
import { ErrorResponse, SystemInfo, UpdateCheckSettings } from '@kioku/contracts'

import { lockAsAdmin, requireConsole, requireInstanceAdmin } from '../auth/middleware'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { systemInfo } from '../settings/systemInfo'
import { saveUpdateCheck, startUpdateCheck } from '../settings/updateCheck'

const forbidden = jsonResponse('需要实例管理员', ErrorResponse)

// 实例级的接口不在 /spaces/* 下，会话鉴权挂在每个路由上
function infoRoute(deps: Deps) {
  return createRoute({
    method: 'get',
    path: '/instance/system',
    tags: ['settings'],
    summary:
      '系统信息（只有实例管理员）：构建、运行环境、数据库、配置与后台任务，检查新版本的结果，以及可以贴进 issue 的诊断信息',
    middleware: [requireConsole(deps), requireInstanceAdmin(deps)],
    responses: { 200: jsonResponse('系统信息', SystemInfo), 403: forbidden },
  })
}

function updateCheckRoute(deps: Deps) {
  return createRoute({
    method: 'put',
    path: '/instance/update-check',
    tags: ['settings'],
    summary:
      '打开或关闭检查新版本（只有实例管理员）：打开后向 GitHub 请求最新的正式版，成功之后隔一天、失败之后隔一小时再查。返回整份系统信息',
    middleware: [requireConsole(deps), requireInstanceAdmin(deps)],
    request: { body: jsonBody(UpdateCheckSettings) },
    responses: { 200: jsonResponse('系统信息', SystemInfo), 403: forbidden },
  })
}

export function systemRoutes(deps: Deps) {
  return router()
    .openapi(infoRoute(deps), async (c) => {
      // 到了间隔时在后台查一次，不等 GitHub：这次给出已知的结果，checking 为真时界面过一会儿再取
      await startUpdateCheck(deps.db, deps.updateCheck)
      return c.json(await systemInfo(deps), 200)
    })
    .openapi(updateCheckRoute(deps), async (c) => {
      const actor = c.get('console').accountId
      // 和别的管理员写操作一样先过 lockAsAdmin：中间件查过之后才被停用、降级的管理员改不了
      const saved = await deps.db.transaction(async (tx) => {
        if (!(await lockAsAdmin(tx, actor))) return false
        await saveUpdateCheck(tx, c.req.valid('json').enabled)
        return true
      })
      if (!saved) return c.json({ error: '需要实例管理员' }, 403)
      await startUpdateCheck(deps.db, deps.updateCheck)
      // 返回整份系统信息：诊断信息里也有这个开关
      return c.json(await systemInfo(deps), 200)
    })
}
