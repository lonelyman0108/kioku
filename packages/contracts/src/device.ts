import { z } from 'zod'

import {
  ClientInfo,
  LensKeyScopes,
  LINKED_CIRCLES_MAX,
  LinkedCircleGrant,
  RuntimeFamily,
  Slug,
} from './auth'
import { WhenCondition } from './facets'

// 浏览器授权：命令行发起授权申请，成员在管理界面选择主场圈、关联客场圈、在场切面并确认签发
export const DEVICE_GRANT_TTL_SECONDS = 600
export const DEVICE_POLL_INTERVAL_SECONDS = 3

export const DEVICE_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
export const DEVICE_USER_CODE_LENGTH = 8

export const DeviceUserCode = z
  .string()
  .max(64)
  .transform((value) => value.replace(/[\s-]/g, '').toUpperCase())
  .pipe(
    z
      .string()
      .regex(
        new RegExp(`^[${DEVICE_USER_CODE_ALPHABET}]{${DEVICE_USER_CODE_LENGTH}}$`),
        '确认码是 8 个字母',
      ),
  )

export function formatDeviceUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

const DeviceClientName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, '不能包含控制字符')

export const DEVICE_MAX_PLATFORMS = 8

export const DevicePlatform = z.object({
  runtimeFamily: RuntimeFamily,
  clientName: DeviceClientName.optional(),
})
export type DevicePlatform = z.infer<typeof DevicePlatform>

export const DeviceAuthorizeRequest = z
  .object({
    runtimeFamily: RuntimeFamily.optional(),
    platforms: z.array(DevicePlatform).min(1).max(DEVICE_MAX_PLATFORMS).optional(),
    clientName: DeviceClientName.optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.runtimeFamily === undefined) === (value.platforms === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'runtimeFamily 与 platforms 二选一' })
      return
    }
    const seen = new Set<string>()
    for (const [index, platform] of (value.platforms ?? []).entries()) {
      if (seen.has(platform.runtimeFamily)) {
        ctx.addIssue({
          code: 'custom',
          path: ['platforms', index, 'runtimeFamily'],
          message: '运行时不能重复',
        })
      }
      seen.add(platform.runtimeFamily)
    }
  })
export type DeviceAuthorizeRequest = z.infer<typeof DeviceAuthorizeRequest>

export const DeviceAuthorization = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationPath: z.string(),
  expiresIn: z.number().int(),
  interval: z.number().int(),
})
export type DeviceAuthorization = z.infer<typeof DeviceAuthorization>

export const DeviceTokenRequest = z.object({ deviceCode: z.string().min(1).max(128) })
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequest>

const DeviceKeyClient = z.object({ slug: z.string(), name: z.string(), runtimeFamily: z.string() })

export const DEVICE_KEY_DENIALS = {
  member: '确认人已不在记忆圈或已停用',
  role: '超出确认人当前可签发的范围',
  linked: '关联客场圈已失效或超出写入权限',
  client: '接入实例已不存在或已转给他人',
} as const
export type DeviceKeyDenial = (typeof DEVICE_KEY_DENIALS)[keyof typeof DEVICE_KEY_DENIALS]

export const DeviceIssuedKey = z.discriminatedUnion('status', [
  z.object({
    runtimeFamily: RuntimeFamily,
    status: z.literal('issued'),
    key: z.string(),
    client: DeviceKeyClient,
  }),
  z.object({ runtimeFamily: RuntimeFamily, status: z.literal('skipped') }),
  z.object({
    runtimeFamily: RuntimeFamily,
    status: z.literal('denied'),
    reason: z.enum(Object.values(DEVICE_KEY_DENIALS)),
  }),
])
export type DeviceIssuedKey = z.infer<typeof DeviceIssuedKey>

export const DeviceTokenResponse = z.union([
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('approved'), key: z.string(), client: DeviceKeyClient }),
  z.object({ status: z.literal('approved'), keys: z.array(DeviceIssuedKey) }),
])
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponse>

export const DeviceGrantLookup = z.object({ userCode: DeviceUserCode })
export type DeviceGrantLookup = z.infer<typeof DeviceGrantLookup>

export const DeviceGrantInfo = z.object({
  platforms: z.array(z.object({ runtimeFamily: RuntimeFamily, clientName: z.string().nullable() })),
  clientName: z.string().nullable(),
  clientAddress: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
})
export type DeviceGrantInfo = z.infer<typeof DeviceGrantInfo>

export const DeviceGrantItem = z.union([
  z.object({ runtimeFamily: RuntimeFamily, skip: z.literal(true) }),
  z.object({
    runtimeFamily: RuntimeFamily,
    client: z.union([
      z.object({ id: z.uuid() }),
      z.object({ slug: Slug, name: z.string().min(1).max(64) }),
    ]),
    keyName: z.string().min(1).max(64),
    scopes: LensKeyScopes,
    contextFacets: WhenCondition.optional(),
  }),
])
export type DeviceGrantItem = z.infer<typeof DeviceGrantItem>

export const DeviceGrantApprove = z.object({
  userCode: DeviceUserCode,
  circleId: z.uuid(),
  linkedCircles: z
    .array(LinkedCircleGrant)
    .max(LINKED_CIRCLES_MAX)
    .default([])
    .refine(
      (list) => new Set(list.map((i) => i.circleId)).size === list.length,
      '关联记忆圈不能重复',
    ),
  contextFacets: WhenCondition.default({}),
  items: z.array(DeviceGrantItem).min(1).max(DEVICE_MAX_PLATFORMS),
})
export type DeviceGrantApprove = z.infer<typeof DeviceGrantApprove>

export const DeviceGrantApproved = z.object({
  items: z.array(
    z.object({ runtimeFamily: RuntimeFamily, client: ClientInfo, keyName: z.string() }),
  ),
})
export type DeviceGrantApproved = z.infer<typeof DeviceGrantApproved>

export const DeviceGrantProblem = z.object({
  error: z.string(),
  runtimeFamily: RuntimeFamily.optional(),
})
export type DeviceGrantProblem = z.infer<typeof DeviceGrantProblem>

export const DeviceGrantDeny = z.object({ userCode: DeviceUserCode })
export type DeviceGrantDeny = z.infer<typeof DeviceGrantDeny>
