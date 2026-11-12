import { z } from 'zod'

import { MemberInfo, SPACE_NAME_MAX } from './auth'
import { MemberRole } from './memory'

// 离开空间（被移除或自己离开）之后，本人记忆、凭据与密码库连接还留这么多天：期间重新加入就恢复，到期由保留期的清理删掉
export const DEPARTURE_RETENTION_DAYS = 30

export const SpaceName = z
  .string()
  .trim()
  .min(1, '请填写空间名')
  .max(SPACE_NAME_MAX, `空间名不超过 ${SPACE_NAME_MAX} 个字符`)

export const SpaceInfo = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.string(),
})
export type SpaceInfo = z.infer<typeof SpaceInfo>

// 空间概况：成员都能看。role 是当前账号在这个空间的角色
export const SpaceDetail = SpaceInfo.extend({
  role: MemberRole,
  memberCount: z.number().int(),
})
export type SpaceDetail = z.infer<typeof SpaceDetail>

// 新建空间：所有者是当前账号
export const CreateSpaceRequest = z.object({ name: SpaceName })
export type CreateSpaceRequest = z.infer<typeof CreateSpaceRequest>

export const CreatedSpace = SpaceInfo.extend({ ownerAccountId: z.uuid() })
export type CreatedSpace = z.infer<typeof CreatedSpace>

export const RenameSpaceRequest = z.object({ name: SpaceName })
export type RenameSpaceRequest = z.infer<typeof RenameSpaceRequest>

// 删除空间要带上现在的空间名，对不上不删
export const DeleteSpaceRequest = z.object({ confirmName: z.string().max(256) })
export type DeleteSpaceRequest = z.infer<typeof DeleteSpaceRequest>

// 空间数量上限：每个账号作为所有者的空间最多几个，整个实例一个数，实例管理员自己也受限。
// 新建、导入、接受转让、被加为或升为所有者都占名额；新账号自带的个人空间算一个。
// 调低之后已经超出的账号不受影响，只是不能再多拥有。默认值与上下限只写在这里
export const SPACE_LIMIT_DEFAULT = 5
export const SPACE_LIMIT_MIN = 1
export const SPACE_LIMIT_MAX = 100
export const MaxOwnedSpaces = z.number().int().min(SPACE_LIMIT_MIN).max(SPACE_LIMIT_MAX)
export const SpaceLimitPolicy = z.object({ maxOwnedSpaces: MaxOwnedSpaces })
export type SpaceLimitPolicy = z.infer<typeof SpaceLimitPolicy>
// ownedSpaces 是当前账号现在拥有几个，canCreate 是还能不能新建或导入
export const SpaceLimitView = SpaceLimitPolicy.extend({
  ownedSpaces: z.number().int(),
  canCreate: z.boolean(),
})
export type SpaceLimitView = z.infer<typeof SpaceLimitView>

export const AccountRef = z.object({
  accountId: z.uuid(),
  username: z.string(),
  displayName: z.string(),
})
export type AccountRef = z.infer<typeof AccountRef>

// 实例的空间列表（只给实例管理员）：不含任何内容数据
export const InstanceSpace = SpaceInfo.extend({
  owners: z.array(AccountRef),
  memberCount: z.number().int(),
})
export type InstanceSpace = z.infer<typeof InstanceSpace>

// 成员表的一行：加入时间与拥有的应用数。别人的本人记忆、凭据的数量都不给
export const SpaceMember = MemberInfo.extend({
  joinedAt: z.string(),
  appCount: z.number().int(),
})
export type SpaceMember = z.infer<typeof SpaceMember>

// 按用户名添加成员：精确匹配，不提供账号的列表与搜索
// 用户名只有小写（Username），输入先去首尾空白、转小写再精确匹配
export const AddMemberRequest = z.object({
  username: z.string().trim().toLowerCase().min(1, '请填写用户名').max(64),
  role: MemberRole,
})
export type AddMemberRequest = z.infer<typeof AddMemberRequest>

export const UpdateMemberRequest = z.object({ role: MemberRole })
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>

// 转让所有者：对方成为所有者，当前账号改为编辑者
export const TransferOwnershipRequest = z.object({ accountId: z.uuid() })
export type TransferOwnershipRequest = z.infer<typeof TransferOwnershipRequest>
