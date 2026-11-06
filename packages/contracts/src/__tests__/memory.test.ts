import { describe, expect, it } from 'vitest'

import {
  bootEligible,
  CURATED_LAYERS,
  DEFAULT_SENSITIVITY,
  isBootCandidate,
  LAYERS,
  sensitivityAllowed,
} from '../memory'

describe('不给敏感级时的默认值', () => {
  it('本人默认私密、应用默认内部、人格与通用默认公开，每一类的默认都是这一类收的', () => {
    expect(DEFAULT_SENSITIVITY).toEqual({
      core: 'public',
      persona: 'public',
      app: 'internal',
      user: 'private',
    })
    for (const layer of CURATED_LAYERS) {
      expect(sensitivityAllowed(layer, DEFAULT_SENSITIVITY[layer]), layer).toBe(true)
    }
  })
})

describe('够格进启动加载的记忆', () => {
  const base = {
    form: 'curated',
    layer: 'core',
    priority: 0,
    provenance: 'owner',
    sensitivity: 'public',
  } as const

  it('目录里的、归属与优先级够格、来源受信、不是机密才算', () => {
    expect(isBootCandidate(base)).toBe(true)
    expect(isBootCandidate({ ...base, form: 'extracted' })).toBe(false)
    expect(isBootCandidate({ ...base, priority: 1 })).toBe(false)
    expect(isBootCandidate({ ...base, layer: 'persona', priority: 1 })).toBe(true)
    expect(isBootCandidate({ ...base, layer: 'user', sensitivity: 'private' })).toBe(true)
    expect(isBootCandidate({ ...base, layer: 'subject' })).toBe(false)
    expect(isBootCandidate({ ...base, provenance: 'untrusted' })).toBe(false)
    expect(isBootCandidate({ ...base, sensitivity: 'secret' })).toBe(false)
  })

  it('记下的四类 priority 0 都进，人格与应用放宽到 1，来自对话的两类不进', () => {
    const eligible = LAYERS.map((layer) => [layer, bootEligible(layer, 0), bootEligible(layer, 1)])
    expect(eligible).toEqual([
      ['core', true, false],
      ['persona', true, true],
      ['app', true, true],
      ['user', true, false],
      ['subject', false, false],
      ['episode', false, false],
    ])
  })
})
