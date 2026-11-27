import type { BootResponse, RecallCandidate, RecentEntry } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import type { CredentialService } from '../../credential/service'
import type { Deps, KeyPrincipal } from '../../http/env'
import { GUIDANCE } from '../../lifecycle/lifecycle'
import { handleMcpRequest } from '../../mcp/server'
import type { EntryService } from '../../memory/service'
import { bootEntryChars, bootHeading, formatBootBlock, formatRecentBlock } from '../boot'
import { formatRecallBlock } from '../recall'

describe('生命周期引导、MCP 工具描述与在场文本的短 ID / 场景露出', () => {
  it('GUIDANCE 同时涵盖单机边界写入规范与主对话顺口纠偏指引', () => {
    expect(GUIDANCE).toContain('单机专属配置')
    expect(GUIDANCE).toContain('适用机器和前提')
    expect(GUIDANCE).toContain('避免泛化为全局规则')
    expect(GUIDANCE).toContain('主对话纠偏')
    expect(GUIDANCE).toContain('kioku_get')
    expect(GUIDANCE).toContain('kioku_update')
    expect(GUIDANCE).toContain('patch')
    expect(GUIDANCE).toContain('change_summary')
  })

  it('formatBootBlock、formatRecentBlock 与 formatRecallBlock 清晰露出短 ID 与四维场景标签', () => {
    const boot: BootResponse = {
      entries: [
        {
          shortId: 'm-234abc',
          title: '本机代理端口约定',
          kind: 'entry',
          bootMode: 'full',
          bucket: 'context',
          content: '仅限 home-24 本机使用 7890 端口。',
          envs: ['home-24'],
          realms: ['work'],
          projects: ['kioku'],
          runtimes: ['claudecode'],
          updatedAt: '2026-10-05T10:00:00Z',
          version: 12,
          lastChangeSummary: '收紧至 home-24 单机',
        },
        {
          shortId: 'm-345bcd',
          title: '全局协作铁律',
          kind: 'entry',
          bootMode: 'full',
          bucket: 'global',
          content: '回复保持简洁直接。',
          envs: [],
          realms: [],
          projects: [],
          runtimes: [],
          updatedAt: '2026-10-05T10:00:00Z',
        },
      ],
      episodes: [],
      omitted: ['m-456cde'],
      omittedItems: [
        {
          shortId: 'm-456cde',
          title: '家宽网络拓扑参考',
          bootMode: 'index',
          reason: 'index',
          summary: '记录 home-24 与旁路由分流规则。',
          envs: ['home-24'],
          realms: ['personal'],
          projects: [],
          runtimes: [],
          updatedAt: '2026-10-05T10:00:00Z',
          charCount: 2_400,
        },
      ],
    }

    const renderedBoot = formatBootBlock(boot, GUIDANCE)
    expect(renderedBoot).toContain(
      '## 本机代理端口约定 (m-234abc) [kioku, home-24, work, claudecode] · 更新 2026-10-05（v12：收紧至 home-24 单机）',
    )
    expect(renderedBoot).toContain('## 全局协作铁律 (m-345bcd) · 更新 2026-10-05')
    expect(renderedBoot).toContain(
      '- m-456cde「家宽网络拓扑参考」 [home-24, personal] · 更新 2026-10-05 — 记录 home-24 与旁路由分流规则。（约 2.4k 字）',
    )

    // 字符预算计算把场景标签长度一并计入，与实际渲染长度一致
    const scopedEntry = boot.entries[0]!
    const plainChars = bootEntryChars(
      bootHeading(scopedEntry.shortId, scopedEntry.title),
      scopedEntry.content,
      {
        updatedAt: scopedEntry.updatedAt,
        version: scopedEntry.version,
        lastChangeSummary: scopedEntry.lastChangeSummary,
      },
    )
    const scopedChars = bootEntryChars(
      bootHeading(scopedEntry.shortId, scopedEntry.title),
      scopedEntry.content,
      scopedEntry,
    )
    expect(scopedChars - plainChars).toBe(' [kioku, home-24, work, claudecode]'.length)

    const recent: RecentEntry[] = [
      {
        shortId: 'm-567def',
        title: '调试端口配置',
        isPinned: false,
        summary: '仅 home-24 使用 55432 端口。',
        disclosure: null,
        envs: ['home-24'],
        projects: ['kioku'],
        realms: [],
        runtimes: [],
        updatedAt: '2026-10-05T10:00:00Z',
      },
    ]
    expect(formatRecentBlock(recent)).toContain(
      '- 调试端口配置 (m-567def) [kioku, home-24]（更新于 2026-10-05）',
    )

    const candidates: RecallCandidate[] = [
      {
        entryId: '00000000-0000-4000-8000-000000000009',
        shortId: 'm-678efg',
        title: '本机代理设置',
        kind: 'entry',
        isPinned: false,
        envs: ['home-24'],
        realms: ['work'],
        projects: ['kioku'],
        runtimes: ['codex'],
        summary: '仅在 home-24 启用 7890 代理。',
        disclosure: null,
        updatedAt: '2026-10-05T10:00:00Z',
        score: 0.86,
        via: ['fulltext'],
        cues: ['环境:home-24'],
      },
    ]
    const recalled = formatRecallBlock(candidates, 'sess-1')
    expect(recalled).toContain(
      '- (0.86) m-678efg「本机代理设置」 [kioku, home-24, work, codex] · 更新 2026-10-05',
    )
  })

  it('MCP tools/list 对 kioku_create 与 kioku_update 清楚说明主机边界、envs 交集语义与主对话纠偏', async () => {
    const dummyKey: KeyPrincipal = {
      kind: 'key',
      keyId: '00000000-0000-4000-8000-000000000010',
      name: 'Test Terminal',
      prefix: 'kk_test',
      runtimeFamily: 'claudecode',
      envs: ['mac', 'home-24'],
      allowedRealms: null,
      canWrite: true,
      canResolveCredentials: false,
    }
    const req = new Request('http://127.0.0.1/v1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })

    const res = await handleMcpRequest(
      {} as Deps,
      dummyKey,
      {} as EntryService,
      {} as CredentialService,
      req,
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as {
      result: {
        tools: Array<{
          name: string
          description?: string
          inputSchema?: { properties?: Record<string, { description?: string }> }
        }>
      }
    }

    const createTool = payload.result.tools.find((t) => t.name === 'kioku_create')
    const updateTool = payload.result.tools.find((t) => t.name === 'kioku_update')
    expect(createTool?.description).toContain('单机特例须写清适用主机与前提')
    expect(createTool?.inputSchema?.properties?.envs?.description).toContain('home-24')
    expect(createTool?.inputSchema?.properties?.envs?.description).toContain('交集匹配')
    expect(createTool?.inputSchema?.properties?.envs?.description).toContain('仅标主机标识')
    expect(updateTool?.description).toContain('主对话中根据用户纠偏收紧记忆适用范围')
    expect(updateTool?.description).toContain('patch')
    expect(updateTool?.description).toContain('envs/projects/disclosure')
    expect(updateTool?.inputSchema?.properties?.envs?.description).toContain('home-24')
  })
})
