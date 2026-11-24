import { createRoute, z } from '@hono/zod-openapi'
import {
  ACTIVITY_UNKNOWN_TIME_ZONE,
  ActivityDays,
  ActivityDaysQuery,
  ActivityEvent,
  ActivityEventParams,
  ActivityFacets,
  ActivityFilter,
  ActivityList,
  ActivityQuery,
  BrowseEntriesQuery,
  ConsoleCreateEntryRequest,
  ConsoleEntryView,
  ConsoleSearchRequest,
  ConsoleSearchResponse,
  ConsoleTransferEntryRequest,
  ConsoleUpdateEntryRequest,
  ConvertedToCredential,
  ConvertToCredentialRequest,
  CreateEntryRequest,
  CredentialWriteError,
  DeletedEntryList,
  EntryBrowseResponse,
  EntryHistory,
  EntryHistoryQuery,
  EntryList,
  EntryListQuery,
  EntryView,
  EntryWriteError,
  ErrorResponse,
  ExpiredEntryList,
  GetEntryQuery,
  GlossaryIndex,
  PageQuery,
  PlaintextIgnoreRequest,
  ProtectEntryRequest,
  ReactivateRequest,
  RedactEntryRequest,
  RestoreRequest,
  RevealEntryRequest,
  TransferEntryRequest,
  UndeleteRequest,
  UpdateEntryRequest,
} from '@kioku/contracts'
import type { Context } from 'hono'

import { isInstanceAdmin, requireKey } from '../auth/middleware'
import { credentialServiceForConsole } from '../credential/context'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { withDeletionRetention } from '../jobs/retention'
import {
  consoleAllCirclesAccessFor,
  consoleCircleFor,
  consoleMemberFor,
  entryServiceForKey,
  recallForConsole,
  recallScopeForKey,
} from '../memory/context'
import { EntryService, UnknownTimeZoneError } from '../memory/service'

const MATCH_LIMIT = 10

const DeleteEntryQuery = z.object({
  id: z.string().trim().min(1).max(2048),
  circle: z.string().trim().min(1).max(64).optional(),
  expectedVersion: z.coerce.number().int().optional(),
})

const errors = {
  400: jsonResponse('请求不合法', ErrorResponse),
  401: jsonResponse('未登录或凭据无效', ErrorResponse),
  403: jsonResponse('没有权限', ErrorResponse),
  404: jsonResponse('不存在或不可见', ErrorResponse),
  409: jsonResponse('冲突', ErrorResponse),
}

const writeErrors = {
  ...errors,
  400: jsonResponse(
    '请求不合法，或正文里有新增的疑似明文凭据（plaintext 列出每一处）',
    EntryWriteError,
  ),
}

export function memoryRoutes(deps: Deps) {
  const app = router()
  app.use('/entries/*', requireKey(deps))
  app.route('/', keyEntryRoutes(deps))
  app.route('/', consoleEntryRoutes(deps))
  return app
}

function keyEntryRoutes(deps: Deps) {
  const common = { tags: ['entries'], security: [{ bearer: [] }] }
  const get = createRoute({
    ...common,
    method: 'get',
    path: '/entries',
    summary: '按短 ID（m-xxxxxx）、历史坐标或标题读取词条；默认返回与当前切面焦点相容的变体切片',
    request: { query: GetEntryQuery },
    responses: { 200: jsonResponse('词条', EntryView), ...errors },
  })
  const browse = createRoute({
    ...common,
    method: 'get',
    path: '/entries/browse',
    summary: '按维度分组浏览可见的词条索引与多变体切面概览',
    request: { query: BrowseEntriesQuery },
    responses: { 200: jsonResponse('分组浏览结果', EntryBrowseResponse), ...errors },
  })
  const create = createRoute({
    ...common,
    method: 'post',
    path: '/entries',
    summary: '新建词条（单切片或多变体切片），可选目标记忆圈，默认进入主场记忆圈',
    request: { body: jsonBody(CreateEntryRequest) },
    responses: { 201: jsonResponse('已创建', EntryView), ...writeErrors },
  })
  const update = createRoute({
    ...common,
    method: 'patch',
    path: '/entries',
    summary: '修改词条内容、按切面追加/覆盖或删除变体切片、主题标签、敏感级与有效期',
    request: { body: jsonBody(UpdateEntryRequest) },
    responses: { 200: jsonResponse('已修改', EntryView), ...writeErrors },
  })
  const remove = createRoute({
    ...common,
    method: 'delete',
    path: '/entries',
    summary: '软删除词条（保留历史事件）',
    request: { query: DeleteEntryQuery },
    responses: { 204: { description: '已删除' }, ...errors },
  })
  const transfer = createRoute({
    ...common,
    method: 'post',
    path: '/entries/transfer',
    summary: '将词条迁移到另一条可写的共享记忆圈（禁止机密词条或跨越个人圈）',
    request: { body: jsonBody(TransferEntryRequest) },
    responses: { 200: jsonResponse('迁移后的词条', EntryView), ...errors },
  })

  return router()
    .openapi(browse, async (c) => {
      const key = c.get('key')
      return c.json(await entryServiceForKey(deps, key).browse(c.req.valid('query')), 200)
    })
    .openapi(get, async (c) => {
      const key = c.get('key')
      const query = c.req.valid('query')
      const focus = await recallScopeForKey(deps, key).focus()
      const entry = (await entryServiceForKey(deps, key).get(
        {
          id: query.id,
          ...(query.circle !== undefined ? { circle: query.circle } : {}),
          ...(query.allVariants !== undefined ? { allVariants: query.allVariants } : {}),
          focus,
        },
        'rest',
      )) as EntryView
      if (entry.sensitivity === 'secret') c.header('Cache-Control', 'no-store')
      return c.json(entry, 200)
    })
    .openapi(create, async (c) => {
      const key = c.get('key')
      const created = (await entryServiceForKey(deps, key, undefined, {
        maskSecret: true,
      }).create(c.req.valid('json'))) as EntryView
      return c.json(created, 201)
    })
    .openapi(update, async (c) => {
      const key = c.get('key')
      const updated = (await entryServiceForKey(deps, key).update(
        c.req.valid('json'),
        'rest',
      )) as EntryView
      if (updated.sensitivity === 'secret' && updated.variants.some((v) => v.content !== null)) {
        c.header('Cache-Control', 'no-store')
      }
      return c.json(updated, 200)
    })
    .openapi(remove, async (c) => {
      const { id, circle, expectedVersion } = c.req.valid('query')
      await entryServiceForKey(deps, c.get('key')).remove({
        id,
        ...(circle !== undefined ? { circle } : {}),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      })
      return c.body(null, 204)
    })
    .openapi(transfer, async (c) => {
      const transferred = (await entryServiceForKey(deps, c.get('key')).transfer(
        c.req.valid('json'),
      )) as EntryView
      return c.json(transferred, 200)
    })
}

async function consoleMember(deps: Deps, c: Context<AppEnv>) {
  const circleId = c.req.param('circleId')!
  return { circleId, ...(await consoleMemberFor(deps, circleId, c.get('console').accountId)) }
}

function consoleEntryRoutes(deps: Deps) {
  const params = z.object({ circleId: z.uuid() })
  const base = '/circles/{circleId}/entries'
  const common = { tags: ['console'] }

  const get = createRoute({
    ...common,
    method: 'get',
    path: base,
    summary: '按短 ID、UUID 或标题读取词条（默认返回全部变体切片；机密正文不自动解密）',
    request: { params, query: GetEntryQuery },
    responses: { 200: jsonResponse('词条', ConsoleEntryView), ...errors },
  })
  const browse = createRoute({
    ...common,
    method: 'get',
    path: `${base}/browse`,
    summary: '按维度分组浏览词条',
    request: { params, query: BrowseEntriesQuery },
    responses: { 200: jsonResponse('分组浏览结果', EntryBrowseResponse), ...errors },
  })
  const list = createRoute({
    ...common,
    method: 'get',
    path: `${base}/list`,
    summary: '按条件筛选并分页列出词条',
    request: { params, query: EntryListQuery },
    responses: { 200: jsonResponse('词条列表', EntryList), ...errors },
  })
  const search = createRoute({
    ...common,
    method: 'post',
    path: `${base}/search`,
    summary: '搜索词条：标题/短 ID 直接命中，加上召回候选',
    request: { params, body: jsonBody(ConsoleSearchRequest) },
    responses: { 200: jsonResponse('搜索结果', ConsoleSearchResponse), ...errors },
  })
  const glossary = createRoute({
    ...common,
    method: 'get',
    path: `${base}/glossary`,
    summary: '成员可见词条的关键词索引及对应短 ID',
    request: { params },
    responses: { 200: jsonResponse('关键词', GlossaryIndex), ...errors },
  })
  const history = createRoute({
    ...common,
    method: 'get',
    path: `${base}/history`,
    summary: '查看一条词条的历史变更事件（按管理读取过滤）',
    request: { params, query: EntryHistoryQuery },
    responses: { 200: jsonResponse('历史', EntryHistory), ...errors },
  })
  const deleted = createRoute({
    ...common,
    method: 'get',
    path: `${base}/deleted`,
    summary: '已删除的词条列表，最近删除的在前，附带实例回收保留期',
    request: { params, query: PageQuery },
    responses: { 200: jsonResponse('已删除的词条', DeletedEntryList), ...errors },
  })
  const restore = createRoute({
    ...common,
    method: 'post',
    path: `${base}/restore`,
    summary: '恢复到某次历史事件之后的快照',
    request: { params, body: jsonBody(RestoreRequest) },
    responses: { 200: jsonResponse('恢复后的词条', ConsoleEntryView), ...errors },
  })
  const undelete = createRoute({
    ...common,
    method: 'post',
    path: `${base}/undelete`,
    summary: '撤销软删除',
    request: { params, body: jsonBody(UndeleteRequest) },
    responses: { 200: jsonResponse('恢复后的词条', ConsoleEntryView), ...errors },
  })
  const expired = createRoute({
    ...common,
    method: 'get',
    path: `${base}/expired`,
    summary: '已过期的词条列表，最近过期的在前',
    request: { params, query: PageQuery },
    responses: { 200: jsonResponse('已过期的词条', ExpiredEntryList), ...errors },
  })
  const reactivate = createRoute({
    ...common,
    method: 'post',
    path: `${base}/reactivate`,
    summary: '让已过期词条重新生效（清掉有效期）',
    request: { params, body: jsonBody(ReactivateRequest) },
    responses: { 200: jsonResponse('重新生效的词条', ConsoleEntryView), ...errors },
  })
  const reveal = createRoute({
    ...common,
    method: 'post',
    path: `${base}/reveal`,
    summary: '显式查看机密词条的全部变体正文并记一次访问审计事件',
    request: { params, body: jsonBody(RevealEntryRequest) },
    responses: { 200: jsonResponse('带正文的词条', ConsoleEntryView), ...errors },
  })
  const ignorePlaintext = createRoute({
    ...common,
    method: 'post',
    path: `${base}/ignore-plaintext`,
    summary: '忽略明文提示（误报时用）：正文改动后提示自动恢复',
    request: { params, body: jsonBody(PlaintextIgnoreRequest) },
    responses: { 200: jsonResponse('词条', ConsoleEntryView), ...errors },
  })
  const unignorePlaintext = createRoute({
    ...common,
    method: 'post',
    path: `${base}/unignore-plaintext`,
    summary: '撤销忽略明文提示',
    request: { params, body: jsonBody(PlaintextIgnoreRequest) },
    responses: { 200: jsonResponse('词条', ConsoleEntryView), ...errors },
  })
  const redact = createRoute({
    ...common,
    method: 'post',
    path: `${base}/redact`,
    summary: '抹除敏感段：不可逆地将疑似明文凭据或个人信息替换为遮盖符',
    request: { params, body: jsonBody(RedactEntryRequest) },
    responses: { 200: jsonResponse('词条', ConsoleEntryView), ...errors },
  })
  const protect = createRoute({
    ...common,
    method: 'post',
    path: `${base}/protect`,
    summary: '保护含个人信息的词条：转为个人圈私密或加密存为机密',
    request: { params, body: jsonBody(ProtectEntryRequest) },
    responses: { 200: jsonResponse('词条', ConsoleEntryView), ...errors },
  })
  const convertToCredential = createRoute({
    ...common,
    method: 'post',
    path: `${base}/convert-to-credential`,
    summary: '将词条正文中的明文值转存为凭据并替换为占位符（仅记忆圈所有者）',
    request: { params, body: jsonBody(ConvertToCredentialRequest) },
    responses: {
      200: jsonResponse('转存结果', ConvertedToCredential),
      ...errors,
      409: jsonResponse('冲突', CredentialWriteError),
    },
  })
  const transfer = createRoute({
    ...common,
    method: 'post',
    path: `${base}/transfer`,
    summary: '控制台跨圈迁移词条（支持个人圈与共享圈互转及机密迁移）',
    request: { params, body: jsonBody(ConsoleTransferEntryRequest) },
    responses: { 200: jsonResponse('迁移后的词条', ConsoleEntryView), ...errors },
  })
  const create = createRoute({
    ...common,
    method: 'post',
    path: base,
    summary: '新建词条',
    request: { params, body: jsonBody(ConsoleCreateEntryRequest) },
    responses: { 201: jsonResponse('已创建', ConsoleEntryView), ...writeErrors },
  })
  const update = createRoute({
    ...common,
    method: 'patch',
    path: base,
    summary: '修改词条或变体切片',
    request: { params, body: jsonBody(ConsoleUpdateEntryRequest) },
    responses: { 200: jsonResponse('已修改', ConsoleEntryView), ...writeErrors },
  })
  const remove = createRoute({
    ...common,
    method: 'delete',
    path: base,
    summary: '删除词条',
    request: { params, query: DeleteEntryQuery },
    responses: { 204: { description: '已删除' }, ...errors },
  })
  const activity = createRoute({
    ...common,
    method: 'get',
    path: '/circles/{circleId}/activity',
    summary: '记忆圈内词条变更活动记录，最新的在前',
    request: { params, query: ActivityQuery },
    responses: { 200: jsonResponse('变更记录', ActivityList), ...errors },
  })
  const activityDays = createRoute({
    ...common,
    method: 'get',
    path: '/circles/{circleId}/activity/days',
    summary: '变更记录按天计数',
    request: { params, query: ActivityDaysQuery },
    responses: { 200: jsonResponse('按天的条数', ActivityDays), ...errors },
  })
  const activityFacets = createRoute({
    ...common,
    method: 'get',
    path: '/circles/{circleId}/activity/facets',
    summary: '变更记录的筛选维度计数',
    request: { params, query: ActivityFilter },
    responses: { 200: jsonResponse('筛选计数', ActivityFacets), ...errors },
  })
  const activityEvent = createRoute({
    ...common,
    method: 'get',
    path: '/circles/{circleId}/activity/{eventId}',
    summary: '单条变更活动详情及前后快照',
    request: { params: ActivityEventParams },
    responses: { 200: jsonResponse('一条改动', ActivityEvent), ...errors },
  })

  return router()
    .openapi(browse, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.browse(c.req.valid('query')), 200)
    })
    .openapi(list, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.list(c.req.valid('query')), 200)
    })
    .openapi(search, async (c) => {
      const accountId = c.get('console').accountId
      const { circleId, service, resolved } = await consoleMember(deps, c)
      const { query, limit, allCircles } = c.req.valid('json')
      if (allCircles) {
        const allAccess = await consoleAllCirclesAccessFor(deps, circleId, accountId, resolved)
        const allService = new EntryService({
          db: deps.db,
          access: allAccess,
          masterKey: deps.masterKey,
          actor: { accountId },
          listSecret: resolved.role === 'owner',
          secretRead: 'explicit',
          circleOwner: resolved.role === 'owner',
        })
        const [matches, candidates] = await Promise.all([
          allService.searchMatches(query, MATCH_LIMIT),
          recallForConsole(deps, circleId, allAccess, query, limit),
        ])
        return c.json({ matches, candidates }, 200)
      }
      const [matches, candidates] = await Promise.all([
        service.searchMatches(query, MATCH_LIMIT),
        recallForConsole(deps, circleId, service.access, query, limit),
      ])
      return c.json({ matches, candidates }, 200)
    })
    .openapi(glossary, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.glossary(), 200)
    })
    .openapi(history, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.history(c.req.valid('query').id), 200)
    })
    .openapi(deleted, async (c) => {
      const { service } = await consoleMember(deps, c)
      const q = c.req.valid('query')
      return c.json(
        await withDeletionRetention(
          deps.db,
          service.deletedList({
            limit: q.limit,
            ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
          }),
          isInstanceAdmin(deps.db, c.get('console').accountId),
        ),
        200,
      )
    })
    .openapi(restore, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.restore(c.req.valid('json')), 200)
    })
    .openapi(undelete, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.undelete(c.req.valid('json')), 200)
    })
    .openapi(expired, async (c) => {
      const { service } = await consoleMember(deps, c)
      const q = c.req.valid('query')
      return c.json(
        await service.expiredList({
          limit: q.limit,
          ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        }),
        200,
      )
    })
    .openapi(reactivate, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.reactivate(c.req.valid('json')), 200)
    })
    .openapi(reveal, async (c) => {
      const { service } = await consoleMember(deps, c)
      const entry = await service.reveal(c.req.valid('json').entryId, 'console')
      c.header('Cache-Control', 'no-store')
      return c.json(entry, 200)
    })
    .openapi(ignorePlaintext, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.ignorePlaintext(c.req.valid('json')), 200)
    })
    .openapi(unignorePlaintext, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.unignorePlaintext(c.req.valid('json')), 200)
    })
    .openapi(redact, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.redact(c.req.valid('json')), 200)
    })
    .openapi(protect, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.protect(c.req.valid('json')), 200)
    })
    .openapi(convertToCredential, async (c) => {
      const { circleId, service } = await consoleMember(deps, c)
      const credentials = await credentialServiceForConsole(
        deps,
        circleId,
        c.get('console').accountId,
      )
      const body = c.req.valid('json')
      const sink = await credentials.convertTarget(body.target, body.value, () =>
        service.checkConvertible(body),
      )
      const result = await service
        .convertToCredential(body, async (tx) => {
          const credId = await sink.apply(tx)
          return {
            identifier: sink.identifier,
            field: sink.field,
            loadCredential: (afterTx) => credentials.viewIn(afterTx, credId),
            created: sink.created,
            storedIn: sink.storedIn,
          }
        })
        .catch((err: unknown) => {
          throw credentials.orphanedConvert(err, sink)
        })
      c.header('Cache-Control', 'no-store')
      return c.json(result, 200)
    })
    .openapi(transfer, async (c) => {
      const { service } = await consoleMember(deps, c)
      const body = c.req.valid('json')
      const target = await consoleCircleFor(deps, c.get('console').accountId, body.toCircleId)
      if (!target) return c.json({ error: '无权访问目标记忆圈' }, 403)
      return c.json(await service.consoleTransfer(body, target.access), 200)
    })
    .openapi(get, async (c) => {
      const { service } = await consoleMember(deps, c)
      const query = c.req.valid('query')
      const entry = (await service.get(
        {
          id: query.id,
          ...(query.circle !== undefined ? { circle: query.circle } : {}),
          allVariants: query.allVariants ?? true,
        },
        'console',
      )) as ConsoleEntryView
      return c.json(entry, 200)
    })
    .openapi(create, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json((await service.create(c.req.valid('json'))) as ConsoleEntryView, 201)
    })
    .openapi(update, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json((await service.update(c.req.valid('json'), 'console')) as ConsoleEntryView, 200)
    })
    .openapi(remove, async (c) => {
      const { service } = await consoleMember(deps, c)
      const { id, circle, expectedVersion } = c.req.valid('query')
      await service.remove({
        id,
        ...(circle !== undefined ? { circle } : {}),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      })
      return c.body(null, 204)
    })
    .openapi(activity, async (c) => {
      const { service } = await consoleMember(deps, c)
      const { cursor, ...rest } = c.req.valid('query')
      return c.json(
        await service.activity({ ...rest, ...(cursor !== undefined ? { cursor } : {}) }),
        200,
      )
    })
    .openapi(activityDays, async (c) => {
      const { service } = await consoleMember(deps, c)
      try {
        return c.json(await service.activityDays(c.req.valid('query')), 200)
      } catch (err) {
        if (err instanceof UnknownTimeZoneError) {
          return c.json({ error: err.message, code: ACTIVITY_UNKNOWN_TIME_ZONE }, 400)
        }
        throw err
      }
    })
    .openapi(activityFacets, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.activityFacets(c.req.valid('query')), 200)
    })
    .openapi(activityEvent, async (c) => {
      const { service } = await consoleMember(deps, c)
      return c.json(await service.activityEvent(c.req.valid('param').eventId), 200)
    })
}
