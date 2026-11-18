import { describe, expect, it } from 'vitest'

import {
  bootEligible,
  CIRCLE_KINDS,
  CREDENTIAL_CAPABILITIES,
  DEFAULT_SENSITIVITY,
  ENTRY_KINDS,
  isBootCandidate,
  minSensitivity,
  sensitivityAllowed,
  sensitivityRank,
  STRATA_BANDS,
} from '../memory'

describe('缺省敏感级与允许组合', () => {
  it('个人圈默认私密、共享圈默认内部，个人圈允许显式设为公开', () => {
    expect(DEFAULT_SENSITIVITY).toEqual({
      personal: 'private',
      shared: 'internal',
    })
    for (const circleKind of CIRCLE_KINDS) {
      expect(sensitivityAllowed(circleKind, 'entry', DEFAULT_SENSITIVITY[circleKind])).toBe(true)
    }
    expect(sensitivityAllowed('personal', 'entry', 'public')).toBe(true)
    expect(sensitivityAllowed('shared', 'entry', 'secret')).toBe(true)
    expect(sensitivityAllowed('shared', 'episode', 'secret')).toBe(false)
    expect(sensitivityAllowed('shared', 'fact', 'secret', 'untrusted')).toBe(false)
  })

  it('敏感级排序与取小值一致', () => {
    expect(sensitivityRank('public')).toBeLessThan(sensitivityRank('secret'))
    expect(minSensitivity('internal', 'private')).toBe('internal')
    expect(minSensitivity('secret', 'public')).toBe('public')
  })

  it('地层 6 色带与凭据能力固定定义', () => {
    expect(STRATA_BANDS).toEqual([
      'episode',
      'fact',
      'personal',
      'shared-away',
      'persona',
      'primary',
    ])
    expect(CREDENTIAL_CAPABILITIES).toEqual(['none', 'use', 'manage'])
  })
})

describe('启动加载筛选规则', () => {
  const base = {
    kind: 'entry',
    priority: 0,
    provenance: 'owner',
    sensitivity: 'public',
  } as const

  it('仅正式词条、受信来源、非机密且优先级为 0 进入启动加载', () => {
    expect(isBootCandidate(base)).toBe(true)
    expect(isBootCandidate({ ...base, priority: 1 })).toBe(false)
    expect(isBootCandidate({ ...base, kind: 'fact' })).toBe(false)
    expect(isBootCandidate({ ...base, kind: 'episode' })).toBe(false)
    expect(isBootCandidate({ ...base, provenance: 'untrusted' })).toBe(false)
    expect(isBootCandidate({ ...base, sensitivity: 'secret' })).toBe(false)
  })

  it('bootEligible 仅对 priority === 0 的 entry 为真', () => {
    const eligible = ENTRY_KINDS.map((kind) => [kind, bootEligible(kind, 0), bootEligible(kind, 1)])
    expect(eligible).toEqual([
      ['entry', true, false],
      ['fact', false, false],
      ['episode', false, false],
    ])
  })
})
