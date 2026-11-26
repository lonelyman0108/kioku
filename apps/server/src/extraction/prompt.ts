import { ENTRY_TITLE_MAX } from '@kioku/contracts'

import { stripThinkTags, type ChatMessage } from '../models/client'
import { clipChars, inlineText } from '../recall/text'

const MAX_TRANSCRIPT_CHARS = 12_000
const MAX_USER_CHARS = 1_000
const MAX_REPLY_CHARS = 300
const MAX_SUMMARY_CHARS = 800

export interface BufferedTurnItem {
  userText: string
  replyText: string
}

export interface ParsedEpisodeSummary {
  title: string
  summary: string
}

const SYSTEM_PROMPT = [
  '你是编码会话摘要助手。请把下面的多轮开发对话提炼成简明、客观的中文会话摘要。',
  '只输出 JSON：{"title":"简短标题","summary":"2到4句概括本次会话的结论、关键改动、踩坑与待办"}。',
  '规则：',
  '- 若对话仅是寒暄、纯测试或没有值得后续会话参考的结论，请返回 {"title":"","summary":""}。',
  '- 不要编造内容，不要写入明文密码、API Key 或令牌；正文中的 {{cred:...}} 占位符原样保留。',
  '- summary 控制在 500 字以内，简洁陈述事实。',
].join('\n')

export function buildEpisodeMessages(
  turns: readonly BufferedTurnItem[],
  context: { projectSlug?: string; deviceKey?: string },
): ChatMessage[] {
  // 按最新轮次优先保留，总长不超过 MAX_TRANSCRIPT_CHARS
  const blocks: string[] = []
  let chars = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!
    const user = clipChars(inlineText(turn.userText), MAX_USER_CHARS)
    const reply = clipChars(inlineText(turn.replyText), MAX_REPLY_CHARS)
    const block = `用户：${user}\n助手：${reply}`
    if (chars + block.length + 2 > MAX_TRANSCRIPT_CHARS && blocks.length > 0) break
    blocks.unshift(block)
    chars += block.length + 2
  }

  const headerParts: string[] = []
  if (context.projectSlug) headerParts.push(`项目：${context.projectSlug}`)
  if (context.deviceKey) headerParts.push(`设备：${context.deviceKey}`)
  const header = headerParts.length ? `${headerParts.join(' · ')}\n\n` : ''

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${header}${blocks.join('\n\n')}` },
  ]
}

export type EpisodeParseResult =
  | { status: 'summary'; data: ParsedEpisodeSummary }
  | { status: 'empty' }
  | { status: 'invalid'; reason: string }

export function evaluateEpisodeResponse(raw: string): EpisodeParseResult {
  const cleaned = stripThinkTags(raw)
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first < 0 || last <= first) {
    return { status: 'invalid', reason: '模型输出非合法 JSON' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(first, last + 1))
  } catch {
    return { status: 'invalid', reason: '模型输出 JSON 解析失败' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'invalid', reason: '模型输出非 JSON 对象' }
  }
  const rec = parsed as Record<string, unknown>
  if (typeof rec.summary !== 'string') {
    return { status: 'invalid', reason: '模型输出缺少 summary 字符串字段' }
  }
  const summary = clipChars(rec.summary.trim(), MAX_SUMMARY_CHARS)
  if (!summary) return { status: 'empty' }
  const title =
    typeof rec.title === 'string' && rec.title.trim()
      ? clipChars(inlineText(rec.title), ENTRY_TITLE_MAX)
      : clipChars(inlineText(summary), 48)
  return { status: 'summary', data: { title, summary } }
}

export function parseEpisodeSummary(raw: string): ParsedEpisodeSummary | null {
  const evaluated = evaluateEpisodeResponse(raw)
  return evaluated.status === 'summary' ? evaluated.data : null
}
