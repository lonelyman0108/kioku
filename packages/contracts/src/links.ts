import { z } from 'zod'

import { EntryKind, Sensitivity } from './memory'

// 无歧义 Base30 字符集：排除 0/o/1/i/l/u，避免人工抄写混淆
export const SHORT_ID_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz'
export const SHORT_ID_PREFIX = 'm-'
export const SHORT_ID_LENGTH = 6
export const SHORT_ID_PATTERN = /^m-[2-9a-hjkmnp-tv-z]{6,8}$/

// 接受任意大小写输入，统一去除首尾空白并转为小写；全实例唯一
export const ShortId = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .pipe(z.string().regex(SHORT_ID_PATTERN, '短 ID 格式应为 m- 后接 6 到 8 位无歧义小写字母或数字'))
  .meta({ id: 'ShortId' })
export type ShortId = z.infer<typeof ShortId>

export function isShortId(value: string): boolean {
  return SHORT_ID_PATTERN.test(value.trim().toLowerCase())
}

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

export const EntryLinkNeighbor = z
  .object({
    shortId: ShortId,
    title: z.string(),
    circleId: z.uuid(),
    circleSlug: z.string(),
    kind: EntryKind,
    sensitivity: Sensitivity,
    direction: EntryLinkDirection,
    sourceVariantId: z.uuid().nullable(),
  })
  .meta({ id: 'EntryLinkNeighbor' })
export type EntryLinkNeighbor = z.infer<typeof EntryLinkNeighbor>
