import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { credentialServiceForKey } from '../../credential/context'
import { staticEmbedderSource } from '../../embedding/source'
import type { Database, Db, Tx } from '../../db/client'
import type { Deps, KeyPrincipal } from '../../http/env'
import { memoryServiceForKey, recallScopeForKey } from '../../memory/context'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bearer, bootstrap, FULL_SCOPES } from '../../testing/fixtures'
import { TOOL_INTERNAL_ERROR } from '../format'
import { handleMcpRequest } from '../server'

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

  it('kioku_create 与 kioku_update 能设、清掉有效到，设在过去时返回工具错误', async () => {
    const tools = await rpc('tools/list', {})
    const schemaOf = (name: string) =>
      (tools.body.result.tools as { name: string; inputSchema: { properties: object } }[]).find(
        (t) => t.name === name,
      )!.inputSchema.properties
    expect(schemaOf('kioku_create')).toHaveProperty('valid_to')
    expect(schemaOf('kioku_update')).toHaveProperty('valid_to')

    const until = new Date(Date.now() + 86_400_000).toISOString()
    const created = await callTool('kioku_create', {
      uri: 'trip://plan',
      content: '下周出差',
      valid_to: until,
    })
    expect(created.isError).toBeFalsy()
    expect(created.content[0]!.text).toContain(`有效到: ${until}`)
    expect((await callTool('kioku_get', { uri: 'trip://plan' })).content[0]!.text).toContain(
      `有效到: ${until}`,
    )
    const past = await callTool('kioku_update', {
      uri: 'trip://plan',
      valid_to: new Date(Date.now() - 60_000).toISOString(),
    })
    expect(past.isError).toBe(true)
    expect(past.content[0]!.text).toContain('晚于当前时间至少一分钟')
    const cleared = await callTool('kioku_update', { uri: 'trip://plan', valid_to: null })
    expect(cleared.isError).toBeFalsy()
    expect(cleared.content[0]!.text).not.toContain('有效到')
  })

  it('业务错误作为工具错误返回', async () => {
    const missing = await callTool('kioku_get', { uri: 'core://nope' })
    expect(missing.isError).toBe(true)
    expect(missing.content[0]!.text).toContain('不存在')
  })

  describe('非业务错误', () => {
    // 数据库真的报错：事务一开始就语句超时。drizzle 的错误信息带 SQL 与全部参数
    const OVER_TIME = 60_000
    const statementFails = (db: Db) =>
      new Proxy(db, {
        get(target, prop) {
          if (prop !== 'transaction') return Reflect.get(target, prop)
          return (fn: (tx: Tx) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              await tx.execute(sql`set local statement_timeout = 1`)
              await tx.execute(sql`select pg_sleep(${OVER_TIME})`)
              return fn(tx)
            })
        },
      })
    const callWith = async (db: Db, args: Record<string, unknown>) => {
      const deps = { db, masterKey: null, jobs: null } as unknown as Deps
      const principal: KeyPrincipal = {
        kind: 'key',
        keyId: randomUUID(),
        spaceId: randomUUID(),
        scopes: FULL_SCOPES,
        app: {
          id: randomUUID(),
          slug: 'a',
          name: 'a',
          runtimeFamily: 'mcp',
          ownerAccountId: randomUUID(),
          defaultPersonaId: null,
          config: {},
        },
      }
      const res = await handleMcpRequest(
        memoryServiceForKey(deps, principal),
        recallScopeForKey(deps, principal),
        credentialServiceForKey(deps, principal),
        new Request('http://test.invalid/v1/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'kioku_create', arguments: args },
          }),
        }),
      )
      return ((await res.json()) as { result: { content: { text: string }[]; isError?: boolean } })
        .result
    }

    it('数据库报错：工具结果只有固定文字，日志只记 SQLSTATE 与说明，不带 SQL 与参数', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const result = await callWith(statementFails(database.db), {
          uri: 'notes://x',
          content: '不该出现在结果与日志里的正文',
        })
        expect(result.isError).toBe(true)
        expect(result.content[0]!.text).toBe(TOOL_INTERNAL_ERROR)
        expect(error).toHaveBeenCalledTimes(1)
        const logged = error.mock.calls[0]!
        expect(logged[1]).toMatchObject({ code: '57014' })
        expect(JSON.stringify(logged)).not.toContain('pg_sleep')
        expect(JSON.stringify(logged)).not.toContain(String(OVER_TIME))
      } finally {
        error.mockRestore()
      }
    })

    it('带着参数的错误信息也不进工具结果与日志（drizzle 把 SQL 与参数拼进 message）', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const cause = Object.assign(new Error('deadlock detected'), { code: '40P01' })
        const failing = new DrizzleQueryError('insert into memories', ['明文的参数'], cause)
        const db = { transaction: () => Promise.reject(failing) } as unknown as Db
        const result = await callWith(db, { uri: 'notes://x', content: '正文' })
        expect(result.content[0]!.text).toBe(TOOL_INTERNAL_ERROR)
        const logged = JSON.stringify(error.mock.calls[0])
        expect(logged).toContain('40P01')
        expect(logged).toContain('deadlock detected')
        expect(logged).not.toContain('明文的参数')
        expect(logged).not.toContain('insert into memories')
      } finally {
        error.mockRestore()
      }
    })

    it('不是数据库的错误：同样只回固定文字，日志带它自己的堆栈', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const db = { transaction: () => Promise.reject(new TypeError('坏了')) } as unknown as Db
        const result = await callWith(db, { uri: 'notes://x', content: '正文' })
        expect(result.content[0]!.text).toBe(TOOL_INTERNAL_ERROR)
        expect((error.mock.calls[0]![1] as { stack: string }).stack).toContain('坏了')
      } finally {
        error.mockRestore()
      }
    })
  })

  describe('GET', () => {
    it('带 Key 的 GET 返回 405，说明只收 POST；没有 Key 仍是 401', async () => {
      const res = await app.request('/v1/mcp', {
        headers: { ...bearer(key), accept: 'text/event-stream' },
      })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(((await res.json()) as { error: string }).error).toContain('GET')
      expect((await app.request('/v1/mcp')).status).toBe(401)
    })
  })
})
