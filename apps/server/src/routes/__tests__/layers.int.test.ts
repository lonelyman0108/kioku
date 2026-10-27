import { randomBytes } from 'node:crypto'

import type { DomainLayers, KeyScopes, MemoryHistory, MemoryView } from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import type { Database } from '../../db/client'
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

describe.skipIf(!testDatabaseUrl)('改层、跨命名空间移动与 domain 默认层', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
  })

  const space = () => `/v1/spaces/${ws.spaceId}`
  const ok = async <T>(res: Response, status = 200) => {
    expect(res.status).toBe(status)
    return (await res.json()) as T
  }
  const create = async (cookie: string, body: Record<string, unknown>) =>
    ok<MemoryView>(
      await app.request(`${space()}/memories`, jsonRequest('POST', body, { cookie })),
      201,
    )
  const patchRes = (cookie: string, body: Record<string, unknown>) =>
    app.request(`${space()}/memories`, jsonRequest('PATCH', body, { cookie }))
  const moveRes = (cookie: string, body: Record<string, unknown>) =>
    app.request(`${space()}/memories/move`, jsonRequest('POST', body, { cookie }))
  const getRes = (cookie: string, uri: string) =>
    app.request(`${space()}/memories?uri=${encodeURIComponent(uri)}`, { headers: { cookie } })

  it('base、owner、private 之间直接改层，共享与按成员互转时归属跟着变', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const m = await create(ws.cookie, { uri: 'notes://plan', content: '主人的计划' })
    expect((await getRes(editor.cookie, 'notes://plan')).status).toBe(404)

    const shared = await ok<MemoryView>(
      await patchRes(ws.cookie, { uri: 'notes://plan', layer: 'base' }),
    )
    expect(shared.layer).toBe('base')
    expect((await getRes(editor.cookie, 'notes://plan')).status).toBe(200)
    // 它在主人私人层期间的版本，editor 在历史里仍然看不到
    const history = await ok<MemoryHistory>(
      await app.request(`${space()}/memories/history?id=${m.id}`, {
        headers: { cookie: editor.cookie },
      }),
    )
    expect(history.events).toEqual([])

    // editor 把它改成自己的私人层：之后只有 editor 看得到
    const mine = await ok<MemoryView>(
      await patchRes(editor.cookie, { uri: 'notes://plan', layer: 'private' }),
    )
    expect(mine.layer).toBe('private')
    expect((await getRes(ws.cookie, 'notes://plan')).status).toBe(404)
    expect(
      (await ok<MemoryView>(await patchRes(editor.cookie, { uri: 'notes://plan', layer: 'owner' })))
        .layer,
    ).toBe('owner')
  })

  it('改层的限制：人格层与应用层不能直接改，viewer 不能改，Key 要有新层的写权限', async () => {
    const viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
    await ws.createPersona('doubao')
    await create(ws.cookie, { uri: 'persona://doubao/soul', content: '直接' })
    expect(
      (await patchRes(ws.cookie, { uri: 'persona://doubao/soul', layer: 'base' })).status,
    ).toBe(400)
    await create(ws.cookie, { uri: 'kb://faq', content: '常见问题', layer: 'base' })
    expect((await patchRes(viewer.cookie, { uri: 'kb://faq', layer: 'private' })).status).toBe(403)

    const scopes: KeyScopes = {
      ...FULL_SCOPES,
      writeLayers: ['private'],
      maxSensitivity: 'private',
    }
    const key = await ws.issueKey((await ws.createApp('agent')).id, scopes)
    const viaKey = (body: Record<string, unknown>) =>
      app.request('/v1/memories', jsonRequest('PATCH', body, bearer(key)))
    await create(ws.cookie, { uri: 'notes://k', content: '私人' })
    expect((await viaKey({ uri: 'notes://k', layer: 'base' })).status).toBe(403)
  })

  it('改层撞上别的成员同一个 URI 的私人记忆时返回 409', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    await create(ws.cookie, { uri: 'notes://same', content: '主人的' })
    await create(editor.cookie, { uri: 'notes://same', content: 'editor 的' })
    expect((await patchRes(ws.cookie, { uri: 'notes://same', layer: 'base' })).status).toBe(409)
  })

  it('移进、移出 persona:// 与 app:// 时层跟着变，移出时要指定新的层', async () => {
    await ws.createPersona('doubao')
    const botApp = await ws.createApp('bot')
    await create(ws.cookie, { uri: 'notes://rules', content: '规则' })

    const toApp = await ok<MemoryView>(
      await moveRes(ws.cookie, { from: 'notes://rules', to: 'app://bot/rules' }),
    )
    expect(toApp.layer).toBe('app')
    // 这个应用的 Key 现在读得到它
    const key = await ws.issueKey(botApp.id)
    const read = await app.request(`/v1/memories?uri=${encodeURIComponent('app://bot/rules')}`, {
      headers: bearer(key),
    })
    expect(read.status).toBe(200)

    expect((await moveRes(ws.cookie, { from: 'app://bot/rules', to: 'core://rules' })).status).toBe(
      400,
    )
    expect(
      (
        await moveRes(ws.cookie, {
          from: 'app://bot/rules',
          to: 'persona://doubao/rules',
          layer: 'base',
        })
      ).status,
    ).toBe(400)
    const toPersona = await ok<MemoryView>(
      await moveRes(ws.cookie, { from: 'app://bot/rules', to: 'persona://doubao/rules' }),
    )
    expect(toPersona.layer).toBe('persona')
    const out = await ok<MemoryView>(
      await moveRes(ws.cookie, {
        from: 'persona://doubao/rules',
        to: 'core://rules',
        layer: 'base',
      }),
    )
    expect(out.layer).toBe('base')
    // 普通 domain 之间移动时也能顺便改层
    const priv = await ok<MemoryView>(
      await moveRes(ws.cookie, { from: 'core://rules', to: 'notes://rules', layer: 'private' }),
    )
    expect(priv.layer).toBe('private')
  })

  it('Key 不能把记忆移进别的应用的命名空间', async () => {
    const mine = await ws.createApp('mine')
    await ws.createApp('other')
    const key = await ws.issueKey(mine.id)
    const viaKey = (body: Record<string, unknown>) =>
      app.request('/v1/memories/move', jsonRequest('POST', body, bearer(key)))
    const created = await app.request(
      '/v1/memories',
      jsonRequest('POST', { uri: 'notes://x', content: 'x' }, bearer(key)),
    )
    expect(created.status).toBe(201)
    expect((await viaKey({ from: 'notes://x', to: 'app://other/x' })).status).toBe(403)
    expect((await viaKey({ from: 'notes://x', to: 'app://mine/x' })).status).toBe(200)
  })

  it('domain 默认层：成员都能读，只有空间 owner 能改，persona 与 app 不能配置', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const url = `${space()}/domain-layers`
    expect(
      await ok<DomainLayers>(await app.request(url, { headers: { cookie: editor.cookie } })),
    ).toEqual({
      defaults: {},
    })
    const defaults = { core: 'base', preferences: 'owner' }
    expect(
      await ok<DomainLayers>(
        await app.request(url, jsonRequest('PUT', { defaults }, { cookie: ws.cookie })),
      ),
    ).toEqual({
      defaults,
    })
    expect(
      await ok<DomainLayers>(await app.request(url, { headers: { cookie: editor.cookie } })),
    ).toEqual({
      defaults,
    })
    expect(
      (await app.request(url, jsonRequest('PUT', { defaults: {} }, { cookie: editor.cookie })))
        .status,
    ).toBe(403)
    for (const bad of [{ persona: 'base' }, { core: 'app' }, { 'Bad-Domain': 'base' }]) {
      const res = await app.request(
        url,
        jsonRequest('PUT', { defaults: bad }, { cookie: ws.cookie }),
      )
      expect(res.status).toBe(400)
    }
    // 只是管理界面的默认值：Key 写入不传层仍按私人层
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const viaKey = await app.request(
      '/v1/memories',
      jsonRequest('POST', { uri: 'core://new', content: '新的' }, bearer(key)),
    )
    expect(((await viaKey.json()) as MemoryView).layer).toBe('private')
  })
})
