import {
  CREDENTIAL_ACCESS_REASON_NAMES,
  CREDENTIAL_EXPIRY_NAMES,
  LAYER_NAMES,
  type CredentialAccess,
  type CredentialStoredIn,
  type CredentialSummary,
  type CuratedLayer,
  type DomainSummary,
  type KeyCredentialList,
  type MemoryChildren,
  type MemoryView,
} from '@kioku/contracts'

import type { PlaceholderCredential } from '../credential/service'
import { MASKED_CREDENTIAL_VALUES, MASKED_SECRET_CONTENT } from '../memory/masked'
import { inlineText, titleSuffix } from '../recall/text'

// 工具里的非业务错误只回这句，和 REST 一致。测试台也按它认内部错误
export const TOOL_INTERNAL_ERROR = '服务内部错误'

// MCP 工具结果给模型读，用紧凑的文本而不是 JSON
export function formatMemory(m: MemoryView): string {
  const lines = [
    `URI: ${m.uri}`,
    `标题: ${inlineText(m.title)}`,
    `归属: ${m.layer}，敏感级: ${m.sensitivity}，priority: ${m.priority}，版本: ${m.version}`,
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
    const title = c.title ? titleSuffix(c.uri, c.title) : ''
    return `- ${c.uri}${title}（${c.layer}，priority ${c.priority}${below}）${c.disclosure ? `：${c.disclosure}` : ''}`
  })
  const more = result.truncated
    ? '\n（这一级太多，只列出了前面的一部分，用 kioku_search 查找其余的）'
    : ''
  return `${head}子节点：\n${rows.join('\n')}${more}`
}

// 有记忆的开头，各带归属的中文名
export function formatDomains(domains: DomainSummary[]): string {
  if (!domains.length) return '还没有可见的记忆'
  return domains
    .map((d) => {
      const name = LAYER_NAMES[d.domain as CuratedLayer] ?? d.domain
      return `- ${d.domain}://（${name}，${d.count} 个节点）`
    })
    .join('\n')
}

const sourceLabel = (c: CredentialSummary) => (c.source === 'hosted' ? 'Kioku 托管' : '密码库')
// 凭据的明文字段可能是别的 Key 写的（有管理能力的 agent 可能被诱导）：写进给模型的文字之前一律压成单行，
// 免得多行的说明伪造出「值：…」或指令。标识与字段名有格式限制，也一样处理，规则只有一处
const credentialHead = (c: CredentialSummary) =>
  `${inlineText(c.identifier)}（${inlineText(c.name)}）`
const fieldList = (c: CredentialSummary) => c.fields.map(inlineText).join('、') || '无'
// 到期：已到期、快到期的写在版本号前面（测试台按「版本 」取到行尾，版本号要在行尾）
const expiryText = (c: CredentialSummary) =>
  c.expiry && c.expiresAt ? `，${CREDENTIAL_EXPIRY_NAMES[c.expiry]}（${c.expiresAt}）` : ''
// 新建的凭据存在哪里（来源已经写在前面）：写进密码库的给出集合，集合的名称是密码库里的明文，也压成单行；
// 测试台里不写密码库，说明一句
const storedText = (stored: CredentialStoredIn) =>
  stored.kind === 'vault'
    ? `，已写进集合「${inlineText(stored.collectionName)}」`
    : stored.bench
      ? '（测试台里不写密码库）'
      : ''

// 取用结果：值用 JSON 写出，多行的值（例如私钥）也不会和别的行混在一起。测试台里不给值，写占位文字
export function formatCredentialAccess(a: CredentialAccess): string {
  const c = a.credential
  const lines = [`凭据：${credentialHead(c)}${expiryText(c)}，版本 ${c.version}`]
  if (c.description) lines.push(`说明：${inlineText(c.description)}`)
  lines.push(`来源：${sourceLabel(c)}，字段 ${fieldList(c)}`)
  lines.push(`值：${a.values ? JSON.stringify(a.values) : MASKED_CREDENTIAL_VALUES}`)
  lines.push('', a.notice)
  return lines.join('\n')
}

export function formatCredentialList(list: KeyCredentialList): string {
  const items = list.items.map(
    (c) =>
      `- ${credentialHead(c)}：${sourceLabel(c)}，字段 ${fieldList(c)}${expiryText(c)}，版本 ${c.version}${c.description ? `。${inlineText(c.description)}` : ''}`,
  )
  return [
    items.length ? `凭据：\n${items.join('\n')}` : '凭据：暂无可取用的凭据',
    list.truncated ? '（太多，只列出了前面的一部分）' : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function formatCredentialSummary(
  verb: string,
  c: CredentialSummary,
  stored?: CredentialStoredIn,
): string {
  return `${verb}凭据 ${credentialHead(c)}：${sourceLabel(c)}${stored ? storedText(stored) : ''}，字段 ${fieldList(c)}${expiryText(c)}，版本 ${c.version}`
}

export const PLAINTEXT_REMINDER =
  '提醒：正文像有明文密码或 Token。凭据用 kioku_credential_save 存起来，正文里换成 {{cred:<标识>#<字段>}} 占位符。'

// kioku_get 末尾的凭据列表：只说能不能取用（密码库的连接不可用时说明原因），不给值，也不记访问
export function formatPlaceholderCredentials(items: PlaceholderCredential[]): string {
  const rows = items.map((c) => {
    if (c.state === 'unavailable') return `- ${inlineText(c.identifier)}：无权查看或不存在`
    const state =
      c.state === 'usable' ? '可以取用' : `暂时取不到，${CREDENTIAL_ACCESS_REASON_NAMES[c.state]}`
    return `- ${inlineText(c.identifier)}（${inlineText(c.name ?? '')}）：${state}`
  })
  return [
    '正文里引用的凭据（值不在这里；用到时再用 kioku_credential 取，取到的值不要写回记忆，也不要显示在回复里）：',
    ...rows,
  ].join('\n')
}
