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

const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

// 按 CommonMark 等长反引号规则扫描行内代码，仅在代码跨度之外执行替换回调
function replaceOutsideInlineCode(line: string, replacePlain: (segment: string) => string): string {
  if (!line.includes('`')) return replacePlain(line)
  let out = ''
  let plainStart = 0
  let i = 0
  const n = line.length

  while (i < n) {
    if (line[i] !== '`') {
      i++
      continue
    }
    const tickStart = i
    while (i < n && line[i] === '`') i++
    const tickLen = i - tickStart

    // 查找下一个恰好等长（前后均非反引号）的闭合反引号序列
    let closeStart = -1
    let j = i
    while (j < n) {
      if (line[j] !== '`') {
        j++
        continue
      }
      const runStart = j
      while (j < n && line[j] === '`') j++
      if (j - runStart === tickLen) {
        closeStart = runStart
        break
      }
    }

    if (closeStart !== -1) {
      const closeEnd = closeStart + tickLen
      if (tickStart > plainStart) {
        out += replacePlain(line.slice(plainStart, tickStart))
      }
      out += line.slice(tickStart, closeEnd)
      i = closeEnd
      plainStart = closeEnd
    }
  }

  if (plainStart < n) {
    out += replacePlain(line.slice(plainStart))
  }
  return out
}

// 确定性重定向正文中的 [[oldShortId]] / [[oldShortId|别名]] 双链（跳过围栏代码块与行内代码），用于合并重复后修复全库反链
export function redirectWikiLinksInContent(
  content: string,
  redirectMap: ReadonlyMap<string, string>,
): { content: string; replacedCount: number; redirectedTargets: string[] } {
  if (!redirectMap.size || !content) {
    return { content, replacedCount: 0, redirectedTargets: [] }
  }
  const normalizedMap = new Map<string, string>()
  for (const [from, to] of redirectMap.entries()) {
    const f = normalizeShortId(from)
    const t = normalizeShortId(to)
    if (f && t && f !== t) normalizedMap.set(f, t)
  }
  if (!normalizedMap.size) {
    return { content, replacedCount: 0, redirectedTargets: [] }
  }

  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  let fence: string | null = null
  let replacedCount = 0
  const redirectedTargets = new Set<string>()

  const replaceSegment = (segment: string) =>
    segment.replace(
      new RegExp(WIKI_LINK_REGEX.source, 'gi'),
      (full, rawId: string, alias?: string) => {
        const target = normalizedMap.get(rawId.toLowerCase())
        if (!target) return full
        replacedCount++
        redirectedTargets.add(rawId.toLowerCase())
        return alias !== undefined ? `[[${target}|${alias}]]` : `[[${target}]]`
      },
    )

  const outLines = lines.map((line) => {
    const [, marker, info = ''] = FENCE_LINE_RE.exec(line) ?? []
    if (fence !== null) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && /^[ \t]*$/.test(info)) fence = null
      return line
    }
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = marker
      return line
    }

    return replaceOutsideInlineCode(line, replaceSegment)
  })

  return {
    content: replacedCount > 0 ? outLines.join(eol) : content,
    replacedCount,
    redirectedTargets: [...redirectedTargets],
  }
}
