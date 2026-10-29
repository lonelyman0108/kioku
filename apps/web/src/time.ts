const pad = (n: number) => String(n).padStart(2, '0')

// 界面里显示的相对时间：一周之内说「几分钟前」「几天前」，更早的给日期
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())}`
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

// 列表里放得下的本地时间：今年的不写年份，例如 10-31 18:00
export function formatShort(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const day = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.getFullYear() === now.getFullYear() ? day : `${d.getFullYear()}-${day}`
}

// datetime-local 输入框的值：本地时间，精确到分钟，没有时区（YYYY-MM-DDTHH:mm）
export function toLocalInput(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 有效到最早能选的时间：服务端要求比现在晚至少一分钟，输入框只到分钟（秒被截掉），所以从两分钟之后算
export function earliestValidTo(now: Date = new Date()): string {
  return toLocalInput(new Date(now.getTime() + 120_000).toISOString())
}

// 输入框里的本地时间换成带时区的 ISO 时间（接口要带时区的写法）；没填完整时为 null
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) return null
  // 没有时区的日期时间按本地时间解析
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// 有效到已经过去：这条记忆过期了，不再召回、不进 boot
export function isExpired(validTo: string | null, now: Date = new Date()): boolean {
  return validTo !== null && new Date(validTo).getTime() <= now.getTime()
}
