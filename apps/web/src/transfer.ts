import {
  KiokuExportBundle,
  LORE_BACKUP_FORMAT,
  LORE_BACKUP_TABLES,
  TRANSFER_UPLOAD_MAX_BYTES,
  type LoreBackupUpload,
} from '@kioku/contracts'

export class TransferFileError extends Error {}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

// 浏览器端裁剪 Lore 导出：只保留需要的五张表，剥离 app_settings 等敏感表与已废弃正文
export function trimLoreBackup(raw: unknown): LoreBackupUpload {
  const data = raw as { format?: unknown; created_at?: unknown; tables?: unknown } | null
  if (data?.format !== LORE_BACKUP_FORMAT) {
    throw new TransferFileError('不是 Lore 的导出文件')
  }
  if (typeof data.created_at !== 'string') {
    throw new TransferFileError('导出文件缺少导出时间')
  }
  const from = (data.tables ?? {}) as Record<string, unknown>
  const rowsOf = (table: string): Record<string, unknown>[] => {
    const rows = from[table]
    if (!Array.isArray(rows)) {
      throw new TransferFileError(`导出文件缺少 ${table} 表`)
    }
    return rows as Record<string, unknown>[]
  }
  const tables = Object.fromEntries(
    LORE_BACKUP_TABLES.map((table) => [table, rowsOf(table)]),
  ) as LoreBackupUpload['tables']

  tables.memories = tables.memories.map((row) => {
    if (row.deprecated === false) return row
    const rest = { ...row }
    delete rest.content
    return rest
  })

  return { format: LORE_BACKUP_FORMAT, created_at: data.created_at, tables }
}

export async function readLoreBackupFile(file: File): Promise<LoreBackupUpload> {
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    throw new TransferFileError('无法读取此文件，或文件不是合法 JSON')
  }
  const trimmed = trimLoreBackup(raw)
  const size = new TextEncoder().encode(JSON.stringify(trimmed)).length
  if (size > TRANSFER_UPLOAD_MAX_BYTES) {
    throw new TransferFileError(
      `裁剪后仍有 ${formatSize(size)}，超过 ${formatSize(TRANSFER_UPLOAD_MAX_BYTES)} 上限`,
    )
  }
  return trimmed
}

export async function readKiokuBackupFile(file: File): Promise<{
  bundle: KiokuExportBundle
  hasEncryptedCredentials: boolean
}> {
  if (file.size > TRANSFER_UPLOAD_MAX_BYTES) {
    throw new TransferFileError(
      `文件大小 ${formatSize(file.size)} 超过 ${formatSize(TRANSFER_UPLOAD_MAX_BYTES)} 上限`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    throw new TransferFileError('无法读取此文件，或文件不是合法 JSON')
  }
  const parsed = KiokuExportBundle.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? '格式不符合 Kioku 导出文件规范'
    throw new TransferFileError(`文件校验失败：${detail}`)
  }
  return {
    bundle: parsed.data,
    hasEncryptedCredentials: Boolean(parsed.data.encryptedCredentials),
  }
}

function isInternalHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!name.includes('.') && !name.includes(':')) return true
  if (/\.(local|internal|lan|home\.arpa)$/.test(name)) return true
  if (name.includes(':')) return /^(::1$|f[cd]|fe[89ab])/.test(name)
  const octets = name.split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n))) return false
  const [a, b] = octets as [number, number, number, number]
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

// 非内网 http 地址发送 API Token 会经明文传输，界面据此提示
export function tokenInClear(address: string): boolean {
  try {
    const url = new URL(address.trim())
    return url.protocol === 'http:' && !isInternalHost(url.hostname)
  } catch {
    return false
  }
}
