import type { InboxCounts } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  INBOX_TABS,
  actionableInboxCount,
  inboxCountsKey,
  inboxTabCount,
  inboxTabLabels,
  legacyReviewTab,
  resolveInboxTab,
} from '../inbox'

const counts = (over: Partial<InboxCounts> = {}): InboxCounts => ({
  bindings: 0,
  review: 0,
  dreamSuggestions: 0,
  plaintext: 0,
  total: 0,
  ...over,
})

describe('看的是哪一类', () => {
  it('地址里写了就看那一类，哪怕它是空的', () => {
    expect(resolveInboxTab('dream', counts({ review: 3 }), false)).toBe('dream')
    expect(resolveInboxTab('binding', undefined, false)).toBe('binding')
  })

  it('没写或者写错时看第一个有内容的，顺序和左边一样', () => {
    expect(resolveInboxTab(undefined, counts({ plaintext: 2, dreamSuggestions: 1 }), false)).toBe(
      'dream',
    )
    expect(resolveInboxTab('nope', counts({ bindings: 1, review: 1 }), false)).toBe('binding')
  })

  it('都是空的时候看待确认内容', () => {
    expect(resolveInboxTab(undefined, counts(), false)).toBe('review')
  })

  it('条数还没读到时先不决定，不闪一下别的分类；读取失败时不再等', () => {
    expect(resolveInboxTab(undefined, undefined, false)).toBeNull()
    expect(resolveInboxTab(undefined, undefined, true)).toBe('review')
  })
})

describe('角标的数字', () => {
  const all = counts({ bindings: 1, review: 2, dreamSuggestions: 3, plaintext: 4, total: 10 })

  it('所有者和编辑者是总数', () => {
    expect(actionableInboxCount(all, 'owner')).toBe(10)
    expect(actionableInboxCount(all, 'editor')).toBe(10)
  })

  it('查看者只算账号绑定：这一类他能拒绝，别的几类动不了，算进去永远消不掉', () => {
    expect(actionableInboxCount(all, 'viewer')).toBe(1)
    expect(actionableInboxCount(counts({ review: 5, total: 5 }), 'viewer')).toBe(0)
  })
})

describe('旧地址', () => {
  it('review 的两个分页对应到这里', () => {
    expect(legacyReviewTab('dream')).toBe('dream')
    expect(legacyReviewTab(undefined)).toBe('review')
    expect(legacyReviewTab('whatever')).toBe('review')
  })
})

describe('四类', () => {
  it('每一类的条数取对字段，名字都有', () => {
    const all = counts({ bindings: 1, review: 2, dreamSuggestions: 3, plaintext: 4 })
    expect(INBOX_TABS.map((t) => inboxTabCount(all, t))).toEqual([1, 2, 3, 4])
    for (const t of INBOX_TABS) expect(inboxTabLabels[t]).toBeTruthy()
  })

  it('缓存键带空间', () => {
    expect(inboxCountsKey('s1')).toEqual(['inbox-counts', 's1'])
  })
})
