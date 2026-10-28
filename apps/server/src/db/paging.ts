import { sql, type SQLWrapper } from 'drizzle-orm'

// 时间换成微秒整数参与翻页比较：JS 的 Date 只到毫秒，比数据库的精度低，用它做游标会漏掉或重复条目
export const microsOf = (column: SQLWrapper) =>
  sql`(extract(epoch from ${column}) * 1000000)::bigint`

// 游标里的微秒整数换回时间，按微秒精确换算，不经过浮点
export const fromMicros = (micros: string) =>
  sql`('epoch'::timestamptz + ${micros}::bigint * interval '1 microsecond')`

// 微秒整数在 bigint 的范围里
export const MICROS = /^\d{1,18}$/

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}
