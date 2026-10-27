import { createRoute, z } from '@hono/zod-openapi'
import {
  ConsoleCredential,
  ConsoleCredentialList,
  CreateCredentialProviderRequest,
  CreateCredentialRequest,
  CredentialAccess,
  CredentialEventList,
  CredentialIdentifierQuery,
  CredentialProvider,
  CredentialSummary,
  CredentialValues,
  ErrorResponse,
  KeyCreateCredentialRequest,
  KeyCredentialList,
  KeyDeleteCredentialQuery,
  KeyUpdateCredentialRequest,
  PageQuery,
  UpdateCredentialProviderRequest,
  UpdateCredentialRequest,
} from '@kioku/contracts'
import type { Context } from 'hono'

import { requireKey } from '../auth/middleware'
import { credentialServiceForConsole, credentialServiceForKey } from '../credential/context'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('未登录或凭据无效', ErrorResponse),
  403: jsonResponse('没有权限', ErrorResponse),
  404: jsonResponse('不存在或不可见', ErrorResponse),
  409: jsonResponse('冲突', ErrorResponse),
}

const SpaceParams = z.object({ spaceId: z.uuid() })
const CredentialParams = SpaceParams.extend({ credentialId: z.uuid() })
const ProviderParams = SpaceParams.extend({ providerId: z.uuid() })
const VersionQuery = z.object({ expectedVersion: z.coerce.number().int().optional() })

// 带着值的响应不让浏览器和代理缓存
const noStore = (c: Context<AppEnv>) => c.header('Cache-Control', 'no-store')

export function credentialRoutes(deps: Deps) {
  const app = router()
  app.route('/', consoleCredentialRoutes(deps))
  app.route('/', keyCredentialRoutes(deps))
  return app
}

// 管理界面：按 id 访问成员自己的凭据。会话鉴权已在 app.ts 对 /v1/spaces/* 统一注册
function consoleCredentialRoutes(deps: Deps) {
  const base = '/spaces/{spaceId}/credentials'
  const common = { tags: ['credentials'] }
  const list = createRoute({
    ...common,
    method: 'get',
    path: base,
    summary: '列出自己的凭据（不含值）',
    request: { params: SpaceParams },
    responses: { 200: jsonResponse('凭据', ConsoleCredentialList), ...errors },
  })
  const deleted = createRoute({
    ...common,
    method: 'get',
    path: `${base}/deleted`,
    summary: '列出自己已删除的凭据，最近删除的在前',
    request: { params: SpaceParams },
    responses: { 200: jsonResponse('已删除的凭据', ConsoleCredentialList), ...errors },
  })
  const create = createRoute({
    ...common,
    method: 'post',
    path: base,
    summary: '新建凭据：值由 Kioku 加密保存，或绑定到外部凭据源里的条目',
    request: { params: SpaceParams, body: jsonBody(CreateCredentialRequest) },
    responses: { 201: jsonResponse('已创建', ConsoleCredential), ...errors },
  })
  const get = createRoute({
    ...common,
    method: 'get',
    path: `${base}/{credentialId}`,
    summary: '读取一条凭据的说明与绑定（不含值）',
    request: { params: CredentialParams },
    responses: { 200: jsonResponse('凭据', ConsoleCredential), ...errors },
  })
  const update = createRoute({
    ...common,
    method: 'patch',
    path: `${base}/{credentialId}`,
    summary: '修改凭据的名称、说明、来源、托管的值或限定的应用',
    request: { params: CredentialParams, body: jsonBody(UpdateCredentialRequest) },
    responses: { 200: jsonResponse('已修改', ConsoleCredential), ...errors },
  })
  const remove = createRoute({
    ...common,
    method: 'delete',
    path: `${base}/{credentialId}`,
    summary: '删除凭据（软删除，可以恢复）',
    request: { params: CredentialParams, query: VersionQuery },
    responses: { 204: { description: '已删除' }, ...errors },
  })
  const undelete = createRoute({
    ...common,
    method: 'post',
    path: `${base}/{credentialId}/undelete`,
    summary: '撤销删除；同一个标识已经有有效的凭据时不能恢复',
    request: { params: CredentialParams },
    responses: { 200: jsonResponse('恢复后的凭据', ConsoleCredential), ...errors },
  })
  const reveal = createRoute({
    ...common,
    method: 'post',
    path: `${base}/{credentialId}/reveal`,
    summary: '查看托管的值，记一条访问事件',
    request: { params: CredentialParams },
    responses: { 200: jsonResponse('值', CredentialValues), ...errors },
  })
  const events = createRoute({
    ...common,
    method: 'get',
    path: `${base}/{credentialId}/events`,
    summary: '凭据的事件（新建、修改、删除与取用），最新的在前',
    request: { params: CredentialParams, query: PageQuery },
    responses: { 200: jsonResponse('事件', CredentialEventList), ...errors },
  })
  const providers = createRoute({
    ...common,
    method: 'get',
    path: '/spaces/{spaceId}/credential-providers',
    summary: '列出自己的凭据源',
    request: { params: SpaceParams },
    responses: { 200: jsonResponse('凭据源', z.array(CredentialProvider)), ...errors },
  })
  const createProvider = createRoute({
    ...common,
    method: 'post',
    path: '/spaces/{spaceId}/credential-providers',
    summary: '新建凭据源：类型与给 agent 看的使用说明',
    request: { params: SpaceParams, body: jsonBody(CreateCredentialProviderRequest) },
    responses: { 201: jsonResponse('已创建', CredentialProvider), ...errors },
  })
  const updateProvider = createRoute({
    ...common,
    method: 'patch',
    path: '/spaces/{spaceId}/credential-providers/{providerId}',
    summary: '修改凭据源',
    request: { params: ProviderParams, body: jsonBody(UpdateCredentialProviderRequest) },
    responses: { 200: jsonResponse('已修改', CredentialProvider), ...errors },
  })
  const removeProvider = createRoute({
    ...common,
    method: 'delete',
    path: '/spaces/{spaceId}/credential-providers/{providerId}',
    summary: '删除凭据源；还有有效的凭据绑定它时不能删',
    request: { params: ProviderParams },
    responses: { 204: { description: '已删除' }, ...errors },
  })

  const service = (c: Context<AppEnv>) =>
    credentialServiceForConsole(deps, c.req.param('spaceId')!, c.get('console').accountId)

  // 固定路径（deleted）先于带 id 的路径注册
  return router()
    .openapi(list, async (c) => c.json(await (await service(c)).list(), 200))
    .openapi(deleted, async (c) => c.json(await (await service(c)).listDeleted(), 200))
    .openapi(create, async (c) => c.json(await (await service(c)).create(c.req.valid('json')), 201))
    .openapi(get, async (c) =>
      c.json(await (await service(c)).get(c.req.valid('param').credentialId), 200),
    )
    .openapi(update, async (c) =>
      c.json(
        await (await service(c)).update(c.req.valid('param').credentialId, c.req.valid('json')),
        200,
      ),
    )
    .openapi(remove, async (c) => {
      const { expectedVersion } = c.req.valid('query')
      await (await service(c)).delete(c.req.valid('param').credentialId, expectedVersion)
      return c.body(null, 204)
    })
    .openapi(undelete, async (c) =>
      c.json(await (await service(c)).undelete(c.req.valid('param').credentialId), 200),
    )
    .openapi(reveal, async (c) => {
      const values = await (await service(c)).reveal(c.req.valid('param').credentialId)
      noStore(c)
      return c.json(values, 200)
    })
    .openapi(events, async (c) =>
      c.json(
        await (await service(c)).events(c.req.valid('param').credentialId, c.req.valid('query')),
        200,
      ),
    )
    .openapi(providers, async (c) => c.json(await (await service(c)).providers(), 200))
    .openapi(createProvider, async (c) =>
      c.json(await (await service(c)).createProvider(c.req.valid('json')), 201),
    )
    .openapi(updateProvider, async (c) =>
      c.json(
        await (
          await service(c)
        ).updateProvider(c.req.valid('param').providerId, c.req.valid('json')),
        200,
      ),
    )
    .openapi(removeProvider, async (c) => {
      await (await service(c)).deleteProvider(c.req.valid('param').providerId)
      return c.body(null, 204)
    })
}

// 接入方：按标识访问应用主人的凭据，权限按 Key 算：读说明同私人层，取托管的值与管理凭据要 secret 级
function keyCredentialRoutes(deps: Deps) {
  const common = { tags: ['credentials'], security: [{ bearer: [] }] }
  const use = createRoute({
    ...common,
    method: 'get',
    path: '/credentials',
    summary: '取用一条凭据：托管的给值，外部的给凭据源、条目位置与取法；记一条访问事件',
    request: { query: CredentialIdentifierQuery },
    responses: { 200: jsonResponse('凭据', CredentialAccess), ...errors },
  })
  const list = createRoute({
    ...common,
    method: 'get',
    path: '/credentials/list',
    summary: '列出这把 Key 看得到的凭据与凭据源（不含值与外部条目的位置）',
    responses: { 200: jsonResponse('凭据', KeyCredentialList), ...errors },
  })
  const create = createRoute({
    ...common,
    method: 'post',
    path: '/credentials',
    summary: '新建凭据，只给这个应用用；要能读写私人层的 secret 级 Key',
    request: { body: jsonBody(KeyCreateCredentialRequest) },
    responses: { 201: jsonResponse('已创建', CredentialSummary), ...errors },
  })
  const update = createRoute({
    ...common,
    method: 'patch',
    path: '/credentials',
    summary: '按标识修改凭据；不能改限定的应用',
    request: { body: jsonBody(KeyUpdateCredentialRequest) },
    responses: { 200: jsonResponse('已修改', CredentialSummary), ...errors },
  })
  const remove = createRoute({
    ...common,
    method: 'delete',
    path: '/credentials',
    summary: '按标识删除凭据（软删除，可以在管理界面恢复）',
    request: { query: KeyDeleteCredentialQuery },
    responses: { 204: { description: '已删除' }, ...errors },
  })

  const app = router()
  // '/credentials/*' 同时匹配 /credentials 本身；再单独注册 '/credentials' 会让鉴权执行两次
  app.use('/credentials/*', requireKey(deps))
  const service = (c: Context<AppEnv>) => credentialServiceForKey(deps, c.get('key'))
  return app
    .openapi(list, async (c) => c.json(await service(c).keyList(), 200))
    .openapi(use, async (c) => {
      const { identifier, field } = c.req.valid('query')
      const result = await service(c).use(identifier, field, 'rest')
      noStore(c)
      return c.json(result, 200)
    })
    .openapi(create, async (c) => c.json(await service(c).keyCreate(c.req.valid('json')), 201))
    .openapi(update, async (c) => {
      const { identifier, ...input } = c.req.valid('json')
      return c.json(await service(c).keyUpdate(identifier, input), 200)
    })
    .openapi(remove, async (c) => {
      const { identifier, expectedVersion } = c.req.valid('query')
      await service(c).keyDelete(identifier, expectedVersion)
      return c.body(null, 204)
    })
}
