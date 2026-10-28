import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { staticEmbedderSource } from '../../embedding/source'
import type { Database } from '../../db/client'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bearer, bootstrap } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('MCP 接口', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let key: string

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: null,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    const ws = await bootstrap(app)
    key = await ws.issueKey((await ws.createApp('claude-code')).id)
  })

  let id = 0
  async function rpc(method: string, params: unknown, k = key) {
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: {
        ...bearer(k),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    })
    // 测试里按需取字段，这里放宽类型
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = res.status === 200 ? await res.json() : await res.text()
    return { status: res.status, body }
  }
  const callTool = async (name: string, args: Record<string, unknown>) =>
    (await rpc('tools/call', { name, arguments: args })).body.result as {
      content: { text: string }[]
      isError?: boolean
    }

  it('没有 Key 返回 401', async () => {
    const res = await app.request('/v1/mcp', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  it('初始化并列出工具', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    expect(init.body.result.serverInfo.name).toBe('kioku')
    const tools = await rpc('tools/list', {})
    expect(tools.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'kioku_boot',
      'kioku_create',
      'kioku_credential',
      'kioku_credential_delete',
      'kioku_credential_save',
      'kioku_delete',
      'kioku_get',
      'kioku_list',
      'kioku_move',
      'kioku_search',
      'kioku_update',
    ])
    // 输入 schema 里不能有 $ref 与 definitions：不少调工具的后端不认。契约里起了名的 schema
    // 会进 zod 的全局注册表，工具的输入 schema 也按它生成，所以工具参数用到的枚举不起名
    for (const tool of tools.body.result.tools as { name: string; inputSchema: unknown }[]) {
      const schema = JSON.stringify(tool.inputSchema)
      expect(schema, tool.name).not.toContain('$ref')
      expect(schema, tool.name).not.toContain('definitions')
    }
  })

  it('通过工具创建、读取、浏览', async () => {
    const created = await callTool('kioku_create', {
      uri: 'core://agent',
      content: '先读正文再信任',
      layer: 'base',
      disclosure: '每次会话开始',
      glossary: ['规则'],
    })
    expect(created.isError).toBeFalsy()
    const got = await callTool('kioku_get', { uri: 'core://agent' })
    expect(got.content[0]!.text).toContain('先读正文再信任')
    expect(got.content[0]!.text).toContain('Disclosure: 每次会话开始')
    const domains = await callTool('kioku_list', {})
    expect(domains.content[0]!.text).toContain('core://（1 个节点）')
  })

  it('kioku_update 能在 owner 与 private 之间改层，不能改成共享的层', async () => {
    await callTool('kioku_create', { uri: 'notes://plan', content: '计划' })
    const toOwner = await callTool('kioku_update', { uri: 'notes://plan', layer: 'owner' })
    expect(toOwner.isError).toBeFalsy()
    expect(toOwner.content[0]!.text).toContain('owner')
    const toBase = await callTool('kioku_update', { uri: 'notes://plan', layer: 'base' })
    expect(toBase.isError).toBe(true)
    expect(toBase.content[0]!.text).toContain('管理界面')
  })

  it('业务错误作为工具错误返回', async () => {
    const missing = await callTool('kioku_get', { uri: 'core://nope' })
    expect(missing.isError).toBe(true)
    expect(missing.content[0]!.text).toContain('不存在')
  })
})
