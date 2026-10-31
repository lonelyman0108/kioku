import { randomBytes } from 'node:crypto'

import {
  BENCH_READ_TOOLS,
  BENCH_TOOLS,
  BenchRunResult,
  type ActivityList,
  type BenchScenarioList,
  type BenchStepResult,
  type BenchTool,
  type BenchToolList,
  type CredentialEventList,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { connect, withSpace, type Database, type Db } from '../../db/client'
import {
  apiKeys,
  conversationTurns,
  memories,
  recallEvents,
  settings,
  spaceMembers,
  subjects,
} from '../../db/schema'
import { staticEmbedderSource, type EmbedderSource } from '../../embedding/source'
import { saveExtractionConfig } from '../../extraction/settings'
import type { Deps } from '../../http/env'
import type { Jobs } from '../../jobs/queue'
import { memoryServiceForKey } from '../../memory/context'
import { MemoryService } from '../../memory/service'
import { keyToSimulate } from '../../access/simulate'
import { openTestDatabase, resetDatabase, tableDigests, testDatabaseUrl } from '../../testing/db'
import { deferred } from '../../testing/deferred'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { changeTracker } from '../changes'
import { inProcessExecutor, runBench } from '../inProcess'
import { inRollback, type BenchLimits } from '../rollback'

const SECRET_BODY = '保险柜的位置在书房第三层'
const GROUP = {
  chatType: 'group',
  platform: 'bench',
  group: { id: 'bench-group', name: '测试群' },
  sender: { id: 'bench-user', name: '群友' },
}
const TURN_END = {
  event: 'turn.end',
  sessionId: 'bench-session',
  context: GROUP,
  user: '群友说的话',
  reply: '回复的话',
}

const tool = (name: string, args: Record<string, unknown> = {}, extra: object = {}) => ({
  kind: 'tool',
  tool: name,
  arguments: args,
  ...extra,
})
const lifecycle = (body: unknown, extra: object = {}) => ({ kind: 'lifecycle', body, ...extra })

describe.skipIf(!testDatabaseUrl)('测试台的路由', () => {
  let database: Database
  let other: Database
  let deps: Deps
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let appId: string
  let keyId: string
  let plainKey: string
  const masterKey = randomBytes(32)

  const runPath = (id = keyId, app_ = appId) =>
    `/v1/spaces/${ws.spaceId}/apps/${app_}/keys/${id}/bench/run`

  const postRun = (body: unknown, cookie = ws.cookie, target = app, id = keyId) =>
    target.request(runPath(id), jsonRequest('POST', body, { cookie }))
  const run = async (
    body: { mode?: 'rollback' | 'real'; steps: unknown[]; replay?: unknown[] },
    target = app,
  ) => {
    const res = await postRun(body, ws.cookie, target)
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as BenchRunResult
  }
  const step = async (one: unknown, mode: 'rollback' | 'real' = 'rollback') =>
    (await run({ mode, steps: [one] })).steps[0]!

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

  beforeAll(async () => {
    database = await openTestDatabase()
    other = connect(testDatabaseUrl!, { max: 2 })
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
    await other?.close()
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

  const fingerprint = () => tableDigests(database, ws.spaceId)
  const lastUsedAt = async () => {
    const [row] = await database.db
      .select({ at: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId))
    return row!.at
  }
  const recallEventCount = () =>
    withSpace(database.db, ws.spaceId, async (tx) => (await tx.select().from(recallEvents)).length)

  describe('权限', () => {
    it('只给应用主人：空间 owner 不是这个应用的主人时也是 403', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const bobApp = (await (
        await app.request(
          `/v1/spaces/${ws.spaceId}/apps`,
          jsonRequest(
            'POST',
            { slug: 'bob-app', name: 'bob', runtimeFamily: 'mcp' },
            { cookie: editor.cookie },
          ),
        )
      ).json()) as { id: string }
      const bobKey = (await (
        await app.request(
          `/v1/spaces/${ws.spaceId}/apps/${bobApp.id}/keys`,
          jsonRequest(
            'POST',
            {
              name: 'k',
              scopes: {
                readLayers: ['private'],
                writeLayers: ['private'],
                maxSensitivity: 'private',
                admin: false,
              },
            },
            { cookie: editor.cookie },
          ),
        )
      ).json()) as { id: string }

      const steps = [{ kind: 'whoami' }]
      // 别的成员用不了主人的 Key
      const denied = await postRun({ steps }, editor.cookie)
      expect(denied.status).toBe(403)
      // 空间 owner 也用不了 editor 的应用的 Key
      const ownerDenied = await app.request(
        `/v1/spaces/${ws.spaceId}/apps/${bobApp.id}/keys/${bobKey.id}/bench/run`,
        jsonRequest('POST', { steps }, { cookie: ws.cookie }),
      )
      expect(ownerDenied.status).toBe(403)
      const toolsDenied = await app.request(
        `/v1/spaces/${ws.spaceId}/apps/${appId}/keys/${keyId}/bench/tools`,
        { headers: { cookie: editor.cookie } },
      )
      expect(toolsDenied.status).toBe(403)
      // editor 是自己应用的主人，能用
      const allowed = await app.request(
        `/v1/spaces/${ws.spaceId}/apps/${bobApp.id}/keys/${bobKey.id}/bench/run`,
        jsonRequest('POST', { steps }, { cookie: editor.cookie }),
      )
      expect(allowed.status).toBe(200)
    })

    it('没登录是 401，不是空间成员是 403；Key 明文当不了登录状态', async () => {
      const res = await app.request(runPath(), jsonRequest('POST', { steps: [{ kind: 'whoami' }] }))
      expect(res.status).toBe(401)
      const withKey = await app.request(
        runPath(),
        jsonRequest('POST', { steps: [{ kind: 'whoami' }] }, bearer(plainKey)),
      )
      expect(withKey.status).toBe(401)
    })

    it('作废的 Key 与不存在的 Key 都是 404，不能运行', async () => {
      const revoked = await app.request(`/v1/spaces/${ws.spaceId}/apps/${appId}/keys/${keyId}`, {
        ...jsonRequest('DELETE', {}, { cookie: ws.cookie }),
      })
      expect(revoked.ok).toBe(true)
      const res = await postRun({ steps: [{ kind: 'whoami' }] })
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toContain('作废')
      const missing = await postRun(
        { steps: [{ kind: 'whoami' }] },
        ws.cookie,
        app,
        '00000000-0000-4000-8000-000000000000',
      )
      expect(missing.status).toBe(404)
    })

    it('场景列表给空间成员，不是成员 403', async () => {
      const res = await app.request(`/v1/spaces/${ws.spaceId}/bench/scenarios`, {
        headers: { cookie: ws.cookie },
      })
      expect(res.status).toBe(200)
      const { scenarios } = (await res.json()) as BenchScenarioList
      expect(scenarios.map((s) => s.id).sort()).toEqual(
        [
          'astrbot-group-round',
          'claude-code-session',
          'credential-flow',
          'memory-crud',
          'permission-probe',
        ].sort(),
      )
      const stranger = await bootstrapStranger()
      const denied = await app.request(`/v1/spaces/${ws.spaceId}/bench/scenarios`, {
        headers: { cookie: stranger },
      })
      expect(denied.status).toBe(403)
    })

    // 空间之外的账号：直接写一个账号与会话，不用走 setup
    async function bootstrapStranger() {
      const member = await addMember(database.db, ws.spaceId, 'stranger', 'viewer')
      await database.db.execute(
        sql`delete from space_members where account_id = ${member.accountId}`,
      )
      return member.cookie
    }
  })

  describe('运行请求', () => {
    it('工具步骤带 context 是 400：工具调用不带会话上下文', async () => {
      const res = await postRun({ steps: [tool('kioku_get', {}, { context: GROUP })] })
      expect(res.status).toBe(400)
    })

    it('不合法的请求体不让整个运行失败：按步骤校验，返回和 REST 相同的错误', async () => {
      const bodies = [
        { path: '/v1/lifecycle/event', kind: 'lifecycle', body: { event: 'nope' } },
        { path: '/v1/lifecycle/event', kind: 'lifecycle', body: { event: 'prompt.submit' } },
        { path: '/v1/recall', kind: 'recall', body: { query: '' } },
        {
          path: '/v1/recall',
          kind: 'recall',
          body: { query: 'x', context: { chatType: 'group' } },
        },
      ]
      const result = await run({
        steps: [...bodies.map(({ kind, body }) => ({ kind, body })), { kind: 'whoami' }],
      })
      expect(result.steps.at(-1)!.status).toBe('passed')
      for (const [i, { path, body }] of bodies.entries()) {
        const res = await app.request(path, jsonRequest('POST', body, bearer(plainKey)))
        expect(res.status).toBe(400)
        const real = (await res.json()) as { error: string }
        expect(result.steps[i]).toMatchObject({
          isError: true,
          internalError: false,
          httpStatus: 400,
          text: real.error,
          raw: real,
          status: 'passed',
        })
      }
    })

    it('请求体超过上限是 413', async () => {
      const res = await postRun({
        steps: [tool('kioku_create', { content: 'x'.repeat(3 * 1024 * 1024) })],
      })
      expect(res.status).toBe(413)
      expect(((await res.json()) as { error: string }).error).toContain('过大')
    })
  })

  it('工具列表来自真实的 tools/list：和 /v1/mcp 的一样', async () => {
    const res = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${appId}/keys/${keyId}/bench/tools`,
      { headers: { cookie: ws.cookie } },
    )
    expect(res.status).toBe(200)
    const { tools } = (await res.json()) as BenchToolList
    const real = await app.request('/v1/mcp', {
      method: 'POST',
      headers: {
        ...bearer(plainKey),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const body = (await real.json()) as { result: { tools: unknown[] } }
    expect(tools).toEqual(body.result.tools)
    expect(tools.find((t) => t.name === 'kioku_create')!.inputSchema).toBeTruthy()
    // 契约里的判定按工具名走：新加的工具要写进这几张表，命令行的握手也按它核对
    expect(tools.map((t) => t.name).sort()).toEqual([...BENCH_TOOLS].sort())
    const readOnly = (t: BenchTool) =>
      (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true
    expect(
      tools
        .filter(readOnly)
        .map((t) => t.name)
        .sort(),
    ).toEqual([...BENCH_READ_TOOLS].sort())
  })

  it('权限按 Key 现在的有效上限：主人被降级之后，secret 级的 Key 按 private 算', async () => {
    await database.db
      .update(spaceMembers)
      .set({ role: 'editor' })
      .where(eq(spaceMembers.accountId, ws.accountId))
    const result = await run({
      steps: [
        { kind: 'whoami' },
        { kind: 'boot', requires: { maxSensitivity: 'secret' } },
        tool(
          'kioku_create',
          { uri: 'notes://x', content: 'x', sensitivity: 'secret' },
          { expect: { error: true } },
        ),
      ],
    })
    expect(result.whoami.scopes.maxSensitivity).toBe('private')
    expect(result.steps.map((s) => s.status)).toEqual(['passed', 'skipped', 'passed'])
  })

  describe('回滚模式', () => {
    it('回滚后所有表与 Key 的最后使用时间不变', async () => {
      await saveExtractionConfig(database.db, masterKey, {
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'fake',
        apiKey: 'x',
      })
      await realTool('kioku_create', { uri: 'notes://existing', content: '已有的', priority: 2 })
      await realTool('kioku_create', {
        uri: 'notes://sealed',
        content: SECRET_BODY,
        sensitivity: 'secret',
      })
      // 走过真实接口之后等最后使用时间写完：它不等请求结束。这一次写下的时间不早于发请求的时间
      const since = Date.now()
      await realTool('kioku_list')
      await vi.waitFor(async () =>
        expect((await lastUsedAt())?.getTime()).toBeGreaterThanOrEqual(since),
      )
      const used = await lastUsedAt()
      const before = await fingerprint()

      const result = await run({
        steps: [
          lifecycle({ event: 'session.start', project: { dirName: 'kioku' } }),
          lifecycle({ event: 'prompt.submit', prompt: '已有的', context: GROUP }),
          { kind: 'recall', body: { query: '已有的', context: GROUP } },
          lifecycle(TURN_END),
          { kind: 'boot' },
          { kind: 'whoami' },
          tool('kioku_create', { uri: 'notes://new', content: '新的', glossary: ['新的关键词'] }),
          tool('kioku_update', { uri: 'notes://existing', content: '改了', sensitivity: 'secret' }),
          tool('kioku_update', { uri: 'notes://sealed', priority: 9 }),
          tool('kioku_move', { from: 'notes://new', to: 'notes://moved' }),
          tool('kioku_search', { query: '新的关键词' }),
          tool('kioku_credential_save', {
            identifier: 'nas',
            name: 'NAS',
            values: { password: 'hunter2-value' },
          }),
          tool('kioku_credential', { identifier: 'nas' }),
          tool('kioku_delete', { uri: 'notes://moved' }),
        ],
      })
      expect(result.steps.map((s) => [s.label, s.status, s.isError])).toEqual(
        result.steps.map((s) => [s.label, 'passed', false]),
      )
      expect(await fingerprint()).toEqual(before)
      expect((await lastUsedAt())?.getTime()).toBe(used?.getTime())
      expect(await recallEventCount()).toBe(0)
    })

    it('后面的步骤读得到前面的写入，同一次运行里 URI 冲突照常 409 且事务还能继续', async () => {
      const result = await run({
        steps: [
          tool('kioku_create', { uri: 'notes://a', content: '第一次' }),
          tool('kioku_get', { uri: 'notes://a' }, { expect: { contains: ['第一次'] } }),
          tool(
            'kioku_create',
            { uri: 'notes://a', content: '再来一次' },
            {
              expect: { error: true, contains: ['已被占用'] },
            },
          ),
          tool(
            'kioku_update',
            { uri: 'notes://a', content: '改过' },
            {
              expect: { contains: ['版本: 2'] },
            },
          ),
        ],
      })
      expect(result.ok).toBe(true)
    })

    it('重放：先执行、结果不返回，当前步骤读得到；有步骤报错就停下，当前步骤不执行', async () => {
      const first = await run({
        steps: [tool('kioku_create', { uri: 'notes://${run}', content: '第一轮写的' })],
      })
      const entry = first.steps[0]!.replay!
      expect(entry).toMatchObject({ kind: 'tool', tool: 'kioku_create' })
      const uri = (entry.kind === 'tool' ? entry.arguments.uri : null) as string
      expect(uri).toBe(`notes://${first.run}`)

      // 第二轮：带上第一轮的写入，读得到，真实的库里没有
      const second = await run({
        steps: [tool('kioku_get', { uri }, { expect: { contains: ['第一轮写的'] } })],
        replay: [entry],
      })
      expect(second.ok).toBe(true)
      expect(second.steps).toHaveLength(1)
      expect(second.replayDiverged).toBeNull()
      expect((await realTool('kioku_get', { uri })).isError).toBe(true)

      // 重放里同一条写两次：第二条报错，后面不执行
      const diverged = await run({
        steps: [tool('kioku_get', { uri })],
        replay: [entry, entry],
      })
      expect(diverged.replayDiverged).toMatchObject({ index: 1, internalError: false })
      expect(diverged.replayDiverged!.text).toContain('已被占用')
      expect(diverged.steps[0]).toMatchObject({ status: 'notRun', isError: false })
      expect(diverged.ok).toBe(false)

      const replayed = await run({
        mode: 'real',
        steps: [tool('kioku_get', { uri })],
        replay: [entry],
      }).catch((err: Error) => err.message)
      expect(replayed).toContain('HTTP 400')
    })

    it('外部绑定：回滚模式换成占位文字、不记访问；真实模式照常返回，访问记录带标记，也列在 changes 里', async () => {
      const asOwner = async <T>(path: string, body: unknown) => {
        const res = await app.request(
          `/v1/spaces/${ws.spaceId}${path}`,
          jsonRequest('POST', body, { cookie: ws.cookie }),
        )
        if (!res.ok) throw new Error(await res.text())
        return (await res.json()) as T
      }
      const provider = await asOwner<{ id: string }>('/credential-providers', {
        kind: 'bitwarden',
        name: '密码库',
        instructions: '在工作站上解锁',
      })
      const credential = await asOwner<{ id: string }>('/credentials', {
        identifier: 'router',
        name: '路由器',
        source: {
          kind: 'external',
          providerId: provider.id,
          location: 'router admin login',
          fields: [{ name: 'password', sourceField: 'password' }],
        },
      })
      const accessEvents = async () => {
        const res = await app.request(
          `/v1/spaces/${ws.spaceId}/credentials/${credential.id}/events`,
          { headers: { cookie: ws.cookie } },
        )
        return ((await res.json()) as CredentialEventList).items.filter((e) => e.type === 'access')
      }
      const take = tool('kioku_credential', { identifier: 'router' })

      const rolled = await step(take)
      expect(rolled.text).toContain('密码库')
      for (const hidden of ['router admin login', '在工作站上解锁', 'bw get item']) {
        expect(JSON.stringify(rolled)).not.toContain(hidden)
      }
      expect(rolled.changes!.credentials).toEqual([])
      expect(await accessEvents()).toEqual([])

      const real = await run({ mode: 'real', steps: [take] })
      const taken = real.steps[0]!
      for (const shown of ['router admin login', '在工作站上解锁', 'bw get item']) {
        expect(taken.text).toContain(shown)
      }
      expect(taken.changes!.credentials).toEqual([
        { type: 'access', identifier: 'router', fields: ['password'], changes: [] },
      ])
      const events = await accessEvents()
      expect(events).toHaveLength(1)
      expect(events[0]!.via).toBe('kioku_credential')
      expect(events[0]!.bench).toEqual({ accountName: 'alice', run: real.run })
    })

    it('打码：secret 正文与托管的值不出现在结果里，降级与改正文被拒，重放也一样', async () => {
      await realTool('kioku_create', {
        uri: 'notes://sealed',
        content: SECRET_BODY,
        sensitivity: 'secret',
      })
      const steps = [
        tool('kioku_get', { uri: 'notes://sealed' }),
        tool('kioku_list', { of: 'notes://sealed' }),
        tool('kioku_update', { uri: 'notes://sealed', priority: 5 }),
        tool('kioku_move', { from: 'notes://sealed', to: 'notes://sealed2' }),
        tool(
          'kioku_update',
          { uri: 'notes://sealed2', sensitivity: 'private' },
          {
            expect: { error: true, contains: ['记忆页'] },
          },
        ),
        tool(
          'kioku_update',
          { uri: 'notes://sealed2', content: '占位' },
          {
            expect: { error: true, contains: ['记忆页'] },
          },
        ),
        tool('kioku_credential_save', {
          identifier: 'nas',
          name: 'NAS',
          values: { password: 'hunter2-value' },
        }),
        tool(
          'kioku_credential',
          { identifier: 'nas' },
          { expect: { contains: ['字段：password'] } },
        ),
      ]
      const rolled = await run({ steps })
      expect(rolled.ok).toBe(true)
      expect(JSON.stringify(rolled)).not.toContain(SECRET_BODY)
      // 回显的只有请求里没有的结果，toEqual 的是结果文本；请求里的值不进结果
      expect(JSON.stringify(rolled.steps.map((s) => [s.text, s.raw, s.changes]))).not.toContain(
        'hunter2-value',
      )
      const real = await run({ mode: 'real', steps })
      expect(real.ok).toBe(true)
      expect(JSON.stringify(real)).not.toContain(SECRET_BODY)
      expect(JSON.stringify(real.steps.map((s) => [s.text, s.raw, s.changes]))).not.toContain(
        'hunter2-value',
      )
      expect((await realTool('kioku_get', { uri: 'notes://sealed2' })).text).toContain(SECRET_BODY)

      const replay = await run({
        steps: [{ kind: 'whoami' }],
        replay: [
          {
            kind: 'tool',
            tool: 'kioku_update',
            arguments: { uri: 'notes://sealed2', content: 'x' },
          },
        ],
      })
      expect(replay.replayDiverged!.text).toContain('记忆页')
    })

    it.each(['rollback', 'real'] as const)(
      '占位文字写回被拒（%s）：模型照抄读到的结果，什么都不写',
      async (mode) => {
        await realTool('kioku_create', {
          uri: 'notes://sealed',
          content: SECRET_BODY,
          sensitivity: 'secret',
        })
        const seen = await step(tool('kioku_get', { uri: 'notes://sealed' }), mode)
        const result = await run({
          mode,
          steps: [
            tool(
              'kioku_create',
              { uri: 'notes://copied', content: seen.text },
              { expect: { error: true, contains: ['占位文字'] } },
            ),
            tool(
              'kioku_credential_save',
              { identifier: 'copied', name: '抄的', values: { password: seen.text } },
              { expect: { error: true, contains: ['占位文字'] } },
            ),
          ],
        })
        expect(result.ok).toBe(true)
        expect(result.steps.flatMap((s) => (s.replay ? [s.replay] : []))).toEqual([])
        expect((await realTool('kioku_get', { uri: 'notes://copied' })).isError).toBe(true)
        expect((await realTool('kioku_credential', { identifier: 'copied' })).isError).toBe(true)
      },
    )

    it('同一组调用和走真实 /v1/mcp 的输出相同（工具不带会话上下文）', async () => {
      await realTool('kioku_create', {
        uri: 'core://agent',
        content: '先读正文再信任',
        layer: 'base',
        sensitivity: 'public',
        priority: 0,
      })
      const calls: [string, Record<string, unknown>][] = [
        ['kioku_boot', {}],
        ['kioku_list', {}],
        ['kioku_get', { uri: 'core://agent' }],
        ['kioku_get', { uri: 'core://missing' }],
        [
          'kioku_create',
          {
            uri: 'notes://same',
            content: '正文',
            disclosure: '什么时候想起',
            glossary: ['同一组调用'],
          },
        ],
        ['kioku_create', { uri: 'notes://same', content: '重复' }],
        ['kioku_create', { uri: 'bad uri', content: '格式不对' }],
        ['kioku_update', { uri: 'notes://same', content: '改过', glossary_add: ['又一个词'] }],
        ['kioku_update', { uri: 'notes://same', priority: 3, expected_version: 99 }],
        ['kioku_search', { query: '同一组调用' }],
        ['kioku_list', { of: 'notes' }],
        ['kioku_move', { from: 'notes://same', to: 'notes://moved' }],
        ['kioku_get', { uri: 'notes://moved' }],
        ['kioku_delete', { uri: 'notes://moved' }],
        ['kioku_get', { uri: 'notes://moved' }],
        ['kioku_credential', {}],
        ['kioku_unknown', {}],
      ]
      const benched = await run({
        steps: calls.map(([name, args]) => tool(name, args)),
      })
      const expected: { text: string; isError: boolean }[] = []
      for (const [name, args] of calls) expected.push(await realTool(name, args))
      expect(benched.steps.map((s) => ({ text: s.text, isError: s.isError }))).toEqual(expected)
    })

    it('同一把 Key、群聊上下文下 prompt.submit 召回不到私人层，kioku_get 读得到', async () => {
      await realTool('kioku_create', {
        uri: 'notes://lan',
        content: '家里的内网地址',
        layer: 'private',
        glossary: ['内网'],
      })
      const result = await run({
        steps: [
          lifecycle(
            { event: 'prompt.submit', prompt: '内网在哪', context: GROUP },
            { expect: { error: false, notUris: ['notes://lan'], notContains: ['notes://lan'] } },
          ),
          {
            kind: 'recall',
            body: { query: '内网', context: GROUP },
            expect: { notUris: ['notes://lan'] },
          },
          tool(
            'kioku_get',
            { uri: 'notes://lan' },
            {
              expect: { error: false, contains: ['家里的内网地址'] },
            },
          ),
          lifecycle(
            { event: 'prompt.submit', prompt: '内网在哪' },
            { expect: { uris: ['notes://lan'] } },
          ),
        ],
      })
      expect(result.ok).toBe(true)
    })

    it('session.start 的结果多带字数上限、没展开的节点与放不下的附加块', async () => {
      for (const i of [1, 2]) {
        await realTool('kioku_create', {
          uri: `core://big${i}`,
          content: '大'.repeat(5_000),
          layer: 'base',
          sensitivity: 'public',
          priority: 0,
        })
      }
      const started = await step(lifecycle({ event: 'session.start' }))
      expect(started.session).toEqual({ limit: 9_500, omitted: ['core://big2'], dropped: [] })
      expect(started.uris).toEqual(['core://big1'])
      expect(started.raw).toEqual({
        hostOutput: { mode: 'stdout_json', value: expect.anything() },
        nodeUris: ['core://big1'],
      })
      const prompt = await step(lifecycle({ event: 'prompt.submit', prompt: '你好' }))
      expect(prompt.session).toBeNull()
    })

    it('工具结果的 URI 列表只看结构行：正文里写成结构行样子的不算，kioku_boot 的断言明确失败', async () => {
      const lookalikes = ['core://agent', 'foo://bar', 'projects://x', 'fake://y', 'list://fake']
      const body = [
        '- core://agent',
        'URI: foo://bar',
        '## projects://x',
        '0.59 | fake://y | 线索',
        '子节点：',
        '- list://fake（private，priority 2）',
      ].join('\n')
      const expected = (uris: string[]) => ({ expect: { uris, notUris: lookalikes } })
      const result = await run({
        steps: [
          tool(
            'kioku_create',
            { uri: 'notes://real', content: body, glossary: ['结构行的关键词'] },
            expected(['notes://real']),
          ),
          tool('kioku_get', { uri: 'notes://real' }, expected(['notes://real'])),
          tool('kioku_update', { uri: 'notes://real', priority: 3 }, expected(['notes://real'])),
          tool(
            'kioku_create',
            { uri: 'notes://real/child', content: body },
            expected(['notes://real/child']),
          ),
          tool('kioku_list', { of: 'notes://real' }, expected(['notes://real/child'])),
          tool('kioku_search', { query: '结构行的关键词' }, expected(['notes://real'])),
          tool(
            'kioku_move',
            { from: 'notes://real/child', to: 'notes://moved' },
            expected(['notes://moved']),
          ),
          // 子节点移走之后没有子节点了：父节点正文里那几行也不算
          tool('kioku_list', { of: 'notes://real' }, { expect: { notUris: lookalikes } }),
        ],
      })
      expect(result.steps.flatMap((s) => s.assertions.filter((a) => !a.ok))).toEqual([])
      expect(result.steps.map((s) => s.status)).toEqual(result.steps.map(() => 'passed'))
      expect(result.steps[7]!.uris).toEqual([])
      expect(result.steps[7]!.text).toContain('list://fake')

      // 启动节点的正文里写着标题的样子：工具分不清，/boot 有结构化的 entries
      await realTool('kioku_create', {
        uri: 'core://boot-node',
        content: body,
        layer: 'base',
        sensitivity: 'public',
        priority: 0,
      })
      const boot = await run({
        steps: [
          tool('kioku_boot', {}, { expect: { uris: ['core://boot-node'] } }),
          tool('kioku_boot', {}, { expect: { notUris: ['projects://x'] } }),
          { kind: 'boot', expect: { uris: ['core://boot-node'], notUris: ['projects://x'] } },
          lifecycle(
            { event: 'session.start' },
            { expect: { uris: ['core://boot-node'], notUris: ['projects://x'] } },
          ),
        ],
      })
      expect(boot.steps.map((s) => s.status)).toEqual(['failed', 'failed', 'passed', 'passed'])
      expect(boot.steps[0]!.uris).toBeNull()
      expect(boot.steps[0]!.assertions[0]!.message).toContain('无法区分')
      expect(boot.steps[1]!.assertions[0]!.message).toContain('无法区分')
      // 界面按契约校验响应：没有列表（null）也要过
      expect(BenchRunResult.safeParse(boot).success).toBe(true)
    })

    it('跑过一步之后，根事务上不经 withSpace 查内容表返回空，和真实一样', async () => {
      const found = await keyToSimulate(deps, { spaceId: ws.spaceId, appId, keyId }, ws.accountId)
      if ('error' in found) throw new Error(found.error)
      await inRollback(deps, { model: null, vectors: new Map() }, async (scoped, rollback) => {
        const executor = inProcessExecutor(scoped, found.key, {
          run: 'r',
          account: ws.accountId,
          rollback,
        })
        const created = await executor.execute({
          kind: 'tool',
          tool: 'kioku_create',
          arguments: { uri: 'notes://written', content: '这一步写的' },
        })
        expect(created.isError).toBe(false)
        await expect(scoped.db.select().from(memories)).resolves.toEqual([])
        // 下一步照常读得到
        const read = await executor.execute({
          kind: 'tool',
          tool: 'kioku_get',
          arguments: { uri: 'notes://written' },
        })
        expect(read.text).toContain('这一步写的')
      })
    })

    it('只读与不满足 requires 的步骤记跳过，不算失败', async () => {
      const readonly = await ws.createKey(appId, {
        readLayers: ['base'],
        writeLayers: [],
        maxSensitivity: 'public',
        admin: false,
      })
      const res = await postRun(
        {
          steps: [
            { kind: 'whoami' },
            tool(
              'kioku_create',
              { uri: 'notes://x', content: 'x' },
              {
                requires: { writeLayers: ['private'] },
              },
            ),
          ],
        },
        ws.cookie,
        app,
        readonly.id,
      )
      const result = (await res.json()) as BenchRunResult
      expect(result.steps.map((s) => s.status)).toEqual(['passed', 'skipped'])
      expect(result.steps[1]!.reason).toContain('无权写入 private')
      expect(result.whoami.scopes.writeLayers).toEqual([])
      expect(result.ok).toBe(true)
    })
  })

  describe('内部错误', () => {
    // 另一条连接拿着表锁，等锁超时
    const holdLock = async (table: string, db: Db = other.db) => {
      const release = deferred()
      const held = deferred()
      const hold = db.transaction(async (tx) => {
        await tx.execute(sql.raw(`lock table ${table} in access exclusive mode`))
        held.resolve()
        await release.promise
      })
      await held.promise
      return async () => {
        release.resolve()
        await hold
      }
    }
    const limited = (limits: Partial<BenchLimits>) => createApp({ ...deps, benchLimits: limits })

    it('工具步骤等锁超时：只有固定文字，标 internalError 与等锁超时，「应当报错」也算失败，后面的步骤照常', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await realTool('kioku_create', { uri: 'notes://locked', content: '不该出现的正文' })
      const release = await holdLock('memories')
      try {
        const result = await run(
          {
            steps: [
              tool('kioku_get', { uri: 'notes://locked' }, { expect: { error: true } }),
              { kind: 'whoami' },
            ],
          },
          limited({ lockTimeoutMs: 100 }),
        )
        expect(result.steps[0]).toMatchObject({
          status: 'failed',
          isError: true,
          internalError: true,
          internalDetail: 'lock_timeout',
          text: '服务内部错误',
        })
        expect(JSON.stringify(result)).not.toContain('Failed query')
        // 出错的是 savepoint 里的语句，只回滚那一层，下一步照常
        expect(result.steps[1]!.status).toBe('passed')
      } finally {
        await release()
        error.mockRestore()
      }
      expect(JSON.stringify(error.mock.calls)).not.toContain('Failed query')
    })

    it('根事务上的语句出错：这一步内部错误，后面的步骤记为没有执行，算失败', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await saveExtractionConfig(database.db, masterKey, {
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'fake',
        apiKey: 'x',
      })
      // turn.end 读抽取设置那一句直接写在 deps.db 上，落在根事务上
      const release = await holdLock('settings')
      try {
        const result = await run(
          {
            steps: [
              { kind: 'whoami' },
              lifecycle(TURN_END),
              { kind: 'whoami' },
              tool(
                'kioku_create',
                { uri: 'notes://never', content: '不会执行' },
                {
                  requires: { maxSensitivity: 'secret' },
                },
              ),
            ],
          },
          limited({ lockTimeoutMs: 100 }),
        )
        expect(result.steps[1]).toMatchObject({
          status: 'failed',
          internalError: true,
          httpStatus: 500,
          text: '服务内部错误',
        })
        expect(result.steps[1]!.internalDetail).toBe('lock_timeout')
        expect(result.steps.slice(2).map((s) => s.status)).toEqual(['notRun', 'notRun'])
        expect(result.steps[2]!.reason).toContain('根事务出错')
        expect(result.ok).toBe(false)
        expect(result.counts).toEqual({ passed: 1, failed: 1, skipped: 0, notRun: 2 })
      } finally {
        await release()
        error.mockRestore()
      }
    })

    it('总时长到了：后面的步骤记为没有执行，已经结束的步骤结果保留', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const release = await holdLock('memories')
      try {
        const result = await run(
          {
            steps: [
              tool('kioku_get', { uri: 'notes://locked' }),
              tool('kioku_get', { uri: 'notes://locked' }),
            ],
          },
          // 第一步开始时还没到总时长，等锁等到时限时已经过了
          limited({ lockTimeoutMs: 800, runMs: 400 }),
        )
        expect(result.steps[0]!.internalDetail).toBe('lock_timeout')
        expect(result.steps[1]!.status).toBe('notRun')
        expect(result.steps[1]!.reason).toContain('总时长')
      } finally {
        await release()
        error.mockRestore()
      }
    })

    it('列改动时记下的错误原因当场取走，不留到下一步', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const found = await keyToSimulate(deps, { spaceId: ws.spaceId, appId, keyId }, ws.accountId)
      if ('error' in found) throw new Error(found.error)
      const release = await holdLock('memory_events')
      try {
        await inRollback(
          { ...deps, benchLimits: { lockTimeoutMs: 100 } },
          { model: null, vectors: new Map() },
          async (scoped, rollback) => {
            const executor = inProcessExecutor(scoped, found.key, {
              run: 'r',
              account: ws.accountId,
              rollback,
            })
            const outcome = await executor.execute({ kind: 'whoami' })
            // 这一步本身没事，只是列不出改动
            expect(outcome).toMatchObject({
              isError: false,
              internalError: false,
              internalDetail: null,
              changes: null,
            })
            expect(rollback.takeDetail()).toBeNull()
          },
        )
      } finally {
        await release()
        error.mockRestore()
      }
    })

    it('这一步自己的内部错误不算到列改动的超时头上', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const found = await keyToSimulate(deps, { spaceId: ws.spaceId, appId, keyId }, ws.accountId)
      if ('error' in found) throw new Error(found.error)
      const release = await holdLock('memory_events')
      try {
        await inRollback(
          { ...deps, benchLimits: { lockTimeoutMs: 100 } },
          { model: null, vectors: new Map() },
          async (scoped, rollback) => {
            const executor = inProcessExecutor(scoped, found.key, {
              run: 'r',
              account: ws.accountId,
              rollback,
            })
            // 正文带 NUL：写库报 22021，不是超时；接着列改动时才等锁超时
            const outcome = await executor.execute({
              kind: 'tool',
              tool: 'kioku_create',
              arguments: {
                uri: 'projects://bench/nul',
                content: 'a\u0000b',
                priority: 2,
                glossary: [],
              },
            })
            expect(outcome).toMatchObject({
              internalError: true,
              internalDetail: null,
              changes: null,
            })
            expect(rollback.takeDetail()).toBeNull()
          },
        )
      } finally {
        await release()
        error.mockRestore()
      }
    })

    it('闸门：同时运行数到了上限时第三个请求 429（连接池要比闸门大，否则鉴权就拿不到连接）', async () => {
      const big = connect(testDatabaseUrl!, { max: 6 })
      try {
        const target = createApp({ ...deps, db: big.db })
        await realTool('kioku_create', { uri: 'notes://busy', content: '被占着的' })
        // 两个运行都卡在等行锁上
        const release = deferred()
        const held = deferred()
        const hold = withSpace(other.db, ws.spaceId, async (tx) => {
          await tx.update(memories).set({ priority: 7 }).where(eq(memories.path, 'busy'))
          held.resolve()
          await release.promise
        })
        await held.promise
        const update = { steps: [tool('kioku_update', { uri: 'notes://busy', priority: 8 })] }
        const blocked = [postRun(update, ws.cookie, target), postRun(update, ws.cookie, target)]
        let waiting = 0
        for (let i = 0; i < 200 && waiting < 2; i++) {
          const [row] = await other.db.execute<{ n: number }>(sql`
            select count(*)::int as n from pg_stat_activity
            where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`)
          waiting = row!.n
          if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(waiting).toBe(2)
        const third = await postRun({ steps: [{ kind: 'whoami' }] }, ws.cookie, target)
        expect(third.status).toBe(429)
        expect(((await third.json()) as { error: string }).error).toContain('稍后重试')
        // 真实模式不占闸门：它不占着事务
        const real = await postRun({ mode: 'real', steps: [{ kind: 'whoami' }] }, ws.cookie, target)
        expect(real.status).toBe(200)
        release.resolve()
        await hold
        expect((await Promise.all(blocked)).map((r) => r.status)).toEqual([200, 200])
        const after = await postRun({ steps: [{ kind: 'whoami' }] }, ws.cookie, target)
        expect(after.status).toBe(200)
      } finally {
        await big.close()
      }
    })
  })

  describe('查询向量', () => {
    const spied = (embedder: ReturnType<typeof fakeEmbedder>): { deps: Deps; order: string[] } => {
      const order: string[] = []
      const source: EmbedderSource = staticEmbedderSource({
        model: embedder.model,
        embed: (texts, options) => {
          order.push('嵌入')
          return embedder.embed(texts, options)
        },
      })
      const db = new Proxy(database.db, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown
          if (prop !== 'transaction') return value
          return (...args: Parameters<Db['transaction']>) => {
            order.push('开事务')
            return target.transaction(...args)
          }
        },
      })
      return { deps: { ...deps, db, embedder: source }, order }
    }
    const principal = async () => {
      const found = await keyToSimulate(deps, { spaceId: ws.spaceId, appId, keyId }, ws.accountId)
      if ('error' in found) throw new Error(found.error)
      return found.key
    }

    it('开事务之前算好，事务里不请求嵌入接口；运行时才知道的查询只走全文与关键词并标明', async () => {
      await realTool('kioku_create', {
        uri: 'notes://hit',
        content: '向量也能命中的正文',
        glossary: ['字面量查询'],
      })
      const embedder = fakeEmbedder()
      const { deps: scoped, order } = spied(embedder)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = await runBench(scoped, await principal(), ws.accountId, {
        mode: 'rollback',
        replay: [],
        steps: [
          tool(
            'kioku_create',
            { uri: 'notes://${run}/new', content: '查询的来源：运行时' },
            {
              capture: { query: '查询的来源：' },
            },
          ) as never,
          tool('kioku_search', { query: '字面量查询 ${run}' }) as never,
          lifecycle({ event: 'prompt.submit', prompt: '字面量查询' }) as never,
          { kind: 'recall', body: { query: '字面量查询', limit: 5 } },
          tool('kioku_search', { query: '依赖 ${query}' }) as never,
          lifecycle({ event: 'session.start', project: { dirName: 'kioku' } }) as never,
        ],
      })
      warn.mockRestore()
      expect(order.indexOf('嵌入')).toBeLessThan(order.indexOf('开事务'))
      expect(order.lastIndexOf('嵌入')).toBeLessThan(order.indexOf('开事务'))
      // 字面量的查询（${run} 已知）都算了，重复的只算一次，依赖 capture 的不算
      expect(embedder.calls.flat().sort()).toEqual(
        ['字面量查询', `字面量查询 ${result.run}`].sort(),
      )
      expect(result.steps.map((s) => s.vectorSkipped)).toEqual([
        false,
        false,
        false,
        false,
        true,
        false,
      ])
      expect(result.steps.every((s) => !s.internalError)).toBe(true)
    })

    it('实例没配嵌入模型时不算没算好', async () => {
      const result = await run({ steps: [tool('kioku_search', { query: '随便' })] })
      expect(result.steps[0]!.vectorSkipped).toBe(false)
    })

    it('真实模式不走这张表：照常请求嵌入接口', async () => {
      const embedder = fakeEmbedder()
      const { deps: scoped } = spied(embedder)
      await runBench(scoped, await principal(), ws.accountId, {
        mode: 'real',
        replay: [],
        steps: [tool('kioku_search', { query: '真实的查询' }) as never],
      })
      expect(embedder.calls).toEqual([['真实的查询']])
    })
  })

  describe('真执行会改什么', () => {
    const changesOf = (s: BenchStepResult) => s.changes!

    it('回滚模式按事务认：每一步只列这一步的，只给字段名，不带内容', async () => {
      await saveExtractionConfig(database.db, masterKey, {
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'fake',
        apiKey: 'x',
      })
      const result = await run({
        steps: [
          tool('kioku_create', { uri: 'notes://a', content: '正文一', disclosure: '想起一' }),
          tool('kioku_update', { uri: 'notes://a', content: '正文二', priority: 5 }),
          tool('kioku_move', { from: 'notes://a', to: 'notes://b' }),
          tool('kioku_get', { uri: 'notes://b' }),
          tool('kioku_update', { uri: 'notes://b', sensitivity: 'secret' }),
          tool('kioku_credential_save', {
            identifier: 'nas',
            name: 'NAS',
            values: { password: 'hunter2-value' },
          }),
          tool('kioku_credential_save', {
            identifier: 'nas',
            expected_version: 1,
            values: { password: 'changed-value' },
          }),
          lifecycle(TURN_END),
          lifecycle({ ...TURN_END, user: '第二轮' }),
          lifecycle({ event: 'prompt.submit', prompt: '你好' }),
          tool('kioku_delete', { uri: 'notes://b' }),
        ],
      })
      expect(result.ok).toBe(true)
      const [create, update, move, get, secret, saved, changed, turn, nextTurn, prompt, removed] =
        result.steps.map(changesOf)

      expect(create!.memories).toEqual([
        { type: 'create', uri: 'notes://a', fields: [], left: false, becameSecret: false },
      ])
      expect(update!.memories).toEqual([
        {
          type: 'update',
          uri: 'notes://a',
          fields: ['priority', 'content'],
          left: false,
          becameSecret: false,
        },
      ])
      expect(move!.memories[0]).toMatchObject({ type: 'move', uri: 'notes://b', fields: ['uri'] })
      expect(get!.memories).toEqual([])
      expect(secret!.memories).toEqual([
        {
          type: 'update',
          uri: 'notes://b',
          fields: ['sensitivity'],
          left: false,
          becameSecret: true,
        },
      ])
      expect(saved!.credentials).toEqual([
        { type: 'create', identifier: 'nas', fields: [], changes: [] },
      ])
      expect(changed!.credentials).toEqual([
        { type: 'update', identifier: 'nas', fields: ['password'], changes: ['values'] },
      ])
      expect(turn!).toMatchObject({
        subjects: 2,
        identities: [
          { kind: 'person', platform: 'bench' },
          { kind: 'group', platform: 'bench' },
        ],
        turns: 1,
        turn: { sessionId: 'bench-session', user: '群友说的话', reply: '回复的话' },
      })
      // 第二轮：对象已经有了，不再算新建；缓冲只算这一轮
      expect(nextTurn!).toMatchObject({ subjects: 0, identities: [], turns: 1 })
      expect(nextTurn!.turn!.user).toBe('第二轮')
      expect(prompt!).toMatchObject({ memories: [], subjects: 0, turns: 0, turn: null })
      expect(removed!.memories[0]).toMatchObject({ type: 'delete', uri: 'notes://b' })

      const allChanges = JSON.stringify(result.steps.map(changesOf))
      for (const content of [
        '正文一',
        '正文二',
        '想起一',
        'hunter2-value',
        'changed-value',
        'bench-user',
        'bench-group',
      ]) {
        expect(allChanges).not.toContain(content)
      }
    })

    it('重放不列改动，全部重放完推进一次水位：第一个真实步骤的改动不含重放的写入', async () => {
      await saveExtractionConfig(database.db, masterKey, {
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'fake',
        apiKey: 'x',
      })
      const eventChanges = vi.spyOn(MemoryService.prototype, 'eventChanges')
      try {
        const result = await run({
          replay: [
            {
              kind: 'tool',
              tool: 'kioku_create',
              arguments: { uri: 'notes://replayed', content: '重放写的' },
            },
            {
              kind: 'tool',
              tool: 'kioku_update',
              arguments: { uri: 'notes://replayed', priority: 4 },
            },
            {
              kind: 'tool',
              tool: 'kioku_credential_save',
              arguments: { identifier: 'nas', name: 'NAS', values: { password: 'hunter2-value' } },
            },
            { kind: 'lifecycle', body: TURN_END },
          ],
          steps: [
            tool('kioku_get', { uri: 'notes://replayed' }, { expect: { contains: ['重放写的'] } }),
            tool('kioku_create', { uri: 'notes://mine', content: '这一步写的' }),
            lifecycle({ ...TURN_END, user: '这一步说的' }),
          ],
        })
        expect(result.ok).toBe(true)
        expect(result.replayDiverged).toBeNull()
        const [read, created, turn] = result.steps.map(changesOf)
        expect(read!).toEqual({
          memories: [],
          hiddenReleased: 0,
          hiddenOther: 0,
          credentials: [],
          subjects: 0,
          identities: [],
          turns: 0,
          turn: null,
        })
        expect(created!.memories).toEqual([
          { type: 'create', uri: 'notes://mine', fields: [], left: false, becameSecret: false },
        ])
        expect(turn!).toMatchObject({ subjects: 0, identities: [], turns: 1 })
        expect(turn!.turn!.user).toBe('这一步说的')
        // 四步重放只推进一次水位，加上三个真实步骤
        expect(eventChanges).toHaveBeenCalledTimes(4)
      } finally {
        eventChanges.mockRestore()
      }
    })

    it('重放分叉时不列改动，也不推进水位', async () => {
      const eventChanges = vi.spyOn(MemoryService.prototype, 'eventChanges')
      try {
        const entry = {
          kind: 'tool',
          tool: 'kioku_create',
          arguments: { uri: 'notes://twice', content: '写两次' },
        }
        const result = await run({ replay: [entry, entry], steps: [{ kind: 'whoami' }] })
        expect(result.replayDiverged).toMatchObject({ index: 1 })
        expect(eventChanges).not.toHaveBeenCalled()
      } finally {
        eventChanges.mockRestore()
      }
    })

    it('没配抽取模型时 turn.end 不写缓冲，也就不回显', async () => {
      const turn = await step(lifecycle(TURN_END))
      expect(turn.changes).toMatchObject({ subjects: 2, turns: 0, turn: null })
    })

    it('让出别的成员的过期私人记录：只说让出了几条看不到的，不给任何字段', async () => {
      const member = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const bobMemory = {
        uri: 'projects://acme',
        content: '别人的私人正文',
        disclosure: '别人的 disclosure',
        glossary: ['别人的关键词'],
        layer: 'private',
      }
      const created = await app.request(
        `/v1/spaces/${ws.spaceId}/memories`,
        jsonRequest('POST', bobMemory, { cookie: member.cookie }),
      )
      expect(created.status).toBe(201)
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(memories)
          .set({ validTo: new Date(Date.now() - 60_000) })
          .where(eq(memories.path, 'acme')),
      )
      const result = await run({
        steps: [
          tool('kioku_create', {
            uri: 'projects://acme',
            content: '共享的新正文',
            layer: 'base',
            sensitivity: 'public',
          }),
        ],
      })
      const changes = result.steps[0]!.changes!
      expect(result.steps[0]!.isError).toBe(false)
      expect(changes.hiddenReleased).toBe(1)
      expect(changes.memories).toEqual([
        { type: 'create', uri: 'projects://acme', fields: [], left: false, becameSecret: false },
      ])
      const text = JSON.stringify(result)
      for (const hidden of [
        '别人的私人正文',
        '别人的 disclosure',
        '别人的关键词',
        member.accountId,
      ]) {
        expect(text).not.toContain(hidden)
      }
    })

    it('这把 Key 读不到的改动只数条数；改后读不到的只给改前的 URI', async () => {
      const narrow = await ws.createKey(appId, {
        readLayers: ['owner'],
        writeLayers: ['owner', 'private'],
        maxSensitivity: 'private',
        admin: false,
      })
      const res = await postRun(
        {
          steps: [
            tool('kioku_create', { uri: 'notes://a', content: '画像层的正文', layer: 'owner' }),
            tool('kioku_move', { from: 'notes://a', to: 'notes://b', layer: 'private' }),
            tool('kioku_create', { uri: 'notes://c', content: '私人层的正文', layer: 'private' }),
          ],
        },
        ws.cookie,
        app,
        narrow.id,
      )
      const result = (await res.json()) as BenchRunResult
      expect(result.steps.map((s) => s.isError)).toEqual([false, false, false])
      const [created, moved, hidden] = result.steps.map(changesOf)
      expect(created!.memories).toEqual([
        { type: 'create', uri: 'notes://a', fields: [], left: false, becameSecret: false },
      ])
      expect(moved!.memories).toEqual([
        { type: 'move', uri: 'notes://a', fields: [], left: true, becameSecret: false },
      ])
      expect(hidden).toMatchObject({ memories: [], hiddenReleased: 0, hiddenOther: 1 })
    })

    it('让出自己的过期记录：看得到，照常列出', async () => {
      await realTool('kioku_create', { uri: 'notes://mine', content: '旧的' })
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(memories)
          .set({ validTo: new Date(Date.now() - 60_000) })
          .where(eq(memories.path, 'mine')),
      )
      const created = await step(tool('kioku_create', { uri: 'notes://mine', content: '新的' }))
      expect(created.changes!.hiddenReleased).toBe(0)
      expect(created.changes!.memories.map((m) => m.type)).toEqual(['expire', 'create'])
    })

    it('运行期间另一条连接提交的事件、对象与缓冲都不进 changes（同一把 Key 也一样）', async () => {
      await saveExtractionConfig(database.db, masterKey, {
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'fake',
        apiKey: 'x',
      })
      const found = await keyToSimulate(deps, { spaceId: ws.spaceId, appId, keyId }, ws.accountId)
      if ('error' in found) throw new Error(found.error)
      const { key } = found
      const concurrent = { ...deps, db: other.db }
      const seen = await inRollback(deps, { model: null, vectors: new Map() }, async (scoped) => {
        const memory = memoryServiceForKey(scoped, key)
        const tracker = changeTracker(scoped, key, memory, { kind: 'transaction' })
        // 事务开始之后，另一条连接用同一把 Key 真实写入并提交；读已提交隔离下这里读得到
        await memoryServiceForKey(concurrent, key).create({
          uri: 'notes://concurrent',
          content: '别的连接写的',
          priority: 2,
          glossary: [],
        })
        await withSpace(other.db, ws.spaceId, async (tx) => {
          const [subject] = await tx
            .insert(subjects)
            .values({ spaceId: ws.spaceId, kind: 'person', displayName: '别的连接的对象' })
            .returning({ id: subjects.id })
          await tx.insert(conversationTurns).values({
            spaceId: ws.spaceId,
            appId,
            keyId,
            scope: `direct:${subject!.id}`,
            sessionId: 's',
            chatType: 'direct',
            senderSubjectId: subject!.id,
            userText: '别的连接的对话',
            replyText: '回复',
          })
        })
        await memory.create({
          uri: 'notes://mine',
          content: '这个事务写的',
          priority: 2,
          glossary: [],
        })
        const visible = await withSpace(scoped.db, ws.spaceId, async (tx) => ({
          memories: (await tx.select().from(memories)).length,
          turns: (await tx.select().from(conversationTurns)).length,
        }))
        return { visible, changes: await tracker.collect({ kind: 'whoami' }) }
      })
      // 确实读得到别的连接提交的
      expect(seen.visible).toEqual({ memories: 2, turns: 1 })
      expect(seen.changes).toMatchObject({
        memories: [{ type: 'create', uri: 'notes://mine' }],
        subjects: 0,
        identities: [],
        turns: 0,
        turn: null,
      })
    })
  })

  describe('真实模式', () => {
    const jobs = (): Jobs & { embeds: string[]; extractions: number } => {
      const state = {
        embeds: [] as string[],
        extractions: 0,
        enqueueEmbed: (_spaceId: string, memoryId: string) => void state.embeds.push(memoryId),
        enqueueBackfill: async () => true,
        enqueueSwitch: async () => true,
        enqueuePrune: async () => true,
        enqueueBackup: async () => null,
        backupRun: async () => null,
        enqueueCleanup: async () => true,
        enqueueDream: async () => null,
        dreamRun: async () => null,
        enqueueExtraction: async () => {
          state.extractions++
        },
      }
      return state
    }

    it('真实写入、排向量与抽取任务；事件带标记，活动接口返回它；不记召回事件、不更新最后使用时间', async () => {
      await saveExtractionConfig(database.db, masterKey, {
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'fake',
        apiKey: 'x',
      })
      const queue = jobs()
      const target = createApp({ ...deps, jobs: queue })
      const result = await run(
        {
          mode: 'real',
          steps: [
            tool('kioku_create', {
              uri: 'notes://real-${run}',
              content: '真的写了',
              glossary: ['真实关键词'],
            }),
            tool('kioku_search', { query: '真实关键词' }),
            lifecycle({ event: 'prompt.submit', prompt: '真实关键词' }),
            lifecycle(TURN_END),
            tool('kioku_update', { uri: 'notes://real-${run}', priority: 4 }),
          ],
        },
        target,
      )
      expect(result.mode).toBe('real')
      expect(result.ok).toBe(true)
      const uri = `notes://real-${result.run}`
      expect((await realToolAfterCheck(uri)).text).toContain('真的写了')
      expect(queue.embeds).toHaveLength(2)
      expect(queue.extractions).toBe(1)

      // 这一步改了什么按标记列；对象与对话缓冲没有标记，这个模式不列
      expect(result.steps[0]!.changes).toEqual({
        memories: [{ type: 'create', uri, fields: [], left: false, becameSecret: false }],
        hiddenReleased: 0,
        hiddenOther: 0,
        credentials: [],
        subjects: null,
        identities: null,
        turns: null,
        turn: null,
      })
      expect(result.steps[3]!.changes).toMatchObject({ memories: [], subjects: null, turns: null })
      expect(result.steps[4]!.changes!.memories).toEqual([
        { type: 'update', uri, fields: ['priority'], left: false, becameSecret: false },
      ])

      const activity = await app.request(`/v1/spaces/${ws.spaceId}/activity`, {
        headers: { cookie: ws.cookie },
      })
      const { items } = (await activity.json()) as ActivityList
      expect(items.map((i) => [i.type, i.bench])).toEqual([
        ['update', { accountName: 'alice', run: result.run }],
        ['create', { accountName: 'alice', run: result.run }],
      ])

      expect(await recallEventCount()).toBe(0)
      expect(await lastUsedAt()).toBeNull()
    })

    // 核对写进去了：这一步会更新最后使用时间，放在断言它之前的话要读库
    const realToolAfterCheck = async (uri: string) => {
      const found = await keyToSimulate(deps, { spaceId: ws.spaceId, appId, keyId }, ws.accountId)
      if ('error' in found) throw new Error(found.error)
      const view = await memoryServiceForKey(deps, found.key).get(uri)
      return { text: view.content ?? '' }
    }

    it('事件的标记只认这次运行：同一把 Key 之前的真实写入不算', async () => {
      await realTool('kioku_create', { uri: 'notes://before', content: '之前真实写的' })
      const [mine] = (
        await run({
          mode: 'real',
          steps: [tool('kioku_create', { uri: 'notes://during-${run}', content: '这次写的' })],
        })
      ).steps
      expect(mine!.changes!.memories).toHaveLength(1)
      expect(mine!.changes!.memories[0]!.uri).toContain('during')
    })

    it('回滚模式不排任务', async () => {
      const queue = jobs()
      await saveExtractionConfig(database.db, masterKey, {
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'fake',
        apiKey: 'x',
      })
      const result = await run(
        {
          steps: [tool('kioku_create', { uri: 'notes://x', content: 'x' }), lifecycle(TURN_END)],
        },
        createApp({ ...deps, jobs: queue }),
      )
      expect(result.ok).toBe(true)
      expect(queue.embeds).toHaveLength(0)
      expect(queue.extractions).toBe(0)
    })
  })
})
