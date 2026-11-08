import { z } from 'zod'

import { MemberInfo } from './auth'
import { MemberRole } from './memory'

// 离开空间（被移除或自己离开）之后，本人记忆、凭据与密码库连接还留这么多天：期间重新加入就恢复，到期由保留期的清理删掉
export const DEPARTURE_RETENTION_DAYS = 30

export const SpaceName = z.string().trim().min(1, '请填写空间名').max(64, '空间名不超过 64 个字符')

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

// 新建空间：不给所有者时是当前账号；给别的账号只有实例管理员能做
export const CreateSpaceRequest = z.object({
  name: SpaceName,
  ownerAccountId: z.uuid().optional(),
})
export type CreateSpaceRequest = z.infer<typeof CreateSpaceRequest>

export const CreatedSpace = SpaceInfo.extend({ ownerAccountId: z.uuid() })
export type CreatedSpace = z.infer<typeof CreatedSpace>

export const RenameSpaceRequest = z.object({ name: SpaceName })
export type RenameSpaceRequest = z.infer<typeof RenameSpaceRequest>

// 删除空间要带上现在的空间名，对不上不删
export const DeleteSpaceRequest = z.object({ confirmName: z.string().max(256) })
export type DeleteSpaceRequest = z.infer<typeof DeleteSpaceRequest>

// 实例开关：成员能不能自己新建空间（实例管理员随时可以）。canCreate 是当前账号现在能不能新建
export const SpaceCreationPolicy = z.object({ membersCanCreate: z.boolean() })
export type SpaceCreationPolicy = z.infer<typeof SpaceCreationPolicy>
export const SpaceCreationView = SpaceCreationPolicy.extend({ canCreate: z.boolean() })
export type SpaceCreationView = z.infer<typeof SpaceCreationView>

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
export const AddMemberRequest = z.object({
  username: z.string().trim().min(1, '请填写用户名').max(64),
  role: MemberRole,
})
export type AddMemberRequest = z.infer<typeof AddMemberRequest>

export const UpdateMemberRequest = z.object({ role: MemberRole })
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>

// 转让所有者：对方成为所有者，当前账号改为编辑者
export const TransferOwnershipRequest = z.object({ accountId: z.uuid() })
export type TransferOwnershipRequest = z.infer<typeof TransferOwnershipRequest>
