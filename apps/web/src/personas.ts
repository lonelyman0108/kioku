import type { PersonaNode } from '@kioku/contracts'

// 人格层节点的 priority 不超过这个数就进启动上下文，与服务端 boot 的挑选一致
export const PERSONA_BOOT_PRIORITY = 1

// 被覆盖的节点本来会进启动上下文、覆盖它的那条却进不了时，返回覆盖它的那条的 priority；否则为 null
export function lostFromBoot(node: PersonaNode, nodes: readonly PersonaNode[]): number | null {
  if (!node.overriddenBy || node.priority > PERSONA_BOOT_PRIORITY) return null
  const by = nodes.find((n) => n.uri === node.overriddenBy)
  return by && by.priority > PERSONA_BOOT_PRIORITY ? by.priority : null
}
