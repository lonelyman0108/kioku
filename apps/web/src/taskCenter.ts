import type {
  DreamFailedItem,
  DreamMode,
  DreamOutcome,
  DreamRunParams,
  DreamRunSummary,
  DreamState,
  EmbeddingBackfillRunSummary,
  EmbeddingBackfillState,
} from '@kioku/contracts'

import { icons } from './icons'
import { dreamModeLabels } from './labels'

export const TASK_HISTORY_LIMIT = 20
export const CASCADE_ABORT_REASON_PREFIX = '因前序任务触发上游故障已中止'
const DISMISSED_ISSUES_LIMIT = 60

export type TaskSource = 'dream' | 'backfill'

export interface TaskHistoryItem {
  key: string
  id: string
  source: TaskSource
  mode?: DreamMode
  title: string
  icon: string
  trigger: 'manual' | 'scheduled'
  outcome: DreamOutcome
  summary: string
  error: string | null
  errorDetail?: string | null
  failedItems?: DreamFailedItem[]
  params?: DreamRunParams
  retriedByRunId?: string | null
  finishedAt: string
  routeTarget: 'inbox' | 'models' | null
}

export function isTaskIssueOutcome(outcome: DreamOutcome): boolean {
  return outcome === 'failed' || outcome === 'partial'
}

export function isActiveTaskIssue(
  item: Pick<TaskHistoryItem, 'key' | 'outcome' | 'retriedByRunId'>,
  dismissedKeys?: ReadonlySet<string>,
): boolean {
  if (!isTaskIssueOutcome(item.outcome)) return false
  if (item.retriedByRunId) return false
  if (dismissedKeys?.has(item.key)) return false
  return true
}

export function parseDismissedIssueKeys(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    const keys = parsed.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    )
    return new Set(keys.slice(-DISMISSED_ISSUES_LIMIT))
  } catch {
    return new Set()
  }
}

export function serializeDismissedIssueKeys(
  keys: ReadonlySet<string> | readonly string[],
): string | null {
  const list = [...new Set([...keys].filter((item) => item.trim().length > 0))].slice(
    -DISMISSED_ISSUES_LIMIT,
  )
  return list.length > 0 ? JSON.stringify(list) : null
}

export function splitTaskHistory(
  items: readonly TaskHistoryItem[],
  dismissedKeys?: ReadonlySet<string>,
): { issues: TaskHistoryItem[]; recent: TaskHistoryItem[] } {
  const issues: TaskHistoryItem[] = []
  const recent: TaskHistoryItem[] = []
  for (const item of items) {
    if (isActiveTaskIssue(item, dismissedKeys)) issues.push(item)
    else recent.push(item)
  }
  return { issues, recent }
}

export function isCascadeAbortedRun(
  run: Pick<DreamRunSummary, 'outcome' | 'abortedReason'>,
): boolean {
  return (
    run.outcome === 'cancelled' &&
    Boolean(run.abortedReason?.startsWith(CASCADE_ABORT_REASON_PREFIX))
  )
}

// 按时间先后提取位于 lastSeenRunId 之后的新增完成记录；当游标滑出保留窗口或无游标时退回时间水位防历史导入轰炸
export function collectNewDreamRuns(
  recentRuns: readonly DreamRunSummary[],
  lastSeenRunId: string | null,
  lastSeenAt: string | null = null,
): DreamRunSummary[] {
  if (!recentRuns.length) return []
  if (lastSeenRunId) {
    const idx = recentRuns.findIndex((run) => run.id === lastSeenRunId)
    if (idx === 0) return []
    if (idx > 0) return recentRuns.slice(0, idx).reverse()
  }
  const filtered = lastSeenAt
    ? recentRuns.filter((run) => isAfterWatermark(run.createdAt, lastSeenAt))
    : recentRuns
  return [...filtered].reverse()
}

export function formatDreamTaskScope(
  mode: DreamMode,
  params?: DreamRunParams,
  targetCount?: number,
): string {
  const targeted = params?.targetShortIds?.length ?? 0
  if (targeted > 0) return `指定 ${targeted} 条记忆重试`
  if (mode === 'tidy') {
    if (params?.all) return '全部待规范记忆'
    const count = params?.limit ?? targetCount
    if (count && count > 0) {
      return params?.pinnedFirst === false ? `本批 ${count} 条` : `本批 ${count} 条（常驻优先）`
    }
    return '待规范记忆批次'
  }
  if (mode === 'cross_memory') {
    return params?.scope === 'incremental' ? '增量范围' : '全库范围'
  }
  return '近期会话摘要与新记忆'
}

function dreamIconFor(mode: DreamMode | undefined): string {
  if (mode === 'tidy') return icons.tidy
  if (mode === 'cross_memory') return icons.links
  return icons.sparkles
}

function resolveDreamErrorDetail(run: DreamState['recentRuns'][number]): string | null {
  const rawError = run.error?.trim()
  if (rawError) return rawError
  const firstFailed = run.failedItems?.find((item) => item.reason.trim().length > 0)
  if (firstFailed) {
    const label = firstFailed.title.trim() || firstFailed.shortId
    return `${label}：${firstFailed.reason.trim()}`
  }
  if (isTaskIssueOutcome(run.outcome)) {
    return run.abortedReason?.trim() || null
  }
  return null
}

function summarizeDreamRun(run: DreamState['recentRuns'][number]): string {
  if (run.outcome === 'failed') {
    return resolveDreamErrorDetail(run) || '执行过程中遇到错误'
  }
  if (run.outcome === 'cancelled') {
    if (run.suggested > 0) return `已取消 · 已保留 ${run.suggested} 条待确认建议`
    return run.abortedReason?.trim() || '已手动取消'
  }
  if (run.outcome === 'skipped') {
    return run.error?.trim() || '当前无可整理项'
  }
  const bits: string[] = []
  if (run.suggested > 0) bits.push(`新增 ${run.suggested} 条建议`)
  else bits.push('无新增建议')
  if (run.considered > 0) bits.push(`核查 ${run.considered} 条`)
  if (run.failedItems?.length) bits.push(`失败 ${run.failedItems.length} 条`)
  return bits.join(' · ')
}

function summarizeBackfillRun(run: EmbeddingBackfillRunSummary): string {
  if (run.outcome === 'failed') {
    return run.error?.trim() || '向量补齐执行失败'
  }
  if (run.outcome === 'cancelled') {
    return run.updated > 0 ? `已取消 · 已更新 ${run.updated} 条索引` : '已手动取消'
  }
  if (run.updated > 0) {
    return run.model ? `更新 ${run.updated} 条索引 · ${run.model}` : `更新 ${run.updated} 条索引`
  }
  return '索引已是最新状态'
}

function timestampMs(iso: string | null | undefined): number {
  if (!iso) return 0
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

export function isAfterWatermark(iso: string, watermark: string | null): boolean {
  if (!watermark) return true
  const markMs = timestampMs(watermark)
  if (markMs <= 0) return true
  const itemMs = timestampMs(iso)
  if (itemMs <= 0) return false
  return itemMs > markMs
}

export function mergeTaskHistory(
  dreamState: DreamState | null,
  embeddingBackfill: EmbeddingBackfillState | null,
  limit = TASK_HISTORY_LIMIT,
): TaskHistoryItem[] {
  const seen = new Set<string>()
  const merged: TaskHistoryItem[] = []

  const dreamRuns = dreamState?.recentRuns
  if (dreamRuns && dreamRuns.length > 0) {
    for (const run of dreamRuns) {
      const key = `dream:${run.id}`
      if (seen.has(key)) continue
      seen.add(key)
      const mode = run.mode ?? 'standard'
      merged.push({
        key,
        id: run.id,
        source: 'dream',
        mode,
        title: dreamModeLabels[mode],
        icon: dreamIconFor(mode),
        trigger: run.trigger,
        outcome: run.outcome,
        summary: summarizeDreamRun(run),
        error: run.error,
        errorDetail: resolveDreamErrorDetail(run),
        ...(run.failedItems?.length ? { failedItems: run.failedItems } : {}),
        ...(run.params ? { params: run.params } : {}),
        ...(run.retriedByRunId ? { retriedByRunId: run.retriedByRunId } : {}),
        finishedAt: run.createdAt,
        routeTarget: run.suggested > 0 || isTaskIssueOutcome(run.outcome) ? 'inbox' : null,
      })
    }
  } else if (dreamState?.lastRunAt && dreamState.lastOutcome) {
    const fallback: DreamState['recentRuns'][number] = {
      id: dreamState.lastRunAt,
      trigger: 'manual',
      mode: 'standard',
      outcome: dreamState.lastOutcome,
      considered: 0,
      suggested: 0,
      error: dreamState.lastError,
      createdAt: dreamState.lastRunAt,
    }
    const key = `dream:${fallback.id}`
    if (!seen.has(key)) {
      seen.add(key)
      merged.push({
        key,
        id: fallback.id,
        source: 'dream',
        mode: 'standard',
        title: '记忆整理',
        icon: icons.sparkles,
        trigger: fallback.trigger,
        outcome: fallback.outcome,
        summary:
          fallback.outcome === 'partial'
            ? '部分整理未完成'
            : fallback.outcome === 'ok'
              ? '整理完成'
              : summarizeDreamRun(fallback),
        error: fallback.error,
        errorDetail: resolveDreamErrorDetail(fallback),
        finishedAt: fallback.createdAt,
        routeTarget: isTaskIssueOutcome(fallback.outcome) ? 'inbox' : null,
      })
    }
  }

  const backfillRuns = embeddingBackfill?.recentRuns
  if (backfillRuns && backfillRuns.length > 0) {
    for (const run of backfillRuns) {
      const key = `backfill:${run.id}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push({
        key,
        id: run.id,
        source: 'backfill',
        title: '向量索引补齐',
        icon: icons.database,
        trigger: 'manual',
        outcome: run.outcome,
        summary: summarizeBackfillRun(run),
        error: run.error,
        errorDetail: run.error?.trim() || null,
        finishedAt: run.finishedAt,
        routeTarget: run.outcome === 'failed' ? 'models' : null,
      })
    }
  } else if (embeddingBackfill?.lastFinishedAt && embeddingBackfill.lastOutcome) {
    const fallback: EmbeddingBackfillRunSummary = {
      id: embeddingBackfill.lastFinishedAt,
      outcome: embeddingBackfill.lastOutcome,
      processed: embeddingBackfill.lastUpdatedCount,
      total: embeddingBackfill.lastUpdatedCount,
      updated: embeddingBackfill.lastUpdatedCount,
      model: embeddingBackfill.model,
      error: embeddingBackfill.lastError,
      startedAt: embeddingBackfill.lastFinishedAt,
      finishedAt: embeddingBackfill.lastFinishedAt,
    }
    const key = `backfill:${fallback.id}`
    if (!seen.has(key)) {
      seen.add(key)
      merged.push({
        key,
        id: fallback.id,
        source: 'backfill',
        title: '向量索引补齐',
        icon: icons.database,
        trigger: 'manual',
        outcome: fallback.outcome,
        summary: summarizeBackfillRun(fallback),
        error: fallback.error,
        errorDetail: fallback.error?.trim() || null,
        finishedAt: fallback.finishedAt,
        routeTarget: fallback.outcome === 'failed' ? 'models' : null,
      })
    }
  }

  merged.sort((a, b) => {
    const diff = timestampMs(b.finishedAt) - timestampMs(a.finishedAt)
    if (diff !== 0) return diff
    return b.finishedAt.localeCompare(a.finishedAt)
  })

  return merged.slice(0, limit)
}

export function filterVisibleHistory(
  items: readonly TaskHistoryItem[],
  clearedBefore: string | null,
): TaskHistoryItem[] {
  if (!clearedBefore) return [...items]
  return items.filter((item) => isAfterWatermark(item.finishedAt, clearedBefore))
}

export function countUnreadFailures(
  items: readonly TaskHistoryItem[],
  clearedBefore: string | null,
  ackErrorAt: string | null,
  dismissedKeys?: ReadonlySet<string>,
): number {
  let count = 0
  for (const item of items) {
    if (!isActiveTaskIssue(item, dismissedKeys)) continue
    if (!isAfterWatermark(item.finishedAt, clearedBefore)) continue
    if (!isAfterWatermark(item.finishedAt, ackErrorAt)) continue
    count++
  }
  return count
}

export function latestFailedTimestamp(
  items: readonly TaskHistoryItem[],
  dismissedKeys?: ReadonlySet<string>,
): string | null {
  for (const item of items) {
    if (isActiveTaskIssue(item, dismissedKeys)) return item.finishedAt
  }
  return null
}

// 定位整理页最近一条真实的失败/部分失败记录，跳过因前序上游故障熔断而压在头部的联动取消记录
export function findLatestInboxFailureRun(dreamState: DreamState | null): DreamRunSummary | null {
  if (!dreamState) return null
  if (dreamState.lastOutcome !== 'failed' && dreamState.lastOutcome !== 'partial') return null
  for (const run of dreamState.recentRuns) {
    if (isCascadeAbortedRun(run)) continue
    return isTaskIssueOutcome(run.outcome) ? run : null
  }
  return null
}

export function latestInboxFailureTimestamp(dreamState: DreamState | null): string | null {
  if (!dreamState) return null
  const failureRun = findLatestInboxFailureRun(dreamState)
  return (
    failureRun?.createdAt ?? dreamState.recentRuns[0]?.createdAt ?? dreamState.lastRunAt ?? null
  )
}

export function shouldShowInboxFailureBanner(
  dreamState: DreamState | null,
  dismissedAt: string | null,
  clearedBefore: string | null,
): boolean {
  if (!dreamState || dreamState.running) return false
  if (dreamState.lastOutcome !== 'failed' && dreamState.lastOutcome !== 'partial') return false
  const failureRun = findLatestInboxFailureRun(dreamState)
  if (dreamState.recentRuns.length > 0 && !failureRun) return false
  if (failureRun?.retriedByRunId) return false
  const hasFailedItems = (failureRun?.failedItems?.length ?? 0) > 0
  const hasError = Boolean(failureRun?.error || dreamState.lastError)
  if (!hasFailedItems && !hasError) return false

  const failureAt = latestInboxFailureTimestamp(dreamState)
  if (!failureAt) return true
  if (dismissedAt && !isAfterWatermark(failureAt, dismissedAt)) return false
  if (clearedBefore && !isAfterWatermark(failureAt, clearedBefore)) return false
  return true
}

// 汇总当前全部运行中任务的归一化进度；准备阶段总数未知时返回 null 以便渲染旋转弧
export function computeOverallProgress(
  dreamState: DreamState | null,
  embeddingBackfill: EmbeddingBackfillState | null,
): number | null {
  const fractions: number[] = []
  if (dreamState?.running) {
    const p = dreamState.progress
    if (p && p.total > 0) {
      fractions.push(Math.min(1, Math.max(0, p.processed / p.total)))
    }
  }
  if (embeddingBackfill?.running && embeddingBackfill.total > 0) {
    fractions.push(Math.min(1, Math.max(0, embeddingBackfill.processed / embeddingBackfill.total)))
  }
  if (fractions.length === 0) return null
  const avg = fractions.reduce((acc, value) => acc + value, 0) / fractions.length
  const pct = Math.round(avg * 100)
  return Math.max(5, Math.min(100, pct))
}
