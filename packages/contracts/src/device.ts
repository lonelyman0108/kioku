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

// 命令行自报的名字（机器名、平台的配置名这类），只在确认页显示，不可信：单行、不含控制字符
const DeviceClientName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, '不能包含控制字符')

// 一次申请最多带几个平台
export const DEVICE_MAX_PLATFORMS = 8

export const DevicePlatform = z.object({
  runtimeFamily: RuntimeFamily,
  // 这个平台自报的名字（例如配置目录），可选
  clientName: DeviceClientName.optional(),
})
export type DevicePlatform = z.infer<typeof DevicePlatform>

// 申请有两种写法，二选一：
// - 单个平台：runtimeFamily（早期的命令行只会这样发），取走时得到一个访问密钥
// - 几个平台：platforms，浏览器里确认一次，取走时每个平台各得一项结果
// clientName 是这台机器的名字（主机名这类）
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

const DeviceKeyApp = z.object({ slug: z.string(), name: z.string(), runtimeFamily: z.string() })

// 取走时某个平台没签发的原因：固定的几类文字，不带内部细节
export const DEVICE_KEY_DENIALS = {
  member: '确认人已不在空间或已停用',
  role: '超出确认人当前可签发的范围',
  app: '应用已不存在或已转给他人',
} as const
export type DeviceKeyDenial = (typeof DEVICE_KEY_DENIALS)[keyof typeof DEVICE_KEY_DENIALS]

// 几个平台的申请取走时，每个平台一项，顺序和申请的一样：
// issued 签发了；skipped 确认人没有勾选；denied 取走时照签发规则再核对没过
export const DeviceIssuedKey = z.discriminatedUnion('status', [
  z.object({
    runtimeFamily: RuntimeFamily,
    status: z.literal('issued'),
    key: z.string(),
    app: DeviceKeyApp,
  }),
  z.object({ runtimeFamily: RuntimeFamily, status: z.literal('skipped') }),
  z.object({
    runtimeFamily: RuntimeFamily,
    status: z.literal('denied'),
    reason: z.enum(Object.values(DEVICE_KEY_DENIALS)),
  }),
])
export type DeviceIssuedKey = z.infer<typeof DeviceIssuedKey>

// 轮询的结果。approved 只出现一次：访问密钥在这一刻才生成，之后这条申请就没有了。
// 单个平台的申请得到 key 与 app，几个平台的得到 keys
export const DeviceTokenResponse = z.union([
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('denied') }),
  // 过期、已经取走、设备码不对都是它
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('approved'), key: z.string(), app: DeviceKeyApp }),
  z.object({ status: z.literal('approved'), keys: z.array(DeviceIssuedKey) }),
])
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponse>

export const DeviceGrantLookup = z.object({ userCode: DeviceUserCode })
export type DeviceGrantLookup = z.infer<typeof DeviceGrantLookup>

// 确认页上显示的申请。单个平台的申请也规整成一项
export const DeviceGrantInfo = z.object({
  platforms: z.array(z.object({ runtimeFamily: RuntimeFamily, clientName: z.string().nullable() })),
  // 这台机器自报的名字
  clientName: z.string().nullable(),
  // 申请是从哪个地址发来的；取不到时为 null
  clientAddress: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
})
export type DeviceGrantInfo = z.infer<typeof DeviceGrantInfo>

// 确认时每个平台一项：用确认人自己的一个应用，或者新建一个（运行时取这一项的）；skip 表示这个平台不签发
export const DeviceGrantItem = z.union([
  z.object({ runtimeFamily: RuntimeFamily, skip: z.literal(true) }),
  z.object({
    runtimeFamily: RuntimeFamily,
    app: z.union([
      z.object({ id: z.uuid() }),
      z.object({ slug: Slug, name: z.string().min(1).max(64) }),
    ]),
    keyName: z.string().min(1).max(64),
    scopes: KeyScopes,
  }),
])
export type DeviceGrantItem = z.infer<typeof DeviceGrantItem>

// 申请里的每个平台恰好一项、至少一项不跳过，由服务端对着申请核对
export const DeviceGrantApprove = z.object({
  userCode: DeviceUserCode,
  spaceId: z.uuid(),
  items: z.array(DeviceGrantItem).min(1).max(DEVICE_MAX_PLATFORMS),
})
export type DeviceGrantApprove = z.infer<typeof DeviceGrantApprove>

// 确认的结果：签发的那几项各用哪个应用
export const DeviceGrantApproved = z.object({
  items: z.array(z.object({ runtimeFamily: RuntimeFamily, app: AppInfo, keyName: z.string() })),
})
export type DeviceGrantApproved = z.infer<typeof DeviceGrantApproved>

// 确认失败时的说明；只关于某一个平台时带上它的运行时（例如新建应用的标识被占用）
export const DeviceGrantProblem = z.object({
  error: z.string(),
  runtimeFamily: RuntimeFamily.optional(),
})
export type DeviceGrantProblem = z.infer<typeof DeviceGrantProblem>

export const DeviceGrantDeny = z.object({ userCode: DeviceUserCode })
export type DeviceGrantDeny = z.infer<typeof DeviceGrantDeny>
