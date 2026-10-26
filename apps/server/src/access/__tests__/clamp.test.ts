import { LAYERS, type KeyScopes } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { clampScopesToRole } from '../access'

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
