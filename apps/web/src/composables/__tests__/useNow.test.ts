import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isExpired } from '../../time'
import { useNow } from '../useNow'

describe('每分钟走一次的现在', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // 组件的启用状态由调用方给：这里不在组件里，直接用一个开关
  const start = (intervalMs = 60_000, active = ref(true)) => {
    const scope = effectScope()
    const now = scope.run(() => useNow(intervalMs, active))!
    return { scope, now, active }
  }
  const at = (now: { value: Date }) => now.value.toISOString()

  it('每过一分钟换成新的时间，组件卸载（作用域停下）之后不再走', () => {
    const { scope, now } = start()
    expect(at(now)).toBe('2026-10-30T12:00:00.000Z')
    vi.advanceTimersByTime(59_000)
    expect(at(now)).toBe('2026-10-30T12:00:00.000Z')
    vi.advanceTimersByTime(1_000)
    expect(at(now)).toBe('2026-10-30T12:01:00.000Z')
    scope.stop()
    vi.advanceTimersByTime(10 * 60_000)
    expect(at(now)).toBe('2026-10-30T12:01:00.000Z')
  })

  it('在 KeepAlive 里被切走时停下，切回来马上换成现在再接着走', () => {
    const { scope, now, active } = start(30_000)
    vi.advanceTimersByTime(30_000)
    expect(at(now)).toBe('2026-10-30T12:00:30.000Z')
    active.value = false
    vi.advanceTimersByTime(10 * 60_000)
    expect(at(now)).toBe('2026-10-30T12:00:30.000Z')
    active.value = true
    expect(at(now)).toBe('2026-10-30T12:10:30.000Z')
    vi.advanceTimersByTime(30_000)
    expect(at(now)).toBe('2026-10-30T12:11:00.000Z')
    scope.stop()
  })

  it('页面一直开着，按它算的「已过期」到点就变', () => {
    const { scope, now } = start(30_000)
    const validTo = new Date(Date.now() + 45_000).toISOString()
    expect(isExpired(validTo, now.value)).toBe(false)
    vi.advanceTimersByTime(30_000)
    expect(isExpired(validTo, now.value)).toBe(false)
    vi.advanceTimersByTime(30_000)
    expect(isExpired(validTo, now.value)).toBe(true)
    scope.stop()
  })
})
