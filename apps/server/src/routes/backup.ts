import { createRoute, z } from '@hono/zod-openapi'
import {
  BackupObjectList,
  BackupSettingsView,
  BackupTestResult,
  ErrorResponse,
  UpdateBackupSettings,
} from '@kioku/contracts'

import { s3Client } from '../backup/s3'
import {
  backupSettingsView,
  clearBackupSettings,
  loadBackupConfig,
  saveBackupSettings,
} from '../backup/settings'
import { listBackups, testBackupStorage } from '../backup/storage'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { SettingsInputError } from '../settings/endpoint'

const NOT_CONFIGURED = '还没有保存备份存储的设置'
const forbidden = jsonResponse('需要实例管理员', ErrorResponse)
const notConfigured = jsonResponse(NOT_CONFIGURED, ErrorResponse)

const view = createRoute({
  method: 'get',
  path: '/settings/backup',
  tags: ['settings'],
  summary: '备份存储的设置与最近一次的结果（不返回 Secret）',
  responses: { 200: jsonResponse('设置', BackupSettingsView), 403: forbidden },
})

const update = createRoute({
  method: 'put',
  path: '/settings/backup',
  tags: ['settings'],
  summary: '修改备份存储：兼容S3的对象存储的接口、存储桶、访问密钥，每天几点（UTC）备份、留几份',
  request: { body: jsonBody(UpdateBackupSettings) },
  responses: {
    200: jsonResponse('已保存', BackupSettingsView),
    400: jsonResponse('无法保存', ErrorResponse),
    403: forbidden,
  },
})

const clear = createRoute({
  method: 'delete',
  path: '/settings/backup',
  tags: ['settings'],
  summary: '清掉备份存储的设置：定时备份随即停止，存储桶里已有的备份不动',
  responses: { 204: { description: '已清除' }, 403: forbidden },
})

const test = createRoute({
  method: 'post',
  path: '/settings/backup/test',
  tags: ['settings'],
  summary: '用已保存的设置往存储桶里放一个小文件、列一遍再删掉，检查连通与权限',
  responses: {
    200: jsonResponse('测试结果', BackupTestResult),
    400: notConfigured,
    403: forbidden,
  },
})

const run = createRoute({
  method: 'post',
  path: '/settings/backup/run',
  tags: ['settings'],
  summary: '立即做一份备份传上去（排进后台任务，结果看设置里的最近一次）',
  responses: {
    202: jsonResponse('已排队', z.object({})),
    400: notConfigured,
    403: forbidden,
    503: jsonResponse('没有排进队列（服务没有启动后台任务，或入队失败）', ErrorResponse),
  },
})

const objects = createRoute({
  method: 'get',
  path: '/settings/backup/objects',
  tags: ['settings'],
  summary: '列出存储桶里的备份，新的在前',
  responses: {
    200: jsonResponse('备份', BackupObjectList),
    400: notConfigured,
    403: forbidden,
    502: jsonResponse('存储出错', ErrorResponse),
  },
})

// 只给实例管理员：挂在实例设置的路由下面，沿用那里的登录与管理员检查。
// 存了 Secret 就一定配着主密钥（没配时启动检查拒绝启动），读设置不会因为解不开而失败
export function backupRoutes(deps: Deps) {
  const configured = () => loadBackupConfig(deps.db, deps.masterKey)
  return router()
    .openapi(view, async (c) => c.json(await backupSettingsView(deps.db), 200))
    .openapi(update, async (c) => {
      try {
        await saveBackupSettings(deps.db, deps.masterKey, c.req.valid('json'))
      } catch (err) {
        if (err instanceof SettingsInputError) return c.json({ error: err.message }, 400)
        throw err
      }
      return c.json(await backupSettingsView(deps.db), 200)
    })
    .openapi(clear, async (c) => {
      await clearBackupSettings(deps.db)
      return c.body(null, 204)
    })
    .openapi(test, async (c) => {
      const config = await configured()
      if (!config) return c.json({ error: NOT_CONFIGURED }, 400)
      const error = await testBackupStorage(config)
      return c.json({ ok: !error, error }, 200)
    })
    .openapi(run, async (c) => {
      const config = await configured()
      if (!config) return c.json({ error: NOT_CONFIGURED }, 400)
      if (!(await deps.jobs?.enqueueBackup())) {
        return c.json({ error: '没有排进后台任务，稍后再试' }, 503)
      }
      return c.json({}, 202)
    })
    .openapi(objects, async (c) => {
      const config = await configured()
      if (!config) return c.json({ error: NOT_CONFIGURED }, 400)
      try {
        const found = await listBackups(s3Client(config), config.prefix)
        return c.json(
          { objects: found.map((o) => ({ object: o.key, bytes: o.bytes, at: o.at })) },
          200,
        )
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502)
      }
    })
}
