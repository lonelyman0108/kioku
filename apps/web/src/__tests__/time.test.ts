import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  earliestValidTo,
  formatRelative,
  formatShort,
  fromLocalInput,
  isExpired,
  toLocalInput,
} from '../time'

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

describe('有效到', () => {
  // 输入框里是本地时间：固定一个时区核对换算
  const zone = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'Asia/Shanghai'
  })
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('输入框的本地时间与带时区的 ISO 时间互换，精确到分钟', () => {
    expect(toLocalInput('2026-10-31T10:05:42.123Z')).toBe('2026-10-31T18:05')
    expect(fromLocalInput('2026-10-31T18:05')).toBe('2026-10-31T10:05:00.000Z')
    expect(fromLocalInput('2026-10-31T18:05:30')).toBe('2026-10-31T10:05:30.000Z')
    // 跨过本地的零点
    expect(toLocalInput('2026-12-31T16:30:00Z')).toBe('2027-01-01T00:30')
    expect(fromLocalInput(toLocalInput('2027-01-01T00:30:00.000Z'))).toBe(
      '2027-01-01T00:30:00.000Z',
    )
  })

  it('有效到最早能选的时间比现在晚至少一分钟（输入框截掉秒之后也是）', () => {
    const now = new Date('2026-10-31T10:05:59.900Z')
    const earliest = earliestValidTo(now)
    expect(earliest).toBe('2026-10-31T18:07')
    expect(new Date(fromLocalInput(earliest)!).getTime() - now.getTime()).toBeGreaterThanOrEqual(
      60_000,
    )
  })

  it('没填完整、不是日期时间的不换', () => {
    expect(fromLocalInput('')).toBeNull()
    expect(fromLocalInput('2026-10-31')).toBeNull()
    expect(fromLocalInput('2026-13-40T25:00')).toBeNull()
  })

  it('到了有效到的那一刻就算过期；列表里的短时间今年的不写年份', () => {
    const now = new Date('2026-10-31T10:00:00Z')
    expect(isExpired(null, now)).toBe(false)
    expect(isExpired('2026-10-31T10:00:00.001Z', now)).toBe(false)
    expect(isExpired('2026-10-31T10:00:00Z', now)).toBe(true)
    expect(formatShort('2026-11-02T01:00:00Z', now)).toBe('11-02 09:00')
    expect(formatShort('2027-01-02T01:00:00Z', now)).toBe('2027-01-02 09:00')
  })
})
