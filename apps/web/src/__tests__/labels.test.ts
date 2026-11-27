import type { DreamSuggestionView } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { partitionCrossSuggestions } from '../components/SingleTidyDrawer.vue'
import { formatActorLabel, resolveActorDisplay } from '../labels'

function makeSuggestion(id: string, shortIds: string[]): DreamSuggestionView {
  return {
    id,
    kind: 'update',
    entryIds: shortIds.map((_, idx) => `00000000-0000-4000-8000-00000000000${idx + 1}`),
    entryVersions: shortIds.map(() => 1),
    keepId: null,
    entries: shortIds.map((shortId, idx) => ({
      id: `00000000-0000-4000-8000-00000000000${idx + 1}`,
      shortId,
      kind: 'entry',
      title: `记忆 ${shortId}`,
      summary: null,
      content: '正文内容',
      disclosure: null,
      isPinned: false,
      envs: [],
      realms: [],
      projects: [],
      runtimes: [],
      topics: [],
      version: 1,
      updatedAt: '2026-11-28T00:00:00.000Z',
    })),
    proposedTitle: null,
    proposedContent: '更新后的正文内容',
    proposedDisclosure: null,
    proposedTopics: null,
    proposedEnvs: null,
    proposedRealms: null,
    proposedProjects: null,
    proposedRuntimes: null,
    reason: '发现需要同步修订的内容',
    status: 'pending',
    createdAt: '2026-11-28T00:00:00.000Z',
    decidedAt: null,
  }
}

describe('操作来源兜底解析', () => {
  it('将 tidy:single 解析为本人 · 规范整理并归入 self 分组', () => {
    expect(resolveActorDisplay('tidy:single')).toEqual({
      kind: 'console',
      label: '本人 · 规范整理',
      group: 'self',
    })
    expect(resolveActorDisplay('  TIDY:SINGLE  ')).toEqual({
      kind: 'console',
      label: '本人 · 规范整理',
      group: 'self',
    })
    expect(formatActorLabel('tidy:single')).toBe('本人 · 规范整理')
  })
})

describe('单条查重与关联建议分组', () => {
  it('按是否包含当前锚点记忆拆分直接建议与关联记忆修订建议', () => {
    const directSingle = makeSuggestion('10000000-0000-4000-8000-000000000001', ['m-aaaa11'])
    const directMerge = makeSuggestion('10000000-0000-4000-8000-000000000002', [
      'm-aaaa11',
      'm-bbbb22',
    ])
    const relatedOld = makeSuggestion('10000000-0000-4000-8000-000000000003', ['m-cccc33'])
    const relatedAnother = makeSuggestion('10000000-0000-4000-8000-000000000004', ['m-dddd44'])

    const grouped = partitionCrossSuggestions(
      [directSingle, relatedOld, directMerge, relatedAnother],
      'm-aaaa11',
    )

    expect(grouped.direct.map((s) => s.id)).toEqual([directSingle.id, directMerge.id])
    expect(grouped.related.map((s) => s.id)).toEqual([relatedOld.id, relatedAnother.id])
  })

  it('仅有关联记忆修订建议时直接建议为空数组', () => {
    const relatedOnly = makeSuggestion('10000000-0000-4000-8000-000000000005', ['m-eeee55'])
    const grouped = partitionCrossSuggestions([relatedOnly], 'm-aaaa11')
    expect(grouped.direct).toEqual([])
    expect(grouped.related).toEqual([relatedOnly])
  })
})
