import type { PersonaNode } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { sameScopes } from '../components/keyPresets'
import { lostFromBoot } from '../personas'

const node = (uri: string, priority: number, overriddenBy: string | null = null): PersonaNode => ({
  uri,
  personaId: '00000000-0000-4000-8000-000000000000',
  priority,
  sensitivity: 'public',
  disclosure: null,
  overriddenBy,
})

describe('被覆盖之后会不会从启动上下文里消失', () => {
  it('祖先那条会进启动上下文、覆盖它的那条进不了时给出那条的 priority', () => {
    const child = node('persona://child/soul', 2)
    const parent = node('persona://parent/soul', 0, child.uri)
    expect(lostFromBoot(parent, [child, parent])).toBe(2)
  })

  it('覆盖它的那条也进启动上下文、祖先那条本来就进不了、或没被覆盖时不提示', () => {
    const child = node('persona://child/soul', 1)
    expect(lostFromBoot(node('persona://parent/soul', 0, child.uri), [child])).toBeNull()
    const low = node('persona://child/tone', 3)
    expect(lostFromBoot(node('persona://parent/tone', 2, low.uri), [low])).toBeNull()
    expect(lostFromBoot(node('persona://parent/habit', 0), [])).toBeNull()
  })
})

describe('两组 Key 权限是否相同', () => {
  const scopes = {
    readLayers: ['base', 'private'] as const,
    writeLayers: ['private'] as const,
    maxSensitivity: 'private' as const,
    admin: false,
  }
  it('层的先后不算', () => {
    expect(
      sameScopes(
        { ...scopes, readLayers: ['base', 'private'], writeLayers: ['private'] },
        { ...scopes, readLayers: ['private', 'base'], writeLayers: ['private'] },
      ),
    ).toBe(true)
  })
  it('敏感级、admin 或层不同就不同', () => {
    const base = {
      ...scopes,
      readLayers: [...scopes.readLayers],
      writeLayers: [...scopes.writeLayers],
    }
    expect(sameScopes(base, { ...base, maxSensitivity: 'secret' })).toBe(false)
    expect(sameScopes(base, { ...base, admin: true })).toBe(false)
    expect(sameScopes(base, { ...base, writeLayers: [] })).toBe(false)
  })
})
