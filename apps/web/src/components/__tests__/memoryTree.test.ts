import { describe, expect, it } from 'vitest'

import { ancestorsOf, depthOf, lastSegment, parentOf, toTreeItems } from '../memoryTree'

const icons = { folder: 'folder', file: 'file' }

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
    expect(lastSegment('infra://docker_hosts/lore')).toBe('lore')
  })

  it('有下一级的节点放加载占位，展开时再加载；叶子没有 children', () => {
    const items = toTreeItems(
      {
        parent: null,
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
      },
      icons,
    )
    expect(items.map((i) => [i.label, i.loaded, i.children?.length ?? 0, i.icon])).toEqual([
      ['agent', false, 1, 'folder'],
      ['soul', true, 0, 'file'],
      ['notes', false, 1, 'folder'],
    ])
    expect(items[2]!.exists).toBe(false)
  })
})
