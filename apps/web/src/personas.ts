import type { PersonaDetail, PersonaInfo, PersonaNode } from '@kioku/contracts'

// 人格层节点的 priority 不超过这个数就进启动上下文，与服务端 boot 的挑选一致
export const PERSONA_BOOT_PRIORITY = 1

// 被覆盖的节点本来会进启动上下文、覆盖它的那条却进不了时，返回覆盖它的那条的 priority；否则为 null
export function lostFromBoot(node: PersonaNode, nodes: readonly PersonaNode[]): number | null {
  if (!node.overriddenBy || node.priority > PERSONA_BOOT_PRIORITY) return null
  const by = nodes.find((n) => n.uri === node.overriddenBy)
  return by && by.priority > PERSONA_BOOT_PRIORITY ? by.priority : null
}

// 人格列表的一行：缩进几层，以及画引线要知道的事（含义同记忆目录的 TreeRowPlace）
export interface PersonaRow {
  persona: PersonaInfo
  depth: number
  prefix: boolean[]
  last: boolean
}

// 人格排成继承树：被继承的在上，子人格缩进在它下面，同一级保持接口的顺序。
// 每个人格只出现一次：从根走不到的（继承的人格不在列表里，列表还没刷新；万一成环）接在后面各算一棵树
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
  for (const persona of personas) walk([persona], 0, [])
  return rows
}

export interface InheritedGroup {
  id: string
  name: string
  nodes: PersonaNode[]
}

// 继承来的节点按来自哪个祖先分组，由近到远，没有节点的祖先不列。
// 接口保证节点都来自 ancestors；对不上时也不丢，算在一个说不出名字的祖先下面
export function inheritedGroups(
  detail: Pick<PersonaDetail, 'ancestors' | 'inherited'>,
): InheritedGroup[] {
  const order = detail.ancestors.map((a) => a.id)
  const groups = new Map<string, InheritedGroup>()
  for (const node of detail.inherited) {
    const group = groups.get(node.personaId)
    if (group) group.nodes.push(node)
    else {
      const name = detail.ancestors.find((a) => a.id === node.personaId)?.name ?? '祖先人格'
      groups.set(node.personaId, { id: node.personaId, name, nodes: [node] })
    }
  }
  const rank = (id: string) => {
    const at = order.indexOf(id)
    return at < 0 ? order.length : at
  }
  return [...groups.values()].sort((a, b) => rank(a.id) - rank(b.id))
}
