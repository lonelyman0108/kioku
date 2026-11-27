import {
  effectiveBootMode,
  normalizeSlugList,
  stripDuplicateLeadingHeading,
  type DreamSuggestionView,
  type EntrySnapshot,
} from '@kioku/contracts'

import { bootModeLabels, entryFieldLabels, entryKindLabels, envDisplayName } from './labels'
import { runtimeName } from './runtimes'
import { formatTime } from './time'

// 历史版本与整理建议的正文按行对比与词级行内高亮
export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string }
export type DiffRow = DiffLine | { kind: 'skip'; count: number }

export interface InlineDiffPart {
  kind: 'same' | 'add' | 'remove'
  text: string
}

export interface NumberedDiffLine extends DiffLine {
  index: number
  oldLine: number | null
  newLine: number | null
  parts: InlineDiffPart[]
}

export interface StructuredDiff {
  lines: NumberedDiffLine[]
  complete: boolean
  addedCount: number
  removedCount: number
  hunkStarts: number[]
}

export interface DiffVisibleChunk {
  kind: 'visible'
  start: number
  end: number
}

export interface DiffGapChunk {
  kind: 'gap'
  start: number
  end: number
  count: number
  sectionHeading: string | null
}

export type DiffDisplayChunk = DiffVisibleChunk | DiffGapChunk

export interface SplitDiffPair {
  index: number
  left: NumberedDiffLine | null
  right: NumberedDiffLine | null
}

export interface SnapshotFieldChange {
  field: string
  label: string
  before: string
  after: string
}

const MAX_CELLS = 2_000_000
const MAX_INLINE_CELLS = 40_000
const INLINE_TOKEN_RE = /[A-Za-z0-9._/:|-]+|[\u4e00-\u9fff]|[^\sA-Za-z0-9\u4e00-\u9fff]+|\s+/g

export function diffLines(before: string, after: string): DiffLine[] {
  return diffWithStatus(before, after).lines
}

const splitLines = (text: string) => text.replace(/\r\n/g, '\n').split('\n')

function mergeInlineParts(parts: InlineDiffPart[]): InlineDiffPart[] {
  const out: InlineDiffPart[] = []
  for (const part of parts) {
    if (!part.text) continue
    const last = out.at(-1)
    if (last && last.kind === part.kind) {
      last.text += part.text
    } else {
      out.push({ ...part })
    }
  }
  return out
}

// 词/字级行内对比：按英文标识符、中文单字、标点与空白切分后做 LCS，避免整行标红难以辨认
export function computeInlineDiffParts(
  before: string,
  after: string,
): { removed: InlineDiffPart[]; added: InlineDiffPart[] } {
  const a = before.match(INLINE_TOKEN_RE) ?? []
  const b = after.match(INLINE_TOKEN_RE) ?? []
  if (!a.length || !b.length || a.length * b.length > MAX_INLINE_CELLS) {
    return {
      removed: before ? [{ kind: 'same', text: before }] : [],
      added: after ? [{ kind: 'same', text: after }] : [],
    }
  }
  const n = a.length
  const m = b.length
  const width = m + 1
  const lcs = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  const removed: InlineDiffPart[] = []
  const added: InlineDiffPart[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      removed.push({ kind: 'same', text: a[i]! })
      added.push({ kind: 'same', text: b[j]! })
      i++
      j++
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      removed.push({ kind: 'remove', text: a[i++]! })
    } else {
      added.push({ kind: 'add', text: b[j++]! })
    }
  }
  while (i < n) removed.push({ kind: 'remove', text: a[i++]! })
  while (j < m) added.push({ kind: 'add', text: b[j++]! })
  return {
    removed: mergeInlineParts(removed),
    added: mergeInlineParts(added),
  }
}

export function computeStructuredDiff(before: string | null, after: string): StructuredDiff {
  let rawLines: DiffLine[]
  let complete = true
  if (before === null) {
    rawLines = splitLines(after).map((text): DiffLine => ({ kind: 'add', text }))
  } else {
    const res = diffWithStatus(before, after)
    rawLines = res.lines
    complete = res.complete
  }

  let oldLine = 1
  let newLine = 1
  let addedCount = 0
  let removedCount = 0
  const hunkStarts: number[] = []
  let inChange = false

  const lines: NumberedDiffLine[] = rawLines.map((line, index) => {
    const isChange = line.kind !== 'same'
    if (isChange && !inChange) {
      hunkStarts.push(index)
      inChange = true
    } else if (!isChange) {
      inChange = false
    }
    if (line.kind === 'add') addedCount++
    else if (line.kind === 'remove') removedCount++

    const oldLn = line.kind === 'add' ? null : oldLine++
    const newLn = line.kind === 'remove' ? null : newLine++
    return {
      ...line,
      index,
      oldLine: oldLn,
      newLine: newLn,
      parts: line.text ? [{ kind: 'same', text: line.text }] : [],
    }
  })

  // 为相邻的成对删/增块补算行内词级差异
  let cursor = 0
  while (cursor < lines.length) {
    if (lines[cursor]!.kind !== 'remove') {
      cursor++
      continue
    }
    const delStart = cursor
    while (cursor < lines.length && lines[cursor]!.kind === 'remove') cursor++
    const addStart = cursor
    while (cursor < lines.length && lines[cursor]!.kind === 'add') cursor++
    const pairs = Math.min(addStart - delStart, cursor - addStart)
    for (let k = 0; k < pairs; k++) {
      const delLine = lines[delStart + k]!
      const addLine = lines[addStart + k]!
      const inline = computeInlineDiffParts(delLine.text, addLine.text)
      delLine.parts = inline.removed
      addLine.parts = inline.added
    }
  }

  return { lines, complete, addedCount, removedCount, hunkStarts }
}

export function findNearestMarkdownHeading(
  lines: readonly NumberedDiffLine[],
  atIndex: number,
): string | null {
  const start = Math.min(atIndex, lines.length - 1)
  for (let i = start; i >= 0; i--) {
    const text = lines[i]!.text.trim()
    if (/^#{1,3}\s+\S/.test(text)) return text
  }
  return null
}

// 计算默认折叠态可见行掩码：仅展开每处改动及其上下 context 行；无改动时全部可见
export function buildDiffVisibilityMask(
  lines: readonly NumberedDiffLine[],
  hunkStarts: readonly number[],
  context = 3,
): boolean[] {
  const total = lines.length
  const mask = new Array<boolean>(total).fill(false)
  if (!hunkStarts.length) {
    mask.fill(true)
    return mask
  }
  const safeContext = Math.max(0, Math.floor(context))
  for (let i = 0; i < total; i++) {
    if (lines[i]!.kind !== 'same') {
      const from = Math.max(0, i - safeContext)
      const to = Math.min(total - 1, i + safeContext)
      for (let k = from; k <= to; k++) mask[k] = true
    }
  }
  return mask
}

// 对指定省略区间按方向展开上下文（up 从底部向上、down 从顶部向下、all 全部展开）
export function expandDiffGap(
  visibleMask: readonly boolean[],
  start: number,
  end: number,
  direction: 'up' | 'down' | 'all',
  expandStep: number,
): boolean[] {
  const next = [...visibleMask]
  const clampedStart = Math.max(0, start)
  const clampedEnd = Math.min(next.length, end)
  const safeStep = Math.max(1, Math.floor(expandStep))
  if (direction === 'all') {
    for (let i = clampedStart; i < clampedEnd; i++) next[i] = true
  } else if (direction === 'up') {
    const from = Math.max(clampedStart, clampedEnd - safeStep)
    for (let i = from; i < clampedEnd; i++) next[i] = true
  } else {
    const to = Math.min(clampedEnd, clampedStart + safeStep)
    for (let i = clampedStart; i < to; i++) next[i] = true
  }
  return next
}

// 按可见行掩码计算可交互折叠分段，支持在任意省略段向上/向下按需展开上下文
export function buildDiffDisplayChunks(
  lines: readonly NumberedDiffLine[],
  visibleMask: readonly boolean[],
  fullMode = false,
): DiffDisplayChunk[] {
  const total = lines.length
  const chunks: DiffDisplayChunk[] = []
  let i = 0
  while (i < total) {
    if (fullMode || visibleMask[i]) {
      const start = i
      while (i < total && (fullMode || visibleMask[i])) i++
      chunks.push({ kind: 'visible', start, end: i })
    } else {
      const start = i
      while (i < total && !visibleMask[i]) i++
      chunks.push({
        kind: 'gap',
        start,
        end: i,
        count: i - start,
        sectionHeading: findNearestMarkdownHeading(lines, i - 1),
      })
    }
  }
  return chunks
}

// 将可见区间内的连续删/增行配对为左右双栏行
export function buildSplitDiffPairs(
  lines: readonly NumberedDiffLine[],
  start: number,
  end: number,
): SplitDiffPair[] {
  const out: SplitDiffPair[] = []
  let i = start
  while (i < end) {
    const line = lines[i]!
    if (line.kind === 'same') {
      out.push({ index: line.index, left: line, right: line })
      i++
      continue
    }
    const dels: NumberedDiffLine[] = []
    const adds: NumberedDiffLine[] = []
    const firstIdx = line.index
    while (i < end && lines[i]!.kind === 'remove') dels.push(lines[i++]!)
    while (i < end && lines[i]!.kind === 'add') adds.push(lines[i++]!)
    const rows = Math.max(dels.length, adds.length)
    for (let r = 0; r < rows; r++) {
      out.push({
        index: r === 0 ? firstIdx : (dels[r]?.index ?? adds[r]?.index ?? firstIdx),
        left: dels[r] ?? null,
        right: adds[r] ?? null,
      })
    }
  }
  return out
}

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
  if (prev.bootMode !== undefined || curr.bootMode !== undefined) {
    const prevMode = effectiveBootMode(prev)
    const currMode = effectiveBootMode(curr)
    if (prevMode !== currMode) {
      push('bootMode', bootModeLabels[prevMode], bootModeLabels[currMode])
    }
  } else if (prev.isPinned !== curr.isPinned) {
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
