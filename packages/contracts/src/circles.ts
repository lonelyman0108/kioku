import { z } from 'zod'

import { AccountRef, CIRCLE_NAME_MAX, MemberInfo, Slug } from './auth'
import { DefaultFacets } from './facets'
import { CircleKind, MemberRole } from './memory'

// 离开共享圈之后，成员在本圈留下的会话摘要、圈级凭据与密码库连接保留天数；
// 期间重新加入立即恢复，到期由清理任务硬删除
export const DEPARTURE_RETENTION_DAYS = 30

export const CircleName = z
  .string()
  .trim()
  .min(1, '请填写记忆圈名称')
  .max(CIRCLE_NAME_MAX, `记忆圈名称不超过 ${CIRCLE_NAME_MAX} 个字符`)

export const CircleInfo = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  kind: CircleKind,
  defaultFacets: DefaultFacets,
  createdAt: z.string(),
})
export type CircleInfo = z.infer<typeof CircleInfo>

// 记忆圈概况：role 是当前账号在该圈的角色，个人圈固定为 owner
export const CircleDetail = CircleInfo.extend({
  role: MemberRole,
  ownerAccountId: z.uuid().nullable(),
  memberCount: z.number().int(),
})
export type CircleDetail = z.infer<typeof CircleDetail>

// 新建共享圈：个人圈在建账号时自动创建，不允许接口直接新建或删除
export const CreateCircleRequest = z.object({
  slug: Slug.optional(),
  name: CircleName,
  defaultFacets: DefaultFacets.default({}),
})
export type CreateCircleRequest = z.infer<typeof CreateCircleRequest>

export const CreatedCircle = CircleInfo.extend({
  ownerAccountId: z.uuid().nullable(),
})
export type CreatedCircle = z.infer<typeof CreatedCircle>

export const UpdateCircleRequest = z
  .object({
    name: CircleName.optional(),
    defaultFacets: DefaultFacets.optional(),
  })
  .refine((v) => v.name !== undefined || v.defaultFacets !== undefined, {
    message: '没有要修改的内容',
  })
export type UpdateCircleRequest = z.infer<typeof UpdateCircleRequest>

// 删除共享圈必须逐字确认当前名称；个人圈禁止直接删除
export const DeleteCircleRequest = z.object({ confirmName: z.string().max(256) })
export type DeleteCircleRequest = z.infer<typeof DeleteCircleRequest>

// 共享圈数量配额：仅统计 kind = 'shared' 且角色为 owner 的记忆圈，个人圈不占配额。
// 实例管理员调低上限后已超出的账号照常使用，只是不能再新建、导入或成为更多共享圈的所有者
export const CIRCLE_LIMIT_DEFAULT = 5
export const CIRCLE_LIMIT_MIN = 1
export const CIRCLE_LIMIT_MAX = 1000
export const MaxOwnedCircles = z.number().int().min(CIRCLE_LIMIT_MIN).max(CIRCLE_LIMIT_MAX)
export const CircleLimitSettings = z.object({ maxOwnedCircles: MaxOwnedCircles })
export type CircleLimitSettings = z.infer<typeof CircleLimitSettings>

export const CircleLimitView = CircleLimitSettings.extend({
  ownedCircles: z.number().int(),
  canCreate: z.boolean(),
})
export type CircleLimitView = z.infer<typeof CircleLimitView>

// 实例管理员看到的记忆圈列表（不含记忆正文）
export const AdminCircle = CircleInfo.extend({
  owners: z.array(AccountRef),
  memberCount: z.number().int(),
})
export type AdminCircle = z.infer<typeof AdminCircle>

export const AdminCircleList = z.object({ circles: z.array(AdminCircle) })
export type AdminCircleList = z.infer<typeof AdminCircleList>

// 成员列表行：含加入时间与该成员在本圈拥有的接入实例数
export const CircleMember = MemberInfo.extend({
  joinedAt: z.string(),
  clientCount: z.number().int(),
})
export type CircleMember = z.infer<typeof CircleMember>

export const CircleMemberList = z.object({ members: z.array(CircleMember) })
export type CircleMemberList = z.infer<typeof CircleMemberList>

export const AddCircleMemberRequest = z.object({
  username: z.string().trim().toLowerCase().min(1, '请填写用户名').max(64),
  role: MemberRole,
})
export type AddCircleMemberRequest = z.infer<typeof AddCircleMemberRequest>

export const UpdateCircleMemberRequest = z.object({ role: MemberRole })
export type UpdateCircleMemberRequest = z.infer<typeof UpdateCircleMemberRequest>

// 转让所有者：对方成为所有者，原所有者降为编辑者
export const TransferCircleOwnershipRequest = z.object({ accountId: z.uuid() })
export type TransferCircleOwnershipRequest = z.infer<typeof TransferCircleOwnershipRequest>

export type { AccountRef }
