import type {
  CredentialAccess,
  CredentialSummary,
  DomainSummary,
  KeyCredentialList,
  MemoryChildren,
  MemoryView,
} from '@kioku/contracts'

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
  const more = result.truncated
    ? '\n（这一级太多，只列出了前面的一部分，用 kioku_search 查找其余的）'
    : ''
  return `${head}子节点：\n${rows.join('\n')}${more}`
}

export function formatDomains(domains: DomainSummary[]): string {
  if (!domains.length) return '还没有可见的记忆'
  return domains.map((d) => `- ${d.domain}://（${d.count} 个节点）`).join('\n')
}

const sourceLabel = (c: CredentialSummary) =>
  c.source === 'hosted'
    ? 'Kioku 托管'
    : c.provider
      ? `凭据源「${c.provider.name}」（${c.provider.kind}${c.provider.deleted ? '，已删除' : ''}）`
      : '外部凭据源'

// 取用结果：值用 JSON 写出，多行的值（例如私钥）也不会和别的行混在一起
export function formatCredentialAccess(a: CredentialAccess): string {
  const c = a.credential
  const lines = [`凭据：${c.identifier}（${c.name}），版本 ${c.version}`]
  if (c.description) lines.push(`说明：${c.description}`)
  if (c.source === 'hosted') {
    lines.push('来源：Kioku 托管')
    if (a.values) lines.push(`值：${JSON.stringify(a.values)}`)
  } else {
    lines.push(
      `来源：${a.provider ? `凭据源「${a.provider.name}」（${a.provider.kind}）` : '外部凭据源'}`,
    )
    if (c.location) lines.push(`条目：${c.location}`)
    if (a.provider?.instructions) lines.push(`凭据源的使用说明：${a.provider.instructions}`)
  }
  lines.push(`取法：${a.method}`, '', a.notice)
  return lines.join('\n')
}

export function formatCredentialList(list: KeyCredentialList): string {
  const items = list.items.map(
    (c) =>
      `- ${c.identifier}（${c.name}）：${sourceLabel(c)}，字段 ${c.fields.join('、') || '无'}，版本 ${c.version}`,
  )
  const providers = list.providers.map((p) => `- ${p.name}（${p.kind}）：id ${p.id}`)
  return [
    items.length ? `凭据：\n${items.join('\n')}` : '凭据：还没有看得到的凭据',
    list.truncated ? '（太多，只列出了前面的一部分）' : '',
    providers.length
      ? `凭据源：\n${providers.join('\n')}`
      : '凭据源：还没有配置（在管理界面里添加）',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function formatCredentialSummary(verb: string, c: CredentialSummary): string {
  return `${verb}凭据 ${c.identifier}（${c.name}）：${sourceLabel(c)}，字段 ${c.fields.join('、')}，版本 ${c.version}`
}
