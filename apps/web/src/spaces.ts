import {
  CIRCLE_NAME_MAX,
  CircleName,
  DEPARTURE_RETENTION_DAYS,
  type CircleLimitView,
  type MemberRole,
} from '@kioku/contracts'
import type { QueryClient } from '@tanstack/vue-query'

import type { FieldIssue } from './composables/useSavedField'
import { ME_KEY } from './query'

// 记忆圈与成员页面共用的判断与文案。服务端同样检查，这里只决定按钮给不给、旁边写什么

export interface MemberLike {
  accountId: string
  role: MemberRole
}

// 记忆圈名称填得对不对：和服务端同一个 schema（去掉首尾空白、按码点数长度），不对时给出问题的种类
export function circleNameIssue(input: string): FieldIssue | null {
  if (!input.trim()) return 'empty'
  return CircleName.safeParse(input).success ? null : 'range'
}
export const CIRCLE_NAME_RANGE = `记忆圈名称为 1 到 ${CIRCLE_NAME_MAX} 个字符。`

// 删除共享记忆圈要输入现在的名称，逐字一致才能删（和服务端一样，不去空白、不忽略大小写）
export const confirmsName = (input: string, name: string): boolean =>
  name.length > 0 && input === name

export const ownerCount = (members: readonly MemberLike[]): number =>
  members.filter((m) => m.role === 'owner').length

// 这个成员是不是唯一的所有者：不能离开、不能被移除、不能降级，要先转让所有者
export const isLastOwner = (members: readonly MemberLike[], accountId: string): boolean =>
  members.some((m) => m.accountId === accountId && m.role === 'owner') && ownerCount(members) < 2

export const LAST_OWNER_NOTE = '共享记忆圈至少保留一个所有者：先将其他成员设为所有者或转让所有者。'

// 成员表里一行的操作：所有者可以移除别人；自己那一行是离开记忆圈。别人的行对非所有者没有操作。
// 唯一的所有者离开时按钮给出但不能点，旁边写原因
export function memberAction(
  viewer: { accountId: string; role: MemberRole },
  row: MemberLike,
  members: readonly MemberLike[],
): { kind: 'leave' | 'remove'; blocked: string | null } | null {
  if (row.accountId === viewer.accountId) {
    return { kind: 'leave', blocked: isLastOwner(members, row.accountId) ? LAST_OWNER_NOTE : null }
  }
  if (viewer.role !== 'owner') return null
  return { kind: 'remove', blocked: isLastOwner(members, row.accountId) ? LAST_OWNER_NOTE : null }
}

// 角色能不能在表格里改：只有所有者改别人的，自己的角色靠转让所有者改
export const roleEditable = (viewer: { accountId: string; role: MemberRole }, row: MemberLike) =>
  viewer.role === 'owner' && row.accountId !== viewer.accountId

// 转让给谁：别的成员
export const transferTargets = <T extends MemberLike>(members: readonly T[], self: string): T[] =>
  members.filter((m) => m.accountId !== self)

// 头像里的字：显示名的第一个字（按字符算，不切开代理对）
export const initialOf = (name: string): string => Array.from(name.trim())[0] ?? '?'

// 离开或删除之后去哪：优先回到个人记忆圈，其次别的记忆圈的概览，没有记忆圈时回首页
export function nextCircle(
  circles: readonly { id: string; kind?: string }[],
  gone: string,
  personalCircleId?: string,
): string | null {
  const remaining = circles.filter((c) => c.id !== gone)
  if (personalCircleId && remaining.some((c) => c.id === personalCircleId)) {
    return personalCircleId
  }
  return remaining[0]?.id ?? null
}

// 离开、移除与删除的后果。不可逆操作按结果、影响、动作写
export const LEAVE_CONSEQUENCES = [
  '当前账号在本圈接入实例的访问密钥立即吊销。',
  `本人在本圈留下的会话摘要与凭据保留 ${DEPARTURE_RETENTION_DAYS} 天，期间重新加入即恢复，到期删除。`,
]
export const LEAVE_NOTE = `当前账号在本圈的访问密钥立即吊销，留下的会话摘要与凭据保留 ${DEPARTURE_RETENTION_DAYS} 天。`
export const REMOVE_CONSEQUENCES = [
  '此成员在本圈接入实例的访问密钥立即吊销，接入实例保留，可由记忆圈所有者转移或删除。',
  `其在本圈留下的会话摘要与凭据保留 ${DEPARTURE_RETENTION_DAYS} 天，期间重新加入即恢复，到期删除。`,
]
export const DELETE_CONSEQUENCES = [
  '记忆圈内的词条、会话、凭据与访问密钥全部删除，无法恢复。',
  '关联的接入实例立即失去访问。',
]
export const TRANSFER_CONSEQUENCES = [
  '对方成为所有者，当前账号改为编辑者。',
  '之后成员、记忆圈设置与导出由所有者管理。',
]

// 共享记忆圈数量上限与当前账号的名额：新建、导入的入口与实例 › 记忆圈共用这一个查询
export const CIRCLE_LIMIT_KEY = ['instance', 'circle-limit'] as const

// 名额用完时入口旁写的原因；还有名额、或者还没读到时为 null（服务端照样检查）
export const circleLimitNote = (view: CircleLimitView | undefined): string | null =>
  view && !view.canCreate ? `已达共享记忆圈数量上限（${view.maxOwnedCircles} 个）` : null

// 记忆圈的名字、成员与角色变了：会话里的记忆圈列表（切换器、角色）、成员表与实例的记忆圈列表一起刷新，
// 当前账号拥有几个共享记忆圈也可能变了，名额一起重取。
// me 为 false 时不刷新会话，由调用方自己取一次。accounts 为 true 时实例的账号列表（所在记忆圈与角色、
// 唯一可用的所有者）一起刷新：新建、删除、转让、加入、移除、离开与改角色时传，改名不用
export async function refreshCircles(
  client: QueryClient,
  circleId?: string,
  options: { me?: boolean; accounts?: boolean } = {},
): Promise<void> {
  await Promise.all([
    ...(options.me === false ? [] : [client.invalidateQueries({ queryKey: ME_KEY })]),
    client.invalidateQueries({ queryKey: ['instance-circles'] }),
    client.invalidateQueries({ queryKey: CIRCLE_LIMIT_KEY }),
    ...(options.accounts ? [client.invalidateQueries({ queryKey: ['instance-accounts'] })] : []),
    ...(circleId
      ? [
          client.invalidateQueries({ queryKey: ['members', circleId] }),
          client.invalidateQueries({ queryKey: ['circle', circleId] }),
        ]
      : []),
  ])
}

export const isCircleQuery = (circleId: string) => (query: { queryKey: readonly unknown[] }) =>
  query.queryKey.includes(circleId)

// 已经不在的记忆圈的查询（成员、概况、接入实例……）：先停下正在取的，不让它们失效重取（已无权访问，重取只会拿到 403）
export async function stopCircleQueries(client: QueryClient, circleId: string): Promise<void> {
  await client.cancelQueries({ predicate: isCircleQuery(circleId) })
}

// 再丢掉它们。只丢没有观察者的：还挂着的组件会为删掉的键新建查询并请求，403 在页面上闪一下。
// 调用方先离开那个记忆圈的页面（或确认没有页面挂着它）再丢
export function dropCircleQueries(client: QueryClient, circleId: string): void {
  client.removeQueries({
    predicate: (query) => isCircleQuery(circleId)(query) && query.getObserversCount() === 0,
  })
}
