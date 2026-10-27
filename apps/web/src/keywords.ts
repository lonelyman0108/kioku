// 正文里的关键词：别的记忆的关键词出现在这段文字里时标出来，点了跳过去。
// 匹配规则与服务端召回一致：纯 ASCII 的关键词按单词边界、不区分大小写，其余按子串；长的优先

export interface KeywordIndex {
  pattern: RegExp
  // 关键词（小写）→ 有这个关键词的记忆
  targets: Map<string, string[]>
}

const ASCII = /^[\x20-\x7e]+$/
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function buildKeywordIndex(
  entries: { keyword: string; uris: string[] }[],
): KeywordIndex | null {
  const targets = new Map<string, string[]>()
  for (const { keyword, uris } of entries) {
    const key = keyword.trim().toLowerCase()
    if (key.length < 2 || !uris.length) continue
    targets.set(key, [...new Set([...(targets.get(key) ?? []), ...uris])])
  }
  if (!targets.size) return null
  const alternatives = [...targets.keys()]
    .sort((x, y) => y.length - x.length || x.localeCompare(y))
    .map((k) =>
      ASCII.test(k) ? `(?<![A-Za-z0-9_])${escapeRegExp(k)}(?![A-Za-z0-9_])` : escapeRegExp(k),
    )
  return { pattern: new RegExp(alternatives.join('|'), 'gi'), targets }
}

export interface Segment {
  text: string
  // 有值表示这一段是关键词（小写）
  keyword?: string
}

export function splitByKeywords(text: string, index: KeywordIndex): Segment[] {
  const segments: Segment[] = []
  let last = 0
  index.pattern.lastIndex = 0
  for (const match of text.matchAll(index.pattern)) {
    const at = match.index
    if (at > last) segments.push({ text: text.slice(last, at) })
    segments.push({ text: match[0], keyword: match[0].toLowerCase() })
    last = at + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}
