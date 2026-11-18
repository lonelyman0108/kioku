import { randomBytes } from 'node:crypto'

import type {
  ActivityList,
  ConsoleEntryView,
  DeletedEntryList,
  EntryHistory,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { canRead, consoleAccess, type Access } from '../../access/access'
import { createApp } from '../../app'
import { withCircle, type Database } from '../../db/client'
import { entries, entryEvents, entryGlossary, entryVariants } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { snapshotFacts } from '../../memory/filter'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('管理界面的历史、撤销删除与恢复', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  // 记下排队生成向量的词条，用来确认撤销删除之后会重新生成
  const queued: string[] = []

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: {
        enqueueEmbed: (_circleId, entryId) => void queued.push(entryId),
        enqueueBackfill: async () => true,
        enqueueSwitch: async () => true,
        enqueuePrune: async () => true,
        enqueueBackup: async () => null,
        backupRun: async () => null,
        enqueueExtraction: async () => {},
        enqueueCleanup: async () => true,
        enqueueDream: async () => null,
        dreamRun: async () => null,
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

  const circle = () => `/v1/circles/${ws.circleId}`
  const ok = async <T>(res: Response, status = 200) => {
    expect(res.status, await res.clone().text()).toBe(status)
    return (await res.json()) as T
  }
  const create = async (cookie: string, body: Record<string, unknown>) =>
    ok<ConsoleEntryView>(
      await app.request(`${circle()}/entries`, jsonRequest('POST', body, { cookie })),
      201,
    )
  const patch = async (cookie: string, body: Record<string, unknown>) =>
    ok<ConsoleEntryView>(
      await app.request(`${circle()}/entries`, jsonRequest('PATCH', body, { cookie })),
    )
  const reveal = async (cookie: string, entryId: string) =>
    ok<ConsoleEntryView>(
      await app.request(`${circle()}/entries/reveal`, jsonRequest('POST', { entryId }, { cookie })),
    )
  const remove = async (cookie: string, m: ConsoleEntryView) => {
    const query = `id=${encodeURIComponent(m.shortId)}&expectedVersion=${m.version}`
    const res = await app.request(`${circle()}/entries?${query}`, {
      method: 'DELETE',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(204)
  }
  const historyRes = (cookie: string, id: string) =>
    app.request(`${circle()}/entries/history?id=${id}`, { headers: { cookie } })
  const history = async (cookie: string, id: string) =>
    ok<EntryHistory>(await historyRes(cookie, id))
  const deleted = async (cookie: string, query = '') =>
    ok<DeletedEntryList>(
      await app.request(`${circle()}/entries/deleted${query ? `?${query}` : ''}`, {
        headers: { cookie },
      }),
    )
  const activity = async (cookie: string, query = '') =>
    ok<ActivityList>(
      await app.request(`${circle()}/activity${query ? `?${query}` : ''}`, {
        headers: { cookie },
      }),
    )
  const restoreRes = (cookie: string, body: Record<string, unknown>) =>
    app.request(`${circle()}/entries/restore`, jsonRequest('POST', body, { cookie }))
  const undeleteRes = (cookie: string, entryId: string) =>
    app.request(`${circle()}/entries/undelete`, jsonRequest('POST', { entryId }, { cookie }))

  // 照着服务写事件时的样子，构造一条完整的存储快照
  async function snapshotOf(id: string, overrides: Record<string, unknown> = {}) {
    const [row] = await withCircle(database.db, ws.circleId, (tx) =>
      tx.select().from(entries).where(eq(entries.id, id)),
    )
    const [variants, glossary] = await withCircle(database.db, ws.circleId, async (tx) => [
      await tx.select().from(entryVariants).where(eq(entryVariants.entryId, id)),
      await tx
        .select({ keyword: entryGlossary.keyword })
        .from(entryGlossary)
        .where(eq(entryGlossary.entryId, id)),
    ])
    const r = row!
    const snap: Record<string, unknown> = {
      shortId: r.shortId,
      title: r.title,
      kind: r.kind,
      sensitivity: r.sensitivity,
      priority: r.priority,
      disclosure: r.disclosure,
      topics: r.topics,
      realms: r.realms,
      glossary: glossary.map((g) => g.keyword),
      variants: variants.map((v) => ({ when: v.when, content: v.content })),
      version: r.version,
      deleted: r.deletedAt !== null,
      validTo: r.validTo ? r.validTo.toISOString() : null,
      circleId: r.circleId,
      originScope: r.originScope,
      clientId: r.clientId,
      ownerAccountId: r.ownerAccountId,
      subjectKind: r.subjectKind,
      deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    }
    return JSON.parse(JSON.stringify({ ...snap, ...overrides })) as Record<string, unknown>
  }

  async function insertEvent(entryId: string, shortId: string, before: unknown, after: unknown) {
    const [event] = await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .insert(entryEvents)
        .values({
          circleId: ws.circleId,
          entryId,
          shortId,
          eventType: 'update',
          provenance: 'owner',
          before,
          after,
        })
        .returning(),
    )
    return event!.id
  }

  it('历史从近到远列出新建、修改，带操作者', async () => {
    const m = await create(ws.cookie, { title: '笔记', content: '第一版' })
    await patch(ws.cookie, { id: m.shortId, content: '第二版' })
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const viaKey = await app.request(
      '/v1/entries',
      jsonRequest('PATCH', { id: m.shortId, content: '第三版' }, bearer(key)),
    )
    expect(viaKey.status).toBe(200)

    const h = await history(ws.cookie, m.id)
    expect(h.entry).toMatchObject({ id: m.id, shortId: m.shortId, version: 3, deletedAt: null })
    expect(h.events.map((e) => e.type)).toEqual(['update', 'update', 'create'])
    const createdEvent = h.events[2]!
    expect(createdEvent.before).toBeNull()
    expect(createdEvent.after).toMatchObject({
      shortId: m.shortId,
      version: 1,
    })
    expect(createdEvent.after!.variants[0]!.content).toBe('第一版')
    expect(createdEvent.actor).toEqual({ accountName: 'alice', keyName: null, clientName: null })
    expect(h.events[0]!.actor).toEqual({ accountName: null, keyName: 'test', clientName: 'agent' })
  })

  it('事件太多时历史保留最近的 500 个，按时间倒序，并标出截断', async () => {
    const m = await create(ws.cookie, { title: 'busy', content: '常改的' })
    const snap = await snapshotOf(m.id)
    await withCircle(database.db, ws.circleId, (tx) =>
      tx.insert(entryEvents).values(
        Array.from({ length: 505 }, () => ({
          circleId: ws.circleId,
          entryId: m.id,
          shortId: m.shortId,
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
    // 最早的新建事件被截掉，留下的是最近的，从近到远
    expect(h.events.map((e) => e.type)).not.toContain('create')
    const ids = h.events.map((e) => e.id)
    expect(ids).toEqual([...ids].sort((a, b) => b - a))

    const calm = await create(ws.cookie, { title: 'calm', content: '少改的' })
    expect((await history(ws.cookie, calm.id)).truncated).toBe(false)
  })

  it('secret 的历史只给 owner 看得到，快照里没有正文', async () => {
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const wifi = await create(ws.cookie, {
      title: 'wifi',
      content: 'hunter2',
      sensitivity: 'secret',
    })
    const h = await history(ws.cookie, wifi.id)
    expect(h.events.map((e) => e.after?.variants[0]?.content)).toEqual([null])
    expect((await historyRes(editor.cookie, wifi.id)).status).toBe(404)
    expect(
      (
        await restoreRes(editor.cookie, {
          entryId: wifi.id,
          eventId: h.events[0]!.id,
          expectedVersion: 1,
        })
      ).status,
    ).toBe(404)
  })

  it('历史中某版快照变为不可读时，editor 看到离开标记且 after 被隐藏', async () => {
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const faq = await create(ws.cookie, { title: 'faq', content: '常见问题' })
    const secretAfter = await snapshotOf(faq.id, {
      sensitivity: 'secret',
      variants: [{ when: {}, content: null }],
    })
    const hiddenId = await insertEvent(faq.id, faq.shortId, await snapshotOf(faq.id), secretAfter)

    const editorEvent = (await history(editor.cookie, faq.id)).events.find(
      (e) => e.id === hiddenId,
    )!
    expect(editorEvent.left).toBe(true)
    expect(editorEvent.after).toBeNull()
    const ownerEvent = (await history(ws.cookie, faq.id)).events.find((e) => e.id === hiddenId)!
    expect(ownerEvent.left).toBe(false)
    expect(ownerEvent.after).not.toBeNull()

    // 改前不可读、改后可读的事件对 editor 整条不可见，也不能恢复；只有接入实例主人或 owner 看得见 keyName
    const secretBefore = await snapshotOf(faq.id, {
      sensitivity: 'secret',
      variants: [{ when: {}, content: null }],
    })
    const unreadableBeforeId = await insertEvent(
      faq.id,
      faq.shortId,
      secretBefore,
      await snapshotOf(faq.id),
    )
    expect((await history(editor.cookie, faq.id)).events.map((e) => e.id)).not.toContain(
      unreadableBeforeId,
    )
    expect((await activity(editor.cookie)).items.map((i) => i.id)).not.toContain(unreadableBeforeId)
    expect(
      (
        await restoreRes(editor.cookie, {
          entryId: faq.id,
          eventId: unreadableBeforeId,
          expectedVersion: faq.version,
        })
      ).status,
    ).toBe(404)

    const ownerKey = await ws.issueKey((await ws.createClient('owner-bot')).id)
    const viaKey = await ok<ConsoleEntryView>(
      await app.request(
        '/v1/entries',
        jsonRequest('POST', { title: 'by-key', content: 'x' }, bearer(ownerKey)),
      ),
      201,
    )
    expect((await history(ws.cookie, viaKey.id)).events[0]!.actor).toEqual({
      accountName: null,
      keyName: 'test',
      clientName: 'owner-bot',
    })
    expect((await history(editor.cookie, viaKey.id)).events[0]!.actor).toEqual({
      accountName: null,
      keyName: null,
      clientName: 'owner-bot',
    })
  })

  it('过期的词条照样能看历史和恢复', async () => {
    const m = await create(ws.cookie, { title: 'old', content: '第一版' })
    const edited = await patch(ws.cookie, { id: m.shortId, content: '第二版' })
    await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .update(entries)
        .set({ validTo: new Date(Date.now() - 60_000) })
        .where(eq(entries.id, m.id)),
    )
    expect(
      (await app.request(`${circle()}/entries?id=${m.shortId}`, { headers: { cookie: ws.cookie } }))
        .status,
    ).toBe(404)
    const h = await history(ws.cookie, m.id)
    expect(h.events.map((e) => e.type)).toEqual(['update', 'create'])
    const firstCreate = h.events.find((e) => e.type === 'create')!
    const restored = await ok<ConsoleEntryView>(
      await restoreRes(ws.cookie, {
        entryId: m.id,
        eventId: firstCreate.id,
        expectedVersion: edited.version,
      }),
    )
    expect(restored.variants[0]!.content).toBe('第一版')
  })

  it('恢复到某一版：还原变体正文、disclosure、priority 与关键词；版本对不上返回 409', async () => {
    const m = await create(ws.cookie, {
      title: '恢复验证',
      content: '第一版',
      disclosure: '最初',
      priority: 3,
      glossary: ['甲乙'],
    })
    const edited = await patch(ws.cookie, {
      id: m.shortId,
      content: '第二版',
      disclosure: '后来',
      priority: 1,
      glossaryAdd: ['丙丁'],
      glossaryRemove: ['甲乙'],
    })
    const first = (await history(ws.cookie, m.id)).events.find((e) => e.type === 'create')!
    const restored = await ok<ConsoleEntryView>(
      await restoreRes(ws.cookie, {
        entryId: m.id,
        eventId: first.id,
        expectedVersion: edited.version,
      }),
    )
    expect(restored).toMatchObject({
      disclosure: '最初',
      priority: 3,
      glossary: ['甲乙'],
      version: edited.version + 1,
    })
    expect(restored.variants[0]!.content).toBe('第一版')

    expect(
      (
        await restoreRes(ws.cookie, {
          entryId: m.id,
          eventId: first.id,
          expectedVersion: edited.version,
        })
      ).status,
    ).toBe(409)
    expect((await history(ws.cookie, m.id)).events.map((e) => e.type)).toEqual([
      'restore',
      'update',
      'create',
    ])

    // 别的词条的事件不能拿来恢复这一条
    const other = await create(ws.cookie, { title: 'other', content: '别的' })
    const otherEvent = (await history(ws.cookie, other.id)).events[0]!
    expect(
      (
        await restoreRes(ws.cookie, {
          entryId: m.id,
          eventId: otherEvent.id,
          expectedVersion: restored.version,
        })
      ).status,
    ).toBe(404)
  })

  it('机密词条或缺少明文正文的快照不支持回滚恢复，返回 400', async () => {
    const m = await create(ws.cookie, { title: 's', content: '明文', disclosure: '一' })
    const secret = await patch(ws.cookie, {
      id: m.shortId,
      disclosure: '二',
      sensitivity: 'secret',
    })
    const h = await history(ws.cookie, m.id)
    expect(
      (
        await restoreRes(ws.cookie, {
          entryId: m.id,
          eventId: h.events.find((e) => e.type === 'create')!.id,
          expectedVersion: secret.version,
        })
      ).status,
    ).toBe(400)
  })

  it('撤销删除：原样恢复（secret 的正文也在），版本加一，重新生成向量', async () => {
    const m = await create(ws.cookie, {
      title: 'wifi',
      content: 'hunter2',
      sensitivity: 'secret',
    })
    await remove(ws.cookie, m)
    expect((await deleted(ws.cookie)).items.map((i) => i.shortId)).toEqual([m.shortId])
    queued.length = 0

    const back = await ok<ConsoleEntryView>(await undeleteRes(ws.cookie, m.id))
    expect(back).toMatchObject({ id: m.id, contentHidden: true, version: 3 })
    expect(back.variants[0]!.content).toBeNull()
    expect((await reveal(ws.cookie, m.id)).variants[0]!.content).toBe('hunter2')
    expect(queued).toContain(m.id)
    expect((await deleted(ws.cookie)).items).toEqual([])
    expect((await history(ws.cookie, m.id)).events.map((e) => e.type)).toEqual([
      'access',
      'undelete',
      'delete',
      'create',
    ])
    expect((await undeleteRes(ws.cookie, m.id)).status).toBe(409)
  })

  it('已删除的列表只列成员读得到的，最近删除的在前，能翻页', async () => {
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const created: ConsoleEntryView[] = []
    for (const name of ['one', 'two', 'three']) {
      const e = await create(ws.cookie, { title: name, content: name })
      await remove(ws.cookie, e)
      created.push(e)
    }
    const sec = await create(ws.cookie, { title: 's', content: 's', sensitivity: 'secret' })
    await remove(ws.cookie, sec)

    const all = (await deleted(ws.cookie, 'limit=200')).items.map((i) => i.shortId)
    expect(all).toEqual([
      sec.shortId,
      created[2]!.shortId,
      created[1]!.shortId,
      created[0]!.shortId,
    ])
    const first = await deleted(ws.cookie, 'limit=3')
    const second = await deleted(ws.cookie, `limit=3&cursor=${first.nextCursor}`)
    expect([...first.items, ...second.items].map((i) => i.shortId)).toEqual(all)
    expect(second.nextCursor).toBeNull()
    expect((await deleted(editor.cookie)).items.map((i) => i.shortId)).toEqual([
      created[2]!.shortId,
      created[1]!.shortId,
      created[0]!.shortId,
    ])
    expect((await undeleteRes(editor.cookie, sec.id)).status).toBe(404)
  })

  it('viewer 看得到历史，但不能撤销删除，也不能恢复', async () => {
    const viewer = await addMember(database.db, ws.circleId, 'vic', 'viewer')
    const m = await create(ws.cookie, { title: 'faq', content: '第一版' })
    const edited = await patch(ws.cookie, { id: m.shortId, content: '第二版' })
    const first = (await history(viewer.cookie, m.id)).events.find((e) => e.type === 'create')!
    expect(
      (
        await restoreRes(viewer.cookie, {
          entryId: m.id,
          eventId: first.id,
          expectedVersion: edited.version,
        })
      ).status,
    ).toBe(403)
    await remove(ws.cookie, edited)
    expect((await undeleteRes(viewer.cookie, m.id)).status).toBe(403)
  })

  it('活动条目标出词条现在是否已删除，撤销删除之后恢复', async () => {
    const m = await create(ws.cookie, { title: 'gone', content: '一' })
    const edited = await patch(ws.cookie, { id: m.shortId, content: '二' })
    await remove(ws.cookie, edited)
    const flags = async () =>
      (await activity(ws.cookie)).items.filter((i) => i.entryId === m.id).map((i) => i.deleted)
    expect(await flags()).toEqual([true, true, true])
    await ok<ConsoleEntryView>(await undeleteRes(ws.cookie, m.id))
    expect(await flags()).toEqual([false, false, false, false])
  })

  it('活动流：最新的在前，带短 ID 与改了哪些字段，能翻页', async () => {
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const x = await create(ws.cookie, { title: 'x', content: '一' })
    await patch(ws.cookie, { id: x.shortId, content: '二', priority: 1 })
    const y = await create(editor.cookie, { title: 'y', content: 'E 的' })

    const page = await activity(ws.cookie, 'limit=1')
    expect(page.items[0]).toMatchObject({ type: 'create', shortId: y.shortId, changes: [] })
    const page2 = await activity(ws.cookie, `limit=1&cursor=${page.nextCursor}`)
    expect(page2.items[0]).toMatchObject({
      type: 'update',
      shortId: x.shortId,
      changes: ['priority', 'content'],
    })
    const page3 = await activity(ws.cookie, `limit=1&cursor=${page2.nextCursor}`)
    expect(page3.items[0]).toMatchObject({ type: 'create', shortId: x.shortId, changes: [] })
    expect(page3.nextCursor).toBeNull()

    expect(
      (await app.request(`${circle()}/activity?cursor=abc`, { headers: { cookie: ws.cookie } }))
        .status,
    ).toBe(400)
  })

  it('活动里每个事件看不看得到、是不是离开，和按 canRead 逐条算出来的一致', async () => {
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const shared = await create(ws.cookie, { title: 'shared', content: '共享' })
    const secret = await create(ws.cookie, {
      title: 'secret',
      content: '机密',
      sensitivity: 'secret',
    })

    const variants: (Record<string, unknown> | null)[] = [
      null,
      { sensitivity: 'internal' },
      { sensitivity: 'secret', variants: [{ when: {}, content: null }] },
    ]
    for (const m of [shared, secret]) {
      for (const before of variants) {
        for (const after of variants) {
          if (!before && !after) continue
          await insertEvent(
            m.id,
            m.shortId,
            before && (await snapshotOf(m.id, before)),
            after && (await snapshotOf(m.id, after)),
          )
        }
      }
    }
    const { rows, events } = await withCircle(database.db, ws.circleId, async (tx) => ({
      rows: await tx.select().from(entries),
      events: await tx.select().from(entryEvents),
    }))
    const rowById = new Map(rows.map((r) => [r.id, r]))
    const management = { management: true } as const
    const expected = (access: Access) =>
      events
        .flatMap((e) => {
          const shown = (snapshot: unknown) => {
            const facts = snapshot ? snapshotFacts(snapshot as Record<string, unknown>) : null
            return facts !== null && canRead(access, facts, management)
          }
          const left = shown(e.before) && e.after !== null && !shown(e.after)
          const row = rowById.get(e.entryId!)!
          const curFacts = {
            circleId: row.circleId,
            kind: row.kind,
            sensitivity: row.sensitivity,
            originScope: row.originScope,
            clientId: row.clientId,
            ownerAccountId: row.ownerAccountId,
            subjectKind: row.subjectKind,
            realms: row.realms,
            validTo: row.validTo,
            expiresAt: row.expiresAt,
            deletedAt: row.deletedAt,
          }
          const visible =
            (canRead(access, curFacts, management) &&
              (e.before === null || shown(e.before)) &&
              (e.after === null || shown(e.after))) ||
            left
          return visible ? [[e.id, left] as const] : []
        })
        .sort((a, b) => a[0] - b[0])
    const byId = (list: { id: number; left: boolean }[]) =>
      list.map((i) => [i.id, i.left] as const).sort((a, b) => a[0] - b[0])

    for (const [cookie, access] of [
      [ws.cookie, consoleAccess(ws.circleId, 'shared', 'owner', ws.accountId)],
      [editor.cookie, consoleAccess(ws.circleId, 'shared', 'editor', editor.accountId)],
    ] as const) {
      const want = expected(access)
      if (cookie === editor.cookie) {
        expect(want.some(([, left]) => left)).toBe(true)
        expect(want.length).toBeLessThan(events.length)
      }
      expect(byId((await activity(cookie, 'limit=200')).items)).toEqual(want)
    }
  })
})
