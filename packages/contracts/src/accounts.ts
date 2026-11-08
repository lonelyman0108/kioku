import { z } from 'zod'

import { Password, SpaceSummary, Username } from './auth'

const DisplayName = z.string().trim().min(1, '请填写显示名').max(64, '显示名不超过 64 个字符')

// 一次性链接的用途：新账号设置密码，或者管理员给已有账号重置密码。用法相同，只是说法不同
export const ACCOUNT_LINK_PURPOSES = ['setup', 'reset'] as const
export const AccountLinkPurpose = z.enum(ACCOUNT_LINK_PURPOSES)
export type AccountLinkPurpose = z.infer<typeof AccountLinkPurpose>

// 一次性链接 24 小时有效
export const ACCOUNT_LINK_TTL_HOURS = 24

// 令牌只在生成时返回这一次，界面拼成 /password/<令牌> 的地址
export const AccountLink = z.object({
  token: z.string(),
  purpose: AccountLinkPurpose,
  expiresAt: z.string(),
})
export type AccountLink = z.infer<typeof AccountLink>

// 实例管理员看到的账号
export const AdminAccount = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
  // 设过密码没有：新建的账号用链接设置之前为 false
  passwordSet: z.boolean(),
  disabledAt: z.string().nullable(),
  createdAt: z.string(),
  // 现有会话里最近的一次活动；没有会话时为 null
  lastActiveAt: z.string().nullable(),
  // soleActiveOwner：他是不是这个空间唯一没停用的所有者。停用他之后空间里没有能管理它的人，
  // 停用前据此提醒（停用照样允许，重新启用后恢复）
  spaces: z.array(SpaceSummary.extend({ soleActiveOwner: z.boolean() })),
  // 还没用过、没过期的链接（令牌不再给出）
  pendingLink: z.object({ purpose: AccountLinkPurpose, expiresAt: z.string() }).nullable(),
})
export type AdminAccount = z.infer<typeof AdminAccount>

export const AdminAccountList = z.object({ accounts: z.array(AdminAccount) })
export type AdminAccountList = z.infer<typeof AdminAccountList>

export const CreateAccountRequest = z.object({
  username: Username,
  displayName: DisplayName,
  isAdmin: z.boolean().default(false),
})
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>

export const CreatedAccount = z.object({ account: AdminAccount, link: AccountLink })
export type CreatedAccount = z.infer<typeof CreatedAccount>

// 不能改自己的管理员身份与停用状态
export const UpdateAccountRequest = z.object({
  displayName: DisplayName.optional(),
  isAdmin: z.boolean().optional(),
  disabled: z.boolean().optional(),
})
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>

// 令牌放在请求体里，不放进接口的路径：路径会进访问日志
const LinkToken = z.string().min(1).max(128)

export const PasswordLinkRequest = z.object({ token: LinkToken })
export type PasswordLinkRequest = z.infer<typeof PasswordLinkRequest>

export const PasswordLinkInfo = z.object({
  username: z.string(),
  displayName: z.string(),
  purpose: AccountLinkPurpose,
  expiresAt: z.string(),
})
export type PasswordLinkInfo = z.infer<typeof PasswordLinkInfo>

export const SetPasswordRequest = z.object({ token: LinkToken, password: Password })
export type SetPasswordRequest = z.infer<typeof SetPasswordRequest>

export const UpdateProfileRequest = z.object({ displayName: DisplayName })
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().max(256),
  newPassword: Password,
})
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>

// 登录设备：一个会话一行
export const LoginSession = z.object({
  id: z.uuid(),
  current: z.boolean(),
  clientAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
})
export type LoginSession = z.infer<typeof LoginSession>

export const LoginSessionList = z.object({ sessions: z.array(LoginSession) })
export type LoginSessionList = z.infer<typeof LoginSessionList>
