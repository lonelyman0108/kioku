import {
  ENTRY_TITLE_MAX,
  EPISODE_SIGNAL_ITEM_MAX_CHARS,
  EPISODE_SIGNAL_ITEMS_MAX,
} from '@kioku/contracts'

import { stripThinkTags, type ChatMessage } from '../models/client'
import { clipChars, inlineText, oneLine } from '../recall/text'

const MAX_TRANSCRIPT_CHARS = 12_000
const MAX_USER_CHARS = 1_000
const MAX_REPLY_CHARS = 300
const MAX_SUMMARY_CHARS = 800

export interface BufferedTurnItem {
  userText: string
  replyText: string
  sessionId?: string | undefined
}

export interface ParsedEpisodeSummary {
  title: string
  summary: string
  facts: string[]
  directives: string[]
}

const SYSTEM_PROMPT = [
  '你是编码会话摘要与信号分拣助手。请把下面的多轮开发对话一次提炼为简明客观的中文会话摘要，并顺手分拣出值得跨会话沉淀的事实要点与用户流程偏好。',
  '只输出单个 JSON 对象：{"title":"简短标题","summary":"2到4句概括本次会话的结论、关键改动、踩坑与待办","facts":["0到5条新确认的环境/架构/接口事实或踩坑要点，无则[]"],"directives":["0到5条用户明确提出的流程偏好、协作习惯或纠偏要求，无则[]"]}。',
  '规则：',
  '- 若对话仅是寒暄、纯测试或没有任何值得后续参考的结论与信号，返回 {"title":"","summary":"","facts":[],"directives":[]}。',
  '- directives 仅记录用户明确表达的、可跨任务复用的工作流偏好、规范要求或纠偏（如「按职责拆分 PR 提交、合并后清理分支」「公司项目直接提交开发分支不提 PR」「保持极简纸墨风」）；切勿把一次性具体任务指令（如「修这个报错」「把按钮改宽」）写入 directives。',
  '- facts 仅记录本次新确认的环境配置、端口、约束、排错根因或架构决策短句；每条控制在 80 字以内，简洁陈述，不写寒暄或过程流水。',
  '- 不要编造内容，不要写入明文密码、API Key 或令牌；summary 中的 {{cred:...}} 占位符原样保留。',
  '- 涉及单机配置、本机路径、端口、局域网 IP、硬件差异或特定机器开关时，必须在 title、summary 与 facts 中明确注明适用设备、主机或前提条件，不得泛化为通用系统或全局配置。',
  '- summary 控制在 500 字以内，简洁陈述事实。',
].join('\n')

export function buildEpisodeMessages(
  turns: readonly BufferedTurnItem[],
  context: { projectSlug?: string; deviceKey?: string; deviceName?: string },
): ChatMessage[] {
  // 按最新轮次优先保留，总长不超过 MAX_TRANSCRIPT_CHARS
  const kept: Array<{ sessionId: string; block: string }> = []
  let chars = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!
    const user = clipChars(inlineText(turn.userText), MAX_USER_CHARS)
    const reply = clipChars(inlineText(turn.replyText), MAX_REPLY_CHARS)
    const block = `用户：${user}\n助手：${reply}`
    if (chars + block.length + 2 > MAX_TRANSCRIPT_CHARS && kept.length > 0) break
    kept.unshift({ sessionId: turn.sessionId?.trim() ?? '', block })
    chars += block.length + 2
  }

  // 同桶混入多个 sessionId 时显式标注会话边界，交替出现的同一会话沿用原编号，空白 sessionId 单独标注
  const distinctSessions = new Set(kept.map((item) => item.sessionId).filter(Boolean))
  const blocks: string[] = []
  if (distinctSessions.size > 1) {
    const sessionNumbers = new Map<string, number>()
    let lastSession: string | null = null
    for (const item of kept) {
      if (item.sessionId !== lastSession) {
        lastSession = item.sessionId
        if (!item.sessionId) {
          blocks.push('--- 未标识会话 ---')
        } else {
          let num = sessionNumbers.get(item.sessionId)
          if (num === undefined) {
            num = sessionNumbers.size + 1
            sessionNumbers.set(item.sessionId, num)
          }
          blocks.push(`--- 会话 ${num} ---`)
        }
      }
      blocks.push(item.block)
    }
  } else {
    for (const item of kept) blocks.push(item.block)
  }

  const headerParts: string[] = []
  const projectSlug = context.projectSlug?.trim() ?? ''
  if (projectSlug) headerParts.push(`项目：${projectSlug}`)
  const deviceKey = context.deviceKey?.trim() ?? ''
  const deviceName = context.deviceName?.trim() ?? ''
  if (deviceKey && deviceName && deviceName !== deviceKey) {
    headerParts.push(`设备：${deviceKey}（${deviceName}）`)
  } else if (deviceKey) {
    headerParts.push(`设备：${deviceKey}`)
  } else if (deviceName) {
    headerParts.push(`终端：${deviceName}`)
  }
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

function parseSignalList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const clean = clipChars(oneLine(item), EPISODE_SIGNAL_ITEM_MAX_CHARS).trim()
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
    if (out.length >= EPISODE_SIGNAL_ITEMS_MAX) break
  }
  return out
}

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
  const facts = parseSignalList(rec.facts)
  const directives = parseSignalList(rec.directives)
  let summary = clipChars(rec.summary.trim(), MAX_SUMMARY_CHARS)
  if (!summary && !facts.length && !directives.length) return { status: 'empty' }
  if (!summary) {
    summary = clipChars([...directives, ...facts].join('；'), MAX_SUMMARY_CHARS)
  }
  const title =
    typeof rec.title === 'string' && rec.title.trim()
      ? clipChars(inlineText(rec.title), ENTRY_TITLE_MAX)
      : clipChars(inlineText(summary), 48)
  return { status: 'summary', data: { title, summary, facts, directives } }
}

export function parseEpisodeSummary(raw: string): ParsedEpisodeSummary | null {
  const evaluated = evaluateEpisodeResponse(raw)
  return evaluated.status === 'summary' ? evaluated.data : null
}
