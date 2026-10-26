import { OpenAPIHono } from '@hono/zod-openapi'
import { getPath } from 'hono/utils/url'

import type { AppEnv } from './env'

// 所有路由共用：请求校验失败时统一返回 { error }，第一条问题作为提示。
// collapseSlashes 只给顶层应用用：匹配路由前把连续的斜杠合并成一个，
// 例如服务地址末尾多写了斜杠，客户端拼出的 //v1/mcp 也能找到路由
export function router(options: { collapseSlashes?: boolean } = {}) {
  return new OpenAPIHono<AppEnv>({
    ...(options.collapseSlashes
      ? { getPath: (request: Request) => getPath(request).replace(/\/{2,}/g, '/') }
      : {}),
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues[0]
        const where = issue?.path.length ? `${issue.path.join('.')}：` : ''
        return c.json({ error: `${where}${issue?.message ?? '请求格式错误'}` }, 400)
      }
    },
  })
}

export const jsonBody = <T>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
})

export const jsonResponse = <T>(description: string, schema: T) => ({
  description,
  content: { 'application/json': { schema } },
})
