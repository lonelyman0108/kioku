import {
  CHANGE_SUMMARY_MAX,
  checkCaptureIntegrity,
  CREDENTIAL_PLACEHOLDER_PREFIX,
  DISCLOSURE_MAX,
  DREAM_KINDS,
  ENTRY_CONTENT_MAX,
  ENTRY_SUMMARY_MAX,
  ENTRY_TITLE_MAX,
  ENTRY_TITLE_NEW_MAX,
  normalizeSlugList,
  type ArchivedHistoryNote,
  type DreamSuggestionKind,
  type EntryKind,
} from '@kioku/contracts'

import type { ChatMessage } from '../models/client'
import { clipChars, inlineText } from '../recall/text'

export interface DreamPromptItem {
  id: string
  shortId: string
  kind: EntryKind
  title: string
  summary?: string | null | undefined
  content: string
  disclosure: string | null
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
  topics: string[]
  version: number
  updatedAt: string
  truncated: boolean
}

export interface ParsedDreamProposal {
  kind: DreamSuggestionKind
  entryIds: string[]
  keepId: string | null
  proposedTitle: string | null
  proposedSummary: string | null
  proposedContent: string | null
  proposedDisclosure: string | null
  proposedChangeSummary: string | null
  archivedNotes: ArchivedHistoryNote[] | null
  proposedTopics: string[] | null
  proposedEnvs: string[] | null
  proposedRealms: string[] | null
  proposedProjects: string[] | null
  proposedRuntimes: string[] | null
  reason: string
}

const DREAM_KIND_SET: ReadonlySet<string> = new Set(DREAM_KINDS)
const MAX_REASON_CHARS = 300
const MAX_ARCHIVED_NOTES = 20

const SYSTEM_PROMPT = [
  '你是 Kioku 记忆整理助手。请审阅给出的记忆词条（entry）与近期会话摘要（episode），只在确实值得整理时提出少量高价值建议。',
  '只输出 JSON：{"suggestions":[...]}，没有建议时输出 {"suggestions":[]}。',
  '',
  '允许以下 4 种常规建议类型（kind）：',
  '1. "distill_episode"：把 1 条或多条有长期价值的会话摘要（episode）提炼为一条永久正式记忆。须提供 target_short_ids、title（简短稳定、禁日期）、content、reason，推荐提供 summary（1–2 句现行结论）、change_summary、disclosure、topics、envs、realms、projects、runtimes。',
  '2. "merge_duplicates"：合并 2 条以上内容高度重叠且 realms 一致的正式记忆（entry）。须提供 target_short_ids、keep_short_id、title、content、reason，推荐提供 summary、change_summary、disclosure、topics、envs、realms、projects、runtimes。不得合并被截断的词条。',
  '3. "mark_stale"：某条正式记忆已被更新的记忆推翻或明显过时失效。须提供 target_short_ids（1 条）与 reason。',
  '4. "update"：根据更新的会话摘要或关联邻居记忆（含双链邻居间的事实矛盾），对某条现有正式记忆做具体事实补充或修正。须提供 target_short_ids（1 条）、content、reason，推荐提供 title、summary、change_summary、disclosure、topics、envs、realms、projects、runtimes。',
  '',
  '严格约束：',
  '- 宁缺毋滥，不要为细枝末节的措辞调整提建议；但若关联邻居与本条出现明确的配置/地址/架构矛盾，应提出 update 同步修正。',
  '- 标题必须简短稳定，不夹带日期、版本号或改动日志；正文维护现行有效状态与长期防踩坑原因，不在首行重复标题。',
  '- 严禁编造任何密码、API Key 或令牌；原文中的 [[m-xxxxxx]] 双链与 {{cred:...}} 占位符必须完整保留。',
  '- target_short_ids 必须全部取自下方提供的列表。',
].join('\n')

const TIDY_SYSTEM_PROMPT = [
  '你是 Kioku 记忆结构规范化助手。给定一条完整记忆词条，请将其重构为「稳定短标题 + 现行概要 + 干净常青正文 + 独立归档历史说明」。',
  '只输出单个 JSON 对象：',
  '{"needed":true|false,"title":"简短稳定主题名","summary":"1-2句现行结论","content":"重构后的Markdown正文","change_summary":"本次规范整理说明","archived_notes":[{"occurred_at":"YYYY-MM-DDTHH:mm:ssZ或null","note":"剥离出的单条历史变更说明"}],"reason":"为什么建议规范此条"}',
  '若该词条标题干净、已有合适概要且正文不含明显冗余历史流水账，直接输出 {"needed":false}。',
  '',
  '强制规则：',
  '1. title：名词短语主题名，建议 ≤24 字（绝不超 80 字），彻底去掉日期、括号里的更新日志、PR/commit 编号和过渡状态。',
  '2. summary：1–2 句（≤300 字）精准概括「现在是什么」，用于启动加载目录和检索速览。',
  '3. content（核心边界）：',
  '   - 严禁在正文首行重复 # <标题>；建议用清晰的 ## 二级小节组织（如现行配置/规则、关键约束与原因）。',
  '   - 必须保留所有仍在生效的配置、端口、地址、规则以及「防踩坑原因/禁令（Rationale）」——未来不知道会导致改坏系统的原因绝不能删！',
  '   - 将已退役组件、已停用旧流程、逐日迁移/排障过程流水账从正文剥离，压缩为简明条目放入 archived_notes（保留对应日期）。',
  '   - 原文出现的所有 [[m-xxxxxx]] 双链与 {{cred:...}} 凭据占位符必须 100% 完整保留，严禁丢失或改写格式。',
  '4. archived_notes：每条只写精炼单行（≤200 字），日期已知时填 ISO 8601（如 2026-10-21T00:00:00Z），未知填 null；无剥离历史时给 []。',
].join('\n')

function formatItem(item: DreamPromptItem): string {
  const tags: string[] = []
  if (item.projects.length) tags.push(`project=${item.projects.join(',')}`)
  if (item.envs.length) tags.push(`env=${item.envs.join(',')}`)
  if (item.realms.length) tags.push(`realm=${item.realms.join(',')}`)
  if (item.runtimes.length) tags.push(`runtime=${item.runtimes.join(',')}`)
  if (item.topics.length) tags.push(`topic=${item.topics.join(',')}`)
  const head = `[${item.shortId}] (${item.kind}${item.truncated ? ', 已截断' : ''}) ${item.title} | 更新于 ${item.updatedAt.slice(0, 10)}${tags.length ? ` | ${tags.join(' ')}` : ''}`
  const sum = item.summary ? `\n现行概要：${item.summary}` : ''
  const disc = item.disclosure ? `\n触发场景：${item.disclosure}` : ''
  return `${head}${sum}${disc}\n${item.content}`
}

export function buildDreamMessages(
  changed: readonly DreamPromptItem[],
  neighbors: readonly DreamPromptItem[],
): ChatMessage[] {
  const sections: string[] = ['## 本次待整理的新增/变动记录', ...changed.map(formatItem)]
  if (neighbors.length) {
    sections.push(
      '',
      '## 相关已有记忆（含双链邻居，供查重与矛盾核对参考）',
      ...neighbors.map(formatItem),
    )
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ]
}

export function buildTidyMessages(item: DreamPromptItem): ChatMessage[] {
  return [
    { role: 'system', content: TIDY_SYSTEM_PROMPT },
    { role: 'user', content: formatItem(item) },
  ]
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items = value.filter((v): v is string => typeof v === 'string')
  return normalizeSlugList(items)
}

function sameRealms(a: readonly string[], b: readonly string[]): boolean {
  const left = normalizeSlugList(a)
  const right = normalizeSlugList(b)
  return left.length === right.length && left.every((v, i) => v === right[i])
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try {
    const parsed = JSON.parse(raw.slice(first, last + 1)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function normalizeOccurredAt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00Z`
  const ts = Date.parse(trimmed)
  return Number.isNaN(ts) ? null : new Date(ts).toISOString()
}

const CRED_PLACEHOLDER_STRIP_RE = /\{\{cred:[^}]*\}\}/gi
const CRED_PREFIX_STRIP_RE = /\{\{cred:/gi
const CONTROL_CHAR_RE = /\p{Cc}+/gu

// 净化模型产出的非正文单行文本：移除凭据占位符与全部控制字符，保证落库后可安全通过契约校验
function sanitizeDreamPlainField(raw: unknown, maxChars: number): string {
  if (typeof raw !== 'string') return ''
  const stripped = raw
    .replace(CRED_PLACEHOLDER_STRIP_RE, '')
    .replace(CRED_PREFIX_STRIP_RE, '')
    .replace(CONTROL_CHAR_RE, ' ')
  const normalized = inlineText(stripped)
  if (!normalized || normalized.includes(CREDENTIAL_PLACEHOLDER_PREFIX)) return ''
  return clipChars(normalized, maxChars).trim()
}

function parseArchivedNotes(raw: unknown): ArchivedHistoryNote[] {
  if (!Array.isArray(raw)) return []
  const notes: ArchivedHistoryNote[] = []
  for (const item of raw) {
    if (notes.length >= MAX_ARCHIVED_NOTES) break
    if (typeof item === 'string') {
      const cleaned = sanitizeDreamPlainField(item, CHANGE_SUMMARY_MAX)
      if (cleaned) notes.push({ occurredAt: null, note: cleaned })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const text = sanitizeDreamPlainField(rec.note, CHANGE_SUMMARY_MAX)
    if (!text) continue
    notes.push({
      occurredAt: normalizeOccurredAt(rec.occurred_at ?? rec.occurredAt),
      note: text,
    })
  }
  return notes
}

export function parseDreamProposals(
  raw: string,
  catalog: ReadonlyMap<string, DreamPromptItem>,
): ParsedDreamProposal[] {
  const parsed = parseJsonObject(raw)
  const list = parsed && Array.isArray(parsed.suggestions) ? parsed.suggestions : []

  const proposals: ParsedDreamProposal[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const kind =
      typeof rec.kind === 'string' && DREAM_KIND_SET.has(rec.kind)
        ? (rec.kind as DreamSuggestionKind)
        : null
    if (!kind || kind === 'tidy') continue

    const reason = sanitizeDreamPlainField(rec.reason, MAX_REASON_CHARS)
    if (!reason) continue

    const rawTargets = Array.isArray(rec.target_short_ids)
      ? rec.target_short_ids.filter((v): v is string => typeof v === 'string')
      : []
    const resolved: DreamPromptItem[] = []
    const seenIds = new Set<string>()
    for (const sid of rawTargets) {
      const hit = catalog.get(sid.trim().toLowerCase())
      if (hit && !seenIds.has(hit.id)) {
        seenIds.add(hit.id)
        resolved.push(hit)
      }
    }
    if (!resolved.length) continue

    const proposedTitle = sanitizeDreamPlainField(rec.title, ENTRY_TITLE_MAX) || null
    const proposedSummary = sanitizeDreamPlainField(rec.summary, ENTRY_SUMMARY_MAX) || null
    const proposedContent =
      typeof rec.content === 'string' && rec.content.trim()
        ? clipChars(rec.content.trim(), ENTRY_CONTENT_MAX)
        : null
    const proposedDisclosure = sanitizeDreamPlainField(rec.disclosure, DISCLOSURE_MAX) || null
    const proposedChangeSummary =
      sanitizeDreamPlainField(rec.change_summary, CHANGE_SUMMARY_MAX) || null

    if (kind === 'distill_episode') {
      if (!resolved.every((r) => r.kind === 'episode') || !proposedContent) continue
    } else if (kind === 'merge_duplicates') {
      if (resolved.length < 2 || !proposedContent) continue
      if (resolved.some((r) => r.kind !== 'entry' || r.truncated)) continue
      const baseRealms = resolved[0]!.realms
      if (resolved.some((r) => !sameRealms(r.realms, baseRealms))) continue
    } else if (kind === 'mark_stale') {
      if (resolved.length !== 1 || resolved[0]!.kind !== 'entry') continue
    } else if (kind === 'update') {
      if (resolved.length !== 1 || resolved[0]!.kind !== 'entry' || !proposedContent) continue
      const integrity = checkCaptureIntegrity(resolved[0]!.content, proposedContent)
      if (integrity.missingCreds.length > 0) continue
    }

    let keepId: string | null = null
    if (kind === 'merge_duplicates') {
      const keepShort =
        typeof rec.keep_short_id === 'string' ? rec.keep_short_id.trim().toLowerCase() : ''
      const keepItem = catalog.get(keepShort)
      keepId = keepItem && seenIds.has(keepItem.id) ? keepItem.id : resolved[0]!.id
    }

    proposals.push({
      kind,
      entryIds: resolved.map((r) => r.id),
      keepId,
      proposedTitle,
      proposedSummary,
      proposedContent,
      proposedDisclosure,
      proposedChangeSummary,
      archivedNotes: null,
      proposedTopics: asStringArray(rec.topics),
      proposedEnvs: asStringArray(rec.envs),
      proposedRealms: asStringArray(rec.realms),
      proposedProjects: asStringArray(rec.projects),
      proposedRuntimes: asStringArray(rec.runtimes),
      reason,
    })
  }
  return proposals
}

export type TidyParseResult =
  | { status: 'proposal'; proposal: ParsedDreamProposal }
  | { status: 'not_needed' }
  | { status: 'invalid'; reason: string }

export function evaluateTidyResponse(raw: string, target: DreamPromptItem): TidyParseResult {
  const rec = parseJsonObject(raw)
  if (!rec) return { status: 'invalid', reason: '模型输出非合法 JSON' }
  if (rec.needed === false) return { status: 'not_needed' }

  const proposedTitle = sanitizeDreamPlainField(rec.title, ENTRY_TITLE_NEW_MAX) || target.title
  const proposedSummary = sanitizeDreamPlainField(rec.summary, ENTRY_SUMMARY_MAX) || null
  const proposedContent =
    typeof rec.content === 'string' && rec.content.trim()
      ? clipChars(rec.content.trim(), ENTRY_CONTENT_MAX)
      : target.content
  const proposedChangeSummary =
    sanitizeDreamPlainField(rec.change_summary, CHANGE_SUMMARY_MAX) ||
    '规范标题与正文结构，剥离历史流水账'
  const archivedNotes = parseArchivedNotes(rec.archived_notes ?? rec.archivedNotes)
  const reason =
    sanitizeDreamPlainField(rec.reason, MAX_REASON_CHARS) || '规范标题与结构并补充现行概要'

  const effectiveSummary = proposedSummary ?? target.summary ?? null
  const unchanged =
    proposedTitle === target.title &&
    proposedContent === target.content &&
    effectiveSummary === (target.summary ?? null)
  if (unchanged) return { status: 'not_needed' }

  // 严格完整性守卫：规范精简允许安全压缩历史篇幅，但绝不允许丢失任一既有双链或凭据占位符
  const integrity = checkCaptureIntegrity(target.content, proposedContent)
  if (integrity.missingLinks.length > 0 || integrity.missingCreds.length > 0) {
    return { status: 'invalid', reason: '草案丢失原有双链或凭据占位符，已拦截' }
  }

  return {
    status: 'proposal',
    proposal: {
      kind: 'tidy',
      entryIds: [target.id],
      keepId: null,
      proposedTitle,
      proposedSummary,
      proposedContent,
      proposedDisclosure: null,
      proposedChangeSummary,
      archivedNotes: archivedNotes.length ? archivedNotes : null,
      proposedTopics: null,
      proposedEnvs: null,
      proposedRealms: null,
      proposedProjects: null,
      proposedRuntimes: null,
      reason,
    },
  }
}

export function parseTidyProposal(
  raw: string,
  target: DreamPromptItem,
): ParsedDreamProposal | null {
  const res = evaluateTidyResponse(raw, target)
  return res.status === 'proposal' ? res.proposal : null
}
