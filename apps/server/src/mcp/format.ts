import {
  effectiveBootMode,
  extractMarkdownOutline,
  extractMarkdownSection,
  stripDuplicateLeadingHeading,
  type BootMode,
  type CredentialMeta,
  type EntryBrowseResponse,
  type EntryDetailResponse,
  type EntryHistoryResponse,
} from '@kioku/contracts'

import { clipChars, inlineText } from '../recall/text'

export const TOOL_INTERNAL_ERROR = '服务内部错误，请稍后重试'

const OUTLINE_HINT_MIN_CHARS = 4_000

const BOOT_MODE_TEXT: Record<BootMode, string> = {
  none: '按需召回',
  index: '目录常驻',
  full: '全文常驻',
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  create: '创建',
  update: '修改',
  delete: '移入回收站',
  undelete: '恢复生效',
  restore: '恢复版本',
  archive_note: '历史归档',
}

export interface FormatEntryDetailOptions {
  view?: 'full' | 'outline' | undefined
  section?: string | undefined
}

export function formatEntryDetail(
  detail: EntryDetailResponse,
  options: FormatEntryDetailOptions = {},
): string {
  const { entry, outboundLinks, backlinks, credentialRefs, recentHistory, warnings } = detail
  const updatedDate = entry.updatedAt.slice(0, 10)
  const verifiedPart = entry.verifiedAt ? `（核实：${entry.verifiedAt.slice(0, 10)}）` : ''
  const bootMode = effectiveBootMode(entry)
  const lines: string[] = [
    `# ${inlineText(entry.title)} (${entry.shortId})`,
    `类型：${entry.kind === 'episode' ? '会话摘要' : '正式记忆'} | 启动加载：${BOOT_MODE_TEXT[bootMode]} | 版本：v${entry.version} | 更新：${updatedDate}${verifiedPart}`,
  ]
  if (entry.lastChangeSummary) {
    const historyHint =
      recentHistory && recentHistory.length > 1
        ? `（另有历史记录，需追溯时调用 kioku_history）`
        : ''
    lines.push(`最近变更：${inlineText(entry.lastChangeSummary)}${historyHint}`)
  } else if (recentHistory && recentHistory.length > 1) {
    lines.push(
      `历史记录：共记录近期 ${recentHistory.length} 条以上变更，需追溯时调用 kioku_history`,
    )
  }
  if (entry.summary) lines.push(`现行概要：${inlineText(entry.summary)}`)

  const meta: string[] = []
  if (entry.projects.length) meta.push(`项目：${entry.projects.join(', ')}`)
  if (entry.envs.length) meta.push(`环境：${entry.envs.join(', ')}`)
  if (entry.realms.length) meta.push(`场域：${entry.realms.join(', ')}`)
  if (entry.runtimes.length) meta.push(`客户端：${entry.runtimes.join(', ')}`)
  if (entry.topics.length) meta.push(`主题：${entry.topics.join(', ')}`)
  if (entry.validTo) meta.push(`有效期至：${entry.validTo}`)
  if (meta.length) lines.push(meta.join(' | '))
  if (entry.disclosure) lines.push(`触发场景：${inlineText(entry.disclosure)}`)

  const cleanContent = stripDuplicateLeadingHeading(entry.title, entry.content)

  if (options.section) {
    const matched = extractMarkdownSection(cleanContent, options.section)
    if (matched) {
      lines.push('', matched.content)
    } else {
      const outline = extractMarkdownOutline(cleanContent)
      const available = outline.length
        ? outline.map((s) => `「${s.heading}」`).join('、')
        : '（正文暂无二级小节）'
      lines.push('', `未找到小节「${inlineText(options.section)}」。可用小节：${available}`)
    }
  } else if (options.view === 'outline') {
    const outline = extractMarkdownOutline(cleanContent)
    lines.push('', `## 正文大纲（全文共 ${cleanContent.length} 字）`)
    if (outline.length) {
      for (const sec of outline) {
        const preview = sec.preview ? ` — ${inlineText(sec.preview)}` : ''
        lines.push(`- ${sec.heading}（${sec.charCount} 字）${preview}`)
      }
      lines.push('', '提示：如需读取某一节，可传 `section: "<小节标题>"` 调用 kioku_get。')
    } else {
      lines.push(clipChars(cleanContent, 500))
    }
  } else {
    if (cleanContent.length >= OUTLINE_HINT_MIN_CHARS) {
      const outline = extractMarkdownOutline(cleanContent)
      if (outline.length >= 2) {
        lines.push(
          '',
          `小节目录：${outline.map((s) => `${s.heading}(${s.charCount}字)`).join(' / ')}`,
        )
      }
    }
    lines.push('', cleanContent)
  }

  if (outboundLinks.length || backlinks.length) {
    lines.push('', '## 关联记忆')
    for (const link of outboundLinks) {
      const rel = link.relation ? `（${inlineText(link.relation)}）` : ''
      lines.push(`- 出链：[[${link.shortId}]] ${inlineText(link.title)}${rel}`)
    }
    for (const link of backlinks) {
      const rel = link.relation ? `（${inlineText(link.relation)}）` : ''
      lines.push(`- 反链：[[${link.shortId}]] ${inlineText(link.title)}${rel}`)
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

  if (warnings?.length) {
    lines.push('', '## 结构建议（非阻断，已保存）')
    for (const w of warnings) {
      lines.push(`- [${w.code}] ${w.message}`)
    }
  }

  return lines.join('\n')
}

export function formatEntryHistory(
  targetLabel: string,
  res: EntryHistoryResponse,
  requestedVersion?: number,
): string {
  if (!res.items.length) {
    return requestedVersion !== undefined
      ? `${targetLabel} 未找到版本 v${requestedVersion} 的历史记录。`
      : `${targetLabel} 暂无历史记录。`
  }

  if (requestedVersion !== undefined) {
    const item = res.items[0]!
    const time = (item.occurredAt ?? item.createdAt).slice(0, 19).replace('T', ' ')
    const actor = item.actorMeta?.label ?? '系统'
    const lines = [
      `# ${targetLabel} · 历史版本 v${requestedVersion}`,
      `时间：${time} | 操作：${EVENT_TYPE_LABELS[item.eventType] ?? item.eventType} | 来源：${actor}`,
    ]
    if (item.changeSummary) lines.push(`变更说明：${inlineText(item.changeSummary)}`)
    if (item.snapshot) {
      lines.push(`标题：${inlineText(item.snapshot.title)}`)
      if (item.snapshot.summary) lines.push(`现行概要：${inlineText(item.snapshot.summary)}`)
      lines.push('', item.snapshot.content)
    }
    return lines.join('\n')
  }

  const lines: string[] = [`# ${targetLabel} · 变更历史（共 ${res.items.length} 条）`, '']
  for (const item of res.items) {
    const time = (item.occurredAt ?? item.createdAt).slice(0, 10)
    const ver = item.version !== null && item.version !== undefined ? `v${item.version}` : '归档'
    const kind = EVENT_TYPE_LABELS[item.eventType] ?? item.eventType
    const actor = item.actorMeta?.label ?? '系统'
    let detail = item.changeSummary ? inlineText(item.changeSummary) : ''
    if (!detail && item.diffMeta) {
      const delta = item.diffMeta.contentCharsAfter - item.diffMeta.contentCharsBefore
      const deltaText = delta === 0 ? '' : delta > 0 ? `（+${delta} 字）` : `（${delta} 字）`
      detail = item.diffMeta.changedFields.length
        ? `改动字段：${item.diffMeta.changedFields.join(', ')}${deltaText}`
        : `正文变动${deltaText}`
    }
    const suffix = detail ? ` — ${clipChars(detail, 140)}` : ''
    lines.push(`- ${ver} · ${time} · ${kind}（${actor}）${suffix}`)
  }
  lines.push('', '提示：如需查看某一版本的完整快照，传 `version: <版本号>` 调用 kioku_history。')
  return lines.join('\n')
}

export function formatBrowseResponse(res: EntryBrowseResponse): string {
  if (!res.groups.length) return '暂无匹配的记忆。'
  const lines: string[] = []
  for (const group of res.groups) {
    lines.push(`## ${inlineText(group.label)}（${group.count}）`)
    for (const item of group.items) {
      const mode = effectiveBootMode(item)
      const pin = mode === 'full' ? ' [全文常驻]' : mode === 'index' ? ' [目录常驻]' : ''
      const updated = item.updatedAt ? ` · ${item.updatedAt.slice(0, 10)}` : ''
      const chars =
        item.contentLength && item.contentLength >= 1000
          ? ` · ${(item.contentLength / 1000).toFixed(1)}k字`
          : ''
      const desc = item.summary?.trim() || item.disclosure?.trim() || ''
      const note = desc ? ` — ${clipChars(inlineText(desc), 100)}` : ''
      lines.push(`- ${item.shortId} · ${inlineText(item.title)}${pin}${updated}${chars}${note}`)
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
