import type { DomainSummary, MemoryChildren, MemoryView } from '@kioku/contracts'

// MCP 工具结果给模型读，用紧凑的文本而不是 JSON
export function formatMemory(m: MemoryView): string {
  const lines = [
    `URI: ${m.uri}`,
    `层: ${m.layer}，敏感级: ${m.sensitivity}，priority: ${m.priority}，版本: ${m.version}`,
  ]
  if (m.disclosure) lines.push(`Disclosure: ${m.disclosure}`)
  if (m.glossary.length) lines.push(`Glossary: ${m.glossary.join(', ')}`)
  lines.push('', m.content ?? '（secret 正文需要显式读取权限）')
  return lines.join('\n')
}

export function formatChildren(result: MemoryChildren): string {
  const head = result.parent ? `${formatMemory(result.parent)}\n\n` : ''
  if (!result.children.length) return `${head}子节点：无`
  const rows = result.children.map((c) => {
    const below = c.childCount ? `，${c.childCount} 个子节点` : ''
    if (!c.exists) return `- ${c.uri}（路径本身没有记忆${below}）`
    return `- ${c.uri}（${c.layer}，priority ${c.priority}${below}）${c.disclosure ? `：${c.disclosure}` : ''}`
  })
  return `${head}子节点：\n${rows.join('\n')}`
}

export function formatDomains(domains: DomainSummary[]): string {
  if (!domains.length) return '还没有可见的记忆'
  return domains.map((d) => `- ${d.domain}://（${d.count} 个节点）`).join('\n')
}
