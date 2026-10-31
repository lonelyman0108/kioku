import type { AppRecallVolume, DebugCandidate } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { recallTotal, scoreAxis, scoreParts, volumeBars } from '../recall'

const volume = (total: number, sources: [string, number][] = []): AppRecallVolume =>
  ({
    appId: '00000000-0000-4000-8000-000000000001',
    name: 'a',
    total,
    sources: sources.map(([source, count]) => ({ source, count })),
  }) as AppRecallVolume

describe('各应用的调用量', () => {
  it('最长的一条占满，别的按平方根：小应用也看得清', () => {
    const bars = volumeBars([volume(900), volume(100), volume(0)])
    expect(bars.map((b) => Math.round(b.width))).toEqual([100, 33, 0])
  })

  it('一个应用都没有调用时不除以零', () => {
    expect(volumeBars([volume(0)])[0]!.width).toBe(0)
    expect(volumeBars([])).toEqual([])
  })

  it('条内按来路分段，比例按次数，顺序固定，没有的来路不画', () => {
    const [bar] = volumeBars([
      volume(100, [
        ['session.start', 25],
        ['prompt.submit', 75],
      ]),
    ])
    expect(bar!.segments.map((s) => [s.source, s.count, s.share])).toEqual([
      ['prompt.submit', 75, 75],
      ['session.start', 25, 25],
    ])
    expect(bar!.segments.map((s) => s.label)).toEqual(['每轮输入', '会话开始'])
  })

  it('总次数是各应用加起来', () => {
    expect(recallTotal([volume(3), volume(4)])).toBe(7)
    expect(recallTotal([])).toBe(0)
  })
})

describe('分数轴', () => {
  it('通常是 0 到 1，每格 0.25，阈值落在对应的位置', () => {
    const axis = scoreAxis([0.5, 0.2], 0.2)
    expect(axis.max).toBe(1)
    expect(axis.ticks.map((t) => t.label)).toEqual(['0', '0.25', '0.50', '0.75', '1'])
    expect(axis.ticks.map((t) => t.left)).toEqual([0, 25, 50, 75, 100])
    expect(axis.threshold).toBe(20)
  })

  it('四路加起来可能超过 1：轴跟着放长，条不会画出去', () => {
    const axis = scoreAxis([1.41, 0.2], 0.2)
    expect(axis.max).toBe(1.5)
    expect(axis.ticks.at(-1)!.left).toBe(100)
    expect(axis.ticks.at(-1)!.label).toBe('1.50')
    expect(axis.threshold).toBeCloseTo((0.2 / 1.5) * 100)
  })

  it('正好是 1、没有结果时都是 0 到 1', () => {
    expect(scoreAxis([1], 0.2).max).toBe(1)
    expect(scoreAxis([], 0.2).max).toBe(1)
  })
})

describe('分数的分项', () => {
  const candidate = (breakdown: DebugCandidate['breakdown']) => ({ breakdown }) as DebugCandidate

  it('四路都列出来，比例加起来是整条', () => {
    const parts = scoreParts(
      candidate({ semantic: 0.4, fulltext: 0.3, glossary: 0.2, priority: 0.1 }),
    )
    expect(parts.map((p) => p.label)).toEqual(['向量', '全文', '关键词', '优先级'])
    expect(parts.map((p) => p.value)).toEqual([0.4, 0.3, 0.2, 0.1])
    expect(parts.reduce((a, p) => a + p.share, 0)).toBeCloseTo(100)
  })

  it('没走到的一路是 0；全是 0 时不除以零', () => {
    const parts = scoreParts(candidate({ semantic: 0, fulltext: 0, glossary: 0, priority: 0 }))
    expect(parts.every((p) => p.value === 0 && p.share === 0)).toBe(true)
  })
})
