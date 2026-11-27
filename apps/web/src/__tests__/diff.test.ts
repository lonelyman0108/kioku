import type { DreamSuggestionView, EntrySnapshot } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  buildDiffDisplayChunks,
  buildDiffVisibilityMask,
  buildSplitDiffPairs,
  collapseUnchanged,
  computeInlineDiffParts,
  computeStructuredDiff,
  diffEntrySnapshots,
  diffLines,
  diffWithStatus,
  expandDiffGap,
  isTitleOnlyTidy,
} from '../diff'

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

  it('归一化 CRLF 换行符，不因行尾差异把整段标成改动', () => {
    expect(diffLines('甲\r\n乙\r\n丙', '甲\n乙\n丙\n丁')).toEqual([
      { kind: 'same', text: '甲' },
      { kind: 'same', text: '乙' },
      { kind: 'same', text: '丙' },
      { kind: 'add', text: '丁' },
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

describe('对比算没算完', () => {
  it('中间那段太长时整段算删掉再加上，标出没有逐行对齐', () => {
    expect(diffWithStatus('甲\n乙', '甲\n丙').complete).toBe(true)
    const before = Array.from({ length: 2000 }, (_, i) => `a${i}`).join('\n')
    const after = Array.from({ length: 2000 }, (_, i) => `b${i}`).join('\n')
    const { lines, complete } = diffWithStatus(before, after)
    expect(complete).toBe(false)
    expect(lines.filter((l) => l.kind === 'add')).toHaveLength(2000)
  })
})

function makeSnapshot(overrides: Partial<EntrySnapshot> = {}): EntrySnapshot {
  return {
    kind: 'entry',
    title: '默认标题',
    summary: null,
    content: '正文内容',
    disclosure: null,
    isPinned: false,
    envs: [],
    realms: [],
    projects: [],
    runtimes: [],
    topics: [],
    validTo: null,
    verifiedAt: null,
    version: 1,
    ...overrides,
  }
}

describe('快照属性变动对比', () => {
  it('识别纯元数据变动，输出中文标签与改前改后值', () => {
    const prev = makeSnapshot({
      title: '旧标题',
      summary: null,
      isPinned: false,
      topics: ['docker'],
      envs: ['mac'],
      disclosure: null,
      validTo: null,
    })
    const curr = makeSnapshot({
      title: '新短标题',
      summary: '一条简明概要',
      isPinned: true,
      topics: ['docker', 'network'],
      envs: ['linux', 'mac'],
      disclosure: '排查容器网络时',
      validTo: '2026-12-31T15:59:00Z',
      version: 2,
    })
    const changes = diffEntrySnapshots(prev, curr)
    expect(changes.map((c) => c.field)).toEqual([
      'title',
      'summary',
      'isPinned',
      'disclosure',
      'topics',
      'envs',
      'validTo',
    ])
    expect(changes.find((c) => c.field === 'isPinned')).toEqual({
      field: 'isPinned',
      label: '常驻',
      before: '按需',
      after: '常驻',
    })
    expect(changes.find((c) => c.field === 'summary')).toEqual({
      field: 'summary',
      label: '现行概要',
      before: '（空）',
      after: '一条简明概要',
    })
    expect(changes.find((c) => c.field === 'envs')).toEqual({
      field: 'envs',
      label: '环境',
      before: 'macOS',
      after: 'Linux、macOS',
    })
  })

  it('识别三态 bootMode 快照变动并输出中文标签', () => {
    const prev = makeSnapshot({ isPinned: true, bootMode: 'full' })
    const curr = makeSnapshot({ isPinned: true, bootMode: 'index', version: 2 })
    expect(diffEntrySnapshots(prev, curr)).toEqual([
      {
        field: 'bootMode',
        label: '启动加载',
        before: '全文常驻',
        after: '目录常驻',
      },
    ])
  })

  it('无元数据差异时返回空数组', () => {
    const snap = makeSnapshot({ topics: ['a', 'b'] })
    expect(diffEntrySnapshots(snap, makeSnapshot({ topics: ['b', 'a'], version: 2 }))).toEqual([])
    expect(diffEntrySnapshots(null, snap)).toEqual([])
  })
})

function makeTidySuggestion(overrides: Partial<DreamSuggestionView> = {}): DreamSuggestionView {
  const baseId = '11111111-1111-4111-8111-111111111111'
  return {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'tidy',
    entryIds: [baseId],
    entryVersions: [2],
    keepId: baseId,
    entries: [
      {
        id: baseId,
        shortId: 'm-234abc',
        kind: 'entry',
        title: '网络拓扑（2026-10-01 更新）',
        summary: null,
        content: '# 网络拓扑（2026-10-01 更新）\n\n## 当前配置\n- 路由运行正常\n'.repeat(10),
        disclosure: null,
        isPinned: true,
        envs: [],
        realms: [],
        projects: [],
        runtimes: [],
        topics: [],
        verifiedAt: null,
        lastChangeSummary: null,
        version: 2,
        updatedAt: '2026-10-01T00:00:00Z',
      },
    ],
    proposedTitle: '网络拓扑',
    proposedSummary: '家庭网络当前路由结构正常',
    proposedContent: '# 网络拓扑（2026-10-01 更新）\n\n## 当前配置\n- 路由运行正常\n'.repeat(10),
    proposedDisclosure: null,
    proposedChangeSummary: '精简标题并补充现行概要',
    archivedNotes: null,
    proposedTopics: null,
    proposedEnvs: null,
    proposedRealms: null,
    proposedProjects: null,
    proposedRuntimes: null,
    reason: '移除标题中的更新日期后缀',
    status: 'pending',
    createdAt: '2026-10-02T00:00:00Z',
    decidedAt: null,
    ...overrides,
  }
}

describe('纯标题速审表判定', () => {
  it('仅改标题或补概要时不改动正文主体的 tidy 建议可进入速审表', () => {
    expect(isTitleOnlyTidy(makeTidySuggestion())).toBe(true)
    expect(isTitleOnlyTidy(makeTidySuggestion({ proposedContent: null }))).toBe(true)
    expect(
      isTitleOnlyTidy(
        makeTidySuggestion({
          entries: [
            {
              ...makeTidySuggestion().entries[0]!,
              content: '# 网络拓扑（2026-10-01 更新）\n\n## 当前配置\n- 路由运行正常\n',
            },
          ],
          proposedContent: '## 当前配置\n- 路由运行正常\n',
        }),
      ),
    ).toBe(true)
    expect(
      isTitleOnlyTidy(
        makeTidySuggestion({
          entries: [
            {
              ...makeTidySuggestion().entries[0]!,
              content: '# 网络拓扑（2026-10-01 更新）\n\n## 当前配置\n- 路由运行正常\n',
            },
          ],
          proposedContent: '# 网络拓扑\n\n## 当前配置\n- 路由运行正常\n',
        }),
      ),
    ).toBe(true)
  })

  it('含历史归档说明、大段正文改写或非 tidy 类型不进入速审表', () => {
    expect(
      isTitleOnlyTidy(
        makeTidySuggestion({
          archivedNotes: [{ occurredAt: '2026-10-01T00:00:00Z', note: '旧记录' }],
        }),
      ),
    ).toBe(false)
    expect(
      isTitleOnlyTidy(
        makeTidySuggestion({
          proposedContent: '完全重写的新正文内容，删掉了原有全部段落',
        }),
      ),
    ).toBe(false)
    // 哪怕只改了一行实质配置，也不允许进入纯标题速审表静默丢弃
    expect(
      isTitleOnlyTidy(
        makeTidySuggestion({
          proposedContent:
            '# 网络拓扑（2026-10-01 更新）\n\n## 当前配置\n- 路由端口改为 8443\n' +
            '# 网络拓扑（2026-10-01 更新）\n\n## 当前配置\n- 路由运行正常\n'.repeat(9),
        }),
      ),
    ).toBe(false)
    expect(isTitleOnlyTidy(makeTidySuggestion({ kind: 'update' }))).toBe(false)
  })
})

describe('结构化行号、词级行内高亮与可交互折叠块', () => {
  it('为长行局部变动计算精确词级高亮而不误伤未改动正文', () => {
    const res = computeInlineDiffParts(
      '- WiFi 详细规划见 [[wireless_ap]] 说明。',
      '- WiFi 详细规划见 [[m-b6tyap|无线 AP 部署]] 说明。',
    )
    expect(res.removed.some((p) => p.kind === 'remove' && p.text.includes('wireless_ap'))).toBe(
      true,
    )
    expect(res.added.some((p) => p.kind === 'add' && p.text.includes('m-b6tyap'))).toBe(true)
    expect(res.added.some((p) => p.kind === 'same' && p.text.includes('WiFi'))).toBe(true)
  })

  it('生成双列行号、改动块索引、章节锚点与双栏配对行', () => {
    const before = [
      '## 拓扑结构',
      ...Array.from({ length: 12 }, (_, i) => `- 常规节点 ${i + 1}`),
      '- 固件版本 7.23',
      '- 保留条目',
    ].join('\n')
    const after = [
      '## 拓扑结构',
      ...Array.from({ length: 12 }, (_, i) => `- 常规节点 ${i + 1}`),
      '- 固件版本 7.24 稳定版',
      '- 新增光口说明',
      '- 保留条目',
    ].join('\n')
    const diff = computeStructuredDiff(before, after)
    expect(diff.addedCount).toBe(2)
    expect(diff.removedCount).toBe(1)
    expect(diff.hunkStarts).toHaveLength(1)

    const mask = diff.lines.map((_, idx) => idx >= 11)
    const chunks = buildDiffDisplayChunks(diff.lines, mask, false)
    expect(chunks[0]).toMatchObject({
      kind: 'gap',
      start: 0,
      end: 11,
      count: 11,
      sectionHeading: '## 拓扑结构',
    })
    expect(chunks[1]).toMatchObject({ kind: 'visible', start: 11 })

    const pairs = buildSplitDiffPairs(diff.lines, chunks[1]!.start, chunks[1]!.end)
    expect(pairs.some((p) => p.left?.kind === 'remove' && p.right?.kind === 'add')).toBe(true)
    expect(pairs.some((p) => p.left === null && p.right?.kind === 'add')).toBe(true)
  })

  it('默认掩码与按方向增量展开上下文（向上/向下/全部）及重折叠行为正确', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行`)
    const before = lines.join('\n')
    const afterLines = [...lines]
    afterLines[0] = '第 1 行（已改）'
    afterLines[29] = '第 30 行（已改）'
    const diff = computeStructuredDiff(before, afterLines.join('\n'))

    const initialMask = buildDiffVisibilityMask(diff.lines, diff.hunkStarts, 3)
    const initialChunks = buildDiffDisplayChunks(diff.lines, initialMask, false)
    const gap = initialChunks.find((c) => c.kind === 'gap')
    expect(gap).toBeDefined()
    expect(gap!.count).toBeGreaterThan(10)

    // 向下展开 10 行：从省略段顶部展开
    const afterDown = expandDiffGap(initialMask, gap!.start, gap!.end, 'down', 10)
    expect(afterDown[gap!.start]).toBe(true)
    expect(afterDown[gap!.start + 9]).toBe(true)
    expect(afterDown[gap!.end - 1]).toBe(false)

    // 向上展开 10 行：从省略段底部展开
    const afterUp = expandDiffGap(initialMask, gap!.start, gap!.end, 'up', 10)
    expect(afterUp[gap!.end - 1]).toBe(true)
    expect(afterUp[gap!.end - 10]).toBe(true)
    expect(afterUp[gap!.start]).toBe(false)

    // 全部展开后无省略段，且不修改原掩码数组；步长大于区间长度时安全钳位
    const snapshotBefore = [...initialMask]
    const afterAll = expandDiffGap(initialMask, gap!.start, gap!.end, 'all', 10)
    expect(initialMask).toEqual(snapshotBefore)
    expect(buildDiffDisplayChunks(diff.lines, afterAll, false).some((c) => c.kind === 'gap')).toBe(
      false,
    )
    const afterOversizedStep = expandDiffGap(initialMask, gap!.start, gap!.end, 'down', 999)
    expect(afterOversizedStep).toEqual(afterAll)

    // 无改动（hunkStarts 为空）与整篇改写均无折叠行；负 context 安全钳位为 0
    const unchanged = computeStructuredDiff('甲\n乙\n丙', '甲\n乙\n丙')
    expect(buildDiffVisibilityMask(unchanged.lines, unchanged.hunkStarts, 3)).toEqual([
      true,
      true,
      true,
    ])
    const fullRewrite = computeStructuredDiff('甲\n乙\n丙', '一\n二\n三')
    expect(
      buildDiffVisibilityMask(fullRewrite.lines, fullRewrite.hunkStarts, 3).every(Boolean),
    ).toBe(true)
    expect(
      buildDiffVisibilityMask(fullRewrite.lines, fullRewrite.hunkStarts, -5).every(Boolean),
    ).toBe(true)
  })
})
