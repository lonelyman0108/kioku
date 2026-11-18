import type { HttpBindings } from '@hono/node-server'
import { createRoute, z } from '@hono/zod-openapi'
import {
  AddCircleMemberRequest,
  AdminCircleList,
  CIRCLE_EXPORT_MAX_BYTES,
  CircleDetail,
  CircleExportRequest,
  CircleImportForm,
  CircleImportInspectForm,
  CircleImportPreview,
  CircleImportResult,
  CircleInfo,
  CircleLimitSettings,
  CircleLimitView,
  CircleMember,
  CircleMemberList,
  CirclePrivacySettings,
  CreateCircleRequest,
  CreatedCircle,
  CreateFacetDimensionRequest,
  CreateFacetTermRequest,
  DEPARTURE_RETENTION_DAYS,
  DeleteCircleRequest,
  ErrorResponse,
  ExtractionBudget,
  ExtractionUsage,
  FacetDimensionKey,
  FacetDimensionView,
  FacetTermView,
  FacetVocabularyView,
  TransferCircleOwnershipRequest,
  UpdateCircleMemberRequest,
  UpdateCirclePrivacySettings,
  UpdateCircleRequest,
  UpdateFacetDimensionRequest,
  UpdateFacetTermRequest,
} from '@kioku/contracts'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import {
  addMember,
  adminCircles,
  circleDetail,
  circleLimitReached,
  circleLimitView,
  createSharedCircle,
  deleteSharedCircle,
  listMembers,
  removeMember,
  saveCircleLimit,
  transferOwnership,
  updateCircle,
  updateMemberRole,
  type MemberRejection,
} from '../access/circles'
import {
  isInstanceAdmin,
  lockAsAdmin,
  memberRole,
  requireConsole,
  requireInstanceAdmin,
} from '../auth/middleware'
import { exportCircle, type CircleExportResult } from '../backup/circleExport'
import { importCircle, inspectCircleImport } from '../backup/circleImport'
import { acquireTransferSlot, acquireUploadSlot, withTransferSlot } from '../backup/transferGate'
import {
  bumpCirclePrivacyRevision,
  loadCirclePrivacy,
  saveCirclePrivacy,
} from '../credential/privacy'
import { rescanCircleSensitive } from '../credential/rescan'
import { withCircle } from '../db/client'
import { extractionUsage, saveExtractionBudget } from '../extraction/budget'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleRoleFor } from '../memory/context'
import {
  createDimension,
  createTerm,
  deleteDimension,
  deleteTerm,
  listVocabulary,
  updateDimension,
  updateTerm,
} from '../memory/facets'
import { SettingsInputError } from '../settings/endpoint'

const params = z.object({ circleId: z.uuid() })
const memberParams = z.object({ circleId: z.uuid(), accountId: z.uuid() })
const dimParams = z.object({ circleId: z.uuid(), key: FacetDimensionKey })
const termParams = z.object({ circleId: z.uuid(), termId: z.uuid() })

const forbidden = jsonResponse('没有权限', ErrorResponse)
const busy = jsonResponse('导出导入正忙，稍后再试', ErrorResponse)
const badRequest = jsonResponse('请求不合法', ErrorResponse)
const notMember = { error: '无权访问此记忆圈' }
const conflict = jsonResponse(
  '冲突（已是成员、记忆圈至少要有一个所有者、对方拥有的记忆圈已达上限）',
  ErrorResponse,
)

const memberErrors = {
  400: badRequest,
  403: forbidden,
  404: jsonResponse('账号或成员不存在', ErrorResponse),
  409: conflict,
}

const createCircleRoute = createRoute({
  method: 'post',
  path: '/circles',
  tags: ['console'],
  summary: '新建共享记忆圈（个人圈在建账号时自动创建，无需调用）',
  request: { body: jsonBody(CreateCircleRequest) },
  responses: {
    201: jsonResponse('已新建', CreatedCircle),
    400: badRequest,
    403: forbidden,
    404: jsonResponse('账号不存在', ErrorResponse),
    409: jsonResponse('账号已停用、标识被占用，或拥有的共享记忆圈已达上限', ErrorResponse),
  },
})

const circleView = createRoute({
  method: 'get',
  path: '/circles/{circleId}',
  tags: ['console'],
  summary: '记忆圈概况：标识、名称、类型、默认切面、当前账号的角色与成员数',
  request: { params },
  responses: { 200: jsonResponse('记忆圈', CircleDetail), 403: forbidden },
})

const updateCircleRoute = createRoute({
  method: 'patch',
  path: '/circles/{circleId}',
  tags: ['console'],
  summary: '修改记忆圈名称或默认切面（只有记忆圈所有者）',
  request: { params, body: jsonBody(UpdateCircleRequest) },
  responses: { 200: jsonResponse('记忆圈', CircleInfo), ...memberErrors },
})

const deleteCircleRoute = createRoute({
  method: 'delete',
  path: '/circles/{circleId}',
  tags: ['console'],
  summary: '删除共享记忆圈（个人圈禁止删除；需逐字确认记忆圈名称）',
  request: { params, body: jsonBody(DeleteCircleRequest) },
  responses: { 204: { description: '已删除' }, ...memberErrors },
})

function instanceListRoute(deps: Deps) {
  return createRoute({
    method: 'get',
    path: '/instance/circles',
    tags: ['settings'],
    summary: '实例里的全部记忆圈（只有实例管理员）：不含正文',
    middleware: [requireConsole(deps), requireInstanceAdmin(deps)],
    responses: { 200: jsonResponse('记忆圈列表', AdminCircleList), 403: forbidden },
  })
}

function limitViewRoute(deps: Deps) {
  return createRoute({
    method: 'get',
    path: '/instance/circle-limit',
    tags: ['settings'],
    summary: '共享记忆圈数量上限及当前账号已拥有数量（个人圈不占配额）',
    middleware: [requireConsole(deps)],
    responses: { 200: jsonResponse('上限', CircleLimitView) },
  })
}

function limitUpdateRoute(deps: Deps) {
  return createRoute({
    method: 'put',
    path: '/instance/circle-limit',
    tags: ['settings'],
    summary: '修改共享记忆圈数量上限（只有实例管理员）',
    middleware: [requireConsole(deps), requireInstanceAdmin(deps)],
    request: { body: jsonBody(CircleLimitSettings) },
    responses: { 200: jsonResponse('上限', CircleLimitView), 400: badRequest, 403: forbidden },
  })
}

const membersRoute = createRoute({
  method: 'get',
  path: '/circles/{circleId}/members',
  tags: ['console'],
  summary: '记忆圈成员：账号、角色、加入时间与拥有的接入实例数',
  request: { params },
  responses: { 200: jsonResponse('成员列表', CircleMemberList), 403: forbidden },
})

const addMemberRoute = createRoute({
  method: 'post',
  path: '/circles/{circleId}/members',
  tags: ['console'],
  summary: '按用户名添加共享记忆圈成员（只有记忆圈所有者）',
  request: { params, body: jsonBody(AddCircleMemberRequest) },
  responses: { 201: jsonResponse('已添加', CircleMember), ...memberErrors },
})

const updateMemberRoute = createRoute({
  method: 'patch',
  path: '/circles/{circleId}/members/{accountId}',
  tags: ['console'],
  summary: '改成员在共享记忆圈中的角色（只有记忆圈所有者）',
  request: { params: memberParams, body: jsonBody(UpdateCircleMemberRequest) },
  responses: { 200: jsonResponse('成员', CircleMember), ...memberErrors },
})

const removeMemberRoute = createRoute({
  method: 'delete',
  path: '/circles/{circleId}/members/{accountId}',
  tags: ['console'],
  summary: `移除成员或离开共享记忆圈（个人数据保留 ${DEPARTURE_RETENTION_DAYS} 天）`,
  request: { params: memberParams },
  responses: { 204: { description: '已移除' }, ...memberErrors },
})

const transferRoute = createRoute({
  method: 'post',
  path: '/circles/{circleId}/transfer-ownership',
  tags: ['console'],
  summary: '转让共享记忆圈所有者（只有记忆圈所有者）',
  request: { params, body: jsonBody(TransferCircleOwnershipRequest) },
  responses: { 200: jsonResponse('转让之后的成员信息', CircleMemberList), ...memberErrors },
})

const budget = createRoute({
  method: 'get',
  path: '/circles/{circleId}/extraction-budget',
  tags: ['console'],
  summary: '抽取预算与本月用量',
  request: { params },
  responses: { 200: jsonResponse('预算与用量', ExtractionUsage), 403: forbidden },
})

const saveBudget = createRoute({
  method: 'put',
  path: '/circles/{circleId}/extraction-budget',
  tags: ['console'],
  summary: '修改抽取预算（只有记忆圈所有者）',
  request: { params, body: jsonBody(ExtractionBudget) },
  responses: { 200: jsonResponse('预算与用量', ExtractionUsage), 400: badRequest, 403: forbidden },
})

const privacyView = createRoute({
  method: 'get',
  path: '/circles/{circleId}/privacy',
  tags: ['console'],
  summary: '记忆圈隐私与敏感内容识别设置',
  request: { params },
  responses: { 200: jsonResponse('隐私设置', CirclePrivacySettings), 403: forbidden },
})

const savePrivacy = createRoute({
  method: 'put',
  path: '/circles/{circleId}/privacy',
  tags: ['console'],
  summary: '修改记忆圈隐私设置（仅所有者），保存后触发回扫',
  request: { params, body: jsonBody(UpdateCirclePrivacySettings) },
  responses: {
    200: jsonResponse('隐私设置', CirclePrivacySettings),
    400: badRequest,
    403: forbidden,
  },
})

const rescanPrivacy = createRoute({
  method: 'post',
  path: '/circles/{circleId}/privacy/rescan',
  tags: ['console'],
  summary: '手动触发记忆圈敏感内容回扫（仅所有者）',
  request: { params },
  responses: {
    200: jsonResponse(
      '已触发回扫',
      z.object({ queued: z.boolean(), updated: z.number().int().optional() }),
    ),
    403: forbidden,
  },
})

const facetsView = createRoute({
  method: 'get',
  path: '/circles/{circleId}/facets',
  tags: ['console'],
  summary: '查看记忆圈的切面词表（四大内置维度、自定义维度与词条）',
  request: { params },
  responses: { 200: jsonResponse('切面词表', FacetVocabularyView), 403: forbidden },
})

const createFacetDim = createRoute({
  method: 'post',
  path: '/circles/{circleId}/facets/dimensions',
  tags: ['console'],
  summary: '新建自定义切面维度',
  request: { params, body: jsonBody(CreateFacetDimensionRequest) },
  responses: {
    201: jsonResponse('已创建维度', FacetDimensionView),
    400: badRequest,
    403: forbidden,
    409: jsonResponse('维度已存在', ErrorResponse),
  },
})

const updateFacetDim = createRoute({
  method: 'patch',
  path: '/circles/{circleId}/facets/dimensions/{key}',
  tags: ['console'],
  summary: '修改自定义切面维度（内置维度不可修改）',
  request: { params: dimParams, body: jsonBody(UpdateFacetDimensionRequest) },
  responses: {
    200: jsonResponse('已修改维度', FacetDimensionView),
    400: badRequest,
    403: forbidden,
    404: jsonResponse('维度不存在', ErrorResponse),
  },
})

const deleteFacetDim = createRoute({
  method: 'delete',
  path: '/circles/{circleId}/facets/dimensions/{key}',
  tags: ['console'],
  summary: '删除自定义切面维度及其词条（其他维度词条蕴含引用时返回 409）',
  request: { params: dimParams },
  responses: {
    204: { description: '已删除' },
    400: badRequest,
    403: forbidden,
    404: jsonResponse('维度不存在', ErrorResponse),
    409: jsonResponse('仍被其他切面词条引用', ErrorResponse),
  },
})

const createFacetTerm = createRoute({
  method: 'post',
  path: '/circles/{circleId}/facets/terms',
  tags: ['console'],
  summary: '新增或转正切面词条，支持触发词别名与蕴含关系',
  request: { params, body: jsonBody(CreateFacetTermRequest) },
  responses: {
    201: jsonResponse('已创建词条', FacetTermView),
    400: badRequest,
    403: forbidden,
    409: jsonResponse('词条已存在', ErrorResponse),
  },
})

const updateFacetTerm = createRoute({
  method: 'patch',
  path: '/circles/{circleId}/facets/terms/{termId}',
  tags: ['console'],
  summary: '修改切面词条的名称、蕴含关系或触发词别名',
  request: { params: termParams, body: jsonBody(UpdateFacetTermRequest) },
  responses: {
    200: jsonResponse('已修改词条', FacetTermView),
    400: badRequest,
    403: forbidden,
    404: jsonResponse('词条不存在', ErrorResponse),
  },
})

const deleteFacetTerm = createRoute({
  method: 'delete',
  path: '/circles/{circleId}/facets/terms/{termId}',
  tags: ['console'],
  summary: '删除切面词条',
  request: { params: termParams },
  responses: {
    204: { description: '已删除' },
    403: forbidden,
    404: jsonResponse('词条不存在', ErrorResponse),
  },
})

const exportRoute = createRoute({
  method: 'post',
  path: '/circles/{circleId}/export',
  tags: ['console'],
  summary: '按圈导出（仅记忆圈所有者）：加密打包词条、切片、人格、接入实例与凭据',
  request: { params, body: jsonBody(CircleExportRequest) },
  responses: {
    200: {
      description: '导出文件',
      content: {
        'application/octet-stream': {
          schema: z.string().meta({ type: 'string', format: 'binary' }),
        },
      },
    },
    400: badRequest,
    403: forbidden,
    409: jsonResponse('无法导出或需要主密钥', ErrorResponse),
    429: busy,
  },
})

const UPLOAD_READ_MS = 60_000

function uploadMiddleware(): MiddlewareHandler<AppEnv>[] {
  return [
    bodyLimit({
      maxSize: CIRCLE_EXPORT_MAX_BYTES + 64 * 1024,
      onError: (c) =>
        c.json({ error: `文件超过 ${CIRCLE_EXPORT_MAX_BYTES / 1024 / 1024} MB 的上限` }, 413),
    }),
    async (c, next) => {
      const release = acquireUploadSlot(c.get('console').accountId)
      let timer: NodeJS.Timeout | undefined
      try {
        const late = new Promise<'late'>((resolve) => {
          timer = setTimeout(() => resolve('late'), UPLOAD_READ_MS).unref()
        })
        const read = c.req.arrayBuffer().then(() => 'read' as const)
        if ((await Promise.race([read, late])) === 'late') {
          read.catch(() => undefined)
          ;(c.env as Partial<HttpBindings> | undefined)?.outgoing?.destroy()
          return c.json({ error: '上传超时' }, 408)
        }
      } finally {
        clearTimeout(timer)
        release()
      }
      await next()
    },
  ]
}

const uploadErrors = {
  400: badRequest,
  403: forbidden,
  408: jsonResponse('上传超时', ErrorResponse),
  413: jsonResponse('文件太大', ErrorResponse),
  429: busy,
}

const inspectRoute = createRoute({
  method: 'post',
  path: '/circles/import/inspect',
  tags: ['console'],
  summary: '预检导入包：查看导出者、记忆圈类型与各实体数量',
  middleware: uploadMiddleware(),
  request: {
    body: {
      required: true,
      content: { 'multipart/form-data': { schema: CircleImportInspectForm } },
    },
  },
  responses: { 200: jsonResponse('导入包内容概览', CircleImportPreview), ...uploadErrors },
})

const importRoute = createRoute({
  method: 'post',
  path: '/circles/import',
  tags: ['console'],
  summary: '按圈导入：个人圈包合并到当前账号的个人圈，共享圈包导入为新共享圈',
  middleware: uploadMiddleware(),
  request: {
    body: { required: true, content: { 'multipart/form-data': { schema: CircleImportForm } } },
  },
  responses: {
    201: jsonResponse('已导入', CircleImportResult),
    ...uploadErrors,
    409: jsonResponse('冲突或名称已被占用', ErrorResponse),
  },
})

const EXPORT_SEND_IDLE_MS = 2 * 60_000
const EXPORT_SEND_TOTAL_MS = 30 * 60_000
const CHUNK = 64 * 1024

function fileBody(
  file: Uint8Array,
  done: () => void,
  progressed: () => void,
): { stream: ReadableStream<Uint8Array>; abort: (reason: Error) => void } {
  let at = 0
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c
      },
      pull(c) {
        progressed()
        if (at < file.length) {
          c.enqueue(file.subarray(at, at + CHUNK))
          at += CHUNK
          return
        }
        c.close()
        done()
      },
      cancel() {
        done()
      },
    },
    { highWaterMark: 0 },
  )
  return {
    stream,
    abort(reason) {
      controller.error(reason)
      done()
    },
  }
}

async function exportHoldingSlot(
  accountId: string,
  signal: AbortSignal,
  limits: { idleMs: number; totalMs: number },
  disconnect: () => boolean,
  run: () => Promise<CircleExportResult>,
): Promise<{ exported: CircleExportResult; body: ReadableStream<Uint8Array> }> {
  const release = await acquireTransferSlot(accountId, signal)
  let settled = false
  let idle: NodeJS.Timeout | undefined
  let total: NodeJS.Timeout | undefined
  const settle = () => {
    if (settled) return
    settled = true
    clearTimeout(idle)
    clearTimeout(total)
    signal.removeEventListener('abort', settle)
    release()
  }
  let exported: CircleExportResult
  try {
    exported = await run()
  } catch (err) {
    settle()
    throw err
  }
  const body = fileBody(exported.buffer, settle, () => progressed())
  function progressed() {
    if (settled) return
    clearTimeout(idle)
    idle = setTimeout(() => stop('发送时太久没有进度'), limits.idleMs).unref()
  }
  function stop(why: string) {
    if (settled) return
    console.warn(`导出的文件${why}，断开连接、放掉名额`)
    if (!disconnect()) body.abort(new Error(`导出的文件${why}，中止发送`))
    settle()
  }
  if (signal.aborted) {
    settle()
  } else {
    signal.addEventListener('abort', settle, { once: true })
    progressed()
    total = setTimeout(() => stop('过了发送的总时限还没发完'), limits.totalMs).unref()
  }
  return { exported, body: body.stream }
}

function attachment(filename: string): string {
  const safe = filename.replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, '_').trim() || 'circle.kioku-circle'
  const ascii = safe.replace(/[^\x20-\x7e]/gu, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

function memberError(c: Context<AppEnv>, rejection: MemberRejection, ownerOnly: string) {
  switch (rejection.reason) {
    case 'no-circle':
    case 'not-member':
      return c.json(notMember, 403)
    case 'personal-circle':
      return c.json({ error: '个人记忆圈不支持此成员或删除操作' }, 400)
    case 'forbidden':
      return c.json({ error: ownerOnly }, 403)
    case 'no-account':
      return c.json({ error: '账号不存在' }, 404)
    case 'no-target':
      return c.json({ error: '成员不存在' }, 404)
    case 'already-member':
      return c.json({ error: '已是此记忆圈的成员' }, 409)
    case 'last-owner':
      return c.json(
        {
          error:
            '共享记忆圈至少要有一个未停用的所有者：请先转让给未停用的成员，或请实例管理员启用另一位所有者',
        },
        409,
      )
    case 'self':
      return c.json({ error: '不能转让给自己' }, 400)
    case 'slug-taken':
      return c.json({ error: '记忆圈标识已被占用' }, 409)
    case 'disabled':
      return c.json({ error: '账号已停用' }, 409)
    case 'departure-purging':
      return c.json({ error: '离开后的数据已开始清除，完成后才可重新加入' }, 409)
    case 'owner-busy':
      return c.json({ error: '对方正在新建或导入共享记忆圈，稍后再试' }, 409)
    case 'owner-limit':
      return c.json(
        {
          error: `对方拥有的共享记忆圈已达上限（每个账号最多 ${rejection.limit} 个），不能再成为所有者`,
        },
        409,
      )
  }
}

export function instanceSpaceRoutes(deps: Deps) {
  return router()
    .openapi(instanceListRoute(deps), async (c) =>
      c.json({ circles: await adminCircles(deps.db) }, 200),
    )
    .openapi(limitViewRoute(deps), async (c) =>
      c.json(await circleLimitView(deps.db, c.get('console').accountId), 200),
    )
    .openapi(limitUpdateRoute(deps), async (c) => {
      const actor = c.get('console').accountId
      const saved = await deps.db.transaction(async (tx) => {
        if (!(await lockAsAdmin(tx, actor))) return false
        await saveCircleLimit(tx, c.req.valid('json'))
        return true
      })
      if (!saved) return c.json({ error: '需要实例管理员' }, 403)
      return c.json(await circleLimitView(deps.db, actor), 200)
    })
}

export function spaceRoutes(deps: Deps) {
  const requireFacetEditor = async (circleId: string, accountId: string) => {
    const role = await consoleRoleFor(deps, accountId, circleId)
    return role === 'owner' || role === 'editor'
  }

  return router()
    .openapi(inspectRoute, async (c) => {
      const form = c.req.valid('form')
      const preview = await withTransferSlot(
        c.get('console').accountId,
        c.req.raw.signal,
        async () =>
          inspectCircleImport(Buffer.from(await form.file.arrayBuffer()), form.passphrase),
      )
      return c.json(preview, 200)
    })
    .openapi(importRoute, async (c) => {
      const form = c.req.valid('form')
      const accountId = c.get('console').accountId
      const result = await withTransferSlot(accountId, c.req.raw.signal, async () =>
        importCircle(deps, accountId, {
          file: Buffer.from(await form.file.arrayBuffer()),
          passphrase: form.passphrase,
          ...(form.name !== undefined ? { name: form.name } : {}),
          ...(form.intoPersonalCircle !== undefined
            ? { intoPersonalCircle: form.intoPersonalCircle }
            : {}),
        }),
      )
      void deps.jobs?.enqueueBackfill()
      return c.json(result, 201)
    })
    .openapi(createCircleRoute, async (c) => {
      const accountId = c.get('console').accountId
      const body = c.req.valid('json')
      const res = await createSharedCircle(deps.db, {
        name: body.name,
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        defaultFacets: body.defaultFacets,
        ownerAccountId: accountId,
      })
      if (!res.ok) {
        if (res.reason === 'owner-limit') {
          return c.json({ error: circleLimitReached(res.limit) }, 409)
        }
        if (res.reason === 'slug-taken') return c.json({ error: '记忆圈标识已被占用' }, 409)
        return res.reason === 'disabled'
          ? c.json({ error: '账号已停用' }, 409)
          : c.json({ error: '账号不存在' }, 404)
      }
      return c.json(res.value, 201)
    })
    .openapi(exportRoute, async (c) => {
      const { circleId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await memberRole(deps, circleId, accountId)
      if (!role) return c.json(notMember, 403)
      if (role !== 'owner') return c.json({ error: '仅记忆圈所有者可导出记忆圈' }, 403)
      const signal = c.req.raw.signal
      const limits = deps.exportSendLimits ?? {
        idleMs: EXPORT_SEND_IDLE_MS,
        totalMs: EXPORT_SEND_TOTAL_MS,
      }
      const outgoing = (c.env as Partial<HttpBindings> | undefined)?.outgoing
      const disconnect = () => {
        if (!outgoing) return false
        outgoing.destroy()
        return true
      }
      const { exported, body } = await exportHoldingSlot(
        accountId,
        signal,
        limits,
        disconnect,
        () => exportCircle(deps, circleId, accountId, c.req.valid('json').passphrase),
      )
      return c.body(body, 200, {
        'content-type': 'application/octet-stream',
        'content-length': String(exported.buffer.length),
        'content-disposition': attachment(exported.filename),
        'cache-control': 'no-store',
      })
    })
    .openapi(circleView, async (c) => {
      const { circleId } = c.req.valid('param')
      const detail = await circleDetail(deps.db, circleId, c.get('console').accountId)
      if (!detail) return c.json(notMember, 403)
      return c.json(detail, 200)
    })
    .openapi(updateCircleRoute, async (c) => {
      const { circleId } = c.req.valid('param')
      const body = c.req.valid('json')
      const result = await updateCircle(deps.db, {
        circleId,
        actor: c.get('console').accountId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.defaultFacets !== undefined ? { defaultFacets: body.defaultFacets } : {}),
      })
      if (!result.ok) return memberError(c, result, '仅记忆圈所有者可修改记忆圈')
      return c.json(result.value, 200)
    })
    .openapi(deleteCircleRoute, async (c) => {
      const { circleId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const admin = await isInstanceAdmin(deps.db, accountId)
      const result = await deleteSharedCircle(deps.db, {
        circleId,
        actor: accountId,
        admin,
        confirmName: c.req.valid('json').confirmName,
      })
      if (!result.ok) {
        if (result.reason === 'name-mismatch') return c.json({ error: '记忆圈名称不一致' }, 400)
        if (result.reason === 'no-circle' && admin) return c.json({ error: '记忆圈不存在' }, 404)
        return memberError(c, result, '仅记忆圈所有者或实例管理员可删除共享记忆圈')
      }
      return c.body(null, 204)
    })
    .openapi(membersRoute, async (c) => {
      const { circleId } = c.req.valid('param')
      if (!(await memberRole(deps, circleId, c.get('console').accountId))) {
        return c.json(notMember, 403)
      }
      return c.json({ members: await listMembers(deps.db, circleId) }, 200)
    })
    .openapi(addMemberRoute, async (c) => {
      const { circleId } = c.req.valid('param')
      const body = c.req.valid('json')
      const result = await addMember(deps.db, {
        circleId,
        actor: c.get('console').accountId,
        username: body.username,
        role: body.role,
      })
      if (!result.ok) return memberError(c, result, '仅记忆圈所有者可添加成员')
      return c.json(result.value, 201)
    })
    .openapi(updateMemberRoute, async (c) => {
      const { circleId, accountId } = c.req.valid('param')
      const result = await updateMemberRole(deps.db, {
        circleId,
        actor: c.get('console').accountId,
        target: accountId,
        role: c.req.valid('json').role,
      })
      if (!result.ok) return memberError(c, result, '仅记忆圈所有者可修改成员角色')
      return c.json(result.value, 200)
    })
    .openapi(removeMemberRoute, async (c) => {
      const { circleId, accountId } = c.req.valid('param')
      const result = await removeMember(deps.db, {
        circleId,
        actor: c.get('console').accountId,
        target: accountId,
      })
      if (!result.ok) return memberError(c, result, '仅记忆圈所有者可移除其他成员')
      return c.body(null, 204)
    })
    .openapi(transferRoute, async (c) => {
      const { circleId } = c.req.valid('param')
      const result = await transferOwnership(deps.db, {
        circleId,
        actor: c.get('console').accountId,
        target: c.req.valid('json').accountId,
      })
      if (!result.ok) return memberError(c, result, '仅记忆圈所有者可转让所有权')
      return c.json({ members: result.value }, 200)
    })
    .openapi(budget, async (c) => {
      const { circleId } = c.req.valid('param')
      if (!(await memberRole(deps, circleId, c.get('console').accountId))) {
        return c.json(notMember, 403)
      }
      return c.json(await extractionUsage(deps.db, circleId), 200)
    })
    .openapi(saveBudget, async (c) => {
      const { circleId } = c.req.valid('param')
      if ((await memberRole(deps, circleId, c.get('console').accountId)) !== 'owner') {
        return c.json({ error: '仅记忆圈所有者可修改抽取预算' }, 403)
      }
      await saveExtractionBudget(deps.db, circleId, c.req.valid('json'))
      return c.json(await extractionUsage(deps.db, circleId), 200)
    })
    .openapi(privacyView, async (c) => {
      const { circleId } = c.req.valid('param')
      if (!(await memberRole(deps, circleId, c.get('console').accountId))) {
        return c.json(notMember, 403)
      }
      const { settings } = await loadCirclePrivacy(deps.db, circleId)
      return c.json(settings, 200)
    })
    .openapi(savePrivacy, async (c) => {
      const { circleId } = c.req.valid('param')
      if ((await memberRole(deps, circleId, c.get('console').accountId)) !== 'owner') {
        return c.json({ error: '仅记忆圈所有者可修改隐私设置' }, 403)
      }
      try {
        const { settings } = await saveCirclePrivacy(deps.db, circleId, c.req.valid('json'))
        if (deps.jobs?.enqueueSensitiveRescan) {
          void deps.jobs.enqueueSensitiveRescan(circleId)
        } else {
          await rescanCircleSensitive(deps.db, deps.masterKey, circleId)
        }
        return c.json(settings, 200)
      } catch (err) {
        if (err instanceof SettingsInputError) return c.json({ error: err.message }, 400)
        throw err
      }
    })
    .openapi(rescanPrivacy, async (c) => {
      const { circleId } = c.req.valid('param')
      if ((await memberRole(deps, circleId, c.get('console').accountId)) !== 'owner') {
        return c.json({ error: '仅记忆圈所有者可触发回扫' }, 403)
      }
      await bumpCirclePrivacyRevision(deps.db, circleId)
      if (deps.jobs?.enqueueSensitiveRescan) {
        const queued = await deps.jobs.enqueueSensitiveRescan(circleId)
        return c.json({ queued }, 200)
      }
      const updated = await rescanCircleSensitive(deps.db, deps.masterKey, circleId)
      return c.json({ queued: false, updated }, 200)
    })
    .openapi(facetsView, async (c) => {
      const { circleId } = c.req.valid('param')
      await consoleRoleFor(deps, c.get('console').accountId, circleId)
      return c.json(await withCircle(deps.db, circleId, (tx) => listVocabulary(tx, circleId)), 200)
    })
    .openapi(createFacetDim, async (c) => {
      const { circleId } = c.req.valid('param')
      if (!(await requireFacetEditor(circleId, c.get('console').accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const body = c.req.valid('json')
      return c.json(
        await withCircle(deps.db, circleId, (tx) => createDimension(tx, circleId, body)),
        201,
      )
    })
    .openapi(updateFacetDim, async (c) => {
      const { circleId, key } = c.req.valid('param')
      if (!(await requireFacetEditor(circleId, c.get('console').accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const body = c.req.valid('json')
      return c.json(
        await withCircle(deps.db, circleId, (tx) => updateDimension(tx, circleId, key, body)),
        200,
      )
    })
    .openapi(deleteFacetDim, async (c) => {
      const { circleId, key } = c.req.valid('param')
      if (!(await requireFacetEditor(circleId, c.get('console').accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      await withCircle(deps.db, circleId, (tx) => deleteDimension(tx, circleId, key))
      return c.body(null, 204)
    })
    .openapi(createFacetTerm, async (c) => {
      const { circleId } = c.req.valid('param')
      if (!(await requireFacetEditor(circleId, c.get('console').accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const body = c.req.valid('json')
      return c.json(
        await withCircle(deps.db, circleId, (tx) => createTerm(tx, circleId, body)),
        201,
      )
    })
    .openapi(updateFacetTerm, async (c) => {
      const { circleId, termId } = c.req.valid('param')
      if (!(await requireFacetEditor(circleId, c.get('console').accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      const body = c.req.valid('json')
      return c.json(
        await withCircle(deps.db, circleId, (tx) => updateTerm(tx, circleId, termId, body)),
        200,
      )
    })
    .openapi(deleteFacetTerm, async (c) => {
      const { circleId, termId } = c.req.valid('param')
      if (!(await requireFacetEditor(circleId, c.get('console').accountId))) {
        return c.json({ error: '需要记忆圈所有者或编辑者角色' }, 403)
      }
      await withCircle(deps.db, circleId, (tx) => deleteTerm(tx, circleId, termId))
      return c.body(null, 204)
    })
}
