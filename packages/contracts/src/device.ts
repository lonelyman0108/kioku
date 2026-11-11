import { z } from 'zod'

import { AppInfo, RuntimeFamily, Slug } from './auth'
import { KeyScopes } from './memory'

// 浏览器授权：命令行申请，登录了管理界面的成员在确认页输入确认码、选好空间与权限后确认，
// 命令行凭设备码取走一次访问密钥。命令行不用起本地端口，远程登录的机器上也能用

// 申请的有效期（秒）与命令行两次轮询之间至少隔多久（秒）
export const DEVICE_GRANT_TTL_SECONDS = 600
export const DEVICE_POLL_INTERVAL_SECONDS = 3

// 确认码用的字母：去掉元音（拼不出词）和容易看错的字母
export const DEVICE_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
export const DEVICE_USER_CODE_LENGTH = 8

// 确认码：输入时大小写、空格与连字符都不计较，规整成 8 个大写字母
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

// 显示用的写法：四个一组
export function formatDeviceUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

// 命令行自报的名字（机器名这类），只在确认页显示，不可信：单行、不含控制字符
const DeviceClientName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, '不能包含控制字符')

export const DeviceAuthorizeRequest = z.object({
  runtimeFamily: RuntimeFamily,
  clientName: DeviceClientName.optional(),
})
export type DeviceAuthorizeRequest = z.infer<typeof DeviceAuthorizeRequest>

export const DeviceAuthorization = z.object({
  // 只给命令行，取访问密钥用
  deviceCode: z.string(),
  // 给人看、在确认页输入
  userCode: z.string(),
  // 确认页在管理界面里的路径，命令行接在服务地址后面。确认码不放进地址：
  // 要在终端里看着它输入，别人发来的链接里带不了
  verificationPath: z.string(),
  expiresIn: z.number().int(),
  interval: z.number().int(),
})
export type DeviceAuthorization = z.infer<typeof DeviceAuthorization>

export const DeviceTokenRequest = z.object({ deviceCode: z.string().min(1).max(128) })
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequest>

// 轮询的结果。approved 只出现一次：访问密钥在这一刻才生成，之后这条申请就没有了
export const DeviceTokenResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('denied') }),
  // 过期、已经取走、设备码不对都是它
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('approved'),
    key: z.string(),
    app: z.object({ slug: z.string(), name: z.string(), runtimeFamily: z.string() }),
  }),
])
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponse>

export const DeviceGrantLookup = z.object({ userCode: DeviceUserCode })
export type DeviceGrantLookup = z.infer<typeof DeviceGrantLookup>

// 确认页上显示的申请
export const DeviceGrantInfo = z.object({
  runtimeFamily: RuntimeFamily,
  clientName: z.string().nullable(),
  // 申请是从哪个地址发来的；取不到时为 null
  clientAddress: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
})
export type DeviceGrantInfo = z.infer<typeof DeviceGrantInfo>

export const DeviceGrantApprove = z.object({
  userCode: DeviceUserCode,
  spaceId: z.uuid(),
  // 用确认人自己的一个应用，或者新建一个（运行时取申请里的）
  app: z.union([
    z.object({ id: z.uuid() }),
    z.object({ slug: Slug, name: z.string().min(1).max(64) }),
  ]),
  keyName: z.string().min(1).max(64),
  scopes: KeyScopes,
})
export type DeviceGrantApprove = z.infer<typeof DeviceGrantApprove>

export const DeviceGrantApproved = z.object({ app: AppInfo })
export type DeviceGrantApproved = z.infer<typeof DeviceGrantApproved>

export const DeviceGrantDeny = z.object({ userCode: DeviceUserCode })
export type DeviceGrantDeny = z.infer<typeof DeviceGrantDeny>
