import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelClientError } from '../../models/client'
import * as modelStore from '../../models/store'
import {
  computeCrossMemoryTaskMaxTokens,
  runClusterTaskWithTopTwoFallback,
  selectTopTwoClusterRows,
} from '../crossMemory'
import {
  BatchResilienceGuard,
  buildStandardDreamMessages,
  CHANGED_PER_CALL,
  computeDynamicOutputTokens,
  executeStandardBatchWithSplit,
  packStandardDreamPromptItems,
  STANDARD_CHANGED_CHAR_BUDGET,
  STANDARD_MAX_SUGGESTIONS_PER_CALL,
  STANDARD_NEIGHBOR_CHAR_BUDGET,
  STANDARD_TOTAL_CHAR_BUDGET,
} from '../dream'
import { extractEpisodeBatch } from '../extract'
import { computeSingleTidyMaxTokens, previewSingleTidy } from '../singleTidy'

function makePromptSourceRow(
  id: string,
  shortId: string,
  overrides: {
    title?: string
    summary?: string | null
    content?: string
    disclosure?: string | null
  } = {},
) {
  return {
    id,
    shortId,
    kind: 'entry' as const,
    title: overrides.title ?? `词条 ${shortId}`,
    summary: overrides.summary ?? null,
    content: overrides.content ?? '常规记忆正文。',
    disclosure: overrides.disclosure ?? null,
    bootMode: 'none' as const,
    deviceKey: null as string | null,
    envs: [] as string[],
    realms: [] as string[],
    projects: [] as string[],
    runtimes: [] as string[],
    topics: [] as string[],
    version: 1,
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  }
}

async function startCaptureStub(
  handler: (body: Record<string, unknown>, callIndex: number) => string,
): Promise<{
  baseUrl: string
  seenBodies: Record<string, unknown>[]
  close: () => Promise<void>
}> {
  const seenBodies: Record<string, unknown>[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const idx = seenBodies.length
      seenBodies.push(body)
      const content = handler(body, idx)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seenBodies,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}

describe('动态输出预算、增量分批与降级保护', () => {
  const closers: (() => Promise<void>)[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    while (closers.length) {
      await closers.pop()!()
    }
  })

  it('computeDynamicOutputTokens 按正文字符规模平滑缩放并严格落在上下限内', () => {
    expect(computeDynamicOutputTokens(0, { min: 6_000, max: 16_384, overhead: 2_000 })).toBe(6_000)
    expect(computeDynamicOutputTokens(-500, { min: 6_000, max: 16_384 })).toBe(6_000)
    expect(computeDynamicOutputTokens(Number.NaN, { min: 6_000, max: 16_384 })).toBe(6_000)
    expect(computeDynamicOutputTokens(3_000, { min: 6_000, max: 16_384, overhead: 2_000 })).toBe(
      6_800,
    )
    expect(computeDynamicOutputTokens(5_000, { min: 6_000, max: 16_384, overhead: 2_000 })).toBe(
      10_000,
    )
    expect(computeDynamicOutputTokens(12_000, { min: 6_000, max: 16_384, overhead: 2_000 })).toBe(
      16_384,
    )

    expect(computeSingleTidyMaxTokens(800)).toBe(6_000)
    expect(computeSingleTidyMaxTokens(5_000)).toBe(10_000)
    expect(computeSingleTidyMaxTokens(10_000)).toBe(16_384)
  })

  it('dream standard 收缩单批条数并将邻居纳入总输入字符预算，超预算时优先降级为紧凑概要/摘录', () => {
    expect(CHANGED_PER_CALL).toBe(8)
    expect(STANDARD_CHANGED_CHAR_BUDGET).toBe(12_000)
    expect(STANDARD_NEIGHBOR_CHAR_BUDGET).toBe(8_000)
    expect(STANDARD_TOTAL_CHAR_BUDGET).toBe(20_000)

    const longBody = '部署架构与端口规则说明，需保留关键约定。'.repeat(80)
    expect(longBody.length).toBeGreaterThan(1_500)

    const changedRows = Array.from({ length: 6 }, (_, i) =>
      makePromptSourceRow(`c-${i}`, `m-c0000${i}`, {
        title: `变更词条 ${i}`,
        content: longBody,
      }),
    )
    const neighborRows = Array.from({ length: 15 }, (_, i) =>
      makePromptSourceRow(`n-${i}`, `m-n0000${i}`, {
        title: `邻居词条 ${i}`,
        summary: i % 2 === 0 ? `第 ${i} 条邻居现行概要结论。` : null,
        content: longBody,
      }),
    )

    const packed = packStandardDreamPromptItems(changedRows, neighborRows)
    expect(packed.promptChanged).toHaveLength(6)
    expect(packed.neighborChars).toBeLessThanOrEqual(STANDARD_NEIGHBOR_CHAR_BUDGET)
    expect(packed.changedChars + packed.neighborChars).toBeLessThanOrEqual(
      STANDARD_TOTAL_CHAR_BUDGET,
    )
    // 前几条完整保留，放不下完整摘录的邻居自动退为紧凑版，且绝不无上限塞满 15 条完整正文
    expect(packed.compactNeighborCount).toBeGreaterThan(0)
    expect(packed.promptNeighbors.length).toBeLessThan(15)
    const compactWithSummary = packed.promptNeighbors.find(
      (item) => item.truncated && item.content === '' && Boolean(item.summary),
    )
    expect(compactWithSummary).toBeDefined()
    const compactExcerptOnly = packed.promptNeighbors.find(
      (item) => item.truncated && item.content.length > 0 && item.content.length <= 240,
    )
    expect(compactExcerptOnly).toBeDefined()

    // 无 summary 且原文虽 <=240 字但含多行空白被 inlineText 折叠时，紧凑邻居也应标记 truncated: true
    const multilinePacked = packStandardDreamPromptItems(
      changedRows.slice(0, 1),
      [
        makePromptSourceRow('n-ml', 'm-nml001', {
          title: '短多行邻居',
          summary: null,
          content: '第一行内容\n\n        \n\n第二行内容',
        }),
      ],
      { neighborBudget: 140 },
    )
    expect(multilinePacked.promptNeighbors).toHaveLength(1)
    expect(multilinePacked.compactNeighborCount).toBe(1)
    expect(multilinePacked.promptNeighbors[0]?.content).toBe('第一行内容 第二行内容')
    expect(multilinePacked.promptNeighbors[0]?.truncated).toBe(true)

    const messages = buildStandardDreamMessages(packed.promptChanged, packed.promptNeighbors)
    expect(messages).toHaveLength(2)
    expect(messages[1]?.content).toContain(`最多输出 ${STANDARD_MAX_SUGGESTIONS_PER_CALL} 条`)
  })

  it('dream standard 命中 length_limit 或 context_length 时自动二分拆批，仅隔离真正失败的单条', async () => {
    const items = ['m-234aa1', 'm-234aa2', 'm-234aa3', 'm-234aa4']
    const attempted: string[][] = []
    const succeeded: string[] = []
    const failed: { batch: string[]; reason: string }[] = []
    let splitCount = 0
    const guard = new BatchResilienceGuard(10)

    await executeStandardBatchWithSplit(
      items,
      async (subBatch) => {
        attempted.push([...subBatch])
        if (subBatch.includes('m-234aa3')) {
          throw new ModelClientError('对话模型输出达到长度上限被截断', {
            category: 'length_limit',
            retryable: false,
          })
        }
        succeeded.push(...subBatch)
      },
      {
        guard,
        onSplit: () => {
          splitCount++
        },
        onFailure: (subBatch, err) => {
          failed.push({
            batch: [...subBatch],
            reason: err instanceof Error ? err.message : String(err),
          })
        },
      },
    )

    expect(splitCount).toBe(2)
    expect(attempted).toEqual([
      ['m-234aa1', 'm-234aa2', 'm-234aa3', 'm-234aa4'],
      ['m-234aa1', 'm-234aa2'],
      ['m-234aa3', 'm-234aa4'],
      ['m-234aa3'],
      ['m-234aa4'],
    ])
    expect(succeeded).toEqual(['m-234aa1', 'm-234aa2', 'm-234aa4'])
    expect(failed).toHaveLength(1)
    expect(failed[0]?.batch).toEqual(['m-234aa3'])

    // context_length 拆半后若左右两半均成功，则整批零失败
    const ctxSucceeded: string[] = []
    const ctxFailed: string[][] = []
    await executeStandardBatchWithSplit(
      items,
      async (subBatch) => {
        if (subBatch.length > 2) {
          throw new ModelClientError('上下文超长', {
            category: 'context_length',
            retryable: false,
          })
        }
        ctxSucceeded.push(...subBatch)
      },
      {
        guard: new BatchResilienceGuard(10),
        onFailure: (subBatch) => ctxFailed.push([...subBatch]),
      },
    )
    expect(ctxSucceeded).toEqual(items)
    expect(ctxFailed).toEqual([])

    // 非长度类错误（如 401 鉴权错）不拆批并直接触发熔断
    const authGuard = new BatchResilienceGuard(10)
    let authCalls = 0
    const authFailed: string[][] = []
    await executeStandardBatchWithSplit(
      items,
      async () => {
        authCalls++
        throw new ModelClientError('unauthorized', { category: 'auth', retryable: false })
      },
      {
        guard: authGuard,
        onFailure: (subBatch) => authFailed.push([...subBatch]),
      },
    )
    expect(authCalls).toBe(1)
    expect(authGuard.isAborted).toBe(true)
    expect(authFailed).toEqual([items])

    // 拆批中途外部中止时不再继续执行右半批
    const controller = new AbortController()
    const abortAttempted: string[][] = []
    const abortFailed: string[][] = []
    await executeStandardBatchWithSplit(
      items,
      async (subBatch) => {
        abortAttempted.push([...subBatch])
        if (subBatch.length === 4) {
          throw new ModelClientError('truncated', { category: 'length_limit', retryable: false })
        }
        controller.abort()
      },
      {
        guard: new BatchResilienceGuard(10),
        signal: controller.signal,
        onFailure: (subBatch) => abortFailed.push([...subBatch]),
      },
    )
    expect(abortAttempted).toEqual([items, ['m-234aa1', 'm-234aa2']])
    expect(abortFailed).toEqual([])
  })

  it('crossMemory 动态预算与 3-4 条 cluster 截断自动降级 Top-2 最高相似对', async () => {
    expect(computeCrossMemoryTaskMaxTokens('links')).toBe(2_500)
    expect(computeCrossMemoryTaskMaxTokens('boot_trim')).toBe(3_000)
    expect(computeCrossMemoryTaskMaxTokens('cluster', 1_000)).toBe(6_000)
    expect(computeCrossMemoryTaskMaxTokens('cluster', 5_000)).toBe(10_000)
    expect(computeCrossMemoryTaskMaxTokens('cluster', 12_000)).toBe(16_384)
    expect(computeCrossMemoryTaskMaxTokens('episode', 4_000)).toBe(8_400)
    expect(computeCrossMemoryTaskMaxTokens('episode', 12_000)).toBe(16_384)

    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    const edges = [
      { a: 'a', b: 'b', score: 0.86 },
      { a: 'b', b: 'd', score: 0.96 },
      { a: 'a', b: 'c', score: 0.88 },
    ]
    expect(selectTopTwoClusterRows(rows, edges).map((r) => r.id)).toEqual(['b', 'd'])
    expect(selectTopTwoClusterRows(rows, []).map((r) => r.id)).toEqual(['a', 'b'])

    // 4 条 cluster 命中 length_limit -> 自动降级取最高相似对 [b, d] 重试一次并成功
    const seenClusters: string[][] = []
    let fallbackPicked: string[] = []
    const okResult = await runClusterTaskWithTopTwoFallback(
      rows,
      edges,
      async (clusterRows) => {
        seenClusters.push(clusterRows.map((r) => r.id))
        if (clusterRows.length > 2) {
          throw new ModelClientError('truncated', { category: 'length_limit', retryable: false })
        }
        return { merged: clusterRows.map((r) => r.id) }
      },
      {
        onFallback: (topTwo) => {
          fallbackPicked = topTwo.map((r) => r.id)
        },
      },
    )
    expect(seenClusters).toEqual([
      ['a', 'b', 'c', 'd'],
      ['b', 'd'],
    ])
    expect(fallbackPicked).toEqual(['b', 'd'])
    expect(okResult).toEqual({ merged: ['b', 'd'] })

    // 仅 2 条时不降级直接抛错
    let pairCalls = 0
    await expect(
      runClusterTaskWithTopTwoFallback(rows.slice(0, 2), edges, async () => {
        pairCalls++
        throw new ModelClientError('truncated', { category: 'length_limit', retryable: false })
      }),
    ).rejects.toMatchObject({ category: 'length_limit' })
    expect(pairCalls).toBe(1)

    // 外部 signal 已中止时不触发降级重试
    const controller = new AbortController()
    let abortedCalls = 0
    await expect(
      runClusterTaskWithTopTwoFallback(
        rows,
        edges,
        async () => {
          abortedCalls++
          controller.abort()
          throw new ModelClientError('truncated', { category: 'length_limit', retryable: false })
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ category: 'length_limit' })
    expect(abortedCalls).toBe(1)
  })

  it('extractEpisodeBatch 使用 maxTokens=1800 且启用流式，singleTidy 按正文长度动态设置 maxTokens', async () => {
    const extractStub = await startCaptureStub((_body, idx) => {
      if (idx === 0) return 'not-json-trigger-repair'
      return JSON.stringify({ title: '缓存配置结论', summary: '统一由连接池管理超时时间。' })
    })
    closers.push(extractStub.close)

    vi.spyOn(modelStore, 'loadResolvedModel').mockResolvedValue({
      baseUrl: extractStub.baseUrl,
      model: 'test-chat',
      apiKey: null,
      enabled: true,
      reasoningEffort: 'off',
      taskReasoningEffort: { fast: 'off', organize: 'off' },
    })

    // 构造极简链式假数据库，验证 extractEpisodeBatch 透传给 chatComplete 的参数
    let selectCall = 0
    const fakeExtractDb = {
      select: () => ({
        from: () => ({
          where: () => {
            selectCall++
            if (selectCall === 1) {
              return {
                orderBy: async () => [
                  {
                    id: 1,
                    keyId: 'k-1',
                    sessionId: 's-1',
                    deviceKey: 'mac-dev',
                    projectSlug: 'kioku',
                    userText: '如何设置连接池？',
                    replyText: '在配置中统一指定超时参数。',
                    createdAt: new Date('2026-10-01T00:00:00.000Z'),
                  },
                ],
              }
            }
            return {
              limit: async () => [{ name: 'Mac Dev', envs: ['mac'], allowedRealms: ['work'] }],
            }
          },
        }),
      }),
      delete: () => ({
        where: async () => undefined,
      }),
    }
    const fakeEntryService = {
      writeEpisode: async () => ({ shortId: 'm-ep1234' }),
    }

    const extractOutcome = await extractEpisodeBatch(
      fakeExtractDb as never,
      null,
      fakeEntryService as never,
      { deviceKey: 'mac-dev', projectSlug: 'kioku' },
    )
    expect(extractOutcome.createdShortId).toBe('m-ep1234')
    expect(extractStub.seenBodies).toHaveLength(2)
    expect(extractStub.seenBodies[0]?.max_tokens).toBe(1_800)
    expect(extractStub.seenBodies[0]?.stream).toBe(true)
    expect(extractStub.seenBodies[1]?.max_tokens).toBe(1_800)
    expect(extractStub.seenBodies[1]?.stream).toBe(true)

    // 验证 previewSingleTidy 按正文长度动态设置 maxTokens（5000 字 -> 10000 token）
    const longContent = '规范正文段落说明内容，保留关键约束。'.repeat(280)
    expect(longContent.length).toBeGreaterThan(4_500)
    const expectedTidyTokens = computeSingleTidyMaxTokens(longContent.length)
    expect(expectedTidyTokens).toBeGreaterThan(6_000)

    const tidyStub = await startCaptureStub((_body, idx) => {
      if (idx === 0) return '{broken-json'
      return JSON.stringify({ needed: false })
    })
    closers.push(tidyStub.close)

    vi.spyOn(modelStore, 'loadResolvedModel').mockResolvedValue({
      baseUrl: tidyStub.baseUrl,
      model: 'test-chat',
      apiKey: null,
      enabled: true,
      reasoningEffort: 'off',
      taskReasoningEffort: { fast: 'off', organize: 'off' },
    })

    const targetRow = makePromptSourceRow('entry-1', 'm-234abc', {
      title: '长文档记忆',
      content: longContent,
    })
    let tidySelectCall = 0
    const fakeTidyDb = {
      select: () => ({
        from: () => ({
          where: () => {
            tidySelectCall++
            if (tidySelectCall === 1) {
              return { limit: async () => [targetRow] }
            }
            return {
              orderBy: async () => [
                {
                  id: targetRow.id,
                  shortId: targetRow.shortId,
                  title: targetRow.title,
                  realms: targetRow.realms,
                  topics: targetRow.topics,
                  projects: targetRow.projects,
                },
              ],
            }
          },
        }),
      }),
    }

    const preview = await previewSingleTidy(fakeTidyDb as never, null, 'm-234abc')
    expect(preview.needed).toBe(false)
    expect(tidyStub.seenBodies).toHaveLength(2)
    expect(tidyStub.seenBodies[0]?.max_tokens).toBe(expectedTidyTokens)
    expect(tidyStub.seenBodies[1]?.max_tokens).toBe(expectedTidyTokens)
  })
})
