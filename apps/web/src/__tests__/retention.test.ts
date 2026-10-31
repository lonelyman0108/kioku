import type { RetentionCounts } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  attemptNote,
  daysUntilPurge,
  deletionNotice,
  pauseText,
  providerPurgeNote,
  purgeAt,
  purgeNote,
  releasedNotice,
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

  it('从备份恢复的：说明恢复出的已删除记录早已到期，要找回的先恢复', () => {
    const text = pauseText({ ...pause, reason: 'restored' }, 30)
    expect(text.title).toMatch(/^已于 .+ 从备份恢复，清理暂停至 .+$/)
    expect(text.description).toContain('恢复出的已删除记录多已超过保留期')
    expect(text.description).toContain('暂停结束后将被永久删除')
    expect(text.description).toContain('请在暂停结束前到记忆页或凭据页恢复')
    expect(text.detail).toContain('已删除账号留下的历史仍每天清理')
    expect(text.confirm).toContain('删除超过 30 天的将被永久删除')
  })

  it('保留期第一次生效的：说明之前删掉的还有一个完整的保留期可以恢复', () => {
    const text = pauseText({ ...pause, reason: 'started' }, 7)
    expect(text.title).toMatch(/^保留期自 .+ 起生效，首次清理在 .+$/)
    expect(text.description).toContain('此前删除的内容在首次清理前仍可恢复')
    expect(text.detail).toContain('先留出一个完整的保留期')
    expect(text.detail).toContain('已删除账号留下的历史仍每天清理')
    expect(text.confirm).toContain('已删除超过 7 天的')
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

  it('没做完时说删了多少、下一小时重试', () => {
    const note = attemptNote(attempt('2026-10-29T09:17:00.000Z', 2), now)
    expect(note).toContain('本次删除 7 条')
    expect(note).toMatch(/下一小时重试$/)
  })

  it('今天（UTC）已经试满了：明天重试；昨天试满的今天照常再试', () => {
    expect(attemptNote(attempt('2026-10-29T09:17:00.000Z', 3), now)).toMatch(
      /今天已尝试 3 次，明天重试$/,
    )
    expect(attemptNote(attempt('2026-10-28T23:17:00.000Z', 3), now)).toMatch(/下一小时重试$/)
  })
})

describe('已删除的记忆什么时候永久清除', () => {
  const DAY = 86_400_000
  const now = new Date('2026-10-30T12:00:00Z')
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString()
  const later = (days: number) => new Date(now.getTime() + days * DAY).toISOString()
  const normal = { days: 30, paused: false, pausedUntil: null }
  // 实例管理员看得到暂停到什么时候
  const pausedUntil = (iso: string) => ({ days: 30, paused: true, pausedUntil: iso })
  // 别的成员只知道在暂停
  const pausedOnly = { days: 30, paused: true, pausedUntil: null }

  it('删除时间加上保留天数；刚删的还剩整整一个保留期', () => {
    expect(purgeAt(ago(10), normal).toISOString()).toBe(later(20))
    expect(daysUntilPurge(ago(10), normal, now)).toBe(20)
    expect(daysUntilPurge(now.toISOString(), normal, now)).toBe(30)
    expect(purgeNote(ago(10), normal, now)).toEqual({ text: '约 20 天后永久清除', soon: false })
  })

  it('不足一天按一天算，剩三天以内标警示色；到了时间、等着每天一次的清理时说即将清除', () => {
    expect(daysUntilPurge(ago(29.8), normal, now)).toBe(1)
    expect(daysUntilPurge(ago(25.5), normal, now)).toBe(5)
    expect(daysUntilPurge(ago(30), normal, now)).toBe(0)
    expect(daysUntilPurge(ago(45), normal, now)).toBe(0)
    expect(purgeNote(ago(26.5), normal, now)).toEqual({ text: '约 4 天后永久清除', soon: false })
    expect(purgeNote(ago(27.5), normal, now)).toEqual({ text: '约 3 天后永久清除', soon: true })
    expect(purgeNote(ago(45), normal, now)).toEqual({ text: '即将永久清除', soon: true })
  })

  it('知道暂停到什么时候的按暂停结束算：早就到期的也要等暂停结束，暂停之后才到期的照常按删除时间算', () => {
    const paused = pausedUntil(later(12))
    expect(purgeAt(ago(400), paused).toISOString()).toBe(later(12))
    expect(daysUntilPurge(ago(400), paused, now)).toBe(12)
    expect(purgeNote(ago(40), paused, now)).toEqual({ text: '约 12 天后永久清除', soon: false })
    expect(daysUntilPurge(ago(5), paused, now)).toBe(25)
    // 暂停已经过去（列表还没重新读到）时不再推迟
    expect(daysUntilPurge(ago(45), pausedUntil(ago(1)), now)).toBe(0)
  })

  it('只知道在暂停时不催：到期的说暂停结束后清除，没到期的说至少还要多久，都不标警示色', () => {
    expect(purgeNote(ago(45), pausedOnly, now)).toEqual({
      text: '暂停结束后清除',
      soon: false,
    })
    expect(purgeNote(ago(28), pausedOnly, now)).toEqual({
      text: '至少 2 天后永久清除',
      soon: false,
    })
    expect(purgeNote(ago(10), pausedOnly, now)).toEqual({
      text: '至少 20 天后永久清除',
      soon: false,
    })
  })

  it('已删除的凭据源：还有没删除的凭据指着时不说几天；否则从保留期的起点算，规则和别的已删除记录一样', () => {
    expect(providerPurgeNote({ retentionFrom: null }, normal, now)).toEqual({
      text: '仍有凭据绑定，暂不清除',
      soon: false,
    })
    expect(providerPurgeNote({ retentionFrom: null }, pausedUntil(later(12)), now)).toEqual({
      text: '仍有凭据绑定，暂不清除',
      soon: false,
    })
    // 起点是指着它的已删除凭据里最晚的删除时间时，照样按它算
    expect(providerPurgeNote({ retentionFrom: ago(10) }, normal, now)).toEqual({
      text: '约 20 天后永久清除',
      soon: false,
    })
    expect(providerPurgeNote({ retentionFrom: ago(28) }, normal, now)).toEqual({
      text: '约 2 天后永久清除',
      soon: true,
    })
    expect(providerPurgeNote({ retentionFrom: ago(45) }, normal, now)).toEqual({
      text: '即将永久清除',
      soon: true,
    })
    expect(providerPurgeNote({ retentionFrom: ago(45) }, pausedUntil(later(12)), now)).toEqual({
      text: '约 12 天后永久清除',
      soon: false,
    })
    expect(providerPurgeNote({ retentionFrom: ago(45) }, pausedOnly, now)).toEqual({
      text: '暂停结束后清除',
      soon: false,
    })
  })

  it('已过期列表给「URI 已释放」的说明：按释放的时间算，未释放的一直保留；暂停的说法和已删除的一样', () => {
    expect(releasedNotice({ days: 7, paused: false, pausedUntil: null })).toBe(
      '标记为「URI 已释放」的记忆，释放超过 7 天后永久清除，之后只能从备份恢复；未释放的记忆一直保留。',
    )
    expect(releasedNotice(pausedOnly)).toBe(
      '标记为「URI 已释放」的记忆，释放超过 30 天后永久清除，之后只能从备份恢复；未释放的记忆一直保留。清理已暂停，暂不永久清除。',
    )
    const paused = releasedNotice(pausedUntil(later(12)))
    expect(paused).toMatch(/未释放的记忆一直保留。清理暂停至 .+/)
    expect(paused).toContain('在此之前不会清除任何内容')
  })

  it('列表上方说明多少天之后永久清除；暂停中的说暂时不会清除，知道到什么时候的再说出时间', () => {
    expect(deletionNotice({ days: 7, paused: false, pausedUntil: null })).toBe(
      '删除超过 7 天后永久清除，之后只能从备份恢复。',
    )
    expect(deletionNotice(pausedOnly)).toBe(
      '删除超过 30 天后永久清除，之后只能从备份恢复。清理已暂停，暂不永久清除。',
    )
    const paused = deletionNotice(pausedUntil(later(12)))
    expect(paused).toMatch(/^删除超过 30 天后永久清除，之后只能从备份恢复。清理暂停至 .+/)
    expect(paused).toContain('在此之前不会清除任何内容')
  })
})
