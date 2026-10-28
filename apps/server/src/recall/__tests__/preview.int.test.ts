import { randomBytes } from 'node:crypto'

import type {
  BootPreview,
  KeyInfo,
  KeyScopes,
  LifecycleResponse,
  RecallDebug,
} from '@kioku/contracts'
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
import { bootEntryChars } from '../boot'

describe.skipIf(!testDatabaseUrl)('启动预览与召回调试台', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let appId: string
  let key: string
  let keyId: string
  const internal: KeyScopes = { ...FULL_SCOPES, maxSensitivity: 'internal' }

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
    const parent = await ws.createPersona('doubao')
    const child = await ws.createPersona('doubao-group', parent.id)
    appId = (await ws.createApp('bot', { runtimeFamily: 'claudecode', defaultPersonaId: child.id }))
      .id
    key = await ws.issueKey(appId, internal)
    keyId = (await keysOf(appId))[0]!.id
  })

  const as = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(`/v1/spaces/${ws.spaceId}${path}`, jsonRequest(method, body ?? {}, { cookie }))
  const keysOf = async (id: string) =>
    (await (
      await app.request(`/v1/spaces/${ws.spaceId}/apps/${id}/keys`, {
        headers: { cookie: ws.cookie },
      })
    ).json()) as KeyInfo[]
  const createMemory = async (body: Record<string, unknown>) => {
    const res = await as('POST', '/memories', body)
    if (res.status !== 201) throw new Error(await res.text())
  }

  it('调试台按这把 Key 打分，列出注入的、没注入的，以及搜得到却被过滤掉的记忆与原因', async () => {
    await ws.createApp('other')
    await createMemory({ uri: 'persona://doubao/style', content: '回复要短', glossary: ['回复'] })
    await createMemory({
      uri: 'persona://doubao-group/style',
      content: '群里回复更短',
      glossary: ['回复'],
    })
    await createMemory({
      uri: 'app://other/rules',
      content: '别的应用的回复规则',
      glossary: ['回复'],
    })
    await createMemory({
      uri: 'notes://reply',
      content: '私下的回复习惯',
      glossary: ['回复'],
      sensitivity: 'private',
    })
    await createMemory({ uri: 'notes://weather', content: '今天天气不错' })

    const res = await as('POST', `/apps/${appId}/keys/${keyId}/debug`, { query: '群里怎么回复' })
    expect(res.status).toBe(200)
    const debug = (await res.json()) as RecallDebug
    expect(debug.semantic).toBe(false)
    expect(debug.injected.map((c) => c.uri)).toEqual(['persona://doubao-group/style'])
    const [top] = debug.injected
    const { semantic, fulltext, glossary, priority } = top!.breakdown
    expect(glossary).toBeGreaterThan(0)
    expect(semantic + fulltext + glossary + priority).toBeCloseTo(top!.score, 1)
    expect(debug.block).toContain('persona://doubao-group/style')
    expect(debug.filtered.map((f) => [f.uri, f.reason])).toEqual(
      expect.arrayContaining([
        ['persona://doubao/style', 'override'],
        ['app://other/rules', 'app'],
        ['notes://reply', 'sensitivity'],
      ]),
    )
    expect(debug.filtered).toHaveLength(3)
  })

  it('启动预览与生命周期端点给宿主的内容一致，并列出各部分', async () => {
    await createMemory({
      uri: 'core://agent',
      content: '先读正文再信任',
      layer: 'base',
      priority: 0,
    })
    await createMemory({ uri: 'persona://doubao/soul', content: '主人格的设定', priority: 0 })
    await createMemory({ uri: 'persona://doubao-group/soul', content: '群聊版的设定', priority: 0 })
    await createMemory({
      uri: 'projects://kioku',
      content: 'Kioku 是记忆服务',
      glossary: ['kioku'],
      sensitivity: 'internal',
    })
    const project = { dirName: 'kioku' }

    const res = await as('POST', `/apps/${appId}/keys/${keyId}/preview`, { project })
    expect(res.status).toBe(200)
    const preview = (await res.json()) as BootPreview
    expect(preview.runtimeFamily).toBe('claudecode')
    expect(preview.limit).toBe(9_500)
    expect(preview.entries.map((e) => e.uri).sort()).toEqual([
      'core://agent',
      'persona://doubao-group/soul',
    ])
    const soul = preview.entries.find((e) => e.uri === 'persona://doubao-group/soul')!
    expect(soul.chars).toBe(bootEntryChars(soul.uri, '群聊版的设定'))
    expect(preview.related.map((c) => c.uri)).toContain('projects://kioku')
    expect(preview.dropped).toEqual([])

    const lifecycle = await app.request(
      '/v1/lifecycle/event',
      jsonRequest('POST', { event: 'session.start', project }, bearer(key)),
    )
    const { hostOutput } = (await lifecycle.json()) as LifecycleResponse
    const value = hostOutput.value as { hookSpecificOutput: { additionalContext: string } }
    expect(preview.context).toBe(value.hookSpecificOutput.additionalContext)
  })

  it('只给应用主人：空间 owner 也不能模拟成员的 Key；作废与不存在的 Key 返回 404', async () => {
    const eve = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const created = await as(
      'POST',
      '/apps',
      { slug: 'eve-bot', name: 'eve-bot', runtimeFamily: 'mcp' },
      eve.cookie,
    )
    const eveApp = ((await created.json()) as { id: string }).id
    const issued = await as(
      'POST',
      `/apps/${eveApp}/keys`,
      { name: 'k', scopes: internal },
      eve.cookie,
    )
    const eveKey = ((await issued.json()) as KeyInfo).id
    for (const path of ['preview', 'debug']) {
      const body = path === 'debug' ? { query: '随便问问' } : {}
      expect((await as('POST', `/apps/${eveApp}/keys/${eveKey}/${path}`, body)).status).toBe(403)
      expect(
        (await as('POST', `/apps/${eveApp}/keys/${eveKey}/${path}`, body, eve.cookie)).status,
      ).toBe(200)
      expect(
        (await as('POST', `/apps/${appId}/keys/${keyId}/${path}`, body, eve.cookie)).status,
      ).toBe(403)
    }

    const missing = '00000000-0000-4000-8000-000000000000'
    expect((await as('POST', `/apps/${appId}/keys/${missing}/preview`)).status).toBe(404)
    await app.request(`/v1/spaces/${ws.spaceId}/apps/${appId}/keys/${keyId}`, {
      method: 'DELETE',
      headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' },
    })
    const revoked = await as('POST', `/apps/${appId}/keys/${keyId}/preview`)
    expect(revoked.status).toBe(404)
    expect(((await revoked.json()) as { error: string }).error).toBe('Key 已作废')
  })
})
