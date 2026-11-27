import { z } from 'zod'

import { AllowedRealms, CompatRuntimeFamily, KeyName, RuntimeFamily } from './auth'
import { SceneSlugList } from './entries'

// 浏览器设备授权：命令行发起申请，在管理界面一键确认并按终端透镜签发访问密钥
export const DEVICE_GRANT_TTL_SECONDS = 600
export const DEVICE_POLL_INTERVAL_SECONDS = 3

export const DEVICE_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
export const DEVICE_USER_CODE_LENGTH = 8
export const DEVICE_MAX_PLATFORMS = 8

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

export const DevicePlatform = z.object({
  runtimeFamily: CompatRuntimeFamily,
  clientName: DeviceClientName.optional(),
})
export type DevicePlatform = z.infer<typeof DevicePlatform>

export const DeviceAuthorizeRequest = z
  .object({
    runtimeFamily: CompatRuntimeFamily.optional(),
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

export const DeviceAuthorizeResponse = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationPath: z.string(),
  expiresIn: z.number().int(),
  interval: z.number().int(),
})
export type DeviceAuthorizeResponse = z.infer<typeof DeviceAuthorizeResponse>
export const DeviceAuthorization = DeviceAuthorizeResponse
export type DeviceAuthorization = DeviceAuthorizeResponse

export const DeviceTokenRequest = z.object({
  deviceCode: z.string().min(1).max(128),
})
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequest>

export const DeviceKeyClient = z.object({
  slug: z.string(),
  name: z.string(),
  runtimeFamily: z.string(),
})
export type DeviceKeyClient = z.infer<typeof DeviceKeyClient>

export const DeviceIssuedKey = z.discriminatedUnion('status', [
  z.object({
    runtimeFamily: RuntimeFamily,
    status: z.literal('issued'),
    key: z.string(),
    client: DeviceKeyClient,
  }),
  z.object({
    runtimeFamily: RuntimeFamily,
    status: z.literal('skipped'),
  }),
  z.object({
    runtimeFamily: RuntimeFamily,
    status: z.literal('denied'),
    reason: z.string(),
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

// ---- 管理界面授权审批接口 ----

export const DeviceGrantLookupRequest = z.object({ userCode: DeviceUserCode })
export type DeviceGrantLookupRequest = z.infer<typeof DeviceGrantLookupRequest>

export const DeviceGrantLookupResponse = z.object({
  platforms: z.array(
    z.object({
      runtimeFamily: RuntimeFamily,
      clientName: z.string().nullable(),
    }),
  ),
  clientName: z.string().nullable(),
  clientAddress: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
})
export type DeviceGrantLookupResponse = z.infer<typeof DeviceGrantLookupResponse>

export const DeviceGrantApproveItem = z.union([
  z.object({ runtimeFamily: CompatRuntimeFamily, skip: z.literal(true) }),
  z.object({
    runtimeFamily: CompatRuntimeFamily,
    keyName: KeyName,
    skip: z.literal(false).optional(),
  }),
])
export type DeviceGrantApproveItem = z.infer<typeof DeviceGrantApproveItem>

export const DeviceGrantApproveRequest = z.object({
  userCode: DeviceUserCode,
  envs: SceneSlugList.default([]),
  allowedRealms: AllowedRealms.nullable().default(null),
  focusRealms: AllowedRealms.nullable().optional(),
  canWrite: z.boolean().default(true),
  canResolveCredentials: z.boolean().default(false),
  items: z.array(DeviceGrantApproveItem).min(1).max(DEVICE_MAX_PLATFORMS),
})
export type DeviceGrantApproveRequest = z.infer<typeof DeviceGrantApproveRequest>

export const DeviceGrantApproveResponse = z.object({
  items: z.array(
    z.object({
      runtimeFamily: RuntimeFamily,
      keyName: z.string(),
    }),
  ),
})
export type DeviceGrantApproveResponse = z.infer<typeof DeviceGrantApproveResponse>

export const DeviceGrantDenyRequest = z.object({ userCode: DeviceUserCode })
export type DeviceGrantDenyRequest = z.infer<typeof DeviceGrantDenyRequest>
