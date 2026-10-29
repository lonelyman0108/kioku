import { createRoute } from '@hono/zod-openapi'
import {
  BindCode,
  BindCodeRequest,
  BindRequest,
  BindResult,
  ErrorResponse,
  VoidBindCodeRequest,
} from '@kioku/contracts'

import {
  CODE_TTL_SECONDS,
  canBindWithKey,
  issueCode,
  normalizeCode,
  redeemCode,
  refundAttempt,
  reserveAttempt,
  voidCode,
  type AttemptLimit,
} from '../access/binding'
import { resolveKeySession } from '../access/session'
import { enqueueMerged, isLockBusy } from '../access/subjects'
import { requireKey } from '../auth/middleware'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

// 验证码自助绑定的接入方接口（见 access/binding.ts）。插件把这里的错误原样回复给发命令的人，所以说法要短

const security = [{ bearer: [] }]
const BUSY = '正忙，请稍后再试'
const NOT_ALLOWED = '这个 bot 的 Key 写不了对象层，不能绑定账号'

const codeRoute = createRoute({
  method: 'post',
  path: '/bind/code',
  tags: ['binding'],
  summary:
    '在私聊里申请绑定码：8 位、10 分钟有效、只能用一次，同一个人再申请时旧码作废。到另一个平台的私聊里用它，把那边的账号并进这个人',
  security,
  request: { body: jsonBody(BindCodeRequest) },
  responses: {
    200: jsonResponse('绑定码', BindCode),
    400: jsonResponse('不是私聊', ErrorResponse),
    401: jsonResponse('Key 无效', ErrorResponse),
    403: jsonResponse('Key 写不了对象层', ErrorResponse),
    409: jsonResponse('正忙，稍后再试', ErrorResponse),
  },
})

const bindRoute = createRoute({
  method: 'post',
  path: '/bind',
  tags: ['binding'],
  summary:
    '在另一个平台的私聊里使用绑定码：先预览要并到谁那里，同一个账号预览过之后带上 confirm 再发才把这个平台账号的对象并进申请绑定码的对象。申请的对象标记了成员（这边没标记成同一个成员）时，还要那个成员在管理界面确认',
  security,
  request: { body: jsonBody(BindRequest) },
  responses: {
    200: jsonResponse('预览、已合并，或在等确认', BindResult),
    400: jsonResponse('不是私聊、码的格式不对，或者码不对、已失效', ErrorResponse),
    401: jsonResponse('Key 无效', ErrorResponse),
    403: jsonResponse('Key 写不了对象层，或者这个账号标记成了别的成员', ErrorResponse),
    409: jsonResponse('已经是同一个人，或者正忙', ErrorResponse),
    429: jsonResponse('输错的次数太多', ErrorResponse),
  },
})

const voidRoute = createRoute({
  method: 'post',
  path: '/bind/void',
  tags: ['binding'],
  summary:
    '群里有人发了绑定码：把它作废，不合并。码存不存在、是否已经失效，结果都一样；按发言人计输错的次数，免得拿它试码',
  security,
  request: { body: jsonBody(VoidBindCodeRequest) },
  responses: {
    204: { description: '这个码（如果有的话）已经作废' },
    400: jsonResponse('不是群聊，或者没带发言人', ErrorResponse),
    401: jsonResponse('Key 无效', ErrorResponse),
    403: jsonResponse('Key 写不了对象层', ErrorResponse),
    429: jsonResponse('输错的次数太多', ErrorResponse),
  },
})

// 超了上限时的提示只看计数，不看码：不透露发来的码存不存在
function limitMessage(limit: AttemptLimit): string {
  const minutes = Math.max(1, Math.ceil(limit.waitSeconds / 60))
  return limit.scope === 'account'
    ? `输错的次数太多了，${minutes} 分钟后再试`
    : `最近输错绑定码的太多，${minutes} 分钟后再试`
}

export function bindingRoutes(deps: Deps) {
  const app = router()
  for (const path of ['/bind', '/bind/code', '/bind/void']) app.use(path, requireKey(deps))
  return app
    .openapi(codeRoute, async (c) => {
      const key = c.get('key')
      const { context } = c.req.valid('json')
      // 群里不发码：码会被群里的人看到
      if (context.chatType !== 'direct') return c.json({ error: '只能在私聊里申请绑定码' }, 400)
      if (!canBindWithKey(key)) return c.json({ error: NOT_ALLOWED }, 403)
      const session = await resolveKeySession(deps, key, context)
      // 契约保证私聊带着平台与发言人
      const issued = await issueCode(
        deps.db,
        deps.masterKey,
        key,
        session,
        context.platform!,
        context.sender!.id,
      ).catch((err: unknown) => {
        if (isLockBusy(err)) return null
        throw err
      })
      if (!issued) return c.json({ error: BUSY }, 409)
      return c.json(
        {
          code: issued.code,
          expiresAt: issued.expiresAt.toISOString(),
          expiresInSeconds: CODE_TTL_SECONDS,
        },
        200,
      )
    })
    .openapi(bindRoute, async (c) => {
      const key = c.get('key')
      const body = c.req.valid('json')
      const { context } = body
      // 群里不收码：发在群里的码大家都看得到，谁都能抢先用（插件会把它作废）
      if (context.chatType !== 'direct') return c.json({ error: '只能在私聊里绑定' }, 400)
      if (!canBindWithKey(key)) return c.json({ error: NOT_ALLOWED }, 403)
      // 格式不对的不可能是哪个码，不算输错
      const code = normalizeCode(body.code)
      if (!code) return c.json({ error: '绑定码是 8 位字母和数字' }, 400)
      const platform = context.platform!
      const sender = context.sender!
      const limit = await reserveAttempt(deps.db, key, platform, sender.id)
      if (limit) {
        c.header('Retry-After', String(limit.waitSeconds))
        return c.json({ error: limitMessage(limit) }, 429)
      }
      const session = await resolveKeySession(deps, key, context)
      const redeemer = {
        platform,
        externalId: sender.id,
        displayName: session.subjects.find((s) => s.role === 'sender')?.name ?? null,
      }
      const result = await redeemCode(
        deps.db,
        deps.masterKey,
        key,
        session,
        code,
        redeemer,
        body.confirm,
      ).catch((err: unknown) => {
        if (isLockBusy(err)) return { kind: 'busy' as const }
        throw err
      })
      // 只有码不对才算输错，别的结果都退回这一次的名额。绑定已经提交时，退回失败只记日志、照样返回成功
      if (result.kind !== 'invalid') {
        await refundAttempt(deps.db, key, platform, sender.id).catch((err: unknown) => {
          console.error('退回绑定码的输错名额失败', err)
        })
      }
      switch (result.kind) {
        case 'preview':
          return c.json(
            {
              status: 'preview' as const,
              target: result.target,
              needsApproval: result.needsApproval,
              expiresAt: null,
            },
            200,
          )
        case 'merged':
          await enqueueMerged(deps, key.spaceId, result.outcome)
          return c.json({ status: 'merged' as const, needsApproval: false, expiresAt: null }, 200)
        case 'pending':
          return c.json(
            {
              status: 'pending' as const,
              needsApproval: true,
              expiresAt: result.expiresAt.toISOString(),
            },
            200,
          )
        case 'invalid':
          return c.json({ error: '绑定码不对或已经失效，请重新申请' }, 400)
        case 'same':
          return c.json({ error: '这个账号和申请绑定码的账号已经是同一个人了' }, 409)
        case 'linked':
          return c.json(
            {
              error: result.issuerLinked
                ? '两个账号标记成了不同的成员，不能绑在一起'
                : '这个账号标记成了空间里的成员，不能并到别的账号里；可以反过来，用这个账号申请绑定码',
            },
            403,
          )
        case 'kind':
          return c.json({ error: '只能绑定人的账号' }, 400)
        case 'busy':
          return c.json({ error: BUSY }, 409)
      }
    })
    .openapi(voidRoute, async (c) => {
      const key = c.get('key')
      const body = c.req.valid('json')
      const { context } = body
      if (context.chatType !== 'group' && context.chatType !== 'channel') {
        return c.json({ error: '只作废在群里发出来的绑定码' }, 400)
      }
      // 按发言人计次数：不带发言人就没法拦住拿它试码
      if (!context.sender) return c.json({ error: '要带上这条消息的发言人' }, 400)
      if (!canBindWithKey(key)) return c.json({ error: NOT_ALLOWED }, 403)
      // 格式不对的不可能是哪个码，什么都不用做
      const code = normalizeCode(body.code)
      if (!code) return c.body(null, 204)
      // 每次都算一次：作废了一个真的码也不退，免得能从计数看出码存不存在
      const limit = await reserveAttempt(deps.db, key, context.platform!, context.sender.id)
      if (limit) {
        c.header('Retry-After', String(limit.waitSeconds))
        return c.json({ error: limitMessage(limit) }, 429)
      }
      await voidCode(deps.db, deps.masterKey, key, code)
      return c.body(null, 204)
    })
}
