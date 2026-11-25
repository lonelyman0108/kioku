import type { CredentialMeta, EntryBrowseResponse, EntryDetailResponse } from '@kioku/contracts'

import { inlineText } from '../recall/text'

export const TOOL_INTERNAL_ERROR = '服务内部错误，请稍后重试'

export function formatEntryDetail(detail: EntryDetailResponse): string {
  const { entry, outboundLinks, backlinks, credentialRefs } = detail
  const lines: string[] = [
    `# ${inlineText(entry.title)} (${entry.shortId})`,
    `类型：${entry.kind === 'episode' ? '会话摘要' : '正式记忆'} | 常驻：${entry.isPinned ? '是' : '否'} | 版本：${entry.version}`,
  ]
  const meta: string[] = []
  if (entry.projects.length) meta.push(`项目：${entry.projects.join(', ')}`)
  if (entry.envs.length) meta.push(`环境：${entry.envs.join(', ')}`)
  if (entry.realms.length) meta.push(`场域：${entry.realms.join(', ')}`)
  if (entry.runtimes.length) meta.push(`客户端：${entry.runtimes.join(', ')}`)
  if (entry.topics.length) meta.push(`主题：${entry.topics.join(', ')}`)
  if (entry.validTo) meta.push(`有效期至：${entry.validTo}`)
  if (meta.length) lines.push(meta.join(' | '))
  if (entry.disclosure) lines.push(`触发场景：${inlineText(entry.disclosure)}`)

  lines.push('', entry.content)

  if (outboundLinks.length || backlinks.length) {
    lines.push('', '## 关联记忆')
    for (const link of outboundLinks) {
      lines.push(`- 出链：[[${link.shortId}]] ${inlineText(link.title)}`)
    }
    for (const link of backlinks) {
      lines.push(`- 反链：[[${link.shortId}]] ${inlineText(link.title)}`)
    }
  }

  if (credentialRefs.length) {
    lines.push('', '## 正文引用的凭据占位符')
    for (const ref of credentialRefs) {
      const token = ref.field ? `{{cred:${ref.slug}#${ref.field}}}` : `{{cred:${ref.slug}}}`
      const status = ref.available
        ? `可用（${ref.label ? `${inlineText(ref.label)}，` : ''}经 kioku run 注入）`
        : '不可用或当前密钥无权访问'
      lines.push(`- ${token}：${status}`)
    }
  }

  return lines.join('\n')
}

export function formatBrowseResponse(res: EntryBrowseResponse): string {
  if (!res.groups.length) return '暂无匹配的记忆。'
  const lines: string[] = []
  for (const group of res.groups) {
    lines.push(`## ${inlineText(group.label)}（${group.count}）`)
    for (const item of group.items) {
      const pin = item.isPinned ? ' [常驻]' : ''
      const note = item.disclosure ? ` — ${inlineText(item.disclosure)}` : ''
      lines.push(`- ${item.shortId} · ${inlineText(item.title)}${pin}${note}`)
    }
    lines.push('')
  }
  if (res.truncated) lines.push('结果已截断，可加筛选条件进一步缩小范围。')
  return lines.join('\n').trim()
}

export function formatCredentialMetadataList(items: readonly CredentialMeta[]): string {
  if (!items.length) return '无可用凭据。'
  const lines: string[] = ['## 可用凭据清单（仅元数据）', '']
  for (const item of items) {
    const desc = item.description ? ` — ${inlineText(item.description)}` : ''
    const realms = item.allowedRealms?.length ? ` [场域: ${item.allowedRealms.join(', ')}]` : ''
    lines.push(`- \`${item.slug}\`（${inlineText(item.label)}）${realms}${desc}`)
  }
  lines.push(
    '',
    '提示：凭据原值不可直接读取，请用 `kioku run -e VAR=<slug> -- <命令>` 注入环境变量，记忆正文只写 `{{cred:<slug>}}`。',
  )
  return lines.join('\n')
}
