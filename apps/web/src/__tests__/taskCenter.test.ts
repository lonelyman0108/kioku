import type { DreamState, EmbeddingBackfillState } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  computeOverallProgress,
  countUnreadFailures,
  filterVisibleHistory,
  latestFailedTimestamp,
  mergeTaskHistory,
  TASK_HISTORY_LIMIT,
} from '../taskCenter'

function makeDreamState(overrides: Partial<DreamState> = {}): DreamState {
  return {
    enabled: false,
    intervalHours: 24,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    running: false,
    progress: null,
    recentRuns: [],
    ...overrides,
  }
}

function makeBackfillState(
  overrides: Partial<EmbeddingBackfillState> = {},
): EmbeddingBackfillState {
  return {
    running: false,
    processed: 0,
    total: 0,
    model: null,
    lastFinishedAt: null,
    lastOutcome: null,
    lastUpdatedCount: 0,
    lastError: null,
    recentRuns: [],
    ...overrides,
  }
}

describe('taskCenter', () => {
  it('合并整理与向量补齐记录、按完成时间倒序并截断到 20 条', () => {
    const dreamRuns = Array.from({ length: 15 }, (_, idx) => ({
      id: `d-${idx}`,
      trigger: 'manual' as const,
      mode: 'standard' as const,
      outcome: 'ok' as const,
      considered: 10,
      suggested: idx % 3,
      error: null,
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, idx)).toISOString(),
    }))
    const backfillRuns = Array.from({ length: 10 }, (_, idx) => ({
      id: `b-${idx}`,
      outcome: 'ok' as const,
      processed: 5,
      total: 5,
      updated: 5,
      model: 'bge-m3',
      error: null,
      startedAt: new Date(Date.UTC(2026, 10, 1, 1, idx)).toISOString(),
      finishedAt: new Date(Date.UTC(2026, 10, 1, 1, idx, 10)).toISOString(),
    }))

    const merged = mergeTaskHistory(
      makeDreamState({ recentRuns: dreamRuns }),
      makeBackfillState({ recentRuns: backfillRuns }),
    )

    expect(merged).toHaveLength(TASK_HISTORY_LIMIT)
    expect(merged[0]?.key).toBe('backfill:b-9')
    expect(merged[9]?.key).toBe('backfill:b-0')
    expect(merged[10]?.key).toBe('dream:d-14')
  })

  it('清除已完成水位线会过滤早于或等于该时刻的记录，保留之后的新任务', () => {
    const t1 = '2026-11-27T01:00:00.000Z'
    const t2 = '2026-11-27T02:00:00.000Z'
    const t3 = '2026-11-27T03:00:00.000Z'
    const merged = mergeTaskHistory(
      makeDreamState({
        recentRuns: [
          {
            id: 'r3',
            trigger: 'manual',
            mode: 'tidy',
            outcome: 'ok',
            considered: 4,
            suggested: 2,
            error: null,
            createdAt: t3,
          },
          {
            id: 'r2',
            trigger: 'manual',
            mode: 'cross_memory',
            outcome: 'failed',
            considered: 2,
            suggested: 0,
            error: '模型超时',
            createdAt: t2,
          },
          {
            id: 'r1',
            trigger: 'scheduled',
            mode: 'standard',
            outcome: 'skipped',
            considered: 0,
            suggested: 0,
            error: null,
            createdAt: t1,
          },
        ],
      }),
      null,
    )

    expect(filterVisibleHistory(merged, t2).map((item) => item.id)).toEqual(['r3'])
    expect(countUnreadFailures(merged, null, null)).toBe(1)
    expect(countUnreadFailures(merged, null, t2)).toBe(0)
    expect(countUnreadFailures(merged, t2, null)).toBe(0)
    expect(latestFailedTimestamp(merged)).toBe(t2)
  })

  it('未读失败计数仅统计晚于确认水位线的失败任务，且不受运行中状态影响', () => {
    const tFail1 = '2026-11-27T01:00:00.000Z'
    const tFail2 = '2026-11-27T02:00:00.000Z'
    const merged = mergeTaskHistory(
      makeDreamState({
        recentRuns: [
          {
            id: 'd-fail',
            trigger: 'manual',
            mode: 'tidy',
            outcome: 'failed',
            considered: 1,
            suggested: 0,
            error: '502',
            createdAt: tFail1,
          },
        ],
      }),
      makeBackfillState({
        recentRuns: [
          {
            id: 'b-fail',
            outcome: 'failed',
            processed: 2,
            total: 10,
            updated: 2,
            model: 'bge-m3',
            error: '429',
            startedAt: tFail2,
            finishedAt: tFail2,
          },
        ],
      }),
    )

    expect(countUnreadFailures(merged, null, null)).toBe(2)
    expect(countUnreadFailures(merged, null, tFail1)).toBe(1)
    expect(countUnreadFailures(merged, null, tFail2)).toBe(0)
  })

  it('汇总当前运行中任务的归一化进度', () => {
    expect(computeOverallProgress(makeDreamState(), makeBackfillState())).toBeNull()
    expect(
      computeOverallProgress(
        makeDreamState({
          running: true,
          progress: { mode: 'tidy', processed: 0, total: 0, suggested: 0, failed: 0 },
        }),
        makeBackfillState(),
      ),
    ).toBeNull()
    expect(
      computeOverallProgress(
        makeDreamState({
          running: true,
          progress: { mode: 'tidy', processed: 4, total: 10, suggested: 2, failed: 0 },
        }),
        makeBackfillState({ running: true, processed: 8, total: 10 }),
      ),
    ).toBe(60)
  })
})
