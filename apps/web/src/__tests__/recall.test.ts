import type { ClientInfo, ClientRecallVolume, DebugCandidate, KeyInfo } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client'
import { debugKeyChoices, recallTotal, scoreAxis, scoreParts, volumeBars } from '../recall'

const volume = (total: number, sources: [string, number][] = []): ClientRecallVolume =>
  ({
    clientId: '00000000-0000-4000-8000-000000000001',
    name: 'a',
    total,
    sources: sources.map(([source, count]) => ({ source, count })),
  }) as ClientRecallVolume

describe('调试能选的 Key', () => {
  const client = (id: string) => ({ id, name: id }) as ClientInfo
  const key = (id: string, effective = true) =>
    ({ id, effectiveScopes: effective ? { readKinds: [] } : null }) as KeyInfo
  const loaded = (...keys: KeyInfo[]) => ({ data: keys, isError: false, error: null })
  const failed = (data?: KeyInfo[]) => ({
    data,
    isError: true,
    error: new ApiError(404, '接入实例不存在'),
  })

  it('只要有效的 Key', () => {
    const { options, failures } = debugKeyChoices(
      [client('a')],
      [loaded(key('live'), key('voided', false))],
    )
    expect(options.map((o) => o.key.id)).toEqual(['live'])
    expect(failures).toEqual([])
  })

  it('一个接入实例读取失败不挡别的接入实例，失败的单独说', () => {
    const { options, failures } = debugKeyChoices(
      [client('gone'), client('ok')],
      [failed(), loaded(key('k1'))],
    )
    expect(options.map((o) => [o.client.id, o.key.id])).toEqual([['ok', 'k1']])
    expect(failures.map((f) => [f.client.id, f.text])).toEqual([['gone', '接入实例不存在']])
  })

  it('读到过又刷新失败：手里的 Key 照样能选，错误也要说', () => {
    const { options, failures } = debugKeyChoices([client('a')], [failed([key('k1')])])
    expect(options.map((o) => o.key.id)).toEqual(['k1'])
    expect(failures).toHaveLength(1)
  })

  it('还在读的不算失败，也没有选项', () => {
    const { options, failures } = debugKeyChoices(
      [client('a')],
      [{ data: undefined, isError: false, error: null }],
    )
    expect(options).toEqual([])
    expect(failures).toEqual([])
  })
})

describe('各接入实例的调用量', () => {
  it('最长的一条占满，别的按平方根：小接入实例也看得清', () => {
    const bars = volumeBars([volume(900), volume(100), volume(0)])
    expect(bars.map((b) => Math.round(b.width))).toEqual([100, 33, 0])
  })

  it('一个接入实例都没有调用时不除以零', () => {
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

  it('总次数是各接入实例加起来', () => {
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

  it('六路都列出来，正值比例加起来是整条，负切面调制在条上占 0%', () => {
    const parts = scoreParts(
      candidate({
        semantic: 0.4,
        fulltext: 0.25,
        glossary: 0.15,
        priority: 0.1,
        facet: 0.05,
        link: 0.05,
      }),
    )
    expect(parts.map((p) => p.label)).toEqual(['向量', '全文', '关键词', '优先级', '切面', '关联'])
    expect(parts.map((p) => p.value)).toEqual([0.4, 0.25, 0.15, 0.1, 0.05, 0.05])
    expect(parts.reduce((a, p) => a + p.share, 0)).toBeCloseTo(100)

    const penalized = scoreParts(
      candidate({ semantic: 0.5, fulltext: 0.5, glossary: 0, priority: 0, facet: -0.06, link: 0 }),
    )
    expect(penalized.find((p) => p.label === '切面')).toEqual({
      label: '切面',
      value: -0.06,
      share: 0,
    })
    expect(penalized.reduce((a, p) => a + p.share, 0)).toBeCloseTo(100)
  })

  it('没走到的一路是 0；全是 0 时不除以零', () => {
    const parts = scoreParts(
      candidate({ semantic: 0, fulltext: 0, glossary: 0, priority: 0, facet: 0, link: 0 }),
    )
    expect(parts.every((p) => p.value === 0 && p.share === 0)).toBe(true)
  })
})
