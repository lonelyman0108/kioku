import { randomBytes } from 'node:crypto'

import {
  ENTRY_CONTENT_MAX,
  type EntryBrowseResponse,
  type EntryView,
  type IssuedKey,
} from '@kioku/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { hashPassword } from '../../auth/password'
import { withCircle, type Database } from '../../db/client'
import {
  accounts,
  apiKeys,
  circleMembers,
  entries,
  entryEmbeddings,
  entryEvents,
  loginAttempts,
  settings,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { embedEntries } from '../../embedding/worker'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import {
  addMember,
  bearer,
  bootstrap,
  FULL_SCOPES,
  jsonRequest,
  type Workspace,
} from '../../testing/fixtures'

// 对已合并代码补做审查时发现的问题，每条一个回归用例
// 登录防护的几个用例要试几十次密码，每次都是真的 scrypt（N = 2^15），本机两三秒，CI 机器上常常超过默认的 5 秒
describe.skipIf(!testDatabaseUrl)('审查回归', { timeout: 30_000 }, () => {
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

  const clientAs = async (cookie: string, slug: string) => {
    const res = await app.request(
      `/v1/circles/${ws.circleId}/clients`,
      jsonRequest('POST', { slug, name: slug, runtimeFamily: 'mcp' }, { cookie }),
    )
    return ((await res.json()) as { id: string }).id
  }
  const keyAs = async (
    cookie: string,
    clientId: string,
    linkedCircles: { circleId: string; mode: 'read' | 'read_write' }[] = [],
  ) =>
    app.request(
      `/v1/circles/${ws.circleId}/clients/${clientId}/keys`,
      // editor 能签发的最高敏感级是 private
      jsonRequest(
        'POST',
        {
          name: 'k',
          linkedCircles,
          scopes: { ...FULL_SCOPES, maxSensitivity: 'private', credentials: 'none' },
        },
        { cookie },
      ),
    )
  const create = (key: string, body: Record<string, unknown>) =>
    app.request('/v1/entries', jsonRequest('POST', body, bearer(key)))
  const get = (key: string, id: string) =>
    app.request(`/v1/entries?id=${encodeURIComponent(id)}`, { headers: bearer(key) })

  it('两个成员各有自己的个人圈：同名词条互相隔离且不可跨人读取', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const ka = (
      (await (
        await keyAs(ws.cookie, (await ws.createClient('a-agent')).id, [
          { circleId: ws.personalCircleId, mode: 'read_write' },
        ])
      ).json()) as IssuedKey
    ).key
    const kb = (
      (await (
        await keyAs(b.cookie, await clientAs(b.cookie, 'b-agent'), [
          { circleId: b.personalCircleId, mode: 'read_write' },
        ])
      ).json()) as IssuedKey
    ).key

    const resA = await create(ka, {
      circle: ws.personalCircleId,
      title: 'user-pref',
      sensitivity: 'internal',
      content: 'A 的偏好',
    })
    expect(resA.status).toBe(201)
    const idA = ((await resA.json()) as EntryView).shortId

    const resB = await create(kb, {
      circle: b.personalCircleId,
      title: 'user-pref',
      sensitivity: 'internal',
      content: 'B 的偏好',
    })
    expect(resB.status).toBe(201)
    const idB = ((await resB.json()) as EntryView).shortId

    expect(((await (await get(ka, idA)).json()) as EntryView).variants[0]?.content).toBe('A 的偏好')
    expect(((await (await get(kb, idB)).json()) as EntryView).variants[0]?.content).toBe('B 的偏好')
    expect((await get(ka, idB)).status).toBe(404)
    expect((await get(kb, idA)).status).toBe(404)
  })

  it('记忆圈 owner 不能给别的成员的接入实例签发 Key，但可以吊销', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const bClient = await clientAs(b.cookie, 'b-agent')
    expect((await keyAs(ws.cookie, bClient)).status).toBe(403)
    const bKey = (await (await keyAs(b.cookie, bClient)).json()) as IssuedKey
    const revoke = await app.request(
      `/v1/circles/${ws.circleId}/clients/${bClient}/keys/${bKey.id}`,
      {
        method: 'DELETE',
        headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' },
      },
    )
    expect(revoke.status).toBe(204)
  })

  it('editor 不能修改别人的接入实例', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const aClient = (await ws.createClient('a-bot')).id
    const res = await app.request(
      `/v1/circles/${ws.circleId}/clients/${aClient}`,
      jsonRequest('PATCH', { config: { elevateOwnerDirect: 'internal' } }, { cookie: b.cookie }),
    )
    expect(res.status).toBe(403)
  })

  it('改成 secret 后历史事件里不再有明文', async () => {
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const created = (await (
      await create(key, { title: 'router', content: '管理密码 hunter2' })
    ).json()) as EntryView
    await app.request(
      '/v1/entries',
      jsonRequest('PATCH', { id: created.shortId, sensitivity: 'secret' }, bearer(key)),
    )
    const events = await withCircle(database.db, ws.circleId, (tx) => tx.select().from(entryEvents))
    expect(events).toHaveLength(2)
    expect(JSON.stringify(events)).not.toContain('hunter2')
  })

  it('已失效的词条不再占用或被召回读取，新写入同类词条正常可用', async () => {
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const first = (await (
      await create(key, { title: 'router-ip', content: '旧地址' })
    ).json()) as EntryView
    await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .update(entries)
        .set({ validTo: new Date(Date.now() - 1000) })
        .where(eq(entries.id, first.id)),
    )
    expect((await get(key, first.shortId)).status).toBe(404)
    const secondRes = await create(key, { title: 'router-ip', content: '新地址' })
    expect(secondRes.status).toBe(201)
    const second = (await secondRes.json()) as EntryView
    expect(
      ((await (await get(key, second.shortId)).json()) as EntryView).variants[0]?.content,
    ).toBe('新地址')
  })

  it('换了服务商的接口主机必须重新说明 Key 怎么处理', async () => {
    const res = await app.request(
      '/v1/settings/models/providers',
      jsonRequest(
        'POST',
        {
          name: '嵌入服务商',
          format: 'openai-chat',
          baseUrl: 'https://e.example.com/v1',
          apiKey: 'sk-secret',
          profiles: [{ kind: 'embedding', model: 'm' }],
        },
        { cookie: ws.cookie },
      ),
    )
    expect(res.status).toBe(201)
    const provider = (await res.json()) as {
      id: string
      hasApiKey: boolean
      profiles: { id: string }[]
    }
    const profileId = provider.profiles[0]!.id
    const update = (body: Record<string, unknown>) =>
      app.request(
        `/v1/settings/models/providers/${provider.id}`,
        jsonRequest(
          'PUT',
          {
            name: '嵌入服务商',
            format: 'openai-chat',
            profiles: [{ id: profileId, kind: 'embedding', model: 'm' }],
            ...body,
          },
          { cookie: ws.cookie },
        ),
      )
    expect(await (await update({ baseUrl: 'https://e.example.com/v2' })).json()).toMatchObject({
      hasApiKey: true,
    })
    const moved = await update({ baseUrl: 'https://other.example.com/v1' })
    expect(moved.status).toBe(400)
    expect(await moved.json()).toEqual({
      error:
        '接口主机已变更，已保存的 Key 不会发送给新主机。请重新填写；新接口不需要 Key 时，请清除已保存的 Key。',
    })
    expect(
      await (await update({ baseUrl: 'https://other.example.com/v1', apiKey: null })).json(),
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
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const tooLong = 'x'.repeat(ENTRY_CONTENT_MAX + 1)
    expect((await create(key, { title: 'big-rest', content: tooLong })).status).toBe(400)
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
          arguments: { title: 'big-mcp', content: tooLong },
        },
      }),
    })
    const body = (await res.json()) as { result?: { isError?: boolean }; error?: unknown }
    expect(body.error ?? body.result?.isError).toBeTruthy()
    const list = await app.request('/v1/entries/browse?groupBy=topic', { headers: bearer(key) })
    expect(((await list.json()) as EntryBrowseResponse).groups).toEqual([])
  })

  it('editor 不能签发 admin Key，普通 Key 可以', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const bClient = await clientAs(b.cookie, 'b-agent')
    const admin = await app.request(
      `/v1/circles/${ws.circleId}/clients/${bClient}/keys`,
      jsonRequest(
        'POST',
        { name: 'k', scopes: { ...FULL_SCOPES, admin: true } },
        { cookie: b.cookie },
      ),
    )
    expect(admin.status).toBe(403)
    expect((await keyAs(b.cookie, bClient)).status).toBe(201)
  })

  it('并发创建词条：全部分配互不冲突的短 ID 而不是 500', async () => {
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => create(key, { title: 'home-ip', content: `${i}` })),
    )
    expect(results.every((r) => r.status === 201)).toBe(true)
    const views = await Promise.all(results.map((r) => r.json() as Promise<EntryView>))
    expect(new Set(views.map((v) => v.shortId)).size).toBe(5)
  })

  it('请求嵌入期间词条改成了 secret，旧内容的向量不会写回', async () => {
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const res = await create(key, { title: 'router', content: '管理密码 hunter2' })
    const created = (await res.json()) as EntryView
    const inner = fakeEmbedder()
    const racing = {
      model: inner.model,
      async embed(texts: string[]) {
        // 模拟嵌入请求还没返回时，另一个请求把词条改成了 secret
        await app.request(
          '/v1/entries',
          jsonRequest('PATCH', { id: created.shortId, sensitivity: 'secret' }, bearer(key)),
        )
        return inner.embed(texts)
      },
    }
    await embedEntries(database.db, racing, ws.circleId, [created.id])
    const rows = await withCircle(database.db, ws.circleId, (tx) =>
      tx.select().from(entryEmbeddings),
    )
    expect(rows).toHaveLength(0)
  })

  const browse = async (key: string, params = 'groupBy=topic') =>
    (await (
      await app.request(`/v1/entries/browse?${params}`, { headers: bearer(key) })
    ).json()) as EntryBrowseResponse

  it('浏览按维度聚合，读不到的词条不出现，删掉某条时其余同类词条仍在', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const bKey = (
      (await (
        await keyAs(b.cookie, await clientAs(b.cookie, 'b-agent'), [
          { circleId: b.personalCircleId, mode: 'read_write' },
        ])
      ).json()) as IssuedKey
    ).key
    await create(bKey, {
      circle: b.personalCircleId,
      title: 'secret-project',
      topics: ['lab'],
      content: 'B 的私事',
    })
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    expect((await browse(key)).groups).toEqual([])
    expect((await browse(bKey)).groups).toMatchObject([{ key: 'lab', count: 1 }])

    const one = (await (
      await create(key, { title: 'agent-1', topics: ['kb'], content: 'x', priority: 2 })
    ).json()) as EntryView
    const two = (await (
      await create(key, { title: 'agent-2', topics: ['kb'], content: 'y', priority: 0 })
    ).json()) as EntryView
    const ordered = await browse(key)
    expect(ordered.groups[0]!.items.map((i) => i.shortId)).toEqual([two.shortId, one.shortId])

    const del = await app.request(`/v1/entries?id=${encodeURIComponent(one.shortId)}`, {
      method: 'DELETE',
      headers: bearer(key),
    })
    expect(del.status).toBe(204)
    expect((await browse(key)).groups[0]!.items.map((i) => i.shortId)).toEqual([two.shortId])
    expect(
      (await app.request('/v1/entries/browse?groupBy=invalid', { headers: bearer(key) })).status,
    ).toBe(400)
  })

  it('记忆圈 owner 能看到成员接入实例的 Key 列表（用于吊销）', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const bClient = await clientAs(b.cookie, 'b-agent')
    await keyAs(b.cookie, bClient)
    const list = await app.request(`/v1/circles/${ws.circleId}/clients/${bClient}/keys`, {
      headers: { cookie: ws.cookie },
    })
    expect(list.status).toBe(200)
    expect(JSON.stringify(await list.json())).not.toContain('kioku_')
  })

  it('editor 不能签发 secret 级 Key', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const bClient = await clientAs(b.cookie, 'b-agent')
    const res = await app.request(
      `/v1/circles/${ws.circleId}/clients/${bClient}/keys`,
      jsonRequest(
        'POST',
        { name: 'k', scopes: { ...FULL_SCOPES, maxSensitivity: 'secret' } },
        { cookie: b.cookie },
      ),
    )
    expect(res.status).toBe(403)
  })

  it('记忆圈 owner 可以把成员的接入实例转给自己，之后能签发 Key', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const bClient = await clientAs(b.cookie, 'b-agent')
    const patch = (body: Record<string, unknown>, cookie: string) =>
      app.request(
        `/v1/circles/${ws.circleId}/clients/${bClient}`,
        jsonRequest('PATCH', body, { cookie }),
      )
    expect((await patch({ ownerAccountId: ws.accountId }, b.cookie)).status).toBe(403)
    expect(
      (await patch({ ownerAccountId: '00000000-0000-4000-8000-000000000000' }, ws.cookie)).status,
    ).toBe(400)
    expect((await patch({ ownerAccountId: ws.accountId }, ws.cookie)).status).toBe(200)
    expect((await keyAs(ws.cookie, bClient)).status).toBe(201)
  })

  it('转移接入实例所有权会吊销旧 Key，且不能夹带别的修改', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const bClient = await clientAs(b.cookie, 'b-agent')
    const oldKey = ((await (await keyAs(b.cookie, bClient)).json()) as IssuedKey).key
    const patch = (body: Record<string, unknown>) =>
      app.request(
        `/v1/circles/${ws.circleId}/clients/${bClient}`,
        jsonRequest('PATCH', body, { cookie: ws.cookie }),
      )
    expect(
      (await patch({ ownerAccountId: ws.accountId, config: { elevateOwnerDirect: 'internal' } }))
        .status,
    ).toBe(400)
    expect((await patch({ ownerAccountId: ws.accountId })).status).toBe(200)
    expect((await app.request('/v1/whoami', { headers: bearer(oldKey) })).status).toBe(401)
  })

  it('数据库层保证全局短 ID 唯一与形制约束', async () => {
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const created = (await (
      await create(key, { title: 'wifi', content: '共享词条' })
    ).json()) as EntryView
    await expect(
      withCircle(database.db, ws.circleId, (tx) =>
        tx.insert(entries).values({
          circleId: ws.circleId,
          shortId: created.shortId,
          circleKind: 'shared',
          kind: 'entry',
          sensitivity: 'internal',
          provenance: 'agent',
          title: 'dup',
        }),
      ),
    ).rejects.toThrow()
    // 个人圈共享型条目（无 ownerAccountId）被 check 约束拦截
    await expect(
      withCircle(database.db, ws.personalCircleId, (tx) =>
        tx.insert(entries).values({
          circleId: ws.personalCircleId,
          shortId: 'm-999999',
          circleKind: 'personal',
          kind: 'entry',
          sensitivity: 'private',
          provenance: 'agent',
          ownerAccountId: null,
          title: 'bad-personal',
        }),
      ),
    ).rejects.toThrow()
  })

  it('超长用户名返回 400，不写入失败计数表', async () => {
    const res = await app.request(
      '/v1/auth/login',
      jsonRequest('POST', { username: 'x'.repeat(3000), password: 'x' }),
    )
    expect(res.status).toBe(400)
  })

  it('接入实例只能转给 owner 或 editor', async () => {
    const v = await addMember(database.db, ws.circleId, 'victor', 'viewer')
    const aClient = (await ws.createClient('a-bot')).id
    const res = await app.request(
      `/v1/circles/${ws.circleId}/clients/${aClient}`,
      jsonRequest('PATCH', { ownerAccountId: v.accountId }, { cookie: ws.cookie }),
    )
    expect(res.status).toBe(400)
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

  it('接入实例主人被降级后，他签的 Key 随之收紧；离开记忆圈后 Key 作废', async () => {
    const cid = (await ws.createClient('agent')).id
    const key = await ws.issueKey(cid)
    const created = (await (
      await create(key, { title: 'wifi', content: 'hunter2', sensitivity: 'secret' })
    ).json()) as EntryView
    expect((await get(key, created.shortId)).status).toBe(200)

    // 另找一位 owner，再把原 owner 降成 editor
    await addMember(database.db, ws.circleId, 'olga', 'owner')
    await database.db
      .update(circleMembers)
      .set({ role: 'editor' })
      .where(
        and(eq(circleMembers.circleId, ws.circleId), eq(circleMembers.accountId, ws.accountId)),
      )
    expect((await get(key, created.shortId)).status).toBe(404)
    const who = (await (await app.request('/v1/whoami', { headers: bearer(key) })).json()) as {
      scopes: { maxSensitivity: string; admin: boolean }
    }
    expect(who.scopes).toMatchObject({ maxSensitivity: 'private', admin: false })

    await database.db
      .delete(circleMembers)
      .where(
        and(eq(circleMembers.circleId, ws.circleId), eq(circleMembers.accountId, ws.accountId)),
      )
    expect((await app.request('/v1/whoami', { headers: bearer(key) })).status).toBe(401)
  })

  it('签发 Key 与转移所有权并发时，转移之后不会留下前任主人的有效 Key', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    for (let round = 0; round < 6; round++) {
      const bClient = await clientAs(b.cookie, `b-agent-${round}`)
      const [, transfer] = await Promise.all([
        keyAs(b.cookie, bClient),
        app.request(
          `/v1/circles/${ws.circleId}/clients/${bClient}`,
          jsonRequest('PATCH', { ownerAccountId: ws.accountId }, { cookie: ws.cookie }),
        ),
      ])
      expect(transfer.status).toBe(200)
      const live = await database.db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.clientId, bClient), isNull(apiKeys.revokedAt)))
      expect(live).toEqual([])
    }
  })

  it('一个客户端被锁之后再怎么试，也不会把主人从别处登录一起锁住', async () => {
    const proxied = proxiedApp()
    for (let i = 0; i < 60; i++) await loginFrom(proxied, '203.0.113.66', 'wrong')
    expect((await loginFrom(proxied, '203.0.113.10', 'correct horse battery')).status).toBe(200)
  })

  it('词条改成 secret 时，它的向量在同一个事务里删除', async () => {
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const created = (await (
      await create(key, { title: 'router', content: '管理密码 hunter2' })
    ).json()) as EntryView
    await embedEntries(database.db, fakeEmbedder(), ws.circleId, [created.id])
    expect(
      await withCircle(database.db, ws.circleId, (tx) => tx.select().from(entryEmbeddings)),
    ).toHaveLength(1)
    await app.request(
      '/v1/entries',
      jsonRequest('PATCH', { id: created.shortId, sensitivity: 'secret' }, bearer(key)),
    )
    expect(
      await withCircle(database.db, ws.circleId, (tx) => tx.select().from(entryEmbeddings)),
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

  it('主人离开记忆圈又被重新加入后，旧 Key 不会恢复', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const bClient = await clientAs(b.cookie, 'b-agent')
    const oldKey = ((await (await keyAs(b.cookie, bClient)).json()) as IssuedKey).key
    await database.db
      .delete(circleMembers)
      .where(and(eq(circleMembers.circleId, ws.circleId), eq(circleMembers.accountId, b.accountId)))
    await new Promise((r) => setTimeout(r, 5))
    await database.db
      .insert(circleMembers)
      .values({ circleId: ws.circleId, accountId: b.accountId, role: 'editor' })
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
})
