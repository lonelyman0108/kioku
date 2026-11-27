import type {
  DreamMode,
  DreamOutcome,
  DreamState,
  EmbeddingBackfillRunSummary,
  EmbeddingBackfillState,
} from '@kioku/contracts'

import { icons } from './icons'
import { dreamModeLabels } from './labels'

export const TASK_HISTORY_LIMIT = 20

export type TaskSource = 'dream' | 'backfill'

export interface TaskHistoryItem {
  key: string
  id: string
  source: TaskSource
  title: string
  icon: string
  trigger: 'manual' | 'scheduled'
  outcome: DreamOutcome
  summary: string
  error: string | null
  finishedAt: string
  routeTarget: 'inbox' | 'models' | null
}

function dreamIconFor(mode: DreamMode | undefined): string {
  if (mode === 'tidy') return icons.tidy
  if (mode === 'cross_memory') return icons.links
  return icons.sparkles
}

function summarizeDreamRun(run: DreamState['recentRuns'][number]): string {
  if (run.outcome === 'failed') {
    return run.error?.trim() || '执行过程中遇到错误'
  }
  if (run.outcome === 'cancelled') {
    if (run.suggested > 0) return `已取消 · 已保留 ${run.suggested} 条待处理建议`
    return run.abortedReason?.trim() || '已手动取消'
  }
  if (run.outcome === 'skipped') {
    return '当前无可整理项'
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

  for (const run of dreamState?.recentRuns ?? []) {
    const key = `dream:${run.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const mode = run.mode ?? 'standard'
    merged.push({
      key,
      id: run.id,
      source: 'dream',
      title: dreamModeLabels[mode],
      icon: dreamIconFor(mode),
      trigger: run.trigger,
      outcome: run.outcome,
      summary: summarizeDreamRun(run),
      error: run.error,
      finishedAt: run.createdAt,
      routeTarget:
        run.suggested > 0 || run.outcome === 'failed' || run.outcome === 'partial' ? 'inbox' : null,
    })
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
): number {
  let count = 0
  for (const item of items) {
    if (item.outcome !== 'failed') continue
    if (!isAfterWatermark(item.finishedAt, clearedBefore)) continue
    if (!isAfterWatermark(item.finishedAt, ackErrorAt)) continue
    count++
  }
  return count
}

export function latestFailedTimestamp(items: readonly TaskHistoryItem[]): string | null {
  for (const item of items) {
    if (item.outcome === 'failed') return item.finishedAt
  }
  return null
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
