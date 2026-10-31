import { describe, expect, it } from 'vitest'

import {
  ancestorsOf,
  depthOf,
  guideLines,
  lastSegment,
  parentOf,
  splitUri,
  toTreeItems,
  treeRowPlaces,
  typeaheadMatch,
  type MemoryTreeItem,
} from '../memoryTree'

describe('记忆树', () => {
  it('父级：一层路径的父级是 domain 根，多层取上一级', () => {
    expect(parentOf('core://agent')).toBe('core')
    expect(parentOf('core://agent/codex')).toBe('core://agent')
  })

  it('展开到一个节点要经过 domain 根和每一级上层路径；深度从 domain 根的 0 算起', () => {
    expect(ancestorsOf('core://agent/claudecode/x')).toEqual([
      'core',
      'core://agent',
      'core://agent/claudecode',
    ])
    expect(ancestorsOf('core://agent')).toEqual(['core'])
    expect([depthOf('core'), depthOf('core://agent'), depthOf('core://agent/x')]).toEqual([0, 1, 2])
  })

  it('节点名取最后一段', () => {
    expect(lastSegment('infra://servers/web')).toBe('web')
  })

  it('有下一级的节点放加载占位，展开时再加载；叶子没有 children', () => {
    const items = toTreeItems({
      parent: null,
      truncated: false,
      children: [
        {
          uri: 'core://agent',
          exists: true,
          id: 'a',
          layer: 'base',
          sensitivity: 'public',
          priority: 0,
          disclosure: null,
          childCount: 2,
        },
        {
          uri: 'core://soul',
          exists: true,
          id: 'b',
          layer: 'base',
          sensitivity: 'public',
          priority: 0,
          disclosure: null,
          childCount: 0,
        },
        {
          uri: 'core://notes',
          exists: false,
          id: null,
          layer: null,
          sensitivity: null,
          priority: null,
          disclosure: null,
          childCount: 1,
        },
      ],
    })
    expect(items.map((i) => [i.label, i.loaded, i.children?.length ?? 0, i.count])).toEqual([
      ['agent', false, 1, 2],
      ['soul', true, 0, 0],
      ['notes', false, 1, 1],
    ])
    expect(items[2]!.exists).toBe(false)
    // 层、敏感级与 priority 带到节点上，树里标出来
    expect([items[0]!.layer, items[0]!.sensitivity, items[0]!.priority]).toEqual([
      'base',
      'public',
      0,
    ])
    expect([items[2]!.layer, items[2]!.priority]).toEqual([null, null])
  })

  it('这一级被截断时末尾放一个不能点的说明', () => {
    const items = toTreeItems({
      parent: null,
      truncated: true,
      children: [
        {
          uri: 'bulk://a',
          exists: true,
          id: '00000000-0000-4000-8000-000000000001',
          layer: 'base',
          sensitivity: 'public',
          priority: 2,
          disclosure: null,
          childCount: 0,
        },
      ],
    })
    expect(items.map((i) => [i.label, i.disabled ?? false])).toEqual([
      ['a', false],
      ['此级条目过多，仅显示前 1 个', true],
    ])
  })

  it('URI 拆成上一级路径和名字，合起来还是原样', () => {
    expect(splitUri('projects://atlas/release')).toEqual({
      parent: 'projects://atlas/',
      leaf: 'release',
    })
    expect(splitUri('core://agent')).toEqual({ parent: 'core://', leaf: 'agent' })
    expect(splitUri('core')).toEqual({ parent: '', leaf: 'core' })
  })
})

describe('目录的引线', () => {
  const node = (uri: string, children?: MemoryTreeItem[]): MemoryTreeItem => ({
    label: uri,
    uri,
    exists: true,
    loaded: true,
    ...(children ? { children } : {}),
  })
  const items = [
    node('a', [
      node('a://x', [node('a://x/1'), node('a://x/2')]),
      node('a://y', [node('a://y/1')]),
    ]),
    node('b', [node('b://z')]),
  ]

  it('只数展开着的，行号按显示的顺序', () => {
    const places = treeRowPlaces(items, ['a', 'a://x'])
    expect([...places.keys()]).toEqual(['a', 'a://x', 'a://x/1', 'a://x/2', 'a://y', 'b'])
    expect(places.get('a://y')!.index).toBe(4)
    expect(places.has('b://z')).toBe(false)
  })

  it('domain 根没有引线；祖先还有后面的兄弟时才画穿过去的竖线', () => {
    const places = treeRowPlaces(items, ['a', 'a://x', 'a://y', 'b'])
    expect(places.get('a')).toMatchObject({ depth: 0, prefix: [], last: false })
    expect(places.get('a://x')).toMatchObject({ depth: 1, prefix: [], last: false })
    expect(places.get('a://y')).toMatchObject({ depth: 1, prefix: [], last: true })
    // x 后面还有 y，竖线穿过 x 的子节点；y 是最后一个，下面不再画
    expect(places.get('a://x/1')).toMatchObject({ depth: 2, prefix: [true], last: false })
    expect(places.get('a://x/2')).toMatchObject({ depth: 2, prefix: [true], last: true })
    expect(places.get('a://y/1')).toMatchObject({ depth: 2, prefix: [false], last: true })
    expect(places.get('b')).toMatchObject({ depth: 0, last: true })
  })

  it('竖线的位置按层算，最后一个的竖线到一半，带横线的只有自己这一级', () => {
    const places = treeRowPlaces(items, ['a', 'a://x', 'a://y'])
    expect(guideLines(places.get('a')!)).toEqual([])
    expect(guideLines(places.get('a://x')!)).toEqual([{ left: 14, end: false, tick: true }])
    expect(guideLines(places.get('a://x/2')!)).toEqual([
      { left: 14, end: false, tick: false },
      { left: 30, end: true, tick: true },
    ])
    // y 是最后一个：它的子节点左边没有穿过去的竖线
    expect(guideLines(places.get('a://y/1')!)).toEqual([{ left: 30, end: true, tick: true }])
  })

  it('展开列表里的节点没有子节点时也不出错', () => {
    expect([...treeRowPlaces([node('a')], ['a']).keys()]).toEqual(['a'])
  })
})

describe('打字跳转', () => {
  const places = (labels: string[]) =>
    treeRowPlaces(
      labels.map((label) => ({ label, uri: `u:${label}`, exists: true, loaded: true })),
      [],
    )
  const rows = places(['alpha', 'beta', 'atlas', 'Beacon'])

  it('一个字从当前行往下找，到底了回到开头', () => {
    expect(typeaheadMatch(rows, 'a', null)).toBe('u:alpha')
    expect(typeaheadMatch(rows, 'a', 'u:alpha')).toBe('u:atlas')
    expect(typeaheadMatch(rows, 'a', 'u:atlas')).toBe('u:alpha')
  })

  it('不分大小写；打了好几个字时当前行还符合就不动', () => {
    expect(typeaheadMatch(rows, 'bea', null)).toBe('u:Beacon')
    expect(typeaheadMatch(rows, 'at', 'u:atlas')).toBe('u:atlas')
  })

  it('同一个字连着按，在以它开头的行之间循环', () => {
    expect(typeaheadMatch(rows, 'aa', 'u:alpha')).toBe('u:atlas')
  })

  it('没有符合的、空的都不跳', () => {
    expect(typeaheadMatch(rows, 'z', null)).toBeNull()
    expect(typeaheadMatch(rows, '', null)).toBeNull()
    expect(typeaheadMatch(new Map(), 'a', null)).toBeNull()
  })

  it('「加载中」这类说明行不算', () => {
    const list = treeRowPlaces(
      [{ label: '加载中', uri: 'x#loading', exists: false, loaded: true, disabled: true }],
      [],
    )
    expect(typeaheadMatch(list, '加', null)).toBeNull()
  })
})
