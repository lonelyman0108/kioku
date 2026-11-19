import { ENTRY_KINDS, type PersonaInfo, type ResolvedPersonaTrait } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { sameScopes } from '../components/keyPresets'
import { guideLines } from '../components/memoryTree'
import personaDetailSource from '../components/PersonaDetail.vue?raw'
import vocabularyPageSource from '../pages/VocabularyPage.vue?raw'
import {
  canBeParent,
  hasCycle,
  inheritedGroups,
  personaChildren,
  personaOptionItems,
  personaRows,
  personaTree,
} from '../personas'

const CIRCLE = '00000000-0000-4000-8000-0000000000s1'
const at = '2026-11-10T00:00:00.000Z'

const persona = (id: string, extendsId: string | null = null): PersonaInfo => ({
  id,
  circleId: CIRCLE,
  slug: id,
  name: id,
  extendsId,
  description: null,
})

const trait = (
  traitKey: string,
  personaId: string,
  overriddenBy: string | null = null,
): ResolvedPersonaTrait => ({
  traitKey,
  title: traitKey,
  content: `content-${traitKey}`,
  sortOrder: 0,
  updatedAt: at,
  personaId,
  overriddenBy,
})

describe('人格列表的继承树与继承校验', () => {
  const ids = (personas: PersonaInfo[]) => personaRows(personas).map((r) => r.persona.id)

  it('继承的人格不在列表里时，排在前面的子人格也不会被拆出去', () => {
    const personas = [persona('c', 'b'), persona('b', 'gone'), persona('x')]
    expect(ids(personas)).toEqual(['x', 'b', 'c'])
    expect(personaRows(personas).map((r) => r.depth)).toEqual([0, 0, 1])
  })

  it('成环时环外的子人格也不会被拆出去，每个人格只出现一次', () => {
    const personas = [persona('c', 'a'), persona('a', 'b'), persona('b', 'a')]
    const rows = personaRows(personas)
    expect(rows.map((r) => r.persona.id).sort()).toEqual(['a', 'b', 'c'])
    expect(rows.find((r) => r.persona.id === 'c')?.depth).toBeGreaterThan(0)
  })

  it('子人格排在被继承的人格下面，同一级保持接口的顺序', () => {
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
    expect(lines('a1')).toEqual([
      { left: 14, end: false, tick: false },
      { left: 30, end: true, tick: true },
    ])
    expect(lines('b')).toEqual([{ left: 14, end: true, tick: true }])
    expect(lines('b1')).toEqual([{ left: 30, end: true, tick: true }])
  })

  it('personaTree、personaChildren 与成环检测', () => {
    const list = [persona('root'), persona('child', 'root'), persona('leaf', 'child')]
    const tree = personaTree(list)
    expect(tree).toHaveLength(1)
    expect(tree[0]!.children[0]!.children[0]!.persona.id).toBe('leaf')
    expect(personaChildren(list, 'root').map((p) => p.id)).toEqual(['child'])
    expect(hasCycle(list, 'root', 'leaf')).toBe(true)
    expect(hasCycle(list, 'child', 'root')).toBe(false)
    expect(canBeParent(list, 'root', 'leaf')).toBe(false)
    expect(personaOptionItems(list, 'root').map((i) => i.value)).toEqual([null])
  })

  it('没有人格时为空', () => {
    expect(personaRows([])).toEqual([])
    expect(personaTree([])).toEqual([])
  })
})

describe('继承来的设定段按祖先分组', () => {
  it('由近到远排序，保留覆盖状态且不丢失未匹配祖先', () => {
    const groups = inheritedGroups({
      ancestors: [persona('near'), persona('empty'), persona('far')],
      inheritedTraits: [
        trait('tone', 'far', 'near'),
        trait('tone', 'near', 'child'),
        trait('extra', 'unknown', null),
        trait('rules', 'far', null),
      ],
    })
    expect(groups.map((g) => g.persona.name)).toEqual(['near', 'far', '祖先人格'])
    expect(groups[0]!.traits[0]!.overriddenBy).toBe('child')
    expect(groups[1]!.traits.map((t) => t.traitKey)).toEqual(['tone', 'rules'])
  })
})

describe('两组透镜访问密钥权限是否相同', () => {
  const scopes = {
    readKinds: [...ENTRY_KINDS],
    writeKinds: ['entry'] as ('entry' | 'fact' | 'episode')[],
    maxSensitivity: 'private' as const,
    allowedRealms: null,
    admin: false,
    credentials: 'none' as const,
  }
  it('物种与场域的先后不算，null 与空数组不同', () => {
    expect(
      sameScopes(
        { ...scopes, readKinds: ['entry', 'fact', 'episode'] },
        { ...scopes, readKinds: ['episode', 'entry', 'fact'] },
      ),
    ).toBe(true)
    expect(
      sameScopes(
        { ...scopes, allowedRealms: ['work', 'personal'] },
        { ...scopes, allowedRealms: ['personal', 'work'] },
      ),
    ).toBe(true)
    expect(sameScopes({ ...scopes, allowedRealms: null }, { ...scopes, allowedRealms: [] })).toBe(
      false,
    )
  })
  it('敏感级、admin 或写入物种不同就不同', () => {
    const base = {
      ...scopes,
      readKinds: [...scopes.readKinds],
      writeKinds: [...scopes.writeKinds],
    }
    expect(sameScopes(base, { ...base, maxSensitivity: 'secret' })).toBe(false)
    expect(sameScopes(base, { ...base, admin: true })).toBe(false)
    expect(sameScopes(base, { ...base, writeKinds: [] })).toBe(false)
  })
})

describe('词表与独立人格页面源码结构', () => {
  it('VocabularyPage 覆盖切面词表 CRUD 与独立人格分页且不含 persona://', () => {
    expect(vocabularyPageSource).toContain('切面词表')
    expect(vocabularyPageSource).toContain('独立人格')
    expect(vocabularyPageSource).toContain('createFacetDimension')
    expect(vocabularyPageSource).toContain('createFacetTerm')
    expect(vocabularyPageSource).toContain('implies')
    expect(vocabularyPageSource).not.toContain('persona://')
    expect(personaDetailSource).not.toContain('persona://')
  })
})
