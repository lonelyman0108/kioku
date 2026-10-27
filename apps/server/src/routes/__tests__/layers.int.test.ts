import { randomBytes } from 'node:crypto'

import type {
  ActivityList,
  DomainLayers,
  KeyScopes,
  MemoryHistory,
  MemoryView,
} from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memories } from '../../db/schema'
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
      jsonRequest('POST', { uri: 'notes://x', content: 'x', layer: 'base' }, bearer(key)),
    )
    expect(created.status).toBe(201)
    expect((await viaKey({ from: 'notes://x', to: 'app://other/x' })).status).toBe(403)
    expect((await viaKey({ from: 'notes://x', to: 'app://mine/x' })).status).toBe(200)
  })

  it('通过 Key 不能在共享的层与个人的层之间转换，个人的层之间、共享的层之间可以', async () => {
    const mine = await ws.createApp('mine')
    const key = await ws.issueKey(mine.id)
    const viaKey = (method: string, path: string, body: Record<string, unknown>) =>
      app.request(`/v1/memories${path}`, jsonRequest(method, body, bearer(key)))
    await create(ws.cookie, { uri: 'kb://faq', content: '共享的', layer: 'base' })
    await create(ws.cookie, { uri: 'notes://mine', content: '主人的' })

    // 共享 → 个人、个人 → 共享，改层与移动都不行
    expect((await viaKey('PATCH', '', { uri: 'kb://faq', layer: 'private' })).status).toBe(403)
    expect((await viaKey('PATCH', '', { uri: 'notes://mine', layer: 'base' })).status).toBe(403)
    expect(
      (await viaKey('POST', '/move', { from: 'kb://faq', to: 'notes://faq', layer: 'owner' }))
        .status,
    ).toBe(403)
    expect(
      (await viaKey('POST', '/move', { from: 'notes://mine', to: 'app://mine/notes' })).status,
    ).toBe(403)
    // 个人的层之间（同一个主人）可以
    const owner = await viaKey('PATCH', '', { uri: 'notes://mine', layer: 'owner' })
    expect(((await owner.json()) as MemoryView).layer).toBe('owner')
    // 共享的层之间可以：本应用的应用层移到 base
    expect((await viaKey('POST', '/move', { from: 'kb://faq', to: 'app://mine/faq' })).status).toBe(
      200,
    )
    const out = await viaKey('POST', '/move', {
      from: 'app://mine/faq',
      to: 'kb://faq',
      layer: 'base',
    })
    expect(((await out.json()) as MemoryView).layer).toBe('base')
    // 管理界面里由人来改不受这个限制
    expect((await patchRes(ws.cookie, { uri: 'kb://faq', layer: 'private' })).status).toBe(200)
  })

  it('对象层与情节层的记忆不能改层，也不能移到别的命名空间', async () => {
    await ws.createApp('bot')
    // 还没有抽取写入，直接造一条来自对话的情节记忆
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(memories).values({
        spaceId: ws.spaceId,
        form: 'curated',
        layer: 'episode',
        sensitivity: 'public',
        provenance: 'untrusted',
        domain: 'chat',
        path: 'today',
        content: '群里说的话',
      }),
    )
    expect(
      (await moveRes(ws.cookie, { from: 'chat://today', to: 'core://today', layer: 'base' }))
        .status,
    ).toBe(400)
    expect((await moveRes(ws.cookie, { from: 'chat://today', to: 'app://bot/today' })).status).toBe(
      400,
    )
    expect((await patchRes(ws.cookie, { uri: 'chat://today', layer: 'base' })).status).toBe(400)
    // 不改层、在同一个 domain 里改名照常可以
    expect((await moveRes(ws.cookie, { from: 'chat://today', to: 'chat://day1' })).status).toBe(200)
  })

  it('共享的记忆被人改进自己的私人层后，原来看得到的人在活动里还有一条只有改前信息的记录', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const m = await create(ws.cookie, { uri: 'core://rules', content: '共享的规则', layer: 'base' })
    // editor 把它移成自己的私人记忆，换了 URI
    expect(
      (
        await moveRes(editor.cookie, {
          from: 'core://rules',
          to: 'notes://eve-plan',
          layer: 'private',
        })
      ).status,
    ).toBe(200)
    expect((await getRes(ws.cookie, 'core://rules')).status).toBe(404)

    const activity = async (cookie: string) =>
      ok<ActivityList>(await app.request(`${space()}/activity`, { headers: { cookie } }))
    const items = (await activity(ws.cookie)).items
    expect(items[0]).toMatchObject({
      type: 'move',
      memoryId: m.id,
      // 只给改前的 URI，不给它现在在别人那里的 URI
      uri: 'core://rules',
      changes: [],
      left: true,
      actor: { accountName: 'eve' },
    })
    expect(JSON.stringify(items)).not.toContain('eve-plan')
    // 它离开之后，owner 只剩这一条离开的记录（更早的改动记录也随它离开）；
    // 之后在 editor 私人层里的改动，owner 也看不到
    expect(items.filter((i) => i.memoryId === m.id)).toHaveLength(1)
    await patchRes(editor.cookie, { uri: 'notes://eve-plan', content: '改过的计划' })
    expect((await activity(ws.cookie)).items.filter((i) => i.memoryId === m.id)).toHaveLength(1)

    // 它又回到共享层之后，owner 能看历史：离开那一条只有改前的版本，回来的那次与私人层期间的都看不到
    await moveRes(editor.cookie, { from: 'notes://eve-plan', to: 'core://rules', layer: 'base' })
    const history = await ok<MemoryHistory>(
      await app.request(`${space()}/memories/history?id=${m.id}`, {
        headers: { cookie: ws.cookie },
      }),
    )
    expect(history.events.map((e) => [e.type, e.left])).toEqual([
      ['create', false],
      ['move', true],
    ])
    const departed = history.events[1]!
    expect(departed.before?.content).toBe('共享的规则')
    expect(departed.after).toBeNull()
    expect(JSON.stringify(history)).not.toContain('改过的计划')
    // 离开的事件不能拿来恢复
    const restore = await app.request(
      `${space()}/memories/restore`,
      jsonRequest(
        'POST',
        { memoryId: m.id, eventId: departed.id, expectedVersion: history.memory.version },
        { cookie: ws.cookie },
      ),
    )
    expect(restore.status).toBe(404)
  })

  it('记忆改成 secret 后，editor 的活动里有一条离开的记录', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    await create(ws.cookie, { uri: 'kb://wifi', content: '密码在柜子里', layer: 'base' })
    await patchRes(ws.cookie, { uri: 'kb://wifi', sensitivity: 'secret' })
    const items = (
      await ok<ActivityList>(
        await app.request(`${space()}/activity`, { headers: { cookie: editor.cookie } }),
      )
    ).items
    expect(items.map((i) => [i.type, i.uri, i.left])).toEqual([['update', 'kb://wifi', true]])
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
