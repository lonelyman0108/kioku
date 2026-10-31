import type { BindingStatus, SubjectBinding } from '@kioku/contracts'

import { formatShort } from './time'

// 绑定记录在界面上的说法：对象页的「账号绑定」与概览里等确认的绑定共用

export const bindingStatusLabels: Record<BindingStatus, string> = {
  pending: '待确认',
  merged: '已合并',
  confirmed: '已确认',
  rejected: '已拒绝',
  cancelled: '已作废',
  expired: '已过期',
}

export const bindingStatusColors: Record<BindingStatus, 'warning' | 'success' | 'neutral'> = {
  pending: 'warning',
  merged: 'success',
  confirmed: 'success',
  rejected: 'neutral',
  cancelled: 'neutral',
  expired: 'neutral',
}

// 平台账号：平台、账号，有平台上的名字时带上
export function accountText(account: {
  platform: string
  externalId: string
  displayName?: string | null
}): string {
  const name = account.displayName ? `（${account.displayName}）` : ''
  return `${account.platform} ${account.externalId}${name}`
}

const member = (ref: { displayName: string } | null) => `「${ref?.displayName ?? '已删除的成员'}」`

// 这次绑定现在怎样了
export function bindingOutcome(binding: SubjectBinding, now: Date = new Date()): string {
  switch (binding.status) {
    case 'pending':
      return `待${member(binding.confirmer)}确认，${formatShort(binding.expiresAt!, now)} 前有效`
    case 'merged':
      return '使用绑定码的账号确认后已直接合并，无需成员确认'
    case 'confirmed':
      return `${member(binding.decidedBy)}确认后已合并`
    case 'rejected':
      return `${member(binding.decidedBy)}已拒绝，未合并`
    case 'cancelled':
      return `已作废：${binding.note ?? '情况已变化'}`
    case 'expired':
      return `${member(binding.confirmer)}未在期限内处理，已作废`
  }
}

// 绑定码是哪个平台账号、什么时候申请的，经由哪个应用
export function bindingSource(binding: SubjectBinding, now: Date = new Date()): string {
  return `${accountText(binding.issuedBy)} 于 ${formatShort(binding.issuedAt, now)} 申请绑定码，经由「${binding.app.name}」`
}
