import type { DreamRunEntry } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { dreamScopeText, runEntrySummary, runOutcome } from '../dream'

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
  it('共享的层带名字，画像层与私人层只说是我的，对象与情节说是在哪里的对话里记下的', () => {
    const base = { id: null, name: null, origin: null }
    expect(dreamScopeText({ ...base, kind: 'base' })).toBe('基础层')
    expect(dreamScopeText({ ...base, kind: 'persona', name: '豆包' })).toBe('人格「豆包」')
    expect(dreamScopeText({ ...base, kind: 'app' })).toBe('已删除的应用')
    expect(dreamScopeText({ ...base, kind: 'private' })).toBe('我的私人层')
    expect(
      dreamScopeText({
        ...base,
        kind: 'talk',
        origin: { kind: 'group', id: null, name: '读书会' },
      }),
    ).toBe('群「读书会」里记下的')
  })
})

describe('运行记录', () => {
  it('看了几条、提了几条建议，没有的项不列', () => {
    expect(runEntrySummary(entry)).toBe(
      '1,234 token · 看了 5 条（新增或改动的 3 条） · 新建议 2 条 · 和已有的一样 1 条',
    )
    expect(
      runEntrySummary({ ...entry, considered: 3, suggested: 0, known: 0, dropped: 2, more: true }),
    ).toBe('1,234 token · 看了 3 条 · 没有新建议 · 不合规则丢掉 2 条 · 还有没看完的，下次接着整理')
  })

  it('没整理的只说原因', () => {
    expect(runEntrySummary({ ...entry, tokens: 0, skipped: 'budget' })).toBe(
      '没整理：本月的抽取预算用完了',
    )
  })

  it('「现在整理一次」做完之后按结果给提示，还没做完时不提示', () => {
    expect(runOutcome({ state: 'running', outcome: null, reason: null })).toBeNull()
    expect(runOutcome({ state: 'finished', outcome: 'done', reason: null })?.color).toBe('success')
    expect(runOutcome({ state: 'finished', outcome: 'skipped', reason: 'idle' })).toEqual({
      title: '没有要整理的：上次以来没有新增或改动的内容',
      color: 'warning',
    })
    expect(runOutcome({ state: 'finished', outcome: 'failed', reason: null })?.color).toBe('error')
  })
})
