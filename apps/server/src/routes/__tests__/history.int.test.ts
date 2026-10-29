import { randomBytes } from 'node:crypto'

import type {
  ActivityList,
  DeletedMemoryList,
  MemoryHistory,
  MemoryView,
  SpaceOverview,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memories, memoryEvents } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('管理界面的历史、撤销删除与恢复', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  // 记下排队生成向量的记忆，用来确认撤销删除之后会重新生成
  const queued: string[] = []

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: {
        enqueueEmbed: (_spaceId, memoryId) => void queued.push(memoryId),
        enqueueBackfill: async () => true,
        enqueueSwitch: async () => true,
        enqueuePrune: async () => true,
        enqueueBackup: async () => null,
        backupRun: async () => null,
        enqueueExtraction: async () => {},
        enqueueCleanup: async () => true,
      },
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    queued.length = 0
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
  const patch = async (cookie: string, body: Record<string, unknown>) =>
    ok<MemoryView>(await app.request(`${space()}/memories`, jsonRequest('PATCH', body, { cookie })))
  const remove = async (cookie: string, m: MemoryView) => {
    const query = `uri=${encodeURIComponent(m.uri)}&expectedId=${m.id}&expectedVersion=${m.version}`
    const res = await app.request(`${space()}/memories?${query}`, {
      method: 'DELETE',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(204)
  }
  const historyRes = (cookie: string, id: string) =>
    app.request(`${space()}/memories/history?id=${id}`, { headers: { cookie } })
  const history = async (cookie: string, id: string) =>
    ok<MemoryHistory>(await historyRes(cookie, id))
  const deleted = async (cookie: string, query = '') =>
    ok<DeletedMemoryList>(
      await app.request(`${space()}/memories/deleted${query ? `?${query}` : ''}`, {
        headers: { cookie },
      }),
    )
  const activity = async (cookie: string, query = '') =>
    ok<ActivityList>(
      await app.request(`${space()}/activity${query ? `?${query}` : ''}`, { headers: { cookie } }),
    )
  const restoreRes = (cookie: string, body: Record<string, unknown>) =>
    app.request(`${space()}/memories/restore`, jsonRequest('POST', body, { cookie }))
  const undeleteRes = (cookie: string, memoryId: string) =>
    app.request(`${space()}/memories/undelete`, jsonRequest('POST', { memoryId }, { cookie }))

  // 照着服务写事件时的样子，把一行记忆变成快照
  async function snapshotOf(id: string, overrides: Record<string, unknown> = {}) {
    const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memories).where(eq(memories.id, id)),
    )
    const rest: Record<string, unknown> = { ...row, glossary: [] }
    delete rest.ciphertext
    delete rest.wrappedKey
    delete rest.keyId
    delete rest.fts
    return JSON.parse(JSON.stringify({ ...rest, ...overrides })) as Record<string, unknown>
  }
  async function insertEvent(memoryId: string, before: unknown, after: unknown) {
    const [event] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .insert(memoryEvents)
        .values({
          spaceId: ws.spaceId,
          memoryId,
          eventType: 'update',
          provenance: 'owner',
          before,
          after,
        })
        .returning(),
    )
    return event!.id
  }

  it('历史从早到晚列出新建、修改、移动，带操作者', async () => {
    const m = await create(ws.cookie, { uri: 'notes://a', content: '第一版' })
    await patch(ws.cookie, { uri: 'notes://a', content: '第二版' })
    const moved = await app.request(
      `${space()}/memories/move`,
      jsonRequest('POST', { from: 'notes://a', to: 'notes://b' }, { cookie: ws.cookie }),
    )
    expect(moved.status).toBe(200)
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const viaKey = await app.request(
      '/v1/memories',
      jsonRequest('PATCH', { uri: 'notes://b', content: '第三版' }, bearer(key)),
    )
    expect(viaKey.status).toBe(200)

    const h = await history(ws.cookie, m.id)
    expect(h.memory).toMatchObject({ id: m.id, uri: 'notes://b', version: 4, deletedAt: null })
    expect(h.events.map((e) => e.type)).toEqual(['create', 'update', 'move', 'update'])
    expect(h.events[0]!.before).toBeNull()
    expect(h.events[0]!.after).toMatchObject({ uri: 'notes://a', content: '第一版', version: 1 })
    expect(h.events[2]!.after?.uri).toBe('notes://b')
    expect(h.events[0]!.actor).toEqual({ accountName: 'alice', keyName: null, appName: null })
    expect(h.events[3]!.actor).toEqual({ accountName: null, keyName: 'test', appName: 'agent' })
  })

  it('事件太多时历史保留最近的 500 个，按时间正序，并标出截断', async () => {
    const m = await create(ws.cookie, { uri: 'notes://busy', content: '常改的' })
    const snap = await snapshotOf(m.id)
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(memoryEvents).values(
        Array.from({ length: 505 }, () => ({
          spaceId: ws.spaceId,
          memoryId: m.id,
          eventType: 'update',
          provenance: 'owner' as const,
          before: snap,
          after: snap,
        })),
      ),
    )
    const h = await history(ws.cookie, m.id)
    expect(h.truncated).toBe(true)
    expect(h.events).toHaveLength(500)
    // 最早的新建事件被截掉，留下的是最近的，从早到晚
    expect(h.events.map((e) => e.type)).not.toContain('create')
    const ids = h.events.map((e) => e.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(
      (
        await history(
          ws.cookie,
          (await create(ws.cookie, { uri: 'notes://calm', content: '少改的' })).id,
        )
      ).truncated,
    ).toBe(false)
  })

  it('别的成员看不到私人记忆的历史；secret 的历史只给 owner，快照里没有正文', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const diary = await create(ws.cookie, { uri: 'home://diary', content: '私事' })
    expect((await historyRes(editor.cookie, diary.id)).status).toBe(404)

    const wifi = await create(ws.cookie, {
      uri: 'kb://wifi',
      content: 'hunter2',
      layer: 'base',
      sensitivity: 'secret',
    })
    const h = await history(ws.cookie, wifi.id)
    expect(h.events.map((e) => e.after?.content)).toEqual([null])
    expect((await historyRes(editor.cookie, wifi.id)).status).toBe(404)
    // 现在是 secret 的记忆，editor 也恢复不了
    const res = await restoreRes(editor.cookie, {
      memoryId: wifi.id,
      eventId: h.events[0]!.id,
      expectedVersion: 1,
    })
    expect(res.status).toBe(404)
  })

  it('有一边快照看不到的事件整条不显示，也不能拿来恢复，活动里同样没有', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const faq = await create(ws.cookie, { uri: 'kb://faq', content: '常见问题', layer: 'base' })
    // 还没有改层的接口，直接造一条「改前在主人私人层」的事件
    const before = await snapshotOf(faq.id, {
      layer: 'private',
      ownerAccountId: ws.accountId,
      content: '主人的私事',
    })
    const hidden = await insertEvent(faq.id, before, await snapshotOf(faq.id))

    expect((await history(editor.cookie, faq.id)).events.map((e) => e.id)).not.toContain(hidden)
    expect((await history(ws.cookie, faq.id)).events.map((e) => e.id)).toContain(hidden)
    const res = await restoreRes(editor.cookie, {
      memoryId: faq.id,
      eventId: hidden,
      expectedVersion: 1,
    })
    expect(res.status).toBe(404)
    expect((await activity(editor.cookie)).items.map((i) => i.id)).not.toContain(hidden)
    expect((await activity(ws.cookie)).items.map((i) => i.id)).toContain(hidden)
  })

  it('过期的记忆照样能看历史和恢复；人格删掉之后，它的旧快照照样看得到', async () => {
    const m = await create(ws.cookie, { uri: 'notes://old', content: '第一版' })
    const edited = await patch(ws.cookie, { uri: 'notes://old', content: '第二版' })
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 60_000) })
        .where(eq(memories.id, m.id)),
    )
    const normal = await app.request(`${space()}/memories?uri=${encodeURIComponent(m.uri)}`, {
      headers: { cookie: ws.cookie },
    })
    expect(normal.status).toBe(404)
    const h = await history(ws.cookie, m.id)
    expect(h.events.map((e) => e.type)).toEqual(['create', 'update'])
    const restored = await ok<MemoryView>(
      await restoreRes(ws.cookie, {
        memoryId: m.id,
        eventId: h.events[0]!.id,
        expectedVersion: edited.version,
      }),
    )
    expect(restored.content).toBe('第一版')

    const gone = '00000000-0000-4000-8000-000000000000'
    const persona = await snapshotOf(m.id, {
      layer: 'persona',
      ownerAccountId: null,
      personaId: gone,
    })
    const id = await insertEvent(m.id, persona, persona)
    expect((await history(ws.cookie, m.id)).events.map((e) => e.id)).toContain(id)
  })

  it('恢复到某一版：只改正文、disclosure、priority 与关键词，版本对不上返回 409', async () => {
    const m = await create(ws.cookie, {
      uri: 'notes://r',
      content: '第一版',
      disclosure: '最初',
      priority: 3,
      glossary: ['甲乙'],
    })
    const edited = await patch(ws.cookie, {
      uri: 'notes://r',
      content: '第二版',
      disclosure: '后来',
      priority: 1,
      glossaryAdd: ['丙丁'],
      glossaryRemove: ['甲乙'],
    })
    const first = (await history(ws.cookie, m.id)).events[0]!
    const restored = await ok<MemoryView>(
      await restoreRes(ws.cookie, {
        memoryId: m.id,
        eventId: first.id,
        expectedVersion: edited.version,
      }),
    )
    expect(restored).toMatchObject({
      content: '第一版',
      disclosure: '最初',
      priority: 3,
      glossary: ['甲乙'],
      version: edited.version + 1,
    })
    const stale = await restoreRes(ws.cookie, {
      memoryId: m.id,
      eventId: first.id,
      expectedVersion: edited.version,
    })
    expect(stale.status).toBe(409)
    expect((await history(ws.cookie, m.id)).events.map((e) => e.type)).toEqual([
      'create',
      'update',
      'restore',
    ])
    // 别的记忆的事件不能拿来恢复这一条
    const other = await create(ws.cookie, { uri: 'notes://other', content: '别的' })
    const otherEvent = (await history(ws.cookie, other.id)).events[0]!
    const mismatch = await restoreRes(ws.cookie, {
      memoryId: m.id,
      eventId: otherEvent.id,
      expectedVersion: restored.version,
    })
    expect(mismatch.status).toBe(404)
  })

  it('从没有正文的快照恢复时正文不变；不能恢复到删除之后的那一版', async () => {
    const m = await create(ws.cookie, { uri: 'notes://s', content: '明文', disclosure: '一' })
    // 改成 secret 时，之前所有快照里的正文都被抹掉
    const edited = await patch(ws.cookie, {
      uri: 'notes://s',
      disclosure: '二',
      sensitivity: 'secret',
    })
    const h = await history(ws.cookie, m.id)
    expect(h.events[0]!.after?.content).toBeNull()
    const restored = await ok<MemoryView>(
      await restoreRes(ws.cookie, {
        memoryId: m.id,
        eventId: h.events[0]!.id,
        expectedVersion: edited.version,
      }),
    )
    expect(restored).toMatchObject({ content: '明文', disclosure: '一', sensitivity: 'secret' })

    await remove(ws.cookie, restored)
    await ok<MemoryView>(await undeleteRes(ws.cookie, m.id))
    const h2 = await history(ws.cookie, m.id)
    const deleteEvent = h2.events.find((e) => e.type === 'delete')!
    const res = await restoreRes(ws.cookie, {
      memoryId: m.id,
      eventId: deleteEvent.id,
      expectedVersion: h2.memory.version,
    })
    expect(res.status).toBe(400)
  })

  it('撤销删除：原样恢复（secret 的正文也在），版本加一，重新生成向量；URI 被占用时 409', async () => {
    const m = await create(ws.cookie, {
      uri: 'kb://wifi',
      content: 'hunter2',
      layer: 'base',
      sensitivity: 'secret',
    })
    await remove(ws.cookie, m)
    expect((await deleted(ws.cookie)).items.map((i) => i.uri)).toEqual(['kb://wifi'])
    queued.length = 0

    const back = await ok<MemoryView>(await undeleteRes(ws.cookie, m.id))
    expect(back).toMatchObject({ id: m.id, content: 'hunter2', version: 2 })
    expect(queued).toContain(m.id)
    expect((await deleted(ws.cookie)).items).toEqual([])
    expect((await history(ws.cookie, m.id)).events.map((e) => e.type)).toEqual([
      'create',
      'delete',
      'undelete',
    ])
    expect((await undeleteRes(ws.cookie, m.id)).status).toBe(409)

    // 删掉之后在同一个 URI 新建了一条，再撤销删除就撞上
    await remove(ws.cookie, back)
    await create(ws.cookie, { uri: 'kb://wifi', content: '新的', layer: 'base' })
    expect((await undeleteRes(ws.cookie, m.id)).status).toBe(409)
  })

  it('已删除的列表只列成员读得到的，最近删除的在前，能翻页', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    for (const name of ['one', 'two', 'three']) {
      await remove(
        ws.cookie,
        await create(ws.cookie, { uri: `kb://${name}`, content: name, layer: 'base' }),
      )
    }
    await remove(editor.cookie, await create(editor.cookie, { uri: 'home://e', content: 'E 的' }))
    await remove(
      ws.cookie,
      await create(ws.cookie, {
        uri: 'kb://s',
        content: 's',
        layer: 'base',
        sensitivity: 'secret',
      }),
    )

    const all = (await deleted(ws.cookie, 'limit=200')).items.map((i) => i.uri)
    expect(all).toEqual(['kb://s', 'kb://three', 'kb://two', 'kb://one'])
    const first = await deleted(ws.cookie, 'limit=3')
    const second = await deleted(ws.cookie, `limit=3&cursor=${first.nextCursor}`)
    expect([...first.items, ...second.items].map((i) => i.uri)).toEqual(all)
    expect(second.nextCursor).toBeNull()
    expect((await deleted(editor.cookie)).items.map((i) => i.uri)).toEqual([
      'home://e',
      'kb://three',
      'kb://two',
      'kb://one',
    ])
    // editor 撤销不了自己看不到的
    const secretId = (await deleted(ws.cookie, 'limit=1')).items[0]!.id
    expect((await undeleteRes(editor.cookie, secretId)).status).toBe(404)
  })

  it('恢复不把内容带到更宽的可见范围：敏感级比现在高、或归属不同的版本都被拒', async () => {
    const m = await create(ws.cookie, {
      uri: 'kb://notes',
      content: '内部细节',
      layer: 'base',
      sensitivity: 'private',
    })
    const edited = await patch(ws.cookie, {
      uri: 'kb://notes',
      content: '可以公开的版本',
      sensitivity: 'public',
    })
    const first = (await history(ws.cookie, m.id)).events[0]!
    const res = await restoreRes(ws.cookie, {
      memoryId: m.id,
      eventId: first.id,
      expectedVersion: edited.version,
    })
    expect(res.status).toBe(400)

    // 归属不同（这一版在主人的私人层）：即使主人自己看得到，也不能恢复进共享层
    const before = await snapshotOf(m.id, { layer: 'private', ownerAccountId: ws.accountId })
    const event = await insertEvent(m.id, before, before)
    const crossed = await restoreRes(ws.cookie, {
      memoryId: m.id,
      eventId: event,
      expectedVersion: edited.version,
    })
    expect(crossed.status).toBe(400)
  })

  it('Key 的名字只给应用主人与空间 owner 看，别人只看到应用名', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const created = await app.request(
      '/v1/memories',
      jsonRequest('POST', { uri: 'kb://shared', content: '共享', layer: 'base' }, bearer(key)),
    )
    const m = (await created.json()) as MemoryView
    const actor = async (cookie: string) => (await history(cookie, m.id)).events[0]!.actor
    expect(await actor(ws.cookie)).toEqual({ accountName: null, keyName: 'test', appName: 'agent' })
    expect(await actor(editor.cookie)).toEqual({
      accountName: null,
      keyName: null,
      appName: 'agent',
    })
    expect((await activity(editor.cookie)).items[0]!.actor.keyName).toBeNull()
  })

  it('已经过期的记录不列在已删除里，也不能撤销删除', async () => {
    const m = await create(ws.cookie, { uri: 'kb://stale', content: '旧的', layer: 'base' })
    await remove(ws.cookie, m)
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 60_000) })
        .where(eq(memories.id, m.id)),
    )
    expect((await deleted(ws.cookie)).items).toEqual([])
    expect((await undeleteRes(ws.cookie, m.id)).status).toBe(409)
  })

  it('viewer 看得到历史，但不能撤销删除，也不能恢复', async () => {
    const viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
    const m = await create(ws.cookie, { uri: 'kb://faq', content: '第一版', layer: 'base' })
    const edited = await patch(ws.cookie, { uri: 'kb://faq', content: '第二版' })
    const first = (await history(viewer.cookie, m.id)).events[0]!
    const res = await restoreRes(viewer.cookie, {
      memoryId: m.id,
      eventId: first.id,
      expectedVersion: edited.version,
    })
    expect(res.status).toBe(403)
    await remove(ws.cookie, edited)
    expect((await undeleteRes(viewer.cookie, m.id)).status).toBe(403)
  })

  it('活动条目标出记忆现在是否已删除，撤销删除之后恢复', async () => {
    const m = await create(ws.cookie, { uri: 'kb://gone', content: '一', layer: 'base' })
    const edited = await patch(ws.cookie, { uri: 'kb://gone', content: '二' })
    await remove(ws.cookie, edited)
    const flags = async () =>
      (await activity(ws.cookie)).items.filter((i) => i.memoryId === m.id).map((i) => i.deleted)
    expect(await flags()).toEqual([true, true, true])
    await ok<MemoryView>(await undeleteRes(ws.cookie, m.id))
    expect(await flags()).toEqual([false, false, false, false])
  })

  it('活动流：最新的在前，带 URI 与改了哪些字段，能翻页；概览里有最近的改动', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    await create(ws.cookie, { uri: 'kb://x', content: '一', layer: 'base' })
    await patch(ws.cookie, { uri: 'kb://x', content: '二', priority: 1 })
    await create(editor.cookie, { uri: 'home://e', content: 'E 的' })

    const page = await activity(ws.cookie, 'limit=1')
    expect(page.items[0]).toMatchObject({
      type: 'update',
      uri: 'kb://x',
      changes: ['priority', 'content'],
    })
    const next = await activity(ws.cookie, `limit=1&cursor=${page.nextCursor}`)
    expect(next.items[0]).toMatchObject({ type: 'create', uri: 'kb://x', changes: [] })
    expect(next.nextCursor).toBeNull()
    expect((await activity(editor.cookie)).items.map((i) => [i.type, i.uri])).toEqual([
      ['create', 'home://e'],
      ['update', 'kb://x'],
      ['create', 'kb://x'],
    ])
    const bad = await app.request(`${space()}/activity?cursor=abc`, {
      headers: { cookie: ws.cookie },
    })
    expect(bad.status).toBe(400)

    const overview = await ok<SpaceOverview>(
      await app.request(`${space()}/overview`, { headers: { cookie: ws.cookie } }),
    )
    expect(overview.recent.map((i) => i.type)).toEqual(['update', 'create'])
  })
})
