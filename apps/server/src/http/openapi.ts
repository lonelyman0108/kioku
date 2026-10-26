import { OpenAPIHono } from '@hono/zod-openapi'

import type { AppEnv } from './env'

// 所有路由共用：请求校验失败时统一返回 { error }，第一条问题作为提示
export function router() {
  return new OpenAPIHono<AppEnv>({
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
