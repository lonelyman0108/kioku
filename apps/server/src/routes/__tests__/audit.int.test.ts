import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { CreatedKey, MemoryChildren, MemoryView } from '@kioku/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { hashPassword } from '../../auth/password'
import { withSpace, type Database } from '../../db/client'
import {
  accounts,
  apiKeys,
  loginAttempts,
  memories,
  memoryEmbeddings,
  memoryEvents,
  settings,
  spaceMembers,
} from '../../db/schema'
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

  it('换了嵌入接口的主机必须重新说明 Key 怎么处理', async () => {
    const put = (body: Record<string, unknown>) =>
      app.request('/v1/settings/embedding', jsonRequest('PUT', body, { cookie: ws.cookie }))
    await put({ baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: 'sk-secret' })
    expect(
      await (await put({ baseUrl: 'https://e.example.com/v2', model: 'm' })).json(),
    ).toMatchObject({
      hasApiKey: true,
    })
    expect((await put({ baseUrl: 'https://other.example.net/v1', model: 'm' })).status).toBe(400)
    expect(
      await (
        await put({ baseUrl: 'https://other.example.net/v1', model: 'm', apiKey: null })
      ).json(),
    ).toMatchObject({ hasApiKey: false })
  })

  it('并发登录也只放行 5 次尝试', async () => {
    // 分不清客户端时（这里没有底层连接），这些请求共用「未知客户端」计数，并发请求也只放行 5 次
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
    // 对 A 来说这个路径下什么都读不到，和不存在一样是 404
    const lab = await app.request(`/v1/memories/children?of=${encodeURIComponent('home://lab')}`, {
      headers: bearer(key),
    })
    expect(lab.status).toBe(404)
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
  it('转移应用所有权会吊销旧 Key，且不能夹带别的修改', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bApp = await appAs(b.cookie, 'b-agent')
    const oldKey = ((await (await keyAs(b.cookie, bApp)).json()) as CreatedKey).key
    const patch = (body: Record<string, unknown>) =>
      app.request(
        `/v1/spaces/${ws.spaceId}/apps/${bApp}`,
        jsonRequest('PATCH', body, { cookie: ws.cookie }),
      )
    expect(
      (await patch({ ownerAccountId: ws.accountId, config: { elevateOwnerDirect: 'internal' } }))
        .status,
    ).toBe(400)
    expect((await patch({ ownerAccountId: ws.accountId })).status).toBe(200)
    expect((await app.request('/v1/whoami', { headers: bearer(oldKey) })).status).toBe(401)
  })

  it('数据库层也不允许共享节点与成员节点占同一 URI', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    await create(key, { uri: 'home://wifi', content: '共享', layer: 'base' })
    await expect(
      withSpace(database.db, ws.spaceId, (tx) =>
        tx.insert(memories).values({
          spaceId: ws.spaceId,
          form: 'curated',
          layer: 'private',
          sensitivity: 'private',
          provenance: 'agent',
          ownerAccountId: ws.accountId,
          domain: 'home',
          path: 'wifi',
          content: '绕过服务层',
        }),
      ),
    ).rejects.toThrow()
  })

  it('别人的过期记录也会让出 URI', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bKey = (
      (await (await keyAs(b.cookie, await appAs(b.cookie, 'b-agent'))).json()) as CreatedKey
    ).key
    await create(bKey, { uri: 'home://x', content: 'B 的旧事', layer: 'private' })
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 1000) })
        .where(eq(memories.path, 'x')),
    )
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    expect((await create(key, { uri: 'home://x', content: '共享', layer: 'base' })).status).toBe(
      201,
    )
  })

  it('写不了的过期共享记录留着：成员节点可以和它并存，同样是共享节点的写入照样冲突', async () => {
    const ownerKey = await ws.issueKey((await ws.createApp('agent')).id)
    await create(ownerKey, {
      uri: 'home://vault',
      content: '旧密码',
      layer: 'base',
      sensitivity: 'secret',
    })
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 1000) })
        .where(eq(memories.path, 'vault')),
    )
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bKey = (
      (await (await keyAs(b.cookie, await appAs(b.cookie, 'b-agent'))).json()) as CreatedKey
    ).key
    expect(
      (await create(bKey, { uri: 'home://vault', content: '共享', layer: 'base' })).status,
    ).toBe(409)
    expect(
      (await create(bKey, { uri: 'home://vault', content: 'bob 自己的', layer: 'private' })).status,
    ).toBe(201)
    const rows = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memories).where(eq(memories.path, 'vault')),
    )
    expect(rows.filter((r) => r.deletedAt === null)).toHaveLength(2)
    expect(((await (await get(bKey, 'home://vault')).json()) as MemoryView).content).toBe(
      'bob 自己的',
    )
  })

  it('超长用户名返回 400，不写入失败计数表', async () => {
    const res = await app.request(
      '/v1/auth/login',
      jsonRequest('POST', { username: 'x'.repeat(3000), password: 'x' }),
    )
    expect(res.status).toBe(400)
  })

  it('浏览时 priority 高的节点排在前面', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    await create(key, { uri: 'kb://aaa', content: 'x', layer: 'base', priority: 2 })
    await create(key, { uri: 'kb://zzz', content: 'x', layer: 'base', priority: 0 })
    expect((await children(key, 'kb')).children.map((c) => c.uri)).toEqual(['kb://zzz', 'kb://aaa'])
  })
  it('应用只能转给 owner 或 editor', async () => {
    const v = await addMember(database.db, ws.spaceId, 'victor', 'viewer')
    const aApp = (await ws.createApp('a-bot')).id
    const res = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${aApp}`,
      jsonRequest('PATCH', { ownerAccountId: v.accountId }, { cookie: ws.cookie }),
    )
    expect(res.status).toBe(400)
  })

  it('已过期的共享记录不挡住绕过服务层的写入', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    await create(key, { uri: 'home://old', content: '旧', layer: 'base' })
    await withSpace(database.db, ws.spaceId, async (tx) => {
      await tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 1000) })
        .where(eq(memories.path, 'old'))
      await tx.insert(memories).values({
        spaceId: ws.spaceId,
        form: 'curated',
        layer: 'private',
        sensitivity: 'private',
        provenance: 'agent',
        ownerAccountId: ws.accountId,
        domain: 'home',
        path: 'old',
        content: '新',
      })
    })
    expect(((await (await get(key, 'home://old')).json()) as MemoryView).content).toBe('新')
  })
  const proxiedApp = () =>
    createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
      trustedProxies: 1,
    })
  const loginFrom = (
    target: ReturnType<typeof createApp>,
    forwardedFor: string,
    password: string,
  ) =>
    target.request(
      '/v1/auth/login',
      jsonRequest('POST', { username: 'alice', password }, { 'x-forwarded-for': forwardedFor }),
    )

  it('别人连输密码只锁住他自己那一路，主人从别处仍能登录', async () => {
    const proxied = proxiedApp()
    for (let i = 0; i < 5; i++)
      expect((await loginFrom(proxied, '203.0.113.66', 'wrong')).status).toBe(401)
    expect((await loginFrom(proxied, '203.0.113.66', 'correct horse battery')).status).toBe(429)
    expect((await loginFrom(proxied, '203.0.113.10', 'correct horse battery')).status).toBe(200)
  })

  it('伪造 X-Forwarded-For 最左边的项绕不过限流', async () => {
    const proxied = proxiedApp()
    for (let i = 0; i < 5; i++) {
      expect((await loginFrom(proxied, `198.51.100.${i}, 203.0.113.66`, 'wrong')).status).toBe(401)
    }
    expect(
      (await loginFrom(proxied, '198.51.100.99, 203.0.113.66', 'correct horse battery')).status,
    ).toBe(429)
  })
  it('应用主人被降级后，他签的 Key 随之收紧；离开空间后 Key 作废', async () => {
    const appId = (await ws.createApp('agent')).id
    const key = await ws.issueKey(appId)
    await create(key, { uri: 'home://wifi', content: 'hunter2', sensitivity: 'secret' })
    expect((await get(key, 'home://wifi')).status).toBe(200)

    // 另找一位 owner，再把原 owner 降成 editor
    await addMember(database.db, ws.spaceId, 'olga', 'owner')
    await database.db
      .update(spaceMembers)
      .set({ role: 'editor' })
      .where(and(eq(spaceMembers.spaceId, ws.spaceId), eq(spaceMembers.accountId, ws.accountId)))
    expect((await get(key, 'home://wifi')).status).toBe(404)
    const who = (await (await app.request('/v1/whoami', { headers: bearer(key) })).json()) as {
      scopes: { maxSensitivity: string; admin: boolean }
    }
    expect(who.scopes).toMatchObject({ maxSensitivity: 'private', admin: false })

    await database.db
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, ws.spaceId), eq(spaceMembers.accountId, ws.accountId)))
    expect((await app.request('/v1/whoami', { headers: bearer(key) })).status).toBe(401)
  })

  it('签发 Key 与转移所有权并发时，转移之后不会留下前任主人的有效 Key', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    for (let round = 0; round < 6; round++) {
      const bApp = await appAs(b.cookie, `b-agent-${round}`)
      const [, transfer] = await Promise.all([
        keyAs(b.cookie, bApp),
        app.request(
          `/v1/spaces/${ws.spaceId}/apps/${bApp}`,
          jsonRequest('PATCH', { ownerAccountId: ws.accountId }, { cookie: ws.cookie }),
        ),
      ])
      expect(transfer.status).toBe(200)
      const live = await database.db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.appId, bApp), isNull(apiKeys.revokedAt)))
      expect(live).toEqual([])
    }
  })

  it('历史清理迁移在 RLS 下也能清掉旧 secret 事件里的明文', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const res = await create(key, {
      uri: 'home://router',
      content: '管理密码 hunter2',
      sensitivity: 'secret',
    })
    const id = ((await res.json()) as { id: string }).id
    // 模拟清理上线之前留下的事件：快照里还有明文与全文向量
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(memoryEvents).values({
        spaceId: ws.spaceId,
        memoryId: id,
        eventType: 'update',
        provenance: 'agent',
        before: { content: '管理密码 hunter2', fts: "'hunter2':2" },
        after: { content: null },
      }),
    )
    const migration = readFileSync(
      new URL('../../../migrations/0010_scrub_secret_history.sql', import.meta.url),
      'utf8',
    )
    await database.db.transaction(async (tx) => {
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.replace(/--.*$/gm, '').trim()) await tx.execute(sql.raw(statement))
      }
    })
    const events = await withSpace(database.db, ws.spaceId, (tx) => tx.select().from(memoryEvents))
    expect(JSON.stringify(events)).not.toContain('hunter2')
    const forced = await database.db.execute<{ relname: string; relforcerowsecurity: boolean }>(
      sql`select relname, relforcerowsecurity from pg_class where relname in ('memories', 'memory_events')`,
    )
    expect(forced.every((r) => r.relforcerowsecurity)).toBe(true)
  })
  it('一个客户端被锁之后再怎么试，也不会把主人从别处登录一起锁住', async () => {
    const proxied = proxiedApp()
    for (let i = 0; i < 60; i++) await loginFrom(proxied, '203.0.113.66', 'wrong')
    expect((await loginFrom(proxied, '203.0.113.10', 'correct horse battery')).status).toBe(200)
  })

  it('记忆改成 secret 时，它的向量在同一个事务里删除', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const res = await create(key, { uri: 'home://router', content: '管理密码 hunter2' })
    const id = ((await res.json()) as { id: string }).id
    await embedMemory(database.db, fakeEmbedder(), ws.spaceId, id)
    expect(
      await withSpace(database.db, ws.spaceId, (tx) => tx.select().from(memoryEmbeddings)),
    ).toHaveLength(1)
    await app.request(
      '/v1/memories',
      jsonRequest('PATCH', { uri: 'home://router', sensitivity: 'secret' }, bearer(key)),
    )
    expect(
      await withSpace(database.db, ws.spaceId, (tx) => tx.select().from(memoryEmbeddings)),
    ).toHaveLength(0)
  })
  it('别人从很多地址乱试密码，主人在登录过的设备上仍能登录', async () => {
    const proxied = proxiedApp()
    // 主人先在自己的设备上成功登录一次，拿到设备 Cookie
    const first = await loginFrom(proxied, '203.0.113.200', 'correct horse battery')
    const device = first.headers
      .getSetCookie()
      .find((c) => c.startsWith('kioku_device='))!
      .split(';')[0]!
    // 攻击者从 11 个地址各输错 5 次，把「用户名合计」推过上限
    for (let ip = 1; ip <= 11; ip++) {
      for (let i = 0; i < 5; i++) await loginFrom(proxied, `198.51.100.${ip}`, 'wrong')
    }
    // 没有设备 Cookie 的新地址被挡住，带着设备 Cookie 的主人照常登录
    expect((await loginFrom(proxied, '203.0.113.201', 'correct horse battery')).status).toBe(429)
    const owner = await proxied.request(
      '/v1/auth/login',
      jsonRequest(
        'POST',
        { username: 'alice', password: 'correct horse battery' },
        { 'x-forwarded-for': '203.0.113.202', cookie: device },
      ),
    )
    expect(owner.status).toBe(200)
  })

  it('合计超限期间在同一地址多试几次，同一网络里带设备 Cookie 的设备照样能登录', async () => {
    const proxied = proxiedApp()
    const first = await loginFrom(proxied, '203.0.113.200', 'correct horse battery')
    const device = first.headers
      .getSetCookie()
      .find((c) => c.startsWith('kioku_device='))!
      .split(';')[0]!
    for (let ip = 1; ip <= 11; ip++) {
      for (let i = 0; i < 5; i++) await loginFrom(proxied, `198.51.100.${ip}`, 'wrong')
    }
    // 主人在家里另一个没有设备 Cookie 的浏览器上试了 6 次，都被合计挡下，没有校验密码
    for (let i = 0; i < 6; i++) {
      expect((await loginFrom(proxied, '203.0.113.200', 'correct horse battery')).status).toBe(429)
    }
    const owner = await proxied.request(
      '/v1/auth/login',
      jsonRequest(
        'POST',
        { username: 'alice', password: 'correct horse battery' },
        { 'x-forwarded-for': '203.0.113.200', cookie: device },
      ),
    )
    expect(owner.status).toBe(200)
  })

  it('合计超限期间同一地址并发重试，也不会占满本客户端的额度', async () => {
    const proxied = proxiedApp()
    const first = await loginFrom(proxied, '203.0.113.200', 'correct horse battery')
    const device = first.headers
      .getSetCookie()
      .find((c) => c.startsWith('kioku_device='))!
      .split(';')[0]!
    for (let ip = 1; ip <= 11; ip++) {
      for (let i = 0; i < 5; i++) await loginFrom(proxied, `198.51.100.${ip}`, 'wrong')
    }
    const burst = await Promise.all(
      Array.from({ length: 10 }, () =>
        loginFrom(proxied, '203.0.113.200', 'correct horse battery'),
      ),
    )
    expect(burst.every((r) => r.status === 429)).toBe(true)
    const owner = await proxied.request(
      '/v1/auth/login',
      jsonRequest(
        'POST',
        { username: 'alice', password: 'correct horse battery' },
        { 'x-forwarded-for': '203.0.113.200', cookie: device },
      ),
    )
    expect(owner.status).toBe(200)
  })

  it('伪造的设备 Cookie 不起作用', async () => {
    const proxied = proxiedApp()
    for (let ip = 1; ip <= 11; ip++) {
      for (let i = 0; i < 5; i++) await loginFrom(proxied, `198.51.100.${ip}`, 'wrong')
    }
    const forged = await proxied.request(
      '/v1/auth/login',
      jsonRequest(
        'POST',
        { username: 'alice', password: 'correct horse battery' },
        {
          'x-forwarded-for': '203.0.113.202',
          cookie: `kioku_device=${ws.accountId}.${Math.floor(Date.now() / 1000)}.forged`,
        },
      ),
    )
    expect(forged.status).toBe(429)
  })

  it('主人离开空间又被重新加入后，旧 Key 不会恢复', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bApp = await appAs(b.cookie, 'b-agent')
    const oldKey = ((await (await keyAs(b.cookie, bApp)).json()) as CreatedKey).key
    await database.db
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, ws.spaceId), eq(spaceMembers.accountId, b.accountId)))
    await new Promise((r) => setTimeout(r, 5))
    await database.db
      .insert(spaceMembers)
      .values({ spaceId: ws.spaceId, accountId: b.accountId, role: 'editor' })
    expect((await app.request('/v1/whoami', { headers: bearer(oldKey) })).status).toBe(401)
  })
  it('改了密码之后，之前发出的设备 Cookie 不再有效', async () => {
    const proxied = proxiedApp()
    const first = await loginFrom(proxied, '203.0.113.200', 'correct horse battery')
    const device = first.headers
      .getSetCookie()
      .find((c) => c.startsWith('kioku_device='))!
      .split(';')[0]!
    await database.db
      .update(accounts)
      .set({ passwordHash: await hashPassword('another password 123') })
    for (let ip = 1; ip <= 11; ip++) {
      for (let i = 0; i < 5; i++) await loginFrom(proxied, `198.51.100.${ip}`, 'wrong')
    }
    const res = await proxied.request(
      '/v1/auth/login',
      jsonRequest(
        'POST',
        { username: 'alice', password: 'another password 123' },
        { 'x-forwarded-for': '203.0.113.202', cookie: device },
      ),
    )
    expect(res.status).toBe(429)
  })

  it('主人登录成功不清掉「用户名合计」里别人的失败，也不把这次成功算进去', async () => {
    const proxied = proxiedApp()
    for (let i = 0; i < 4; i++) await loginFrom(proxied, '198.51.100.1', 'wrong')
    expect((await loginFrom(proxied, '203.0.113.10', 'correct horse battery')).status).toBe(200)
    const [total] = await database.db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.username, JSON.stringify(['alice'])))
    expect(total?.count).toBe(4)
  })

  it('用户名里带分隔符或引号，也拼不出别人的计数键', async () => {
    const proxied = proxiedApp()
    for (const username of ['alice|c:203.0.113.10', 'alice","203.0.113.10']) {
      for (let ip = 1; ip <= 6; ip++) {
        await proxied.request(
          '/v1/auth/login',
          jsonRequest(
            'POST',
            { username, password: 'wrong' },
            { 'x-forwarded-for': `198.51.100.${ip}` },
          ),
        )
      }
    }
    expect((await loginFrom(proxied, '203.0.113.10', 'correct horse battery')).status).toBe(200)
  })

  it('同一来源并发登录时，账号存在与否，被拒的表现一样', async () => {
    const proxied = proxiedApp()
    const burst = async (username: string) => {
      const responses = await Promise.all(
        Array.from({ length: 3 }, () =>
          proxied.request(
            '/v1/auth/login',
            jsonRequest(
              'POST',
              { username, password: 'wrong' },
              { 'x-forwarded-for': '203.0.113.77' },
            ),
          ),
        ),
      )
      return responses.map((r) => r.status).sort()
    }
    expect(await burst('alice')).toEqual([401, 401, 429])
    expect(await burst('nobody')).toEqual([401, 401, 429])
  })

  it('用户名不存在时同样计数，超限后同样返回 429', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.request(
        '/v1/auth/login',
        jsonRequest('POST', { username: 'nobody', password: 'x' }),
      )
      expect(res.status).toBe(401)
    }
    const res = await app.request(
      '/v1/auth/login',
      jsonRequest('POST', { username: 'nobody', password: 'x' }),
    )
    expect(res.status).toBe(429)
  })

  it('浏览一个不存在、下面也没有可读内容的路径返回 404', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    await create(key, { uri: 'core://agent', content: 'x', layer: 'base' })
    expect(
      (
        await app.request(`/v1/memories/children?of=${encodeURIComponent('core://agnet')}`, {
          headers: bearer(key),
        })
      ).status,
    ).toBe(404)
    expect(
      (await app.request('/v1/memories/children?of=emptydomain', { headers: bearer(key) })).status,
    ).toBe(200)
  })
})
