import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { addMember, createPersonalCircle, createSharedCircle } from '../../access/circles'
import { createClient } from '../../access/clients'
import { issueClientKey } from '../../access/issue'
import { principalForKeyId } from '../../auth/middleware'
import { credentialServiceForKey } from '../../credential/context'
import { withCircle, type Database, type Db, type Tx } from '../../db/client'
import { accounts, legacyUris, settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { AppEnv, Deps, KeyPrincipal } from '../../http/env'
import { entryServiceForKey, recallScopeForKey } from '../../memory/context'
import { createTerm } from '../../memory/facets'
import { MemoryError } from '../../memory/errors'
import { settleRecallEvents } from '../../recall/events'
import { mcpRoutes } from '../../routes/mcp'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { TOOL_INTERNAL_ERROR } from '../format'
import { handleMcpRequest } from '../server'

async function seedAccount(db: Db, username: string) {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({ username, displayName: username, passwordHash: 'hash' })
      .returning()
    const personal = await createPersonalCircle(tx, account!)
    return { account: account!, personal }
  })
}

const FULL_LENS_SCOPES = {
  readKinds: ['entry' as const, 'fact' as const, 'episode' as const],
  writeKinds: ['entry' as const, 'fact' as const, 'episode' as const],
  maxSensitivity: 'secret' as const,
  allowedRealms: null,
  admin: false,
  credentials: 'manage' as const,
}

function buildTestMcpApp(deps: Deps) {
  const root = new Hono<AppEnv>()
  root.onError((err, c) => {
    if (err instanceof MemoryError) return c.json({ error: err.message }, err.status as never)
    throw err
  })
  root.route('/v1', mcpRoutes(deps))
  return root
}

describe.skipIf(!testDatabaseUrl)('MCP 接口', () => {
  let database: Database
  let deps: Deps
  let app: ReturnType<typeof buildTestMcpApp>
  let key: string
  let personalCircleId: string
  let sharedCircleId: string
  let aliceId: string

  beforeAll(async () => {
    database = await openTestDatabase()
    deps = {
      db: database.db,
      cookieSecure: false,
      masterKey: Buffer.alloc(32, 3),
      embedder: staticEmbedderSource(null),
      jobs: null,
    }
    app = buildTestMcpApp(deps)
  })

  afterEach(async () => {
    await settleRecallEvents()
  })

  afterAll(async () => {
    await settleRecallEvents()
    await database?.close()
  })

  beforeEach(async () => {
    await settleRecallEvents()
    await resetDatabase(database)
    await database.db.delete(settings)
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    aliceId = alice.id
    personalCircleId = personal.id
    const sRes = await createSharedCircle(database.db, {
      name: '研发共享圈',
      defaultFacets: { realm: ['work'] },
      ownerAccountId: alice.id,
    })
    if (!sRes.ok) throw new Error('建共享圈失败')
    sharedCircleId = sRes.value.id

    await withCircle(database.db, personalCircleId, async (tx) => {
      await createTerm(tx, personalCircleId, {
        dimensionKey: 'env',
        slug: 'mac',
        label: 'Mac',
        implies: {},
        aliases: [],
      })
      await createTerm(tx, personalCircleId, {
        dimensionKey: 'env',
        slug: 'win',
        label: 'Windows',
        implies: {},
        aliases: [],
      })
    })

    const issued = await withCircle(database.db, personalCircleId, async (tx) => {
      const cRes = await createClient(tx, {
        circleId: personalCircleId,
        ownerAccountId: alice.id,
        slug: 'claudecode',
        name: 'Claude Code',
        runtimeFamily: 'claudecode',
      })
      if (!cRes.ok) throw new Error('建实例失败')
      const kRes = await issueClientKey(tx, {
        circleId: personalCircleId,
        clientId: cRes.client.id,
        accountId: alice.id,
        name: 'MCP 测试密钥',
        linkedCircles: [{ circleId: sharedCircleId, mode: 'read_write' }],
        contextFacets: { env: ['mac'] },
        scopes: FULL_LENS_SCOPES,
      })
      if (!kRes.ok) throw new Error('签发密钥失败')
      return kRes
    })
    key = issued.plaintext
  })

  let rpcId = 0
  async function rpc(method: string, params: unknown, k = key) {
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${k}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = res.status === 200 ? await res.json() : await res.text()
    return { status: res.status, body }
  }

  const callTool = async (name: string, args: Record<string, unknown>, k = key) =>
    (await rpc('tools/call', { name, arguments: args }, k)).body.result as {
      content: { text: string }[]
      isError?: boolean
    }

  it('没有 Key 返回 401', async () => {
    const res = await app.request('/v1/mcp', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  it('初始化并列出完整 11 个工具，inputSchema 无 $ref 与 definitions', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    expect(init.body.result.serverInfo.name).toBe('kioku')
    expect(init.body.result.instructions).toContain('Kioku 是你的长期记忆')
    expect(init.body.result.instructions).toContain('kioku_browse')

    const tools = await rpc('tools/list', {})
    expect(tools.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'kioku_boot',
      'kioku_browse',
      'kioku_create',
      'kioku_credential',
      'kioku_credential_delete',
      'kioku_credential_save',
      'kioku_delete',
      'kioku_get',
      'kioku_search',
      'kioku_transfer',
      'kioku_update',
    ])
    for (const item of tools.body.result.tools as { name: string; inputSchema: unknown }[]) {
      const schema = JSON.stringify(item.inputSchema)
      expect(schema, item.name).not.toContain('$ref')
      expect(schema, item.name).not.toContain('definitions')
      expect(schema, item.name).not.toContain('$defs')
    }
  })

  it('支持单切片/多变体写入、在场切面过滤读取、all_variants、双链实时标题、旧 URI 解析与动态分组浏览', async () => {
    const targetRes = await callTool('kioku_create', {
      title: '代码规范',
      content: '先跑 lint 与类型检查',
      topics: ['workflow'],
      glossary: ['规范'],
    })
    expect(targetRes.isError).toBeFalsy()
    const targetId = /ID:\s+(m-[0-9a-z]+)/.exec(targetRes.content[0]!.text)![1]!

    // 建立带多变体和 wiki 链接的词条
    const multiRes = await callTool('kioku_create', {
      title: '包管理指引',
      variants: [
        { content: `通用指引，参见 [[${targetId}]]。` },
        { when: { env: ['mac'] }, content: 'Mac 上使用 pnpm dev。', sort_order: 1 },
        { when: { env: ['win'] }, content: 'Win 上使用 powershell 脚本。', sort_order: 2 },
      ],
      topics: ['devtools'],
      disclosure: '启动项目前',
      glossary: ['包管理'],
    })
    expect(multiRes.isError).toBeFalsy()
    const multiId = /ID:\s+(m-[0-9a-z]+)/.exec(multiRes.content[0]!.text)![1]!

    // 默认按在场焦点（env: mac）过滤掉 win 切片并在 metadata 中提示其余切片
    const gotFiltered = await callTool('kioku_get', { id: multiId })
    expect(gotFiltered.content[0]!.text).toContain('Mac 上使用 pnpm dev')
    expect(gotFiltered.content[0]!.text).not.toContain('Win 上使用 powershell 脚本')
    expect(gotFiltered.content[0]!.text).toContain(
      '其余可用切片（传 all_variants: true 查看全量）: [env=win]',
    )
    expect(gotFiltered.content[0]!.text).toContain(`[[${targetId}|代码规范]]`)

    // 传入 all_variants: true 可看全量切片
    const gotAll = await callTool('kioku_get', { id: multiId, all_variants: true })
    expect(gotAll.content[0]!.text).toContain('Win 上使用 powershell 脚本')

    // 写入一条 legacy_uri 映射并通过旧 URI 调用 kioku_get -> 重定向并提示规范短 ID
    await withCircle(database.db, personalCircleId, async (tx) => {
      const eRow = await tx.query.entries.findFirst({ where: (t) => eq(t.shortId, targetId) })
      await tx.insert(legacyUris).values({
        circleId: personalCircleId,
        entryId: eRow!.id,
        legacyUri: 'core://agent',
        source: 'lore',
      })
    })
    const byLegacy = await callTool('kioku_get', { id: 'core://agent' })
    expect(byLegacy.content[0]!.text).toContain(`提示: 已解析到规范短 ID ${targetId}`)
    expect(byLegacy.content[0]!.text).toContain('先跑 lint 与类型检查')

    // 动态分组浏览与搜索
    const browsed = await callTool('kioku_browse', { group_by: 'topic' })
    expect(browsed.content[0]!.text).toContain(targetId)
    expect(browsed.content[0]!.text).toContain('[env=mac]')

    const searched = await callTool('kioku_search', { query: '包管理' })
    expect(searched.content[0]!.text).toContain(multiId)
  })

  it('个人圈默认 private 且可设 public，访问密钥仅可在两个有写权限共享圈之间 kioku_transfer', async () => {
    const secondShared = await createSharedCircle(database.db, {
      name: '运维共享圈',
      ownerAccountId: aliceId,
    })
    if (!secondShared.ok) throw new Error('建第二个共享圈失败')

    const bob = await seedAccount(database.db, 'bob')
    const added = await addMember(database.db, {
      circleId: sharedCircleId,
      actor: aliceId,
      username: bob.account.username,
      role: 'editor',
    })
    if (!added.ok) throw new Error('拉入成员失败')

    const createdPersonal = await callTool('kioku_create', { content: '个人草稿' })
    expect(createdPersonal.content[0]!.text).toContain('敏感级: private')
    const pId = /ID:\s+(m-[0-9a-z]+)/.exec(createdPersonal.content[0]!.text)![1]!

    const pub = await callTool('kioku_update', { id: pId, sensitivity: 'public' })
    expect(pub.isError).toBeUndefined()
    expect(pub.content[0]!.text).toContain('敏感级: public')

    // 禁止用访问密钥把个人圈词条迁移进共享圈
    const transferDeny = await callTool('kioku_transfer', {
      id: pId,
      to_circle: sharedCircleId,
    })
    expect(transferDeny.isError).toBe(true)
    expect(transferDeny.content[0]!.text).toContain('共享圈')

    // 另签一把同时拥有两个共享圈写权限的钥匙，验证共享圈间迁移保留短 ID
    const sharedIssued = await withCircle(database.db, sharedCircleId, async (tx) => {
      const cRes = await createClient(tx, {
        circleId: sharedCircleId,
        ownerAccountId: aliceId,
        slug: 'team-mcp',
        name: '团队 MCP',
        runtimeFamily: 'claudecode',
      })
      if (!cRes.ok) throw new Error('建团队实例失败')
      const kRes = await issueClientKey(tx, {
        circleId: sharedCircleId,
        clientId: cRes.client.id,
        accountId: aliceId,
        name: '双共享圈密钥',
        linkedCircles: [{ circleId: secondShared.value.id, mode: 'read_write' }],
        scopes: FULL_LENS_SCOPES,
      })
      if (!kRes.ok) throw new Error('签发团队密钥失败')
      return kRes
    })

    const sharedCreated = await callTool(
      'kioku_create',
      { title: '共享迁移测试', content: '共享运维规范' },
      sharedIssued.plaintext,
    )
    const sId = /ID:\s+(m-[0-9a-z]+)/.exec(sharedCreated.content[0]!.text)![1]!

    const transferred = await callTool(
      'kioku_transfer',
      { id: sId, to_circle: secondShared.value.slug },
      sharedIssued.plaintext,
    )
    expect(transferred.isError).toBeFalsy()
    expect(transferred.content[0]!.text).toContain(`ID: ${sId}`)
    expect(transferred.content[0]!.text).toContain(`记忆圈: ${secondShared.value.slug}`)
  })

  it('支持 valid_to 设置与清空，以及业务错误作为工具错误返回', async () => {
    const tools = await rpc('tools/list', {})
    const schemaOf = (name: string) =>
      (tools.body.result.tools as { name: string; inputSchema: { properties: object } }[]).find(
        (t) => t.name === name,
      )!.inputSchema.properties
    expect(schemaOf('kioku_create')).toHaveProperty('valid_to')
    expect(schemaOf('kioku_update')).toHaveProperty('valid_to')

    const until = new Date(Date.now() + 86_400_000).toISOString()
    const created = await callTool('kioku_create', { content: '下周出差', valid_to: until })
    expect(created.isError).toBeFalsy()
    const shortId = /ID:\s+(m-[0-9a-z]+)/.exec(created.content[0]!.text)![1]!
    expect(created.content[0]!.text).toContain(`有效到: ${until}`)

    const past = await callTool('kioku_update', {
      id: shortId,
      valid_to: new Date(Date.now() - 60_000).toISOString(),
    })
    expect(past.isError).toBe(true)

    const cleared = await callTool('kioku_update', { id: shortId, valid_to: null })
    expect(cleared.isError).toBeFalsy()
    expect(cleared.content[0]!.text).not.toContain('有效到')

    const missing = await callTool('kioku_get', { id: 'm-zzzzzz' })
    expect(missing.isError).toBe(true)
    expect(missing.content[0]!.text).toContain('未找到')
  })

  describe('非业务错误脱敏与使用指引握手', () => {
    const callWith = async (db: Db, args: Record<string, unknown>) => {
      const localDeps = { db, masterKey: null, jobs: null } as unknown as Deps
      const principal: KeyPrincipal = {
        kind: 'key',
        keyId: randomUUID(),
        circleId: randomUUID(),
        scopes: FULL_LENS_SCOPES,
        contextFacets: {},
        staticContextRealms: new Set(),
        personaOverrideId: null,
        primaryCircle: {
          id: randomUUID(),
          slug: 'p',
          name: '个人',
          kind: 'personal',
          defaultRealms: [],
        },
        circleGrants: [],
        client: {
          id: randomUUID(),
          slug: 'a',
          name: 'a',
          runtimeFamily: 'claudecode',
          ownerAccountId: randomUUID(),
          defaultPersonaId: null,
          config: { personMemoryMode: 'strict' },
        },
      }
      const res = await handleMcpRequest(
        entryServiceForKey(localDeps, principal),
        recallScopeForKey(localDeps, principal),
        credentialServiceForKey(localDeps, principal),
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

    it('带参数的 Drizzle 错误不进工具结果与日志', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const cause = Object.assign(new Error('deadlock detected'), { code: '40P01' })
        const failing = new DrizzleQueryError('insert into entries', ['明文的参数'], cause)
        const db = { transaction: () => Promise.reject(failing) } as unknown as Db
        const result = await callWith(db, { content: '正文' })
        expect(result.content[0]!.text).toBe(TOOL_INTERNAL_ERROR)
        const logged = JSON.stringify(error.mock.calls[0])
        expect(logged).toContain('40P01')
        expect(logged).not.toContain('明文的参数')
      } finally {
        error.mockRestore()
      }
    })

    it('数据库语句超时与非 DB 异常仅回固定文字，且 GET 返回 405', async () => {
      const OVER_TIME = 60_000
      const failingDb = new Proxy(database.db, {
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
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const result = await callWith(failingDb, { content: '不该进日志的正文' })
        expect(result.isError).toBe(true)
        expect(result.content[0]!.text).toBe(TOOL_INTERNAL_ERROR)
      } finally {
        error.mockRestore()
      }

      const getRes = await app.request('/v1/mcp', {
        headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' },
      })
      expect(getRes.status).toBe(405)
      expect(getRes.headers.get('allow')).toBe('POST')
    })

    it('仅单条 initialize 请求查设置表并将 agentGuidance 拼进 instructions', async () => {
      const [keyRow] = await withCircle(database.db, personalCircleId, (tx) =>
        tx.query.apiKeys.findMany({ limit: 1 }),
      )
      const principal = (await principalForKeyId(database.db, keyRow!.id))!
      const settingsFn = vi.fn().mockResolvedValue({
        prompts: {
          agentGuidance: ['实例补充：记录架构决策'],
          chatGuidance: ['群聊补充：不得进入 MCP'],
          extractionRules: [],
          dreamRules: [],
        },
      })
      const scopeStub = {
        primaryCircleId: personalCircleId,
        settings: settingsFn,
        focus: async () => ({}),
        recall: async () => [],
        boot: async () => ({ personaTraits: [], entries: [], omitted: [] }),
        recent: async () => [],
        summaries: async () => [],
        subjects: async () => [],
        record: () => {},
      } as unknown as ReturnType<typeof recallScopeForKey>

      const makeReq = (body: unknown) =>
        new Request('http://127.0.0.1/v1/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(body),
        })

      const initRes = await handleMcpRequest(
        entryServiceForKey(deps, principal),
        scopeStub,
        credentialServiceForKey(deps, principal),
        makeReq({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        }),
      )
      const initJson = (await initRes.json()) as { result: { instructions?: string } }
      expect(initJson.result.instructions).toContain('实例补充：记录架构决策')
      expect(initJson.result.instructions).not.toContain('群聊补充：不得进入 MCP')
      expect(settingsFn).toHaveBeenCalledTimes(1)

      await handleMcpRequest(
        entryServiceForKey(deps, principal),
        scopeStub,
        credentialServiceForKey(deps, principal),
        makeReq({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      )
      expect(settingsFn).toHaveBeenCalledTimes(1)
    })
  })
})
