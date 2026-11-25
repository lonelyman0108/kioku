// 正文里的凭据占位符 {{cred:<标识>}} 与 {{cred:<标识>#<字段>}}：阅读时画成徽章，编辑时插入
import { CREDENTIAL_PLACEHOLDER_REGEX } from '@kioku/contracts'

export interface PlaceholderSegment {
  text: string
  ref?: { slug: string; field: string | null }
}

export function splitPlaceholders(text: string): PlaceholderSegment[] {
  const segments: PlaceholderSegment[] = []
  let last = 0
  for (const m of text.matchAll(new RegExp(CREDENTIAL_PLACEHOLDER_REGEX.source, 'gi'))) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index) })
    segments.push({
      text: m[0],
      ref: { slug: m[1]!.toLowerCase(), field: m[2] ? m[2].toLowerCase() : null },
    })
    last = m.index + m[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}

export const placeholderOf = (slug: string, field: string | null = null) =>
  `{{cred:${slug}${field ? `#${field}` : ''}}}`
