import { randomBytes } from 'node:crypto'

import type {
  ActivityList,
  BootResponse,
  DeletedMemoryList,
  ExpiredMemoryList,
  LifecycleResponse,
  MemoryHistory,
  MemoryList,
  MemoryView,
  RecallResponse,
  SubjectDetail,
} from '@kioku/contracts'
import { and, asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { isUniqueViolation, withSpace, type Database } from '../../db/client'
import {
  conversationTurns,
  memories,
  memoryEvents,
  settings,
  subjectIdentities,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { ChatModel } from '../../extraction/provider'
import { saveExtractionConfig } from '../../extraction/settings'
import { processSession } from '../../extraction/worker'
import type { Jobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const fakeModel = (reply: unknown): ChatModel => ({
  model: 'fake-model',
  async complete() {
    return { content: JSON.stringify(reply), usage: { promptTokens: 40, completionTokens: 10 } }
  },
})

const DAY = 86_400_000
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString()

describe.skipIf(!testDatabaseUrl)('有效期与重新生效', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let key: string
  const masterKey = randomBytes(32)
  // 排队生成向量的记忆：重新生效之后要重新排
  const queued: string[] = []
  const jobs: Jobs = {
    enqueueEmbed: (_spaceId, memoryId) => void queued.push(memoryId),
    enqueueBackfill: async () => true,
    enqueueSwitch: async () => true,
    enqueuePrune: async () => true,
    enqueueBackup: async () => null,
    backupRun: async () => null,
    enqueueExtraction: async () => {},
  }

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs,
    })
  })
  afterAll(async () => {
    await database?.db.delete(settings).where(eq(settings.key, 'extraction'))
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    key = await ws.issueKey((await ws.createApp('agent', { runtimeFamily: 'claudecode' })).id)
    queued.length = 0
  })

  const space = () => `/v1/spaces/${ws.spaceId}`
  const ok = async <T>(res: Response, status = 200) => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const errorOf = async (res: Response, status: number) => {
    expect(res.status).toBe(status)
    return ((await res.json()) as { error: string }).error
  }
  // 通过 Key 写
  const keyCreate = (body: Record<string, unknown>) =>
    app.request('/v1/memories', jsonRequest('POST', body, bearer(key)))
  const keyPatch = (body: Record<string, unknown>) =>
    app.request('/v1/memories', jsonRequest('PATCH', body, bearer(key)))
  const keyGet = (uri: string) =>
    app.request(`/v1/memories?uri=${encodeURIComponent(uri)}`, { headers: bearer(key) })
  // 管理界面
  const create = (body: Record<string, unknown>, cookie = ws.cookie) =>
    app.request(`${space()}/memories`, jsonRequest('POST', body, { cookie }))
  const get = (uri: string, cookie = ws.cookie) =>
    app.request(`${space()}/memories?uri=${encodeURIComponent(uri)}`, { headers: { cookie } })
  const remove = async (m: MemoryView, cookie = ws.cookie) => {
    const query = `uri=${encodeURIComponent(m.uri)}&expectedId=${m.id}&expectedVersion=${m.version}`
    const res = await app.request(`${space()}/memories?${query}`, {
      method: 'DELETE',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(204)
  }
  const list = async (path: string, cookie = ws.cookie) =>
    app.request(`${space()}${path}`, { headers: { cookie } })
  const expired = async (cookie = ws.cookie, query = '') =>
    ok<ExpiredMemoryList>(await list(`/memories/expired${query}`, cookie))
  const deleted = async (cookie = ws.cookie) =>
    ok<DeletedMemoryList>(await list('/memories/deleted', cookie))
  const history = async (id: string, cookie = ws.cookie) =>
    ok<MemoryHistory>(await list(`/memories/history?id=${id}`, cookie))
  const reactivate = (memoryId: string, expectedVersion: number, cookie = ws.cookie) =>
    app.request(
      `${space()}/memories/reactivate`,
      jsonRequest('POST', { memoryId, expectedVersion }, { cookie }),
    )
  const undelete = (memoryId: string, cookie = ws.cookie) =>
    app.request(`${space()}/memories/undelete`, jsonRequest('POST', { memoryId }, { cookie }))
  // 让一条记忆过期：把有效到改到一分钟之前（不经过接口，接口不收已经过去的时间）
  const expire = (id: string) =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 60_000) })
        .where(eq(memories.id, id)),
    )
  // 删掉的记忆之后又到期了：两分钟前删掉、一分钟前到期，删除时还有效。返回有效到
  const deletedThenExpired = async (id: string) => {
    const validTo = new Date(Date.now() - 60_000)
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ deletedAt: new Date(Date.now() - 120_000), validTo })
        .where(eq(memories.id, id)),
    )
    return validTo.toISOString()
  }
  const rowOf = async (id: string) =>
    (
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(memories).where(eq(memories.id, id)),
      )
    )[0]!
  const recallUris = async (query: string) =>
    (
      await ok<RecallResponse>(
        await app.request('/v1/recall', jsonRequest('POST', { query }, bearer(key))),
      )
    ).candidates.map((c) => c.uri)
  const bootUris = async () =>
    (await ok<BootResponse>(await app.request('/v1/boot', { headers: bearer(key) }))).entries.map(
      (e) => e.uri,
    )
  const sessionStart = async () =>
    JSON.stringify(
      await ok<LifecycleResponse>(
        await app.request(
          '/v1/lifecycle/event',
          jsonRequest('POST', { event: 'session.start', sessionId: 's' }, bearer(key)),
        ),
      ),
    )

  describe('设有效到', () => {
    it('Key 新建与修改时设有效到、改掉、清掉；不提它时不动，列表与历史里看得到', async () => {
      const until = new Date(Date.now() + 3 * DAY)
      // 带时区的写法，存下来是同一个时刻
      const local = new Date(until.getTime() + 8 * 3_600_000).toISOString().replace('Z', '+08:00')
      const m = await ok<MemoryView>(
        await keyCreate({ uri: 'trip://plan', content: '下周出差', validTo: local }),
        201,
      )
      expect(m.validTo).toBe(until.toISOString())

      const later = inDays(5)
      const moved = await ok<MemoryView>(await keyPatch({ uri: m.uri, validTo: later }))
      expect(moved.validTo).toBe(later)
      // 改别的字段时有效期不动
      const edited = await ok<MemoryView>(await keyPatch({ uri: m.uri, content: '下周三出差' }))
      expect(edited.validTo).toBe(later)
      const cleared = await ok<MemoryView>(await keyPatch({ uri: m.uri, validTo: null }))
      expect(cleared.validTo).toBeNull()
      // 一直有效时再改别的，也还是一直有效
      expect((await ok<MemoryView>(await keyPatch({ uri: m.uri, priority: 1 }))).validTo).toBeNull()

      // 管理界面新建时也能设，列表里带着它
      const soon = inDays(1)
      await ok<MemoryView>(
        await create({ uri: 'trip://visa', content: '签证', validTo: soon }),
        201,
      )
      const items = (await ok<MemoryList>(await list('/memories/list?sort=uri'))).items
      expect(items.map((i) => [i.uri, i.validTo])).toEqual([
        ['trip://plan', null],
        ['trip://visa', soon],
      ])

      const h = await history(m.id)
      expect(h.memory).toMatchObject({ validTo: null, released: false })
      expect(h.events.map((e) => [e.type, e.after?.validTo])).toEqual([
        ['create', until.toISOString()],
        ['update', later],
        ['update', later],
        ['update', null],
        ['update', null],
      ])
      const activity = await ok<ActivityList>(await list('/activity'))
      const changes = activity.items.filter((i) => i.memoryId === m.id).map((i) => i.changes)
      expect(changes).toEqual([['priority'], ['validTo'], ['content'], ['validTo'], []])
    })

    it('有效到要晚于现在：设在过去、正好现在、不带时区的都拒绝，原来的有效期不变', async () => {
      const past = new Date(Date.now() - 60_000).toISOString()
      expect(
        await errorOf(await keyCreate({ uri: 'a://b', content: 'x', validTo: past }), 400),
      ).toContain('晚于现在')
      expect(
        await errorOf(await create({ uri: 'a://b', content: 'x', validTo: past }), 400),
      ).toContain('晚于现在')
      // 不带时区的时间说不清是哪个时刻
      expect(
        (await keyCreate({ uri: 'a://b', content: 'x', validTo: '2030-01-01T00:00:00' })).status,
      ).toBe(400)
      expect((await keyGet('a://b')).status).toBe(404)

      const until = inDays(2)
      const m = await ok<MemoryView>(
        await keyCreate({ uri: 'a://b', content: 'x', validTo: until }),
        201,
      )
      expect(await errorOf(await keyPatch({ uri: m.uri, validTo: past }), 400)).toContain('删掉它')
      expect(
        (await keyPatch({ uri: m.uri, validTo: new Date().toISOString(), content: '新的' })).status,
      ).toBe(400)
      expect(await ok<MemoryView>(await keyGet(m.uri))).toMatchObject({
        validTo: until,
        content: 'x',
        version: 1,
      })
    })

    it('有效到一过就读不到了', async () => {
      // 留足写入与第一次读取的时间（机器忙时请求也可能慢），再等到有效到过了之后读
      const until = Date.now() + 2_500
      const m = await ok<MemoryView>(
        await keyCreate({
          uri: 'flash://note',
          content: '马上过期',
          validTo: new Date(until).toISOString(),
        }),
        201,
      )
      expect((await keyGet(m.uri)).status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, until + 300 - Date.now()))
      expect((await keyGet(m.uri)).status).toBe(404)
      expect((await expired()).items.map((i) => i.id)).toEqual([m.id])
    })
  })

  describe('到期之后', () => {
    it('按 URI 读不到、不在列表与树里、不召回、不进 boot 与会话开始，历史与已过期里看得到', async () => {
      const rule = await ok<MemoryView>(
        await keyCreate({
          uri: 'core://deadline',
          content: '截止日期之前每天提醒一次进度',
          layer: 'base',
          priority: 0,
          glossary: ['截止提醒'],
          validTo: inDays(1),
        }),
        201,
      )
      await ok<MemoryView>(
        await keyCreate({
          uri: 'core://agent',
          content: '先读正文再信任',
          layer: 'base',
          priority: 0,
        }),
        201,
      )
      expect(await bootUris()).toContain(rule.uri)
      expect(await recallUris('截止提醒的安排')).toContain(rule.uri)
      expect(await sessionStart()).toContain('每天提醒一次进度')

      await expire(rule.id)
      expect((await keyGet(rule.uri)).status).toBe(404)
      expect((await get(rule.uri)).status).toBe(404)
      expect((await ok<MemoryList>(await list('/memories/list'))).items.map((i) => i.uri)).toEqual([
        'core://agent',
      ])
      const children = (
        await ok<{ children: { uri: string }[] }>(await list('/memories/children?of=core'))
      ).children.map((c) => c.uri)
      expect(children).toEqual(['core://agent'])
      expect(await bootUris()).toEqual(['core://agent'])
      expect(await recallUris('截止提醒的安排')).not.toContain(rule.uri)
      const start = await sessionStart()
      expect(start).not.toContain('每天提醒一次进度')
      expect(start).not.toContain(rule.uri)

      // 历史照样看得到，活动里标出已经过期
      const h = await history(rule.id)
      expect(h.memory.validTo).not.toBeNull()
      expect(h.memory.released).toBe(false)
      expect(h.events.map((e) => e.type)).toEqual(['create'])
      const activity = await ok<ActivityList>(await list('/activity'))
      expect(activity.items.map((i) => [i.uri, i.expired])).toEqual([
        ['core://agent', false],
        ['core://deadline', true],
      ])
      expect((await expired()).items).toMatchObject([
        { id: rule.id, uri: rule.uri, expiredAt: h.memory.validTo, released: false },
      ])
      expect((await deleted()).items).toEqual([])
    })
  })

  describe('重新生效', () => {
    it('清掉有效期，回到读取、召回与 boot；记一条事件，重新排队生成向量；已经有效的不再重新生效', async () => {
      const m = await ok<MemoryView>(
        await keyCreate({
          uri: 'core://deadline',
          content: '每天提醒进度',
          layer: 'base',
          priority: 0,
          validTo: inDays(1),
        }),
        201,
      )
      await expire(m.id)
      queued.length = 0
      // 看过之后被改过（恢复到旧版本也能用在过期的记忆上）就不对了
      expect(await errorOf(await reactivate(m.id, m.version + 1), 409)).toContain('版本')

      const back = await ok<MemoryView>(await reactivate(m.id, m.version))
      expect(back).toMatchObject({ id: m.id, validTo: null, version: m.version + 1 })
      expect(await ok<MemoryView>(await keyGet(m.uri))).toMatchObject({ id: m.id, validTo: null })
      expect(await bootUris()).toContain(m.uri)
      expect(queued).toContain(m.id)
      expect((await expired()).items).toEqual([])

      const h = await history(m.id)
      expect(h.events.map((e) => e.type)).toEqual(['create', 'reactivate'])
      const event = h.events[1]!
      expect(event.before?.validTo).not.toBeNull()
      expect(event.after?.validTo).toBeNull()
      expect(event.actor.accountName).toBe('alice')
      expect(await errorOf(await reactivate(m.id, back.version), 409)).toContain('现在是有效的')
    })

    it('过期后让出了 URI 的：列在已过期里，撤销删除不行；URI 被新的占着时 409，那条删掉之后一并撤销删除', async () => {
      const old = await ok<MemoryView>(
        await keyCreate({ uri: 'notes://weekly', content: '第一周的安排', validTo: inDays(1) }),
        201,
      )
      await expire(old.id)
      // 同一个 URI 上写新的，过期的那条被让出（软删除，记一条 expire 事件）
      const fresh = await ok<MemoryView>(
        await keyCreate({ uri: 'notes://weekly', content: '第二周的安排' }),
        201,
      )
      const released = await rowOf(old.id)
      expect(released.deletedAt).not.toBeNull()
      expect((await history(old.id)).memory).toMatchObject({ released: true })
      expect((await expired()).items).toMatchObject([{ id: old.id, released: true }])
      expect((await deleted()).items).toEqual([])
      expect(await errorOf(await undelete(old.id), 409)).toContain('重新生效')

      const version = (await rowOf(old.id)).version
      expect(await errorOf(await reactivate(old.id, version), 409)).toContain('先把那条移走或删掉')
      expect((await rowOf(old.id)).deletedAt).not.toBeNull()

      await remove(fresh)
      const back = await ok<MemoryView>(await reactivate(old.id, version))
      expect(back).toMatchObject({ id: old.id, content: '第一周的安排', validTo: null })
      expect(await ok<MemoryView>(await keyGet('notes://weekly'))).toMatchObject({ id: old.id })
      expect((await rowOf(old.id)).deletedAt).toBeNull()
      expect((await history(old.id)).events.map((e) => e.type)).toEqual([
        'create',
        'expire',
        'reactivate',
      ])
      expect((await expired()).items).toEqual([])
      // 新的那条现在是用户删掉的，在已删除里；撤销删除会撞上重新生效的这条
      expect((await deleted()).items.map((i) => i.id)).toEqual([fresh.id])
    })

    it('重新生效时，同一个 URI 上挡着它的别的过期记录先让出', async () => {
      const first = await ok<MemoryView>(
        await keyCreate({ uri: 'notes://w', content: '一', validTo: inDays(1) }),
        201,
      )
      await expire(first.id)
      const second = await ok<MemoryView>(
        await keyCreate({ uri: 'notes://w', content: '二', validTo: inDays(1) }),
        201,
      )
      await expire(second.id)
      // 两条都过期了：第一条被第二条让出，第二条还占着唯一索引
      const back = await ok<MemoryView>(await reactivate(first.id, (await rowOf(first.id)).version))
      expect(back.content).toBe('一')
      expect((await rowOf(second.id)).deletedAt).not.toBeNull()
      expect((await history(second.id)).events.map((e) => e.type)).toEqual(['create', 'expire'])
      expect((await expired()).items).toMatchObject([{ id: second.id, released: true }])
      expect(queued).toContain(second.id)
    })

    it('删掉之后才过期的：列在已删除里，撤销删除不动有效期，回到已过期里，再重新生效', async () => {
      const m = await ok<MemoryView>(
        await keyCreate({ uri: 'notes://gone', content: '删掉的', validTo: inDays(1) }),
        201,
      )
      await remove(m)
      const validTo = await deletedThenExpired(m.id)
      expect((await history(m.id)).memory.released).toBe(false)
      // 撤销删除和过期互不相干：它在已删除里，标着已经过去的有效到；不在已过期里，也不走重新生效
      expect((await deleted()).items).toMatchObject([{ id: m.id, validTo }])
      expect((await expired()).items).toEqual([])
      expect(await errorOf(await reactivate(m.id, (await rowOf(m.id)).version), 409)).toContain(
        '撤销删除',
      )

      const undone = await ok<MemoryView>(await undelete(m.id))
      expect(undone).toMatchObject({ id: m.id, validTo })
      expect((await rowOf(m.id)).deletedAt).toBeNull()
      // 撤销之后它回到过期的状态：按 URI 读不到，在已过期里
      expect((await keyGet(m.uri)).status).toBe(404)
      expect((await deleted()).items).toEqual([])
      expect((await expired()).items).toMatchObject([{ id: m.id, released: false }])

      const back = await ok<MemoryView>(await reactivate(m.id, undone.version))
      expect(back).toMatchObject({ id: m.id, validTo: null })
      expect((await keyGet(m.uri)).status).toBe(200)
      expect((await history(m.id)).events.map((e) => e.type)).toEqual([
        'create',
        'delete',
        'undelete',
        'reactivate',
      ])
    })

    it('撤销删除时同一归属的新记录占着 URI 返回 409，撤销的这条已经过期也一样', async () => {
      const m = await ok<MemoryView>(
        await keyCreate({ uri: 'notes://slot', content: '原来的', validTo: inDays(1) }),
        201,
      )
      await remove(m)
      await deletedThenExpired(m.id)
      await ok<MemoryView>(await keyCreate({ uri: 'notes://slot', content: '新的' }), 201)
      expect(await errorOf(await undelete(m.id), 409)).toContain('先把那条移走或删掉')
      expect((await rowOf(m.id)).deletedAt).not.toBeNull()
    })

    it('共享的过期记忆和成员的私人节点并存时，重新生效返回 409；直接改库清掉有效期也被触发器拦下', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      // editor 写不了 secret，让不出这条过期的共享记忆，只能和它并存
      const shared = await ok<MemoryView>(
        await create({
          uri: 'kb://wifi',
          content: '旧密码',
          layer: 'base',
          sensitivity: 'secret',
          validTo: inDays(1),
        }),
        201,
      )
      await expire(shared.id)
      await ok<MemoryView>(
        await create({ uri: 'kb://wifi', content: 'eve 的笔记' }, editor.cookie),
        201,
      )
      expect((await rowOf(shared.id)).deletedAt).toBeNull()

      expect(await errorOf(await reactivate(shared.id, shared.version), 409)).toContain(
        '另一条记忆占用',
      )
      expect((await rowOf(shared.id)).validTo).not.toBeNull()

      // 绕开服务层只改有效期：触发器在有效期变化时也检查
      const direct = withSpace(database.db, ws.spaceId, (tx) =>
        tx.update(memories).set({ validTo: null }).where(eq(memories.id, shared.id)),
      )
      await expect(direct).rejects.toSatisfy((err: unknown) =>
        isUniqueViolation(err, 'memories_uri_live_idx'),
      )
    })

    it('读不到的 404、写不了的 403；editor 的已过期列表里没有别人的私人层与 secret；Key 没有这个接口', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      const viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
      const mine = await ok<MemoryView>(
        await create({ uri: 'home://plan', content: '私事', validTo: inDays(1) }),
        201,
      )
      const secret = await ok<MemoryView>(
        await create({
          uri: 'kb://token',
          content: 'x',
          layer: 'base',
          sensitivity: 'secret',
          validTo: inDays(1),
        }),
        201,
      )
      const shared = await ok<MemoryView>(
        await create({ uri: 'kb://faq', content: '常见问题', layer: 'base', validTo: inDays(1) }),
        201,
      )
      // 应用主人是 alice：editor 读得到这个应用的应用层，写不了
      const appLayer = await ok<MemoryView>(
        await create({ uri: 'app://agent/rules', content: '提交规范', validTo: inDays(1) }),
        201,
      )
      for (const m of [mine, secret, shared, appLayer]) await expire(m.id)

      expect((await expired(editor.cookie)).items.map((i) => i.uri).sort()).toEqual([
        'app://agent/rules',
        'kb://faq',
      ])
      expect((await reactivate(mine.id, mine.version, editor.cookie)).status).toBe(404)
      expect((await reactivate(secret.id, secret.version, editor.cookie)).status).toBe(404)
      expect((await reactivate(appLayer.id, appLayer.version, editor.cookie)).status).toBe(403)
      expect((await reactivate(shared.id, shared.version, viewer.cookie)).status).toBe(403)
      expect((await reactivate('00000000-0000-4000-8000-000000000000', 1)).status).toBe(404)
      const viaKey = await app.request(
        '/v1/memories/reactivate',
        jsonRequest('POST', { memoryId: shared.id, expectedVersion: 1 }, bearer(key)),
      )
      expect(viaKey.status).toBe(404)
      for (const m of [mine, secret, shared, appLayer]) {
        expect((await rowOf(m.id)).validTo).not.toBeNull()
      }
      // editor 写得了共享的基础层
      expect((await reactivate(shared.id, shared.version, editor.cookie)).status).toBe(200)
    })

    it('已过期列表最近过期的在前，能翻页', async () => {
      const ids: string[] = []
      for (const [i, name] of ['a', 'b', 'c'].entries()) {
        const m = await ok<MemoryView>(
          await keyCreate({ uri: `notes://${name}`, content: name, validTo: inDays(1) }),
          201,
        )
        await withSpace(database.db, ws.spaceId, (tx) =>
          tx
            .update(memories)
            .set({ validTo: new Date(Date.now() - (3 - i) * 60_000) })
            .where(eq(memories.id, m.id)),
        )
        ids.push(m.id)
      }
      const first = await expired(ws.cookie, '?limit=2')
      const second = await expired(ws.cookie, `?limit=2&cursor=${first.nextCursor}`)
      expect([...first.items, ...second.items].map((i) => i.uri)).toEqual([
        'notes://c',
        'notes://b',
        'notes://a',
      ])
      expect(second.nextCursor).toBeNull()
      expect((await list('/memories/expired?cursor=abc')).status).toBe(400)
    })
  })

  describe('被推翻的事实', () => {
    let botKey: string
    const group = {
      chatType: 'group',
      platform: 'qq',
      group: { id: '2001', name: '读书会' },
      sender: { id: '1001', name: '小明' },
    }
    const say = async (user: string) => {
      const res = await app.request(
        '/v1/lifecycle/event',
        jsonRequest(
          'POST',
          { event: 'turn.end', sessionId: 's', context: group, user, reply: '嗯' },
          bearer(botKey),
        ),
      )
      expect(res.status).toBe(200)
    }
    const extract = async (reply: unknown) => {
      const [turn] = await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(conversationTurns).orderBy(asc(conversationTurns.id)).limit(1),
      )
      await processSession(
        database.db,
        masterKey,
        { spaceId: ws.spaceId, appId: turn!.appId, scope: turn!.scope },
        () => fakeModel(reply),
      )
    }
    const subjectOf = async (kind: 'person' | 'group', externalId: string) =>
      (
        await withSpace(database.db, ws.spaceId, (tx) =>
          tx
            .select()
            .from(subjectIdentities)
            .where(
              and(eq(subjectIdentities.kind, kind), eq(subjectIdentities.externalId, externalId)),
            ),
        )
      )[0]!.subjectId
    const subjectId = () => subjectOf('person', '1001')
    const detail = async (id: string) => ok<SubjectDetail>(await list(`/subjects/${id}`))
    const reactivateFact = (subject: string, fact: string, version: number, cookie = ws.cookie) =>
      app.request(
        `${space()}/subjects/${subject}/facts/${fact}/reactivate`,
        jsonRequest('POST', { version }, { cookie }),
      )
    const recalled = async () =>
      (
        await ok<RecallResponse>(
          await app.request(
            '/v1/recall',
            jsonRequest('POST', { query: '你好', context: group }, bearer(botKey)),
          ),
        )
      ).subjects.flatMap((s) => s.facts.map((f) => f.content))

    beforeEach(async () => {
      botKey = await ws.issueKey((await ws.createApp('qq-bot', { runtimeFamily: 'astrbot' })).id)
      await saveExtractionConfig(database.db, masterKey, {
        baseUrl: 'https://llm.example.com/v1',
        model: 'm',
      })
      await say('我在学日语')
      await extract({ facts: [{ subject: 'M1', op: 'add', content: '在学日语' }] })
      await say('我改学韩语了')
      await extract({
        facts: [{ subject: 'M1', op: 'update', replaces: 'F1', content: '在学韩语' }],
      })
    })

    it('列在对象页上，带着推翻它的那条；重新生效之后两条都有效，记一条事件', async () => {
      const id = await subjectId()
      const before = await detail(id)
      expect(before.facts.map((f) => f.content)).toEqual(['在学韩语'])
      expect(before.supersededFacts).toMatchObject([
        { content: '在学日语', supersededBy: '在学韩语' },
      ])
      const old = before.supersededFacts[0]!
      expect(await errorOf(await reactivateFact(id, old.id, old.version + 1), 409)).toContain(
        '改过',
      )

      expect((await reactivateFact(id, old.id, old.version)).status).toBe(204)
      const after = await detail(id)
      expect(after.facts.map((f) => f.content).sort()).toEqual(['在学日语', '在学韩语'])
      expect(after.supersededFacts).toEqual([])
      expect((await recalled()).sort()).toEqual(['在学日语', '在学韩语'])
      const events = await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .select()
          .from(memoryEvents)
          .where(eq(memoryEvents.memoryId, old.id))
          .orderBy(asc(memoryEvents.id)),
      )
      expect(events.map((e) => e.eventType)).toEqual(['create', 'update', 'reactivate'])
      expect((events[2]!.after as { validTo: unknown }).validTo).toBeNull()
      expect(await errorOf(await reactivateFact(id, old.id, old.version + 1), 409)).toContain(
        '现在是有效的',
      )
    })

    it('抽取的记忆不走记忆的重新生效：被推翻的事实与到期的会话摘要都返回 409，原样不动', async () => {
      const id = await subjectId()
      const old = (await detail(id)).supersededFacts[0]!
      expect(await errorOf(await reactivate(old.id, old.version), 409)).toContain('对象页')
      expect((await rowOf(old.id)).validTo).not.toBeNull()
      // 会话摘要按设计到期，不能借这里变成一直有效
      const [summary] = await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .insert(memories)
          .values({
            spaceId: ws.spaceId,
            form: 'extracted',
            layer: 'episode',
            sensitivity: 'public',
            provenance: 'untrusted',
            originScope: 'global',
            content: '昨天聊了读书会的安排',
            expiresAt: new Date(Date.now() - 60_000),
          })
          .returning(),
      )
      expect(await errorOf(await reactivate(summary!.id, summary!.version), 409)).toContain(
        '会话摘要',
      )
      expect((await rowOf(summary!.id)).expiresAt).not.toBeNull()
    })

    it('viewer 不能重新生效；别的对象上的、不存在的 404；推翻它的那条删掉之后不再给出', async () => {
      const id = await subjectId()
      const viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
      const { supersededFacts, facts } = await detail(id)
      const old = supersededFacts[0]!
      expect((await reactivateFact(id, old.id, old.version, viewer.cookie)).status).toBe(403)
      // 群这个对象上没有这条事实
      expect(
        (await reactivateFact(await subjectOf('group', '2001'), old.id, old.version)).status,
      ).toBe(404)
      expect((await reactivateFact(id, '00000000-0000-4000-8000-000000000000', 1)).status).toBe(404)

      const removed = await app.request(
        `${space()}/subjects/${id}/facts/${facts[0]!.id}?version=${facts[0]!.version}`,
        { method: 'DELETE', headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' } },
      )
      expect(removed.status).toBe(204)
      expect((await detail(id)).supersededFacts).toMatchObject([{ id: old.id, supersededBy: null }])
      expect((await rowOf(old.id)).validTo).not.toBeNull()
    })
  })
})
