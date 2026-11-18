import {
  deriveEntryTitle,
  ENTRY_TITLE_MAX,
  firstMarkdownHeading,
  type Sensitivity,
} from '@kioku/contracts'

import { mentionsPlaceholder } from '../credential/placeholders'

// 兼容第 8 期迁入器尚未重构前的旧坐标类型定义；新版服务改以短 ID 替代路径坐标
export type LegacyCuratedLayer = 'user' | 'core' | 'app' | 'persona'

const LEGACY_URI_PATTERN =
  /^(user|core|app|persona):\/\/([a-z0-9_-]{1,64}(?:\/[a-z0-9_-]{1,64}){0,15})$/

export interface ParsedUri {
  domain: LegacyCuratedLayer
  path: string
  namespaceSlug: string | null
}

export const PERSONA_DOMAIN = 'persona'
export const APP_DOMAIN = 'app'

export function parseUri(uri: string): ParsedUri | null {
  const match = LEGACY_URI_PATTERN.exec(uri)
  if (!match) return null
  return toParsed(match[1] as LegacyCuratedLayer, match[2]!)
}

export function toParsed(domain: LegacyCuratedLayer, path: string): ParsedUri {
  const namespaced = domain === PERSONA_DOMAIN || domain === APP_DOMAIN
  return { domain, path, namespaceSlug: namespaced ? path.split('/')[0]! : null }
}

export function formatUri(domain: string, path: string): string {
  return `${domain}://${path}`
}

export function layerOf(parsed: ParsedUri): LegacyCuratedLayer {
  return parsed.domain
}

export function identifierOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function firstHeading(content: string): string | null {
  const heading = firstMarkdownHeading(content)
  if (!heading || mentionsPlaceholder(heading)) return null
  if (heading.length <= ENTRY_TITLE_MAX) return heading
  let out = ''
  for (const point of heading) {
    if (out.length + point.length > ENTRY_TITLE_MAX) break
    out += point
  }
  return out.trim()
}

export function deriveTitle(content: string, path: string, sensitivity: Sensitivity): string {
  return deriveEntryTitle(undefined, [{ content }], identifierOf(path), sensitivity)
}

export function headingsOf(contents: Iterable<unknown>): Set<string> {
  const headings = new Set<string>()
  for (const content of contents) {
    const heading = typeof content === 'string' ? firstHeading(content) : null
    if (heading) headings.add(heading)
  }
  return headings
}

export function withoutHeading(title: string, path: string, headings: ReadonlySet<string>): string {
  return headings.has(title) ? identifierOf(path) : title
}
