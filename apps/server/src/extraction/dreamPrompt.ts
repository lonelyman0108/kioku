import {
  DISCLOSURE_MAX,
  DREAM_KINDS,
  ENTRY_CONTENT_MAX,
  ENTRY_TITLE_MAX,
  normalizeSlugList,
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
  proposedContent: string | null
  proposedDisclosure: string | null
  proposedTopics: string[] | null
  proposedEnvs: string[] | null
  proposedRealms: string[] | null
  proposedProjects: string[] | null
  proposedRuntimes: string[] | null
  reason: string
}

const DREAM_KIND_SET: ReadonlySet<string> = new Set(DREAM_KINDS)
const MAX_REASON_CHARS = 300

const SYSTEM_PROMPT = [
  '你是 Kioku 记忆整理助手。请审阅给出的记忆词条（entry）与近期会话摘要（episode），只在确实值得整理时提出少量高价值建议。',
  '只输出 JSON：{"suggestions":[...]}，没有建议时输出 {"suggestions":[]}。',
  '',
  '仅允许以下 4 种建议类型（kind）：',
  '1. "distill_episode"：把 1 条或多条有长期价值的会话摘要（episode）提炼为一条永久正式记忆。须提供 target_short_ids、title、content、reason，可选 disclosure、topics、envs、realms、projects、runtimes。',
  '2. "merge_duplicates"：合并 2 条以上内容高度重叠且 realms 一致的正式记忆（entry）。须提供 target_short_ids、keep_short_id、title、content、reason，可选 disclosure、topics、envs、realms、projects、runtimes。不得合并被截断的词条。',
  '3. "mark_stale"：某条正式记忆已被更新的记忆推翻或明显过时失效。须提供 target_short_ids（1 条）与 reason。',
  '4. "update"：根据更新的会话摘要或其他记忆，对某条现有正式记忆做具体事实补充或修正。须提供 target_short_ids（1 条）、content、reason，可选 title、disclosure、topics、envs、realms、projects、runtimes。',
  '',
  '严格约束：',
  '- 宁缺毋滥，不要为细枝末节的措辞调整提建议。',
  '- 严禁编造任何密码、API Key 或令牌；原文中的 {{cred:...}} 占位符必须原样保留。',
  '- target_short_ids 必须全部取自下方提供的列表。',
].join('\n')

function formatItem(item: DreamPromptItem): string {
  const tags: string[] = []
  if (item.projects.length) tags.push(`project=${item.projects.join(',')}`)
  if (item.envs.length) tags.push(`env=${item.envs.join(',')}`)
  if (item.realms.length) tags.push(`realm=${item.realms.join(',')}`)
  if (item.runtimes.length) tags.push(`runtime=${item.runtimes.join(',')}`)
  if (item.topics.length) tags.push(`topic=${item.topics.join(',')}`)
  const head = `[${item.shortId}] (${item.kind}${item.truncated ? ', 已截断' : ''}) ${item.title} | 更新于 ${item.updatedAt.slice(0, 10)}${tags.length ? ` | ${tags.join(' ')}` : ''}`
  const disc = item.disclosure ? `\n触发场景：${item.disclosure}` : ''
  return `${head}${disc}\n${item.content}`
}

export function buildDreamMessages(
  changed: readonly DreamPromptItem[],
  neighbors: readonly DreamPromptItem[],
): ChatMessage[] {
  const sections: string[] = ['## 本次待整理的新增/变动记录', ...changed.map(formatItem)]
  if (neighbors.length) {
    sections.push('', '## 相关已有记忆（供查重与核对参考）', ...neighbors.map(formatItem))
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
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

export function parseDreamProposals(
  raw: string,
  catalog: ReadonlyMap<string, DreamPromptItem>,
): ParsedDreamProposal[] {
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first < 0 || last <= first) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(first, last + 1))
  } catch {
    return []
  }
  const list =
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { suggestions?: unknown }).suggestions)
      ? (parsed as { suggestions: unknown[] }).suggestions
      : []

  const proposals: ParsedDreamProposal[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const kind =
      typeof rec.kind === 'string' && DREAM_KIND_SET.has(rec.kind)
        ? (rec.kind as DreamSuggestionKind)
        : null
    if (!kind) continue

    const reason =
      typeof rec.reason === 'string' ? clipChars(inlineText(rec.reason), MAX_REASON_CHARS) : ''
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

    const proposedTitle =
      typeof rec.title === 'string' && rec.title.trim()
        ? clipChars(inlineText(rec.title), ENTRY_TITLE_MAX)
        : null
    const proposedContent =
      typeof rec.content === 'string' && rec.content.trim()
        ? clipChars(rec.content.trim(), ENTRY_CONTENT_MAX)
        : null
    const proposedDisclosure =
      typeof rec.disclosure === 'string' && rec.disclosure.trim()
        ? clipChars(inlineText(rec.disclosure), DISCLOSURE_MAX)
        : null

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
      proposedContent,
      proposedDisclosure,
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
