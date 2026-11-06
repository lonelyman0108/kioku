import {
  MEMORY_TITLE_MAX,
  URI_PATTERN,
  type CuratedLayer,
  type Layer,
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

// 不给敏感级时按归属取；本人不设公开，不给时按私密，宁可收得紧
export const DEFAULT_SENSITIVITY: Record<Layer, Sensitivity> = {
  core: 'public',
  persona: 'public',
  app: 'internal',
  user: 'private',
  subject: 'public',
  episode: 'public',
}

// Markdown 的标题行（# 到 ######），代码块里的不算
const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
// 换成空格的控制字符：标题里不能有
const CONTROL = /\p{Cc}+/gu

// 不给标题时的标题：正文里第一个 # 标题，没有就用标识。机密的正文是加密的、标题是明文，
// 不从正文里取；标题里带凭据占位符的也不取（占位符只能写在正文里）。截到上限时不切开代理对
export function deriveTitle(content: string, path: string, sensitivity: Sensitivity): string {
  if (sensitivity !== 'secret') {
    let fence: string | null = null
    for (const line of content.split('\n')) {
      const opened = FENCE.exec(line)?.[1]
      if (opened && (fence === null || opened[0] === fence[0])) {
        fence = fence === null ? opened : null
        continue
      }
      if (fence !== null) continue
      const heading = HEADING.exec(line)?.[1]?.replace(CONTROL, ' ').trim()
      if (heading && !mentionsPlaceholder(heading)) return clip(heading)
      if (heading) break
    }
  }
  return identifierOf(path)
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
