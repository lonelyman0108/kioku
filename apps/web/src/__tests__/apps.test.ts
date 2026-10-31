import type { BootPreview, KeyInfo, KeyScopes } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { bootUsage, effectiveNote, isNarrowed, lastUsedAt } from '../apps'

const scopes = (over: Partial<KeyScopes> = {}): KeyScopes => ({
  readLayers: ['base'],
  writeLayers: ['base'],
  maxSensitivity: 'internal',
  admin: false,
  ...over,
})
const key = (over: Partial<KeyInfo> = {}): KeyInfo => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'k',
  prefix: 'kk_a',
  scopes: scopes(),
  effectiveScopes: scopes(),
  createdAt: '2026-10-01T00:00:00Z',
  lastUsedAt: null,
  revokedAt: null,
  ...over,
})

describe('最近使用', () => {
  it('取没吊销的 Key 里最晚的；都没用过是 null', () => {
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
    const narrowed = key({ effectiveScopes: scopes({ writeLayers: [] }) })
    expect(isNarrowed(narrowed)).toBe(true)
    expect(effectiveNote(narrowed)).toBe(
      '当前有效范围：可读 1 层，可写 0 层，最高内部（已按所有者当前角色收紧）',
    )
  })

  it('所有者离开空间时说已作废，不算收紧', () => {
    const voided = key({ effectiveScopes: null })
    expect(isNarrowed(voided)).toBe(false)
    expect(effectiveNote(voided)).toBe('已作废：应用所有者已不在此空间')
  })

  it('吊销了的不再说', () => {
    const revoked = key({ effectiveScopes: null, revokedAt: '2026-10-10T00:00:00Z' })
    expect(isNarrowed(revoked)).toBe(false)
    expect(effectiveNote(revoked)).toBeNull()
  })
})

describe('启动加载的用量条', () => {
  const preview = (over: Partial<BootPreview>): BootPreview => ({
    runtimeFamily: 'claudecode',
    limit: 1000,
    context: 'x'.repeat(500),
    entries: [
      { uri: 'core://a', layer: 'base', chars: 100 },
      { uri: 'persona://b', layer: 'persona', chars: 300 },
    ],
    omitted: [],
    recent: [],
    related: [],
    dropped: [],
    ...over,
  })

  it('整条是客户端能完整接收的字数，每个节点一段，别的部分单算', () => {
    const usage = bootUsage(preview({}))
    expect(usage.used).toBe(500)
    expect(usage.limit).toBe(1000)
    expect(usage.segments.map((s) => s.width)).toEqual([10, 30])
    expect(usage.segments.map((s) => s.layer)).toEqual(['base', 'persona'])
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

  it('节点的字数加起来超过用量时，别的部分是 0，不是负数', () => {
    const usage = bootUsage(preview({ context: 'x'.repeat(100) }))
    expect(usage.other).toBe(0)
  })

  it('什么都没有时不除以零', () => {
    const usage = bootUsage(preview({ limit: null, context: '', entries: [] }))
    expect(usage.segments).toEqual([])
    expect(usage.other).toBe(0)
  })
})
