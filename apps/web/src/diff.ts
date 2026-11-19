import { whenSignature, type VariantSnapshot, type WhenCondition } from '@kioku/contracts'

// 历史里两版正文的按行对比
export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string }
export type DiffRow = DiffLine | { kind: 'skip'; count: number }

// 公共前后缀去掉之后，中间部分超过这么多「行 × 行」就不再逐行对齐，整段算删掉再加上：
// 最长公共子序列要 O(n·m) 的内存，正文最多两万字，极端情况下每个字一行
const MAX_CELLS = 2_000_000

export function diffLines(before: string, after: string): DiffLine[] {
  return diffWithStatus(before, after).lines
}

// 同 diffLines，另外说明是不是逐行对齐算出来的：complete 为 false 时中间那段超出 MAX_CELLS，
// 整段算删掉再加上，增删的行数不准
export function diffWithStatus(
  before: string,
  after: string,
): { lines: DiffLine[]; complete: boolean } {
  const a = before.split('\n')
  const b = after.split('\n')
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
  // lcs[i * (m + 1) + j]：a[i..] 与 b[j..] 的最长公共子序列长度
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

// 只留改动前后各 context 行，其余没变的行收成一个「省略 N 行」
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

export type VariantDiffStatus = 'added' | 'removed' | 'modified' | 'unchanged' | 'secret'

export interface VariantDiffItem {
  sig: string
  when: WhenCondition
  status: VariantDiffStatus
  rows: DiffRow[]
}

// 历史中前后两次词条快照的多变体切片按 when 签名配对比较
export function diffVariantSnapshots(
  before: readonly VariantSnapshot[] | null,
  after: readonly VariantSnapshot[],
): VariantDiffItem[] {
  const beforeMap = new Map<string, VariantSnapshot>()
  for (const variant of before ?? []) {
    beforeMap.set(whenSignature(variant.when), variant)
  }
  const afterMap = new Map<string, VariantSnapshot>()
  for (const variant of after) {
    afterMap.set(whenSignature(variant.when), variant)
  }

  const ordered: { sig: string; prev?: VariantSnapshot; next?: VariantSnapshot }[] = []
  const seen = new Set<string>()
  for (const variant of after) {
    const sig = whenSignature(variant.when)
    seen.add(sig)
    ordered.push({ sig, prev: beforeMap.get(sig), next: variant })
  }
  for (const variant of before ?? []) {
    const sig = whenSignature(variant.when)
    if (seen.has(sig)) continue
    ordered.push({ sig, prev: variant })
  }

  return ordered.map(({ sig, prev, next }) => {
    const when = next?.when ?? prev!.when
    if (!next) {
      if (prev!.content === null) return { sig, when, status: 'secret', rows: [] }
      return {
        sig,
        when,
        status: 'removed',
        rows: prev!.content.split('\n').map((text) => ({ kind: 'remove' as const, text })),
      }
    }
    if (!prev) {
      if (next.content === null) return { sig, when, status: 'secret', rows: [] }
      return {
        sig,
        when,
        status: 'added',
        rows: next.content.split('\n').map((text) => ({ kind: 'add' as const, text })),
      }
    }
    if (prev.content === null || next.content === null) {
      return { sig, when, status: 'secret', rows: [] }
    }
    if (prev.content === next.content) {
      return { sig, when, status: 'unchanged', rows: [] }
    }
    return {
      sig,
      when,
      status: 'modified',
      rows: collapseUnchanged(diffLines(prev.content, next.content)),
    }
  })
}
