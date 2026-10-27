import { describe, expect, it } from 'vitest'

import { collapseUnchanged, diffLines } from '../diff'

describe('按行对比', () => {
  it('找出删掉与加上的行，没变的行保留', () => {
    expect(diffLines('甲\n乙\n丙', '甲\n丁\n丙')).toEqual([
      { kind: 'same', text: '甲' },
      { kind: 'remove', text: '乙' },
      { kind: 'add', text: '丁' },
      { kind: 'same', text: '丙' },
    ])
    expect(diffLines('一\n二', '一\n二\n三')).toEqual([
      { kind: 'same', text: '一' },
      { kind: 'same', text: '二' },
      { kind: 'add', text: '三' },
    ])
    expect(diffLines('', '新的')).toEqual([
      { kind: 'remove', text: '' },
      { kind: 'add', text: '新的' },
    ])
  })

  it('中间插入时对齐到最长公共子序列', () => {
    const kinds = diffLines('a\nb\nc\nd', 'a\nx\nb\nc\ny\nd').map((l) => `${l.kind[0]}${l.text}`)
    expect(kinds).toEqual(['sa', 'ax', 'sb', 'sc', 'ay', 'sd'])
  })

  it('中间部分太大时整段算删掉再加上，不按行对齐', () => {
    const a = Array.from({ length: 2000 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 2000 }, (_, i) => `b${i}`).join('\n')
    const lines = diffLines(a, b)
    expect(lines.filter((l) => l.kind === 'remove')).toHaveLength(2000)
    expect(lines.filter((l) => l.kind === 'add')).toHaveLength(2000)
    expect(lines[0]!.kind).toBe('remove')
  })

  it('没变的长段落收起来，只留改动前后几行', () => {
    const before = Array.from({ length: 20 }, (_, i) => `行${i}`).join('\n')
    const after = before.replace('行10', '改过的行')
    const rows = collapseUnchanged(diffLines(before, after), 2)
    expect(rows[0]).toEqual({ kind: 'skip', count: 8 })
    expect(rows.slice(1, 7).map((r) => r.kind)).toEqual([
      'same',
      'same',
      'remove',
      'add',
      'same',
      'same',
    ])
    expect(rows.at(-1)).toEqual({ kind: 'skip', count: 7 })
  })
})
