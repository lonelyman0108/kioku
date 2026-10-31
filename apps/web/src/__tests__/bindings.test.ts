import type { SubjectBinding } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { accountText, bindingOutcome, bindingSource } from '../bindings'

const now = new Date(2026, 9, 29, 12, 0)
const at = (hour: number, day = 29) => new Date(2026, 9, day, hour, 30).toISOString()

const binding = (extra: Partial<SubjectBinding>): SubjectBinding => ({
  id: 'b',
  status: 'pending',
  subject: { id: 's', displayName: '小明' },
  incoming: null,
  redeemedBy: { platform: 'telegram', externalId: 'u1', displayName: '明' },
  issuedBy: { platform: 'aiocqhttp', externalId: '1001' },
  issuedAt: at(9),
  app: { id: 'a', name: '群聊 bot' },
  confirmer: { id: 'bob', displayName: 'bob' },
  decidedBy: null,
  createdAt: at(10),
  expiresAt: at(10, 31),
  decidedAt: null,
  note: null,
  canConfirm: false,
  canReject: false,
  ...extra,
})

describe('绑定记录的说法', () => {
  it('平台账号有名字时带上', () => {
    expect(accountText({ platform: 'telegram', externalId: 'u1', displayName: '明' })).toBe(
      'telegram u1（明）',
    )
    expect(accountText({ platform: 'aiocqhttp', externalId: '1001' })).toBe('aiocqhttp 1001')
  })

  it('说清绑定码是谁、什么时候申请的，经由哪个应用', () => {
    expect(bindingSource(binding({}), now)).toBe(
      'aiocqhttp 1001 于 10-29 09:30 申请绑定码，经由「群聊 bot」',
    )
  })

  it('每种状态说清现在怎样了；成员的账号删掉了也说得出来', () => {
    expect(bindingOutcome(binding({}), now)).toBe('待「bob」确认，10-31 10:30 前有效')
    expect(bindingOutcome(binding({ status: 'merged', confirmer: null }), now)).toBe(
      '使用绑定码的账号确认后已直接合并，无需成员确认',
    )
    expect(
      bindingOutcome(
        binding({ status: 'confirmed', decidedBy: { id: 'bob', displayName: 'bob' } }),
        now,
      ),
    ).toBe('「bob」确认后已合并')
    expect(bindingOutcome(binding({ status: 'rejected', decidedBy: null }), now)).toBe(
      '「已删除的成员」已拒绝，未合并',
    )
    expect(
      bindingOutcome(binding({ status: 'cancelled', note: '等确认期间对象被合并了' }), now),
    ).toBe('已作废：等确认期间对象被合并了')
    expect(bindingOutcome(binding({ status: 'expired' }), now)).toBe(
      '「bob」未在期限内处理，已作废',
    )
  })
})
