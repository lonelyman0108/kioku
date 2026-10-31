import {
  RETENTION_DAILY_TRIES,
  type DeletedCredentialProvider,
  type DeletionRetention,
  type RetentionCounts,
  type RetentionStatus,
  type RetentionView,
} from '@kioku/contracts'

import { formatTime } from './time'

const DAY = 86_400_000
// 还剩这么几天就要永久清除的标成警示色
const SOON_DAYS = 3

// 一条已删除的记录最早什么时候被永久清除：删除时间加上保留天数；知道清理暂停到什么时候的，不早于暂停结束的时间。
// 清理每天做一次，实际在这之后的那一次里删
export function purgeAt(deletedAt: string, retention: DeletionRetention): Date {
  const due = new Date(deletedAt).getTime() + retention.days * DAY
  const paused = retention.pausedUntil === null ? 0 : new Date(retention.pausedUntil).getTime()
  return new Date(Math.max(due, paused))
}

// 大约还剩几天被永久清除：不足一天按一天算；已经到了、等着下一次清理的为 0
export function daysUntilPurge(
  deletedAt: string,
  retention: DeletionRetention,
  now: Date = new Date(),
): number {
  const left = purgeAt(deletedAt, retention).getTime() - now.getTime()
  return Math.max(0, Math.ceil(left / DAY))
}

// 已删除列表里每一条后面的说法，以及要不要标成快要清除（警示色）。清理暂停着、又不知道到什么时候
// （不是实例管理员）时只能说至少还要多久：到期的不说即将清除，暂停结束之前一条都不删，也不标警示色，免得催人去撤销
export function purgeNote(
  deletedAt: string,
  retention: DeletionRetention,
  now: Date = new Date(),
): { text: string; soon: boolean } {
  const days = daysUntilPurge(deletedAt, retention, now)
  if (retention.paused && retention.pausedUntil === null) {
    return { text: days > 0 ? `至少 ${days} 天后永久清除` : '暂停结束后清除', soon: false }
  }
  return { text: days > 0 ? `约 ${days} 天后永久清除` : '即将永久清除', soon: days <= SOON_DAYS }
}

// 已删除的凭据源什么时候永久清除。retentionFrom 为 null 时还有没删除的凭据指着它，清理不删它，不说几天；
// 否则和别的已删除记录一样，只是从 retentionFrom 算起（指着它的已删除凭据清除之后才轮到它）
export function providerPurgeNote(
  provider: Pick<DeletedCredentialProvider, 'retentionFrom'>,
  retention: DeletionRetention,
  now: Date = new Date(),
): { text: string; soon: boolean } {
  if (provider.retentionFrom === null) return { text: '仍有凭据绑定，暂不清除', soon: false }
  return purgeNote(provider.retentionFrom, retention, now)
}

// 列表上方说明的后半句：清理暂停中的说暂时不会清除，知道到什么时候的再说出时间
function pauseNotice(retention: DeletionRetention): string {
  if (!retention.paused) return ''
  if (retention.pausedUntil === null) return '清理已暂停，暂不永久清除。'
  const until = formatTime(retention.pausedUntil)
  return `清理暂停至 ${until}（从备份恢复或保留期刚生效时，先留出一个完整的保留期），在此之前不会清除任何内容。`
}

// 已删除列表上方的说明：多少天之后永久清除，再加上暂停的情况
export function deletionNotice(retention: DeletionRetention): string {
  return `删除超过 ${retention.days} 天后永久清除，之后只能从备份恢复。${pauseNotice(retention)}`
}

// 已过期列表上方给「URI 已释放」的说明：让出 URI 时算作删除，按让出的时间清除；没让出的过期记忆不清除
export function releasedNotice(retention: DeletionRetention): string {
  return `标记为「URI 已释放」的记忆，释放超过 ${retention.days} 天后永久清除，之后只能从备份恢复；未释放的记忆一直保留。${pauseNotice(retention)}`
}

// 一次清理每一类删了多少：卡片上按这个顺序列
export const retentionLabels: Record<keyof RetentionCounts, string> = {
  deletedMemories: '已删除的记忆',
  supersededFacts: '已被取代的事实',
  expiredSummaries: '过期的会话摘要',
  orphanEvents: '记忆已不存在的历史',
  scrubbedSnapshots: '已抹除正文的历史快照',
  extractionRuns: '抽取记录',
  dreamRuns: 'Dream 的运行记录',
  dreamSuggestions: '已处理或已失效的 Dream 建议',
  credentialEvents: '凭据事件',
  deletedCredentials: '已删除的凭据',
  deletedProviders: '已删除的凭据源',
  subjectBindings: '已处理的绑定记录',
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
  const head = `最近一次清理（${formatTime(attempt.at)}）未完成（出错或超时，本次删除 ${retentionTotal(attempt.counts)} 条）`
  const today = attempt.at.slice(0, 10) === now.toISOString().slice(0, 10)
  return today && attempt.tries >= RETENTION_DAILY_TRIES
    ? `${head}，今天已尝试 ${attempt.tries} 次，明天重试`
    : `${head}，下一小时重试`
}

// 暂停按原因给说法：卡片上的标题与说明、提示层里的细节，以及提前开始时确认框里的话
export function pauseText(
  pause: NonNullable<RetentionView['pause']>,
  days: number,
): { title: string; description: string; detail: string; confirm: string } {
  const since = formatTime(pause.since)
  const until = formatTime(pause.until)
  const always = '已删除账号留下的历史仍每天清理。'
  if (pause.reason === 'restored') {
    return {
      title: `已于 ${since} 从备份恢复，清理暂停至 ${until}`,
      description: '如需找回已删除的记录，请在暂停结束前到记忆页或凭据页恢复。',
      detail: `恢复出的已删除记录按删除时间多已超过保留期，照常清理会立即将其永久删除。暂停至恢复时间加保留天数（调整保留天数时随之变化），之后自动照常清理。${always}`,
      confirm: `恢复出的已删除记录中，删除超过 ${days} 天的将被永久删除，无法撤销。如需从这份备份找回，请先在记忆页或凭据页恢复。`,
    }
  }
  return {
    title: `保留期自 ${since} 起生效，首次清理在 ${until}`,
    description: '此前删除的内容在首次清理前仍可恢复。',
    detail: `先留出一个完整的保留期（调整保留天数时随之变化），之后自动按保留天数清理。${always}`,
    confirm: `已删除超过 ${days} 天的记忆、凭据等将被永久删除，无法撤销。如需找回，请先在记忆页或凭据页恢复。`,
  }
}
