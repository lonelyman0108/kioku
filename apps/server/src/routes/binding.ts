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
  reserveVoid,
  voidCode,
  type AttemptLimit,
  type RedeemResult,
} from '../access/binding'
import { resolveKeySession } from '../access/session'
import { enqueueMerged, isLockBusy } from '../access/subjects'
import { requireKey } from '../auth/middleware'
import { loggableError } from '../db/client'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'

// 验证码自助绑定的接入方接口（见 access/binding.ts）。插件把这里的错误原样回复给发命令的人，所以说法要短

const security = [{ bearer: [] }]
const BUSY = '服务繁忙，请稍后重试'
const NOT_ALLOWED = '当前 bot 的 Key 无权写入联系人层，无法绑定账号'

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
    '群里有人发了绑定码：把它作废，不合并。码存不存在、是否已经失效，结果都一样；不占输错的次数，只按发言人限制请求的次数',
  security,
  request: { body: jsonBody(VoidBindCodeRequest) },
  responses: {
    204: { description: '这个码（如果有的话）已经作废' },
    400: jsonResponse('不是群聊，或者没带发言人', ErrorResponse),
    401: jsonResponse('Key 无效', ErrorResponse),
    403: jsonResponse('Key 写不了对象层', ErrorResponse),
    429: jsonResponse('请求太多', ErrorResponse),
  },
})

const LIMIT_MESSAGES: Record<AttemptLimit['scope'], string> = {
  account: '输错次数过多',
  app: '近期输错绑定码的次数过多',
  void: '作废请求过多',
}

// 占一次名额。超了时设好 Retry-After，返回给人看的提示，调用方拿它回 429；没超时为 null。
// 提示只看计数，不看码：不透露发来的码存不存在
async function overLimit(
  c: { header: (name: string, value: string) => void },
  reserve: Promise<AttemptLimit | null>,
): Promise<string | null> {
  const limit = await reserve
  if (!limit) return null
  c.header('Retry-After', String(limit.waitSeconds))
  const minutes = Math.max(1, Math.ceil(limit.waitSeconds / 60))
  return `${LIMIT_MESSAGES[limit.scope]}，请 ${minutes} 分钟后重试`
}

export function bindingRoutes(deps: Deps) {
  const app = router()
  for (const path of ['/bind', '/bind/code', '/bind/void']) app.use(path, requireKey(deps))
  return app
    .openapi(codeRoute, async (c) => {
      const key = c.get('key')
      const { context } = c.req.valid('json')
      // 群里不发码：码会被群里的人看到
      if (context.chatType !== 'direct') return c.json({ error: '只能在私聊中申请绑定码' }, 400)
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
      if (context.chatType !== 'direct') return c.json({ error: '只能在私聊中绑定' }, 400)
      if (!canBindWithKey(key)) return c.json({ error: NOT_ALLOWED }, 403)
      // 格式不对的不可能是哪个码，不算输错
      const code = normalizeCode(body.code)
      if (!code) return c.json({ error: '绑定码由 8 位字母和数字组成' }, 400)
      const platform = context.platform!
      const sender = context.sender!
      const tooMany = await overLimit(c, reserveAttempt(deps.db, key, platform, sender.id))
      if (tooMany) return c.json({ error: tooMany }, 429)
      // 只有码对不上任何一条记录才算输错：别的结果（码对得上、只是已经失效，预览、绑成了或因为别的原因没绑成，
      // 以及中途出错）都在 finally 里退回这一次的名额。绑定已经提交时，退回失败只记日志、照样返回成功
      let wrong = false
      let result: RedeemResult
      try {
        const session = await resolveKeySession(deps, key, context)
        const redeemer = {
          platform,
          externalId: sender.id,
          displayName: session.subjects.find((s) => s.role === 'sender')?.name ?? null,
        }
        result = await redeemCode(
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
        wrong = result.kind === 'invalid' && result.wrong
      } finally {
        if (!wrong) {
          await refundAttempt(deps.db, key, platform, sender.id).catch((err: unknown) => {
            console.error('退回绑定码的输错名额失败', loggableError(err))
          })
        }
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
          return c.json({ error: '绑定码错误或已失效，请重新申请' }, 400)
        case 'same':
          return c.json({ error: '此账号与申请绑定码的账号已是同一个人' }, 409)
        case 'linked':
          return c.json(
            {
              error: result.issuerLinked
                ? '两个账号已标记为不同成员，无法绑定'
                : '此账号已标记为空间成员，无法合并到其他账号。可改用此账号申请绑定码。',
            },
            403,
          )
        case 'kind':
          return c.json({ error: '只能绑定个人账号' }, 400)
        case 'busy':
          return c.json({ error: BUSY }, 409)
      }
    })
    .openapi(voidRoute, async (c) => {
      const key = c.get('key')
      const body = c.req.valid('json')
      const { context } = body
      if (context.chatType !== 'group' && context.chatType !== 'channel') {
        return c.json({ error: '只作废群里发出的绑定码' }, 400)
      }
      // 按发言人计次数：不带发言人就没法拦住拿它试码
      if (!context.sender) return c.json({ error: '须带上这条消息的发言人' }, 400)
      if (!canBindWithKey(key)) return c.json({ error: NOT_ALLOWED }, 403)
      // 格式不对的不可能是哪个码，什么都不用做
      const code = normalizeCode(body.code)
      if (!code) return c.body(null, 204)
      // 不占输错的名额（结果总是一样，探不出码），只按发言人限制请求的次数，免得在群里刷命令
      const tooMany = await overLimit(
        c,
        reserveVoid(deps.db, key, context.platform!, context.sender.id),
      )
      if (tooMany) return c.json({ error: tooMany }, 429)
      await voidCode(deps.db, deps.masterKey, key, code)
      return c.body(null, 204)
    })
}
