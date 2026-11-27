import { CapturePlanResponse } from '@kioku/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Db } from '../../db/client'
import { ModelClientError, type ChatCompleteOptions, type ChatMessage } from '../../models/client'

const mockLoadResolvedModel = vi.fn()
const mockChatComplete = vi.fn()

vi.mock('../../models/store', () => ({
  CHAT_LLM_SETTING_KEY: 'chat_llm',
  loadResolvedModel: (...args: unknown[]) => mockLoadResolvedModel(...args),
}))

vi.mock('../../models/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../models/client')>()
  return {
    ...actual,
    chatComplete: (...args: unknown[]) => mockChatComplete(...args),
  }
})

import { CaptureAbortedError, planCapture, REFINE_PROMPT_CONTENT_LIMIT } from '../capture'

const CONSOLE_SCOPE = {
  kind: 'console' as const,
  accountId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
}

function makeFakeDb(row: Record<string, unknown> | null) {
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    })),
  } as unknown as Db
}

function makeEntryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000301',
    shortId: 'm-234xyz',
    kind: 'entry',
    title: '本地代理配置',
    summary: '本地代理端口 7890。',
    content:
      '## 代理端口\n- 本地代理监听 127.0.0.1:7890\n- 凭据 {{cred:proxy-token}} 与 [[m-234abc]]',
    disclosure: '排查代理问题时参考',
    isPinned: false,
    bootMode: 'none',
    envs: ['mac'],
    realms: ['work'],
    projects: ['kioku'],
    runtimes: [],
    topics: ['network'],
    deviceKey: null,
    projectSlug: null,
    searchTags: '',
    validTo: null,
    verifiedAt: null,
    lastChangeSummary: null,
    version: 4,
    dreamCheckedVersion: 0,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  }
}

describe('planCapture 单条按说明微调执行链路', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadResolvedModel.mockResolvedValue({
      baseUrl: 'https://api.example.com/v1',
      model: 'test-chat',
      apiKey: 'test-key',
    })
  })

  it('调用 chatComplete 使用按正文长度计算的充裕输出预算并返回正文与元信息修订方案', async () => {
    const longContent = `## 代理端口\n- 本地代理监听 127.0.0.1:7890\n${'补充说明。'.repeat(700)}\n- 引用 {{cred:proxy-token}} 与 [[m-234abc]]`
    mockChatComplete.mockResolvedValueOnce({
      content: JSON.stringify({
        action: 'update',
        patch: {
          kind: 'replace',
          oldText: '- 本地代理监听 127.0.0.1:7890',
          text: '- 仅限 home-24 主机生效：本地代理监听 127.0.0.1:7890',
        },
        proposedTitle: 'home-24 本地代理配置',
        proposedSummary: '仅适用于 home-24 主机，代理监听 7890 端口。',
        proposedEnvs: ['home-24'],
        proposedChangeSummary: '补充单机前提并收紧环境标签',
        reason: '按说明限定了 home-24 主机边界',
      }),
    })

    const db = makeFakeDb(makeEntryRow({ content: longContent }))
    const plan = await planCapture(db, null, CONSOLE_SCOPE, {
      text: '补充说明仅适用于 home-24 主机并收紧环境标签',
      targetShortId: 'm-234xyz',
      mode: 'refine',
    })

    const parsed = CapturePlanResponse.parse(plan)
    expect(parsed.action).toBe('update')
    expect(parsed.patchKind).toBe('replace')
    expect(parsed.targetShortId).toBe('m-234xyz')
    expect(parsed.targetVersion).toBe(4)
    expect(parsed.proposedContent).toContain('仅限 home-24 主机生效')
    expect(parsed.proposedTitle).toBe('home-24 本地代理配置')
    expect(parsed.proposedEnvs).toEqual(['home-24'])
    expect(parsed.integrity?.intact).toBe(true)

    expect(mockChatComplete).toHaveBeenCalledTimes(1)
    const [, messages, options] = mockChatComplete.mock.calls[0] as [
      unknown,
      ChatMessage[],
      ChatCompleteOptions,
    ]
    expect(messages[1]?.content).toContain('补充说明仅适用于 home-24 主机并收紧环境标签')
    expect(options.taskKind).toBe('organize')
    expect(options.jsonMode).toBe(true)
    expect(options.stream).toBe(true)
    expect(options.maxTokens).toBe(Math.ceil(longContent.length * 1.6) + 2_000)
  })

  it('目标不存在返回 404，未配置对话模型返回 400，超时返 504、取消抛 CaptureAbortedError，超长整篇覆写返 422', async () => {
    const emptyDb = makeFakeDb(null)
    await expect(
      planCapture(emptyDb, null, CONSOLE_SCOPE, {
        text: '补充前提',
        targetShortId: 'm-234xyz',
        mode: 'refine',
      }),
    ).rejects.toMatchObject({ status: 404 })

    mockLoadResolvedModel.mockResolvedValueOnce(null)
    const db = makeFakeDb(makeEntryRow())
    await expect(
      planCapture(db, null, CONSOLE_SCOPE, {
        text: '补充前提',
        targetShortId: 'm-234xyz',
        mode: 'refine',
      }),
    ).rejects.toMatchObject({ status: 400 })

    // ModelClientError(timeout) -> 504
    mockChatComplete.mockRejectedValueOnce(
      new ModelClientError('请求超时', { category: 'timeout', retryable: true }),
    )
    await expect(
      planCapture(db, null, CONSOLE_SCOPE, {
        text: '补充前提',
        targetShortId: 'm-234xyz',
        mode: 'refine',
      }),
    ).rejects.toMatchObject({ status: 504 })

    // ModelClientError(cancelled) -> CaptureAbortedError
    mockChatComplete.mockRejectedValueOnce(
      new ModelClientError('请求已取消', { category: 'cancelled', retryable: false }),
    )
    await expect(
      planCapture(db, null, CONSOLE_SCOPE, {
        text: '补充前提',
        targetShortId: 'm-234xyz',
        mode: 'refine',
      }),
    ).rejects.toBeInstanceOf(CaptureAbortedError)

    // 超长正文尝试整篇覆写 -> 422 提示缩小修改范围
    const oversizedDb = makeFakeDb(
      makeEntryRow({ content: `## 章节\n${'内容'.repeat(REFINE_PROMPT_CONTENT_LIMIT / 2 + 50)}` }),
    )
    mockChatComplete.mockResolvedValueOnce({
      content: JSON.stringify({
        action: 'update',
        patch: null,
        proposedContent: '## 章节\n截断重写',
        reason: '整篇重写',
      }),
    })
    await expect(
      planCapture(oversizedDb, null, CONSOLE_SCOPE, {
        text: '重写全文',
        targetShortId: 'm-234xyz',
        mode: 'refine',
      }),
    ).rejects.toMatchObject({ status: 422 })
  })
})
