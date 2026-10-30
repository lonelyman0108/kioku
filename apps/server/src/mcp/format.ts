import type {
  CredentialAccess,
  CredentialSummary,
  DomainSummary,
  KeyCredentialList,
  MemoryChildren,
  MemoryView,
} from '@kioku/contracts'

import { CREDENTIAL_NOTICE } from '../credential/methods'
import type { PlaceholderCredential } from '../credential/service'
import { MASKED_SECRET_CONTENT } from '../memory/masked'

// 工具里的非业务错误只回这句，和 REST 一致。测试台也按它认内部错误
export const TOOL_INTERNAL_ERROR = '服务内部错误'

// MCP 工具结果给模型读，用紧凑的文本而不是 JSON
export function formatMemory(m: MemoryView): string {
  const lines = [
    `URI: ${m.uri}`,
    `层: ${m.layer}，敏感级: ${m.sensitivity}，priority: ${m.priority}，版本: ${m.version}`,
  ]
  if (m.validTo) lines.push(`有效到: ${m.validTo}（到期后不再召回）`)
  if (m.disclosure) lines.push(`Disclosure: ${m.disclosure}`)
  if (m.glossary.length) lines.push(`Glossary: ${m.glossary.join(', ')}`)
  lines.push('', m.content ?? MASKED_SECRET_CONTENT)
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
    if (c.location) lines.push(`条目：${JSON.stringify(c.location)}`)
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

export const PLAINTEXT_REMINDER =
  '提醒：正文像有明文密码或 Token。凭据用 kioku_credential_save 存起来，正文里换成 {{cred:<标识>#<字段>}} 占位符。'

// kioku_get 末尾的凭据列表：读者取不了的只标「无权查看或不存在」。取法与使用说明可能有好几行，
// 续行缩进，免得和下一条混在一起
export function formatPlaceholderCredentials(items: PlaceholderCredential[]): string {
  const rows = items.map((c) => {
    if (!c.available) return `- ${c.identifier}：无权查看或不存在`
    const where =
      c.source === 'hosted'
        ? 'Kioku 托管'
        : c.provider
          ? `凭据源「${c.provider.name}」（${c.provider.kind}），条目 ${JSON.stringify(c.location)}`
          : '外部凭据源'
    const details = [`取法：${c.method}`]
    if (c.provider?.instructions) details.push(`凭据源的使用说明：${c.provider.instructions}`)
    const indented = details.flatMap((d) => d.split('\n')).map((line) => `  ${line}`)
    return [`- ${c.identifier}（${c.name}）：${where}`, ...indented].join('\n')
  })
  return [
    '正文里引用的凭据（用到时按各条的取法取，取到的值不要写回记忆，也不要显示在回复里）：',
    ...rows,
    '',
    CREDENTIAL_NOTICE,
  ].join('\n')
}
