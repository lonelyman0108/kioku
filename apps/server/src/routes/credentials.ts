import { createRoute, z } from '@hono/zod-openapi'
import {
  ConsoleCredential,
  ConsoleCredentialList,
  ConnectVaultRequest,
  CreateCredentialRequest,
  CredentialAccess,
  CredentialEventList,
  CredentialIdentifierQuery,
  CredentialReferenceList,
  CredentialSummary,
  CredentialValues,
  DeletedCredentialList,
  ErrorResponse,
  KeyCreateCredentialRequest,
  KeyCredentialList,
  KeyDeleteCredentialQuery,
  KeyUpdateCredentialRequest,
  PageQuery,
  ReconnectVaultRequest,
  UpdateCredentialRequest,
  VaultConnection,
  VaultConnectionList,
  VaultConnectResult,
  VaultItemList,
} from '@kioku/contracts'
import type { Context } from 'hono'

import { isInstanceAdmin, requireKey } from '../auth/middleware'
import { credentialServiceForConsole, credentialServiceForKey } from '../credential/context'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { withDeletionRetention } from '../jobs/retention'

const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('未登录或凭据无效', ErrorResponse),
  403: jsonResponse('没有权限', ErrorResponse),
  404: jsonResponse('不存在或不可见', ErrorResponse),
  409: jsonResponse('冲突', ErrorResponse),
  502: jsonResponse('密码库无法连接或返回的内容无法识别', ErrorResponse),
}

const SpaceParams = z.object({ spaceId: z.uuid() })
const CredentialParams = SpaceParams.extend({ credentialId: z.uuid() })
const ConnectionParams = SpaceParams.extend({ connectionId: z.uuid() })
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
    summary: '列出自己已删除的凭据，最近删除的在前，带上保留期（多久之后永久清除）',
    request: { params: SpaceParams },
    responses: { 200: jsonResponse('已删除的凭据', DeletedCredentialList), ...errors },
  })
  const create = createRoute({
    ...common,
    method: 'post',
    path: base,
    summary: '新建凭据：值由 Kioku 加密保存，或给连接的密码库里的条目起标识',
    request: { params: SpaceParams, body: jsonBody(CreateCredentialRequest) },
    responses: { 201: jsonResponse('已创建', ConsoleCredential), ...errors },
  })
  const get = createRoute({
    ...common,
    method: 'get',
    path: `${base}/{credentialId}`,
    summary: '读取一条凭据的说明、字段与来源（不含值）',
    request: { params: CredentialParams },
    responses: { 200: jsonResponse('凭据', ConsoleCredential), ...errors },
  })
  const update = createRoute({
    ...common,
    method: 'patch',
    path: `${base}/{credentialId}`,
    summary: '修改凭据的名称、说明、限定的应用，托管的值或密码库的字段对应；来源不能改',
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
    summary: '撤销删除；同一个标识或同一个条目已经有有效的凭据时不能恢复',
    request: { params: CredentialParams },
    responses: { 200: jsonResponse('恢复后的凭据', ConsoleCredential), ...errors },
  })
  const reveal = createRoute({
    ...common,
    method: 'post',
    path: `${base}/{credentialId}/reveal`,
    summary: '查看值（托管的与密码库的，totp 给验证码），记一条访问事件',
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
  const references = createRoute({
    ...common,
    method: 'get',
    path: `${base}/{credentialId}/references`,
    summary: '引用这条凭据的记忆（不含已删除、secret 与已失效的）',
    request: { params: CredentialParams },
    responses: { 200: jsonResponse('引用它的记忆', CredentialReferenceList), ...errors },
  })
  const connBase = '/spaces/{spaceId}/vault-connections'
  const connCommon = { tags: ['vault-connections'] }
  const connections = createRoute({
    ...connCommon,
    method: 'get',
    path: connBase,
    summary: '列出自己的密码库连接',
    request: { params: SpaceParams },
    responses: { 200: jsonResponse('连接', VaultConnectionList), ...errors },
  })
  const connect = createRoute({
    ...connCommon,
    method: 'post',
    path: connBase,
    summary: '连接密码库：用主密码登录，保存刷新令牌与账户密钥（不保存主密码）；只接专用账号',
    request: { params: SpaceParams, body: jsonBody(ConnectVaultRequest) },
    responses: { 200: jsonResponse('连接的结果', VaultConnectResult), ...errors },
  })
  const reconnect = createRoute({
    ...connCommon,
    method: 'post',
    path: `${connBase}/{connectionId}/reconnect`,
    summary: '重新登录同一个账号',
    request: { params: ConnectionParams, body: jsonBody(ReconnectVaultRequest) },
    responses: { 200: jsonResponse('连接的结果', VaultConnectResult), ...errors },
  })
  const check = createRoute({
    ...connCommon,
    method: 'post',
    path: `${connBase}/{connectionId}/check`,
    summary: '重新同步一次：停用的原因已经消失就恢复成可用',
    request: { params: ConnectionParams },
    responses: { 200: jsonResponse('连接', VaultConnection), ...errors },
  })
  const disconnect = createRoute({
    ...connCommon,
    method: 'post',
    path: `${connBase}/{connectionId}/disconnect`,
    summary: '断开：立即清掉保存的令牌与密钥，连接与凭据留着',
    request: { params: ConnectionParams },
    responses: { 200: jsonResponse('连接', VaultConnection), ...errors },
  })
  const items = createRoute({
    ...connCommon,
    method: 'get',
    path: `${connBase}/{connectionId}/items`,
    summary: '列出连接读得到的条目（不含值），顺带同步一次',
    request: { params: ConnectionParams },
    responses: { 200: jsonResponse('条目', VaultItemList), ...errors },
  })

  const service = (c: Context<AppEnv>) =>
    credentialServiceForConsole(deps, c.req.param('spaceId')!, c.get('console').accountId)
  // 密码库连接：列出要凭据能力「取用」，其余要「管理」（目前只有空间 owner）
  const vault = async (c: Context<AppEnv>, manage = true) => {
    const s = await service(c)
    if (manage) s.requireManage()
    else s.requireUse()
    return s.vault
  }
  const connectionId = (c: Context<AppEnv>) => c.req.param('connectionId')!
  // 已删除的列表带上保留期：保留天数与是否暂停对谁都一样，暂停到什么时候只给实例管理员
  const withRetention = <T extends object>(c: Context<AppEnv>, list: Promise<T>) =>
    withDeletionRetention(deps.db, list, isInstanceAdmin(deps.db, c.get('console').accountId))

  // 固定路径（deleted）先于带 id 的路径注册
  return router()
    .openapi(list, async (c) => c.json(await (await service(c)).list(), 200))
    .openapi(deleted, async (c) =>
      c.json(await withRetention(c, (await service(c)).listDeleted()), 200),
    )
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
    .openapi(references, async (c) =>
      c.json(await (await service(c)).references(c.req.valid('param').credentialId), 200),
    )
    .openapi(connections, async (c) => c.json(await (await vault(c, false)).list(), 200))
    .openapi(connect, async (c) => c.json(await (await vault(c)).connect(c.req.valid('json')), 200))
    .openapi(reconnect, async (c) =>
      c.json(await (await vault(c)).reconnect(connectionId(c), c.req.valid('json')), 200),
    )
    .openapi(check, async (c) => c.json(await (await vault(c)).check(connectionId(c)), 200))
    .openapi(disconnect, async (c) =>
      c.json(await (await vault(c)).disconnect(connectionId(c)), 200),
    )
    .openapi(items, async (c) => {
      const list = await (await vault(c)).items(connectionId(c))
      noStore(c)
      return c.json(list, 200)
    })
}

// 接入方：按标识访问应用所有者的凭据，权限按 Key 的凭据能力算：取用要「取用」，新建、修改、删除要「管理」
function keyCredentialRoutes(deps: Deps) {
  const common = { tags: ['credentials'], security: [{ bearer: [] }] }
  const use = createRoute({
    ...common,
    method: 'get',
    path: '/credentials',
    summary:
      '取用一条凭据：给值（totp 给验证码），可以带一句用途；交出值、被拒或失败都记一条访问事件',
    request: { query: CredentialIdentifierQuery },
    responses: { 200: jsonResponse('凭据', CredentialAccess), ...errors },
  })
  const list = createRoute({
    ...common,
    method: 'get',
    path: '/credentials/list',
    summary: '列出这把 Key 能取用的凭据（不含值）',
    responses: { 200: jsonResponse('凭据', KeyCredentialList), ...errors },
  })
  const create = createRoute({
    ...common,
    method: 'post',
    path: '/credentials',
    summary: '新建 Kioku 托管的凭据，只给这个应用用；要凭据能力为「管理」的访问密钥',
    request: { body: jsonBody(KeyCreateCredentialRequest) },
    responses: { 201: jsonResponse('已创建', CredentialSummary), ...errors },
  })
  const update = createRoute({
    ...common,
    method: 'patch',
    path: '/credentials',
    summary: '按标识修改凭据；不能改限定的应用，密码库的凭据只能改名称与说明',
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
      const { identifier, field, purpose } = c.req.valid('query')
      const result = await service(c).use(identifier, field, 'rest', purpose)
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
