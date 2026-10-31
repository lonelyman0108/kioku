import type { ActivityItem } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { dayLabel, groupByDay } from '../activity'
import { formatClock } from '../time'

// 本地时间：测试机在哪个时区都要过，所以都用本地的年月日时分来造
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString()
const now = new Date(2026, 9, 31, 9, 30)

const item = (id: number, createdAt: string) => ({ id, createdAt }) as ActivityItem

describe('一天的小标题', () => {
  it('今天、昨天按本地日期算，不按过了多少小时算', () => {
    expect(dayLabel(at(2026, 10, 31, 0, 1), now)).toBe('今天')
    // 刚过零点：几分钟之前也是昨天
    const justAfterMidnight = new Date(2026, 9, 31, 0, 5)
    expect(dayLabel(at(2026, 10, 30, 23, 58), justAfterMidnight)).toBe('昨天')
    expect(dayLabel(at(2026, 10, 30, 0, 1), now)).toBe('昨天')
  })

  it('更早的写日期，今年的不写年份', () => {
    expect(dayLabel(at(2026, 10, 29), now)).toBe('10-29')
    expect(dayLabel(at(2025, 10, 31), now)).toBe('2025-10-31')
  })

  it('月初和年初的昨天', () => {
    expect(dayLabel(at(2026, 9, 30), new Date(2026, 9, 1, 8))).toBe('昨天')
    expect(dayLabel(at(2025, 12, 31), new Date(2026, 0, 1, 8))).toBe('昨天')
  })
})

describe('变更记录按天分组', () => {
  it('同一天的放一组，组的先后和里面的先后不动', () => {
    const days = groupByDay(
      [
        item(5, at(2026, 10, 31, 8)),
        item(4, at(2026, 10, 31, 1)),
        item(3, at(2026, 10, 30, 23)),
        item(2, at(2026, 10, 28)),
        item(1, at(2025, 10, 28)),
      ],
      now,
    )
    expect(days.map((d) => d.label)).toEqual(['今天', '昨天', '10-28', '2025-10-28'])
    expect(days[0]!.items.map((i) => i.id)).toEqual([5, 4])
  })

  it('去年同月同日是不同的两天，键也不一样', () => {
    const days = groupByDay([item(2, at(2026, 10, 28)), item(1, at(2025, 10, 28))], now)
    expect(new Set(days.map((d) => d.key)).size).toBe(2)
  })

  it('翻页后接在同一天后面，不多出一组', () => {
    const first = [item(3, at(2026, 10, 30, 10))]
    const more = [...first, item(2, at(2026, 10, 30, 9)), item(1, at(2026, 10, 29))]
    expect(groupByDay(more, now).map((d) => d.items.length)).toEqual([2, 1])
  })

  it('没有记录时为空', () => {
    expect(groupByDay([], now)).toEqual([])
  })
})

describe('一行的时间', () => {
  it('补齐两位', () => {
    expect(formatClock(at(2026, 10, 31, 7, 5))).toBe('07:05')
  })
})
