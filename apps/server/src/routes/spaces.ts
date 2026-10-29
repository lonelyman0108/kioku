import { createRoute, z } from '@hono/zod-openapi'
import {
  DomainLayers,
  ErrorResponse,
  ExtractionBudget,
  ExtractionUsage,
  MemberInfo,
  SPACE_EXPORT_MAX_BYTES,
  SpaceExportRequest,
  SpaceImportForm,
  SpaceImportInspectForm,
  SpaceImportPreview,
  SpaceImportResult,
} from '@kioku/contracts'
import { asc, eq } from 'drizzle-orm'
import { bodyLimit } from 'hono/body-limit'
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'

import { memberRole, requireInstanceAdmin } from '../auth/middleware'
import { exportSpace } from '../backup/spaceExport'
import { importSpace, inspectSpaceImport } from '../backup/spaceImport'
import { acquireTransferSlot } from '../backup/transferGate'
import { accounts, spaceMembers, spaces } from '../db/schema'
import { extractionUsage, saveExtractionBudget } from '../extraction/budget'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

const params = z.object({ spaceId: z.uuid() })
const forbidden = jsonResponse('没有权限', ErrorResponse)
// 口令派生同时只跑一个、排队有上限、每个账号同时最多一个：满了就是这个
const busy = jsonResponse('导出导入正忙，稍后再试', ErrorResponse)

const read = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/domain-layers',
  tags: ['console'],
  summary: '空间的 domain 默认层：管理界面新建记忆时按 domain 带出层',
  request: { params },
  responses: { 200: jsonResponse('默认层', DomainLayers), 403: forbidden },
})

const save = createRoute({
  method: 'put',
  path: '/spaces/{spaceId}/domain-layers',
  tags: ['console'],
  summary: '修改空间的 domain 默认层（只有空间 owner）',
  request: { params, body: jsonBody(DomainLayers) },
  responses: {
    200: jsonResponse('已保存', DomainLayers),
    400: jsonResponse('请求不合法', ErrorResponse),
    403: forbidden,
  },
})

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

const members = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/members',
  tags: ['console'],
  summary: '空间成员：名字与角色（转移应用时选新主人用）',
  request: { params },
  responses: { 200: jsonResponse('成员列表', z.array(MemberInfo)), 403: forbidden },
})

const exportRoute = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/export',
  tags: ['console'],
  summary:
    '导出这个空间（只有空间 owner）：共享的内容加上自己的画像、私人层与凭据，用口令加密成一个文件，可以导入到另一个实例的新空间',
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

// 整个检查或导入占一个名额（见 transferGate.ts），做完才放；先占名额再读表单，排着队的请求不先把文件读进内存
const transferSlot = createMiddleware<AppEnv>(async (c, next) => {
  const release = await acquireTransferSlot(c.get('console').accountId, c.req.raw.signal)
  try {
    await next()
  } finally {
    release()
  }
})

// 上传导出文件的两个接口共用：先确认是实例管理员、再占名额、看大小，最后才读表单，别人上传的大文件不读进内存。
// 上限按文件算，表单里的口令、名字与分隔行另外留一点余量
function uploadMiddleware(deps: Deps): MiddlewareHandler<AppEnv>[] {
  return [
    requireInstanceAdmin(deps, '只有实例管理员能导入空间'),
    transferSlot,
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
      '把导出文件导入成一个新空间（只有实例管理员），导入人是新空间的 owner，导出人的画像层、私人层与凭据都归导入人；Key 不在文件里，要重新签发',
    middleware: uploadMiddleware(deps),
    request: {
      body: { required: true, content: { 'multipart/form-data': { schema: SpaceImportForm } } },
    },
    responses: { 201: jsonResponse('已导入', SpaceImportResult), ...uploadErrors },
  })
}

// 导出的文件发完才放掉名额：文件攒在内存里，要等发给浏览器之后才释放。发送途中客户端断开时响应流被取消，也放掉
function releasingBody(file: Uint8Array, release: () => void): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(file)
        return
      }
      controller.close()
      release()
    },
    cancel() {
      release()
    },
  })
}

// 下载的文件名：空间名加导出时间（UTC）。空间名里放不进文件名的字符换成 _，另给一个只有 ASCII 的备用名
function attachment(spaceName: string, createdAt: string): string {
  const stamp = createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const safe = spaceName.replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, '_').trim() || 'space'
  const fallback = `kioku-space-${stamp}.kioku-space`
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(`${safe}-${stamp}.kioku-space`)}`
}

// 空间级的设置。spaces 是身份表，不在 RLS 里，按成员关系自己检查权限
export function spaceRoutes(deps: Deps) {
  return router()
    .openapi(exportRoute, async (c) => {
      const { spaceId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      const role = await memberRole(deps, spaceId, accountId)
      if (!role) return c.json({ error: '不是该空间成员' }, 403)
      // 文件里有 secret 与托管的凭据值，和读写它们一样只给空间 owner
      if (role !== 'owner') return c.json({ error: '只有空间 owner 能导出空间' }, 403)
      // 整个导出占一个名额，文件发完才放（见 releasingBody）
      const signal = c.req.raw.signal
      const release = await acquireTransferSlot(accountId, signal)
      let exported
      try {
        exported = await exportSpace(deps.db, deps.masterKey, {
          spaceId,
          accountId,
          passphrase: c.req.valid('json').passphrase,
        })
      } catch (err) {
        release()
        throw err
      }
      // 客户端在导出期间就断开了的，node 的服务端既不读这个响应流、也不取消它，名额不会经响应流放掉：
      // 已经断开的在这里放，之后断开的在断开时放
      if (signal.aborted) release()
      else signal.addEventListener('abort', release, { once: true })
      return c.body(releasingBody(exported.file, release), 200, {
        'content-type': 'application/octet-stream',
        'content-length': String(exported.file.length),
        'content-disposition': attachment(exported.spaceName, exported.createdAt),
        'cache-control': 'no-store',
      })
    })
    .openapi(inspectRoute(deps), async (c) => {
      const form = c.req.valid('form')
      const preview = await inspectSpaceImport(deps.masterKey, {
        file: Buffer.from(await form.file.arrayBuffer()),
        passphrase: form.passphrase,
      })
      return c.json(preview, 200)
    })
    .openapi(importRoute(deps), async (c) => {
      const form = c.req.valid('form')
      const result = await importSpace(deps.db, deps.masterKey, {
        accountId: c.get('console').accountId,
        file: Buffer.from(await form.file.arrayBuffer()),
        passphrase: form.passphrase,
        name: form.name,
      })
      // 向量不在文件里，按这个实例的嵌入设置重新生成
      void deps.jobs?.enqueueBackfill()
      return c.json(result, 201)
    })
    .openapi(members, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await memberRole(deps, spaceId, c.get('console').accountId))) {
        return c.json({ error: '不是该空间成员' }, 403)
      }
      const rows = await deps.db
        .select({
          accountId: accounts.id,
          username: accounts.username,
          displayName: accounts.displayName,
          role: spaceMembers.role,
        })
        .from(spaceMembers)
        .innerJoin(accounts, eq(accounts.id, spaceMembers.accountId))
        .where(eq(spaceMembers.spaceId, spaceId))
        .orderBy(asc(spaceMembers.createdAt))
      return c.json(rows, 200)
    })
    .openapi(budget, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await memberRole(deps, spaceId, c.get('console').accountId))) {
        return c.json({ error: '不是该空间成员' }, 403)
      }
      return c.json(await extractionUsage(deps.db, spaceId), 200)
    })
    .openapi(saveBudget, async (c) => {
      const { spaceId } = c.req.valid('param')
      // 预算管的是花钱的事，和 domain 默认层一样只有空间 owner 能改
      if ((await memberRole(deps, spaceId, c.get('console').accountId)) !== 'owner') {
        return c.json({ error: '只有空间 owner 能改抽取预算' }, 403)
      }
      await saveExtractionBudget(deps.db, spaceId, c.req.valid('json'))
      return c.json(await extractionUsage(deps.db, spaceId), 200)
    })
    .openapi(read, async (c) => {
      const { spaceId } = c.req.valid('param')
      if (!(await memberRole(deps, spaceId, c.get('console').accountId))) {
        return c.json({ error: '不是该空间成员' }, 403)
      }
      const [row] = await deps.db
        .select({ domainLayers: spaces.domainLayers })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
      return c.json({ defaults: row?.domainLayers ?? {} }, 200)
    })
    .openapi(save, async (c) => {
      const { spaceId } = c.req.valid('param')
      if ((await memberRole(deps, spaceId, c.get('console').accountId)) !== 'owner') {
        return c.json({ error: '只有空间 owner 能改 domain 默认层' }, 403)
      }
      const { defaults } = c.req.valid('json')
      await deps.db.update(spaces).set({ domainLayers: defaults }).where(eq(spaces.id, spaceId))
      return c.json({ defaults }, 200)
    })
}
