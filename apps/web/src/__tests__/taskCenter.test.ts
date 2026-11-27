import type { DreamState, EmbeddingBackfillState } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  computeOverallProgress,
  countUnreadFailures,
  filterVisibleHistory,
  isTaskIssueOutcome,
  latestFailedTimestamp,
  latestInboxFailureTimestamp,
  mergeTaskHistory,
  shouldShowInboxFailureBanner,
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

  it('损坏的水位线字符串会被忽略，损坏的条目时间不会误判为更新记录', () => {
    const t1 = '2026-11-27T01:00:00.000Z'
    const merged = mergeTaskHistory(
      makeDreamState({
        recentRuns: [
          {
            id: 'ok-1',
            trigger: 'manual',
            mode: 'tidy',
            outcome: 'failed',
            considered: 1,
            suggested: 0,
            error: 'timeout',
            createdAt: t1,
          },
          {
            id: 'bad-ts',
            trigger: 'manual',
            mode: 'tidy',
            outcome: 'failed',
            considered: 1,
            suggested: 0,
            error: 'bad',
            createdAt: 'not-a-timestamp',
          },
        ],
      }),
      null,
    )

    expect(filterVisibleHistory(merged, 'invalid-watermark').map((i) => i.id)).toEqual([
      'ok-1',
      'bad-ts',
    ])
    expect(filterVisibleHistory(merged, t1)).toEqual([])
    expect(countUnreadFailures(merged, null, 'invalid-watermark')).toBe(2)
    expect(countUnreadFailures(merged, null, t1)).toBe(0)
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

  it('partial 异常纳入未读角标计数与最新异常时间，同时保留计数摘要并透出错误原因', () => {
    const tPartial1 = '2026-11-27T01:00:00.000Z'
    const tPartial2 = '2026-11-27T02:00:00.000Z'
    const tPartial3 = '2026-11-27T03:00:00.000Z'

    expect(isTaskIssueOutcome('failed')).toBe(true)
    expect(isTaskIssueOutcome('partial')).toBe(true)
    expect(isTaskIssueOutcome('ok')).toBe(false)
    expect(isTaskIssueOutcome('skipped')).toBe(false)

    const merged = mergeTaskHistory(
      makeDreamState({
        recentRuns: [
          {
            id: 'p-3',
            trigger: 'manual',
            mode: 'cross_memory',
            outcome: 'partial',
            considered: 6,
            suggested: 1,
            error: null,
            abortedReason: '连续触发上游限流，提前停止',
            createdAt: tPartial3,
          },
          {
            id: 'p-2',
            trigger: 'manual',
            mode: 'tidy',
            outcome: 'partial',
            considered: 5,
            suggested: 2,
            error: null,
            failedItems: [
              {
                shortId: 'm-234abc',
                title: '测试词条',
                kind: 'tidy',
                reason: '对话模型输出达到长度上限被截断',
              },
            ],
            createdAt: tPartial2,
          },
          {
            id: 'p-1',
            trigger: 'scheduled',
            mode: 'standard',
            outcome: 'partial',
            considered: 4,
            suggested: 0,
            error: '本批 4 条中 2 条失败：m-234xyz（对话模型输出达到长度上限被截断）',
            failedItems: [
              {
                shortId: 'm-234xyz',
                title: '长记忆',
                kind: 'standard',
                reason: '对话模型输出达到长度上限被截断',
              },
            ],
            createdAt: tPartial1,
          },
        ],
      }),
      null,
    )

    expect(countUnreadFailures(merged, null, null)).toBe(3)
    expect(countUnreadFailures(merged, null, tPartial2)).toBe(1)
    expect(countUnreadFailures(merged, null, tPartial3)).toBe(0)
    expect(latestFailedTimestamp(merged)).toBe(tPartial3)

    const item1 = merged.find((item) => item.id === 'p-1')
    expect(item1?.summary).toBe('无新增建议 · 核查 4 条 · 失败 1 条')
    expect(item1?.errorDetail).toBe(
      '本批 4 条中 2 条失败：m-234xyz（对话模型输出达到长度上限被截断）',
    )

    const item2 = merged.find((item) => item.id === 'p-2')
    expect(item2?.summary).toBe('新增 2 条建议 · 核查 5 条 · 失败 1 条')
    expect(item2?.errorDetail).toBe('m-234abc：对话模型输出达到长度上限被截断')

    const item3 = merged.find((item) => item.id === 'p-3')
    expect(item3?.summary).toBe('新增 1 条建议 · 核查 6 条')
    expect(item3?.errorDetail).toBe('连续触发上游限流，提前停止')
  })

  it('dreamState 无 recentRuns 但存在 lastRunAt 与 lastOutcome 时合成兜底记录', () => {
    const tFail = '2026-11-27T04:00:00.000Z'
    const failedMerged = mergeTaskHistory(
      makeDreamState({
        lastRunAt: tFail,
        lastOutcome: 'failed',
        lastError: '无法解密模型密钥',
        recentRuns: [],
      }),
      null,
    )
    expect(failedMerged).toHaveLength(1)
    expect(failedMerged[0]).toMatchObject({
      source: 'dream',
      outcome: 'failed',
      summary: '无法解密模型密钥',
      errorDetail: '无法解密模型密钥',
      finishedAt: tFail,
      routeTarget: 'inbox',
    })
    expect(countUnreadFailures(failedMerged, null, null)).toBe(1)

    const partialMerged = mergeTaskHistory(
      makeDreamState({
        lastRunAt: tFail,
        lastOutcome: 'partial',
        lastError: '对话模型输出达到长度上限被截断',
        recentRuns: [],
      }),
      null,
    )
    expect(partialMerged).toHaveLength(1)
    expect(partialMerged[0]).toMatchObject({
      outcome: 'partial',
      summary: '部分整理未完成',
      errorDetail: '对话模型输出达到长度上限被截断',
      routeTarget: 'inbox',
    })
    expect(countUnreadFailures(partialMerged, null, null)).toBe(1)
  })

  it('待处理失败横幅支持按关闭水位与任务清空水位隐藏、排除 skipped，并在新失败时重新展示', () => {
    const t1 = '2026-11-27T01:00:00.000Z'
    const t2 = '2026-11-27T02:00:00.000Z'

    const skippedState = makeDreamState({
      lastRunAt: t1,
      lastOutcome: 'skipped',
      lastError: '未配置对话模型',
      recentRuns: [
        {
          id: 'skip-1',
          trigger: 'manual',
          mode: 'standard',
          outcome: 'skipped',
          considered: 0,
          suggested: 0,
          error: '未配置对话模型',
          createdAt: t1,
        },
      ],
    })
    expect(shouldShowInboxFailureBanner(skippedState, null, null)).toBe(false)

    const partialState = makeDreamState({
      lastRunAt: t1,
      lastOutcome: 'partial',
      lastError: '对话模型输出达到长度上限被截断',
      recentRuns: [
        {
          id: 'fail-1',
          trigger: 'manual',
          mode: 'tidy',
          outcome: 'partial',
          considered: 3,
          suggested: 1,
          error: '对话模型输出达到长度上限被截断',
          failedItems: [
            {
              shortId: 'm-234abc',
              title: '示例记忆',
              kind: 'tidy',
              reason: '对话模型输出达到长度上限被截断',
            },
          ],
          createdAt: t1,
        },
      ],
    })
    expect(latestInboxFailureTimestamp(partialState)).toBe(t1)
    expect(shouldShowInboxFailureBanner(partialState, null, null)).toBe(true)
    expect(shouldShowInboxFailureBanner({ ...partialState, running: true }, null, null)).toBe(false)
    expect(shouldShowInboxFailureBanner(partialState, t1, null)).toBe(false)
    expect(shouldShowInboxFailureBanner(partialState, null, t1)).toBe(false)

    const newerFailState = makeDreamState({
      lastRunAt: t2,
      lastOutcome: 'failed',
      lastError: '请求超时',
      recentRuns: [
        {
          id: 'fail-2',
          trigger: 'manual',
          mode: 'tidy',
          outcome: 'failed',
          considered: 1,
          suggested: 0,
          error: '请求超时',
          createdAt: t2,
        },
      ],
    })
    expect(shouldShowInboxFailureBanner(newerFailState, t1, t1)).toBe(true)
    expect(shouldShowInboxFailureBanner(newerFailState, t2, t1)).toBe(false)
  })
})
