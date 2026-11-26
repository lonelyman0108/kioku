import { z } from 'zod'

// 无歧义 Base30 字符集：排除 0/o/1/i/l/u，避免人工抄写混淆
export const SHORT_ID_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz'
export const SHORT_ID_PREFIX = 'm-'
export const SHORT_ID_LENGTH = 6
export const SHORT_ID_PATTERN = /^m-[2-9a-hjkmnp-tv-z]{6,8}$/
export const SHORT_ID_RE = SHORT_ID_PATTERN

export function normalizeShortId(value: string): string {
  return value.trim().toLowerCase()
}

export function isShortId(value: string): boolean {
  return SHORT_ID_PATTERN.test(normalizeShortId(value))
}

export const ShortId = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .pipe(z.string().regex(SHORT_ID_PATTERN, '短 ID 格式应为 m- 后接 6 到 8 位无歧义小写字母或数字'))
  .meta({ id: 'ShortId' })
export type ShortId = z.infer<typeof ShortId>

// 正文中的双链语法：[[m-xxxxxx]] 或 [[m-xxxxxx|显示文字]]
export const WIKI_LINK_REGEX = /\[\[(m-[2-9a-hjkmnp-tv-z]{6,8})(?:\|([^\]\r\n]{1,200}))?\]\]/gi
export const LINK_RELATION_MAX = 64
export const LINK_CONTEXT_MAX = 160

export interface ParsedWikiLink {
  targetShortId: string
  alias: string | null
  raw: string
  start: number
  end: number
}

export interface ExtractedEntryLink {
  targetShortId: string
  relation: string | null
  contextSnippet: string | null
}

function clipClean(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  let out = ''
  for (const ch of compact) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out.trim()
}

function extractLineSnippet(
  content: string,
  start: number,
  end: number,
  raw: string,
): string | null {
  const lineStart = content.lastIndexOf('\n', start - 1) + 1
  const nextNl = content.indexOf('\n', end)
  const lineEnd = nextNl === -1 ? content.length : nextNl
  const line = content
    .slice(lineStart, lineEnd)
    .replace(/\r$/, '')
    .replace(/^\s*(?:[-*+]|\d+\.|#{1,6}|>)\s+/, '')
    .trim()
  if (!line || line === raw.trim()) return null
  return clipClean(line, LINK_CONTEXT_MAX)
}

// 线性扫描正文提取双链，保持文本中出现的先后顺序
export function extractWikiLinks(content: string): ParsedWikiLink[] {
  const regex = new RegExp(WIKI_LINK_REGEX.source, 'gi')
  const result: ParsedWikiLink[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    const targetShortId = match[1]!.toLowerCase()
    const alias = match[2] !== undefined ? match[2].trim() || null : null
    result.push({
      targetShortId,
      alias,
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return result
}

// 提取去重后的目标短 ID 列表，供构建 entry_links 出链索引使用
export function extractTargetShortIds(content: string): string[] {
  const seen = new Set<string>()
  for (const item of extractWikiLinks(content)) {
    seen.add(item.targetShortId)
  }
  return [...seen]
}

// 提取去重后的双链及其关系语境与所在行片段，供写入 entry_links 与展示引用原因
export function extractEntryLinksWithContext(content: string): ExtractedEntryLink[] {
  const map = new Map<string, ExtractedEntryLink>()
  for (const item of extractWikiLinks(content)) {
    const relation = item.alias ? clipClean(item.alias, LINK_RELATION_MAX) || null : null
    const contextSnippet = extractLineSnippet(content, item.start, item.end, item.raw)
    const prev = map.get(item.targetShortId)
    if (!prev) {
      map.set(item.targetShortId, {
        targetShortId: item.targetShortId,
        relation,
        contextSnippet,
      })
    } else if (!prev.relation && relation) {
      prev.relation = relation
      if (!prev.contextSnippet && contextSnippet) prev.contextSnippet = contextSnippet
    } else if (!prev.contextSnippet && contextSnippet) {
      prev.contextSnippet = contextSnippet
    }
  }
  return [...map.values()]
}

export const ENTRY_LINK_DIRECTIONS = ['outgoing', 'incoming'] as const
export const EntryLinkDirection = z.enum(ENTRY_LINK_DIRECTIONS)
export type EntryLinkDirection = z.infer<typeof EntryLinkDirection>

// 凭据占位符语法：同时支持 {{cred:slug}} 与 {{cred:slug#field}}
export const CREDENTIAL_PLACEHOLDER_PREFIX = '{{cred:'
export const CREDENTIAL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const CREDENTIAL_SLUG_RE = CREDENTIAL_SLUG_PATTERN
export const CREDENTIAL_FIELD_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const CREDENTIAL_PLACEHOLDER_REGEX =
  /\{\{cred:([a-z0-9][a-z0-9._-]{0,63})(?:#([a-z0-9][a-z0-9_-]{0,63}))?\}\}/gi

export interface ParsedCredentialPlaceholder {
  slug: string
  field: string | null
  raw: string
  start: number
  end: number
}

export function extractCredentialPlaceholders(content: string): ParsedCredentialPlaceholder[] {
  const regex = new RegExp(CREDENTIAL_PLACEHOLDER_REGEX.source, 'gi')
  const result: ParsedCredentialPlaceholder[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    result.push({
      slug: match[1]!.toLowerCase(),
      field: match[2] ? match[2].toLowerCase() : null,
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return result
}

export function extractCredentialSlugs(content: string): string[] {
  const seen = new Set<string>()
  for (const item of extractCredentialPlaceholders(content)) {
    seen.add(item.slug)
  }
  return [...seen]
}
