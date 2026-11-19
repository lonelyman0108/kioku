import type { PersonaDetail, PersonaInfo, ResolvedPersonaTrait } from '@kioku/contracts'

// 人格列表的一行：缩进几层，以及画引线要知道的事（含义同记忆目录的 TreeRowPlace）
export interface PersonaRow {
  persona: PersonaInfo
  depth: number
  prefix: boolean[]
  last: boolean
}

export interface PersonaTreeNode {
  persona: PersonaInfo
  children: PersonaTreeNode[]
}

// 检查 candidateParentId 作为 targetId 的父人格时是否成环
export function hasCycle(
  personas: readonly PersonaInfo[],
  targetId: string,
  candidateParentId: string | null,
): boolean {
  if (!candidateParentId) return false
  const byId = new Map(personas.map((p) => [p.id, p]))
  const seen = new Set<string>([targetId])
  let cur: string | null = candidateParentId
  while (cur) {
    if (seen.has(cur)) return true
    seen.add(cur)
    cur = byId.get(cur)?.extendsId ?? null
  }
  return false
}

export function canBeParent(
  personas: readonly PersonaInfo[],
  targetId: string | null,
  candidateParentId: string,
): boolean {
  if (!targetId) return true
  return !hasCycle(personas, targetId, candidateParentId)
}

export function personaChildren(
  personas: readonly PersonaInfo[],
  parentId: string | null,
): PersonaInfo[] {
  return personas.filter((p) => p.extendsId === parentId)
}

export function personaTree(personas: readonly PersonaInfo[]): PersonaTreeNode[] {
  const byId = new Map(personas.map((p) => [p.id, p]))
  const childrenMap = new Map<string | null, PersonaInfo[]>()
  for (const p of personas) {
    const key = p.extendsId && byId.has(p.extendsId) ? p.extendsId : null
    childrenMap.set(key, [...(childrenMap.get(key) ?? []), p])
  }
  const placed = new Set<string>()
  const build = (list: readonly PersonaInfo[]): PersonaTreeNode[] =>
    list
      .filter((p) => !placed.has(p.id))
      .map((p) => {
        placed.add(p.id)
        return { persona: p, children: build(childrenMap.get(p.id) ?? []) }
      })
  const roots = build(childrenMap.get(null) ?? [])
  for (const p of personas) {
    if (!placed.has(p.id)) {
      placed.add(p.id)
      roots.push({ persona: p, children: build(childrenMap.get(p.id) ?? []) })
    }
  }
  return roots
}

export function personaOptionItems(
  personas: readonly PersonaInfo[],
  excludeId: string | null = null,
): { label: string; value: string | null }[] {
  return [
    { label: '不继承', value: null },
    ...personas
      .filter((p) => canBeParent(personas, excludeId, p.id))
      .map((p) => ({ label: `${p.name}（${p.slug}）`, value: p.id })),
  ]
}

// 人格排成继承树：被继承的在上，子人格缩进在它下面，同一级保持接口的顺序。
// 每个人格只出现一次：从根走不到的（继承的人格不在列表里，或成环）接在后面各算一棵树
export function personaRows(personas: readonly PersonaInfo[]): PersonaRow[] {
  const children = new Map<string, PersonaInfo[]>()
  const roots: PersonaInfo[] = []
  for (const persona of personas) {
    const parent = persona.extendsId
    if (parent) children.set(parent, [...(children.get(parent) ?? []), persona])
    else roots.push(persona)
  }
  const rows: PersonaRow[] = []
  const placed = new Set<string>()
  const walk = (level: readonly PersonaInfo[], depth: number, prefix: boolean[]) => {
    const fresh = level.filter((p) => !placed.has(p.id))
    fresh.forEach((persona, i) => {
      const last = i === fresh.length - 1
      placed.add(persona.id)
      rows.push({ persona, depth, prefix, last })
      walk(children.get(persona.id) ?? [], depth + 1, depth === 0 ? [] : [...prefix, !last])
    })
  }
  walk(roots, 0, [])
  // 从树顶开始走，排在前面的子人格才不会被拆出去
  const byId = new Map(personas.map((p) => [p.id, p]))
  const topOf = (persona: PersonaInfo) => {
    const seen = new Set<string>()
    let at = persona
    while (!seen.has(at.id)) {
      const parent = at.extendsId ? byId.get(at.extendsId) : undefined
      if (!parent) break
      seen.add(at.id)
      at = parent
    }
    return at
  }
  for (const persona of personas) walk([topOf(persona)], 0, [])
  return rows
}

export interface InheritedTraitGroup {
  persona: PersonaInfo
  traits: ResolvedPersonaTrait[]
}

// 继承来的设定段按来自哪个祖先分组，由近到远；没有设定段的祖先不列
export function inheritedGroups(
  detail: Pick<PersonaDetail, 'ancestors' | 'inheritedTraits'>,
): InheritedTraitGroup[] {
  const order = detail.ancestors.map((a) => a.id)
  const groups = new Map<string, InheritedTraitGroup>()
  for (const trait of detail.inheritedTraits) {
    const existing = groups.get(trait.personaId)
    if (existing) {
      existing.traits.push(trait)
    } else {
      const ancestor = detail.ancestors.find((a) => a.id === trait.personaId) ?? {
        id: trait.personaId,
        circleId: detail.ancestors[0]?.circleId ?? '',
        slug: trait.personaId.slice(0, 8),
        name: '祖先人格',
        extendsId: null,
        description: null,
      }
      groups.set(trait.personaId, { persona: ancestor, traits: [trait] })
    }
  }
  const rank = (id: string) => {
    const at = order.indexOf(id)
    return at < 0 ? order.length : at
  }
  return [...groups.values()].sort((a, b) => rank(a.persona.id) - rank(b.persona.id))
}
