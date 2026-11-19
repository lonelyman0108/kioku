import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inspect } from 'node:util'

import type {
  DreamBindingView,
  ExtractionBindingView,
  ModelChainTestResult,
  ModelProfileTestResult,
  ModelProviderView,
  ModelRegistryView,
} from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import type { Database } from '../../db/client'
import { settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { loadExtractionConfig, saveExtractionConfig } from '../../extraction/settings'
import {
  openTestDatabase,
  resetDatabase,
  settingsQueryFails,
  testDatabaseUrl,
} from '../../testing/db'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('模型服务商与用途绑定设置', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  const masterKey = randomBytes(32)
  const appWith = (deps: { db?: Database['db']; masterKey?: Buffer | null }) =>
    createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
      ...deps,
    })

  let server: Server
  let baseUrl: string
  const seen: { path: string; authorization: string | undefined }[] = []

  beforeAll(async () => {
    database = await openTestDatabase()
    app = appWith({})
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? '', authorization: req.headers.authorization })
      if (req.url?.startsWith('/broken/')) {
        res.writeHead(502).end('upstream down')
        return
      }
      if (req.url?.startsWith('/echo/')) {
        const key = (req.headers.authorization ?? '').replace('Bearer ', '')
        res.writeHead(401).end(`Incorrect API key provided: ${key}`)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve))
    await database?.db.delete(settings)
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    seen.length = 0
    ws = await bootstrap(app)
  })

  const call = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(`/v1/settings/models${path}`, jsonRequest(method, body, { cookie }))
  const registry = async () => (await (await call('GET', '')).json()) as ModelRegistryView
  const testExtraction = async () =>
    (await (await call('POST', '/bindings/extraction/test')).json()) as ModelChainTestResult

  const createProvider = async (body: Record<string, unknown>) => {
    const res = await call('POST', '/providers', body)
    expect(res.status).toBe(201)
    return (await res.json()) as ModelProviderView
  }

  it('只有实例管理员能看、能改', async () => {
    const bob = await addMember(database.db, ws.circleId, 'bob', 'owner')
    expect((await call('GET', '', undefined, bob.cookie)).status).toBe(403)
    expect(
      (
        await call(
          'POST',
          '/providers',
          {
            name: 'S',
            format: 'openai-chat',
            baseUrl: `${baseUrl}/v1`,
            profiles: [{ kind: 'chat', model: 'm' }],
          },
          bob.cookie,
        )
      ).status,
    ).toBe(403)
    expect((await call('PUT', '/bindings/extraction', { profileIds: [] }, bob.cookie)).status).toBe(
      403,
    )
    expect((await call('POST', '/bindings/extraction/test', undefined, bob.cookie)).status).toBe(
      403,
    )
  })

  it('服务商保存、查看与删除；Key 加密存库不返回；被绑定引用时拦截删除', async () => {
    const prov = await createProvider({
      name: '主力网关',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-extract',
      profiles: [{ kind: 'chat', label: '主力', model: 'example-chat-model' }],
    })
    expect(prov).toMatchObject({
      name: '主力网关',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/v1`,
      hasApiKey: true,
    })
    const pid = prov.profiles[0]!.id
    const rows = await database.db.select().from(settings)
    expect(JSON.stringify(rows)).not.toContain('sk-extract')

    const bound = await call('PUT', '/bindings/extraction', { profileIds: [pid] })
    expect(bound.status).toBe(200)
    expect((await bound.json()) as ExtractionBindingView).toEqual({
      configured: true,
      profileIds: [pid],
    })

    // 被抽取绑定引用时不能直接删掉服务商或移除该模型
    const blockedDel = await call('DELETE', `/providers/${prov.id}`)
    expect(blockedDel.status).toBe(400)
    expect(((await blockedDel.json()) as { error: string }).error).toContain('抽取模型')

    const dreamBound = await call('PUT', '/bindings/dream', { mode: 'custom', profileIds: [pid] })
    expect(dreamBound.status).toBe(200)
    expect((await dreamBound.json()) as DreamBindingView).toEqual({
      configured: true,
      mode: 'custom',
      profileIds: [pid],
    })

    // 解绑后可删除
    await call('PUT', '/bindings/extraction', { profileIds: [] })
    await call('PUT', '/bindings/dream', { mode: 'inherit', profileIds: [] })
    expect((await call('DELETE', `/providers/${prov.id}`)).status).toBe(204)
    expect((await registry()).providers).toEqual([])
  })

  it('换了接口主机必须重新说明 Key 怎么处理；同一主机沿用已保存的 Key', async () => {
    const prov = await createProvider({
      name: '网关',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-extract',
      profiles: [{ kind: 'chat', model: 'm' }],
    })
    const pid = prov.profiles[0]!.id
    const sameHost = await call('PUT', `/providers/${prov.id}`, {
      name: '网关',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/v2`,
      profiles: [{ id: pid, kind: 'chat', model: 'm2' }],
    })
    expect(sameHost.status).toBe(200)
    expect(await sameHost.json()).toMatchObject({ hasApiKey: true })

    expect(
      (
        await call('PUT', `/providers/${prov.id}`, {
          name: '网关',
          format: 'openai-chat',
          baseUrl: 'https://other.example.net/v1',
          profiles: [{ id: pid, kind: 'chat', model: 'm2' }],
        })
      ).status,
    ).toBe(400)

    const cleared = await call('PUT', `/providers/${prov.id}`, {
      name: '网关',
      format: 'openai-chat',
      baseUrl: 'https://other.example.net/v1',
      apiKey: null,
      profiles: [{ id: pid, kind: 'chat', model: 'm2' }],
    })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ hasApiKey: false })
  })

  it('连通性测试：单条模型测试与链式测试（含脱敏与状态码）', async () => {
    expect(await testExtraction()).toMatchObject({
      ok: false,
      results: [{ ok: false, error: '尚未绑定抽取模型' }],
    })

    const prov = await createProvider({
      name: '网关',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-extract',
      profiles: [{ kind: 'chat', model: 'm' }],
    })
    const pid = prov.profiles[0]!.id
    await call('PUT', '/bindings/extraction', { profileIds: [pid] })

    const single = (await (
      await call('POST', `/profiles/${pid}/test`)
    ).json()) as ModelProfileTestResult
    expect(single).toMatchObject({ ok: true, model: 'm', error: null })
    expect(seen).toEqual([{ path: '/v1/chat/completions', authorization: 'Bearer sk-extract' }])

    await call('PUT', `/providers/${prov.id}`, {
      name: '网关',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/echo/v1`,
      profiles: [{ id: pid, kind: 'chat', model: 'm' }],
    })
    const chain = await testExtraction()
    expect(chain.ok).toBe(false)
    expect(chain.results[0]?.error).toBe('模型接口返回 HTTP 401：Incorrect API key provided: ***')
  })

  it('已经存着的 Key 中间有换行（fetch 把整个请求头写进错误）：连通性测试报连不上，不带 Key', async () => {
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: `${baseUrl}/v1`,
      model: 'm',
      apiKey: 'sk-pasted\nwith-newline',
    })
    const failed = await testExtraction()
    expect(failed.ok).toBe(false)
    expect(failed.results[0]?.error).toContain('无法连接模型接口')
    expect(failed.results[0]?.error).not.toContain('sk-pasted')
    expect(failed.results[0]?.error).not.toContain('with-newline')
    expect(seen).toEqual([])
  })

  it('Key 解不开：连通性测试说明原因，不请求模型', async () => {
    const prov = await createProvider({
      name: '主力网关',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-extract',
      profiles: [{ kind: 'chat', model: 'm' }],
    })
    await call('PUT', '/bindings/extraction', { profileIds: [prov.profiles[0]!.id] })

    const probe = async (locked: ReturnType<typeof createApp>) => {
      const res = await locked.request(
        '/v1/settings/models/bindings/extraction/test',
        jsonRequest('POST', undefined, { cookie: ws.cookie }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as ModelChainTestResult
      expect(body.ok).toBe(false)
      return body.results[0]?.error
    }
    expect(await probe(appWith({ masterKey: null }))).toContain(
      '的 Key 已加密保存，但服务端未配置 KIOKU_MASTER_KEY',
    )
    const mismatch = await probe(appWith({ masterKey: randomBytes(32) }))
    expect(mismatch).toContain('的 Key 无法解密')
    expect(mismatch).toContain('旧密钥须配置在 KIOKU_MASTER_KEY_PREVIOUS')
    expect(seen).toEqual([])
  })

  it('读设置时数据库出错：500 与固定文字，响应和日志里都没有 SQL 与参数', async () => {
    const prov = await createProvider({
      name: '网关',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-extract',
      profiles: [{ kind: 'chat', model: 'm' }],
    })
    await call('PUT', '/bindings/extraction', { profileIds: [prov.profiles[0]!.id] })

    const broken = appWith({ db: settingsQueryFails(database.db) })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const responses = [
        await broken.request(
          '/v1/settings/models/bindings/extraction/test',
          jsonRequest('POST', undefined, { cookie: ws.cookie }),
        ),
        await broken.request(
          '/v1/settings/models/providers',
          jsonRequest(
            'POST',
            {
              name: '新网关',
              format: 'openai-chat',
              baseUrl: `${baseUrl}/v1`,
              apiKey: 'sk-new',
              profiles: [{ kind: 'chat', model: 'm' }],
            },
            { cookie: ws.cookie },
          ),
        ),
      ]
      for (const res of responses) {
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: '服务内部错误' })
      }
      expect(seen).toEqual([])
      expect(logged).toHaveBeenCalledTimes(2)
      const text = inspect(logged.mock.calls, { depth: null })
      for (const leaked of ['Failed query', 'params:', 'model-providers', 'select']) {
        expect(text).not.toContain(leaked)
      }
    } finally {
      logged.mockRestore()
    }
  })

  it('Key 首尾的空白去掉再存；中间有换行的 400；保存 Key 需要主密钥', async () => {
    const prov = await createProvider({
      name: '网关',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/v1`,
      apiKey: ' sk-extract\n',
      profiles: [{ kind: 'chat', model: 'm' }],
    })
    await call('PUT', '/bindings/extraction', { profileIds: [prov.profiles[0]!.id] })
    const stored = async () => (await loadExtractionConfig(database.db, masterKey))?.[0]?.apiKey
    expect(await stored()).toBe('sk-extract')

    const bad = await call('POST', '/providers', {
      name: '网关2',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-new\nkey',
      profiles: [{ kind: 'chat', model: 'm' }],
    })
    expect(bad.status).toBe(400)

    const bare = appWith({ masterKey: null })
    const noMaster = await bare.request(
      '/v1/settings/models/providers',
      jsonRequest(
        'POST',
        {
          name: '网关3',
          format: 'openai-chat',
          baseUrl: `${baseUrl}/v1`,
          apiKey: 'sk',
          profiles: [{ kind: 'chat', model: 'm' }],
        },
        { cookie: ws.cookie },
      ),
    )
    expect(noMaster.status).toBe(400)
    expect(((await noMaster.json()) as { error: string }).error).toContain('KIOKU_MASTER_KEY')
  })

  it('创建或编辑服务商传入未知或属于其他服务商的条目 ID 时忽略并重分配新 ID，不能劫持绑定', async () => {
    const provA = await createProvider({
      name: '服务商A',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-a',
      profiles: [{ kind: 'chat', model: 'm-a' }],
    })
    const pidA = provA.profiles[0]!.id
    await call('PUT', '/bindings/extraction', { profileIds: [pidA] })

    const provB = await createProvider({
      name: '服务商B',
      format: 'openai-chat',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-b',
      profiles: [{ id: pidA, kind: 'chat', model: 'm-b' }],
    })
    const pidB = provB.profiles[0]!.id
    expect(pidB).not.toBe(pidA)

    const updatedB = (await (
      await call('PUT', `/providers/${provB.id}`, {
        name: '服务商B',
        format: 'openai-chat',
        baseUrl: `${baseUrl}/v1`,
        profiles: [{ id: pidA, kind: 'chat', model: 'm-b2' }],
      })
    ).json()) as ModelProviderView
    expect(updatedB.profiles[0]!.id).not.toBe(pidA)

    const extractors = await loadExtractionConfig(database.db, masterKey)
    expect(extractors).toHaveLength(1)
    expect(extractors![0]!.model).toBe('m-a')
  })
})
