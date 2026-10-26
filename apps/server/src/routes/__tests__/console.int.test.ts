import { randomBytes } from 'node:crypto'

import type { MemoryChildren, MemoryView } from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memoryEvents } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('管理界面的记忆接口', () => {
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

  const base = () => `/v1/spaces/${ws.spaceId}/memories`
  const consoleGet = (cookie: string, uri: string) =>
    app.request(`${base()}?uri=${encodeURIComponent(uri)}`, { headers: { cookie } })
  const consoleCreate = (cookie: string, body: Record<string, unknown>) =>
    app.request(base(), jsonRequest('POST', body, { cookie }))

  it('能看到所有应用的应用层与所有人格的记忆', async () => {
    const p1 = await ws.createPersona('doubao')
    const p2 = await ws.createPersona('formal')
    const a1 = await ws.createApp('bot-a', { defaultPersonaId: p1.id })
    const a2 = await ws.createApp('bot-b', { defaultPersonaId: p2.id })
    const k1 = await ws.issueKey(a1.id)
    const k2 = await ws.issueKey(a2.id)
    const viaKey = (key: string, body: Record<string, unknown>) =>
      app.request('/v1/memories', jsonRequest('POST', body, bearer(key)))
    await viaKey(k1, { uri: 'app://bot-a/rules', content: 'A 的规则' })
    await viaKey(k2, { uri: 'app://bot-b/rules', content: 'B 的规则' })
    await viaKey(k1, { uri: 'persona://doubao/soul', content: '豆包' })
    await viaKey(k2, { uri: 'persona://formal/soul', content: '正式' })
    for (const uri of [
      'app://bot-a/rules',
      'app://bot-b/rules',
      'persona://doubao/soul',
      'persona://formal/soul',
    ]) {
      expect((await consoleGet(ws.cookie, uri)).status).toBe(200)
    }
    const apps = (await (
      await app.request(`${base()}/children?of=app`, { headers: { cookie: ws.cookie } })
    ).json()) as MemoryChildren
    expect(apps.children.map((c) => c.uri)).toEqual(['app://bot-a', 'app://bot-b'])
  })

  it('私人层只看得到自己的', async () => {
    const b = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    expect(
      (await consoleCreate(b.cookie, { uri: 'home://diary', content: 'B 的日记' })).status,
    ).toBe(201)
    expect((await consoleGet(b.cookie, 'home://diary')).status).toBe(200)
    expect((await consoleGet(ws.cookie, 'home://diary')).status).toBe(404)
  })

  it('viewer 只读，editor 读不到 secret，owner 可以', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
    expect(
      (
        await consoleCreate(ws.cookie, {
          uri: 'kb://wifi',
          content: 'hunter2',
          layer: 'base',
          sensitivity: 'secret',
        })
      ).status,
    ).toBe(201)
    expect(
      (await consoleCreate(ws.cookie, { uri: 'kb://faq', content: '常见问题', layer: 'base' }))
        .status,
    ).toBe(201)
    expect(((await (await consoleGet(ws.cookie, 'kb://wifi')).json()) as MemoryView).content).toBe(
      'hunter2',
    )
    expect((await consoleGet(editor.cookie, 'kb://wifi')).status).toBe(404)
    expect((await consoleGet(viewer.cookie, 'kb://faq')).status).toBe(200)
    expect(
      (await consoleCreate(viewer.cookie, { uri: 'kb://x', content: 'x', layer: 'base' })).status,
    ).toBe(403)
    expect(
      (
        await consoleCreate(editor.cookie, {
          uri: 'kb://y',
          content: 'x',
          layer: 'base',
          sensitivity: 'secret',
        })
      ).status,
    ).toBe(403)
  })

  it('写入记录操作账号，来源是 owner', async () => {
    await consoleCreate(ws.cookie, { uri: 'core://agent', content: '规则', layer: 'base' })
    const [event] = await withSpace(database.db, ws.spaceId, (tx) => tx.select().from(memoryEvents))
    expect(event).toMatchObject({
      actorAccountId: ws.accountId,
      actorKeyId: null,
      provenance: 'owner',
    })
  })

  it('不是成员的空间返回 403，没登录返回 401', async () => {
    const other = '00000000-0000-4000-8000-000000000000'
    expect(
      (
        await app.request(`/v1/spaces/${other}/memories/domains`, {
          headers: { cookie: ws.cookie },
        })
      ).status,
    ).toBe(403)
    expect((await app.request(`${base()}/domains`)).status).toBe(401)
  })

  it('OpenAPI 文档同时包含两套记忆接口', async () => {
    const doc = (await (await app.request('/v1/openapi.json')).json()) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/memories',
        '/v1/spaces/{spaceId}/memories',
        '/v1/spaces/{spaceId}/memories/children',
      ]),
    )
  })
})
