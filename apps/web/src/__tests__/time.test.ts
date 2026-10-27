import { describe, expect, it } from 'vitest'

import { formatRelative } from '../time'

describe('相对时间', () => {
  const now = new Date('2026-10-27T12:00:00')
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()

  it('一周之内按分钟、小时、天说', () => {
    expect(formatRelative(ago(20_000), now)).toBe('刚刚')
    expect(formatRelative(ago(5 * 60_000), now)).toBe('5 分钟前')
    expect(formatRelative(ago(3 * 3_600_000), now)).toBe('3 小时前')
    expect(formatRelative(ago(2 * 86_400_000), now)).toBe('2 天前')
  })

  it('更早的给日期；时钟偏差导致的未来时间算刚刚', () => {
    expect(formatRelative(new Date('2026-10-01T08:00:00').toISOString(), now)).toBe('2026-10-01')
    expect(formatRelative(ago(-30_000), now)).toBe('刚刚')
  })
})
