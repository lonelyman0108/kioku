// 历史里两版正文的按行对比
export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string }
export type DiffRow = DiffLine | { kind: 'skip'; count: number }

// 公共前后缀去掉之后，中间部分超过这么多「行 × 行」就不再逐行对齐，整段算删掉再加上：
// 最长公共子序列要 O(n·m) 的内存，正文最多两万字，极端情况下每个字一行
const MAX_CELLS = 2_000_000

export function diffLines(before: string, after: string): DiffLine[] {
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
  return [...head, ...diffMiddle(midA, midB), ...tail]
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
