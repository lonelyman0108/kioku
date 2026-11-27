import { describe, expect, it } from 'vitest'

import {
  applyTidyCheckedVersionMerge,
  applyTidyCheckedVersionTransitions,
} from '../../models/store'
import { resolveStaticActorMeta } from '../actorMeta'
import {
  carryForwardDreamCheckedVersion,
  hasManualContentOverride,
  hasRemainingTidyIssue,
} from '../service'

describe('整理水位顺延与操作来源纯函数', () => {
  it('carryForwardDreamCheckedVersion 仅在满足条件且写入前已审阅当前版本时顺延', () => {
    expect(carryForwardDreamCheckedVersion({ version: 3, dreamCheckedVersion: 3 }, 4, true)).toBe(4)
    expect(carryForwardDreamCheckedVersion({ version: 3, dreamCheckedVersion: 0 }, 4, true)).toBe(0)
    expect(carryForwardDreamCheckedVersion({ version: 3, dreamCheckedVersion: 2 }, 4, true)).toBe(2)
    expect(carryForwardDreamCheckedVersion({ version: 3, dreamCheckedVersion: 3 }, 4, false)).toBe(
      3,
    )
    expect(carryForwardDreamCheckedVersion({ version: 3, dreamCheckedVersion: 1 }, 4, false)).toBe(
      1,
    )
  })

  it('applyTidyCheckedVersionTransitions 仅顺延命中原版本的记录，无命中时返回 changed=false', () => {
    const base = { a: 2, b: 5, c: 1 }

    const noHit = applyTidyCheckedVersionTransitions(base, [
      { id: 'a', fromVersion: 1, toVersion: 2 },
      { id: 'missing', fromVersion: 1, toVersion: 2 },
      { id: 'b', fromVersion: 5, toVersion: 5 },
      { id: 'c', fromVersion: 1, toVersion: 0 },
    ])
    expect(noHit.changed).toBe(false)
    expect(noHit.next).toEqual(base)

    const partialHit = applyTidyCheckedVersionTransitions(base, [
      { id: 'a', fromVersion: 2, toVersion: 3 },
      { id: 'b', fromVersion: 4, toVersion: 5 },
      { id: 'missing', fromVersion: 1, toVersion: 2 },
    ])
    expect(partialHit.changed).toBe(true)
    expect(partialHit.next).toEqual({ a: 3, b: 5, c: 1 })
    // 不原地修改输入对象
    expect(base).toEqual({ a: 2, b: 5, c: 1 })
  })

  it('applyTidyCheckedVersionMerge 单调合并更新、仅清理非更新失效键且保留并发新键', () => {
    const current = { keepHigher: 5, concurrentNew: 2, staleA: 1, keepViaUpdate: 1 }

    const noChange = applyTidyCheckedVersionMerge(
      current,
      new Map([['keepHigher', 3]]),
      new Set(['notPresent']),
    )
    expect(noChange.changed).toBe(false)
    expect(noChange.next).toEqual(current)

    const merged = applyTidyCheckedVersionMerge(
      current,
      new Map([
        ['keepHigher', 4],
        ['keepViaUpdate', 2],
        ['batchNew', 1],
      ]),
      new Set(['staleA', 'keepViaUpdate']),
    )
    expect(merged.changed).toBe(true)
    expect(merged.next).toEqual({
      keepHigher: 5,
      concurrentNew: 2,
      keepViaUpdate: 2,
      batchNew: 1,
    })
    expect(current).toEqual({ keepHigher: 5, concurrentNew: 2, staleA: 1, keepViaUpdate: 1 })
  })

  it('hasManualContentOverride 区分取消勾选原文与真正的人工改写正文', () => {
    expect(hasManualContentOverride(undefined, '建议正文', '原始正文')).toBe(false)
    expect(hasManualContentOverride('原始正文', '建议正文', '原始正文')).toBe(false)
    expect(hasManualContentOverride('建议正文', '建议正文', '原始正文')).toBe(false)
    expect(hasManualContentOverride('人工新正文', '建议正文', '原始正文')).toBe(true)
    expect(hasManualContentOverride('原始正文', null, '原始正文')).toBe(false)
    expect(hasManualContentOverride('人工新正文', null, '原始正文')).toBe(true)
  })

  it('hasRemainingTidyIssue 与批量规范候选口径一致，忽略 pinned_oversized 但拦截缺概要与卫生问题', () => {
    expect(
      hasRemainingTidyIssue({
        title: '规范标题',
        content: '简短清晰正文。',
        summary: null,
        isPinned: false,
        bootMode: 'none',
        topics: ['ops'],
      }),
    ).toBe(false)
    expect(
      hasRemainingTidyIssue({
        title: '2026-01-01 旧日志标题',
        content: '简短清晰正文。',
        summary: '概要。',
        isPinned: false,
        bootMode: 'none',
        topics: ['ops'],
      }),
    ).toBe(true)
    expect(
      hasRemainingTidyIssue({
        title: '常驻规则',
        content: '简短规则。',
        summary: null,
        isPinned: true,
        bootMode: 'index',
        topics: [],
      }),
    ).toBe(true)
    expect(
      hasRemainingTidyIssue({
        title: '较长正文',
        content: '详'.repeat(420),
        summary: null,
        isPinned: false,
        bootMode: 'none',
        topics: [],
      }),
    ).toBe(true)
    expect(
      hasRemainingTidyIssue({
        title: '长全文常驻但有概要',
        content: '详'.repeat(1_500),
        summary: '已有现行概要。',
        isPinned: true,
        bootMode: 'full',
        topics: ['core'],
      }),
    ).toBe(false)
  })

  it('resolveStaticActorMeta 支持 tidy:single 并保留原有静态来源', () => {
    expect(resolveStaticActorMeta('tidy:single')).toEqual({
      kind: 'console',
      label: '本人 · 规范整理',
      runtimeFamily: null,
    })
    expect(resolveStaticActorMeta('console')).toEqual({
      kind: 'console',
      label: '本人 · 控制台',
      runtimeFamily: null,
    })
    expect(resolveStaticActorMeta('hygiene:sweep')).toEqual({
      kind: 'system',
      label: '结构检查',
      runtimeFamily: null,
    })
  })
})
