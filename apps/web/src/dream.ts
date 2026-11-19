import type {
  DreamRunEntry,
  DreamRunList,
  DreamRunStatus,
  DreamScope,
  DreamSkipReason,
  DreamSuggestionKind,
  DreamTrigger,
} from '@kioku/contracts'

import { originScopeText } from './labels'
import { formatShort } from './time'

// Dream 的建议类型：名字与执行之后会怎样
export const suggestionKinds: Record<DreamSuggestionKind, { label: string; effect: string }> = {
  merge: {
    label: '合并重复内容',
    effect: '执行后保留标记为「保留」的一条，正文替换为合并后的内容，其余几条删除。',
  },
  merge_variants: {
    label: '合并为多变体词条',
    effect: '执行后保留标记为「保留」的一条并写入各切面变体切片，其余几条删除。',
  },
  facet_tag: {
    label: '补充切面标签',
    effect: '执行后为该词条主切片补全建议的适用切面条件，正文保持不变。',
  },
  generalize: {
    label: '泛化上浮共性',
    effect: '执行后将跨项目共性提炼写入通用切片，各特定项目切片按建议精简或保留。',
  },
  distill: {
    label: '提炼词条',
    effect: '执行后按草稿新建一条正式词条；作为来源的事实保持不变。',
  },
  distill_episode: {
    label: '沉淀会话摘要',
    effect: '执行后将到期会话摘要中的关键结论新建为正式词条；原摘要保持不变。',
  },
  stale: {
    label: '可能已过时',
    effect:
      '执行后有效期截止到当前时间，不再召回；词条可在「已过期」中恢复生效，事实可在联系人页恢复生效。',
  },
  review: {
    label: '待确认内容',
    effect: '确认后记为本人来源；删除后不再注入对话，从对话中抽取的内容无法在管理界面恢复。',
  },
  promote: {
    label: '提升优先级',
    effect: '执行后将这条记忆调整为重要或加入启动加载，高频内容无需检索即可稳定生效。',
  },
}

// 建议看的是哪一部分记忆
export function dreamScopeText(scope: DreamScope): string {
  switch (scope.kind) {
    case 'circle':
      return scope.name ? `记忆圈「${scope.name}」` : '当前记忆圈'
    case 'personal':
      return scope.name ? `${scope.name} 的私密内容` : '个人范围'
    case 'talk':
      return scope.origin ? `${originScopeText(scope.origin)}中记下的` : '对话中记下的'
    case 'local_session':
      return scope.name ? `本地会话「${scope.name}」` : '本地会话'
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
  'opted-out': '本次结果未保存：请求模型期间已关闭个人范围的整理，重新开启后将再次整理',
}

// 自己在这个记忆圈里的 Dream 设置的查询键：记忆圈设置里的开关与待处理页的说明共用一份缓存
export const dreamSettingsKey = (circleId: string) => ['dream-settings', circleId] as const

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

// 标题旁边的一句话：最近一次什么时候整理、处理了多少、用了多少。各个范围的加起来
export function lastRunSummary(run: DreamRunList['runs'][number], now: Date = new Date()): string {
  const considered = run.entries.reduce((sum, entry) => sum + entry.considered, 0)
  const tokens = run.entries.reduce((sum, entry) => sum + entry.tokens, 0)
  return `${formatShort(run.at, now)}，处理 ${considered} 条，用量 ${tokens.toLocaleString()} token`
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
