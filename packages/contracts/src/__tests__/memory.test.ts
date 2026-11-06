import { describe, expect, it } from 'vitest'

import { isBootCandidate } from '../memory'

describe('够格进启动加载的记忆', () => {
  const base = { layer: 'base', priority: 0, provenance: 'owner', sensitivity: 'public' } as const

  it('层与优先级够格、来源受信、不是机密才算', () => {
    expect(isBootCandidate(base)).toBe(true)
    expect(isBootCandidate({ ...base, priority: 1 })).toBe(false)
    expect(isBootCandidate({ ...base, layer: 'persona', priority: 1 })).toBe(true)
    expect(isBootCandidate({ ...base, layer: 'subject' })).toBe(false)
    expect(isBootCandidate({ ...base, provenance: 'untrusted' })).toBe(false)
    expect(isBootCandidate({ ...base, sensitivity: 'secret' })).toBe(false)
  })
})
