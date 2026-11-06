import {
  MEMORY_TITLE_MAX,
  URI_PATTERN,
  type CuratedLayer,
  type Sensitivity,
} from '@kioku/contracts'

import { mentionsPlaceholder } from '../credential/placeholders'

// 坐标拆开的样子：开头（domain，就是归属）与开头之后的整段（path）
export interface ParsedUri {
  domain: CuratedLayer
  path: string
  // persona:// 与 app:// 下第一段是人格或应用的标识
  namespaceSlug: string | null
}

export const PERSONA_DOMAIN = 'persona'
export const APP_DOMAIN = 'app'

export function parseUri(uri: string): ParsedUri | null {
  const match = URI_PATTERN.exec(uri)
  if (!match) return null
  return toParsed(match[1] as CuratedLayer, match[2]!)
}

// 已经拆开的 domain 与 path（例如从数据库读出的一行），不必再拼成字符串重新解析
export function toParsed(domain: CuratedLayer, path: string): ParsedUri {
  const namespaced = domain === PERSONA_DOMAIN || domain === APP_DOMAIN
  return { domain, path, namespaceSlug: namespaced ? path.split('/')[0]! : null }
}

export function formatUri(domain: string, path: string): string {
  return `${domain}://${path}`
}

// 坐标的开头就是归属（见 contracts 的 CURATED_LAYERS），四种开头以外的坐标解析不出来
export function layerOf(parsed: ParsedUri): CuratedLayer {
  return parsed.domain
}

// 标识：坐标的最后一段
export function identifierOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

// Markdown 的标题行（# 到 ######），代码块里的不算
const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
// 代码块的围栏（照 CommonMark）：缩进不到四格，三个以上的 ` 或 ~，后面是信息串
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
// 换成空格的控制字符：标题里不能有
const CONTROL = /\p{Cc}+/gu

// 正文里第一个 # 标题，取不出来时为 null：没有 # 标题，或者第一个 # 标题里带凭据占位符（占位符只能写在正文里）。
// 行尾的 \r（Windows 的换行）先去掉再认。代码块里的不算，代码块照 CommonMark 认：` 开头的围栏信息串里不能有 `；
// 结束的围栏是同一种字符、不短于开头的，后面除了空格与制表符没有别的；没有结束的代码块一直到正文结尾。
// 截到上限时不切开代理对
export function firstHeading(content: string): string | null {
  let fence: string | null = null
  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const [, marker, info = ''] = FENCE.exec(line) ?? []
    if (fence !== null) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && /^[ \t]*$/.test(info)) fence = null
      continue
    }
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = marker
      continue
    }
    const heading = HEADING.exec(line)?.[1]?.replace(CONTROL, ' ').trim()
    if (heading) return mentionsPlaceholder(heading) ? null : clip(heading)
  }
  return null
}

// 不给标题时的标题：正文里第一个 # 标题，没有就用标识。机密的正文是加密的、标题是明文，不从正文里取
export function deriveTitle(content: string, path: string, sensitivity: Sensitivity): string {
  return (sensitivity !== 'secret' && firstHeading(content)) || identifierOf(path)
}

// 几段正文各自的第一个 # 标题（不是字符串的跳过）
export function headingsOf(contents: Iterable<unknown>): Set<string> {
  const headings = new Set<string>()
  for (const content of contents) {
    const heading = typeof content === 'string' ? firstHeading(content) : null
    if (heading) headings.add(heading)
  }
  return headings
}

// 机密记忆的标题：等于正文（headings 是这条记忆各版明文正文的 # 标题）第一个 # 标题的换成标识。没给标题时标题就是
// 从正文取的，正文加密、历史抹掉之后它还以明文留在标题、全文检索与快照里；分不清是取的还是照抄的，一律换。
// 别的标题照旧，和触发场景、关键词一样是明文
export function withoutHeading(title: string, path: string, headings: ReadonlySet<string>): string {
  return headings.has(title) ? identifierOf(path) : title
}

// 和契约里的长度上限一样按 UTF-16 码元算，按码点往里放
function clip(text: string): string {
  if (text.length <= MEMORY_TITLE_MAX) return text
  let out = ''
  for (const point of text) {
    if (out.length + point.length > MEMORY_TITLE_MAX) break
    out += point
  }
  return out.trim()
}
