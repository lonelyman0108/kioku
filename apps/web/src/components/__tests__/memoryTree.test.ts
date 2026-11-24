import { BROWSE_GROUP_BYS, type EntryBrowseResponse } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  buildBrowseTree,
  entryNodeKey,
  focusAfterSelect,
  GROUP_BY_OPTIONS,
  groupNodeKey,
  guideLines,
  keysForShortId,
  parentRow,
  selectable,
  treeRowPlaces,
  typeaheadMatch,
  type MemoryTreeItem,
} from '../memoryTree'

describe('动态分组目录', () => {
  it('单圈浏览支持除记忆圈外的 6 种分组维度且顺序固定', () => {
    const expected = BROWSE_GROUP_BYS.filter((g) => g !== 'circle')
    expect(GROUP_BY_OPTIONS.map((o) => o.value)).toEqual(expect.arrayContaining(expected))
    expect(GROUP_BY_OPTIONS).toHaveLength(expected.length)
  })

  it('按分组构建两级树，同词条落在多个分组下保持唯一行键并推导出色带', () => {
    const response: EntryBrowseResponse = {
      groupBy: 'topic',
      truncated: false,
      groups: [
        {
          key: 'infra',
          label: 'infra',
          count: 2,
          items: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              shortId: 'm-234567',
              title: '家用 NAS',
              circleId: 'c-personal',
              circleSlug: 'personal',
              kind: 'entry',
              sensitivity: 'private',
              priority: 0,
              topics: ['infra', 'home'],
              disclosure: null,
              variantCount: 2,
              variantsSummary: [{}, { env: ['macos'] }],
            },
            {
              id: '00000000-0000-4000-8000-000000000002',
              shortId: 'm-345678',
              title: '生产集群',
              circleId: 'c-work',
              circleSlug: 'work',
              kind: 'entry',
              sensitivity: 'internal',
              priority: 2,
              topics: ['infra'],
              disclosure: '部署时',
              variantCount: 1,
              variantsSummary: [{}],
            },
          ],
        },
        {
          key: 'home',
          label: 'home',
          count: 1,
          items: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              shortId: 'm-234567',
              title: '家用 NAS',
              circleId: 'c-personal',
              circleSlug: 'personal',
              kind: 'entry',
              sensitivity: 'private',
              priority: 0,
              topics: ['infra', 'home'],
              disclosure: null,
              variantCount: 2,
              variantsSummary: [{}, { env: ['macos'] }],
            },
          ],
        },
      ],
    }

    const tree = buildBrowseTree(response, { id: 'c-work', kind: 'shared' })
    expect(tree).toHaveLength(2)
    expect(tree[0]).toMatchObject({ key: 'group:infra', label: 'infra', count: 2, kind: 'group' })
    expect(selectable(tree[0]!)).toBe(false)
    expect(selectable(tree[0]!.children![0]!)).toBe(true)

    // 同一短 ID 在两个分组中拥有互不冲突的行键
    expect(tree[0]!.children![0]!.key).toBe('item:infra:m-234567')
    expect(tree[1]!.children![0]!.key).toBe('item:home:m-234567')
    // 客场关联的个人圈词条显示 personal 色带，当前主场共享圈词条显示 primary 色带
    expect(tree[0]!.children![0]!.band).toBe('personal')
    expect(tree[0]!.children![1]!.band).toBe('primary')

    // 查找默认或指定行键
    expect(keysForShortId(tree, 'm-234567')).toMatchObject({
      groupKey: 'group:infra',
      itemKey: 'item:infra:m-234567',
    })
    expect(keysForShortId(tree, 'm-234567', 'item:home:m-234567')).toMatchObject({
      groupKey: 'group:home',
      itemKey: 'item:home:m-234567',
    })
  })

  it('截断时末尾追加不可选中的提示行', () => {
    const tree = buildBrowseTree(
      { groupBy: 'topic', truncated: true, groups: [] },
      { id: 'c1', kind: 'personal' },
    )
    expect(tree).toEqual([
      {
        key: 'note:truncated',
        label: '条目过多，仅显示前部分结果',
        kind: 'note',
        disabled: true,
      },
    ])
    expect(selectable(tree[0]!)).toBe(false)
  })
})

describe('目录的引线、左键返回与打字跳转', () => {
  const entry = (group: string, shortId: string, label: string): MemoryTreeItem => ({
    key: entryNodeKey(group, shortId),
    shortId,
    label,
    kind: 'entry',
  })
  const items: MemoryTreeItem[] = [
    {
      key: groupNodeKey('g1'),
      label: 'alpha 组',
      kind: 'group',
      children: [entry('g1', 'm-234567', 'alpha'), entry('g1', 'm-345678', 'atlas')],
    },
    {
      key: groupNodeKey('g2'),
      label: 'beta 组',
      kind: 'group',
      children: [entry('g2', 'm-456789', 'Beacon')],
    },
  ]

  it('只计算展开行的位置并保留父键，支持左键跳回所属分组', () => {
    const expanded = ['group:g1']
    const places = treeRowPlaces(items, expanded)
    expect([...places.keys()]).toEqual([
      'group:g1',
      'item:g1:m-234567',
      'item:g1:m-345678',
      'group:g2',
    ])
    expect(guideLines(places.get('group:g1')!)).toEqual([])
    expect(guideLines(places.get('item:g1:m-234567')!)).toEqual([
      { left: 14, end: false, tick: true },
    ])
    expect(guideLines(places.get('item:g1:m-345678')!)).toEqual([
      { left: 14, end: true, tick: true },
    ])
    expect(parentRow(places, expanded, 'item:g1:m-345678')).toBe('group:g1')
    expect(parentRow(places, expanded, 'group:g1')).toBeNull()
  })

  it('打字跳转忽略说明行并在同首字母间循环', () => {
    const places = treeRowPlaces(items, ['group:g1', 'group:g2'])
    expect(typeaheadMatch(places, 'b', null)).toBe('group:g2')
    expect(typeaheadMatch(places, 'bea', null)).toBe('item:g2:m-456789')
    expect(typeaheadMatch(places, 'a', 'group:g1')).toBe('item:g1:m-234567')
    expect(typeaheadMatch(places, 'z', null)).toBeNull()
  })
})

describe('窄屏切换之后的焦点', () => {
  it('打开一条放到标题，返回时放回原来那一行；宽屏不动', () => {
    expect(focusAfterSelect(true, 'm-234567', null)).toEqual({ to: 'title' })
    expect(focusAfterSelect(true, 'm-345678', 'm-234567')).toEqual({ to: 'title' })
    expect(focusAfterSelect(true, null, 'm-234567')).toEqual({ to: 'row', shortId: 'm-234567' })
    expect(focusAfterSelect(false, 'm-234567', null)).toBeNull()
    expect(focusAfterSelect(true, null, null)).toBeNull()
  })
})
