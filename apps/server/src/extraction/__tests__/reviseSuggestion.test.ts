import { ReviseSuggestionResponse, type DreamSuggestionKind } from '@kioku/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Db } from '../../db/client'
import type { Deps } from '../../http/env'
import { router } from '../../http/openapi'
import { MemoryError } from '../../memory/errors'
import type { EntryService } from '../../memory/service'
import { ModelClientError, type ChatCompleteOptions, type ChatMessage } from '../../models/client'

const mockLoadResolvedModel = vi.fn()
const mockChatComplete = vi.fn()

vi.mock('../../models/store', () => ({
  CHAT_LLM_SETTING_KEY: 'chat_llm',
  loadResolvedModel: (...args: unknown[]) => mockLoadResolvedModel(...args),
  loadStoredModel: vi.fn(async () => null),
}))

vi.mock('../../models/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../models/client')>()
  return {
    ...actual,
    chatComplete: (...args: unknown[]) => mockChatComplete(...args),
  }
})

import { dreamRoutes } from '../../routes/dream'
import { CaptureAbortedError } from '../capture'
import {
  buildCurrentDraftFromSuggestion,
  buildRevisedSuggestionResult,
  buildReviseSuggestionMessages,
  computeReviseMaxTokens,
  isRevisableDreamKind,
  parseReviseOutput,
  reviseSuggestion,
  type ReviseContext,
  type ReviseSourceEntry,
} from '../reviseSuggestion'

const SUGGESTION_ID = '00000000-0000-4000-8000-000000000101'
const ENTRY_ID_1 = '00000000-0000-4000-8000-000000000201'
const ENTRY_ID_2 = '00000000-0000-4000-8000-000000000202'

function makeSourceEntry(overrides: Partial<ReviseSourceEntry> = {}): ReviseSourceEntry {
  return {
    id: ENTRY_ID_1,
    shortId: 'm-234abc',
    kind: 'episode',
    title: '本地代理端口排查',
    summary: null,
    content: '在家里 home-24 主机上将本地代理端口改为 7890，凭据见 {{cred:proxy-auth}}。',
    disclosure: null,
    bootMode: 'none',
    isPinned: false,
    envs: ['mac'],
    realms: ['work'],
    projects: ['kioku'],
    runtimes: [],
    topics: ['network'],
    deviceKey: 'home-24',
    ...overrides,
  }
}

function makeFakeDb(
  suggestionRow: Record<string, unknown> | null,
  entryRows: Record<string, unknown>[],
) {
  let selectCount = 0
  const insert = vi.fn()
  const update = vi.fn()
  const del = vi.fn()
  const db = {
    select: vi.fn(() => {
      selectCount++
      if (selectCount === 1) {
        return {
          from: () => ({
            where: () => ({
              limit: async () => (suggestionRow ? [suggestionRow] : []),
            }),
          }),
        }
      }
      return {
        from: () => ({
          where: () => ({
            orderBy: async () => entryRows,
          }),
        }),
      }
    }),
    insert,
    update,
    delete: del,
  } as unknown as Db
  return { db, insert, update, del }
}

function makeSuggestionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SUGGESTION_ID,
    kind: 'distill_episode' as DreamSuggestionKind,
    entryIds: [ENTRY_ID_1],
    entryVersions: [2],
    keepId: null,
    proposedTitle: 'macOS 本地代理端口',
    proposedSummary: '本地代理端口设为 7890。',
    proposedContent:
      'macOS 本地代理监听 127.0.0.1:7890，认证见 {{cred:proxy-auth}} 与 [[m-345bcd]]。',
    proposedDisclosure: '排查代理端口时参考',
    proposedChangeSummary: '从会话摘要提炼代理端口配置',
    archivedNotes: null,
    proposedTopics: ['network'],
    proposedEnvs: ['mac'],
    proposedRealms: ['work'],
    proposedProjects: ['kioku'],
    proposedRuntimes: [],
    proposedLinks: null,
    proposedBootMode: 'none',
    secretWarnings: null,
    reason: '将近期排错经验沉淀为正式记忆',
    fingerprint: 'fp-1',
    status: 'pending',
    createdAt: new Date('2026-10-02T00:00:00Z'),
    decidedAt: null,
    ...overrides,
  }
}

function makeEntryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID_1,
    shortId: 'm-234abc',
    kind: 'episode',
    title: '本地代理端口排查',
    summary: null,
    content: '在家里 home-24 主机上将本地代理端口改为 7890，凭据见 {{cred:proxy-auth}}。',
    disclosure: null,
    isPinned: false,
    bootMode: 'none',
    envs: ['mac'],
    realms: ['work'],
    projects: ['kioku'],
    runtimes: [],
    topics: ['network'],
    deviceKey: 'home-24',
    projectSlug: 'kioku',
    searchTags: '',
    validTo: null,
    verifiedAt: null,
    lastChangeSummary: null,
    version: 2,
    dreamCheckedVersion: 0,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  }
}

describe('reviseSuggestion 单轮无状态待处理建议修订', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadResolvedModel.mockResolvedValue({
      baseUrl: 'https://api.example.com/v1',
      model: 'test-chat',
      apiKey: 'test-key',
    })
  })

  it('校验可修订类型与充裕输出预算，并在提示词中透传 deviceKey 与数据边界', () => {
    expect(isRevisableDreamKind('distill_episode')).toBe(true)
    expect(isRevisableDreamKind('update')).toBe(true)
    expect(isRevisableDreamKind('merge_duplicates')).toBe(true)
    expect(isRevisableDreamKind('tidy')).toBe(true)
    expect(isRevisableDreamKind('mark_stale')).toBe(false)
    expect(isRevisableDreamKind('link_entries')).toBe(false)
    expect(isRevisableDreamKind('adjust_boot_mode')).toBe(false)

    expect(computeReviseMaxTokens(500)).toBe(4_000)
    expect(computeReviseMaxTokens(4_000)).toBe(8_400)
    expect(computeReviseMaxTokens(20_000)).toBe(16_384)

    const source = makeSourceEntry({ deviceKey: 'home-24' })
    const context: ReviseContext = {
      kind: 'distill_episode',
      reason: '提炼单机配置',
      keepId: null,
      baseEntry: source,
      sourceEntries: [source],
      currentDraft: {
        title: 'macOS 本地代理端口',
        summary: '本地代理端口 7890。',
        content: 'macOS 本地代理端口 7890。',
        disclosure: null,
        changeSummary: null,
        topics: ['network'],
        envs: ['mac'],
        realms: ['work'],
        projects: ['kioku'],
        runtimes: [],
        bootMode: 'none',
      },
      instruction: '限定仅适用于 home-24 主机',
    }

    const messages = buildReviseSuggestionMessages(context)
    expect(messages).toHaveLength(2)
    const sys = messages[0]!.content
    const usr = messages[1]!.content
    const nonce = sys.match(/<instruction_([0-9a-f]{8})>/)?.[1]
    expect(nonce).toBeTruthy()
    expect(usr).toContain(`<instruction_${nonce}>`)
    expect(usr).toContain(`<draft_${nonce}>`)
    expect(usr).toContain(`<source_${nonce}>`)
    expect(usr).toContain('device=home-24')
  })

  it('严格拦截越权拓宽 realms 场域边界，并允许向内收窄场域', () => {
    const sourceWork = makeSourceEntry({ kind: 'entry', realms: ['work'] })
    const baseContext: ReviseContext = {
      kind: 'update',
      reason: '更新代理说明',
      keepId: null,
      baseEntry: sourceWork,
      sourceEntries: [sourceWork],
      currentDraft: {
        title: '代理配置',
        summary: null,
        content: sourceWork.content,
        disclosure: null,
        changeSummary: null,
        topics: ['network'],
        envs: ['mac'],
        realms: ['work'],
        projects: ['kioku'],
        runtimes: [],
        bootMode: 'none',
      },
      instruction: '改为不限场域',
    }

    // 尝试将 work 放宽为空数组（通用）或追加 personal -> 一律拦截回退至 ['work']
    const widenToAll = parseReviseOutput(
      JSON.stringify({
        proposedContent: sourceWork.content,
        proposedRealms: [],
        reason: '尝试放宽为通用记忆',
      }),
    )!
    const resAll = buildRevisedSuggestionResult(baseContext, widenToAll)
    expect(resAll.proposedRealms).toEqual(['work'])
    expect(resAll.reason).toContain('已保留原场域安全边界')

    const widenToPersonal = parseReviseOutput(
      JSON.stringify({
        proposedContent: sourceWork.content,
        proposedRealms: ['work', 'personal'],
        reason: '尝试扩展到 personal',
      }),
    )!
    const resPersonal = buildRevisedSuggestionResult(baseContext, widenToPersonal)
    expect(resPersonal.proposedRealms).toEqual(['work'])

    // 通用来源（realms: []）允许收窄至 ['work']
    const universalSource = makeSourceEntry({ kind: 'episode', realms: [] })
    const narrowCtx: ReviseContext = {
      ...baseContext,
      kind: 'distill_episode',
      baseEntry: universalSource,
      sourceEntries: [universalSource],
      currentDraft: { ...baseContext.currentDraft, realms: [] },
    }
    const narrowOutput = parseReviseOutput(
      JSON.stringify({
        proposedContent: universalSource.content,
        proposedRealms: ['work'],
        reason: '收紧至 work 场域',
      }),
    )!
    const resNarrow = buildRevisedSuggestionResult(narrowCtx, narrowOutput)
    expect(resNarrow.proposedRealms).toEqual(['work'])
    expect(resNarrow.reason).not.toContain('已保留原场域安全边界')
  })

  it('在合并重复与单条修订中准确计算双链与凭据占位符完整性告警', () => {
    const keepEntry = makeSourceEntry({
      id: ENTRY_ID_1,
      shortId: 'm-234aaa',
      kind: 'entry',
      realms: ['work'],
      content: '保留条目，参考 [[m-234ccc]] 与 {{cred:db-pass}}。',
    })
    const dupEntry = makeSourceEntry({
      id: ENTRY_ID_2,
      shortId: 'm-234bbb',
      kind: 'entry',
      realms: ['work'],
      content: '并入条目，参考 [[m-234aaa]]、[[m-234ddd]] 与 {{cred:api-key#token}}。',
    })
    const mergeCtx: ReviseContext = {
      kind: 'merge_duplicates',
      reason: '合并重复条目',
      keepId: ENTRY_ID_1,
      baseEntry: keepEntry,
      sourceEntries: [keepEntry, dupEntry],
      currentDraft: {
        title: '合并后条目',
        summary: null,
        content: '合并内容 [[m-234ccc]] [[m-234ddd]] {{cred:db-pass}} {{cred:api-key#token}}',
        disclosure: null,
        changeSummary: null,
        topics: [],
        envs: ['mac'],
        realms: ['work'],
        projects: [],
        runtimes: [],
        bootMode: 'none',
      },
      instruction: '精简描述',
    }

    // 遗漏了 [[m-234ddd]] 与 {{cred:api-key#token}}（指向被合并自身 m-234aaa 不算外部遗漏）
    const parsed = parseReviseOutput(
      JSON.stringify({
        proposedContent: '精简合并内容，保留 [[m-234ccc]] 与 {{cred:db-pass}}。',
        proposedRealms: ['personal'], // 合并也必须阻止偏离 keep.realms
        reason: '精简了合并后正文',
      }),
    )!
    const result = buildRevisedSuggestionResult(mergeCtx, parsed)
    expect(result.proposedRealms).toEqual(['work'])
    expect(result.integrity.intact).toBe(false)
    expect(result.integrity.missingLinks).toEqual(['m-234ddd'])
    expect(result.integrity.missingCreds).toEqual(['api-key#token'])
  })

  it('端到端执行无状态修订（零写库）并校验 404 / 409 / 400 错误路径', async () => {
    // 1. 建议不存在 -> 404
    const missingDb = makeFakeDb(null, [])
    await expect(
      reviseSuggestion(missingDb.db, null, SUGGESTION_ID, { instruction: '补充前提' }),
    ).rejects.toMatchObject({ status: 404 })

    // 2. 非 pending 状态 -> 409
    const appliedDb = makeFakeDb(makeSuggestionRow({ status: 'applied' }), [makeEntryRow()])
    await expect(
      reviseSuggestion(appliedDb.db, null, SUGGESTION_ID, { instruction: '补充前提' }),
    ).rejects.toMatchObject({ status: 409 })

    // 3. 不支持的建议类型 -> 400
    for (const badKind of ['mark_stale', 'link_entries', 'adjust_boot_mode'] as const) {
      const badKindDb = makeFakeDb(makeSuggestionRow({ kind: badKind }), [makeEntryRow()])
      await expect(
        reviseSuggestion(badKindDb.db, null, SUGGESTION_ID, { instruction: '补充前提' }),
      ).rejects.toMatchObject({ status: 400 })
    }

    // 4. 关联记忆版本漂移 -> 409
    const driftedDb = makeFakeDb(makeSuggestionRow({ entryVersions: [2] }), [
      makeEntryRow({ version: 3 }),
    ])
    await expect(
      reviseSuggestion(driftedDb.db, null, SUGGESTION_ID, { instruction: '补充前提' }),
    ).rejects.toMatchObject({ status: 409 })

    // 5. 关联记忆已软删除 -> 409
    const deletedDb = makeFakeDb(makeSuggestionRow(), [
      makeEntryRow({ deletedAt: new Date('2026-10-03T00:00:00Z') }),
    ])
    await expect(
      reviseSuggestion(deletedDb.db, null, SUGGESTION_ID, { instruction: '补充前提' }),
    ).rejects.toMatchObject({ status: 409 })

    // 6. 未配置对话模型 -> 400
    mockLoadResolvedModel.mockResolvedValueOnce(null)
    const noModelDb = makeFakeDb(makeSuggestionRow(), [makeEntryRow()])
    await expect(
      reviseSuggestion(noModelDb.db, null, SUGGESTION_ID, { instruction: '补充前提' }),
    ).rejects.toMatchObject({ status: 400 })

    // 7. 正常成功路径：不写库、透传 deviceKey、使用 organize 任务与充裕 maxTokens
    mockChatComplete.mockResolvedValueOnce({
      content: JSON.stringify({
        proposedTitle: 'home-24 本机代理端口约定',
        proposedSummary: '仅适用于家里 home-24 主机，代理端口为 7890。',
        proposedContent:
          '仅限家里 home-24 主机生效：本地代理监听 127.0.0.1:7890，认证见 {{cred:proxy-auth}} 与 [[m-345bcd]]。',
        proposedDisclosure: '在 home-24 主机配置代理时参考',
        proposedChangeSummary: '限定单机适用边界为 home-24',
        proposedTopics: ['network'],
        proposedEnvs: ['home-24'],
        proposedRealms: ['work'],
        proposedProjects: ['kioku'],
        proposedRuntimes: [],
        proposedBootMode: 'none',
        reason: '已按说明补充 home-24 主机边界并收紧环境标签',
      }),
    })

    const okDb = makeFakeDb(makeSuggestionRow(), [makeEntryRow()])
    const res = await reviseSuggestion(okDb.db, null, SUGGESTION_ID, {
      instruction: '仅限家里 home-24 主机，把环境标签收紧为 home-24',
    })

    expect(ReviseSuggestionResponse.parse(res)).toMatchObject({
      proposedTitle: 'home-24 本机代理端口约定',
      proposedEnvs: ['home-24'],
      proposedRealms: ['work'],
      integrity: { intact: true },
    })
    expect(okDb.insert).not.toHaveBeenCalled()
    expect(okDb.update).not.toHaveBeenCalled()
    expect(okDb.del).not.toHaveBeenCalled()

    expect(mockChatComplete).toHaveBeenCalledTimes(1)
    const [, sentMessages, sentOptions] = mockChatComplete.mock.calls[0] as [
      unknown,
      ChatMessage[],
      ChatCompleteOptions,
    ]
    expect(sentMessages[1]?.content).toContain('device=home-24')
    expect(sentOptions.jsonMode).toBe(true)
    expect(sentOptions.stream).toBe(true)
    expect(sentOptions.taskKind).toBe('organize')
    expect(sentOptions.maxTokens).toBeGreaterThanOrEqual(4_000)

    // 8. ModelClientError(timeout) -> 504；ModelClientError(cancelled) -> CaptureAbortedError
    mockChatComplete.mockRejectedValueOnce(
      new ModelClientError('请求超时', { category: 'timeout', retryable: true }),
    )
    const timeoutDb = makeFakeDb(makeSuggestionRow(), [makeEntryRow()])
    await expect(
      reviseSuggestion(timeoutDb.db, null, SUGGESTION_ID, { instruction: '补充前提' }),
    ).rejects.toMatchObject({ status: 504 })

    mockChatComplete.mockRejectedValueOnce(
      new ModelClientError('请求已取消', { category: 'cancelled', retryable: false }),
    )
    const cancelledDb = makeFakeDb(makeSuggestionRow(), [makeEntryRow()])
    await expect(
      reviseSuggestion(cancelledDb.db, null, SUGGESTION_ID, { instruction: '补充前提' }),
    ).rejects.toBeInstanceOf(CaptureAbortedError)

    // 9. distill_episode 二次修订传入已丢占位符的 overrides.content 时，仍以原始 suggestion.proposedContent 为完整性基线
    mockChatComplete.mockResolvedValueOnce({
      content: JSON.stringify({
        proposedTitle: 'home-24 本地代理',
        proposedContent: '仅限 home-24 主机生效：本地代理监听 127.0.0.1:7890。',
        reason: '再次精简表述',
      }),
    })
    const secondPassDb = makeFakeDb(makeSuggestionRow(), [makeEntryRow()])
    const secondPass = await reviseSuggestion(secondPassDb.db, null, SUGGESTION_ID, {
      instruction: '再精简一下措辞',
      content: '仅限 home-24：本地代理 7890（首轮已遗漏占位符与双链）',
    })
    expect(secondPass.integrity.intact).toBe(false)
    expect(secondPass.integrity.missingCreds).toEqual(['proxy-auth'])
    expect(secondPass.integrity.missingLinks).toEqual(['m-345bcd'])

    // 10. merge_duplicates 的 overrides.realms 须严格匹配 sameRealms，偏离 keep.realms 时被忽略
    const keepForMerge = makeSourceEntry({
      id: ENTRY_ID_1,
      shortId: 'm-234aaa',
      kind: 'entry',
      realms: ['work'],
    })
    const dupForMerge = makeSourceEntry({
      id: ENTRY_ID_2,
      shortId: 'm-234bbb',
      kind: 'entry',
      realms: ['work'],
    })
    const mergeDraft = buildCurrentDraftFromSuggestion(
      makeSuggestionRow({
        kind: 'merge_duplicates',
        entryIds: [ENTRY_ID_1, ENTRY_ID_2],
        entryVersions: [2, 2],
        keepId: ENTRY_ID_1,
      }) as Parameters<typeof buildCurrentDraftFromSuggestion>[0],
      keepForMerge,
      [keepForMerge, dupForMerge],
      { instruction: '调整场域', realms: [] },
    )
    expect(mergeDraft.realms).toEqual(['work'])
  })

  it('POST /console/inbox/{id}/revise 路由校验参数并返回结构化修订结果', async () => {
    mockChatComplete.mockResolvedValueOnce({
      content: JSON.stringify({
        proposedTitle: 'home-24 本地代理',
        proposedSummary: '仅适用于 home-24 主机。',
        proposedContent:
          '仅限 home-24 生效，本地代理 7890，认证见 {{cred:proxy-auth}} 与 [[m-345bcd]]。',
        proposedDisclosure: '在 home-24 排查代理时参考',
        proposedChangeSummary: '限定仅限 home-24',
        proposedTopics: ['network'],
        proposedEnvs: ['home-24'],
        proposedRealms: ['work'],
        proposedProjects: ['kioku'],
        proposedRuntimes: [],
        proposedBootMode: 'none',
        reason: '按说明完成单轮修订',
      }),
    })

    const { db } = makeFakeDb(makeSuggestionRow(), [makeEntryRow()])
    const app = router()
    app.onError((err, c) => {
      if (err instanceof MemoryError) return c.json({ error: err.message }, err.status)
      return c.json({ error: '服务内部错误' }, 500)
    })
    app.route(
      '/v1',
      dreamRoutes(
        { db, cookieSecure: false, masterKey: null, jobs: null } as unknown as Deps,
        {} as unknown as EntryService,
      ),
    )

    // 非法 UUID -> 400
    const badIdRes = await app.request('/v1/console/inbox/not-a-uuid/revise', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '收紧标签' }),
    })
    expect(badIdRes.status).toBe(400)

    // 空修订说明 -> 400
    const emptyInstRes = await app.request(`/v1/console/inbox/${SUGGESTION_ID}/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '   ' }),
    })
    expect(emptyInstRes.status).toBe(400)

    // 超长修订说明（>500字）-> 400
    const tooLongRes = await app.request(`/v1/console/inbox/${SUGGESTION_ID}/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '字'.repeat(501) }),
    })
    expect(tooLongRes.status).toBe(400)

    // 合法请求 -> 200 并通过契约校验
    const okRes = await app.request(`/v1/console/inbox/${SUGGESTION_ID}/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '仅限家里 home-24 主机' }),
    })
    expect(okRes.status).toBe(200)
    const body = ReviseSuggestionResponse.parse(await okRes.json())
    expect(body.proposedEnvs).toEqual(['home-24'])
    expect(body.integrity.intact).toBe(true)
  })
})
