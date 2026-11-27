import { createHash } from 'node:crypto'

import {
  extractMarkdownOutline,
  parseEpisodeSignals,
  stripDuplicateLeadingHeading,
  type EntryKind,
} from '@kioku/contracts'

import { clipChars } from '../recall/text'

export interface EmbeddableEntry {
  shortId: string
  kind?: EntryKind | undefined
  title: string
  summary?: string | null | undefined
  disclosure: string | null
  topics: readonly string[]
  envs: readonly string[]
  realms: readonly string[]
  projects: readonly string[]
  runtimes: readonly string[]
  content: string
}

const EMBEDDING_CONTENT_MAX_CHARS = 2_500
const EMBEDDING_OUTLINE_MAX_CHARS = 400
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ANY_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+/
const CHANGELOG_HEADING_RE =
  /^ {0,3}(#{2,4})[ \t]+(?:更新日志|变更记录|变更历史|状态变更|历史变更|修改记录|演进记录|changelog|history)(?:\b|[（(：:\s]|$)/i

// 剥离正文残留的更新日志小节，按对应标题层级闭合，避免误删同级有效小节
function stripTrailingChangelogSections(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let fence: string | null = null
  let skipLevel: number | null = null
  for (const line of lines) {
    const [, marker, info = ''] = FENCE_RE.exec(line) ?? []
    if (fence !== null) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && /^[ \t]*$/.test(info)) fence = null
      if (skipLevel === null) out.push(line)
      continue
    }
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = marker
      if (skipLevel === null) out.push(line)
      continue
    }
    const changelogMatch = CHANGELOG_HEADING_RE.exec(line)
    if (changelogMatch?.[1]) {
      skipLevel = changelogMatch[1].length
      continue
    }
    if (skipLevel !== null) {
      const headingMatch = ANY_HEADING_RE.exec(line)
      if (headingMatch?.[1] && headingMatch[1].length <= skipLevel) {
        skipLevel = null
      }
    }
    if (skipLevel === null) out.push(line)
  }
  const joined = out.join('\n').trim()
  return joined || content.trim()
}

// 会话摘要（episode）仅对剥离后的结构化信号做定向向量化，与业务正文解耦，避免业务语境淹没跨会话行为模式
export function buildEpisodeSignalEmbeddingText(disclosure: string | null | undefined): string {
  const signals = parseEpisodeSignals(disclosure)
  if (!signals.directives.length && !signals.facts.length) return ''
  const parts: string[] = []
  if (signals.directives.length) {
    parts.push(`行为偏好与指令：\n${signals.directives.join('\n')}`)
  }
  if (signals.facts.length) {
    parts.push(`确认事实与约束：\n${signals.facts.join('\n')}`)
  }
  return parts.join('\n\n').trim()
}

// 拼接高信噪比向量文本：正式词条取标题、概要、触发场景、场景标签与去噪正文；会话摘要仅编码结构化信号
export function buildEmbeddingText(entry: EmbeddableEntry): string {
  if (entry.kind === 'episode') {
    return buildEpisodeSignalEmbeddingText(entry.disclosure)
  }
  const lines: string[] = [entry.title.trim()]
  if (entry.summary?.trim()) lines.push(entry.summary.trim())
  if (entry.disclosure?.trim()) lines.push(entry.disclosure.trim())
  const tags = [...entry.projects, ...entry.envs, ...entry.realms, ...entry.runtimes]
  if (tags.length) lines.push(tags.join(' '))
  const deduped = stripDuplicateLeadingHeading(entry.title, entry.content)
  const stripped = stripTrailingChangelogSections(deduped)
  const cleaned = clipChars(stripped, EMBEDDING_CONTENT_MAX_CHARS)
  if (cleaned) lines.push(cleaned)
  if (cleaned.length < stripped.length) {
    const allHeadings = extractMarkdownOutline(stripped)
      .map((s) => s.heading.trim())
      .filter(Boolean)
    const tailHeadings = allHeadings.filter((h) => !cleaned.includes(h))
    const chosen = tailHeadings.length ? tailHeadings : allHeadings
    if (chosen.length) {
      const outlineLine = clipChars(`小节纲要：${chosen.join(' / ')}`, EMBEDDING_OUTLINE_MAX_CHARS)
      lines.push(outlineLine)
    }
  }
  return lines.join('\n').trim()
}

export function embeddingContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
