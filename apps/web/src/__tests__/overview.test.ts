import type { SubjectBinding } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { bindingNote, budgetWarning, splitNote, strataFilterQuery, strataTarget } from '../overview'

const usage = (usedTokens: number, monthlyTokens = 500_000) => ({
  usedTokens,
  monthlyTokens,
  dailyWritesPerSubject: 20,
  periodStart: '2026-10-01T00:00:00.000Z',
})

describe('抽取预算的提醒', () => {
  it('用到八成才提醒', () => {
    expect(budgetWarning(usage(399_999))).toBeNull()
    expect(budgetWarning(usage(400_000))?.title).toBe('本月抽取预算已用 80%')
  })

  it('用完之后说清后果，后果一句都不能少', () => {
    const near = budgetWarning(usage(410_000))!
    expect(near.over).toBe(false)
    expect(near.description).toContain('用完后本月仅写会话摘要，不再抽取事实，整理暂停。')
    const over = budgetWarning(usage(500_000))!
    expect(over.over).toBe(true)
    expect(over.title).toBe('本月抽取预算已用完')
    expect(over.description).toContain('下月恢复')
    expect(over.description).toContain('记忆圈所有者可在记忆圈设置中调高预算')
  })
})

describe('提醒的第一句', () => {
  it('第一句留在页面上，别的放进提示层，一个字不少', () => {
    expect(splitNote('已用 1 / 2 token。用完后暂停。下月恢复。')).toEqual({
      first: '已用 1 / 2 token',
      rest: '用完后暂停。下月恢复。',
    })
  })

  it('只有一句时提示层是空的', () => {
    expect(splitNote('只有一句。')).toEqual({ first: '只有一句', rest: '' })
    expect(splitNote('没有句号')).toEqual({ first: '没有句号', rest: '' })
  })
})

describe('账号绑定那一行', () => {
  const binding = (id: string) =>
    ({
      redeemedBy: { platform: 'telegram', externalId: id, displayName: null },
      subject: { id: 's', displayName: '小明' },
    }) as unknown as SubjectBinding

  it('没有申请时没有说明，交给页面写「暂无」', () => {
    expect(bindingNote([], 0)).toBeNull()
  })

  it('说清哪个账号绑定到谁；好几个时带上总数，总数以合计为准', () => {
    expect(bindingNote([binding('u1')], 1)).toBe('telegram u1 申请绑定到「小明」')
    expect(bindingNote([binding('u1'), binding('u2')], 25)).toBe(
      'telegram u1 申请绑定到「小明」，共 25 个',
    )
  })
})

describe('点地层柱去哪里', () => {
  it('来自对话的两类去对话页对应的分页，独立人格去词表页的人格分页', () => {
    expect(strataTarget('c1', { band: 'episode', sensitivity: null })).toEqual({
      name: 'conversations',
      params: { circleId: 'c1' },
      query: {},
    })
    expect(strataTarget('c1', { band: 'fact', sensitivity: 'public' })).toEqual({
      name: 'conversations',
      params: { circleId: 'c1' },
      query: { tab: 'contacts' },
    })
    expect(strataTarget('c1', { band: 'persona', sensitivity: null })).toEqual({
      name: 'vocabulary',
      params: { circleId: 'c1' },
      query: { tab: 'personas' },
    })
  })

  it('点其他色带或一个敏感级：记忆列表按色带与敏感级筛选', () => {
    expect(strataTarget('c1', { band: 'personal', sensitivity: null })).toEqual({
      name: 'memories',
      params: { circleId: 'c1' },
      query: { view: 'list', band: 'personal' },
    })
    expect(strataTarget('c1', { band: 'primary', sensitivity: 'internal' })).toEqual({
      name: 'memories',
      params: { circleId: 'c1' },
      query: { view: 'list', band: 'primary', sensitivity: 'internal' },
    })
    expect(strataTarget('c1', { band: 'shared-away', sensitivity: 'public' })).toEqual({
      name: 'memories',
      params: { circleId: 'c1' },
      query: { view: 'list', band: 'shared-away', sensitivity: 'public' },
    })
    expect(strataTarget('c1', { band: null, sensitivity: 'secret' }).query).toEqual({
      view: 'list',
      sensitivity: 'secret',
    })
  })
})

describe('点地层柱的一格', () => {
  it('跳到列表，带上色带和敏感级', () => {
    expect(strataFilterQuery({ band: 'personal', sensitivity: 'secret' })).toEqual({
      view: 'list',
      band: 'personal',
      sensitivity: 'secret',
    })
  })

  it('只点一个色带或只点一个敏感级时，另一个不写进地址', () => {
    expect(strataFilterQuery({ band: 'primary', sensitivity: null })).toEqual({
      view: 'list',
      band: 'primary',
    })
    expect(strataFilterQuery({ band: null, sensitivity: 'internal' })).toEqual({
      view: 'list',
      sensitivity: 'internal',
    })
  })
})
