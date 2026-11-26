import { z } from 'zod'

import {
  CREDENTIAL_PLACEHOLDER_PREFIX,
  extractCredentialPlaceholders,
  extractTargetShortIds,
} from './links'

export const HYGIENE_WARNING_CODES = [
  'title_too_long',
  'title_has_date_or_log',
  'content_repeats_title',
  'content_has_changelog',
  'content_has_legacy_glossary',
  'legacy_lore_uri',
  'pinned_missing_summary',
  'missing_change_summary',
  'severe_shrink_or_lost_refs',
] as const
export const HygieneWarningCode = z.enum(HYGIENE_WARNING_CODES)
export type HygieneWarningCode = z.infer<typeof HygieneWarningCode>

export const HygieneWarning = z.object({
  code: HygieneWarningCode,
  message: z.string(),
})
export type HygieneWarning = z.infer<typeof HygieneWarning>

export const ENTRY_TITLE_RECOMMENDED_MAX = 32
const PINNED_SUMMARY_THRESHOLD_CHARS = 1_500

const TITLE_DATE_RE =
  /(?:20\d{2}[-./年]\d{1,2}(?:[-./月]\d{1,2}日?)?|(?<![0-9a-zA-Z])\d{2}-\d{2}(?![0-9a-zA-Z]))/
const TITLE_LOG_PAREN_RE =
  /[（(][^）)]*(?:更新|迁移|迁到|迁至|新增|下线|停用|退役|立项|定方向|合并|上线|开发完成|完成|开始|实测|切换|重建|归档|卸载|调整|改为|定稿|PR\s*#|commit|v\d+\.\d+|第\s*\d)[^）)]*[）)]/i
const TITLE_DASH_STATUS_RE = /[—–-]{2,}\s*(?:已于|已|20\d{2}|停用|退役|卸载|废弃|完成)/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const H1_HEADING_RE = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const CHANGELOG_HEADING_RE =
  /^ {0,3}#{2,4}[ \t]+(?:更新日志|变更记录|变更历史|状态变更|历史变更|修改记录|演进记录|changelog|history)(?:\b|[（(：:\s]|$)/i
const DATED_BULLET_RE =
  /^\s*[-*+]\s*(?:\*\*)?(?:20\d{2}[-./]\d{1,2}(?:[-./]\d{1,2})?|\d{2}-\d{2})\b/
export const LEGACY_LORE_URI_REGEX =
  /\b(?:infra|projects|project|preferences|core|user|app|persona):\/\/[^\s`'"()（）[\]【】<>《》「」『』，。；、：！？]+/gi
export const NON_SHORT_ID_WIKI_LINK_REGEX =
  /\[\[(?!m-[2-9a-hjkmnp-tv-z]{6,8}(?:\||\]\]))([^\]|\r\n]{1,120})(?:\|([^\]\r\n]{1,200}))?\]\]/gi

function normalizeHeadingCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

// 去除正文首行与词条标题等价的 # 一级标题（仅用于展示归一化或预清洗，跳过围栏块）
export function stripDuplicateLeadingHeading(title: string, content: string): string {
  const normalizedTitle = normalizeHeadingCompare(title)
  if (!normalizedTitle || !content) return content

  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let idx = 0
  while (idx < lines.length && lines[idx]!.trim() === '') idx++
  if (idx >= lines.length) return content

  const match = H1_HEADING_RE.exec(lines[idx]!)
  if (!match?.[1]) return content
  if (normalizeHeadingCompare(match[1]) !== normalizedTitle) return content

  let next = idx + 1
  while (next < lines.length && lines[next]!.trim() === '') next++
  const rest = lines.slice(next).join('\n')
  return rest.trim() ? rest : content
}

export function hasDuplicateLeadingHeading(title: string, content: string): boolean {
  const normalizedTitle = normalizeHeadingCompare(title)
  if (!normalizedTitle || !content) return false
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let idx = 0
  while (idx < lines.length && lines[idx]!.trim() === '') idx++
  if (idx >= lines.length) return false
  const match = H1_HEADING_RE.exec(lines[idx]!)
  if (!match?.[1]) return false
  if (normalizeHeadingCompare(match[1]) !== normalizedTitle) return false
  // 只有首行标题后仍有正文时才视为可去除的重复标题
  let next = idx + 1
  while (next < lines.length && lines[next]!.trim() === '') next++
  return next < lines.length
}

export function stripLegacyGlossaryLines(content: string): { content: string; removed: boolean } {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  let fence: string | null = null
  let removed = false
  const kept: string[] = []
  for (const line of lines) {
    const [, marker, info = ''] = FENCE_RE.exec(line) ?? []
    if (fence !== null) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && /^[ \t]*$/.test(info)) fence = null
      kept.push(line)
      continue
    }
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = marker
      kept.push(line)
      continue
    }
    if (/^\s*glossary keywords:\s*.+$/i.test(line)) {
      removed = true
      continue
    }
    kept.push(line)
  }
  if (!removed) return { content, removed: false }
  const cleaned = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
  return cleaned ? { content: cleaned, removed: true } : { content, removed: false }
}

export function extractLegacyRefs(content: string): { uris: string[]; slugLinks: string[] } {
  const uris = new Set<string>()
  const slugLinks = new Set<string>()
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let fence: string | null = null
  for (const line of lines) {
    const [, marker, info = ''] = FENCE_RE.exec(line) ?? []
    if (fence !== null) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && /^[ \t]*$/.test(info)) fence = null
      continue
    }
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = marker
      continue
    }
    const uriRe = new RegExp(LEGACY_LORE_URI_REGEX.source, 'gi')
    let m: RegExpExecArray | null
    while ((m = uriRe.exec(line)) !== null) {
      uris.add(m[0].replace(/[.,;:]+$/, ''))
    }
    const slugRe = new RegExp(NON_SHORT_ID_WIKI_LINK_REGEX.source, 'gi')
    while ((m = slugRe.exec(line)) !== null) {
      const slug = m[1]?.trim()
      if (slug && !slug.includes(CREDENTIAL_PLACEHOLDER_PREFIX)) slugLinks.add(slug)
    }
  }
  return { uris: [...uris], slugLinks: [...slugLinks] }
}

// 尝试将标题尾部的日期/更新日志括号或破折号后缀拆出，供编辑器一键移入变更说明
export function splitTitleLogSuffix(
  title: string,
): { cleanTitle: string; extractedNote: string } | null {
  const trimmed = title.trim()
  if (!trimmed) return null

  const parenMatch = /^(.+?)\s*[（(]([^）)]+)[）)]\s*$/.exec(trimmed)
  if (parenMatch?.[1] && parenMatch[2]) {
    const inside = parenMatch[2].trim()
    const base = parenMatch[1].trim()
    if (
      base.length >= 2 &&
      (TITLE_DATE_RE.test(inside) || TITLE_LOG_PAREN_RE.test(`（${inside}）`))
    ) {
      return { cleanTitle: base, extractedNote: inside }
    }
  }

  const dashMatch = /^(.+?)\s*[—–-]{2,}\s*(.+)$/.exec(trimmed)
  if (dashMatch?.[1] && dashMatch[2]) {
    const suffix = dashMatch[2].trim()
    const base = dashMatch[1].trim()
    if (base.length >= 2 && TITLE_DASH_STATUS_RE.test(`——${suffix}`)) {
      return { cleanTitle: base, extractedNote: suffix }
    }
  }

  return null
}

function hasChangelogSectionOrStreak(content: string): boolean {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  let fence: string | null = null
  let datedStreak = 0
  for (const line of lines) {
    const [, marker, info = ''] = FENCE_RE.exec(line) ?? []
    if (fence !== null) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && /^[ \t]*$/.test(info)) fence = null
      continue
    }
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = marker
      continue
    }
    if (CHANGELOG_HEADING_RE.test(line)) return true
    if (DATED_BULLET_RE.test(line)) {
      datedStreak++
      if (datedStreak >= 3) return true
    } else if (line.trim() !== '') {
      datedStreak = 0
    }
  }
  return false
}

export interface LintEntryHygieneInput {
  title: string
  content: string
  summary?: string | null | undefined
  isPinned?: boolean | undefined
  isUpdate?: boolean | undefined
  contentChanged?: boolean | undefined
  changeSummary?: string | null | undefined
  previousContent?: string | undefined
}

export function lintEntryHygiene(input: LintEntryHygieneInput): HygieneWarning[] {
  const warnings: HygieneWarning[] = []
  const title = input.title.trim()
  const content = input.content

  if (title.length > ENTRY_TITLE_RECOMMENDED_MAX) {
    warnings.push({
      code: 'title_too_long',
      message: `标题共 ${title.length} 字（建议 ${ENTRY_TITLE_RECOMMENDED_MAX} 字以内，保持简短稳定）`,
    })
  }

  if (
    TITLE_DATE_RE.test(title) ||
    TITLE_LOG_PAREN_RE.test(title) ||
    TITLE_DASH_STATUS_RE.test(title)
  ) {
    warnings.push({
      code: 'title_has_date_or_log',
      message: '标题包含日期或变更状态说明，建议保持稳定主题名，改动记录写入变更说明',
    })
  }

  if (hasDuplicateLeadingHeading(title, content)) {
    warnings.push({
      code: 'content_repeats_title',
      message: '正文首行重复了标题，可直接从正文或二级小节开始编写',
    })
  }

  if (hasChangelogSectionOrStreak(content)) {
    warnings.push({
      code: 'content_has_changelog',
      message: '正文含更新日志段落或连续日期流水，建议只保留现行状态与原因，变更记录留入历史',
    })
  }

  if (stripLegacyGlossaryLines(content).removed) {
    warnings.push({
      code: 'content_has_legacy_glossary',
      message: '正文包含旧版关键词汇总行，主题标签已独立保存，可安全移除该行',
    })
  }

  const legacyRefs = extractLegacyRefs(content)
  if (legacyRefs.uris.length > 0 || legacyRefs.slugLinks.length > 0) {
    const count = legacyRefs.uris.length + legacyRefs.slugLinks.length
    warnings.push({
      code: 'legacy_lore_uri',
      message: `正文残留 ${count} 处旧路径或非短 ID 引用，建议替换为 [[m-xxxxxx]] 双链`,
    })
  }

  if (input.isPinned && content.length > PINNED_SUMMARY_THRESHOLD_CHARS && !input.summary?.trim()) {
    warnings.push({
      code: 'pinned_missing_summary',
      message: `常驻记忆正文较长（${content.length} 字），建议补充 1–2 句现行概要以便启动加载紧凑呈现`,
    })
  }

  if (input.isUpdate && input.contentChanged && !input.changeSummary?.trim()) {
    warnings.push({
      code: 'missing_change_summary',
      message: '本次修改了正文但未填写变更说明，补充一句原因便于后续版本历史追溯',
    })
  }

  if (input.isUpdate && input.previousContent !== undefined && input.contentChanged) {
    const beforeLinks = extractTargetShortIds(input.previousContent)
    const afterLinks = new Set(extractTargetShortIds(content))
    const lostLinks = beforeLinks.filter((id) => !afterLinks.has(id))
    const credKey = (p: { slug: string; field: string | null }) =>
      p.field ? `${p.slug}#${p.field}` : p.slug
    const beforeCreds = new Set(extractCredentialPlaceholders(input.previousContent).map(credKey))
    const afterCreds = new Set(extractCredentialPlaceholders(content).map(credKey))
    const lostCreds = [...beforeCreds].filter((k) => !afterCreds.has(k))
    const severeShrink =
      input.previousContent.length >= 200 &&
      content.length < Math.floor(input.previousContent.length * 0.5)
    if (lostLinks.length > 0 || lostCreds.length > 0 || severeShrink) {
      const parts: string[] = []
      if (lostLinks.length > 0) parts.push(`减少了 ${lostLinks.length} 条既有双链`)
      if (lostCreds.length > 0) parts.push(`减少了 ${lostCreds.length} 个凭据占位符`)
      if (severeShrink)
        parts.push(`正文篇幅缩减超过一半（${input.previousContent.length} → ${content.length} 字）`)
      warnings.push({
        code: 'severe_shrink_or_lost_refs',
        message: `检测到较大改动：${parts.join('，')}，请确认未误覆盖既有主体`,
      })
    }
  }

  return warnings
}

export function isTitleDirty(title: string): boolean {
  const trimmed = title.trim()
  return (
    trimmed.length > ENTRY_TITLE_RECOMMENDED_MAX ||
    TITLE_DATE_RE.test(trimmed) ||
    TITLE_LOG_PAREN_RE.test(trimmed) ||
    TITLE_DASH_STATUS_RE.test(trimmed)
  )
}
