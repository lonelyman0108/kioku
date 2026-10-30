import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inspect } from 'node:util'

import { serve } from '@hono/node-server'
import {
  BENCH_AGENT_MAX_BYTES,
  BENCH_AGENT_MAX_MESSAGES,
  BENCH_TOOLS,
  BenchAgentInfo,
  BenchAgentTurnResult,
  BenchRunResult,
  type BenchAgentToolCall,
  type BenchToolList,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { accounts, memories, settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { saveExtractionConfig } from '../../extraction/settings'
import type { Deps } from '../../http/env'
import {
  openTestDatabase,
  resetDatabase,
  settingsQueryFails,
  tableDigests,
  testDatabaseUrl,
} from '../../testing/db'
import {
  startFakeChatServer,
  type FakeChatReply,
  type FakeChatMessage,
  type FakeChatServer,
} from '../../testing/fakeChatServer'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const API_KEY = 'sk-bench-agent-0123456789abcdef'
const SECRET_BODY = '保险柜的位置在书房第三层'
const HOSTED_VALUE = 'hunter2-hosted-value'
const USER = { role: 'user', content: '你好' }
// 等着模型的用例：里面按断言等几秒，要比这些等待长，等不到时才是断言失败而不是用例超时
const WAITING_TIMEOUT = 15_000
const MEMBER_SCOPES = {
  readLayers: ['private'],
  writeLayers: ['private'],
  maxSensitivity: 'private',
  admin: false,
}

const toolCall = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
})
const toolMessage = (id: string, content: string) => ({ role: 'tool', tool_call_id: id, content })
const toolSteps = (calls: BenchAgentToolCall[]) =>
  calls.map((call) => ({ kind: 'tool', tool: call.name, arguments: call.arguments }))

describe.skipIf(!testDatabaseUrl)('模型代理', () => {
  let database: Database
  let deps: Deps
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let appId: string
  let keyId: string
  let plainKey: string
  const masterKey = randomBytes(32)
  const models: FakeChatServer[] = []

  // 起一个假模型，配成实例的抽取模型
  const startModel = async (
    reply: (messages: FakeChatMessage[]) => FakeChatReply | Promise<FakeChatReply>,
    apiKey: string | null = API_KEY,
  ) => {
    const server = await startFakeChatServer(reply)
    models.push(server)
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: server.url,
      model: 'fake-model',
      apiKey,
    })
    return server
  }
  const benchPath = (appId_ = appId, keyId_ = keyId) =>
    `/v1/spaces/${ws.spaceId}/apps/${appId_}/keys/${keyId_}/bench`
  const postTurn = (body: unknown, cookie = ws.cookie, path = benchPath(), target = app) =>
    target.request(`${path}/agent/turn`, jsonRequest('POST', body, { cookie }))
  const getInfo = (cookie = ws.cookie, path = benchPath(), target = app) =>
    target.request(`${path}/agent`, { headers: { cookie } })
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error
  const turn = async (body: unknown) => {
    const res = await postTurn(body)
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return BenchAgentTurnResult.parse(await res.json())
  }
  const run = async (body: {
    mode?: 'rollback' | 'real'
    steps: unknown[]
    replay?: unknown[]
  }) => {
    const res = await app.request(
      `${benchPath()}/run`,
      jsonRequest('POST', body, { cookie: ws.cookie }),
    )
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return BenchRunResult.parse(await res.json())
  }
  // 真实的 /v1/mcp：造数据，也用来对照
  let rpcId = 0
  const realTool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: {
        ...bearer(plainKey),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    const { result } = (await res.json()) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    return { text: result.content[0]!.text, isError: result.isError === true }
  }
  // 成员自己的应用与 Key，返回测试台的路径
  const memberApp = async (cookie: string, slug = 'member-app') => {
    const created = await app.request(
      `/v1/spaces/${ws.spaceId}/apps`,
      jsonRequest('POST', { slug, name: slug, runtimeFamily: 'claudecode' }, { cookie }),
    )
    const { id } = (await created.json()) as { id: string }
    const key = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${id}/keys`,
      jsonRequest('POST', { name: 'k', scopes: MEMBER_SCOPES }, { cookie }),
    )
    return benchPath(id, ((await key.json()) as { id: string }).id)
  }

  beforeAll(async () => {
    database = await openTestDatabase()
    deps = {
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    }
    app = createApp(deps)
  })
  afterAll(async () => {
    // 实例设置不随 resetDatabase 清掉，留着会挡住别的测试文件保存抽取设置
    await database?.db.delete(settings)
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    ws = await bootstrap(app)
    appId = (await ws.createApp('cc', { runtimeFamily: 'claudecode' })).id
    const created = await ws.createKey(appId)
    keyId = created.id
    plainKey = created.key
  })
  afterEach(async () => {
    await Promise.all(models.splice(0).map((server) => server.close()))
  })

  describe('权限', () => {
    it('应用主人不是实例管理员：请求模型 403；查情况不是 403，给原因，不透露配没配', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const path = await memberApp(bob.cookie)
      const unavailable = {
        available: false,
        reason: 'notAdmin',
        defaultModel: null,
        loop: 'hook',
        tools: true,
      }

      const before = await getInfo(bob.cookie, path)
      expect(before.status).toBe(200)
      expect(BenchAgentInfo.parse(await before.json())).toEqual(unavailable)

      const server = await startModel(() => '不该请求到这里')
      const res = await postTurn({ messages: [USER] }, bob.cookie, path)
      expect(res.status).toBe(403)
      expect(await errorOf(res)).toContain('实例管理员')
      expect(server.requests).toHaveLength(0)
      expect(await (await getInfo(bob.cookie, path)).json()).toEqual(unavailable)
    })

    it('实例管理员不是应用主人：两个接口都 403', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const path = await memberApp(bob.cookie)
      const server = await startModel(() => '不该请求到这里')
      const res = await postTurn({ messages: [USER] }, ws.cookie, path)
      expect(res.status).toBe(403)
      expect(await errorOf(res)).toContain('主人')
      expect((await getInfo(ws.cookie, path)).status).toBe(403)
      expect(server.requests).toHaveLength(0)
    })

    it('editor 既不是实例管理员也不是这个应用的主人：两个接口都 403', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const server = await startModel(() => '不该请求到这里')
      const res = await postTurn({ messages: [USER] }, bob.cookie)
      expect(res.status).toBe(403)
      expect(await errorOf(res)).toContain('主人')
      expect((await getInfo(bob.cookie)).status).toBe(403)
      expect(server.requests).toHaveLength(0)
    })

    it('实例管理员又是应用主人才能用，空间里的角色不影响', async () => {
      const carol = await addMember(database.db, ws.spaceId, 'carol', 'editor')
      await database.db
        .update(accounts)
        .set({ isAdmin: true })
        .where(eq(accounts.id, carol.accountId))
      const path = await memberApp(carol.cookie)
      const server = await startModel(() => '好')
      expect((await postTurn({ messages: [USER] }, carol.cookie, path)).status).toBe(200)
      expect(await (await getInfo(carol.cookie, path)).json()).toMatchObject({
        available: true,
        reason: null,
      })
      expect(server.requests).toHaveLength(1)
    })

    it('没登录 401；Key 明文当不了登录状态；作废的 Key 404', async () => {
      await startModel(() => '好')
      const body = { messages: [USER] }
      expect(
        (await app.request(`${benchPath()}/agent/turn`, jsonRequest('POST', body))).status,
      ).toBe(401)
      expect(
        (
          await app.request(
            `${benchPath()}/agent/turn`,
            jsonRequest('POST', body, bearer(plainKey)),
          )
        ).status,
      ).toBe(401)
      expect((await app.request(`${benchPath()}/agent`)).status).toBe(401)

      const revoked = await app.request(`/v1/spaces/${ws.spaceId}/apps/${appId}/keys/${keyId}`, {
        ...jsonRequest('DELETE', {}, { cookie: ws.cookie }),
      })
      expect(revoked.ok).toBe(true)
      expect((await postTurn(body)).status).toBe(404)
      expect((await getInfo()).status).toBe(404)
    })
  })

  describe('设置', () => {
    it('没配模型：请求模型 400，说明去实例设置配抽取模型；查情况给原因；配好之后可用', async () => {
      const res = await postTurn({ messages: [USER] })
      expect(res.status).toBe(400)
      const error = await errorOf(res)
      expect(error).toContain('实例设置')
      expect(error).toContain('抽取模型')
      expect(BenchAgentInfo.parse(await (await getInfo()).json())).toEqual({
        available: false,
        reason: 'noModel',
        defaultModel: null,
        loop: 'hook',
        tools: true,
      })

      await startModel(() => '好')
      expect(BenchAgentInfo.parse(await (await getInfo()).json())).toEqual({
        available: true,
        reason: null,
        defaultModel: 'fake-model',
        loop: 'hook',
        tools: true,
      })
    })

    it('Key 解不开（没配主密钥）：400 并说明，不请求模型', async () => {
      const server = await startModel(() => '不该请求到这里')
      const noKey = createApp({ ...deps, masterKey: null })
      const res = await postTurn({ messages: [USER] }, ws.cookie, benchPath(), noKey)
      expect(res.status).toBe(400)
      expect(await errorOf(res)).toContain('KIOKU_MASTER_KEY')
      expect(server.requests).toHaveLength(0)
    })

    it('Key 解不开（主密钥对不上）：400 并说明，不是解密库的英文报错，不请求模型', async () => {
      const server = await startModel(() => '不该请求到这里')
      const otherKey = createApp({ ...deps, masterKey: randomBytes(32) })
      const expectLocked = async () => {
        const res = await postTurn({ messages: [USER] }, ws.cookie, benchPath(), otherKey)
        expect(res.status).toBe(400)
        const error = await errorOf(res)
        expect(error).toContain('抽取模型的 Key 解不开')
        expect(error).toContain('KIOKU_MASTER_KEY')
        expect(error).toContain('旧的那把要配在 KIOKU_MASTER_KEY_PREVIOUS')
      }
      // 记着主密钥的标识：还没解密就知道对不上
      await expectLocked()
      // 加上标识之前保存的：解密时才失败
      const [row] = await database.db.select().from(settings).where(eq(settings.key, 'extraction'))
      const value = row!.value as { apiKey: { keyId?: string } }
      delete value.apiKey.keyId
      await database.db.update(settings).set({ value }).where(eq(settings.key, 'extraction'))
      await expectLocked()
      expect(server.requests).toHaveLength(0)
    })

    it('读设置时数据库出错：500 与固定文字，响应和日志里都没有 SQL 与参数，不请求模型', async () => {
      const server = await startModel(() => '不该请求到这里')
      const broken = createApp({ ...deps, db: settingsQueryFails(database.db) })
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const res = await postTurn({ messages: [USER] }, ws.cookie, benchPath(), broken)
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: '服务内部错误' })
        expect(server.requests).toHaveLength(0)
        // 查情况的接口也读同一份设置，两边一致
        const info = await getInfo(ws.cookie, benchPath(), broken)
        expect(info.status).toBe(500)
        expect(await info.json()).toEqual({ error: '服务内部错误' })
        // 前提：确实是数据库报的错（表不存在），这条用例测的是这种错误
        expect(logged).toHaveBeenCalledTimes(2)
        expect(logged.mock.calls[0]![1]).toMatchObject({ code: '42P01' })
        const text = inspect(logged.mock.calls, { depth: null })
        for (const leaked of ['Failed query', 'params:', 'extraction']) {
          expect(text).not.toContain(leaked)
        }
      } finally {
        logged.mockRestore()
      }
    })
  })

  describe('工具', () => {
    it('发给模型的工具等于真实的 tools/list，只去掉 $schema；请求里没有别的参数', async () => {
      const server = await startModel(() => '好')
      await turn({ messages: [USER] })

      const listed = (await (
        await app.request(`${benchPath()}/tools`, { headers: { cookie: ws.cookie } })
      ).json()) as BenchToolList
      // 前提：真实的工具带 $schema，否则这条用例什么也没测到
      expect(
        listed.tools.some((tool) => '$schema' in (tool.inputSchema as Record<string, unknown>)),
      ).toBe(true)
      const expected = listed.tools.map((tool) => {
        const parameters = { ...(tool.inputSchema as Record<string, unknown>) }
        delete parameters.$schema
        return {
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters },
        }
      })
      expect(server.tools[0]).toEqual(expected)
      expect(JSON.stringify(server.tools[0])).not.toContain('$schema')
      expect(expected.map((tool) => tool.function.name).sort()).toEqual([...BENCH_TOOLS].sort())

      expect(Object.keys(server.bodies[0]!).sort()).toEqual(['messages', 'model', 'tools'])
      expect(server.authorizations[0]).toBe(`Bearer ${API_KEY}`)
    })

    it('聊天类运行时不给工具，请求里也没有 tools', async () => {
      const chatApp = (await ws.createApp('bot', { runtimeFamily: 'astrbot' })).id
      const key = await ws.createKey(chatApp)
      const path = benchPath(chatApp, key.id)
      const server = await startModel(() => '好')
      const res = await postTurn({ messages: [USER] }, ws.cookie, path)
      expect(res.status).toBe(200)
      expect(server.tools[0]).toBeUndefined()
      expect(Object.keys(server.bodies[0]!).sort()).toEqual(['messages', 'model'])
    })

    it.each([
      ['claudecode', 'hook', true],
      ['codex', 'hook', true],
      ['astrbot', 'chat', false],
      ['mcp', 'tools', true],
      ['openclaw', 'approximate', true],
      ['other', 'approximate', true],
    ])('%s：循环是 %s，给不给工具 %s，和实际请求一致', async (runtimeFamily, loop, tools) => {
      const created = (await ws.createApp(`app-${runtimeFamily}`, { runtimeFamily })).id
      const key = await ws.createKey(created)
      const path = benchPath(created, key.id)
      const server = await startModel(() => '好')
      expect(await (await getInfo(ws.cookie, path)).json()).toEqual({
        available: true,
        reason: null,
        defaultModel: 'fake-model',
        loop,
        tools,
      })
      expect((await postTurn({ messages: [USER] }, ws.cookie, path)).status).toBe(200)
      expect(server.tools[0] !== undefined).toBe(tools)
    })
  })

  describe('消息', () => {
    it('助手消息原样返回，再传回来时原样发给上游，含 reasoning_content 与不认识的字段', async () => {
      const assistant = {
        content: null,
        reasoning_content: '让我想想该调哪个工具',
        future_field: { nested: [1, { a: 'b' }] },
        tool_calls: [toolCall('call-1', 'kioku_list', {})],
      }
      const server = await startModel((messages) =>
        messages.some((m) => m.role === 'tool') ? '列完了' : assistant,
      )
      const first = await turn({ messages: [USER] })
      expect(first.message).toEqual({ role: 'assistant', ...assistant })
      expect(first.finishReason).toBe('tool_calls')

      const history = [USER, first.message, toolMessage('call-1', '结果')]
      const second = await turn({ messages: history })
      expect(server.requests[1]).toEqual(history)
      expect(second.message).toEqual({ role: 'assistant', content: '列完了' })
      expect(second.toolCalls).toEqual([])
      expect(second.finishReason).toBe('stop')
    })

    it('工具调用的参数：空串、空白与字符串 null 按 {}，解析失败与不是对象的给 parseError，请求不失败', async () => {
      await startModel(() => ({
        content: null,
        tool_calls: [
          toolCall('empty', 'kioku_boot', ''),
          toolCall('blank', 'kioku_boot', ' \n\t'),
          toolCall('good', 'kioku_get', { uri: 'core://agent' }),
          toolCall('bad', 'kioku_get', '{"uri":'),
          toolCall('array', 'kioku_get', '[1]'),
          toolCall('null', 'kioku_get', 'null'),
          toolCall('text', 'kioku_get', '"core://agent"'),
        ],
      }))
      const { toolCalls } = await turn({ messages: [USER] })
      const notJson = '工具参数不是合法的 JSON'
      const notObject = '工具参数不是 JSON 对象'
      expect(toolCalls).toEqual([
        { id: 'empty', name: 'kioku_boot', arguments: {}, parseError: null },
        { id: 'blank', name: 'kioku_boot', arguments: {}, parseError: null },
        { id: 'good', name: 'kioku_get', arguments: { uri: 'core://agent' }, parseError: null },
        { id: 'bad', name: 'kioku_get', arguments: null, parseError: notJson },
        { id: 'array', name: 'kioku_get', arguments: null, parseError: notObject },
        { id: 'null', name: 'kioku_get', arguments: {}, parseError: null },
        { id: 'text', name: 'kioku_get', arguments: null, parseError: notObject },
      ])
    })

    it('响应里有未转义的控制字符：字符串里的容忍，字符串外的换行不被转义', async () => {
      await startModel(() => ({
        raw: [
          '{',
          '  "choices": [',
          '    {',
          '      "message": {',
          '        "role": "assistant",',
          // 字符串里有换行与制表符，有转义的引号，结尾是转义的反斜杠
          '        "content": "第一行\n第二行\t\\"引号\\" 反斜杠\\\\",',
          '        "reasoning_content": "想\r\n一想"',
          '      },',
          '      "finish_reason": "stop"',
          '    }',
          '  ],',
          '  "usage": {"prompt_tokens": 7, "completion_tokens": 3}',
          '}',
          '',
        ].join('\n'),
      }))
      const result = await turn({ messages: [USER] })
      expect(result.message).toEqual({
        role: 'assistant',
        content: '第一行\n第二行\t"引号" 反斜杠\\',
        reasoning_content: '想\r\n一想',
      })
      expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 3 })
    })

    it('arguments 字符串里有未转义的换行：响应能解析，参数也一样容忍', async () => {
      const call = (id: string, args: string) =>
        `{"id":"${id}","type":"function","function":{"name":"kioku_get","arguments":"${args}"}}`
      await startModel(() => ({
        raw: `{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[${[
          // 换行在参数的 JSON 结构之间，是合法的空白
          call('space', '{\n\\"uri\\":\\"core://agent\\"}'),
          // 换行在参数的字符串里：还原之后参数本身有没转义的换行
          call('inner', '{\\"uri\\":\\"core\n//agent\\"}'),
          // 容忍之后还是不合法的，才报错
          call('broken', '{\\"uri\\":\\"core\n//agent'),
        ].join(',')}]}}]}`,
      }))
      const { toolCalls } = await turn({ messages: [USER] })
      expect(toolCalls).toEqual([
        { id: 'space', name: 'kioku_get', arguments: { uri: 'core://agent' }, parseError: null },
        { id: 'inner', name: 'kioku_get', arguments: { uri: 'core\n//agent' }, parseError: null },
        { id: 'broken', name: 'kioku_get', arguments: null, parseError: '工具参数不是合法的 JSON' },
      ])
    })

    // 严格的上游：tool_calls 要是非空数组，id 都是不重复的非空字符串，后面按顺序跟齐对应的 tool 消息。不合规就 400
    const refusal = (messages: FakeChatMessage[]) => {
      for (const [i, message] of messages.entries()) {
        if (!('tool_calls' in message)) continue
        const calls = message.tool_calls as { id?: unknown }[]
        if (!Array.isArray(calls) || !calls.length) return 'tool_calls 不能是空的'
        const ids = calls.map((call) => call.id)
        if (ids.some((id) => typeof id !== 'string' || !id)) return 'id 不合法'
        if (new Set(ids).size !== ids.length) return 'id 重复'
        const answered = messages.slice(i + 1, i + 1 + ids.length).map((m) => m.tool_call_id)
        if (JSON.stringify(answered) !== JSON.stringify(ids)) return 'tool_call_id 对不上'
      }
      return null
    }
    const strictModel = (reply: () => FakeChatReply) =>
      startModel((messages) => {
        const reason = refusal(messages)
        if (reason) return { status: 400, raw: reason }
        return messages.some((m) => m.role === 'tool') ? '调完了' : reply()
      })

    it('工具调用的 id 缺失、不是字符串、空串或重复：规范化之后下一轮对得上，严格的上游也接受', async () => {
      const call = { type: 'function', function: { name: 'kioku_boot', arguments: '' } }
      const server = await strictModel(() => ({
        content: null,
        reasoning_content: '想一想',
        tool_calls: [
          { id: 'kept', ...call },
          call,
          { id: 42, ...call },
          { id: '', ...call },
          { id: '', ...call },
          { id: 'kept', ...call },
        ],
      }))
      const first = await turn({ messages: [USER] })
      const ids = first.toolCalls.map((c) => c.id)
      expect(ids[0]).toBe('kept')
      expect(new Set(ids).size).toBe(6)
      expect(first.message.reasoning_content).toBe('想一想')
      expect((first.message.tool_calls as { id: string }[]).map((c) => c.id)).toEqual(ids)
      expect(first.toolCalls.every((c) => c.name === 'kioku_boot' && !c.parseError)).toBe(true)

      const history = [USER, first.message, ...ids.map((id) => toolMessage(id, '结果'))]
      const second = await turn({ messages: history })
      expect(second.message.content).toBe('调完了')
      // 发给上游的和界面放回历史的一样，id 没有再变
      expect(server.requests[1]).toEqual(history)
    })

    it.each([
      ['空数组', []],
      ['不是数组', 'x'],
      ['全都不是对象', [null, 'x']],
    ])('tool_calls 是%s：消息里去掉，下一轮严格的上游也接受', async (_, toolCalls) => {
      const server = await strictModel(() => ({
        content: '好',
        tool_calls: toolCalls as unknown[],
      }))
      const first = await turn({ messages: [USER] })
      expect(first.toolCalls).toEqual([])
      expect(first.message).toEqual({ role: 'assistant', content: '好' })
      expect('tool_calls' in first.message).toBe(false)

      const history = [USER, first.message, { role: 'user', content: '再说一句' }]
      const second = await postTurn({ messages: history })
      expect(second.status).toBe(200)
      expect(server.requests[1]).toEqual(history)
    })

    it('改模型名生效，接口与 Key 不变；用量与耗时都返回', async () => {
      const server = await startModel(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return '好'
      })
      const byDefault = await turn({ messages: [USER] })
      expect(byDefault.model).toBe('fake-model')
      expect(server.bodies[0]!.model).toBe('fake-model')
      expect(byDefault.usage).toEqual({ promptTokens: 100, completionTokens: 20 })
      // 假模型等了 30 毫秒。定时器可能早到一点，留出余量
      expect(byDefault.ms).toBeGreaterThanOrEqual(25)

      const other = await turn({ model: '  other-model ', messages: [USER] })
      expect(other.model).toBe('other-model')
      expect(server.bodies[1]!.model).toBe('other-model')
      expect(server.authorizations[1]).toBe(`Bearer ${API_KEY}`)
      // 实例设置没变
      expect(await (await getInfo()).json()).toMatchObject({ defaultModel: 'fake-model' })
    })
  })

  describe('上游报错', () => {
    it.each([400, 401, 404, 429, 500, 503])('HTTP %i 映射成 502，带上游原文', async (status) => {
      await startModel(() => ({ status, raw: '{"error":{"message":"上游说不行"}}' }))
      const res = await postTurn({ messages: [USER] })
      expect(res.status).toBe(502)
      const error = await errorOf(res)
      expect(error).toContain(`HTTP ${status}`)
      expect(error).toContain('上游说不行')
    })

    it.each([400, 500])('HTTP %i 的上游原文截断到 500 字', async (status) => {
      await startModel(() => ({ status, raw: 'x'.repeat(2000) }))
      const res = await postTurn({ messages: [USER] })
      expect(res.status).toBe(502)
      const error = await errorOf(res)
      expect(error).toContain('x'.repeat(500))
      expect(error).not.toContain('x'.repeat(501))
    })

    it('报错里没有 API Key：上游写进原文的换掉，跨在截断处的也不留半截', async () => {
      await startModel(() => ({ status: 401, raw: `无效的 Key：${API_KEY}` }))
      const echoed = await postTurn({ messages: [USER] })
      expect(echoed.status).toBe(502)
      const error = await errorOf(echoed)
      expect(error).toContain('无效的 Key')
      expect(error).not.toContain(API_KEY)

      await startModel(() => ({
        status: 500,
        raw: `${'x'.repeat(495)}${API_KEY}${'y'.repeat(1000)}`,
      }))
      const cut = await errorOf(await postTurn({ messages: [USER] }))
      expect(cut).not.toContain(API_KEY.slice(0, 5))
    })

    it.each([
      ['不是 JSON', '模型接口的响应不是合法的 JSON', (text: string) => `<html>${text}</html>`],
      [
        '没有助手消息',
        '模型接口的响应里没有助手消息',
        (text: string) => JSON.stringify({ error: text }),
      ],
    ])('2xx 但%s：502，带截断到 500 字的原文，没有 API Key', async (_, reason, body) => {
      const tail = 'x'.repeat(2000)
      await startModel(() => ({ raw: body(`${API_KEY}${tail}`) }))
      const res = await postTurn({ messages: [USER] })
      expect(res.status).toBe(502)
      expect(await errorOf(res)).toBe(`${reason}：${body(`***${tail}`).slice(0, 500)}…`)
    })

    it('保存的 Key 结尾有换行（fetch 去掉之后请求照样发出去）：上游写进报错的 Key 换掉', async () => {
      const server = await startModel(
        () => ({ status: 401, raw: '{"error":"Incorrect API key provided: sk-pasted"}' }),
        'sk-pasted\n',
      )
      const res = await postTurn({ messages: [USER] })
      // 前提：上游见到的就是去掉换行之后的，和保存的写法对不上
      expect(server.authorizations[0]).toBe('Bearer sk-pasted')
      expect(res.status).toBe(502)
      const error = await errorOf(res)
      expect(error).toContain('Incorrect API key provided: ***')
      expect(error).not.toContain('sk-pasted')
    })

    it('Key 里有换行（fetch 把整个请求头写进错误）：502，报错里没有 Key', async () => {
      const server = await startModel(() => '不该请求到这里', 'sk-pasted\nwith-newline')
      const res = await postTurn({ messages: [USER] })
      expect(res.status).toBe(502)
      const error = await errorOf(res)
      expect(error).toContain('连不上模型接口')
      expect(error).not.toContain('sk-pasted')
      expect(error).not.toContain('with-newline')
      expect(server.requests).toHaveLength(0)
    })

    it('接口连不上：502，说明是连不上', async () => {
      const server = await startModel(() => '好')
      await server.close()
      const res = await postTurn({ messages: [USER] })
      expect(res.status).toBe(502)
      expect(await errorOf(res)).toContain('连不上模型接口')
    })
  })

  describe('取消与连接', () => {
    // 走真实的端口：断开信号是 Node 的适配器给的，app.request 测不到。两种请求体的写法经过 bodyLimit 的路径不同
    it.each([
      ['带 Content-Length', true],
      ['分块传输', false],
    ])(
      '客户端断开（%s）：上游的请求被取消，不继续花 token',
      async (_, sized) => {
        const server = await startModel(() => ({ hang: true }))
        const listener = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server
        if (!listener.listening) await once(listener, 'listening')
        try {
          const payload = JSON.stringify({ messages: [USER] })
          const client = httpRequest({
            host: '127.0.0.1',
            port: (listener.address() as AddressInfo).port,
            path: `${benchPath()}/agent/turn`,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(sized ? { 'content-length': Buffer.byteLength(payload) } : {}),
              'sec-fetch-site': 'same-origin',
              cookie: ws.cookie,
            },
          })
          // 下面主动断开，这边会报 socket hang up
          client.on('error', () => {})
          client.end(payload)
          await vi.waitFor(() => expect(server.requests).toHaveLength(1), { timeout: 3_000 })
          expect(server.cancelled).toEqual([])
          client.destroy()
          // 比用例的时限短：signal 没传给上游时按断言失败，不是等到用例超时
          await vi.waitFor(() => expect(server.cancelled).toEqual([0]), { timeout: 3_000 })
        } finally {
          await new Promise((resolve) => listener.close(resolve))
        }
      },
      WAITING_TIMEOUT,
    )

    it(
      '请求模型期间不占连接：连接池 2 条，3 个请求都等着模型时别的查询照常',
      async () => {
        const server = await startModel(() => ({ hang: true }))
        const pending = [1, 2, 3].map(() => postTurn({ messages: [USER] }))
        try {
          await vi.waitFor(() => expect(server.requests).toHaveLength(3), { timeout: 3_000 })
          const queried = await Promise.race([
            database.db.select({ id: accounts.id }).from(accounts),
            new Promise<'等不到连接'>((resolve) => setTimeout(() => resolve('等不到连接'), 3_000)),
          ])
          expect(queried).not.toBe('等不到连接')
        } finally {
          // 上游关掉，这几个请求才会结束
          await server.close()
          await Promise.all(pending)
        }
      },
      WAITING_TIMEOUT,
    )

    it('不写库：所有表和请求之前逐行相同，不进抽取预算', async () => {
      await startModel(() => ({
        content: null,
        reasoning_content: '想',
        tool_calls: [toolCall('c', 'kioku_create', { uri: 'notes://x', content: '不会写' })],
      }))
      const before = await tableDigests(database, ws.spaceId)
      await turn({ messages: [USER] })
      await postTurn({ messages: [USER] })
      expect(await tableDigests(database, ws.spaceId)).toEqual(before)
    })
  })

  describe('请求的上限', () => {
    it('缺 role、消息为空、多余的字段都是 400，不请求模型', async () => {
      const server = await startModel(() => '好')
      for (const body of [
        { messages: [] },
        { messages: [{ content: '没有 role' }] },
        { messages: [{ role: '', content: '空的 role' }] },
        { messages: ['不是对象'] },
        {},
        { messages: [USER], temperature: 0.5 },
        { messages: [USER], model: '   ' },
      ]) {
        expect((await postTurn(body)).status, JSON.stringify(body)).toBe(400)
      }
      expect(server.requests).toHaveLength(0)
    })

    it('条数超过上限是 400；总大小超过上限是 400；请求体太大是 413，都不请求模型', async () => {
      const server = await startModel(() => '好')
      const tooMany = await postTurn({
        messages: Array.from({ length: BENCH_AGENT_MAX_MESSAGES + 1 }, () => USER),
      })
      expect(tooMany.status).toBe(400)
      expect(await errorOf(tooMany)).toContain('对话太长')

      const tooLarge = await postTurn({
        messages: [{ role: 'user', content: 'x'.repeat(BENCH_AGENT_MAX_BYTES) }],
      })
      expect(tooLarge.status).toBe(400)
      expect(await errorOf(tooLarge)).toContain('对话太长')

      const tooBig = await postTurn({
        messages: [{ role: 'user', content: 'x'.repeat(BENCH_AGENT_MAX_BYTES + 128 * 1024) }],
      })
      expect(tooBig.status).toBe(413)
      expect(await errorOf(tooBig)).toContain('对话太长')
      expect(server.requests).toHaveLength(0)
    })
  })

  describe('和运行接口串起来', () => {
    const seedSecrets = async () => {
      const created = await realTool('kioku_create', {
        uri: 'notes://safe',
        content: SECRET_BODY,
        sensitivity: 'secret',
      })
      expect(created.isError).toBe(false)
      const credential = await app.request(
        `/v1/spaces/${ws.spaceId}/credentials`,
        jsonRequest(
          'POST',
          {
            identifier: 'nas',
            name: 'NAS',
            source: { kind: 'hosted', values: { username: 'alice', password: HOSTED_VALUE } },
          },
          { cookie: ws.cookie },
        ),
      )
      expect(credential.ok).toBe(true)
      // 对照：真实的接口读得到明文，下面没有明文不是因为没读到
      expect((await realTool('kioku_get', { uri: 'notes://safe' })).text).toContain(SECRET_BODY)
      expect((await realTool('kioku_credential', { identifier: 'nas' })).text).toContain(
        HOSTED_VALUE,
      )
    }

    it.each(['rollback', 'real'] as const)(
      '%s：模型要 secret 记忆与托管凭据，运行接口的输出里没有明文，发回给模型的也没有',
      async (mode) => {
        await seedSecrets()
        const server = await startModel((messages) =>
          messages.some((m) => m.role === 'tool')
            ? '记忆在，正文和凭据的值都读不到'
            : {
                content: null,
                tool_calls: [
                  toolCall('get', 'kioku_get', { uri: 'notes://safe' }),
                  toolCall('cred', 'kioku_credential', { identifier: 'nas' }),
                ],
              },
        )

        const first = await turn({ messages: [USER] })
        expect(first.toolCalls.map((call) => call.name)).toEqual(['kioku_get', 'kioku_credential'])

        // 同一条消息里的多个工具调用放进同一次运行，按顺序执行
        const result = await run({ mode, steps: toolSteps(first.toolCalls) })
        expect(result.counts.passed).toBe(2)
        const output = JSON.stringify(result)
        expect(output).not.toContain(SECRET_BODY)
        expect(output).not.toContain(HOSTED_VALUE)
        // 工具确实跑了，结果是打过码的
        expect(result.steps[0]!.text).toContain('敏感级: secret')
        expect(result.steps[0]!.text).toContain('notes://safe')
        expect(result.steps[1]!.text).toContain('password')

        const history = [
          USER,
          first.message,
          ...first.toolCalls.map((call, i) => toolMessage(call.id, result.steps[i]!.text)),
        ]
        const second = await turn({ messages: history })
        expect(second.message.content).toBe('记忆在，正文和凭据的值都读不到')
        const sent = JSON.stringify(server.requests[1])
        expect(sent).not.toContain(SECRET_BODY)
        expect(sent).not.toContain(HOSTED_VALUE)
        expect(sent).toContain('敏感级: secret')
      },
    )

    it('回滚模式跨轮：第一轮写的，第二轮带重放读得到，模型收到结果，库里没有留下', async () => {
      const uri = 'notes://agent-made'
      const body = '模型第一轮写下的内容'
      const server = await startModel((messages) => {
        const answered = messages.filter((m) => m.role === 'tool').length
        if (answered === 0) {
          return {
            content: null,
            tool_calls: [toolCall('create', 'kioku_create', { uri, content: body })],
          }
        }
        if (answered === 1) {
          return { content: null, tool_calls: [toolCall('get', 'kioku_get', { uri })] }
        }
        return '记下了'
      })
      const before = await tableDigests(database, ws.spaceId)

      const first = await turn({ messages: [USER] })
      const created = await run({ steps: toolSteps(first.toolCalls) })
      expect(created.ok).toBe(true)
      const replay = created.steps[0]!.replay
      expect(replay).toMatchObject({ kind: 'tool', tool: 'kioku_create' })
      const afterFirst = [USER, first.message, toolMessage('create', created.steps[0]!.text)]

      const second = await turn({ messages: afterFirst })
      expect(second.toolCalls.map((call) => call.name)).toEqual(['kioku_get'])
      // 不带重放读不到：事务已经回滚了，读得到全靠重放
      const alone = await run({ steps: toolSteps(second.toolCalls) })
      expect(alone.steps[0]!.isError).toBe(true)
      const got = await run({ steps: toolSteps(second.toolCalls), replay: [replay] })
      expect(got.steps[0]!.isError).toBe(false)
      expect(got.steps[0]!.text).toContain(body)
      // 重放之后这一步只是读，不进重放日志
      expect(got.steps[0]!.replay).toBeNull()

      const third = await turn({
        messages: [...afterFirst, second.message, toolMessage('get', got.steps[0]!.text)],
      })
      expect(third.message.content).toBe('记下了')
      expect(JSON.stringify(server.requests[2])).toContain(body)

      expect(
        await withSpace(database.db, ws.spaceId, (tx) => tx.select().from(memories)),
      ).toHaveLength(0)
      expect(await tableDigests(database, ws.spaceId)).toEqual(before)
      // 最后才调：真实的调用会更新 Key 的最后使用时间
      expect((await realTool('kioku_get', { uri })).isError).toBe(true)
    })
  })
})
