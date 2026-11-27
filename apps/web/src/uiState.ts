// 跨刷新持久化少量稳定的个人工作台偏好，存储受限时静默回退默认值

export const UI_STORAGE_KEYS = {
  editorView: 'kioku:editor:view',
  editorSyncScroll: 'kioku:editor:sync-scroll',
  historyDiffLayout: 'kioku:history:diff-layout',
  historyDiffContext: 'kioku:history:diff-context',
  tasksClearedBefore: 'kioku:tasks:cleared-before',
  tasksAckErrorAt: 'kioku:tasks:ack-error-at',
} as const

export function readStoredString(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key)
    return value && value.trim() ? value : null
  } catch {
    return null
  }
}

export function writeStoredString(key: string, value: string | null): void {
  try {
    if (value === null || !value.trim()) {
      window.localStorage.removeItem(key)
    } else {
      window.localStorage.setItem(key, value)
    }
  } catch {
    // 隐私模式或存储配额不足时忽略写入异常
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
