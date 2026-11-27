import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readStoredBoolean,
  readStoredEnum,
  readStoredString,
  writeStoredBoolean,
  writeStoredString,
} from '../uiState'

function installMemoryStorage() {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
  vi.stubGlobal('window', { localStorage: storage })
  return store
}

describe('uiState', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('读写字符串、枚举与布尔值并在非法值时回退默认', () => {
    installMemoryStorage()

    expect(readStoredString('k:str')).toBeNull()
    writeStoredString('k:str', '2026-11-27T00:00:00.000Z')
    expect(readStoredString('k:str')).toBe('2026-11-27T00:00:00.000Z')
    writeStoredString('k:str', null)
    expect(readStoredString('k:str')).toBeNull()

    writeStoredString('k:view', 'split')
    expect(readStoredEnum('k:view', ['edit', 'split', 'preview'] as const, 'edit')).toBe('split')
    writeStoredString('k:view', 'unknown')
    expect(readStoredEnum('k:view', ['edit', 'split', 'preview'] as const, 'edit')).toBe('edit')

    expect(readStoredBoolean('k:sync', true)).toBe(true)
    writeStoredBoolean('k:sync', false)
    expect(readStoredBoolean('k:sync', true)).toBe(false)
    writeStoredBoolean('k:sync', true)
    expect(readStoredBoolean('k:sync', false)).toBe(true)
  })

  it('存储抛异常时静默降级为默认值', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('quota')
        },
        removeItem: () => {
          throw new Error('blocked')
        },
      },
    })

    expect(() => writeStoredString('k:x', 'v')).not.toThrow()
    expect(readStoredString('k:x')).toBeNull()
    expect(readStoredEnum('k:x', ['a', 'b'] as const, 'a')).toBe('a')
    expect(readStoredBoolean('k:x', true)).toBe(true)
  })
})
