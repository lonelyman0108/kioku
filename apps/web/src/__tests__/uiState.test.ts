import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readStoredBoolean,
  readStoredEnum,
  readStoredString,
  subscribeStoredString,
  UI_STORAGE_KEYS,
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

  it('同标签页写入与跨标签页 storage 事件均会通知订阅者并支持退订', () => {
    installMemoryStorage()
    const storageHandlers = new Set<(event: StorageEvent) => void>()
    const originalWindow = globalThis.window
    vi.stubGlobal('window', {
      localStorage: originalWindow.localStorage,
      addEventListener: (type: string, fn: (event: StorageEvent) => void) => {
        if (type === 'storage') storageHandlers.add(fn)
      },
      removeEventListener: (type: string, fn: (event: StorageEvent) => void) => {
        if (type === 'storage') storageHandlers.delete(fn)
      },
    })

    const seen: (string | null)[] = []
    const unsubscribe = subscribeStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt, (value) => {
      seen.push(value)
    })

    writeStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt, '2026-11-27T04:00:00.000Z')
    writeStoredString(UI_STORAGE_KEYS.tasksClearedBefore, '2026-11-27T04:05:00.000Z')
    writeStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt, '   ')

    for (const handler of storageHandlers) {
      handler({
        key: UI_STORAGE_KEYS.inboxFailureDismissedAt,
        newValue: '2026-11-27T05:00:00.000Z',
      } as StorageEvent)
    }

    expect(seen).toEqual(['2026-11-27T04:00:00.000Z', null, '2026-11-27T05:00:00.000Z'])

    unsubscribe()
    expect(storageHandlers.size).toBe(0)
    writeStoredString(UI_STORAGE_KEYS.inboxFailureDismissedAt, '2026-11-27T06:00:00.000Z')
    expect(seen).toHaveLength(3)
  })

  it('重复调用退订保持幂等且不误删后续新订阅者，回调内退订也不影响其他订阅者', () => {
    installMemoryStorage()

    const firstSeen: (string | null)[] = []
    const secondSeen: (string | null)[] = []
    const thirdSeen: (string | null)[] = []

    const unsubFirst = subscribeStoredString(UI_STORAGE_KEYS.tasksClearedBefore, (value) => {
      firstSeen.push(value)
    })
    unsubFirst()

    const unsubSecond = subscribeStoredString(UI_STORAGE_KEYS.tasksClearedBefore, (value) => {
      secondSeen.push(value)
      unsubSecond()
    })
    const unsubThird = subscribeStoredString(UI_STORAGE_KEYS.tasksClearedBefore, (value) => {
      thirdSeen.push(value)
    })

    // 重复退订旧订阅者不应影响新注册的订阅者集合
    unsubFirst()

    writeStoredString(UI_STORAGE_KEYS.tasksClearedBefore, '2026-11-27T07:00:00.000Z')
    writeStoredString(UI_STORAGE_KEYS.tasksClearedBefore, '2026-11-27T08:00:00.000Z')

    expect(firstSeen).toEqual([])
    expect(secondSeen).toEqual(['2026-11-27T07:00:00.000Z'])
    expect(thirdSeen).toEqual(['2026-11-27T07:00:00.000Z', '2026-11-27T08:00:00.000Z'])

    unsubThird()
  })
})
