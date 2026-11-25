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

export interface ParsedWikiLink {
  targetShortId: string
  alias: string | null
  raw: string
  start: number
  end: number
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
