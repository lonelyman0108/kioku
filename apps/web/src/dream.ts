import type {
  DreamRunEntry,
  DreamRunStatus,
  DreamScope,
  DreamSkipReason,
  DreamSuggestionKind,
  DreamTrigger,
} from '@kioku/contracts'

import { icons } from './icons'
import { originScopeText } from './labels'

// Dream 的四种建议：卡片上的名字、图标与执行之后会怎样
export const suggestionKinds: Record<
  DreamSuggestionKind,
  { label: string; icon: string; effect: string }
> = {
  merge: {
    label: '合并重复内容',
    icon: icons.merge,
    effect:
      '执行后保留标记为「保留」的一条（URI 与层不变），正文替换为合并后的内容，其余几条删除。',
  },
  distill: {
    label: '提炼',
    icon: icons.distill,
    effect: '执行后按草稿新建一条记忆，未选层时放在当前账号的私人层；作为来源的事实保持不变。',
  },
  stale: {
    label: '可能已过时',
    icon: icons.stale,
    effect:
      '执行后有效期截止到当前时间，不再召回；记忆可在「已过期」中恢复生效，事实可在联系人页恢复生效。',
  },
  review: {
    label: '待确认内容',
    icon: icons.review,
    effect: '确认后记为本人来源；删除后不再注入对话，从对话中抽取的内容无法在管理界面恢复。',
  },
}

// 建议看的是哪一部分记忆
export function dreamScopeText(scope: DreamScope): string {
  switch (scope.kind) {
    case 'base':
      return '基础层'
    case 'persona':
      return scope.name ? `人格「${scope.name}」` : '已删除的人格'
    case 'app':
      return scope.name ? `应用「${scope.name}」` : '已删除的应用'
    case 'owner':
      return '个人画像层'
    case 'private':
      return '私人层'
    case 'talk':
      return scope.origin ? `${originScopeText(scope.origin)}中记下的` : '对话中记下的'
  }
}

export const triggerLabels: Record<DreamTrigger, string> = {
  scheduled: '每日整理',
  manual: '手动整理',
}

export const skipReasonLabels: Record<DreamSkipReason, string> = {
  'no-model': '未整理：尚未配置抽取模型（可在实例设置中配置）',
  budget: '未整理：本月抽取预算已用完',
  idle: '无需整理：上次以来没有新增或修改的内容',
  'opted-out': '本次结果未保存：请求模型期间已关闭个人画像层与私人层的整理，重新开启后将再次整理',
}

// 自己在这个空间里的 Dream 设置的查询键：空间设置里的开关与待审页的说明共用一份缓存
export const dreamSettingsKey = (spaceId: string) => ['dream-settings', spaceId] as const

// 共享部分的汇总（运行记录里范围为空的那一条，每次一条）：各个范围的条目说了用量与建议，这里只说共享的内容整体怎样
export function sharedSummaryText(entry: DreamRunEntry): string {
  if (entry.skipped === 'idle') return '上次以来没有新增或修改'
  if (entry.skipped) return skipReasonLabels[entry.skipped]
  if (entry.error) return '出错，本次已停止'
  return entry.more ? '已整理，还有未处理的内容，下次继续' : '已整理'
}

// 运行记录里一个范围的情况：用了多少 token、看了几条、提了几条建议
export function runEntrySummary(entry: DreamRunEntry): string {
  if (entry.skipped) return skipReasonLabels[entry.skipped]
  const parts = [`${entry.tokens.toLocaleString()} token`]
  if (entry.considered) {
    parts.push(
      entry.considered > entry.changed
        ? `处理 ${entry.considered} 条（新增或修改 ${entry.changed} 条）`
        : `处理 ${entry.considered} 条`,
    )
  }
  parts.push(entry.suggested ? `新建议 ${entry.suggested} 条` : '无新建议')
  if (entry.known) parts.push(`与已有建议重复 ${entry.known} 条`)
  if (entry.dropped) parts.push(`已丢弃不合规建议 ${entry.dropped} 条`)
  if (entry.more) parts.push('还有未处理的内容，下次继续')
  return parts.join(' · ')
}

// 「立即整理」做完之后的提示
export function runOutcome(
  status: DreamRunStatus,
): { title: string; color: 'success' | 'warning' | 'error' } | null {
  if (status.state !== 'finished') return null
  if (status.outcome === 'done') return { title: '整理完成，新建议见下方', color: 'success' }
  if (status.outcome === 'skipped' && status.reason) {
    return { title: skipReasonLabels[status.reason], color: 'warning' }
  }
  return { title: '整理失败，原因见下方「最近整理」', color: 'error' }
}
