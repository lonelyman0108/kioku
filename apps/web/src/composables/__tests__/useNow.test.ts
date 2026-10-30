import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { purgeNote } from '../../retention'
import { useNow } from '../useNow'

describe('每分钟走一次的现在', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('每过一分钟换成新的时间，组件卸载（作用域停下）之后不再走', () => {
    const scope = effectScope()
    const now = scope.run(() => useNow())!
    expect(now.value.toISOString()).toBe('2026-10-30T12:00:00.000Z')
    vi.advanceTimersByTime(59_000)
    expect(now.value.toISOString()).toBe('2026-10-30T12:00:00.000Z')
    vi.advanceTimersByTime(1_000)
    expect(now.value.toISOString()).toBe('2026-10-30T12:01:00.000Z')
    scope.stop()
    vi.advanceTimersByTime(10 * 60_000)
    expect(now.value.toISOString()).toBe('2026-10-30T12:01:00.000Z')
  })

  it('页面开着过夜，按它算的倒计时跟着变', () => {
    const scope = effectScope()
    const now = scope.run(() => useNow())!
    const retention = { days: 30, pausedUntil: null }
    // 29 天又 12 小时前删的：还剩半天
    const deletedAt = new Date(Date.now() - 29.5 * 86_400_000).toISOString()
    expect(purgeNote(deletedAt, retention, now.value)).toBe('约 1 天后永久清除')
    vi.advanceTimersByTime(13 * 3_600_000)
    expect(purgeNote(deletedAt, retention, now.value)).toBe('即将永久清除')
    scope.stop()
  })
})
