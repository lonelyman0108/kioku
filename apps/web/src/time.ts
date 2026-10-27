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
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())}`
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
