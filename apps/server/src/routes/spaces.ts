import type { HttpBindings } from '@hono/node-server'
import { createRoute, z } from '@hono/zod-openapi'
import {
  AddMemberRequest,
  CreatedSpace,
  CreateSpaceRequest,
  DeleteSpaceRequest,
  ErrorResponse,
  ExtractionBudget,
  ExtractionUsage,
  InstanceSpace,
  RenameSpaceRequest,
  SPACE_EXPORT_MAX_BYTES,
  SpaceCreationPolicy,
  SpaceCreationView,
  SpaceDetail,
  SpaceInfo,
  SpaceMember,
  TransferOwnershipRequest,
  UpdateMemberRequest,
  SpaceExportRequest,
  SpaceImportForm,
  SpaceImportInspectForm,
  SpaceImportPreview,
  SpaceImportResult,
} from '@kioku/contracts'
import { bodyLimit } from 'hono/body-limit'
import type { Context, MiddlewareHandler } from 'hono'

import {
  addMember,
  createSpace,
  deleteSpace,
  instanceSpaces,
  listMembers,
  loadSpaceCreationPolicy,
  removeMember,
  renameSpace,
  saveSpaceCreationPolicy,
  spaceDetail,
  transferOwnership,
  updateMemberRole,
  type MemberFailure,
} from '../access/spaces'
import {
  isInstanceAdmin,
  memberRole,
  requireConsole,
  requireInstanceAdmin,
} from '../auth/middleware'
import { exportSpace, type SpaceExport } from '../backup/spaceExport'
import { importSpace, inspectSpaceImport } from '../backup/spaceImport'
import { acquireTransferSlot, withTransferSlot } from '../backup/transferGate'
import { extractionUsage, saveExtractionBudget } from '../extraction/budget'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const params = z.object({ spaceId: z.uuid() })
const forbidden = jsonResponse('没有权限', ErrorResponse)
// 导出、检查与导入同时只做一个、排队有上限、每个账号同时最多占一个：满了就是这个
const busy = jsonResponse('导出导入正忙，稍后再试', ErrorResponse)

const budget = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/extraction-budget',
  tags: ['console'],
  summary: '抽取预算与本月用量：每月的 token 上限、每个对象每天最多写几条事实',
  request: { params },
  responses: { 200: jsonResponse('预算与用量', ExtractionUsage), 403: forbidden },
})

const saveBudget = createRoute({
  method: 'put',
  path: '/spaces/{spaceId}/extraction-budget',
  tags: ['console'],
  summary: '修改抽取预算（只有空间 owner）：用完之后只写会话摘要，下个月恢复',
  request: { params, body: jsonBody(ExtractionBudget) },
  responses: {
    200: jsonResponse('预算与用量', ExtractionUsage),
    400: jsonResponse('请求不合法', ErrorResponse),
    403: forbidden,
  },
})

const notMember = { error: '无权访问此空间' }
const badRequest = jsonResponse('请求不合法', ErrorResponse)
const conflict = jsonResponse('冲突（已是成员、空间至少要有一个所有者）', ErrorResponse)
const memberParams = z.object({ spaceId: z.uuid(), accountId: z.uuid() })
// memberError 会给出的几种回应
const memberErrors = {
  400: badRequest,
  403: forbidden,
  404: jsonResponse('账号或成员不存在', ErrorResponse),
  409: conflict,
}

const createSpaceRoute = createRoute({
  method: 'post',
  path: '/spaces',
  tags: ['console'],
  summary:
    '新建空间：实例管理员随时可以，并且可以指定所有者；别的账号只在实例开关打开时可以，所有者是自己',
  request: { body: jsonBody(CreateSpaceRequest) },
  responses: {
    201: jsonResponse('已新建', CreatedSpace),
    400: badRequest,
    403: forbidden,
    404: jsonResponse('账号不存在', ErrorResponse),
  },
})

const spaceView = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}',
  tags: ['console'],
  summary: '空间概况：名字、建立时间、当前账号的角色与成员数（成员都能看）',
  request: { params },
  responses: { 200: jsonResponse('空间', SpaceDetail), 403: forbidden },
})

const renameRoute = createRoute({
  method: 'patch',
  path: '/spaces/{spaceId}',
  tags: ['console'],
  summary: '改空间名（只有空间所有者）',
  request: { params, body: jsonBody(RenameSpaceRequest) },
  responses: { 200: jsonResponse('空间', SpaceInfo), ...memberErrors },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/spaces/{spaceId}',
  tags: ['console'],
  summary:
    '删除空间（空间所有者或实例管理员）：请求里带上现在的空间名确认，空间里的全部内容一起删除，无法恢复',
  request: { params, body: jsonBody(DeleteSpaceRequest) },
  responses: { 204: { description: '已删除' }, ...memberErrors },
})

// 实例级的接口不在 /spaces/* 下，会话鉴权挂在每个路由上
function instanceListRoute(deps: Deps) {
  return createRoute({
    method: 'get',
    path: '/instance/spaces',
    tags: ['settings'],
    summary: '实例里的全部空间（只有实例管理员）：名字、建立时间、所有者与成员数，不含内容',
    middleware: [requireConsole(deps), requireInstanceAdmin(deps)],
    responses: { 200: jsonResponse('空间列表', z.array(InstanceSpace)), 403: forbidden },
  })
}

function creationViewRoute(deps: Deps) {
  return createRoute({
    method: 'get',
    path: '/instance/space-creation',
    tags: ['settings'],
    summary: '实例开关「允许成员自建空间」，以及当前账号能不能新建空间',
    middleware: [requireConsole(deps)],
    responses: { 200: jsonResponse('开关', SpaceCreationView) },
  })
}

function creationUpdateRoute(deps: Deps) {
  return createRoute({
    method: 'put',
    path: '/instance/space-creation',
    tags: ['settings'],
    summary: '修改「允许成员自建空间」（只有实例管理员，默认关）',
    middleware: [requireConsole(deps), requireInstanceAdmin(deps)],
    request: { body: jsonBody(SpaceCreationPolicy) },
    responses: { 200: jsonResponse('开关', SpaceCreationView), 400: badRequest, 403: forbidden },
  })
}

const members = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/members',
  tags: ['console'],
  summary: '空间成员：账号、角色、加入时间与拥有的应用数（成员都能看）',
  request: { params },
  responses: { 200: jsonResponse('成员列表', z.array(SpaceMember)), 403: forbidden },
})

const addMemberRoute = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/members',
  tags: ['console'],
  summary:
    '按用户名添加成员（只有空间所有者，精确匹配）。离开不满 30 天的成员重新加入后，本人记忆与凭据照旧可见',
  request: { params, body: jsonBody(AddMemberRequest) },
  responses: {
    201: jsonResponse('已添加', SpaceMember),
    ...memberErrors,
  },
})

const updateMemberRoute = createRoute({
  method: 'patch',
  path: '/spaces/{spaceId}/members/{accountId}',
  tags: ['console'],
  summary: '改成员的角色（只有空间所有者）：空间至少要有一个所有者',
  request: { params: memberParams, body: jsonBody(UpdateMemberRequest) },
  responses: {
    200: jsonResponse('成员', SpaceMember),
    ...memberErrors,
  },
})

const removeMemberRoute = createRoute({
  method: 'delete',
  path: '/spaces/{spaceId}/members/{accountId}',
  tags: ['console'],
  summary:
    '移除成员（空间所有者移除别人），或离开空间（成员移除自己）。他的应用的访问密钥立即吊销；本人记忆、凭据与密码库连接保留 30 天，期间重新加入就恢复，到期删除。最后一个所有者要先转让',
  request: { params: memberParams },
  responses: {
    204: { description: '已移除' },
    ...memberErrors,
  },
})

const transferRoute = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/transfer-ownership',
  tags: ['console'],
  summary: '转让所有者（只有空间所有者）：对方成为所有者，当前账号改为编辑者',
  request: { params, body: jsonBody(TransferOwnershipRequest) },
  responses: {
    200: jsonResponse('对方与当前账号转让之后的成员信息', z.array(SpaceMember)),
    ...memberErrors,
  },
})

const exportRoute = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/export',
  tags: ['console'],
  summary:
    '导出这个空间（只有空间 owner）：共享的内容加上自己的本人记忆与凭据，用口令加密成一个文件，可以导入到另一个实例的新空间',
  request: { params, body: jsonBody(SpaceExportRequest) },
  responses: {
    200: {
      description: '导出文件',
      content: {
        'application/octet-stream': {
          schema: z.string().meta({ type: 'string', format: 'binary' }),
        },
      },
    },
    400: jsonResponse('导出不了（例如超过导入的大小上限）', ErrorResponse),
    403: forbidden,
    409: jsonResponse('有导出了也导入不了、或者解不开的内容（点名是哪一条）', ErrorResponse),
    429: busy,
  },
})

// 上传导出文件的两个接口共用：先确认是实例管理员、再看大小，最后才读表单，别人上传的大文件不读进内存。
// 上限按文件算，表单里的口令、名字与分隔行另外留一点余量。名额等表单读完才在处理函数里拿（见 transferGate.ts）：
// 太大的上传在这之前就是 413，不排队、不占名额，慢的上传也不占着名额。这两个接口只有实例管理员能用，
// 同时上传的个数不另外限制
function uploadMiddleware(deps: Deps): MiddlewareHandler<AppEnv>[] {
  return [
    requireInstanceAdmin(deps, '仅实例管理员可导入空间'),
    bodyLimit({
      maxSize: SPACE_EXPORT_MAX_BYTES + 64 * 1024,
      onError: (c) =>
        c.json({ error: `文件超过 ${SPACE_EXPORT_MAX_BYTES / 1024 / 1024} MB 的上限` }, 413),
    }),
  ]
}
const uploadErrors = {
  400: jsonResponse('导入不了（口令不对、文件被改过、内容对不上、没配主密钥等）', ErrorResponse),
  403: forbidden,
  413: jsonResponse('文件太大', ErrorResponse),
  429: busy,
}

function inspectRoute(deps: Deps) {
  return createRoute({
    method: 'post',
    path: '/spaces/import/inspect',
    tags: ['console'],
    summary:
      '导入之前先检查导出文件（只有实例管理员）：是谁导出的、有多少，导入后哪些归你；导入会遇到的问题这一步就报出来，不写库',
    middleware: uploadMiddleware(deps),
    request: {
      body: {
        required: true,
        content: { 'multipart/form-data': { schema: SpaceImportInspectForm } },
      },
    },
    responses: { 200: jsonResponse('文件的内容', SpaceImportPreview), ...uploadErrors },
  })
}

function importRoute(deps: Deps) {
  return createRoute({
    method: 'post',
    path: '/spaces/import',
    tags: ['console'],
    summary:
      '把导出文件导入成一个新空间（只有实例管理员），导入人是新空间的 owner，导出人的本人记忆与凭据都归导入人；Key 不在文件里，要重新签发',
    middleware: uploadMiddleware(deps),
    request: {
      body: { required: true, content: { 'multipart/form-data': { schema: SpaceImportForm } } },
    },
    responses: { 201: jsonResponse('已导入', SpaceImportResult), ...uploadErrors },
  })
}

// 导出的文件发送的时限。客户端不断开、却一直不读响应时，node 与 @hono/node-server 都没有发送的时限，
// 名额会一直占到连接关闭，别的导出导入只能排着：
// - 空闲：这么久没有进度（客户端没有读走下一块）就断开、放掉名额。慢网络上正常在读的下载每读一块重新计时，不会被掐断；
// - 总时限：一直在读、但慢到这么久还没发完的也断开。导出导入全实例只有一个名额，不能让谁慢慢读就占着它太久；
//   文件最大 32 MiB，30 分钟发完要每秒 18 KB 左右
const EXPORT_SEND_IDLE_MS = 2 * 60_000
const EXPORT_SEND_TOTAL_MS = 30 * 60_000

// 整个导出占一个名额：文件攒在内存里，要等发给浏览器之后才释放。名额只在 settle 里放、只放一次，放的时候移除断开的监听
// 与发送时限；哪种情况先到都走它：导出出错或停下、文件发完、发送途中响应流被取消、文件做好之后客户端断开、
// 到了发送时限（先断开连接）。导出期间不靠断开的监听放：客户端断开时 exportSpace 在下一个检查点自己停下，停下之后才放，
// 名额不会在它还在派生、读库时就让给别人。文件做好之后、开始发之前就断开的，node 的服务端既不读这个响应流、
// 也不取消它，只能在断开时放。
// 到了时限直接断开这个请求的连接（disconnect），客户端只看到连接断了：不让响应流出错，否则 @hono/node-server 会往
// 发了一半的文件后面写一段错误文本、再打一段调用栈。拿不到底层连接时（进程内调用 app.request）才让响应流出错
async function exportHoldingSlot(
  accountId: string,
  signal: AbortSignal,
  limits: { idleMs: number; totalMs: number },
  disconnect: () => boolean,
  run: () => Promise<SpaceExport>,
): Promise<{ exported: SpaceExport; body: ReadableStream<Uint8Array> }> {
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
  let exported: SpaceExport
  try {
    exported = await run()
  } catch (err) {
    settle()
    throw err
  }
  const body = fileBody(exported.file, settle, () => progressed())
  // 每读走一块重新计空闲时限。两个时限都只是兜底，unref 不让进程为它们留着
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

// 每次交给响应流的字节数
const CHUNK = 64 * 1024

// 响应流：文件分块交出去，读一块才给下一块（不预先排一块），读完或者被取消时调 done，所以文件真的发出去了才算发完。
// 一次交出整个文件的话，node 的服务端拿到就整个收进连接的写缓冲，马上算发完、放掉名额，客户端不读时文件却一直在内存里。
// 每次被读（pull）调 progressed；abort 让响应流出错，也调 done
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

// 下载的文件名：空间名加导出时间（UTC）。空间名里放不进文件名的字符换成 _，另给一个只有 ASCII 的备用名
function attachment(spaceName: string, createdAt: string): string {
  const stamp = createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const safe = spaceName.replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, '_').trim() || 'space'
  const fallback = `kioku-space-${stamp}.kioku-space`
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(`${safe}-${stamp}.kioku-space`)}`
}

// 成员与空间操作被拒的回应。不是成员（包括空间不存在）一律和别的空间接口一样回 403；ownerOnly 是不是所有者时的说明
function memberError(c: Context<AppEnv>, reason: MemberFailure, ownerOnly: string) {
  switch (reason) {
    case 'no-space':
    case 'not-member':
      return c.json(notMember, 403)
    case 'forbidden':
      return c.json({ error: ownerOnly }, 403)
    case 'no-account':
      return c.json({ error: '账号不存在' }, 404)
    case 'no-target':
      return c.json({ error: '成员不存在' }, 404)
    case 'already-member':
      return c.json({ error: '已是此空间的成员' }, 409)
    case 'last-owner':
      return c.json({ error: '空间至少要有一个所有者，请先转让所有者' }, 409)
    case 'self':
      return c.json({ error: '不能转让给自己' }, 400)
  }
}

// 实例级的空间管理：空间列表与「允许成员自建空间」
export function instanceSpaceRoutes(deps: Deps) {
  const view = async (accountId: string) => {
    const policy = await loadSpaceCreationPolicy(deps.db)
    const admin = await isInstanceAdmin(deps.db, accountId)
    return { ...policy, canCreate: admin || policy.membersCanCreate }
  }
  return router()
    .openapi(instanceListRoute(deps), async (c) => c.json(await instanceSpaces(deps.db), 200))
    .openapi(creationViewRoute(deps), async (c) =>
      c.json(await view(c.get('console').accountId), 200),
    )
    .openapi(creationUpdateRoute(deps), async (c) => {
      await saveSpaceCreationPolicy(deps.db, c.req.valid('json'))
      return c.json(await view(c.get('console').accountId), 200)
    })
}

// 空间级的设置。spaces 是身份表，不在 RLS 里，按成员关系自己检查权限
export function spaceRoutes(deps: Deps) {
  return router()
    .openapi(exportRoute, async (c) => {
      const { spaceId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await memberRole(deps, spaceId, accountId)
      if (!role) return c.json(notMember, 403)
      // 文件里有 secret 与托管的凭据值，和读写它们一样只给空间 owner
      if (role !== 'owner') return c.json({ error: '仅空间所有者可导出空间' }, 403)
      const signal = c.req.raw.signal
      const limits = deps.exportSendLimits ?? {
        idleMs: EXPORT_SEND_IDLE_MS,
        totalMs: EXPORT_SEND_TOTAL_MS,
      }
      // @hono/node-server 把底层的请求与响应放在 env 里，断开连接要用；进程内调用 app.request 时没有
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
        () =>
          exportSpace(deps.db, deps.masterKey, {
            spaceId,
            accountId,
            passphrase: c.req.valid('json').passphrase,
            signal,
          }),
      )
      return c.body(body, 200, {
        'content-type': 'application/octet-stream',
        'content-length': String(exported.file.length),
        'content-disposition': attachment(exported.spaceName, exported.createdAt),
        'cache-control': 'no-store',
      })
    })
    .openapi(inspectRoute(deps), async (c) => {
      const form = c.req.valid('form')
      // 表单读完了才拿名额：解密、解压与解析都占着它
      const preview = await withTransferSlot(
        c.get('console').accountId,
        c.req.raw.signal,
        async () =>
          inspectSpaceImport(deps.db, deps.masterKey, {
            file: Buffer.from(await form.file.arrayBuffer()),
            passphrase: form.passphrase,
          }),
      )
      return c.json(preview, 200)
    })
    .openapi(importRoute(deps), async (c) => {
      const form = c.req.valid('form')
      const accountId = c.get('console').accountId
      // 表单读完了才拿名额：解密、解压、解析与写库都占着它
      const result = await withTransferSlot(accountId, c.req.raw.signal, async () =>
        importSpace(deps.db, deps.masterKey, {
          accountId,
          file: Buffer.from(await form.file.arrayBuffer()),
          passphrase: form.passphrase,
          name: form.name,
        }),
      )
      // 向量不在文件里，按这个实例的嵌入设置重新生成
      void deps.jobs?.enqueueBackfill()
      return c.json(result, 201)
    })
    .openapi(members, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await memberRole(deps, spaceId, c.get('console').accountId))) {
        return c.json(notMember, 403)
      }
      return c.json(await listMembers(deps.db, spaceId), 200)
    })
    .openapi(addMemberRoute, async (c) => {
      const { spaceId } = c.req.valid('param')
      const body = c.req.valid('json')
      const result = await addMember(deps.db, {
        spaceId,
        actor: c.get('console').accountId,
        username: body.username,
        role: body.role,
      })
      if (!result.ok) return memberError(c, result.reason, '仅空间所有者可添加成员')
      return c.json(result.value, 201)
    })
    .openapi(updateMemberRoute, async (c) => {
      const { spaceId, accountId } = c.req.valid('param')
      const result = await updateMemberRole(deps.db, {
        spaceId,
        actor: c.get('console').accountId,
        target: accountId,
        role: c.req.valid('json').role,
      })
      if (!result.ok) return memberError(c, result.reason, '仅空间所有者可修改成员角色')
      return c.json(result.value, 200)
    })
    .openapi(removeMemberRoute, async (c) => {
      const { spaceId, accountId } = c.req.valid('param')
      const result = await removeMember(deps.db, {
        spaceId,
        actor: c.get('console').accountId,
        target: accountId,
      })
      if (!result.ok) return memberError(c, result.reason, '仅空间所有者可移除其他成员')
      return c.body(null, 204)
    })
    .openapi(transferRoute, async (c) => {
      const { spaceId } = c.req.valid('param')
      const result = await transferOwnership(deps.db, {
        spaceId,
        actor: c.get('console').accountId,
        target: c.req.valid('json').accountId,
      })
      if (!result.ok) return memberError(c, result.reason, '仅空间所有者可转让所有者')
      return c.json(result.value, 200)
    })
    .openapi(createSpaceRoute, async (c) => {
      const accountId = c.get('console').accountId
      const body = c.req.valid('json')
      const admin = await isInstanceAdmin(deps.db, accountId)
      const owner = body.ownerAccountId ?? accountId
      if (!admin) {
        if (owner !== accountId) return c.json({ error: '仅实例管理员可为其他账号新建空间' }, 403)
        if (!(await loadSpaceCreationPolicy(deps.db)).membersCanCreate) {
          return c.json({ error: '实例未允许成员自建空间' }, 403)
        }
      }
      const space = await createSpace(deps.db, { name: body.name, ownerAccountId: owner })
      if (!space) return c.json({ error: '账号不存在' }, 404)
      return c.json({ ...space, ownerAccountId: owner }, 201)
    })
    .openapi(spaceView, async (c) => {
      const { spaceId } = c.req.valid('param')
      const detail = await spaceDetail(deps.db, spaceId, c.get('console').accountId)
      if (!detail) return c.json(notMember, 403)
      return c.json(detail, 200)
    })
    .openapi(renameRoute, async (c) => {
      const { spaceId } = c.req.valid('param')
      const result = await renameSpace(deps.db, {
        spaceId,
        actor: c.get('console').accountId,
        name: c.req.valid('json').name,
      })
      if (!result.ok) return memberError(c, result.reason, '仅空间所有者可修改空间名')
      return c.json(result.value, 200)
    })
    .openapi(deleteRoute, async (c) => {
      const { spaceId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const admin = await isInstanceAdmin(deps.db, accountId)
      const result = await deleteSpace(deps.db, {
        spaceId,
        actor: accountId,
        admin,
        confirmName: c.req.valid('json').confirmName,
      })
      if (!result.ok) {
        if (result.reason === 'name-mismatch') return c.json({ error: '空间名不一致' }, 400)
        // 别人探不出空间在不在：不存在与不是成员一样回 403，只有实例管理员看得到 404
        if (result.reason === 'no-space' && admin) return c.json({ error: '空间不存在' }, 404)
        return memberError(c, result.reason, '仅空间所有者或实例管理员可删除空间')
      }
      return c.body(null, 204)
    })
    .openapi(budget, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await memberRole(deps, spaceId, c.get('console').accountId))) {
        return c.json(notMember, 403)
      }
      return c.json(await extractionUsage(deps.db, spaceId), 200)
    })
    .openapi(saveBudget, async (c) => {
      const { spaceId } = c.req.valid('param')
      // 预算管的是花钱的事，和 domain 默认层一样只有空间 owner 能改
      if ((await memberRole(deps, spaceId, c.get('console').accountId)) !== 'owner') {
        return c.json({ error: '仅空间所有者可修改抽取预算' }, 403)
      }
      await saveExtractionBudget(deps.db, spaceId, c.req.valid('json'))
      return c.json(await extractionUsage(deps.db, spaceId), 200)
    })
}
