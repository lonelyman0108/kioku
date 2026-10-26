import { randomBytes } from 'node:crypto'

import type { CreatedKey, MemoryView } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memories, memoryEvents, settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  addMember,
  bearer,
  bootstrap,
  FULL_SCOPES,
  jsonRequest,
  type Workspace,
} from '../../testing/fixtures'

// 对已合并代码补做审查时发现的问题，每条一个回归用例
describe.skipIf(!testDatabaseUrl)('审查回归', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  const masterKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    ws = await bootstrap(app)
  })

  const appAs = async (cookie: string, slug: string) => {
    const res = await app.request(
      `/v1/spaces/${ws.spaceId}/apps`,
      jsonRequest('POST', { slug, name: slug, runtimeFamily: 'mcp' }, { cookie }),
    )
    return ((await res.json()) as { id: string }).id
  }
  const keyAs = async (cookie: string, appId: string) =>
    app.request(
      `/v1/spaces/${ws.spaceId}/apps/${appId}/keys`,
      jsonRequest('POST', { name: 'k', scopes: FULL_SCOPES }, { cookie }),
    )
  const create = (key: string, body: Record<string, unknown>) =>
    app.request('/v1/memories', jsonRequest('POST', body, bearer(key)))
  const get = (key: string, uri: string) =>
    app.request(`/v1/memories?uri=${encodeURIComponent(uri)}`, { headers: bearer(key) })

  it('同一空间的两个成员各有自己的 owner 层 URI', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const keyA = ws.issueKey((await ws.createApp('a-agent')).id)
    const keyB = (
      (await (await keyAs(b.cookie, await appAs(b.cookie, 'b-agent'))).json()) as CreatedKey
    ).key
    const ka = await keyA
    expect(
      (await create(ka, { uri: 'preferences://user', content: 'A 的偏好', layer: 'owner' })).status,
    ).toBe(201)
    expect(
      (await create(keyB, { uri: 'preferences://user', content: 'B 的偏好', layer: 'owner' }))
        .status,
    ).toBe(201)
    expect(((await (await get(ka, 'preferences://user')).json()) as MemoryView).content).toBe(
      'A 的偏好',
    )
    expect(((await (await get(keyB, 'preferences://user')).json()) as MemoryView).content).toBe(
      'B 的偏好',
    )
  })

  it('空间 owner 不能给别的成员的应用签发 Key，但可以吊销', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bApp = await appAs(b.cookie, 'b-agent')
    expect((await keyAs(ws.cookie, bApp)).status).toBe(403)
    const list = await app.request(`/v1/spaces/${ws.spaceId}/apps/${bApp}/keys`, {
      headers: { cookie: ws.cookie },
    })
    expect(list.status).toBe(403)
    const bKey = (await (await keyAs(b.cookie, bApp)).json()) as CreatedKey
    const revoke = await app.request(`/v1/spaces/${ws.spaceId}/apps/${bApp}/keys/${bKey.id}`, {
      method: 'DELETE',
      headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(revoke.status).toBe(204)
  })

  it('editor 不能修改别人的应用', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const aApp = (await ws.createApp('a-bot')).id
    const res = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${aApp}`,
      jsonRequest('PATCH', { config: { elevateOwnerDirect: 'internal' } }, { cookie: b.cookie }),
    )
    expect(res.status).toBe(403)
  })

  it('改成 secret 后历史事件里不再有明文', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    await create(key, { uri: 'home://router', content: '管理密码 hunter2' })
    await app.request(
      '/v1/memories',
      jsonRequest('PATCH', { uri: 'home://router', sensitivity: 'secret' }, bearer(key)),
    )
    const events = await withSpace(database.db, ws.spaceId, (tx) => tx.select().from(memoryEvents))
    expect(events).toHaveLength(2)
    expect(JSON.stringify(events)).not.toContain('hunter2')
  })

  it('父节点不存在时不能创建子节点；命名空间根可以直接浏览', async () => {
    const persona = await ws.createPersona('doubao')
    const key = await ws.issueKey(
      (await ws.createApp('agent', { defaultPersonaId: persona.id })).id,
    )
    expect((await create(key, { uri: 'projects://kioku/notes', content: 'x' })).status).toBe(400)
    expect((await create(key, { uri: 'persona://doubao/soul', content: 'x' })).status).toBe(201)
    const kids = await app.request(
      `/v1/memories/children?of=${encodeURIComponent('persona://doubao')}`,
      {
        headers: bearer(key),
      },
    )
    expect(kids.status).toBe(200)
  })

  it('已失效的记忆让出 URI', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    await create(key, { uri: 'home://ip', content: '旧地址' })
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 1000) })
        .where(eq(memories.path, 'ip')),
    )
    expect((await create(key, { uri: 'home://ip', content: '新地址' })).status).toBe(201)
    expect(((await (await get(key, 'home://ip')).json()) as MemoryView).content).toBe('新地址')
  })

  it('换了嵌入接口的主机，旧 Key 不再沿用', async () => {
    const put = (body: Record<string, unknown>) =>
      app.request('/v1/settings/embedding', jsonRequest('PUT', body, { cookie: ws.cookie }))
    await put({ baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: 'sk-secret' })
    expect(
      await (await put({ baseUrl: 'https://e.example.com/v2', model: 'm' })).json(),
    ).toMatchObject({
      hasApiKey: true,
    })
    expect(
      await (await put({ baseUrl: 'https://other.example.net/v1', model: 'm' })).json(),
    ).toMatchObject({
      hasApiKey: false,
    })
  })

  it('并发登录也只放行 5 次尝试', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.request(
          '/v1/auth/login',
          jsonRequest('POST', { username: 'alice', password: 'wrong' }),
        ),
      ),
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(5)
    expect(statuses.filter((s) => s === 429)).toHaveLength(15)
  })

  it('MCP 与 REST 用同一套长度限制', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: {
        ...bearer(key),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'kioku_create',
          arguments: { uri: 'core://big', content: 'x'.repeat(20_001), layer: 'base' },
        },
      }),
    })
    const body = (await res.json()) as { result?: { isError?: boolean }; error?: unknown }
    expect(body.error ?? body.result?.isError).toBeTruthy()
    expect((await get(key, 'core://big')).status).toBe(404)
  })
})
