import { createHash } from 'node:crypto'

import { extractMarkdownOutline, stripDuplicateLeadingHeading } from '@kioku/contracts'

import { clipChars } from '../recall/text'

export interface EmbeddableEntry {
  shortId: string
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

// 拼接高信噪比向量文本：标题、现行概要、触发场景、场景标签与去噪后的正文（超长正文附加二级小节纲要以覆盖后段）
export function buildEmbeddingText(entry: EmbeddableEntry): string {
  const lines: string[] = [entry.title.trim()]
  if (entry.summary?.trim()) lines.push(entry.summary.trim())
  if (entry.disclosure?.trim()) lines.push(entry.disclosure.trim())
  const tags = [...entry.projects, ...entry.envs, ...entry.realms, ...entry.runtimes]
  if (tags.length) lines.push(tags.join(' '))
  const deduped = stripDuplicateLeadingHeading(entry.title, entry.content)
  const stripped = stripTrailingChangelogSections(deduped)
  const cleaned = clipChars(stripped, EMBEDDING_CONTENT_MAX_CHARS)
  if (cleaned) lines.push(cleaned)
  if (stripped.length > EMBEDDING_CONTENT_MAX_CHARS) {
    const headings = extractMarkdownOutline(stripped)
      .map((s) => s.heading.trim())
      .filter(Boolean)
    if (headings.length) {
      const outlineLine = clipChars(
        `小节纲要：${headings.join(' / ')}`,
        EMBEDDING_OUTLINE_MAX_CHARS,
      )
      lines.push(outlineLine)
    }
  }
  return lines.join('\n').trim()
}

export function embeddingContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
