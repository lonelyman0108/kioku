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
    label: '合并',
    icon: icons.merge,
    effect: '执行之后保留标着「保留」的那条（URI 与层不变），正文换成合并后的，其余几条删掉。',
  },
  distill: {
    label: '提炼',
    icon: icons.distill,
    effect:
      '执行之后按草稿新建一条策展记忆，不选层时放在你自己的私人层；作为来源的几条事实保留不动。',
  },
  stale: {
    label: '可能过时',
    icon: icons.stale,
    effect:
      '执行之后这条的有效到设为现在，不再召回；策展记忆在「已过期」里、事实在对象页上能重新生效。',
  },
  review: {
    label: '审核',
    icon: icons.review,
    effect: '和待审的内容一样：确认之后来源记为你，删除之后不再注入对话。',
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
      return '我的画像'
    case 'private':
      return '我的私人层'
    case 'talk':
      return scope.origin ? `${originScopeText(scope.origin)}里记下的` : '对话里记下的'
  }
}

export const triggerLabels: Record<DreamTrigger, string> = {
  scheduled: '每天的整理',
  manual: '手动整理',
}

export const skipReasonLabels: Record<DreamSkipReason, string> = {
  'no-model': '没整理：还没配抽取模型（实例设置里配）',
  budget: '没整理：本月的抽取预算用完了',
  idle: '没有要整理的：上次以来没有新增或改动的内容',
}

// 运行记录里一个范围的情况：用了多少 token、看了几条、提了几条建议
export function runEntrySummary(entry: DreamRunEntry): string {
  if (entry.skipped) return skipReasonLabels[entry.skipped]
  const parts = [`${entry.tokens.toLocaleString()} token`]
  if (entry.considered) {
    parts.push(
      entry.considered > entry.changed
        ? `看了 ${entry.considered} 条（新增或改动的 ${entry.changed} 条）`
        : `看了 ${entry.considered} 条`,
    )
  }
  parts.push(entry.suggested ? `新建议 ${entry.suggested} 条` : '没有新建议')
  if (entry.known) parts.push(`和已有的一样 ${entry.known} 条`)
  if (entry.dropped) parts.push(`不合规则丢掉 ${entry.dropped} 条`)
  if (entry.more) parts.push('还有没看完的，下次接着整理')
  return parts.join(' · ')
}

// 「现在整理一次」做完之后的提示
export function runOutcome(
  status: DreamRunStatus,
): { title: string; color: 'success' | 'warning' | 'error' } | null {
  if (status.state !== 'finished') return null
  if (status.outcome === 'done') return { title: '整理完了，新的建议在下面', color: 'success' }
  if (status.outcome === 'skipped' && status.reason) {
    return { title: skipReasonLabels[status.reason], color: 'warning' }
  }
  return { title: '整理出错了，原因见下面的运行记录', color: 'error' }
}
