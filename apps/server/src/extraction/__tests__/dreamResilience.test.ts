import { SingleCrossCheckResponse } from '@kioku/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Db } from '../../db/client'
import { dreamSuggestions, entries, entryLinks } from '../../db/schema'
import { ModelClientError } from '../../models/client'

const { mockLoadResolvedModel, mockRecordDreamRun, mockChatComplete, mockDatabaseNow } = vi.hoisted(
  () => ({
    mockLoadResolvedModel: vi.fn(),
    mockRecordDreamRun: vi.fn(),
    mockChatComplete: vi.fn(),
    mockDatabaseNow: vi.fn(),
  }),
)

vi.mock('../../models/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../models/store')>()
  return {
    ...actual,
    loadResolvedModel: mockLoadResolvedModel,
    recordDreamRun: mockRecordDreamRun,
  }
})

vi.mock('../../models/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../models/client')>()
  return {
    ...actual,
    chatComplete: mockChatComplete,
  }
})

vi.mock('../../db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/client')>()
  return {
    ...actual,
    databaseNow: mockDatabaseNow,
  }
})

import { runSingleCrossCheck } from '../crossMemory'
import { runDream } from '../dream'

type EntryRow = typeof entries.$inferSelect

function makeEntryRow(overrides: Partial<EntryRow> & Pick<EntryRow, 'id' | 'shortId'>): EntryRow {
  const now = new Date('2026-11-27T00:00:00.000Z')
  return {
    kind: 'entry',
    title: '测试记忆',
    summary: '简短概要',
    content: '这是用于验证单条查重容错逻辑的正文内容。',
    disclosure: null,
    isPinned: false,
    bootMode: 'none',
    envs: [],
    realms: ['work'],
    projects: ['kioku'],
    runtimes: [],
    topics: ['architecture', 'testing'],
    searchTags: '',
    validTo: null,
    verifiedAt: null,
    lastChangeSummary: null,
    version: 2,
    dreamCheckedVersion: 0,
    deviceKey: null,
    projectSlug: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    fts: null,
    ...overrides,
  }
}

function makeFakeCrossCheckDb(target: EntryRow, neighbor: EntryRow): Db {
  let entryQueryIndex = 0
  const select = () => ({
    from: (table: unknown) => {
      if (table === entries) {
        const idx = entryQueryIndex++
        if (idx === 0) {
          return {
            where: () => ({
              limit: () => Promise.resolve([target]),
            }),
          }
        }
        return {
          where: () => ({
            orderBy: () => Promise.resolve([target, neighbor]),
          }),
        }
      }
      if (table === entryLinks) {
        return {
          where: () => Promise.resolve([]),
        }
      }
      if (table === dreamSuggestions) {
        const result = Promise.resolve([])
        return Object.assign(result, {
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        })
      }
      return Promise.resolve([])
    },
  })

  return {
    select,
    execute: () => Promise.resolve([{ entry_a: target.id, entry_b: neighbor.id, sim: 0.9 }]),
  } as unknown as Db
}

describe('整理容错落库与单条查重部分失败告警', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loadResolvedModel 抛错时 runDream 仍通过 recordDreamRun 落库失败状态', async () => {
    mockLoadResolvedModel.mockRejectedValueOnce(new Error('无法解密已保存的对话模型密钥'))
    mockRecordDreamRun.mockResolvedValueOnce(undefined)

    const result = await runDream({} as Db, null, {
      runId: 'dream-load-err',
      trigger: 'manual',
      mode: 'tidy',
    })

    expect(result).toEqual({
      mode: 'tidy',
      outcome: 'failed',
      considered: 0,
      suggested: 0,
      error: '无法解密已保存的对话模型密钥',
      failedItems: [],
      retriedCount: 0,
      abortedReason: null,
    })
    expect(mockRecordDreamRun).toHaveBeenCalledTimes(1)
    expect(mockRecordDreamRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'dream-load-err',
        trigger: 'manual',
        mode: 'tidy',
        outcome: 'failed',
        error: '无法解密已保存的对话模型密钥',
      }),
    )
  })

  it('runSingleCrossCheck 在部分子任务截断失败时返回去重 warnings，全部成功时不附带 warnings', async () => {
    const target = makeEntryRow({
      id: '11111111-1111-4111-8111-111111111111',
      shortId: 'm-234aaa',
      title: '前端构建规范',
    })
    const neighbor = makeEntryRow({
      id: '22222222-2222-4222-8222-222222222222',
      shortId: 'm-234bbb',
      title: '前端构建与发布说明',
    })

    mockDatabaseNow.mockResolvedValue(new Date('2026-11-27T01:00:00.000Z'))
    mockLoadResolvedModel.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:18999/v1',
      model: 'test-chat',
      apiKey: null,
    })

    // 簇审阅失败（写入 2 条同因失败明细），双链巡检成功，整体为 partial 且 warnings 去重
    mockChatComplete
      .mockRejectedValueOnce(
        new ModelClientError('对话模型输出达到长度上限被截断', {
          category: 'length_limit',
          retryable: false,
        }),
      )
      .mockResolvedValueOnce({
        content: JSON.stringify({ suggestions: [] }),
        promptTokens: 100,
        completionTokens: 20,
      })

    const partialRes = await runSingleCrossCheck(
      makeFakeCrossCheckDb(target, neighbor),
      null,
      target.shortId,
    )
    const parsedPartial = SingleCrossCheckResponse.parse(partialRes)
    expect(parsedPartial.consideredNeighbors).toBe(1)
    expect(parsedPartial.warnings).toEqual(['对话模型输出达到长度上限被截断'])

    mockChatComplete
      .mockResolvedValueOnce({
        content: JSON.stringify({ suggestions: [] }),
        promptTokens: 100,
        completionTokens: 20,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ suggestions: [] }),
        promptTokens: 80,
        completionTokens: 15,
      })

    const okRes = await runSingleCrossCheck(
      makeFakeCrossCheckDb(target, neighbor),
      null,
      target.shortId,
    )
    const parsedOk = SingleCrossCheckResponse.parse(okRes)
    expect(parsedOk.warnings).toBeUndefined()
  })
})
