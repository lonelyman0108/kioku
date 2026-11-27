// 跨刷新持久化少量稳定的个人工作台偏好，存储受限时静默回退默认值

export const UI_STORAGE_KEYS = {
  editorView: 'kioku:editor:view',
  editorSyncScroll: 'kioku:editor:sync-scroll',
  historyDiffLayout: 'kioku:history:diff-layout',
  historyDiffContext: 'kioku:history:diff-context',
  tasksClearedBefore: 'kioku:tasks:cleared-before',
  tasksAckErrorAt: 'kioku:tasks:ack-error-at',
  inboxFailureDismissedAt: 'kioku:inbox:failure-dismissed-at',
} as const

type StoredStringListener = (value: string | null) => void

const storageListeners = new Map<string, Set<StoredStringListener>>()

function normalizeStoredValue(value: string | null): string | null {
  return value && value.trim() ? value : null
}

function notifyStoredString(key: string, value: string | null): void {
  const listeners = storageListeners.get(key)
  if (!listeners) return
  for (const listener of [...listeners]) {
    listener(value)
  }
}

export function readStoredString(key: string): string | null {
  try {
    return normalizeStoredValue(window.localStorage.getItem(key))
  } catch {
    return null
  }
}

export function writeStoredString(key: string, value: string | null): void {
  const normalized = normalizeStoredValue(value)
  try {
    if (normalized === null) {
      window.localStorage.removeItem(key)
    } else {
      window.localStorage.setItem(key, normalized)
    }
  } catch {
    // 隐私模式或存储配额不足时忽略写入异常
  }
  notifyStoredString(key, normalized)
}

export function subscribeStoredString(key: string, listener: StoredStringListener): () => void {
  let set = storageListeners.get(key)
  if (!set) {
    set = new Set()
    storageListeners.set(key, set)
  }
  set.add(listener)

  const onStorage = (event: StorageEvent) => {
    if (event.key === key) {
      listener(normalizeStoredValue(event.newValue))
    } else if (event.key === null) {
      listener(readStoredString(key))
    }
  }
  const hasWindowEvents =
    typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  if (hasWindowEvents) {
    window.addEventListener('storage', onStorage)
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    set.delete(listener)
    if (set.size === 0 && storageListeners.get(key) === set) {
      storageListeners.delete(key)
    }
    if (hasWindowEvents) {
      window.removeEventListener('storage', onStorage)
    }
  }
}

export function readStoredEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readStoredString(key)
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

export function readStoredBoolean(key: string, fallback: boolean): boolean {
  const raw = readStoredString(key)
  if (raw === '1' || raw === 'true') return true
  if (raw === '0' || raw === 'false') return false
  return fallback
}

export function writeStoredBoolean(key: string, value: boolean): void {
  writeStoredString(key, value ? '1' : '0')
}
