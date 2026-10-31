import type { ActivityItem } from '@kioku/contracts'

import { localDate } from './time'

// 一天的小标题：今天、昨天，更早的写日期，今年的不写年份。都按本地时间算
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const key = localDate(d)
  if (key === localDate(now)) return '今天'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (key === localDate(yesterday)) return '昨天'
  return d.getFullYear() === now.getFullYear() ? key.slice(5) : key
}

export interface ActivityDay {
  key: string
  label: string
  items: ActivityItem[]
}

// 变更记录按本地日期分组。接口按时间倒序给，翻页时后面的页接在同一天后面，组的先后和里面的先后都不动
export function groupByDay(items: readonly ActivityItem[], now: Date = new Date()): ActivityDay[] {
  const days = new Map<string, ActivityDay>()
  for (const item of items) {
    const key = localDate(new Date(item.createdAt))
    const day = days.get(key)
    if (day) day.items.push(item)
    else days.set(key, { key, label: dayLabel(item.createdAt, now), items: [item] })
  }
  return [...days.values()]
}
