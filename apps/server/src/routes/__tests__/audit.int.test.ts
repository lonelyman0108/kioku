import { randomBytes } from 'node:crypto'

import type { CreatedKey, MemoryChildren, MemoryView } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memories, memoryEmbeddings, memoryEvents, settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { embedMemory } from '../../embedding/worker'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
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
      // editor 能签发的最高敏感级是 private
      jsonRequest(
        'POST',
        { name: 'k', scopes: { ...FULL_SCOPES, maxSensitivity: 'private' } },
        { cookie },
      ),
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
  it('editor 不能签发 admin Key，普通 Key 可以', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bApp = await appAs(b.cookie, 'b-agent')
    const admin = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${bApp}/keys`,
      jsonRequest(
        'POST',
        { name: 'k', scopes: { ...FULL_SCOPES, admin: true } },
        { cookie: b.cookie },
      ),
    )
    expect(admin.status).toBe(403)
    expect((await keyAs(b.cookie, bApp)).status).toBe(201)
  })

  it('共享节点与私人节点不能占同一个 URI', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    expect((await create(key, { uri: 'home://wifi', content: '共享', layer: 'base' })).status).toBe(
      201,
    )
    expect(
      (await create(key, { uri: 'home://wifi', content: '私人', layer: 'private' })).status,
    ).toBe(409)
    expect(
      (await create(key, { uri: 'prefs://user', content: '私人', layer: 'owner' })).status,
    ).toBe(201)
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bKey = (
      (await (await keyAs(b.cookie, await appAs(b.cookie, 'b-agent'))).json()) as CreatedKey
    ).key
    expect(
      (await create(bKey, { uri: 'prefs://user', content: '共享', layer: 'base' })).status,
    ).toBe(409)
  })

  it('并发创建同一个 URI：一个成功，其余 409 而不是 500', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => create(key, { uri: 'home://ip', content: `${i}` })),
    )
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409])
  })

  it('请求嵌入期间记忆改成了 secret，旧内容的向量不会写回', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const res = await create(key, { uri: 'home://router', content: '管理密码 hunter2' })
    const id = ((await res.json()) as { id: string }).id
    const inner = fakeEmbedder()
    const racing = {
      model: inner.model,
      async embed(texts: string[]) {
        // 模拟嵌入请求还没返回时，另一个请求把记忆改成了 secret
        await app.request(
          '/v1/memories',
          jsonRequest('PATCH', { uri: 'home://router', sensitivity: 'secret' }, bearer(key)),
        )
        return inner.embed(texts)
      },
    }
    await embedMemory(database.db, racing, ws.spaceId, id)
    const rows = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memoryEmbeddings),
    )
    expect(rows).toHaveLength(0)
  })
  const children = async (key: string, of: string) =>
    (await (
      await app.request(`/v1/memories/children?of=${encodeURIComponent(of)}`, {
        headers: bearer(key),
      })
    ).json()) as MemoryChildren

  it('父节点不存在时也能创建，并通过虚拟节点浏览到', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    expect((await create(key, { uri: 'projects://kioku/notes', content: 'x' })).status).toBe(201)
    const root = await children(key, 'projects')
    expect(root.children).toMatchObject([{ uri: 'projects://kioku', exists: false, childCount: 1 }])
    const level = await children(key, 'projects://kioku')
    expect(level.parent).toBeNull()
    expect(level.children).toMatchObject([{ uri: 'projects://kioku/notes', exists: true }])
  })

  it('读不到的记忆不出现，也不会产生虚拟节点', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bKey = (
      (await (await keyAs(b.cookie, await appAs(b.cookie, 'b-agent'))).json()) as CreatedKey
    ).key
    await create(bKey, { uri: 'home://lab/secret-project', content: 'B 的私事', layer: 'private' })
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    expect((await children(key, 'home')).children).toEqual([])
    expect((await children(key, 'home://lab')).children).toEqual([])
    expect((await children(bKey, 'home')).children).toMatchObject([
      { uri: 'home://lab', exists: false },
    ])
  })

  it('删除或移走父节点后，子节点仍然可以浏览到', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    await create(key, { uri: 'core://agent', content: 'x', layer: 'base' })
    await create(key, { uri: 'core://agent/codex', content: 'x', layer: 'base' })
    const del = await app.request('/v1/memories?uri=core%3A%2F%2Fagent', {
      method: 'DELETE',
      headers: bearer(key),
    })
    expect(del.status).toBe(204)
    expect((await children(key, 'core')).children).toMatchObject([
      { uri: 'core://agent', exists: false },
    ])
    expect((await children(key, 'core://agent')).children).toMatchObject([
      { uri: 'core://agent/codex' },
    ])
  })

  it('空间 owner 能看到成员应用的 Key 列表（用于吊销）', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bApp = await appAs(b.cookie, 'b-agent')
    await keyAs(b.cookie, bApp)
    const list = await app.request(`/v1/spaces/${ws.spaceId}/apps/${bApp}/keys`, {
      headers: { cookie: ws.cookie },
    })
    expect(list.status).toBe(200)
    expect(JSON.stringify(await list.json())).not.toContain('kioku_')
  })
  it('editor 不能签发 secret 级 Key', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bApp = await appAs(b.cookie, 'b-agent')
    const res = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${bApp}/keys`,
      jsonRequest(
        'POST',
        { name: 'k', scopes: { ...FULL_SCOPES, maxSensitivity: 'secret' } },
        { cookie: b.cookie },
      ),
    )
    expect(res.status).toBe(403)
  })

  it('空间 owner 可以把成员的应用转给自己，之后能签发 Key', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bApp = await appAs(b.cookie, 'b-agent')
    const patch = (body: Record<string, unknown>, cookie: string) =>
      app.request(`/v1/spaces/${ws.spaceId}/apps/${bApp}`, jsonRequest('PATCH', body, { cookie }))
    expect((await patch({ ownerAccountId: ws.accountId }, b.cookie)).status).toBe(403)
    expect(
      (await patch({ ownerAccountId: '00000000-0000-4000-8000-000000000000' }, ws.cookie)).status,
    ).toBe(400)
    expect((await patch({ ownerAccountId: ws.accountId }, ws.cookie)).status).toBe(200)
    expect((await keyAs(ws.cookie, bApp)).status).toBe(201)
  })

  it('浏览结果按层聚合，每一级只出现一次', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    for (const uri of ['kb://a', 'kb://a/x', 'kb://a/y', 'kb://a/y/z', 'kb://b/q']) {
      await create(key, { uri, content: uri, layer: 'base' })
    }
    const root = await children(key, 'kb')
    expect(root.children.map((c) => [c.uri, c.exists, c.childCount])).toEqual([
      ['kb://a', true, 2],
      ['kb://b', false, 1],
    ])
  })
})
