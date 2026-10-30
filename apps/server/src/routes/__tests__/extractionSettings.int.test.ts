import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inspect } from 'node:util'

import type { ExtractionSettingsView, ExtractionTestResult } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
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

describe.skipIf(!testDatabaseUrl)('抽取模型的设置', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  const masterKey = randomBytes(32)
  // 换一个依赖建的应用：主密钥不同、数据库出错这些情况
  const appWith = (deps: { db?: Database['db']; masterKey?: Buffer | null }) =>
    createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
      ...deps,
    })
  // 本机的假接口：记下收到的 Key，按路径返回成功或失败
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
      // 把收到的 Key 写进报错
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
    // 实例设置不挂在空间下，resetDatabase 清不到：不给后面的测试留下用别的主密钥加密的 Key
    await database?.db.delete(settings).where(eq(settings.key, 'extraction'))
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings).where(eq(settings.key, 'extraction'))
    seen.length = 0
    ws = await bootstrap(app)
  })

  const call = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(`/v1/settings/extraction${path}`, jsonRequest(method, body, { cookie }))
  const view = async () => (await (await call('GET', '')).json()) as ExtractionSettingsView
  const test = async () => (await (await call('POST', '/test')).json()) as ExtractionTestResult

  it('只有实例管理员能看、能改', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
    expect((await call('GET', '', undefined, bob.cookie)).status).toBe(403)
    expect(
      (await call('PUT', '', { baseUrl: `${baseUrl}/v1`, model: 'm' }, bob.cookie)).status,
    ).toBe(403)
    expect((await call('DELETE', '', undefined, bob.cookie)).status).toBe(403)
    expect((await call('POST', '/test', undefined, bob.cookie)).status).toBe(403)
  })

  it('保存、查看与清除；Key 加密存库、不返回', async () => {
    expect(await view()).toEqual({
      configured: false,
      baseUrl: null,
      model: null,
      hasApiKey: false,
    })
    const saved = await call('PUT', '', {
      baseUrl: `${baseUrl}/v1`,
      model: 'example-chat-model',
      apiKey: 'sk-extract',
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({
      configured: true,
      baseUrl: `${baseUrl}/v1`,
      model: 'example-chat-model',
      hasApiKey: true,
    })
    const [row] = await database.db.select().from(settings).where(eq(settings.key, 'extraction'))
    expect(JSON.stringify(row!.value)).not.toContain('sk-extract')

    expect((await call('DELETE', '')).status).toBe(204)
    expect(await view()).toMatchObject({ configured: false, hasApiKey: false })
  })

  it('换了接口的主机必须重新说明 Key 怎么处理；同一主机沿用已保存的 Key', async () => {
    await call('PUT', '', { baseUrl: `${baseUrl}/v1`, model: 'm', apiKey: 'sk-extract' })
    expect(
      await (await call('PUT', '', { baseUrl: `${baseUrl}/v2`, model: 'm2' })).json(),
    ).toMatchObject({ hasApiKey: true, model: 'm2' })
    expect(
      (await call('PUT', '', { baseUrl: 'https://other.example.net/v1', model: 'm' })).status,
    ).toBe(400)
    expect(
      await (
        await call('PUT', '', { baseUrl: 'https://other.example.net/v1', model: 'm', apiKey: null })
      ).json(),
    ).toMatchObject({ hasApiKey: false })
  })

  it('连通性测试：没配时说明原因；配了就带着 Key 请求一次，接口出错时给出状态码', async () => {
    expect(await test()).toMatchObject({ ok: false, error: '还没有保存抽取模型的设置' })
    await call('PUT', '', { baseUrl: `${baseUrl}/v1`, model: 'm', apiKey: 'sk-extract' })
    expect(await test()).toMatchObject({ ok: true, error: null })
    expect(seen).toEqual([{ path: '/v1/chat/completions', authorization: 'Bearer sk-extract' }])

    await call('PUT', '', { baseUrl: `${baseUrl}/broken/v1`, model: 'm' })
    const failed = await test()
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('HTTP 502')
  })

  it('连通性测试时上游把 Key 写进报错：模型报的错看得到，Key 换掉', async () => {
    await call('PUT', '', { baseUrl: `${baseUrl}/echo/v1`, model: 'm', apiKey: 'sk-extract' })
    const failed = await test()
    expect(failed.ok).toBe(false)
    expect(failed.error).toBe('抽取模型返回 HTTP 401：Incorrect API key provided: ***')
  })

  it('已经存着的 Key 中间有换行（fetch 把整个请求头写进错误）：连通性测试报连不上，不带 Key', async () => {
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: `${baseUrl}/v1`,
      model: 'm',
      apiKey: 'sk-pasted\nwith-newline',
    })
    const failed = await test()
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('连不上抽取模型')
    expect(failed.error).not.toContain('sk-pasted')
    expect(failed.error).not.toContain('with-newline')
    expect(seen).toEqual([])
  })

  it('Key 解不开：连通性测试说明原因，不请求模型', async () => {
    await call('PUT', '', { baseUrl: `${baseUrl}/v1`, model: 'm', apiKey: 'sk-extract' })
    const probe = async (locked: ReturnType<typeof createApp>) => {
      const res = await locked.request(
        '/v1/settings/extraction/test',
        jsonRequest('POST', undefined, { cookie: ws.cookie }),
      )
      expect(res.status).toBe(200)
      const { ok, error } = (await res.json()) as ExtractionTestResult
      expect(ok).toBe(false)
      return error
    }
    expect(await probe(appWith({ masterKey: null }))).toContain(
      '抽取模型的 Key 已加密保存，但服务端没有配置 KIOKU_MASTER_KEY',
    )
    const mismatch = await probe(appWith({ masterKey: randomBytes(32) }))
    expect(mismatch).toContain('抽取模型的 Key 解不开')
    // 轮换主密钥时最容易碰到：提示旧的那把配在哪里
    expect(mismatch).toContain('旧的那把要配在 KIOKU_MASTER_KEY_PREVIOUS')
    expect(seen).toEqual([])
  })

  it('读设置时数据库出错：连通性测试与保存都是 500 与固定文字，响应和日志里都没有 SQL 与参数', async () => {
    await call('PUT', '', { baseUrl: `${baseUrl}/v1`, model: 'm', apiKey: 'sk-extract' })
    const broken = appWith({ db: settingsQueryFails(database.db) })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const responses = [
        await broken.request(
          '/v1/settings/extraction/test',
          jsonRequest('POST', undefined, { cookie: ws.cookie }),
        ),
        await broken.request(
          '/v1/settings/extraction',
          jsonRequest(
            'PUT',
            { baseUrl: `${baseUrl}/v1`, model: 'm', apiKey: 'sk-new' },
            { cookie: ws.cookie },
          ),
        ),
      ]
      for (const res of responses) {
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: '服务内部错误' })
      }
      expect(seen).toEqual([])
      // 前提：确实是数据库报的错（表不存在），这条用例测的是这种错误
      expect(logged).toHaveBeenCalledTimes(2)
      expect(logged.mock.calls[0]![1]).toMatchObject({ code: '42P01' })
      expect(logged.mock.calls[1]![1]).toMatchObject({ code: '42P01' })
      const text = inspect(logged.mock.calls, { depth: null })
      for (const leaked of ['Failed query', 'params:', 'extraction', 'select']) {
        expect(text).not.toContain(leaked)
      }
    } finally {
      logged.mockRestore()
    }
  })

  it('Key 首尾的空白去掉再存；中间有换行的 400，原来存的不变；只有空白的 400', async () => {
    const put = (apiKey: string) =>
      call('PUT', '', { baseUrl: `${baseUrl}/v1`, model: 'm', apiKey })
    const stored = async () => (await loadExtractionConfig(database.db, masterKey))?.apiKey

    expect((await put(' sk-extract\n')).status).toBe(200)
    expect(await stored()).toBe('sk-extract')
    await test()
    expect(seen[0]?.authorization).toBe('Bearer sk-extract')

    const inner = await put('sk-new\nkey')
    expect(inner.status).toBe(400)
    const { error } = (await inner.json()) as { error: string }
    expect(error).toContain('不能有换行等控制字符')
    expect(error).not.toContain('sk-new')
    expect(await stored()).toBe('sk-extract')

    expect((await put(' \n')).status).toBe(400)
    expect(await stored()).toBe('sk-extract')
  })

  it('接口地址只收 http 与 https：别的协议的 origin 都是 "null"，会被当成同一个主机', async () => {
    const res = await call('PUT', '', {
      baseUrl: 'ftp://a.example.com/v1',
      model: 'm',
      apiKey: 'sk',
    })
    expect(res.status).toBe(400)
    expect(await view()).toMatchObject({ configured: false })
  })

  it('保存 Key 需要主密钥', async () => {
    const bare = appWith({ masterKey: null })
    const res = await bare.request(
      '/v1/settings/extraction',
      jsonRequest(
        'PUT',
        { baseUrl: `${baseUrl}/v1`, model: 'm', apiKey: 'sk' },
        { cookie: ws.cookie },
      ),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('KIOKU_MASTER_KEY')
  })
})
