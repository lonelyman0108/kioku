import { ENTRY_KINDS, type BootPreview, type KeyInfo, type LensKeyScopes } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { bootUsage, effectiveNote, isNarrowed, lastUsedAt, simulatorState } from '../apps'

const CIRCLE = '00000000-0000-4000-8000-0000000000s1'
const CLIENT = '00000000-0000-4000-8000-0000000000c1'

const scopes = (over: Partial<LensKeyScopes> = {}): LensKeyScopes => ({
  readKinds: ['entry'],
  writeKinds: ['entry'],
  maxSensitivity: 'internal',
  allowedRealms: null,
  admin: false,
  credentials: 'none' as const,
  ...over,
})
const key = (over: Partial<KeyInfo> = {}): KeyInfo => ({
  id: '00000000-0000-4000-8000-000000000001',
  clientId: CLIENT,
  name: 'k',
  prefix: 'kk_a',
  linkedCircles: [],
  contextFacets: {},
  personaOverrideId: null,
  scopes: scopes(),
  effectiveScopes: scopes(),
  circleGrants: [],
  createdAt: '2026-10-01T00:00:00Z',
  lastUsedAt: null,
  revokedAt: null,
  ...over,
})

describe('最近使用', () => {
  it('取没吊销的访问密钥里最晚的；都没用过是 null', () => {
    expect(lastUsedAt([])).toBeNull()
    expect(lastUsedAt([key()])).toBeNull()
    expect(
      lastUsedAt([
        key({ lastUsedAt: '2026-10-02T00:00:00Z' }),
        key({ lastUsedAt: '2026-10-03T00:00:00Z' }),
        key({ lastUsedAt: '2026-10-09T00:00:00Z', revokedAt: '2026-10-10T00:00:00Z' }),
      ]),
    ).toBe('2026-10-03T00:00:00Z')
  })
})

describe('签发上限和当前有效上限', () => {
  it('一样时不说', () => {
    expect(isNarrowed(key())).toBe(false)
    expect(effectiveNote(key())).toBeNull()
  })

  it('所有者被降级时写出当前有效范围', () => {
    const narrowed = key({ effectiveScopes: scopes({ writeKinds: [] }) })
    expect(isNarrowed(narrowed)).toBe(true)
    expect(effectiveNote(narrowed)).toBe(
      '当前有效范围：读 1 类，写 0 类，至内部（已按所有者当前角色收紧）',
    )
  })

  it('所有者离开记忆圈时说已作废，不算收紧', () => {
    const voided = key({ effectiveScopes: null })
    expect(isNarrowed(voided)).toBe(false)
    expect(effectiveNote(voided)).toBe('已作废：接入实例所有者已不在此记忆圈')
  })

  it('吊销了的不再说', () => {
    const revoked = key({ effectiveScopes: null, revokedAt: '2026-10-10T00:00:00Z' })
    expect(isNarrowed(revoked)).toBe(false)
    expect(effectiveNote(revoked)).toBeNull()
  })
})

describe('启动加载这一块的情况', () => {
  it('有选中的访问密钥就能模拟，哪怕列表刷新失败了', () => {
    expect(simulatorState({ isPending: false, hasData: true }, 'k1')).toBe('ready')
    expect(simulatorState({ isPending: false, hasData: false }, 'k1')).toBe('ready')
  })

  it('读到了列表又没有选中的，才是没有有效访问密钥', () => {
    expect(simulatorState({ isPending: false, hasData: true }, undefined)).toBe('none')
  })

  it('还在读、读取失败时不能说没有有效访问密钥，不然可能多签一个', () => {
    expect(simulatorState({ isPending: true, hasData: false }, undefined)).toBe('loading')
    expect(simulatorState({ isPending: false, hasData: false }, undefined)).toBe('failed')
  })
})

describe('启动加载的用量条', () => {
  const preview = (over: Partial<BootPreview> = {}): BootPreview => ({
    runtimeFamily: 'claudecode',
    limit: 1000,
    context: 'x'.repeat(500),
    resolvedFacets: {},
    personaTraits: [],
    entries: [
      { shortId: 'm-0001', title: 'a', circleId: CIRCLE, circleSlug: 'main', chars: 100 },
      { shortId: 'm-0002', title: 'c', circleId: CIRCLE, circleSlug: null, chars: 300 },
    ],
    omitted: [],
    summaries: [],
    recent: [],
    related: [],
    dropped: [],
    ...over,
  })

  it('整条是客户端能完整接收的字数，每个词条一段，别的部分单算', () => {
    const usage = bootUsage(preview())
    expect(usage.used).toBe(500)
    expect(usage.limit).toBe(1000)
    expect(usage.segments.map((s) => s.width)).toEqual([10, 30])
    expect(usage.segments.map((s) => s.shortId)).toEqual(['m-0001', 'm-0002'])
    expect(usage.other).toBe(10)
    expect(usage.over).toBe(false)
  })

  it('没有上限时整条是用掉的字数', () => {
    const usage = bootUsage(preview({ limit: null }))
    expect(usage.segments.map((s) => s.width)).toEqual([20, 60])
    expect(usage.other).toBe(20)
    expect(usage.over).toBe(false)
  })

  it('超出上限时整条是用掉的字数，合起来不超过 100%', () => {
    const usage = bootUsage(preview({ limit: 400 }))
    expect(usage.over).toBe(true)
    const sum = usage.segments.reduce((a, s) => a + s.width, 0) + usage.other
    expect(sum).toBeCloseTo(100)
  })

  it('词条的字数加起来超过用量时，别的部分是 0，不是负数', () => {
    const usage = bootUsage(preview({ context: 'x'.repeat(100) }))
    expect(usage.other).toBe(0)
  })

  it('什么都没有时不除以零', () => {
    const usage = bootUsage(preview({ limit: null, context: '', entries: [] }))
    expect(usage.segments).toEqual([])
    expect(usage.other).toBe(0)
    expect(ENTRY_KINDS).toHaveLength(3)
  })
})
