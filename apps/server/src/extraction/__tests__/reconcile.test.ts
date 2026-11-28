import { SingleCrossCheckResponse } from '@kioku/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Db } from '../../db/client'
import { dreamSuggestions, entries, entryLinks } from '../../db/schema'

const { mockLoadResolvedModel, mockChatComplete, mockDatabaseNow } = vi.hoisted(() => ({
  mockLoadResolvedModel: vi.fn(),
  mockChatComplete: vi.fn(),
  mockDatabaseNow: vi.fn(),
}))

vi.mock('../../models/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../models/store')>()
  return {
    ...actual,
    loadResolvedModel: mockLoadResolvedModel,
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

import {
  canReconcileTarget,
  computeCrossMemoryTaskMaxTokens,
  reconcileActionDiscriminator,
  runCrossMemoryFunnel,
  runSingleCrossCheck,
  selectReconcileSeeds,
} from '../crossMemory'
import { packStandardDreamPromptItems, suggestionFingerprint, toPromptItem } from '../dream'
import {
  buildDreamMessages,
  buildReconcileLocateMessages,
  buildReconcilePatchMessages,
  evaluateDreamResponse,
  parseReconcileLocateResponse,
  parseReconcilePatchResponse,
  type ReconcileCandidateItem,
  type ReconcileSourceItem,
} from '../dreamPrompt'

type EntryRow = typeof entries.$inferSelect
type SuggestionInsertRow = typeof dreamSuggestions.$inferInsert

function makeEntryRow(overrides: Partial<EntryRow> & Pick<EntryRow, 'id' | 'shortId'>): EntryRow {
  const now = new Date('2026-11-27T00:00:00.000Z')
  return {
    kind: 'entry',
    title: '测试记忆',
    summary: '简短概要',
    content: '常规记忆正文内容。',
    disclosure: null,
    isPinned: false,
    bootMode: 'none',
    envs: [],
    realms: ['work'],
    projects: ['kioku'],
    runtimes: [],
    topics: ['network'],
    searchTags: '',
    validTo: null,
    verifiedAt: null,
    lastChangeSummary: null,
    version: 1,
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

interface FakeFunnelDbOptions {
  allEntries: EntryRow[]
  links?: { sourceEntryId: string; targetShortId: string }[]
  vectorPairs?: { entry_a: string; entry_b: string; sim: number }[]
  reconcileVectorPairs?: { entry_a: string; entry_b: string; sim: number }[]
  ftsResultIds?: string[]
  existingSuggestions?: {
    id?: string
    status?: 'pending' | 'applied' | 'rejected'
    fingerprint: string
    kind: string
    entryIds: string[]
    entryVersions: number[]
  }[]
  singleTarget?: EntryRow
}

function sqlChunksToText(query: unknown): string {
  if (typeof query === 'string') return query
  if (!query || typeof query !== 'object') return ''
  const rec = query as { value?: unknown; queryChunks?: unknown[] }
  if (Array.isArray(rec.value)) return rec.value.map(String).join('')
  if (Array.isArray(rec.queryChunks)) return rec.queryChunks.map(sqlChunksToText).join('')
  return ''
}

function makeFakeFunnelDb(options: FakeFunnelDbOptions): {
  db: Db
  insertedSuggestions: SuggestionInsertRow[]
} {
  const insertedSuggestions: SuggestionInsertRow[] = []
  const storedPending: (typeof dreamSuggestions.$inferSelect)[] = []
  let nextInsertSeq = 1
  const linkRows = options.links ?? []
  const existingRows = (options.existingSuggestions ?? []).map((row, idx) => ({
    id: row.id ?? `90000000-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
    status: row.status ?? ('pending' as const),
    fingerprint: row.fingerprint,
    kind: row.kind,
    entryIds: row.entryIds,
    entryVersions: row.entryVersions,
  }))
  const vectorRows = options.vectorPairs ?? []
  const reconcileVectorRows = options.reconcileVectorPairs ?? vectorRows
  const ftsResultIds = options.ftsResultIds ?? []

  for (const row of existingRows) {
    if (row.status === 'pending') {
      storedPending.push({
        id: row.id,
        kind: row.kind as typeof dreamSuggestions.$inferSelect.kind,
        entryIds: row.entryIds,
        entryVersions: row.entryVersions,
        keepId: null,
        proposedTitle: null,
        proposedSummary: null,
        proposedContent: '待确认历史建议内容',
        proposedDisclosure: null,
        proposedChangeSummary: null,
        archivedNotes: null,
        proposedTopics: null,
        proposedEnvs: null,
        proposedRealms: null,
        proposedProjects: null,
        proposedRuntimes: null,
        proposedLinks: null,
        proposedBootMode: null,
        reason: '已有待确认建议',
        fingerprint: row.fingerprint,
        status: 'pending',
        createdAt: new Date('2026-11-27T01:30:00.000Z'),
        decidedAt: null,
      })
    }
  }

  let singleTargetLoaded = false

  const select = (projection?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      if (table === entries) {
        if (options.singleTarget && !singleTargetLoaded && !projection) {
          singleTargetLoaded = true
          return {
            where: () => ({
              limit: () => Promise.resolve([options.singleTarget!]),
            }),
          }
        }
        if (projection && 'deletedAt' in projection && !('content' in projection)) {
          return {
            where: () =>
              Promise.resolve(
                options.allEntries.map((e) => ({
                  shortId: e.shortId,
                  title: e.title,
                  deletedAt: e.deletedAt,
                })),
              ),
          }
        }
        return {
          where: () => {
            const listPromise = Promise.resolve(options.allEntries)
            return Object.assign(listPromise, {
              orderBy: () => Promise.resolve(options.allEntries),
            })
          },
        }
      }
      if (table === entryLinks) {
        return {
          where: () => Promise.resolve(linkRows),
          innerJoin: () => ({
            where: () => Promise.resolve([]),
          }),
        }
      }
      if (table === dreamSuggestions) {
        if (projection && 'fingerprint' in projection) {
          return Promise.resolve(existingRows)
        }
        return {
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve(storedPending),
            }),
          }),
        }
      }
      return Promise.resolve([])
    },
  })

  const insert = (table: unknown) => ({
    values: (val: SuggestionInsertRow) => ({
      onConflictDoNothing: () => ({
        returning: () => {
          if (table === dreamSuggestions) {
            insertedSuggestions.push(val)
            const id = `00000000-0000-4000-8000-${String(nextInsertSeq++).padStart(12, '0')}`
            const now = new Date('2026-11-27T02:00:00.000Z')
            storedPending.push({
              id,
              kind: val.kind,
              entryIds: val.entryIds,
              entryVersions: val.entryVersions,
              keepId: val.keepId ?? null,
              proposedTitle: val.proposedTitle ?? null,
              proposedSummary: val.proposedSummary ?? null,
              proposedContent: val.proposedContent ?? null,
              proposedDisclosure: val.proposedDisclosure ?? null,
              proposedChangeSummary: val.proposedChangeSummary ?? null,
              archivedNotes: val.archivedNotes ?? null,
              proposedTopics: val.proposedTopics ?? null,
              proposedEnvs: val.proposedEnvs ?? null,
              proposedRealms: val.proposedRealms ?? null,
              proposedProjects: val.proposedProjects ?? null,
              proposedRuntimes: val.proposedRuntimes ?? null,
              proposedLinks: val.proposedLinks ?? null,
              proposedBootMode: val.proposedBootMode ?? null,
              reason: val.reason,
              fingerprint: val.fingerprint,
              status: val.status ?? 'pending',
              createdAt: now,
              decidedAt: null,
            })
            return Promise.resolve([{ id }])
          }
          return Promise.resolve([])
        },
      }),
    }),
  })

  const execute = (query: unknown) => {
    const text = sqlChunksToText(query).toLowerCase()
    if (text.includes('row_number() over')) {
      return Promise.resolve(reconcileVectorRows)
    }
    if (text.includes('entry_embeddings')) {
      return Promise.resolve(vectorRows.filter((r) => r.sim >= 0.7))
    }
    if (text.includes('tsvector_to_array')) {
      return Promise.resolve([{ terms: ftsResultIds.length ? ['代理', '端口'] : [] }])
    }
    if (text.includes('ts_rank_cd')) {
      return Promise.resolve(
        ftsResultIds.map((id, idx) => ({ id, rank: Math.max(0.1, 1 - idx * 0.1) })),
      )
    }
    return Promise.resolve([])
  }

  return {
    db: { select, insert, execute } as unknown as Db,
    insertedSuggestions,
  }
}

describe('提示词语义时间对齐与 standard 更新防线', () => {
  it('formatItem 优先输出 verifiedAt 核实日期，缺省时回退 updatedAt 更新日期', () => {
    const verifiedRow = makeEntryRow({
      id: '10000000-0000-4000-8000-000000000001',
      shortId: 'm-234ver',
      title: '已核实记忆',
      verifiedAt: new Date('2026-09-15T10:00:00.000Z'),
      updatedAt: new Date('2026-11-20T10:00:00.000Z'),
    })
    const fallbackRow = makeEntryRow({
      id: '10000000-0000-4000-8000-000000000002',
      shortId: 'm-234upd',
      title: '未核实记忆',
      verifiedAt: null,
      updatedAt: new Date('2026-11-20T10:00:00.000Z'),
    })

    const itemA = toPromptItem(verifiedRow, 1_500, ['m-234upd'])
    const itemB = toPromptItem(fallbackRow)
    expect(itemA.verifiedAt).toBe('2026-09-15T10:00:00.000Z')
    expect(itemA.outboundShortIds).toEqual(['m-234upd'])
    expect(itemB.verifiedAt).toBeNull()
    expect(itemB.outboundShortIds).toBeUndefined()

    const msgs = buildDreamMessages([itemA], [itemB])
    expect(msgs[0]?.content).toContain('必须填 source_short_id')
    expect(msgs[1]?.content).toContain('[m-234ver] (entry, 9字) 已核实记忆 | 核实于 2026-09-15')
    expect(msgs[1]?.content).toContain('已有出链：m-234upd')
    expect(msgs[1]?.content).toContain('[m-234upd] (entry, 9字) 未核实记忆 | 更新于 2026-11-20')
  })

  it('packStandardDreamPromptItems 透传既有出链以提前过滤重复 link_entries', () => {
    const rowA = makeEntryRow({
      id: '10000000-0000-4000-8000-000000000011',
      shortId: 'm-234aa1',
      title: '服务架构',
    })
    const rowB = makeEntryRow({
      id: '10000000-0000-4000-8000-000000000012',
      shortId: 'm-234bb2',
      title: '部署手册',
    })
    const rowC = makeEntryRow({
      id: '10000000-0000-4000-8000-000000000013',
      shortId: 'm-234cc3',
      title: '排错清单',
    })

    const packed = packStandardDreamPromptItems([rowA], [rowB, rowC], {
      outboundByEntryId: new Map([[rowA.id, [rowB.shortId]]]),
    })
    const catalog = new Map(
      [...packed.promptChanged, ...packed.promptNeighbors].map((item) => [item.shortId, item]),
    )

    const evaluated = evaluateDreamResponse(
      JSON.stringify({
        suggestions: [
          {
            kind: 'link_entries',
            target_short_ids: [rowA.shortId],
            links: [
              { target_short_id: rowB.shortId, relation: '已存在应过滤' },
              { target_short_id: rowC.shortId, relation: '排错对照' },
            ],
            reason: '补充上下游关联',
          },
        ],
      }),
      catalog,
    )
    expect(evaluated.status).toBe('ok')
    if (evaluated.status === 'ok') {
      expect(evaluated.proposals).toHaveLength(1)
      expect(evaluated.proposals[0]?.proposedLinks?.map((l) => l.targetShortId)).toEqual([
        rowC.shortId,
      ])
    }
  })

  it('evaluateDreamResponse 拦截丢失双链的 update 与无合法场域来源的跨邻居 update', () => {
    const workChanged = toPromptItem(
      makeEntryRow({
        id: '10000000-0000-4000-8000-000000000021',
        shortId: 'm-234wk1',
        realms: ['work'],
        content: '公司代理端口已改为 7891。',
      }),
    )
    const globalNeighbor = toPromptItem(
      makeEntryRow({
        id: '10000000-0000-4000-8000-000000000022',
        shortId: 'm-234gb2',
        realms: [],
        content: '通用网络手册，参考 [[m-234ref]] 与 {{cred:net-token}}，端口 7890。',
      }),
    )
    const workNeighbor = toPromptItem(
      makeEntryRow({
        id: '10000000-0000-4000-8000-000000000023',
        shortId: 'm-234wk3',
        realms: ['work'],
        content: '公司调试说明，参考 [[m-234ref]]，端口 7890。',
      }),
    )

    const catalog = new Map([
      [workChanged.shortId, workChanged],
      [globalNeighbor.shortId, globalNeighbor],
      [workNeighbor.shortId, workNeighbor],
    ])
    const changedShortIds = new Set([workChanged.shortId])

    const res = evaluateDreamResponse(
      JSON.stringify({
        suggestions: [
          // 未填 source_short_id 且仅 work 变更条无法流入全局邻居 -> 拦截防渗漏
          {
            kind: 'update',
            target_short_ids: [globalNeighbor.shortId],
            content: '通用网络手册，参考 [[m-234ref]] 与 {{cred:net-token}}，端口 7891。',
            reason: '同步端口变更',
          },
          // 伪造不存在的 source_short_id 企图绕过场域检查 -> 拦截
          {
            kind: 'update',
            target_short_ids: [globalNeighbor.shortId],
            source_short_id: 'm-999zzz',
            content: '通用网络手册，参考 [[m-234ref]] 与 {{cred:net-token}}，端口 7891。',
            reason: '同步端口变更',
          },
          // 丢失原有双链 [[m-234ref]] -> 拦截
          {
            kind: 'update',
            target_short_ids: [workNeighbor.shortId],
            source_short_id: workChanged.shortId,
            content: '公司调试说明，端口 7891。',
            reason: '同步端口但误删双链',
          },
          // 同场域且完整保留双链 -> 放行
          {
            kind: 'update',
            target_short_ids: [workNeighbor.shortId],
            content: '公司调试说明，参考 [[m-234ref]]，端口 7891。',
            reason: '同场域邻居同步新端口',
          },
        ],
      }),
      catalog,
      { changedShortIds },
    )

    expect(res.status).toBe('ok')
    if (res.status === 'ok') {
      expect(res.proposals).toHaveLength(1)
      expect(res.proposals[0]?.entryIds).toEqual([workNeighbor.id])
      expect(res.proposals[0]?.proposedContent).toContain('[[m-234ref]]')
    }

    // 混合场域批次 fail-closed 检验：含 work + global 变更条时，省略 source_short_id 禁止修改全局邻居或全局自身，伪造/自指 source_short_id 一律丢弃
    const globalChanged = toPromptItem(
      makeEntryRow({
        id: '10000000-0000-4000-8000-000000000024',
        shortId: 'm-234gb4',
        realms: [],
        content: '全局部署规范，端口 7890。',
      }),
    )
    const mixedCatalog = new Map([
      [workChanged.shortId, workChanged],
      [globalChanged.shortId, globalChanged],
      [globalNeighbor.shortId, globalNeighbor],
      [workNeighbor.shortId, workNeighbor],
    ])
    const mixedChanged = new Set([workChanged.shortId, globalChanged.shortId])

    const mixedRes = evaluateDreamResponse(
      JSON.stringify({
        suggestions: [
          // 混合批次省略 source_short_id 更新全局邻居 -> fail-closed 丢弃（不可因同批存在 globalChanged 放行）
          {
            kind: 'update',
            target_short_ids: [globalNeighbor.shortId],
            content: '通用网络手册，参考 [[m-234ref]] 与 {{cred:net-token}}，端口 7891。',
            reason: '混合批次缺 source_short_id',
          },
          // 混合批次省略 source_short_id 更新批次内全局自身 -> catalog 混入 work 条，fail-closed 丢弃
          {
            kind: 'update',
            target_short_ids: [globalChanged.shortId],
            content: '全局部署规范，端口 7891。',
            reason: '可能隐式混入窄场域事实',
          },
          // 显式传自指 source_short_id -> 丢弃
          {
            kind: 'update',
            target_short_ids: [workNeighbor.shortId],
            source_short_id: workNeighbor.shortId,
            content: '公司调试说明，参考 [[m-234ref]]，端口 7891。',
            reason: '自指 source_short_id 非法',
          },
          // 显式传不在 catalog 的 source_short_id -> 丢弃（即使原本目标为 work 邻居也不放行）
          {
            kind: 'update',
            target_short_ids: [workNeighbor.shortId],
            source_short_id: 'm-999zzz',
            content: '公司调试说明，参考 [[m-234ref]]，端口 7891。',
            reason: '伪造 source_short_id 非法',
          },
          // 混合批次更新 work 邻居且全部变更条（work、[]）均可流入 work -> 放行
          {
            kind: 'update',
            target_short_ids: [workNeighbor.shortId],
            content: '公司调试说明，参考 [[m-234ref]]，端口 7891。',
            reason: '全部变更条场域均可流入 work',
          },
          // 显式指定合法全局 source_short_id 更新全局邻居 -> 放行
          {
            kind: 'update',
            target_short_ids: [globalNeighbor.shortId],
            source_short_id: globalChanged.shortId,
            content: '通用网络手册，参考 [[m-234ref]] 与 {{cred:net-token}}，端口 7891。',
            reason: '显式全局来源合法流入全局邻居',
          },
        ],
      }),
      mixedCatalog,
      { changedShortIds: mixedChanged },
    )
    expect(mixedRes.status).toBe('ok')
    if (mixedRes.status === 'ok') {
      expect(mixedRes.proposals.map((p) => p.entryIds[0])).toEqual([
        workNeighbor.id,
        globalNeighbor.id,
      ])
      expect(mixedRes.proposals[1]?.actionDiscriminator).toBe(`from:${globalChanged.shortId}`)
    }
  })
})

describe('跨记忆两阶段事实对账提示词、解析器与筛选规则', () => {
  it('定位与补丁提示词及解析器按约定格式输出并严格净化与去重', () => {
    const source: ReconcileSourceItem = {
      shortId: 'm-234src',
      title: '本地代理迁移结论',
      summary: '本地代理端口由 7890 切换至 7891。',
      content: '自本周起代理服务监听 127.0.0.1:7891，旧端口 7890 已停用。',
      lastChangeSummary: '将代理端口更新为 7891',
      envs: ['mac'],
      realms: ['work'],
      projects: ['kioku'],
      runtimes: [],
      topics: ['network'],
      verifiedAt: '2026-11-26T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z',
    }
    const structuredCand: ReconcileCandidateItem = {
      shortId: 'm-234c01',
      title: '开发联调手册',
      summary: '联调环境变量与端口约定。',
      content: '## 网络代理\n- 代理地址 127.0.0.1:7890\n\n## 构建命令\n- pnpm test',
      envs: ['mac'],
      realms: ['work'],
      projects: ['kioku'],
      runtimes: [],
      topics: ['dev'],
      verifiedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-11-25T00:00:00.000Z',
      relationHint: '反向引用邻居',
    }
    const plainCand: ReconcileCandidateItem = {
      shortId: 'm-234c02',
      title: '简短备忘',
      summary: null,
      content: '纯文本无二级小节的备忘内容，提到旧端口 7890。',
      envs: [],
      realms: ['work'],
      projects: ['kioku'],
      runtimes: [],
      topics: [],
      verifiedAt: null,
      updatedAt: '2026-10-10T00:00:00.000Z',
    }

    const locateMsgs = buildReconcileLocateMessages(source, [structuredCand, plainCand])
    expect(locateMsgs[1]?.content).toContain('核实于 2026-11-26')
    expect(locateMsgs[1]?.content).toContain('最近变更说明：将代理端口更新为 7891')
    expect(locateMsgs[1]?.content).toContain('- ## 网络代理')
    expect(locateMsgs[1]?.content).toContain('正文摘录（无二级小节）')

    const parsedLocate = parseReconcileLocateResponse(
      JSON.stringify({
        conflicts: [
          {
            target_short_id: 'm-234c01',
            section_heading: '## 网络代理',
            conflict_reason: '端口 7890 已被 m-234src 切换为 7891',
          },
          {
            target_short_id: 'm-234c01',
            section_heading: '构建命令',
            conflict_reason: '重复目标应去重',
          },
          {
            target_short_id: 'm-999bad',
            section_heading: null,
            conflict_reason: '不在允许列表应丢弃',
          },
          {
            target_short_id: 'm-234c02',
            section_heading: null,
            conflict_reason: '无小节文档端口过时',
          },
        ],
      }),
      new Set(['m-234c01', 'm-234c02']),
    )
    expect(parsedLocate).toEqual({
      status: 'ok',
      conflicts: [
        {
          targetShortId: 'm-234c01',
          sectionHeading: '网络代理',
          conflictReason: '端口 7890 已被 m-234src 切换为 7891',
        },
        {
          targetShortId: 'm-234c02',
          sectionHeading: null,
          conflictReason: '无小节文档端口过时',
        },
      ],
    })
    expect(parseReconcileLocateResponse('not json', new Set(['m-234c01']))).toMatchObject({
      status: 'invalid',
    })
    expect(parseReconcileLocateResponse('{"suggestions":[]}', new Set(['m-234c01']))).toEqual({
      status: 'ok',
      conflicts: [],
    })

    const patchMsgs = buildReconcilePatchMessages(
      source,
      structuredCand,
      '网络代理',
      '## 网络代理\n- 代理地址 127.0.0.1:7890',
      '端口 7890 已被 7891 替代',
    )
    expect(patchMsgs[1]?.content).toContain('小节「## 网络代理」原文')
    expect(patchMsgs[1]?.content).toContain('端口 7890 已被 7891 替代')

    expect(parseReconcilePatchResponse('{"needed":false}')).toEqual({ status: 'not_needed' })
    expect(
      parseReconcilePatchResponse(
        JSON.stringify({ needed: true, old_text: '- 相同行', new_text: '- 相同行' }),
      ),
    ).toEqual({ status: 'not_needed' })
    expect(parseReconcilePatchResponse('{"needed":true,"old_text":"只有旧片段"}')).toMatchObject({
      status: 'invalid',
    })

    const validPatch = parseReconcilePatchResponse(
      JSON.stringify({
        needed: true,
        old_text: '- 代理地址 127.0.0.1:7890',
        new_text: '- 代理地址 127.0.0.1:7891',
        proposed_summary: '联调代理已改为 7891，勿泄露 {{cred:secret}}。',
        change_summary: '依据 m-234src 更新联调代理端口为 7891',
        reason: 'm-234src 已将本地代理切换至 7891',
      }),
    )
    expect(validPatch).toEqual({
      status: 'patch',
      patch: {
        oldText: '- 代理地址 127.0.0.1:7890',
        newText: '- 代理地址 127.0.0.1:7891',
        proposedSummary: '联调代理已改为 7891，勿泄露 。',
        changeSummary: '依据 m-234src 更新联调代理端口为 7891',
        reason: 'm-234src 已将本地代理切换至 7891',
      },
    })
  })

  it('canReconcileTarget 严守场域流向与互斥场景边界，selectReconcileSeeds 限制种子数量与窗口', () => {
    const workMac = makeEntryRow({
      id: '20000000-0000-4000-8000-000000000001',
      shortId: 'm-234a01',
      realms: ['work'],
      envs: ['mac'],
      projects: ['kioku'],
    })
    const globalMac = makeEntryRow({
      id: '20000000-0000-4000-8000-000000000002',
      shortId: 'm-234a02',
      realms: [],
      envs: ['mac'],
      projects: ['kioku'],
    })
    const workLinux = makeEntryRow({
      id: '20000000-0000-4000-8000-000000000003',
      shortId: 'm-234a03',
      realms: ['work'],
      envs: ['linux'],
      projects: ['kioku'],
    })
    const workOtherProj = makeEntryRow({
      id: '20000000-0000-4000-8000-000000000004',
      shortId: 'm-234a04',
      realms: ['work'],
      envs: ['mac'],
      projects: ['other-repo'],
    })

    expect(canReconcileTarget(workMac, workMac)).toBe(false)
    expect(canReconcileTarget(workMac, globalMac)).toBe(false)
    expect(canReconcileTarget(globalMac, workMac)).toBe(true)
    expect(canReconcileTarget(workMac, workLinux)).toBe(false)
    expect(canReconcileTarget(workMac, workOtherProj)).toBe(false)

    const now = new Date('2026-11-27T00:00:00.000Z')
    const seeds = Array.from({ length: 6 }, (_, idx) =>
      makeEntryRow({
        id: `30000000-0000-4000-8000-00000000000${idx + 1}`,
        shortId: `m-234s0${idx + 1}`,
        version: idx === 5 ? 2 : 1,
        dreamCheckedVersion: idx === 5 ? 1 : 1,
        verifiedAt: new Date(now.getTime() - idx * 10 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - idx * 10 * 24 * 60 * 60 * 1000),
      }),
    )

    // 单条模式直接锚定目标
    expect(
      selectReconcileSeeds([seeds[4]!], { scope: 'incremental', isSingleTarget: true, now }).map(
        (r) => r.shortId,
      ),
    ).toEqual(['m-234s05'])

    // 增量模式优先未复核条目且最多 4 条
    const incSeeds = selectReconcileSeeds(seeds, {
      scope: 'incremental',
      isSingleTarget: false,
      now,
    })
    expect(incSeeds).toHaveLength(4)
    expect(incSeeds[0]?.shortId).toBe('m-234s06')

    // 全库模式按 verifiedAt ?? createdAt 判定近 30 天窗口，不被纯整理刷新 updatedAt 误拉入
    const oldMaintained = makeEntryRow({
      id: '30000000-0000-4000-8000-000000000009',
      shortId: 'm-234old',
      verifiedAt: null,
      createdAt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
      updatedAt: now,
    })
    const fullSeeds = selectReconcileSeeds([...seeds, oldMaintained], {
      scope: 'full_corpus',
      isSingleTarget: false,
      now,
    })
    expect(fullSeeds.map((r) => r.shortId)).toEqual([
      'm-234s01',
      'm-234s02',
      'm-234s03',
      'm-234s04',
    ])

    expect(computeCrossMemoryTaskMaxTokens('reconcile_locate')).toBe(1_500)
    expect(computeCrossMemoryTaskMaxTokens('reconcile_patch', 2_000)).toBe(4_200)
  })
})

describe('跨记忆关联对账两阶段执行与抽屉可见性', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDatabaseNow.mockResolvedValue(new Date('2026-11-27T01:00:00.000Z'))
    mockLoadResolvedModel.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:18999/v1',
      model: 'test-chat',
      apiKey: null,
    })
  })

  it('单条查重通过反向入链召回旧记忆 B，仅局部修补命中二级小节并在抽屉返回 B 的建议', async () => {
    const entryA = makeEntryRow({
      id: '40000000-0000-4000-8000-000000000001',
      shortId: 'm-234aaa',
      title: '代理服务新端口',
      summary: '代理监听端口已切换至 7891。',
      content: '代理服务现监听 127.0.0.1:7891，旧端口 7890 已下线。',
      version: 3,
      verifiedAt: new Date('2026-11-27T00:00:00.000Z'),
      lastChangeSummary: '代理端口由 7890 改为 7891',
    })
    const entryB = makeEntryRow({
      id: '40000000-0000-4000-8000-000000000002',
      shortId: 'm-234bbb',
      title: '日常联调手册',
      summary: '使用 7890 代理联调。',
      content: [
        '## 历史对照',
        '- 旧配置记录：7890',
        '',
        '## 当前联调配置',
        '- 本地代理：127.0.0.1:7890，详见 [[m-234aaa]]',
        '- 认证凭据：{{cred:proxy-auth}}',
      ].join('\n'),
      version: 1,
      verifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    })

    const { db, insertedSuggestions } = makeFakeFunnelDb({
      allEntries: [entryA, entryB],
      links: [{ sourceEntryId: entryB.id, targetShortId: entryA.shortId }],
      singleTarget: entryA,
    })

    // 顺序：1) reconcile 定位；2) reconcile 单小节补丁；3) links 巡检
    mockChatComplete
      .mockResolvedValueOnce({
        content: JSON.stringify({
          conflicts: [
            {
              target_short_id: entryB.shortId,
              section_heading: '当前联调配置',
              conflict_reason: '本地代理端口 7890 已被 m-234aaa 更新为 7891',
            },
          ],
        }),
        promptTokens: 120,
        completionTokens: 40,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          needed: true,
          old_text: '- 本地代理：127.0.0.1:7890，详见 [[m-234aaa]]',
          new_text: '- 本地代理：127.0.0.1:7891，详见 [[m-234aaa]]',
          proposed_summary: '使用 7891 代理联调。',
          change_summary: '同步 m-234aaa 的新代理端口 7891',
          reason: '依据 m-234aaa 修订过时代理端口',
        }),
        promptTokens: 150,
        completionTokens: 60,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ suggestions: [] }),
        promptTokens: 100,
        completionTokens: 10,
      })

    const res = await runSingleCrossCheck(db, null, entryA.shortId)
    const parsed = SingleCrossCheckResponse.parse(res)

    expect(parsed.consideredNeighbors).toBe(1)
    expect(parsed.createdCount).toBe(1)
    expect(parsed.suggestions).toHaveLength(1)
    expect(parsed.suggestions[0]?.kind).toBe('update')
    expect(parsed.suggestions[0]?.entryIds).toEqual([entryB.id])
    expect(parsed.suggestions[0]?.proposedSummary).toBe('使用 7891 代理联调。')
    expect(parsed.suggestions[0]?.proposedContent).toContain('## 历史对照\n- 旧配置记录：7890')
    expect(parsed.suggestions[0]?.proposedContent).toContain(
      '## 当前联调配置\n- 本地代理：127.0.0.1:7891，详见 [[m-234aaa]]',
    )
    expect(parsed.suggestions[0]?.proposedContent).toContain('{{cred:proxy-auth}}')

    expect(insertedSuggestions).toHaveLength(1)
    const expectedFp = suggestionFingerprint(
      'update',
      [entryB.id],
      [entryB.version],
      reconcileActionDiscriminator(entryA.shortId, entryA.version),
    )
    expect(insertedSuggestions[0]?.fingerprint).toBe(expectedFp)
  })

  it('同指纹已存在时跳过候选 B 避免重复消耗调用', async () => {
    const entryA = makeEntryRow({
      id: '50000000-0000-4000-8000-000000000001',
      shortId: 'm-234aa5',
      projects: [],
      version: 2,
    })
    const entryB = makeEntryRow({
      id: '50000000-0000-4000-8000-000000000002',
      shortId: 'm-234bb5',
      projects: [],
      version: 1,
    })

    const existingFp = suggestionFingerprint(
      'update',
      [entryB.id],
      [entryB.version],
      reconcileActionDiscriminator(entryA.shortId, entryA.version),
    )
    const { db } = makeFakeFunnelDb({
      allEntries: [entryA, entryB],
      links: [{ sourceEntryId: entryA.id, targetShortId: entryB.shortId }],
      existingSuggestions: [
        {
          fingerprint: existingFp,
          kind: 'update',
          entryIds: [entryB.id],
          entryVersions: [entryB.version],
        },
      ],
    })

    const out = await runCrossMemoryFunnel(
      db,
      {
        baseUrl: 'http://127.0.0.1:18999/v1',
        model: 'test-chat',
        apiKey: null,
        reasoningEffort: 'off',
        taskReasoningEffort: { fast: 'off', organize: 'off' },
      },
      { scope: 'incremental', targetShortIds: [entryA.shortId], maxCalls: 6 },
    )
    expect(out.result.outcome).toBe('skipped')
    expect(out.consideredNeighbors).toBe(1)
    expect(out.matchedPendingIds).toHaveLength(1)
    expect(mockChatComplete).not.toHaveBeenCalled()
  })

  it('补丁丢失双链/凭据或命中小节超过 4000 字时安全拦截不入库', async () => {
    const entryA = makeEntryRow({
      id: '60000000-0000-4000-8000-000000000001',
      shortId: 'm-234aa6',
      projects: [],
      version: 2,
    })
    const entryDropLink = makeEntryRow({
      id: '60000000-0000-4000-8000-000000000002',
      shortId: 'm-234bb6',
      projects: [],
      content: '## 代理\n- 端口 7890 参考 [[m-234aa6]] {{cred:proxy-key}}',
      version: 1,
    })
    const entryOversized = makeEntryRow({
      id: '60000000-0000-4000-8000-000000000003',
      shortId: 'm-234cc6',
      projects: [],
      content: `## 超长小节\n${'长段说明文字。'.repeat(700)}`,
      version: 1,
    })

    const { db, insertedSuggestions } = makeFakeFunnelDb({
      allEntries: [entryA, entryDropLink, entryOversized],
      links: [
        { sourceEntryId: entryA.id, targetShortId: entryDropLink.shortId },
        { sourceEntryId: entryA.id, targetShortId: entryOversized.shortId },
      ],
    })

    mockChatComplete
      .mockResolvedValueOnce({
        content: JSON.stringify({
          conflicts: [
            {
              target_short_id: entryDropLink.shortId,
              section_heading: '代理',
              conflict_reason: '端口需更新',
            },
            {
              target_short_id: entryOversized.shortId,
              section_heading: '超长小节',
              conflict_reason: '小节内容过时',
            },
          ],
        }),
        promptTokens: 100,
        completionTokens: 40,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          needed: true,
          old_text: '- 端口 7890 参考 [[m-234aa6]] {{cred:proxy-key}}',
          new_text: '- 端口 7891',
          change_summary: '误删了双链与凭据占位符',
          reason: '更新端口',
        }),
        promptTokens: 100,
        completionTokens: 40,
      })

    const out = await runCrossMemoryFunnel(
      db,
      {
        baseUrl: 'http://127.0.0.1:18999/v1',
        model: 'test-chat',
        apiKey: null,
        reasoningEffort: 'off',
        taskReasoningEffort: { fast: 'off', organize: 'off' },
      },
      { scope: 'incremental', targetShortIds: [entryA.shortId], maxCalls: 6 },
    )

    // 仅调用 2 次：1 次定位 + 1 次 entryDropLink 补丁；entryOversized 超 4000 字直接跳过未发补丁请求
    expect(mockChatComplete).toHaveBeenCalledTimes(2)
    expect(insertedSuggestions).toHaveLength(0)
    expect(out.result.suggested).toBe(0)
    expect(out.result.outcome).toBe('ok')
  })

  it('0.65-0.70 向量近邻仅进入 reconcile 而不进入 Task B links，且严格遵守 maxCalls 配额', async () => {
    const entryA = makeEntryRow({
      id: '70000000-0000-4000-8000-000000000001',
      shortId: 'm-234aa7',
      projects: [],
      version: 2,
    })
    const entryB = makeEntryRow({
      id: '70000000-0000-4000-8000-000000000002',
      shortId: 'm-234bb7',
      projects: [],
      content: '旧值 7890，需更新。',
      version: 1,
    })
    const entryC = makeEntryRow({
      id: '70000000-0000-4000-8000-000000000003',
      shortId: 'm-234cc7',
      projects: [],
      content: '另一条旧值 7890。',
      version: 1,
    })

    const { db, insertedSuggestions } = makeFakeFunnelDb({
      allEntries: [entryA, entryB, entryC],
      vectorPairs: [
        { entry_a: entryA.id, entry_b: entryB.id, sim: 0.67 },
        { entry_a: entryA.id, entry_b: entryC.id, sim: 0.66 },
      ],
    })

    mockChatComplete
      .mockResolvedValueOnce({
        content: JSON.stringify({
          conflicts: [
            {
              target_short_id: entryB.shortId,
              section_heading: null,
              conflict_reason: 'B 端口过时',
            },
            {
              target_short_id: entryC.shortId,
              section_heading: null,
              conflict_reason: 'C 端口过时',
            },
          ],
        }),
        promptTokens: 100,
        completionTokens: 40,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          needed: true,
          old_text: '旧值 7890',
          new_text: '新值 7891',
          change_summary: '更新 B 端口',
          reason: '依据 m-234aa7 修订',
        }),
        promptTokens: 100,
        completionTokens: 40,
      })

    const out = await runCrossMemoryFunnel(
      db,
      {
        baseUrl: 'http://127.0.0.1:18999/v1',
        model: 'test-chat',
        apiKey: null,
        reasoningEffort: 'off',
        taskReasoningEffort: { fast: 'off', organize: 'off' },
      },
      { scope: 'incremental', targetShortIds: [entryA.shortId], maxCalls: 2 },
    )

    // maxCalls=2：仅执行 1 次定位 + 1 次补丁（B），C 受额度保护跳过；0.67/0.66 未进入 links
    expect(mockChatComplete).toHaveBeenCalledTimes(2)
    expect(insertedSuggestions).toHaveLength(1)
    expect(insertedSuggestions[0]?.entryIds).toEqual([entryB.id])
    expect(insertedSuggestions[0]?.proposedContent).toBe('新值 7891，需更新。')
    expect(out.consideredNeighbors).toBe(2)
  })

  it('仅余 1 次调用额度时跳过两阶段 reconcile 让位于单次 links，且超长被 cluster 截断的旧记忆仍可进入 reconcile', async () => {
    const conn = {
      baseUrl: 'http://127.0.0.1:18999/v1',
      model: 'test-chat',
      apiKey: null,
      reasoningEffort: 'off' as const,
      taskReasoningEffort: { fast: 'off' as const, organize: 'off' as const },
    }

    // 1. maxCalls=1：reconcile 需要至少 2 次调用被跳过，额度留给只需 1 次调用的 links
    const entryA = makeEntryRow({
      id: '80000000-0000-4000-8000-000000000001',
      shortId: 'm-234aa8',
      projects: ['kioku'],
      version: 2,
    })
    const entryB = makeEntryRow({
      id: '80000000-0000-4000-8000-000000000002',
      shortId: 'm-234bb8',
      projects: ['kioku'],
      version: 1,
    })
    const { db: budgetDb } = makeFakeFunnelDb({
      allEntries: [entryA, entryB],
      vectorPairs: [{ entry_a: entryA.id, entry_b: entryB.id, sim: 0.76 }],
    })
    mockChatComplete.mockResolvedValueOnce({
      content: JSON.stringify({ suggestions: [] }),
      promptTokens: 80,
      completionTokens: 10,
    })

    const budgetOut = await runCrossMemoryFunnel(budgetDb, conn, {
      scope: 'incremental',
      targetShortIds: [entryA.shortId],
      maxCalls: 1,
    })
    expect(mockChatComplete).toHaveBeenCalledTimes(1)
    const calledSys = String(mockChatComplete.mock.calls[0]?.[1]?.[0]?.content ?? '')
    expect(calledSys).toContain('双链关联审阅助手')
    expect(budgetOut.result.outcome).toBe('ok')

    // 2. 超长旧记忆（> 8000 字）虽与 A 高相似（0.90）进簇但被 cluster 截断，不得被排除出 reconcile
    vi.clearAllMocks()
    mockDatabaseNow.mockResolvedValue(new Date('2026-11-27T01:00:00.000Z'))
    const longTarget = makeEntryRow({
      id: '80000000-0000-4000-8000-000000000003',
      shortId: 'm-234lg8',
      projects: ['kioku'],
      content: `## 拓扑说明\n${'大段历史拓扑与端口规划说明文字。'.repeat(550)}\n\n## 代理配置\n- 端口 7890`,
      version: 1,
    })
    expect(longTarget.content.length).toBeGreaterThan(8_000)

    const { db: longDb, insertedSuggestions: longInserted } = makeFakeFunnelDb({
      allEntries: [entryA, longTarget],
      vectorPairs: [{ entry_a: entryA.id, entry_b: longTarget.id, sim: 0.9 }],
    })
    // 调用顺序：1) cluster 审阅（空） 2) reconcile 定位 3) reconcile 单小节补丁 4) links（同项目）
    mockChatComplete
      .mockResolvedValueOnce({
        content: JSON.stringify({ suggestions: [] }),
        promptTokens: 100,
        completionTokens: 10,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          conflicts: [
            {
              target_short_id: longTarget.shortId,
              section_heading: '代理配置',
              conflict_reason: '端口 7890 已变更为 7891',
            },
          ],
        }),
        promptTokens: 100,
        completionTokens: 30,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          needed: true,
          old_text: '- 端口 7890',
          new_text: '- 端口 7891',
          change_summary: '更新超长记忆的代理端口小节',
          reason: '依据 m-234aa8 同步端口变更',
        }),
        promptTokens: 100,
        completionTokens: 30,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ suggestions: [] }),
        promptTokens: 80,
        completionTokens: 10,
      })

    const longOut = await runCrossMemoryFunnel(longDb, conn, {
      scope: 'incremental',
      targetShortIds: [entryA.shortId],
      maxCalls: 6,
    })
    expect(longOut.result.outcome).toBe('ok')
    expect(longInserted).toHaveLength(1)
    expect(longInserted[0]?.entryIds).toEqual([longTarget.id])
    expect(longInserted[0]?.proposedContent).toContain('## 代理配置\n- 端口 7891')
  })

  it('独立分区向量召回防大簇饿死、向量全被过滤时正常触发 FTS 兜底、且复查保留簇级待确认建议', async () => {
    const conn = {
      baseUrl: 'http://127.0.0.1:18999/v1',
      model: 'test-chat',
      apiKey: null,
      reasoningEffort: 'off' as const,
      taskReasoningEffort: { fast: 'off' as const, organize: 'off' as const },
    }

    // 1. 向量阶段仅返回不合法的窄->宽目标被过滤（vecAddedCount === 0）时，必须触发 FTS 兜底召回合格候选
    const workSeed = makeEntryRow({
      id: '81000000-0000-4000-8000-000000000001',
      shortId: 'm-234ws1',
      realms: ['work'],
      projects: [],
      version: 2,
    })
    const globalBlocked = makeEntryRow({
      id: '81000000-0000-4000-8000-000000000002',
      shortId: 'm-234gb1',
      realms: [],
      projects: [],
      version: 1,
    })
    const workFtsTarget = makeEntryRow({
      id: '81000000-0000-4000-8000-000000000003',
      shortId: 'm-234wf1',
      realms: ['work'],
      projects: [],
      content: '旧代理端口 7890。',
      version: 1,
    })
    const { db: ftsDb, insertedSuggestions: ftsInserted } = makeFakeFunnelDb({
      allEntries: [workSeed, globalBlocked, workFtsTarget],
      vectorPairs: [{ entry_a: workSeed.id, entry_b: globalBlocked.id, sim: 0.72 }],
      reconcileVectorPairs: [{ entry_a: workSeed.id, entry_b: globalBlocked.id, sim: 0.72 }],
      ftsResultIds: [workFtsTarget.id],
    })
    mockChatComplete
      .mockResolvedValueOnce({
        content: JSON.stringify({
          conflicts: [
            {
              target_short_id: workFtsTarget.shortId,
              section_heading: null,
              conflict_reason: '端口需更新',
            },
          ],
        }),
        promptTokens: 80,
        completionTokens: 30,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          needed: true,
          old_text: '旧代理端口 7890',
          new_text: '新代理端口 7891',
          change_summary: '更新代理端口',
          reason: '依据 m-234ws1 修订',
        }),
        promptTokens: 80,
        completionTokens: 30,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ suggestions: [] }),
        promptTokens: 60,
        completionTokens: 10,
      })

    const ftsOut = await runCrossMemoryFunnel(ftsDb, conn, {
      scope: 'incremental',
      targetShortIds: [workSeed.shortId],
      maxCalls: 6,
    })
    expect(ftsOut.result.outcome).toBe('ok')
    expect(ftsInserted).toHaveLength(1)
    expect(ftsInserted[0]?.entryIds).toEqual([workFtsTarget.id])

    // 2. 簇内已有 from:<anchor> 待确认建议时，二次单条查重通过 matchedPendingIds 保持抽屉可见
    vi.clearAllMocks()
    mockDatabaseNow.mockResolvedValue(new Date('2026-11-27T01:00:00.000Z'))
    mockLoadResolvedModel.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:18999/v1',
      model: 'test-chat',
      apiKey: null,
    })
    const anchor = makeEntryRow({
      id: '82000000-0000-4000-8000-000000000001',
      shortId: 'm-234an2',
      projects: [],
      version: 2,
    })
    const peer = makeEntryRow({
      id: '82000000-0000-4000-8000-000000000002',
      shortId: 'm-234pr2',
      projects: [],
      version: 1,
    })
    const clusterMergeFp = suggestionFingerprint(
      'merge_duplicates',
      [anchor.id, peer.id],
      [anchor.version, peer.version],
    )
    const peerFromFp = suggestionFingerprint(
      'update',
      [peer.id],
      [peer.version],
      `from:${anchor.shortId}`,
    )
    const peerUpdateId = '91000000-0000-4000-8000-000000000001'
    const { db: clusterDb } = makeFakeFunnelDb({
      allEntries: [anchor, peer],
      vectorPairs: [{ entry_a: anchor.id, entry_b: peer.id, sim: 0.9 }],
      existingSuggestions: [
        {
          id: '91000000-0000-4000-8000-000000000002',
          status: 'rejected',
          fingerprint: clusterMergeFp,
          kind: 'merge_duplicates',
          entryIds: [anchor.id, peer.id],
          entryVersions: [anchor.version, peer.version],
        },
        {
          id: peerUpdateId,
          status: 'pending',
          fingerprint: peerFromFp,
          kind: 'update',
          entryIds: [peer.id],
          entryVersions: [peer.version],
        },
      ],
      singleTarget: anchor,
    })
    mockChatComplete.mockResolvedValueOnce({
      content: JSON.stringify({ conflicts: [] }),
      promptTokens: 80,
      completionTokens: 10,
    })

    const reopenRes = await runSingleCrossCheck(clusterDb, null, anchor.shortId)
    const parsedReopen = SingleCrossCheckResponse.parse(reopenRes)
    expect(parsedReopen.suggestions.some((s) => s.id === peerUpdateId)).toBe(true)
  })
})
