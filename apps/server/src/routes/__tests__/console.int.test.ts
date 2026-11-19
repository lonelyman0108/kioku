import { randomBytes } from 'node:crypto'

import type { ConsoleEntryView, EntryBrowseResponse } from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database } from '../../db/client'
import { entryEvents } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('管理界面的词条接口', () => {
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

  const base = (circleId = ws.circleId) => `/v1/circles/${circleId}/entries`
  const consoleGet = (cookie: string, id: string, circleId = ws.circleId) =>
    app.request(`${base(circleId)}?id=${encodeURIComponent(id)}`, { headers: { cookie } })
  const consoleCreate = (cookie: string, body: Record<string, unknown>, circleId = ws.circleId) =>
    app.request(base(circleId), jsonRequest('POST', body, { cookie }))

  it('能看到不同接入实例写入本记忆圈的词条，也能分组浏览', async () => {
    const c1 = await ws.createClient('bot-a')
    const c2 = await ws.createClient('bot-b')
    const k1 = await ws.issueKey(c1.id)
    const k2 = await ws.issueKey(c2.id)
    const viaKey = async (key: string, body: Record<string, unknown>) => {
      const res = await app.request('/v1/entries', jsonRequest('POST', body, bearer(key)))
      expect(res.status).toBe(201)
      return (await res.json()) as { shortId: string }
    }
    const a = await viaKey(k1, { title: 'A 的规则', content: 'A 的规则', topics: ['ops'] })
    const b = await viaKey(k2, { title: 'B 的规则', content: 'B 的规则', topics: ['ops'] })

    for (const id of [a.shortId, b.shortId]) {
      expect((await consoleGet(ws.cookie, id)).status).toBe(200)
    }
    const browsed = (await (
      await app.request(`${base()}/browse?groupBy=topic`, { headers: { cookie: ws.cookie } })
    ).json()) as EntryBrowseResponse
    const opsGroup = browsed.groups.find((g) => g.key === 'ops')!
    expect(opsGroup.items.map((item) => item.shortId).sort()).toEqual([a.shortId, b.shortId].sort())
  })

  it('个人圈成员各自隔离，读不到别人的个人圈词条', async () => {
    const b = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const created = await consoleCreate(
      b.cookie,
      { title: 'B 的日记', content: 'B 的日记' },
      b.personalCircleId,
    )
    expect(created.status).toBe(201)
    const entry = (await created.json()) as ConsoleEntryView
    expect((await consoleGet(b.cookie, entry.shortId, b.personalCircleId)).status).toBe(200)
    expect((await consoleGet(ws.cookie, entry.shortId, b.personalCircleId)).status).toBe(403)
    expect((await consoleGet(b.cookie, entry.shortId, ws.personalCircleId)).status).toBe(403)
  })

  it('editor 能建改删非机密词条，viewer 只读，editor 读不到也建不了 secret，owner 可以', async () => {
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const viewer = await addMember(database.db, ws.circleId, 'vic', 'viewer')
    const wifiRes = await consoleCreate(ws.cookie, {
      title: '无线密码',
      content: 'hunter2',
      sensitivity: 'secret',
    })
    expect(wifiRes.status).toBe(201)
    const wifi = (await wifiRes.json()) as ConsoleEntryView

    const faqRes = await consoleCreate(ws.cookie, { title: '常见问题', content: '常见问题' })
    expect(faqRes.status).toBe(201)
    const faq = (await faqRes.json()) as ConsoleEntryView

    // owner 默认列表/详情不回显机密正文，显式 reveal 才返回
    const gotWifi = (await (await consoleGet(ws.cookie, wifi.shortId)).json()) as ConsoleEntryView
    expect(gotWifi.contentHidden).toBe(true)
    expect(gotWifi.variants[0]!.content).toBeNull()
    const revealed = await app.request(
      `${base()}/reveal`,
      jsonRequest('POST', { entryId: wifi.id }, { cookie: ws.cookie }),
    )
    expect(revealed.status).toBe(200)
    expect(((await revealed.json()) as ConsoleEntryView).variants[0]!.content).toBe('hunter2')

    // editor 看不到也写不了 secret，但可建改删非机密词条
    expect((await consoleGet(editor.cookie, wifi.shortId)).status).toBe(404)
    expect(
      (
        await consoleCreate(editor.cookie, {
          title: '机密尝试',
          content: 'x',
          sensitivity: 'secret',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(
          base(),
          jsonRequest(
            'PATCH',
            { id: faq.shortId, sensitivity: 'secret' },
            { cookie: editor.cookie },
          ),
        )
      ).status,
    ).toBe(403)

    const editorDraftRes = await consoleCreate(editor.cookie, {
      title: '工作笔记',
      content: '初稿',
    })
    expect(editorDraftRes.status).toBe(201)
    const draft = (await editorDraftRes.json()) as ConsoleEntryView
    expect(
      (
        await app.request(
          base(),
          jsonRequest('PATCH', { id: draft.shortId, content: '修订版' }, { cookie: editor.cookie }),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(`${base()}?id=${draft.shortId}`, {
          method: 'DELETE',
          headers: { cookie: editor.cookie, 'sec-fetch-site': 'same-origin' },
        })
      ).status,
    ).toBe(204)

    // viewer 只读
    expect((await consoleGet(viewer.cookie, faq.shortId)).status).toBe(200)
    expect((await consoleGet(viewer.cookie, wifi.shortId)).status).toBe(404)
    expect((await consoleCreate(viewer.cookie, { title: 'x', content: 'x' })).status).toBe(403)
    expect(
      (
        await app.request(
          base(),
          jsonRequest('PATCH', { id: faq.shortId, content: '篡改' }, { cookie: viewer.cookie }),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(`${base()}?id=${faq.shortId}`, {
          method: 'DELETE',
          headers: { cookie: viewer.cookie, 'sec-fetch-site': 'same-origin' },
        })
      ).status,
    ).toBe(403)
  })

  it('写入记录操作账号，来源是 owner', async () => {
    await consoleCreate(ws.cookie, { title: '规则', content: '规则' })
    const [event] = await withCircle(database.db, ws.circleId, (tx) =>
      tx.select().from(entryEvents),
    )
    expect(event).toMatchObject({
      actorAccountId: ws.accountId,
      actorKeyId: null,
      provenance: 'owner',
    })
  })

  it('不是成员的记忆圈返回 403，没登录返回 401', async () => {
    const other = '00000000-0000-4000-8000-000000000000'
    expect(
      (
        await app.request(`/v1/circles/${other}/entries/browse?groupBy=topic`, {
          headers: { cookie: ws.cookie },
        })
      ).status,
    ).toBe(403)
    expect((await app.request(`${base()}/browse?groupBy=topic`)).status).toBe(401)
  })

  it('OpenAPI 文档同时包含两套词条接口', async () => {
    const doc = (await (await app.request('/v1/openapi.json')).json()) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/entries',
        '/v1/entries/browse',
        '/v1/entries/transfer',
        '/v1/circles/{circleId}/entries',
        '/v1/circles/{circleId}/entries/browse',
        '/v1/circles/{circleId}/entries/list',
      ]),
    )
  })
})
