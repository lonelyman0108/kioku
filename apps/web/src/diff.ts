import {
  normalizeSlugList,
  stripDuplicateLeadingHeading,
  type DreamSuggestionView,
  type EntrySnapshot,
} from '@kioku/contracts'

import { entryFieldLabels, entryKindLabels, envDisplayName } from './labels'
import { runtimeName } from './runtimes'
import { formatTime } from './time'

// 历史版本与整理建议的正文按行对比
export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string }
export type DiffRow = DiffLine | { kind: 'skip'; count: number }

export interface SnapshotFieldChange {
  field: string
  label: string
  before: string
  after: string
}

const MAX_CELLS = 2_000_000

export function diffLines(before: string, after: string): DiffLine[] {
  return diffWithStatus(before, after).lines
}

const splitLines = (text: string) => text.replace(/\r\n/g, '\n').split('\n')

export function diffWithStatus(
  before: string,
  after: string,
): { lines: DiffLine[]; complete: boolean } {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head = a.slice(0, start).map((text): DiffLine => ({ kind: 'same', text }))
  const tail = a.slice(endA).map((text): DiffLine => ({ kind: 'same', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  return {
    lines: [...head, ...diffMiddle(midA, midB), ...tail],
    complete: midA.length * midB.length <= MAX_CELLS,
  }
}

function diffMiddle(a: string[], b: string[]): DiffLine[] {
  const removed = a.map((text): DiffLine => ({ kind: 'remove', text }))
  const added = b.map((text): DiffLine => ({ kind: 'add', text }))
  if (!a.length || !b.length || a.length * b.length > MAX_CELLS) return [...removed, ...added]
  const n = a.length
  const m = b.length
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      out.push({ kind: 'remove', text: a[i++]! })
    } else {
      out.push({ kind: 'add', text: b[j++]! })
    }
  }
  while (i < n) out.push({ kind: 'remove', text: a[i++]! })
  while (j < m) out.push({ kind: 'add', text: b[j++]! })
  return out
}

export function collapseUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = lines.map(() => false)
  lines.forEach((line, index) => {
    if (line.kind === 'same') return
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(lines.length - 1, index + context);
      k++
    ) {
      keep[k] = true
    }
  })
  const rows: DiffRow[] = []
  let skipped = 0
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) rows.push({ kind: 'skip', count: skipped })
      skipped = 0
      rows.push(line)
    } else {
      skipped++
    }
  })
  if (skipped) rows.push({ kind: 'skip', count: skipped })
  return rows
}

function formatList(
  values: readonly string[],
  emptyText: string,
  mapper?: (item: string) => string,
): string {
  const list = normalizeSlugList(values)
  if (!list.length) return emptyText
  return (mapper ? list.map(mapper) : list).join('、')
}

// 对比两个历史快照的元数据属性变动（不含正文），用于修复纯元数据变动无对比内容的问题
export function diffEntrySnapshots(
  prev: EntrySnapshot | null | undefined,
  curr: EntrySnapshot,
): SnapshotFieldChange[] {
  if (!prev) return []
  const changes: SnapshotFieldChange[] = []
  const push = (field: string, before: string, after: string) => {
    changes.push({
      field,
      label: entryFieldLabels[field] ?? field,
      before,
      after,
    })
  }

  if (prev.title !== curr.title) {
    push('title', prev.title || '（空）', curr.title || '（空）')
  }
  const prevSummary = prev.summary?.trim() ?? ''
  const currSummary = curr.summary?.trim() ?? ''
  if (prevSummary !== currSummary) {
    push('summary', prevSummary || '（空）', currSummary || '（空）')
  }
  if (prev.isPinned !== curr.isPinned) {
    push('isPinned', prev.isPinned ? '常驻' : '按需', curr.isPinned ? '常驻' : '按需')
  }
  const prevDisclosure = prev.disclosure?.trim() ?? ''
  const currDisclosure = curr.disclosure?.trim() ?? ''
  if (prevDisclosure !== currDisclosure) {
    push('disclosure', prevDisclosure || '（空）', currDisclosure || '（空）')
  }
  if (prev.kind !== curr.kind) {
    push('kind', entryKindLabels[prev.kind], entryKindLabels[curr.kind])
  }

  const prevTopics = normalizeSlugList(prev.topics)
  const currTopics = normalizeSlugList(curr.topics)
  if (prevTopics.join('\n') !== currTopics.join('\n')) {
    push('topics', formatList(prevTopics, '（无）'), formatList(currTopics, '（无）'))
  }

  const prevEnvs = normalizeSlugList(prev.envs)
  const currEnvs = normalizeSlugList(curr.envs)
  if (prevEnvs.join('\n') !== currEnvs.join('\n')) {
    push(
      'envs',
      formatList(prevEnvs, '不限', envDisplayName),
      formatList(currEnvs, '不限', envDisplayName),
    )
  }

  const prevRealms = normalizeSlugList(prev.realms)
  const currRealms = normalizeSlugList(curr.realms)
  if (prevRealms.join('\n') !== currRealms.join('\n')) {
    push('realms', formatList(prevRealms, '不限'), formatList(currRealms, '不限'))
  }

  const prevProjects = normalizeSlugList(prev.projects)
  const currProjects = normalizeSlugList(curr.projects)
  if (prevProjects.join('\n') !== currProjects.join('\n')) {
    push('projects', formatList(prevProjects, '不限'), formatList(currProjects, '不限'))
  }

  const prevRuntimes = normalizeSlugList(prev.runtimes)
  const currRuntimes = normalizeSlugList(curr.runtimes)
  if (prevRuntimes.join('\n') !== currRuntimes.join('\n')) {
    push(
      'runtimes',
      formatList(prevRuntimes, '不限', runtimeName),
      formatList(currRuntimes, '不限', runtimeName),
    )
  }

  if (prev.validTo !== curr.validTo) {
    push(
      'validTo',
      prev.validTo ? formatTime(prev.validTo) : '长期有效',
      curr.validTo ? formatTime(curr.validTo) : '长期有效',
    )
  }

  return changes
}

// 判断一条规范整理建议是否仅涉及改标题或现行概要，不改写大段正文（用于待处理页纯标题速审表）
export function isTitleOnlyTidy(suggestion: DreamSuggestionView): boolean {
  if (suggestion.kind !== 'tidy') return false
  const base =
    (suggestion.keepId
      ? suggestion.entries.find((e) => e.id === suggestion.keepId)
      : suggestion.entries[0]) ?? suggestion.entries[0]
  if (!base) return false

  const proposedTitle = suggestion.proposedTitle?.trim() ?? ''
  const titleChanged = Boolean(proposedTitle && proposedTitle !== base.title)
  const summaryChanged = Boolean(
    suggestion.proposedSummary !== undefined &&
    suggestion.proposedSummary !== null &&
    suggestion.proposedSummary.trim() !== (base.summary?.trim() ?? ''),
  )
  if (!titleChanged && !summaryChanged) return false
  if (suggestion.archivedNotes && suggestion.archivedNotes.length > 0) return false
  if (!suggestion.proposedContent) return true

  const beforeRaw = base.content.trim()
  const afterRaw = suggestion.proposedContent.trim()
  if (beforeRaw === afterRaw) return true

  const beforeClean = stripDuplicateLeadingHeading(base.title, base.content).trim()
  const afterClean = stripDuplicateLeadingHeading(
    proposedTitle || base.title,
    suggestion.proposedContent,
  ).trim()
  return beforeClean === afterClean
}
