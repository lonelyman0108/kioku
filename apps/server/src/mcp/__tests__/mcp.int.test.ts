import { CredentialMeta, EntryBrowseResponse, EntryDetailResponse } from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import {
  createTestApp,
  issueTestApiKey,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'

async function mcpRpc(
  app: ReturnType<typeof createTestApp>,
  key: string,
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request('/v1/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const text = await res.text()
  // Streamable HTTP 可能回纯 JSON 或 SSE data 行，两种都解析
  const jsonText = text.startsWith('event:')
    ? (text
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .pop() ?? '{}')
    : text
  return { status: res.status, body: JSON.parse(jsonText) as Record<string, unknown> }
}

describe.skipIf(!testDatabaseUrl)('无状态 MCP 服务与 9 个扁平工具', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await database.close()
  })

  it('GET /v1/mcp 返回 405，tools/list 暴露 9 个工具且全链路 CRUD/检索/凭据元数据隔离生效', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const credSvc = new CredentialService(database.db, masterKey)

    await credSvc.create({
      slug: 'work-token',
      label: 'Work Token',
      description: '发布流水线凭据',
      value: 'SUPER_SECRET_NEVER_IN_MCP',
      allowedRealms: ['work'],
    })
    await credSvc.create({
      slug: 'personal-token',
      label: 'Personal Token',
      value: 'PERSONAL_SECRET',
      allowedRealms: ['personal'],
    })

    const workKey = await issueTestApiKey(database, {
      runtimeFamily: 'claudecode',
      envs: ['mac'],
      allowedRealms: ['work'],
      canWrite: true,
      canResolveCredentials: true,
    })
    const readOnlyKey = await issueTestApiKey(database, {
      runtimeFamily: 'mcp',
      allowedRealms: ['work'],
      canWrite: false,
      canResolveCredentials: false,
    })

    // GET /v1/mcp 不提供长连接 SSE，返回 405
    const getRes = await app.request('/v1/mcp', {
      headers: { authorization: `Bearer ${workKey.key}` },
    })
    expect(getRes.status).toBe(405)

    // 1. tools/list 恰好暴露 9 个工具（含只读 kioku_history）
    const listRes = await mcpRpc(app, workKey.key, 'tools/list')
    expect(listRes.status).toBe(200)
    const tools = (listRes.body.result as { tools: { name: string }[] }).tools
    expect(tools.map((t) => t.name).sort()).toEqual([
      'kioku_boot',
      'kioku_browse',
      'kioku_create',
      'kioku_delete',
      'kioku_get',
      'kioku_history',
      'kioku_list_credentials',
      'kioku_search',
      'kioku_update',
    ])

    // 2. kioku_create 创建常驻词条并附带 structuredContent
    const created = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_create',
      arguments: {
        title: '服务发布手册',
        content: '发布前先运行全量门禁，需要凭据时引用 {{cred:work-token}}。',
        is_pinned: true,
        envs: ['mac'],
        realms: ['work'],
        projects: ['kioku'],
        topics: ['release'],
      },
    })
    const createResult = created.body.result as {
      content: { text: string }[]
      structuredContent?: unknown
      isError?: boolean
    }
    const createText = createResult.content[0]!.text
    expect(createResult.isError).not.toBe(true)
    const createdDetail = EntryDetailResponse.parse(createResult.structuredContent)
    expect(createdDetail.entry.title).toBe('服务发布手册')
    expect(createdDetail.entry.version).toBe(1)
    expect(createdDetail.credentialRefs).toMatchObject([{ slug: 'work-token', available: true }])
    const shortIdMatch = createText.match(/m-[2-9a-hjkmnp-tv-z]{6,8}/)
    expect(shortIdMatch).not.toBeNull()
    const shortId = shortIdMatch![0]!
    expect(createdDetail.entry.shortId).toBe(shortId)

    // 越权写入 personal 场域或显式写入无场域全局词条必须被拦截，省略 realms 时自动继承当前默认场域
    const autoInherited = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_create',
      arguments: {
        title: '默认场域继承验证',
        content: '省略 realms 时自动归入 work 场域。',
      },
    })
    const autoInheritedResult = autoInherited.body.result as {
      isError?: boolean
      structuredContent?: unknown
    }
    expect(autoInheritedResult.isError).not.toBe(true)
    expect(EntryDetailResponse.parse(autoInheritedResult.structuredContent).entry.realms).toEqual([
      'work',
    ])

    const explicitGlobal = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_create',
      arguments: {
        title: '显式空场域写穿',
        content: '受限密钥不得显式写入全局词条',
        realms: [],
      },
    })
    const explicitGlobalResult = explicitGlobal.body.result as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
    }
    expect(explicitGlobalResult.isError).toBe(true)
    expect(explicitGlobalResult.structuredContent).toMatchObject({ status: 403 })

    const crossRealm = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_create',
      arguments: {
        title: '越权词条',
        content: '不应写入',
        realms: ['personal'],
      },
    })
    const crossRealmResult = crossRealm.body.result as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
    }
    expect(crossRealmResult.isError).toBe(true)
    expect(crossRealmResult.structuredContent).toMatchObject({ status: 403 })
    expect(typeof crossRealmResult.structuredContent?.error).toBe('string')

    // 只读密钥写入必须被拦截
    const roCreate = await mcpRpc(app, readOnlyKey.key, 'tools/call', {
      name: 'kioku_create',
      arguments: { title: '只读测试', content: '不应写入' },
    })
    const roCreateResult = roCreate.body.result as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
    }
    expect(roCreateResult.isError).toBe(true)
    expect(roCreateResult.structuredContent).toMatchObject({ status: 403 })

    // 3. kioku_boot / kioku_search / kioku_get / kioku_browse
    const bootRes = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_boot',
      arguments: { project: 'kioku' },
    })
    expect((bootRes.body.result as { content: { text: string }[] }).content[0]!.text).toContain(
      shortId,
    )

    const searchRes = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_search',
      arguments: { query: '发布门禁' },
    })
    expect((searchRes.body.result as { content: { text: string }[] }).content[0]!.text).toContain(
      shortId,
    )

    const getResTool = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_get',
      arguments: { id: shortId },
    })
    const getResult = getResTool.body.result as {
      content: { text: string }[]
      structuredContent?: unknown
    }
    expect(getResult.content[0]!.text).toContain('服务发布手册')
    const fetchedDetail = EntryDetailResponse.parse(getResult.structuredContent)
    expect(fetchedDetail.entry.shortId).toBe(shortId)
    expect(fetchedDetail.entry.content).toContain('{{cred:work-token}}')

    // 查询不存在的词条应返回 isError 与 404 结构化错误
    const notFoundRes = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_get',
      arguments: { id: 'm-222222' },
    })
    const notFoundResult = notFoundRes.body.result as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
    }
    expect(notFoundResult.isError).toBe(true)
    expect(notFoundResult.structuredContent).toMatchObject({ status: 404 })
    expect(typeof notFoundResult.structuredContent?.error).toBe('string')

    const browseRes = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_browse',
      arguments: { group_by: 'project' },
    })
    const browseResult = browseRes.body.result as {
      content: { text: string }[]
      structuredContent?: unknown
    }
    expect(browseResult.content[0]!.text).toContain('kioku')
    const browsed = EntryBrowseResponse.parse(browseResult.structuredContent)
    expect(browsed.groupBy).toBe('project')
    expect(browsed.groups[0]?.items.map((item) => item.shortId)).toContain(shortId)

    // 4. kioku_list_credentials：只返回允许场域的元数据，永不泄露明文；无权限密钥返回空
    const credsRes = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_list_credentials',
      arguments: {},
    })
    const credsResult = credsRes.body.result as {
      content: { text: string }[]
      structuredContent?: { items?: unknown[] }
    }
    const credsText = credsResult.content[0]!.text
    expect(credsText).toContain('work-token')
    expect(credsText).not.toContain('personal-token')
    expect(credsText).not.toContain('SUPER_SECRET_NEVER_IN_MCP')
    const credItems = (credsResult.structuredContent?.items ?? []).map((item) =>
      CredentialMeta.parse(item),
    )
    expect(credItems.map((c) => c.slug)).toEqual(['work-token'])

    const noCredPerm = await mcpRpc(app, readOnlyKey.key, 'tools/call', {
      name: 'kioku_list_credentials',
      arguments: {},
    })
    const noCredResult = noCredPerm.body.result as {
      content: { text: string }[]
      structuredContent?: { items?: unknown[] }
    }
    const noCredText = noCredResult.content[0]!.text
    expect(noCredText).not.toContain('work-token')
    expect(noCredResult.structuredContent).toEqual({ items: [] })

    // 5. kioku_update（含乐观锁冲突 409）与 kioku_delete
    const updRes = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_update',
      arguments: { id: shortId, expected_version: 1, title: '服务发布手册（已更新）' },
    })
    const updResult = updRes.body.result as {
      isError?: boolean
      structuredContent?: unknown
    }
    expect(updResult.isError).not.toBe(true)
    const updatedDetail = EntryDetailResponse.parse(updResult.structuredContent)
    expect(updatedDetail.entry.title).toBe('服务发布手册（已更新）')
    expect(updatedDetail.entry.version).toBe(2)

    const conflictRes = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_update',
      arguments: { id: shortId, expected_version: 1, title: '过期版本写入' },
    })
    const conflictResult = conflictRes.body.result as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
    }
    expect(conflictResult.isError).toBe(true)
    expect(conflictResult.structuredContent).toMatchObject({ status: 409 })
    expect(typeof conflictResult.structuredContent?.error).toBe('string')

    const delRes = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_delete',
      arguments: { id: shortId },
    })
    const delResult = delRes.body.result as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
    }
    expect(delResult.isError).not.toBe(true)
    expect(delResult.structuredContent).toEqual({ deleted: true, id: shortId })
  })

  it('支持 kioku_get 大纲/小节直取、kioku_update 局部 patch 与软提醒，以及带场域隔离的 kioku_history', async () => {
    const masterKey = testMasterKey()
    const app = createTestApp(database, { masterKey })
    const workKey = await issueTestApiKey(database, {
      runtimeFamily: 'claudecode',
      allowedRealms: ['work'],
      canWrite: true,
    })
    const personalKey = await issueTestApiKey(database, {
      runtimeFamily: 'codex',
      allowedRealms: ['personal'],
      canWrite: true,
    })

    const created = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_create',
      arguments: {
        title: '网络架构手册',
        summary: '主路由负责拨号，核心交换负责万兆汇聚。',
        content: [
          '# 网络架构手册',
          '',
          '## 拓扑结构',
          '- 主路由 127.0.0.1',
          '',
          '## 关键禁令',
          '- 严禁破坏既有端口划分',
        ].join('\n'),
        realms: ['work'],
        change_summary: '初始化网络架构手册',
      },
    })
    const createRes = created.body.result as {
      content: { text: string }[]
      structuredContent?: unknown
    }
    const detail = EntryDetailResponse.parse(createRes.structuredContent)
    expect(detail.warnings?.some((w) => w.code === 'content_repeats_title')).toBe(true)
    expect(createRes.content[0]!.text).toContain('更新：')
    expect(createRes.content[0]!.text).toContain('现行概要：主路由负责拨号')

    // kioku_get view=outline 与 section 按需直取
    const outlineRes = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_get',
      arguments: { id: detail.entry.shortId, view: 'outline' },
    })
    const outlineText = (outlineRes.body.result as { content: { text: string }[] }).content[0]!.text
    expect(outlineText).toContain('## 正文大纲')
    expect(outlineText).toContain('拓扑结构')
    expect(outlineText).toContain('关键禁令')

    const secRes = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_get',
      arguments: { id: detail.entry.shortId, section: '关键禁令' },
    })
    const secText = (secRes.body.result as { content: { text: string }[] }).content[0]!.text
    expect(secText).toContain('严禁破坏既有端口划分')
    expect(secText).not.toContain('主路由 127.0.0.1')

    // kioku_update 局部 patch + change_summary
    const patched = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_update',
      arguments: {
        id: detail.entry.shortId,
        expected_version: 1,
        patch: {
          kind: 'insert_under_heading',
          heading: '关键禁令',
          text: '- 变更前先导出配置快照',
        },
        change_summary: '补充变更前导出快照要求',
      },
    })
    const patchedDetail = EntryDetailResponse.parse(
      (patched.body.result as { structuredContent?: unknown }).structuredContent,
    )
    expect(patchedDetail.entry.version).toBe(2)
    expect(patchedDetail.entry.content).toContain('变更前先导出配置快照')
    expect(patchedDetail.entry.lastChangeSummary).toBe('补充变更前导出快照要求')

    // kioku_history 默认轻量时间线不返回大 snapshot；传 version 返回快照；跨场域密钥被 404 隔离
    const histTimeline = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_history',
      arguments: { id: detail.entry.shortId },
    })
    const histResult = histTimeline.body.result as {
      content: { text: string }[]
      structuredContent?: { items: Array<{ snapshot?: unknown; changeSummary?: string | null }> }
    }
    expect(histResult.content[0]!.text).toContain('补充变更前导出快照要求')
    expect(histResult.structuredContent?.items).toHaveLength(2)
    expect(histResult.structuredContent?.items[0]?.snapshot).toBeUndefined()

    const histV1 = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_history',
      arguments: { id: detail.entry.shortId, version: 1 },
    })
    const histV1Result = histV1.body.result as {
      content: { text: string }[]
      structuredContent?: { items: Array<{ snapshot?: { version: number } }> }
    }
    expect(histV1Result.content[0]!.text).toContain('历史版本')
    expect(histV1Result.structuredContent?.items[0]?.snapshot?.version).toBe(1)

    const crossRealmHist = await mcpRpc(app, personalKey.key, 'tools/call', {
      name: 'kioku_history',
      arguments: { id: detail.entry.shortId },
    })
    const crossResult = crossRealmHist.body.result as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
    }
    expect(crossResult.isError).toBe(true)
    expect(crossResult.structuredContent).toMatchObject({ status: 404 })

    // kioku_create 支持 boot_mode='index' 与自定义 runtimes，kioku_boot 支持 runtime 覆盖
    const indexCreated = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_create',
      arguments: {
        title: 'ZCode 索引参考',
        summary: '自定义客户端参考手册概要。',
        content: '详细参考内容。',
        realms: ['work'],
        runtimes: ['zcode'],
        boot_mode: 'index',
      },
    })
    const indexDetail = EntryDetailResponse.parse(
      (indexCreated.body.result as { structuredContent?: unknown }).structuredContent,
    )
    expect(indexDetail.entry.bootMode).toBe('index')
    expect(indexDetail.entry.isPinned).toBe(true)
    expect(indexDetail.entry.runtimes).toEqual(['zcode'])

    const zcodeBoot = await mcpRpc(app, workKey.key, 'tools/call', {
      name: 'kioku_boot',
      arguments: { runtime: 'zcode' },
    })
    const zcodeBootText = (zcodeBoot.body.result as { content: { text: string }[] }).content[0]!
      .text
    expect(zcodeBootText).toContain(indexDetail.entry.shortId)
    expect(zcodeBootText).toContain('## 常驻记忆目录')
  })
})
