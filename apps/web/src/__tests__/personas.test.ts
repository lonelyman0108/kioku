import type { PersonaInfo, PersonaNode } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { sameScopes } from '../components/keyPresets'
import { guideLines } from '../components/memoryTree'
import { inheritedGroups, lostFromBoot, personaRows } from '../personas'

const node = (uri: string, priority: number, overriddenBy: string | null = null): PersonaNode => ({
  uri,
  personaId: '00000000-0000-4000-8000-000000000000',
  priority,
  sensitivity: 'public',
  disclosure: null,
  overriddenBy,
})

describe('被覆盖之后会不会从启动上下文里消失', () => {
  it('祖先那条会进启动上下文、覆盖它的那条进不了时给出那条的 priority', () => {
    const child = node('persona://child/soul', 2)
    const parent = node('persona://parent/soul', 0, child.uri)
    expect(lostFromBoot(parent, [child, parent])).toBe(2)
  })

  it('覆盖它的那条也进启动上下文、祖先那条本来就进不了、或没被覆盖时不提示', () => {
    const child = node('persona://child/soul', 1)
    expect(lostFromBoot(node('persona://parent/soul', 0, child.uri), [child])).toBeNull()
    const low = node('persona://child/tone', 3)
    expect(lostFromBoot(node('persona://parent/tone', 2, low.uri), [low])).toBeNull()
    expect(lostFromBoot(node('persona://parent/habit', 0), [])).toBeNull()
  })
})

const persona = (id: string, extendsId: string | null = null): PersonaInfo => ({
  id,
  slug: id,
  name: id,
  extendsId,
  description: null,
})

describe('人格列表的继承树', () => {
  const ids = (personas: PersonaInfo[]) => personaRows(personas).map((r) => r.persona.id)

  it('子人格排在被继承的人格下面，同一级保持接口的顺序', () => {
    // 接口按创建时间排，子人格可能比后来才设的父人格更早
    const personas = [
      persona('child', 'root'),
      persona('root'),
      persona('other'),
      persona('leaf', 'child'),
      persona('sibling', 'root'),
    ]
    expect(ids(personas)).toEqual(['root', 'child', 'leaf', 'sibling', 'other'])
    expect(personaRows(personas).map((r) => r.depth)).toEqual([0, 1, 2, 1, 0])
  })

  it('引线：还有后面的兄弟时竖线穿过去，最后一个画到一半', () => {
    const rows = personaRows([
      persona('root'),
      persona('a', 'root'),
      persona('a1', 'a'),
      persona('b', 'root'),
      persona('b1', 'b'),
    ])
    const lines = (id: string) => guideLines(rows.find((r) => r.persona.id === id)!)
    expect(lines('root')).toEqual([])
    expect(lines('a')).toEqual([{ left: 14, end: false, tick: true }])
    // a 后面还有 b：a1 这一行要有 a 那一级穿过去的竖线
    expect(lines('a1')).toEqual([
      { left: 14, end: false, tick: false },
      { left: 30, end: true, tick: true },
    ])
    expect(lines('b')).toEqual([{ left: 14, end: true, tick: true }])
    // b 是最后一个：b1 这一行没有穿过去的竖线
    expect(lines('b1')).toEqual([{ left: 30, end: true, tick: true }])
  })

  it('继承的人格不在列表里时算作一棵新树，不丢', () => {
    expect(personaRows([persona('orphan', 'gone')]).map((r) => [r.persona.id, r.depth])).toEqual([
      ['orphan', 0],
    ])
  })

  it('万一成环也不丢、不重复、不死循环', () => {
    const rows = personaRows([persona('a', 'b'), persona('b', 'a'), persona('root')])
    expect(rows.map((r) => r.persona.id).sort()).toEqual(['a', 'b', 'root'])
  })

  it('没有人格时为空', () => {
    expect(personaRows([])).toEqual([])
  })
})

describe('继承来的节点按祖先分组', () => {
  const at = (uri: string, personaId: string): PersonaNode => ({
    ...node(uri, 2),
    personaId,
  })

  it('由近到远，和节点的先后无关；没有节点的祖先不列', () => {
    const groups = inheritedGroups({
      ancestors: [persona('near'), persona('empty'), persona('far')],
      inherited: [
        at('persona://far/a', 'far'),
        at('persona://near/b', 'near'),
        at('persona://far/c', 'far'),
      ],
    })
    expect(groups.map((g) => g.name)).toEqual(['near', 'far'])
    expect(groups[1]!.nodes.map((n) => n.uri)).toEqual(['persona://far/a', 'persona://far/c'])
  })

  it('节点对不上祖先时也不丢', () => {
    const groups = inheritedGroups({
      ancestors: [persona('near')],
      inherited: [at('persona://x/a', 'unknown'), at('persona://near/b', 'near')],
    })
    expect(groups.map((g) => g.name)).toEqual(['near', '祖先人格'])
  })
})

describe('两组 Key 权限是否相同', () => {
  const scopes = {
    readLayers: ['base', 'private'] as const,
    writeLayers: ['private'] as const,
    maxSensitivity: 'private' as const,
    admin: false,
  }
  it('层的先后不算', () => {
    expect(
      sameScopes(
        { ...scopes, readLayers: ['base', 'private'], writeLayers: ['private'] },
        { ...scopes, readLayers: ['private', 'base'], writeLayers: ['private'] },
      ),
    ).toBe(true)
  })
  it('敏感级、admin 或层不同就不同', () => {
    const base = {
      ...scopes,
      readLayers: [...scopes.readLayers],
      writeLayers: [...scopes.writeLayers],
    }
    expect(sameScopes(base, { ...base, maxSensitivity: 'secret' })).toBe(false)
    expect(sameScopes(base, { ...base, admin: true })).toBe(false)
    expect(sameScopes(base, { ...base, writeLayers: [] })).toBe(false)
  })
})
