import { describe, expect, it } from 'vitest'

import {
  ancestorsOf,
  depthOf,
  entityItems,
  focusAfterSelect,
  guideLines,
  lastSegment,
  nodeKeyOf,
  nodeOfItem,
  nodeParam,
  parentOf,
  parentRow,
  parseNodeParam,
  rootItems,
  selectable,
  splitUri,
  toTreeItems,
  treeRowPlaces,
  typeaheadMatch,
  type MemoryTreeItem,
} from '../memoryTree'
import { CURATED_STACK } from '../strata/strata'

const persona = (id: string, slug: string, name: string, extendsId: string | null = null) => ({
  id,
  slug,
  name,
  extendsId,
  description: null,
})

describe('四个根与人格、应用', () => {
  it('根的顺序和地层柱一样，键是归属的名字，读之前先放一个加载中', () => {
    const roots = rootItems(CURATED_STACK)
    expect(roots.map((r) => [r.uri, r.label, r.kind])).toEqual([
      ['user', '本人', 'root'],
      ['app', '应用', 'root'],
      ['persona', '人格', 'root'],
      ['core', '通用', 'root'],
    ])
    expect(roots.every((r) => !r.loaded && r.children?.[0]?.kind === 'note')).toBe(true)
  })

  it('人格按继承关系排，被继承的在前，键是坐标开头，继承了谁写在行尾', () => {
    const items = entityItems('persona', [
      persona('b', 'doubao', '豆包', 'a'),
      persona('a', 'default', '默认'),
    ])
    expect(items.map((i) => [i.uri, i.label, i.entityId, i.meta])).toEqual([
      ['persona://default', '默认', 'a', undefined],
      ['persona://doubao', '豆包', 'b', '继承默认'],
    ])
    // 坐标开头是它下面各级的上一级，它自己的上一级是人格的根
    expect(parentOf('persona://doubao/soul')).toBe('persona://doubao')
    expect(parentOf('persona://doubao')).toBe('persona')
    expect(ancestorsOf('persona://doubao/soul')).toEqual(['persona', 'persona://doubao'])
  })

  it('能选中的是根、人格与应用、记忆；位置和说明行不能', () => {
    expect(['root', 'entity', 'memory'].every((kind) => selectable({ kind } as never))).toBe(true)
    expect(selectable({ kind: 'folder' })).toBe(false)
    expect(selectable({ kind: 'note' })).toBe(false)
  })

  it('地址里的 node：根写归属，人格与应用写 id，换成目录里的那一行', () => {
    expect(parseNodeParam('user')).toEqual({ kind: 'root', layer: 'user' })
    expect(parseNodeParam('persona:p1')).toEqual({ kind: 'persona', id: 'p1' })
    expect(parseNodeParam('app:a1')).toEqual({ kind: 'app', id: 'a1' })
    for (const bad of [null, '', 'subject', 'episode', 'nope:1']) {
      expect(parseNodeParam(bad)).toBeNull()
    }
    expect(nodeParam({ kind: 'persona', id: 'p1' })).toBe('persona:p1')
    expect(nodeParam({ kind: 'root', layer: 'core' })).toBe('core')
    const personas = [{ id: 'p1', slug: 'doubao' }]
    expect(nodeKeyOf({ kind: 'persona', id: 'p1' }, personas, [])).toBe('persona://doubao')
    // 列表还没读到、或者已经删掉了：不知道是哪一行
    expect(nodeKeyOf({ kind: 'persona', id: 'p1' }, undefined, [])).toBeNull()
    expect(nodeKeyOf({ kind: 'app', id: 'gone' }, personas, [])).toBeNull()
    expect(nodeKeyOf({ kind: 'root', layer: 'app' }, undefined, undefined)).toBe('app')
  })

  it('目录里的一行换回地址里的 node', () => {
    const [entity] = entityItems('persona', [persona('p1', 'default', '默认')])
    expect(nodeOfItem(entity!)).toBe('persona:p1')
    expect(nodeOfItem(rootItems(['core'])[0]!)).toBe('core')
    expect(nodeOfItem({ kind: 'memory', uri: 'core://agent', layer: 'core' })).toBeNull()
  })
})

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
          title: '工作流约束',
          layer: 'core',
          sensitivity: 'public',
          priority: 0,
          disclosure: null,
          childCount: 2,
        },
        {
          uri: 'core://soul',
          exists: true,
          id: 'b',
          title: 'soul',
          layer: 'core',
          sensitivity: 'public',
          priority: 0,
          disclosure: null,
          childCount: 0,
        },
        {
          uri: 'core://notes',
          exists: false,
          id: null,
          title: null,
          layer: null,
          sensitivity: null,
          priority: null,
          disclosure: null,
          childCount: 1,
        },
      ],
    })
    // 有记忆的写标题，位置写它在坐标里的那一段
    expect(items.map((i) => [i.label, i.loaded, i.children?.length ?? 0, i.count])).toEqual([
      ['工作流约束', false, 1, 2],
      ['soul', true, 0, 0],
      ['notes', false, 1, 1],
    ])
    expect(items.map((i) => i.kind)).toEqual(['memory', 'memory', 'folder'])
    expect(items[2]!.exists).toBe(false)
    // 归属、敏感级与 priority 带到节点上，树里标出来
    expect([items[0]!.layer, items[0]!.sensitivity, items[0]!.priority]).toEqual([
      'core',
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
          uri: 'core://a',
          exists: true,
          id: '00000000-0000-4000-8000-000000000001',
          title: 'a',
          layer: 'core',
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
    kind: 'memory',
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

  it('左键跳到上一级：展开着的行留给组件库收起，domain 根没有上一级', () => {
    const expanded = ['a', 'a://x']
    const places = treeRowPlaces(items, expanded)
    expect(parentRow(places, expanded, 'a://x/2')).toBe('a://x')
    expect(parentRow(places, expanded, 'a://y')).toBe('a')
    expect(parentRow(places, expanded, 'a://x')).toBeNull()
    expect(parentRow(places, expanded, 'a')).toBeNull()
    expect(parentRow(places, expanded, 'b')).toBeNull()
    expect(parentRow(places, expanded, 'not-there')).toBeNull()
  })

  it('展开列表里的节点没有子节点时也不出错', () => {
    expect([...treeRowPlaces([node('a')], ['a']).keys()]).toEqual(['a'])
  })
})

describe('打字跳转', () => {
  const places = (labels: string[]) =>
    treeRowPlaces(
      labels.map((label) => ({
        label,
        uri: `u:${label}`,
        kind: 'memory' as const,
        exists: true,
        loaded: true,
      })),
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
      [
        {
          label: '加载中',
          uri: 'x#loading',
          kind: 'note',
          exists: false,
          loaded: true,
          disabled: true,
        },
      ],
      [],
    )
    expect(typeaheadMatch(list, '加', null)).toBeNull()
  })
})

describe('窄屏切换之后的焦点', () => {
  it('打开一条放到标题，换一条也是', () => {
    expect(focusAfterSelect(true, 'a://x', null)).toEqual({ to: 'title' })
    expect(focusAfterSelect(true, 'a://y', 'a://x')).toEqual({ to: 'title' })
  })

  it('返回时放回原来那一行', () => {
    expect(focusAfterSelect(true, null, 'a://x')).toEqual({ to: 'row', uri: 'a://x' })
  })

  it('宽屏两边都在，不动焦点', () => {
    expect(focusAfterSelect(false, 'a://x', null)).toBeNull()
    expect(focusAfterSelect(false, null, 'a://x')).toBeNull()
    expect(focusAfterSelect(true, null, null)).toBeNull()
  })
})
