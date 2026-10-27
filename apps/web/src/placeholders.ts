// 正文里的凭据占位符 {{cred:<标识>}} 与 {{cred:<标识>#<字段>}}：阅读时画成徽章，编辑时插入。
// 写法以 contracts 的 CREDENTIAL_PLACEHOLDER 为准，与服务端检查的是同一条
import { CREDENTIAL_PLACEHOLDER } from '@kioku/contracts'

export interface PlaceholderSegment {
  text: string
  // 有值表示这一段是占位符
  ref?: { identifier: string; field: string | null }
}

export function splitPlaceholders(text: string): PlaceholderSegment[] {
  const segments: PlaceholderSegment[] = []
  let last = 0
  for (const m of text.matchAll(new RegExp(CREDENTIAL_PLACEHOLDER.source, 'g'))) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index) })
    segments.push({ text: m[0], ref: { identifier: m[1]!, field: m[2] ?? null } })
    last = m.index + m[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}

export const placeholderOf = (identifier: string, field: string | null) =>
  `{{cred:${identifier}${field ? `#${field}` : ''}}}`
