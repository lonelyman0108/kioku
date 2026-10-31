import type { DreamRunEntry } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { dreamScopeText, runEntrySummary, runOutcome, sharedSummaryText } from '../dream'

const entry: DreamRunEntry = {
  scope: null,
  model: 'm',
  tokens: 1_234,
  changed: 3,
  considered: 5,
  suggested: 2,
  known: 1,
  dropped: 0,
  more: false,
  skipped: null,
  error: null,
}

describe('Dream 的范围', () => {
  it('共享的层带名字，个人画像层与私人层只说层名，联系人与情节说是在哪里的对话里记下的', () => {
    const base = { id: null, name: null, origin: null }
    expect(dreamScopeText({ ...base, kind: 'base' })).toBe('基础层')
    expect(dreamScopeText({ ...base, kind: 'persona', name: '豆包' })).toBe('人格「豆包」')
    expect(dreamScopeText({ ...base, kind: 'app' })).toBe('已删除的应用')
    expect(dreamScopeText({ ...base, kind: 'private' })).toBe('私人层')
    expect(
      dreamScopeText({
        ...base,
        kind: 'talk',
        origin: { kind: 'group', id: null, name: '读书会' },
      }),
    ).toBe('群「读书会」中记下的')
  })
})

describe('运行记录', () => {
  it('处理了几条、提了几条建议，没有的项不列', () => {
    expect(runEntrySummary(entry)).toBe(
      '1,234 token · 处理 5 条（新增或修改 3 条） · 新建议 2 条 · 与已有建议重复 1 条',
    )
    expect(
      runEntrySummary({ ...entry, considered: 3, suggested: 0, known: 0, dropped: 2, more: true }),
    ).toBe(
      '1,234 token · 处理 3 条 · 无新建议 · 已丢弃不合规建议 2 条 · 还有未处理的内容，下次继续',
    )
  })

  it('没整理的只说原因', () => {
    expect(runEntrySummary({ ...entry, tokens: 0, skipped: 'budget' })).toBe(
      '未整理：本月抽取预算已用完',
    )
  })

  it('共享部分的汇总只说共享的内容整体怎样，用量与建议看各个范围的条目', () => {
    const summary = { ...entry, tokens: 0, changed: 0, considered: 0, suggested: 0, known: 0 }
    expect(sharedSummaryText(summary)).toBe('已整理')
    expect(sharedSummaryText({ ...summary, more: true })).toBe('已整理，还有未处理的内容，下次继续')
    expect(sharedSummaryText({ ...summary, skipped: 'idle' })).toBe('上次以来没有新增或修改')
    expect(sharedSummaryText({ ...summary, skipped: 'no-model' })).toBe(
      '未整理：尚未配置抽取模型（可在实例设置中配置）',
    )
    expect(sharedSummaryText({ ...summary, error: '共享范围出错' })).toBe('出错，本次已停止')
  })

  it('「立即整理」做完之后按结果给提示，还没做完时不提示', () => {
    expect(runOutcome({ state: 'running', outcome: null, reason: null })).toBeNull()
    expect(runOutcome({ state: 'finished', outcome: 'done', reason: null })?.color).toBe('success')
    expect(runOutcome({ state: 'finished', outcome: 'skipped', reason: 'idle' })).toEqual({
      title: '无需整理：上次以来没有新增或修改的内容',
      color: 'warning',
    })
    expect(runOutcome({ state: 'finished', outcome: 'failed', reason: null })?.color).toBe('error')
  })
})
