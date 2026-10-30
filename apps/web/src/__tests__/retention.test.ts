import type { RetentionCounts } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  attemptNote,
  daysUntilPurge,
  deletionNotice,
  pauseText,
  purgeAt,
  purgeNote,
  retentionSummary,
  retentionTotal,
} from '../retention'

const zero: RetentionCounts = {
  deletedMemories: 0,
  supersededFacts: 0,
  expiredSummaries: 0,
  orphanEvents: 0,
  scrubbedSnapshots: 0,
  extractionRuns: 0,
  dreamRuns: 0,
  dreamSuggestions: 0,
  credentialEvents: 0,
  deletedCredentials: 0,
  deletedProviders: 0,
  subjectBindings: 0,
}

describe('保留期清理的结果', () => {
  it('一条都没删时什么都不列', () => {
    expect(retentionSummary(zero)).toEqual([])
    expect(retentionTotal(zero)).toBe(0)
  })

  it('只列删了东西的几类，按固定的顺序', () => {
    const counts = { ...zero, deletedProviders: 1, deletedMemories: 12, credentialEvents: 3 }
    expect(retentionSummary(counts)).toEqual([
      { label: '已删除的记忆', count: 12 },
      { label: '凭据事件', count: 3 },
      { label: '已删除的凭据源', count: 1 },
    ])
    expect(retentionTotal(counts)).toBe(16)
  })
})

describe('暂停的说法', () => {
  const pause = { since: '2026-10-29T05:00:00.000Z', until: '2026-11-28T05:00:00.000Z' }

  it('从备份恢复的：说明恢复出的已删除记录早已到期，要找回的先撤销删除', () => {
    const text = pauseText({ ...pause, reason: 'restored' }, 30)
    expect(text.title).toMatch(/^从备份恢复于 .+，清理暂停到 .+$/)
    expect(text.description).toContain('恢复出的已删除记录')
    expect(text.confirm).toContain('删除超过 30 天的会被永久删除')
  })

  it('保留期第一次生效的：说明之前删掉的还有一个完整的保留期可以撤销', () => {
    const text = pauseText({ ...pause, reason: 'started' }, 7)
    expect(text.title).toMatch(/^保留期从 .+ 开始生效，第一次清理在 .+$/)
    expect(text.description).toContain('之前删掉的到现在都还能撤销')
    expect(text.description).toContain('删账号留下的历史照常每天清理')
    expect(text.confirm).toContain('已经删除超过 7 天的')
  })
})

describe('最近一次没做完的说法', () => {
  const now = new Date('2026-10-29T10:00:00Z')
  const attempt = (at: string, tries: number, complete = false) => ({
    at,
    paused: false,
    complete,
    counts: { ...zero, deletedMemories: 7 },
    tries,
  })

  it('做完了、还没试过时不说', () => {
    expect(attemptNote(null, now)).toBeNull()
    expect(attemptNote(attempt('2026-10-29T09:17:00.000Z', 1, true), now)).toBeNull()
  })

  it('没做完时说删了多少、下一个小时再试', () => {
    const note = attemptNote(attempt('2026-10-29T09:17:00.000Z', 2), now)
    expect(note).toContain('这次删了 7 条')
    expect(note).toMatch(/下一个小时再试$/)
  })

  it('今天（UTC）已经试满了：明天再试；昨天试满的今天照常再试', () => {
    expect(attemptNote(attempt('2026-10-29T09:17:00.000Z', 3), now)).toMatch(
      /今天已经试了 3 次，明天再试$/,
    )
    expect(attemptNote(attempt('2026-10-28T23:17:00.000Z', 3), now)).toMatch(/下一个小时再试$/)
  })
})

describe('已删除的记忆什么时候永久清除', () => {
  const DAY = 86_400_000
  const now = new Date('2026-10-30T12:00:00Z')
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString()
  const later = (days: number) => new Date(now.getTime() + days * DAY).toISOString()
  const normal = { days: 30, pausedUntil: null }

  it('删除时间加上保留天数；刚删的还剩整整一个保留期', () => {
    expect(purgeAt(ago(10), normal).toISOString()).toBe(later(20))
    expect(daysUntilPurge(ago(10), normal, now)).toBe(20)
    expect(daysUntilPurge(now.toISOString(), normal, now)).toBe(30)
    expect(purgeNote(ago(10), normal, now)).toBe('约 20 天后永久清除')
  })

  it('不足一天按一天算；到了时间、等着每天一次的清理时说即将清除', () => {
    expect(daysUntilPurge(ago(29.8), normal, now)).toBe(1)
    expect(daysUntilPurge(ago(25.5), normal, now)).toBe(5)
    expect(daysUntilPurge(ago(30), normal, now)).toBe(0)
    expect(daysUntilPurge(ago(45), normal, now)).toBe(0)
    expect(purgeNote(ago(45), normal, now)).toBe('即将永久清除')
  })

  it('暂停期间按暂停结束的时间算：早就到期的也要等暂停结束，暂停之后才到期的照常按删除时间算', () => {
    const paused = { days: 30, pausedUntil: later(12) }
    expect(purgeAt(ago(400), paused).toISOString()).toBe(later(12))
    expect(daysUntilPurge(ago(400), paused, now)).toBe(12)
    expect(purgeNote(ago(40), paused, now)).toBe('约 12 天后永久清除')
    expect(daysUntilPurge(ago(5), paused, now)).toBe(25)
    // 暂停已经过去（列表还没重新读到）时不再推迟
    expect(daysUntilPurge(ago(45), { days: 30, pausedUntil: ago(1) }, now)).toBe(0)
  })

  it('列表上方说明多少天之后永久清除，暂停中的还说到什么时候之前一条都不删', () => {
    expect(deletionNotice({ days: 7, pausedUntil: null })).toBe(
      '删除超过 7 天会被永久清除，之后只能从备份找回。',
    )
    const paused = deletionNotice({ days: 30, pausedUntil: later(12) })
    expect(paused).toMatch(/^删除超过 30 天会被永久清除，之后只能从备份找回。清理暂停到 .+/)
    expect(paused).toContain('这之前一条都不会清除')
  })
})
