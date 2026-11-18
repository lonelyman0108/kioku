import {
  CREDENTIAL_ACCESS_REASON_NAMES,
  CREDENTIAL_EXPIRY_NAMES,
  normalizeWhen,
  type CredentialAccess,
  type CredentialStoredIn,
  type CredentialSummary,
  type EntryBrowseResponse,
  type EntryLinkNeighbor,
  type EntryView,
  type KeyCredentialList,
  type WhenCondition,
} from '@kioku/contracts'

import type { PlaceholderCredential } from '../credential/service'
import { MASKED_CREDENTIAL_VALUES, MASKED_SECRET_CONTENT } from '../memory/masked'
import { inlineText, titleSuffix } from '../recall/text'

// 工具里的非业务错误只回这句，和 REST 一致。测试台也按它认内部错误
export const TOOL_INTERNAL_ERROR = '服务内部错误'

const INLINE_WIKI_LINK = /\[\[(m-[2-9a-hjkmnp-tv-z]{6,8})(?:\|([^\]\n]+))?\]\]/gi

export function formatWhenTag(when: WhenCondition): string {
  const clean = normalizeWhen(when)
  const parts = Object.entries(clean).map(([dim, slugs]) => `${dim}=${slugs.join(',')}`)
  return parts.length ? parts.join(', ') : '通用'
}

// 仅给当前可读的出向目标双链实时注上最新标题；无权查看、机密或悬空目标保持原样不泄露存在性
function annotateReadableLinks(text: string, links: readonly EntryLinkNeighbor[]): string {
  const titleByShort = new Map<string, string>()
  for (const link of links) {
    if (link.direction === 'outgoing') {
      titleByShort.set(link.shortId.toLowerCase(), inlineText(link.title))
    }
  }
  if (!titleByShort.size) return text
  return text.replace(INLINE_WIKI_LINK, (full, rawId: string, alias?: string) => {
    const shortId = rawId.toLowerCase()
    if (alias !== undefined) return `[[${shortId}|${alias}]]`
    const title = titleByShort.get(shortId)
    return title ? `[[${shortId}|${title}]]` : full
  })
}

// MCP 工具结果给模型读，用紧凑的文本而不是 JSON；版本字段留在所属行尾以兼容结构化提取
export function formatEntry(view: EntryView, options: { requestedId?: string } = {}): string {
  const lines: string[] = []
  const req = options.requestedId?.trim().toLowerCase()
  if (req && req !== view.shortId) {
    lines.push(`提示: 已解析到规范短 ID ${view.shortId}（后续请直接使用此短 ID 读写）`)
  }
  lines.push(
    `ID: ${view.shortId}`,
    `标题: ${inlineText(view.title)}`,
    `记忆圈: ${view.circleSlug ?? '当前圈'}，物种: ${view.kind}，敏感级: ${view.sensitivity}，priority: ${view.priority}，版本: ${view.version}`,
  )
  if (view.topics.length) lines.push(`主题: ${view.topics.join(', ')}`)
  if (view.realms.length) lines.push(`场域: ${view.realms.join(', ')}`)
  if (view.validTo) lines.push(`有效到: ${view.validTo}（到期后不再召回）`)
  if (view.disclosure) lines.push(`Disclosure: ${inlineText(view.disclosure)}`)
  if (view.glossary.length) lines.push(`Glossary: ${view.glossary.map(inlineText).join(', ')}`)
  if (view.otherVariants.length) {
    lines.push(
      `其余可用切片（传 all_variants: true 查看全量）: ${view.otherVariants
        .map((o) => `[${formatWhenTag(o.when)}]`)
        .join('、')}`,
    )
  }
  if (view.links.length) {
    const linkList = view.links
      .map(
        (l) =>
          `${l.direction === 'outgoing' ? '->' : '<-'} [[${l.shortId}]]「${inlineText(l.title)}」${
            l.circleSlug ? ` [${l.circleSlug}]` : ''
          }`,
      )
      .join('；')
    lines.push(`关联词条: ${linkList}`)
  }

  if (!view.variants.length) {
    lines.push(
      '',
      '（当前切面条件下无匹配切片；请传 all_variants: true 或调整 variant_filter 查看其余切片）',
    )
    return lines.join('\n')
  }

  const singleBase =
    view.variants.length === 1 && Object.keys(normalizeWhen(view.variants[0]!.when)).length === 0
  if (singleBase) {
    const raw = view.variants[0]!.content
    const body =
      raw === null
        ? MASKED_SECRET_CONTENT
        : view.sensitivity === 'secret'
          ? raw
          : annotateReadableLinks(raw, view.links)
    lines.push('', body)
    return lines.join('\n')
  }

  for (const variant of view.variants) {
    const raw = variant.content
    const body =
      raw === null
        ? MASKED_SECRET_CONTENT
        : view.sensitivity === 'secret'
          ? raw
          : annotateReadableLinks(raw, view.links)
    lines.push('', `### 切片 [${formatWhenTag(variant.when)}]`, body)
  }
  return lines.join('\n')
}

export function formatBrowse(result: EntryBrowseResponse): string {
  if (!result.groups.length) return '还没有可见的记忆词条'
  const sections = result.groups.map((group) => {
    const headerLabel =
      group.key && group.key !== group.label
        ? `${inlineText(group.label)}（${group.key}，${group.count}）`
        : `${inlineText(group.label)}（${group.count}）`
    const items = group.items.map((item) => {
      const circleTag = item.circleSlug ? ` [${item.circleSlug}]` : ''
      const tags = item.variantsSummary
        .map((w) => `[${formatWhenTag(w)}]`)
        .filter((t) => t !== '[通用]')
      const tagStr = tags.length ? `，切面 ${tags.join(' / ')}` : ''
      return `- ${item.shortId}${titleSuffix(item.shortId, item.title)}${circleTag}（${item.kind}，${item.sensitivity}，priority ${item.priority}${tagStr}）${
        item.disclosure ? `：${inlineText(item.disclosure)}` : ''
      }`
    })
    return [`## ${headerLabel}`, ...items].join('\n')
  })
  if (result.truncated) {
    sections.push(
      '（结果较多，只列出了前面的一部分，可加 query/topic/facets 缩小范围或改用 kioku_search）',
    )
  }
  return sections.join('\n\n')
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

// 修改的请求什么都没改（值与现在的相同、别的部分也没变）：版本号不变，如实说没有改动。
// 密码库的值相同时客户端不发修改；「版本 」照旧在行尾
export function formatCredentialUnchanged(c: CredentialSummary, valuesGiven: boolean): string {
  const why = valuesGiven && c.source === 'vault' ? '值与密码库里的相同' : '内容与现在的相同'
  return `凭据 ${credentialHead(c)}没有改动：${why}，版本 ${c.version}`
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
