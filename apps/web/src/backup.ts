import type { OverviewBackup } from '@kioku/contracts'

// 每天几点（UTC）做备份：选项里同时给出浏览器所在时区的钟点。按今天换算，夏令时的地区也对得上
export function hourLabel(hour: number, today: Date = new Date()): string {
  const at = new Date(today)
  at.setUTCHours(hour, 0, 0, 0)
  const local = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `${String(hour).padStart(2, '0')}:00 UTC（本地 ${local}）`
}

// 没设置过时默认本地凌晨 3 点：换成 UTC 的钟点
export function defaultHour(today: Date = new Date()): number {
  const at = new Date(today)
  at.setHours(3, 0, 0, 0)
  return at.getUTCHours()
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// 超过这么久没做成一份就提醒：每天一份，留一天的余量
const STALE_MS = 2 * 24 * 3600_000

// 最近的错误是没做成（比最近一份成功晚），还是做成之后的提醒（和那份成功同时记下）
export function errorKind(
  lastSuccessAt: string | null,
  lastError: { at: string } | null,
): 'error' | 'warning' | null {
  if (!lastError) return null
  return lastSuccessAt && lastError.at <= lastSuccessAt ? 'warning' : 'error'
}

export interface BackupNotice {
  color: 'error' | 'warning' | 'info'
  title: string
  description: string
}

// 概览里给实例管理员的提醒：没配备份、出了错、好几天没做成。都正常时返回 null
export function backupNotice(
  backup: OverviewBackup | null,
  now: Date = new Date(),
): BackupNotice | null {
  if (!backup) return null
  if (!backup.configured) {
    return {
      color: 'info',
      title: '还没配备份',
      description:
        '数据只在这台服务器的数据库里。在实例设置里配一个兼容S3的对象存储，每天自动加密备份。',
    }
  }
  const { lastSuccessAt, lastError } = backup
  const kind = errorKind(lastSuccessAt, lastError)
  if (kind === 'error') {
    return {
      color: 'error',
      title: '备份没做成',
      description: `${lastError!.message}。下一个小时会再试，详情见实例设置。`,
    }
  }
  if (!lastSuccessAt) {
    return {
      color: 'info',
      title: '还没做过备份',
      description: '保存设置之后一个小时内会做第一份，也可以在实例设置里立即备份。',
    }
  }
  const age = now.getTime() - new Date(lastSuccessAt).getTime()
  if (age > STALE_MS) {
    return {
      color: 'warning',
      title: '好几天没有新的备份',
      description: `最近一份做于 ${Math.floor(age / (24 * 3600_000))} 天前，备份按天做，去实例设置里看看最近的结果。`,
    }
  }
  // 做成之后的提醒（例如删旧备份出错）：好几天没有新的一份时先说那个
  if (kind === 'warning') {
    return { color: 'warning', title: '备份做成了，但有提醒', description: lastError!.message }
  }
  return null
}
