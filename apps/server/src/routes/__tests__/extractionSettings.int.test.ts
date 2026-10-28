import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ExtractionSettingsView, ExtractionTestResult } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import type { Database } from '../../db/client'
import { settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('抽取模型的设置', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  // 本机的假接口：记下收到的 Key，按路径返回成功或失败
  let server: Server
  let baseUrl: string
  const seen: { path: string; authorization: string | undefined }[] = []

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? '', authorization: req.headers.authorization })
      if (req.url?.startsWith('/broken/')) {
        res.writeHead(502).end('upstream down')
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
    const bare = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: null,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
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
