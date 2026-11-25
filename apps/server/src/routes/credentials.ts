import { createRoute, z } from '@hono/zod-openapi'
import {
  CreateCredentialRequest,
  CredentialListResponse,
  CredentialMeta,
  ErrorResponse,
  ResolveCredentialsRequest,
  ResolveCredentialsResponse,
  RevealCredentialResponse,
  UpdateCredentialRequest,
} from '@kioku/contracts'

import { requireKey } from '../auth/middleware'
import type { CredentialService } from '../credential/service'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('未登录或密钥无效', ErrorResponse),
  403: jsonResponse('没有权限', ErrorResponse),
  404: jsonResponse('凭据不存在或无权访问', ErrorResponse),
  409: jsonResponse('标识已存在', ErrorResponse),
  503: jsonResponse('未配置主密钥', ErrorResponse),
}

const IdParams = z.object({ id: z.uuid() })

const listRoute = createRoute({
  method: 'get',
  path: '/console/credentials',
  tags: ['credentials'],
  summary: '列出全部凭据元数据（不含明文值）',
  responses: { 200: jsonResponse('凭据列表', CredentialListResponse), ...errors },
})

const createRouteDef = createRoute({
  method: 'post',
  path: '/console/credentials',
  tags: ['credentials'],
  summary: '新建加密托管凭据',
  request: { body: jsonBody(CreateCredentialRequest) },
  responses: { 201: jsonResponse('已创建', CredentialMeta), ...errors },
})

const updateRoute = createRoute({
  method: 'patch',
  path: '/console/credentials/{id}',
  tags: ['credentials'],
  summary: '更新凭据说明、允许场域或轮换凭据值',
  request: { params: IdParams, body: jsonBody(UpdateCredentialRequest) },
  responses: { 200: jsonResponse('已更新', CredentialMeta), ...errors },
})

const revealRoute = createRoute({
  method: 'post',
  path: '/console/credentials/{id}/reveal',
  tags: ['credentials'],
  summary: '临时解密查看凭据原值（禁止缓存）',
  request: { params: IdParams },
  responses: { 200: jsonResponse('凭据值', RevealCredentialResponse), ...errors },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/console/credentials/{id}',
  tags: ['credentials'],
  summary: '删除凭据',
  request: { params: IdParams },
  responses: { 204: { description: '已删除' }, ...errors },
})

const resolveRoute = createRoute({
  method: 'post',
  path: '/credentials/resolve',
  tags: ['credentials'],
  security: [{ bearer: [] }],
  summary: '供 kioku run 一次性原子取值注入子进程环境变量',
  request: { body: jsonBody(ResolveCredentialsRequest) },
  responses: { 200: jsonResponse('解析结果', ResolveCredentialsResponse), ...errors },
})

export function credentialRoutes(deps: Deps, credentials: CredentialService) {
  const app = router()
    .openapi(listRoute, async (c) => c.json({ items: await credentials.list() }, 200))
    .openapi(createRouteDef, async (c) =>
      c.json(await credentials.create(c.req.valid('json')), 201),
    )
    .openapi(updateRoute, async (c) =>
      c.json(await credentials.update(c.req.valid('param').id, c.req.valid('json')), 200),
    )
    .openapi(revealRoute, async (c) => {
      const revealed = await credentials.reveal(c.req.valid('param').id)
      c.header('Cache-Control', 'no-store')
      return c.json(revealed, 200)
    })
    .openapi(deleteRoute, async (c) => {
      await credentials.remove(c.req.valid('param').id)
      return c.body(null, 204)
    })

  const keyApp = router()
  keyApp.use('/credentials/*', requireKey(deps))
  keyApp.openapi(resolveRoute, async (c) => {
    const resolved = await credentials.resolveForKey(c.get('key'), c.req.valid('json'))
    c.header('Cache-Control', 'no-store')
    return c.json(resolved, 200)
  })

  app.route('/', keyApp)
  return app
}
