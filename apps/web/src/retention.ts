import {
  RETENTION_DAILY_TRIES,
  type RetentionCounts,
  type RetentionStatus,
  type RetentionView,
} from '@kioku/contracts'

import { formatTime } from './time'

// 一次清理每一类删了多少：卡片上按这个顺序列
export const retentionLabels: Record<keyof RetentionCounts, string> = {
  deletedMemories: '已删除的记忆',
  supersededFacts: '被推翻的事实',
  expiredSummaries: '过期的会话摘要',
  orphanEvents: '记忆已经不在的历史',
  scrubbedSnapshots: '抹掉正文的历史快照',
  extractionRuns: '抽取记录',
  dreamRuns: 'Dream 的运行记录',
  dreamSuggestions: '处理过或作废的 Dream 建议',
  credentialEvents: '凭据事件',
  deletedCredentials: '已删除的凭据',
  deletedProviders: '已删除的凭据源',
  subjectBindings: '处理完的绑定记录',
}

// 删了东西的那几类，一条都没删的不列
export function retentionSummary(counts: RetentionCounts): { label: string; count: number }[] {
  return (Object.keys(retentionLabels) as (keyof RetentionCounts)[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => ({ label: retentionLabels[kind], count: counts[kind] }))
}

export function retentionTotal(counts: RetentionCounts): number {
  return Object.values(counts).reduce((a, b) => a + b, 0)
}

// 最近一次尝试没做完时的说法：下一个小时再试，或者今天（UTC）已经试满了、明天再试。做完了、还没试过时为 null
export function attemptNote(
  attempt: RetentionStatus['lastAttempt'],
  now: Date = new Date(),
): string | null {
  if (!attempt || attempt.complete) return null
  const head = `最近一次（${formatTime(attempt.at)}）没做完（出错或者到了时间，这次删了 ${retentionTotal(attempt.counts)} 条）`
  const today = attempt.at.slice(0, 10) === now.toISOString().slice(0, 10)
  return today && attempt.tries >= RETENTION_DAILY_TRIES
    ? `${head}，今天已经试了 ${attempt.tries} 次，明天再试`
    : `${head}，下一个小时再试`
}

// 暂停按原因给说法：卡片上的标题与说明，以及提前开始时确认框里的话
export function pauseText(
  pause: NonNullable<RetentionView['pause']>,
  days: number,
): { title: string; description: string; confirm: string } {
  const since = formatTime(pause.since)
  const until = formatTime(pause.until)
  const always = '删账号留下的历史照常每天清理。'
  if (pause.reason === 'restored') {
    return {
      title: `从备份恢复于 ${since}，清理暂停到 ${until}`,
      description: `恢复出的已删除记录按删除的时间早就过了保留期，照常清理会马上把它们永久删掉。暂停到恢复的时间加上保留天数（调保留天数时跟着变），要从备份里找回的在这之前撤销删除；之后自动照常清理。${always}`,
      confirm: `恢复出的已删除记录里，删除超过 ${days} 天的会被永久删除，不能撤销。要从这份备份里找回的，先在记忆页或凭据页撤销删除。`,
    }
  }
  return {
    title: `保留期从 ${since} 开始生效，第一次清理在 ${until}`,
    description: `之前删掉的到现在都还能撤销，先留一个完整的保留期（调保留天数时跟着变），之后自动按保留天数清理。${always}`,
    confirm: `已经删除超过 ${days} 天的记忆、凭据等会被永久删除，不能撤销。要找回的，先在记忆页或凭据页撤销删除。`,
  }
}
