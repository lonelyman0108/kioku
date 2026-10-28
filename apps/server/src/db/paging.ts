import { sql, type SQLWrapper } from 'drizzle-orm'

// 时间换成微秒整数参与翻页比较：JS 的 Date 只到毫秒，比数据库的精度低，用它做游标会漏掉或重复条目
export const microsOf = (column: SQLWrapper) =>
  sql`(extract(epoch from ${column}) * 1000000)::bigint`

// 游标里的微秒整数换回时间，按微秒精确换算，不经过浮点
export const fromMicros = (micros: string) =>
  sql`('epoch'::timestamptz + ${micros}::bigint * interval '1 microsecond')`

// 微秒整数在 bigint 的范围里
export const MICROS = /^\d{1,18}$/

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const INVALID_CURSOR = '翻页参数无效，请从第一页重新开始'

// 游标是 base64url 编码的 JSON 数组；解不开或不是数组时返回 'invalid'
export function parseCursor(cursor: string): unknown[] | 'invalid' {
  try {
    const values: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    return Array.isArray(values) ? values : 'invalid'
  } catch {
    return 'invalid'
  }
}

// 「时间 + id」的游标：上一页最后一条的微秒时间与 id
export function encodeTimeCursor(micros: string, id: string): string {
  return Buffer.from(JSON.stringify([micros, id])).toString('base64url')
}

// 没有游标时返回 null；解不开时返回 'invalid'，由调用方按自己的方式报 400
export function decodeTimeCursor(
  cursor: string | undefined,
  id: RegExp,
): [string, string] | null | 'invalid' {
  if (!cursor) return null
  const values = parseCursor(cursor)
  if (
    values === 'invalid' ||
    values.length !== 2 ||
    typeof values[0] !== 'string' ||
    !MICROS.test(values[0]) ||
    typeof values[1] !== 'string' ||
    !id.test(values[1])
  ) {
    return 'invalid'
  }
  return [values[0], values[1]]
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}
