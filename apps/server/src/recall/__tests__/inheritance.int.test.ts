import { randomBytes } from 'node:crypto'

import type {
  BootResponse,
  ConsoleSearchResponse,
  KeyScopes,
  MemoryChildren,
  RecallResponse,
} from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resolveAccess } from '../../access/access'
import { createApp } from '../../app'
import type { Database } from '../../db/client'
import { staticEmbedderSource } from '../../embedding/source'
import { runInSpace } from '../../memory/personas'
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
import { recentMemories } from '../boot'

describe.skipIf(!testDatabaseUrl)('人格继承的覆盖', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let parentId: string
  let childId: string
  let appId: string
  let key: string

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(fakeEmbedder()),
      jobs: null,
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    parentId = (await ws.createPersona('doubao')).id
    childId = (await ws.createPersona('doubao-group', parentId)).id
    appId = (await ws.createApp('group-bot', { defaultPersonaId: childId })).id
    key = await ws.issueKey(appId)
  })

  // 祖先人格的节点由管理界面写：Key 只能写应用当前的人格
  const consoleCreate = async (body: Record<string, unknown>) => {
    const res = await app.request(
      `/v1/spaces/${ws.spaceId}/memories`,
      jsonRequest('POST', body, { cookie: ws.cookie }),
    )
    if (res.status !== 201) throw new Error(await res.text())
  }
  const bootUris = async (k = key) => {
    const res = await app.request('/v1/boot', { headers: bearer(k) })
    return ((await res.json()) as BootResponse).entries.map((e) => e.uri).sort()
  }
  const recallUris = async (query: string, k = key) => {
    const res = await app.request(
      '/v1/recall',
      jsonRequest('POST', { query, limit: 10 }, bearer(k)),
    )
    return ((await res.json()) as RecallResponse).candidates.map((c) => c.uri).sort()
  }

  it('boot 里子人格的节点覆盖祖先同一相对路径的节点，祖先的其余节点照常', async () => {
    await consoleCreate({ uri: 'persona://doubao/soul', content: '主人格的设定', priority: 0 })
    await consoleCreate({ uri: 'persona://doubao/tone', content: '主人格的口吻', priority: 0 })
    await consoleCreate({
      uri: 'persona://doubao-group/soul',
      content: '群聊版的设定',
      priority: 0,
    })
    expect(await bootUris()).toEqual(['persona://doubao-group/soul', 'persona://doubao/tone'])
  })

  it('子人格的节点读不到时照常用祖先的：敏感级超出 Key、已删除', async () => {
    await consoleCreate({ uri: 'persona://doubao/soul', content: '主人格的设定', priority: 0 })
    await consoleCreate({
      uri: 'persona://doubao-group/soul',
      content: '群聊版的设定',
      sensitivity: 'internal',
      priority: 0,
    })
    const publicOnly: KeyScopes = { ...FULL_SCOPES, maxSensitivity: 'public' }
    expect(await bootUris(await ws.issueKey(appId, publicOnly))).toEqual(['persona://doubao/soul'])
    expect(await bootUris()).toEqual(['persona://doubao-group/soul'])

    const res = await app.request(
      `/v1/spaces/${ws.spaceId}/memories?uri=${encodeURIComponent('persona://doubao-group/soul')}`,
      { method: 'DELETE', headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' } },
    )
    expect(res.status).toBe(204)
    expect(await bootUris()).toEqual(['persona://doubao/soul'])
  })

  it('覆盖之后按子人格那条的 priority 挑选：它进不了 boot 时，boot 里就没有这个路径', async () => {
    await consoleCreate({ uri: 'persona://doubao/soul', content: '主人格的设定', priority: 0 })
    await consoleCreate({
      uri: 'persona://doubao-group/soul',
      content: '群聊版的设定',
      priority: 2,
    })
    expect(await bootUris()).toEqual([])
    expect(await recallUris('群聊版的设定')).toEqual(['persona://doubao-group/soul'])
  })

  it('多级继承按最近的人格覆盖，人格根节点也按相对路径算', async () => {
    const grandchild = (await ws.createPersona('doubao-night', childId)).id
    const nightApp = (await ws.createApp('night-bot', { defaultPersonaId: grandchild })).id
    await consoleCreate({ uri: 'persona://doubao', content: '主人格总述', priority: 0 })
    await consoleCreate({ uri: 'persona://doubao/soul', content: '主人格的设定', priority: 0 })
    await consoleCreate({ uri: 'persona://doubao/tone', content: '主人格的口吻', priority: 0 })
    await consoleCreate({
      uri: 'persona://doubao-group/soul',
      content: '群聊版的设定',
      priority: 0,
    })
    await consoleCreate({ uri: 'persona://doubao-night', content: '夜间版总述', priority: 0 })
    await consoleCreate({
      uri: 'persona://doubao-night/tone',
      content: '夜间版的口吻',
      priority: 0,
    })
    expect(await bootUris(await ws.issueKey(nightApp))).toEqual([
      'persona://doubao-group/soul',
      'persona://doubao-night',
      'persona://doubao-night/tone',
    ])
  })

  it('召回与近期列表同样覆盖；按 URI 读取、树浏览与管理界面的搜索照样看得到祖先的节点', async () => {
    await consoleCreate({
      uri: 'persona://doubao/catchphrase',
      content: '主人格的口头禅是「好嘞」',
      glossary: ['口头禅'],
      priority: 2,
    })
    await consoleCreate({
      uri: 'persona://doubao-group/catchphrase',
      content: '群聊版的口头禅是「收到」',
      glossary: ['口头禅'],
      priority: 2,
    })
    await consoleCreate({
      uri: 'persona://doubao/habit',
      content: '主人格的口头禅只在私聊里用',
      glossary: ['口头禅'],
      priority: 2,
    })
    expect(await recallUris('它的口头禅是什么')).toEqual([
      'persona://doubao-group/catchphrase',
      'persona://doubao/habit',
    ])

    const scopes = { appId, ownerAccountId: ws.accountId, personaId: childId }
    const recent = await runInSpace(database.db, ws.spaceId, childId, (tx, chain) =>
      recentMemories(
        tx,
        resolveAccess(FULL_SCOPES, scopes),
        { personaIds: chain, inheritance: true },
        10,
      ),
    )
    expect(recent.map((m) => m.uri).sort()).toEqual([
      'persona://doubao-group/catchphrase',
      'persona://doubao/habit',
    ])

    const get = await app.request(
      `/v1/memories?uri=${encodeURIComponent('persona://doubao/catchphrase')}`,
      { headers: bearer(key) },
    )
    expect(get.status).toBe(200)
    const tree = await app.request(
      `/v1/memories/children?of=${encodeURIComponent('persona://doubao')}`,
      {
        headers: bearer(key),
      },
    )
    const { children } = (await tree.json()) as MemoryChildren
    expect(children.map((c) => c.uri)).toContain('persona://doubao/catchphrase')

    const search = await app.request(
      `/v1/spaces/${ws.spaceId}/memories/search`,
      jsonRequest('POST', { query: '它的口头禅是什么' }, { cookie: ws.cookie }),
    )
    const { candidates } = (await search.json()) as ConsoleSearchResponse
    expect(candidates.map((c) => c.uri)).toContain('persona://doubao/catchphrase')
  })

  describe('Key 写人格层', () => {
    const keyRequest = (method: string, path: string, body: unknown, k = key) =>
      app.request(`/v1${path}`, jsonRequest(method, body, bearer(k)))

    it('只能写应用当前的人格，继承来的祖先只能读', async () => {
      await consoleCreate({ uri: 'persona://doubao/soul', content: '主人格的设定', priority: 0 })
      const ownCreate = await keyRequest('POST', '/memories', {
        uri: 'persona://doubao-group/rule',
        content: '群里不聊工作',
      })
      expect(ownCreate.status).toBe(201)

      const attempts = [
        keyRequest('POST', '/memories', { uri: 'persona://doubao/rule', content: '改主人格' }),
        keyRequest('PATCH', '/memories', { uri: 'persona://doubao/soul', content: '改掉设定' }),
        app.request(`/v1/memories?uri=${encodeURIComponent('persona://doubao/soul')}`, {
          method: 'DELETE',
          headers: bearer(key),
        }),
        keyRequest('POST', '/memories/move', {
          from: 'persona://doubao/soul',
          to: 'persona://doubao/soul-old',
        }),
        keyRequest('POST', '/memories/move', {
          from: 'persona://doubao-group/rule',
          to: 'persona://doubao/rule',
        }),
      ]
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(403)
        expect(((await res.json()) as { error: string }).error).toContain('当前应用所用人格')
      }
      const soul = await app.request(
        `/v1/memories?uri=${encodeURIComponent('persona://doubao/soul')}`,
        { headers: bearer(key) },
      )
      expect(((await soul.json()) as { content: string }).content).toBe('主人格的设定')
    })

    it('Key 不能写人格层时，报的是没有权限而不是人格不对', async () => {
      await consoleCreate({ uri: 'persona://doubao/soul', content: '主人格的设定', priority: 0 })
      const noPersona = await ws.issueKey(appId, {
        ...FULL_SCOPES,
        writeLayers: FULL_SCOPES.writeLayers.filter((l) => l !== 'persona'),
      })
      const attempts = [
        keyRequest(
          'PATCH',
          '/memories',
          { uri: 'persona://doubao/soul', content: '改掉设定' },
          noPersona,
        ),
        keyRequest(
          'POST',
          '/memories',
          { uri: 'persona://doubao-group/rule', content: '群里不聊工作' },
          noPersona,
        ),
      ]
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(403)
        expect(((await res.json()) as { error: string }).error).not.toContain('当前应用所用人格')
      }
    })

    it('跨人格 / 应用写入的 Key 与管理界面的 editor 能写祖先人格', async () => {
      const admin = await ws.issueKey(appId, { ...FULL_SCOPES, admin: true })
      const res = await keyRequest(
        'POST',
        '/memories',
        { uri: 'persona://doubao/rule', content: '主人格的规则' },
        admin,
      )
      expect(res.status).toBe(201)

      const editor = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const byEditor = await app.request(
        `/v1/spaces/${ws.spaceId}/memories`,
        jsonRequest(
          'POST',
          { uri: 'persona://doubao/style', content: '主人格的文风' },
          { cookie: editor.cookie },
        ),
      )
      expect(byEditor.status).toBe(201)
    })
  })
})
