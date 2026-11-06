import { randomBytes } from 'node:crypto'

import type { ActivityList, KeyScopes, MemoryHistory, MemoryView } from '@kioku/contracts'
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

describe.skipIf(!testDatabaseUrl)('坐标的开头决定归属：移动与改归属', () => {
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
    expect(res.status, await res.clone().text()).toBe(status)
    return (await res.json()) as T
  }
  const createRes = (cookie: string, body: Record<string, unknown>) =>
    app.request(`${space()}/memories`, jsonRequest('POST', body, { cookie }))
  const create = async (cookie: string, body: Record<string, unknown>) =>
    ok<MemoryView>(await createRes(cookie, body), 201)
  const patchRes = (cookie: string, body: Record<string, unknown>) =>
    app.request(`${space()}/memories`, jsonRequest('PATCH', body, { cookie }))
  const moveRes = (cookie: string, body: Record<string, unknown>) =>
    app.request(`${space()}/memories/move`, jsonRequest('POST', body, { cookie }))
  const getRes = (cookie: string, uri: string) =>
    app.request(`${space()}/memories?uri=${encodeURIComponent(uri)}`, { headers: { cookie } })

  it('开头就是归属：本人按成员各一份，移到共享的开头之后大家都看得到', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const m = await create(ws.cookie, { uri: 'user://notes/plan', content: '本人的计划' })
    expect(m.layer).toBe('user')
    expect(m.sensitivity).toBe('private')
    expect((await getRes(editor.cookie, 'user://notes/plan')).status).toBe(404)
    // 两个成员可以各有一条同样坐标的本人记忆
    const theirs = await create(editor.cookie, { uri: 'user://notes/plan', content: 'eve 的' })
    expect(theirs.id).not.toBe(m.id)

    const shared = await ok<MemoryView>(
      await moveRes(ws.cookie, { from: 'user://notes/plan', to: 'core://notes/plan' }),
    )
    expect(shared.layer).toBe('core')
    expect((await getRes(editor.cookie, 'core://notes/plan')).status).toBe(200)
    // 它在本人期间的版本，editor 在历史里仍然看不到
    const history = await ok<MemoryHistory>(
      await app.request(`${space()}/memories/history?id=${m.id}`, {
        headers: { cookie: editor.cookie },
      }),
    )
    expect(history.events).toEqual([])
    // 共享的坐标在同一归属里唯一：别人再建同一个共享坐标是 409
    expect(
      (await createRes(editor.cookie, { uri: 'core://notes/plan', content: '再来' })).status,
    ).toBe(409)
  })

  it('移动的限制：viewer 不能移，Key 要有新归属的写权限', async () => {
    const viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
    await create(ws.cookie, { uri: 'core://kb/faq', content: '常见问题' })
    expect(
      (await moveRes(viewer.cookie, { from: 'core://kb/faq', to: 'core://kb/q' })).status,
    ).toBe(403)

    const scopes: KeyScopes = { ...FULL_SCOPES, writeLayers: ['user'], maxSensitivity: 'private' }
    const key = await ws.issueKey((await ws.createApp('agent')).id, scopes)
    const viaKey = (body: Record<string, unknown>) =>
      app.request('/v1/memories/move', jsonRequest('POST', body, bearer(key)))
    await create(ws.cookie, { uri: 'user://notes/k', content: '本人的' })
    expect((await viaKey({ from: 'user://notes/k', to: 'user://notes/k2' })).status).toBe(200)
    expect((await viaKey({ from: 'core://kb/faq', to: 'core://kb/q' })).status).toBe(403)
  })

  it('移进、移出 persona:// 与 app:// 时归属跟着变', async () => {
    await ws.createPersona('doubao')
    const botApp = await ws.createApp('bot')
    await create(ws.cookie, { uri: 'core://rules', content: '规则' })

    const toApp = await ok<MemoryView>(
      await moveRes(ws.cookie, { from: 'core://rules', to: 'app://bot/rules' }),
    )
    expect(toApp.layer).toBe('app')
    // 这个应用的 Key 现在读得到它
    const key = await ws.issueKey(botApp.id)
    const read = await app.request(`/v1/memories?uri=${encodeURIComponent('app://bot/rules')}`, {
      headers: bearer(key),
    })
    expect(read.status).toBe(200)

    const toPersona = await ok<MemoryView>(
      await moveRes(ws.cookie, { from: 'app://bot/rules', to: 'persona://doubao/rules' }),
    )
    expect(toPersona.layer).toBe('persona')
    const out = await ok<MemoryView>(
      await moveRes(ws.cookie, { from: 'persona://doubao/rules', to: 'core://rules' }),
    )
    expect(out.layer).toBe('core')
    // 不存在的人格、应用不能当开头
    expect(
      (await moveRes(ws.cookie, { from: 'core://rules', to: 'persona://nobody/rules' })).status,
    ).toBe(404)
  })

  it('Key 不能把记忆移进别的应用', async () => {
    const mine = await ws.createApp('mine')
    await ws.createApp('other')
    const key = await ws.issueKey(mine.id)
    const viaKey = (body: Record<string, unknown>) =>
      app.request('/v1/memories/move', jsonRequest('POST', body, bearer(key)))
    const created = await app.request(
      '/v1/memories',
      jsonRequest('POST', { uri: 'core://notes/x', content: 'x' }, bearer(key)),
    )
    expect(created.status).toBe(201)
    expect((await viaKey({ from: 'core://notes/x', to: 'app://other/x' })).status).toBe(403)
    expect((await viaKey({ from: 'core://notes/x', to: 'app://mine/x' })).status).toBe(200)
  })

  it('通过 Key 不能在共享的归属与本人之间移动，共享的归属之间、本人里面可以', async () => {
    const mine = await ws.createApp('mine')
    const key = await ws.issueKey(mine.id)
    const viaKey = (body: Record<string, unknown>) =>
      app.request('/v1/memories/move', jsonRequest('POST', body, bearer(key)))
    await create(ws.cookie, { uri: 'core://kb/faq', content: '共享的' })
    await create(ws.cookie, { uri: 'user://notes/mine', content: '本人的' })

    expect((await viaKey({ from: 'core://kb/faq', to: 'user://kb/faq' })).status).toBe(403)
    expect((await viaKey({ from: 'user://notes/mine', to: 'app://mine/notes' })).status).toBe(403)
    // 本人里面换位置可以
    expect((await viaKey({ from: 'user://notes/mine', to: 'user://plans/mine' })).status).toBe(200)
    // 共享的归属之间可以：通用移到本应用，再移回来
    expect((await viaKey({ from: 'core://kb/faq', to: 'app://mine/faq' })).status).toBe(200)
    const back = await viaKey({ from: 'app://mine/faq', to: 'core://kb/faq' })
    expect(((await back.json()) as MemoryView).layer).toBe('core')
    // 管理界面里由人来移不受这个限制；公开的记忆要先调高敏感级才能移进本人
    expect((await moveRes(ws.cookie, { from: 'core://kb/faq', to: 'user://kb/faq' })).status).toBe(
      400,
    )
    await patchRes(ws.cookie, { uri: 'core://kb/faq', sensitivity: 'internal' })
    const moved = await ok<MemoryView>(
      await moveRes(ws.cookie, { from: 'core://kb/faq', to: 'user://kb/faq' }),
    )
    expect(moved.layer).toBe('user')
  })

  it('本人不设公开：新建、改敏感级都拒绝，并说明原因', async () => {
    const res = await createRes(ws.cookie, {
      uri: 'user://notes/pub',
      content: '公开的？',
      sensitivity: 'public',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain(
      '本人（user://）的记忆不设公开',
    )
    await create(ws.cookie, { uri: 'user://notes/x', content: 'x', sensitivity: 'internal' })
    expect(
      (await patchRes(ws.cookie, { uri: 'user://notes/x', sensitivity: 'public' })).status,
    ).toBe(400)
    // 通过 Key 写也一样
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const viaKey = await app.request(
      '/v1/memories',
      jsonRequest(
        'POST',
        { uri: 'user://notes/y', content: 'y', sensitivity: 'public' },
        bearer(key),
      ),
    )
    expect(viaKey.status).toBe(400)
  })

  it('四种开头以外的坐标直接拒绝，说明各放什么', async () => {
    const res = await createRes(ws.cookie, { uri: 'notes://plan', content: 'x' })
    expect(res.status).toBe(400)
    const { error } = (await res.json()) as { error: string }
    for (const root of ['core://', 'user://', 'persona://<人格标识>/', 'app://<应用标识>/']) {
      expect(error).toContain(root)
    }
    // 人格、应用的开头之后还要有标识
    expect((await createRes(ws.cookie, { uri: 'app://bot', content: 'x' })).status).toBe(400)
  })

  it('共享的记忆被人移进自己的本人后，原来看得到的人在变更记录里还有一条只有改前信息的记录', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const m = await create(ws.cookie, {
      uri: 'core://rules',
      content: '共享的规则',
      sensitivity: 'internal',
    })
    // editor 把它移成自己的本人记忆，换了坐标
    expect(
      (await moveRes(editor.cookie, { from: 'core://rules', to: 'user://notes/eve-plan' })).status,
    ).toBe(200)
    expect((await getRes(ws.cookie, 'core://rules')).status).toBe(404)

    const activity = async (cookie: string) =>
      ok<ActivityList>(await app.request(`${space()}/activity`, { headers: { cookie } }))
    const items = (await activity(ws.cookie)).items
    expect(items[0]).toMatchObject({
      type: 'move',
      memoryId: m.id,
      // 只给改前的坐标，不给它现在在别人那里的坐标
      uri: 'core://rules',
      changes: [],
      left: true,
      actor: { accountName: 'eve' },
    })
    expect(JSON.stringify(items)).not.toContain('eve-plan')
    // 它离开之后，owner 只剩这一条离开的记录（更早的改动记录也随它离开）；
    // 之后在 editor 本人记忆里的改动，owner 也看不到
    expect(items.filter((i) => i.memoryId === m.id)).toHaveLength(1)
    await patchRes(editor.cookie, { uri: 'user://notes/eve-plan', content: '改过的计划' })
    expect((await activity(ws.cookie)).items.filter((i) => i.memoryId === m.id)).toHaveLength(1)

    // 它又回到共享的归属之后，owner 能看历史：离开那一条只有改前的版本，回来的那次与本人期间的都看不到
    await moveRes(editor.cookie, { from: 'user://notes/eve-plan', to: 'core://rules' })
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

  it('记忆改成 secret 后，editor 的变更记录里有一条离开的记录', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    await create(ws.cookie, { uri: 'core://kb/wifi', content: '密码在柜子里' })
    await patchRes(ws.cookie, { uri: 'core://kb/wifi', sensitivity: 'secret' })
    const items = (
      await ok<ActivityList>(
        await app.request(`${space()}/activity`, { headers: { cookie: editor.cookie } }),
      )
    ).items
    expect(items.map((i) => [i.type, i.uri, i.left])).toEqual([['update', 'core://kb/wifi', true]])
  })
})
