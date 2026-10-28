import { LAYERS, type KeyScopes } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { clampScopesToRole, keyEffectiveScopes } from '../access'

const full: KeyScopes = {
  readLayers: [...LAYERS],
  writeLayers: [...LAYERS],
  maxSensitivity: 'secret',
  admin: true,
}

describe('Key 上限随主人当前角色收紧', () => {
  it('owner 不变', () => {
    expect(clampScopesToRole(full, 'owner')).toEqual(full)
  })

  it('editor 失去 admin 与 secret', () => {
    expect(clampScopesToRole(full, 'editor')).toEqual({
      ...full,
      maxSensitivity: 'private',
      admin: false,
    })
  })

  it('viewer 只读', () => {
    expect(clampScopesToRole(full, 'viewer')).toEqual({
      ...full,
      writeLayers: [],
      maxSensitivity: 'private',
      admin: false,
    })
  })

  it('本来就低于上限的不会被抬高', () => {
    const low: KeyScopes = { ...full, maxSensitivity: 'public', admin: false }
    expect(clampScopesToRole(low, 'editor').maxSensitivity).toBe('public')
  })
})

describe('Key 当前的有效上限', () => {
  const issuedAt = new Date('2026-10-01T00:00:00Z')
  const key = { scopes: full, createdAt: issuedAt, revokedAt: null }
  const joined = new Date('2026-09-01T00:00:00Z')

  it('按主人当前的角色收紧', () => {
    expect(keyEffectiveScopes(key, { role: 'owner', memberSince: joined })).toEqual(full)
    expect(keyEffectiveScopes(key, { role: 'editor', memberSince: joined })).toEqual(
      clampScopesToRole(full, 'editor'),
    )
  })

  it('吊销、主人不在空间里、或主人重新加入之前签发的 Key 作废', () => {
    expect(
      keyEffectiveScopes({ ...key, revokedAt: new Date() }, { role: 'owner', memberSince: joined }),
    ).toBeNull()
    expect(keyEffectiveScopes(key, undefined)).toBeNull()
    expect(keyEffectiveScopes(key, { role: null, memberSince: null })).toBeNull()
    expect(
      keyEffectiveScopes(key, { role: 'owner', memberSince: new Date('2026-10-02T00:00:00Z') }),
    ).toBeNull()
  })
})
