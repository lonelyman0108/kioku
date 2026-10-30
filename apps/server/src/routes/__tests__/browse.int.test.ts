import { randomBytes } from 'node:crypto'

import type {
  ConsoleSearchResponse,
  EmbeddingStatus,
  KeyScopes,
  MemoryChildren,
  MemoryList,
  MemoryView,
  SpaceOverview,
} from '@kioku/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memories, settings, spaceMembers } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { backfillEmbeddings, embedMemory } from '../../embedding/worker'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const EDITOR_SCOPES: KeyScopes = {
  readLayers: ['base'],
  writeLayers: [],
  maxSensitivity: 'private',
  admin: false,
}

describe.skipIf(!testDatabaseUrl)('管理界面的列表、搜索与概览', () => {
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
    // 实例设置不挂在空间下，resetDatabase 清不到，嵌入设置要单独清掉
    await database.db.delete(settings)
    ws = await bootstrap(app)
  })

  const space = () => `/v1/spaces/${ws.spaceId}`
  const create = async (cookie: string, body: Record<string, unknown>) => {
    const res = await app.request(`${space()}/memories`, jsonRequest('POST', body, { cookie }))
    expect(res.status).toBe(201)
    return (await res.json()) as MemoryView
  }
  const get = async <T>(cookie: string, path: string) => {
    const res = await app.request(`${space()}${path}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    return (await res.json()) as T
  }
  const list = (cookie: string, query = '') =>
    get<MemoryList>(cookie, `/memories/list${query ? `?${query}` : ''}`)
  const uris = (l: { items: { uri: string }[] }) => l.items.map((i) => i.uri)
  const search = async (cookie: string, query: string) => {
    const res = await app.request(
      `${space()}/memories/search`,
      jsonRequest('POST', { query }, { cookie }),
    )
    expect(res.status).toBe(200)
    return (await res.json()) as ConsoleSearchResponse
  }
  const saveEmbedding = async () => {
    const res = await app.request(
      '/v1/settings/embedding',
      jsonRequest(
        'PUT',
        {
          model: 'fake-embedding',
          channels: [{ baseUrl: 'https://embed.example.com/v1', model: 'fake-embedding' }],
        },
        { cookie: ws.cookie },
      ),
    )
    expect(res.status).toBe(200)
  }

  // 各层与各敏感级都有一条；editor 另有一条自己的私人记忆
  async function seed() {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    await create(ws.cookie, {
      uri: 'core://agent',
      content: '先读正文再信任',
      layer: 'base',
      disclosure: '每次会话开始',
    })
    await create(ws.cookie, {
      uri: 'preferences://user',
      content: '回答用中文',
      layer: 'owner',
      disclosure: '和主人协作时',
    })
    await create(ws.cookie, {
      uri: 'projects://alpha',
      content: '阿尔法项目的说明',
      glossary: ['阿尔法'],
    })
    await create(ws.cookie, {
      uri: 'projects://beta',
      content: '贝塔项目',
      disclosure: '提到贝塔时',
    })
    await create(ws.cookie, {
      uri: 'kb://wifi',
      content: 'hunter2',
      layer: 'base',
      sensitivity: 'secret',
      disclosure: '连无线网时',
    })
    await create(editor.cookie, { uri: 'home://diary', content: '日记' })
    return editor
  }

  it('列表按成员权限返回：别人的私人层看不到，secret 只有能读 secret 的成员列得出', async () => {
    const editor = await seed()
    expect(uris(await list(ws.cookie)).sort()).toEqual([
      'core://agent',
      'kb://wifi',
      'preferences://user',
      'projects://alpha',
      'projects://beta',
    ])
    expect(uris(await list(editor.cookie)).sort()).toEqual(['core://agent', 'home://diary'])
  })

  it('列表可以按层、敏感级、domain、关键字与 disclosure 筛选', async () => {
    await seed()
    expect(uris(await list(ws.cookie, 'layer=private')).sort()).toEqual([
      'projects://alpha',
      'projects://beta',
    ])
    expect(uris(await list(ws.cookie, 'sensitivity=secret'))).toEqual(['kb://wifi'])
    expect(uris(await list(ws.cookie, 'domain=projects')).sort()).toEqual([
      'projects://alpha',
      'projects://beta',
    ])
    // 关键字同时查 URI 与 disclosure，不区分大小写；% 与 _ 按字面匹配
    expect(uris(await list(ws.cookie, 'q=AGENT'))).toEqual(['core://agent'])
    expect(uris(await list(ws.cookie, `q=${encodeURIComponent('贝塔')}`))).toEqual([
      'projects://beta',
    ])
    expect((await list(ws.cookie, `q=${encodeURIComponent('%')}`)).items).toEqual([])
    expect(uris(await list(ws.cookie, 'missingDisclosure=true'))).toEqual(['projects://alpha'])
    expect((await list(ws.cookie, 'missingDisclosure=false')).items).toHaveLength(4)
  })

  it('三种排序逐页翻完，不重不漏，顺序与一次取完相同', async () => {
    for (const [i, priority] of [3, 1, 2, 1, 0, 2, 1].entries()) {
      await create(ws.cookie, { uri: `notes://n${i}`, content: `第 ${i} 条`, priority })
    }
    // 几条的更新时间相同，靠 id 决定先后
    const same = new Date('2026-01-01T00:00:00.123456Z')
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ updatedAt: same })
        .where(inArray(memories.path, ['n1', 'n2', 'n3'])),
    )
    const patched = await app.request(
      `${space()}/memories`,
      jsonRequest('PATCH', { uri: 'notes://n0', content: '改过' }, { cookie: ws.cookie }),
    )
    expect(patched.status).toBe(200)

    for (const sort of ['updated', 'priority', 'uri'] as const) {
      const all = uris(await list(ws.cookie, `sort=${sort}&limit=200`))
      expect(all).toHaveLength(7)
      const paged: string[] = []
      let cursor: string | null = null
      do {
        const page: MemoryList = await list(
          ws.cookie,
          `sort=${sort}&limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        )
        expect(page.items.length).toBeLessThanOrEqual(3)
        paged.push(...uris(page))
        cursor = page.nextCursor
      } while (cursor)
      expect(paged).toEqual(all)
    }
    expect(uris(await list(ws.cookie, 'sort=updated&limit=1'))).toEqual(['notes://n0'])
    expect(uris(await list(ws.cookie, 'sort=priority&limit=200'))).toEqual([
      'notes://n4',
      'notes://n1',
      'notes://n3',
      'notes://n6',
      'notes://n2',
      'notes://n5',
      'notes://n0',
    ])
  })

  it('路径很长的记忆排在一页末尾时，游标照样能翻到下一页', async () => {
    // URI 允许的最长路径：16 段，每段 64 个字符
    const long = Array.from({ length: 16 }, (_, i) => String(i % 10).repeat(64)).join('/')
    await create(ws.cookie, { uri: `notes://${long}`, content: '很长的路径', priority: 0 })
    await create(ws.cookie, { uri: 'notes://short', content: '短的', priority: 1 })
    for (const sort of ['uri', 'priority'] as const) {
      const first = await list(ws.cookie, `sort=${sort}&limit=1`)
      expect(uris(first)).toEqual([`notes://${long}`])
      const second = await list(ws.cookie, `sort=${sort}&limit=1&cursor=${first.nextCursor}`)
      expect(uris(second)).toEqual(['notes://short'])
    }
  })

  it('列表可以按更新时间筛选', async () => {
    for (const name of ['old', 'mid', 'new']) {
      await create(ws.cookie, { uri: `notes://${name}`, content: name })
    }
    const at = (path: string, iso: string) =>
      withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(memories)
          .set({ updatedAt: new Date(iso) })
          .where(inArray(memories.path, [path])),
      )
    await at('old', '2026-01-01T00:00:00Z')
    await at('mid', '2026-02-01T00:00:00Z')
    await at('new', '2026-03-01T00:00:00Z')
    const range = (q: string) => list(ws.cookie, `sort=uri&${q}`)
    expect(uris(await range(`updatedAfter=${encodeURIComponent('2026-02-01T00:00:00Z')}`))).toEqual(
      ['notes://mid', 'notes://new'],
    )
    expect(
      uris(await range(`updatedBefore=${encodeURIComponent('2026-02-01T00:00:00+00:00')}`)),
    ).toEqual(['notes://old'])
    const res = await app.request(`${space()}/memories/list?updatedAfter=yesterday`, {
      headers: { cookie: ws.cookie },
    })
    expect(res.status).toBe(400)

    // 精确到微秒：边界不能因为换算成 JS 的 Date 而挪动
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.execute(
        sql`update memories set updated_at = '2026-02-01T00:00:00.000200Z' where path = 'mid'`,
      ),
    )
    expect(
      uris(await range(`updatedBefore=${encodeURIComponent('2026-02-01T00:00:00.000500Z')}`)),
    ).toEqual(['notes://mid', 'notes://old'])
    expect(
      uris(await range(`updatedAfter=${encodeURIComponent('2026-02-01T00:00:00.000500Z')}`)),
    ).toEqual(['notes://new'])
  })

  it('翻页参数无效时返回 400', async () => {
    await create(ws.cookie, { uri: 'notes://x', content: 'x' })
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const uriCursor = encode(['notes', 'x', '00000000-0000-4000-8000-000000000000'])
    for (const query of [
      'cursor=abc',
      `cursor=${encode([1, 2])}`,
      `cursor=${encode(['1', 'not-a-uuid'])}`,
      // 按 URI 排序的游标拿去按更新时间翻页
      `sort=updated&cursor=${uriCursor}`,
      // 超出 bigint 的范围，不能让数据库报错变成 500
      `sort=updated&cursor=${encode(['9999999999999999999', '00000000-0000-4000-8000-000000000000'])}`,
      // priority 超出整数范围
      `sort=priority&cursor=${encode([3000000000, 'notes', 'x', '00000000-0000-4000-8000-000000000000'])}`,
    ]) {
      const res = await app.request(`${space()}/memories/list?${query}`, {
        headers: { cookie: ws.cookie },
      })
      expect(res.status).toBe(400)
    }
    expect(uris(await list(ws.cookie, `sort=uri&cursor=${uriCursor}`))).toEqual(['notes://x'])
  })

  it('树里能读 secret 的成员看得到 secret 记忆，editor 和 Key 都看不到', async () => {
    const editor = await seed()
    const ownerKb = await get<MemoryChildren>(ws.cookie, '/memories/children?of=kb')
    expect(ownerKb.children.map((c) => [c.uri, c.sensitivity])).toEqual([['kb://wifi', 'secret']])
    expect((await get<MemoryChildren>(editor.cookie, '/memories/children?of=kb')).children).toEqual(
      [],
    )
    const domains = async (cookie: string) =>
      (await get<{ domain: string }[]>(cookie, '/memories/domains')).map((d) => d.domain)
    expect(await domains(ws.cookie)).toContain('kb')
    expect(await domains(editor.cookie)).not.toContain('kb')

    // 接入方的 Key 即使是 secret 级，浏览时也列不出 secret：只能按 URI 显式读取
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const viaKey = (await (
      await app.request('/v1/memories/children?of=kb', { headers: bearer(key) })
    ).json()) as MemoryChildren
    expect(viaKey.children).toEqual([])
    const read = await app.request(`/v1/memories?uri=${encodeURIComponent('kb://wifi')}`, {
      headers: bearer(key),
    })
    expect(((await read.json()) as MemoryView).content).toBe('hunter2')
  })

  it('搜索：URI 与关键词直接命中，召回候选不含 secret，看不到别人的私人层', async () => {
    const editor = await seed()
    const byUri = await search(ws.cookie, 'wifi')
    expect(byUri.matches.map((m) => m.uri)).toEqual(['kb://wifi'])
    expect(byUri.candidates.map((c) => c.uri)).not.toContain('kb://wifi')
    expect((await search(ws.cookie, '阿尔')).matches.map((m) => m.uri)).toEqual([
      'projects://alpha',
    ])
    // 测试里没有嵌入模型，召回走全文与关键词
    expect((await search(ws.cookie, '阿尔法项目怎么样了')).candidates.map((c) => c.uri)).toContain(
      'projects://alpha',
    )
    expect(
      (await search(editor.cookie, '阿尔法项目怎么样了')).candidates.map((c) => c.uri),
    ).not.toContain('projects://alpha')
    expect((await search(editor.cookie, 'wifi')).matches).toEqual([])
    expect((await search(ws.cookie, 'diary')).matches).toEqual([])
    expect((await search(editor.cookie, 'diary')).matches.map((m) => m.uri)).toEqual([
      'home://diary',
    ])
  })

  it('概览按层与敏感级计数，统计缺 disclosure 与向量覆盖率', async () => {
    await seed()
    await saveEmbedding()
    const alpha = await get<MemoryView>(
      ws.cookie,
      `/memories?uri=${encodeURIComponent('projects://alpha')}`,
    )
    await embedMemory(database.db, fakeEmbedder(), ws.spaceId, alpha.id)
    const o = await get<SpaceOverview>(ws.cookie, '/overview')
    expect(o.total).toBe(5)
    expect(o.counts).toEqual([
      { layer: 'base', sensitivity: 'public', count: 1 },
      { layer: 'base', sensitivity: 'secret', count: 1 },
      { layer: 'owner', sensitivity: 'internal', count: 1 },
      { layer: 'private', sensitivity: 'private', count: 2 },
    ])
    expect(o.missingDisclosure).toBe(1)
    // secret 不生成向量，不算在应当有向量的记忆里；别人的私人层也不算
    expect(o.embedding).toEqual({
      configured: true,
      model: 'fake-embedding',
      eligible: 4,
      embedded: 1,
    })
  })

  it('有已过期的记忆时，概览与实例设置的向量数一样：都只算现在有效的', async () => {
    await saveEmbedding()
    for (const p of ['a', 'b', 'c']) {
      await create(ws.cookie, { uri: `kb://${p}`, content: p, layer: 'base' })
    }
    const lapsed = await create(ws.cookie, { uri: 'kb://lapsed', content: '到期了', layer: 'base' })
    await create(ws.cookie, { uri: 'home://wifi', content: 'hunter2', sensitivity: 'secret' })
    // 过期之前已经生成了向量
    expect(await backfillEmbeddings(database.db, fakeEmbedder())).toBe(4)
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 60_000) })
        .where(eq(memories.id, lapsed.id)),
    )

    const overview = (await get<SpaceOverview>(ws.cookie, '/overview')).embedding
    expect(overview).toMatchObject({ eligible: 3, embedded: 3 })
    const res = await app.request('/v1/settings/embedding/status', {
      headers: { cookie: ws.cookie },
    })
    const status = (await res.json()) as EmbeddingStatus
    expect({ eligible: status.eligible, embedded: status.active?.embedded }).toEqual({
      eligible: overview.eligible,
      embedded: overview.embedded,
    })
  })

  it('概览里 Key 的使用情况只给应用主人与空间 owner 看，吊销的不算', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const ownerApp = await ws.createApp('owner-bot')
    await ws.issueKey(ownerApp.id)
    const created = await app.request(
      `${space()}/apps`,
      jsonRequest(
        'POST',
        { slug: 'eve-bot', name: 'eve-bot', runtimeFamily: 'mcp' },
        { cookie: editor.cookie },
      ),
    )
    const eveApp = (await created.json()) as { id: string }
    const issued = await app.request(
      `${space()}/apps/${eveApp.id}/keys`,
      jsonRequest('POST', { name: 'k', scopes: EDITOR_SCOPES }, { cookie: editor.cookie }),
    )
    expect(issued.status).toBe(201)
    const revoked = (await issued.json()) as { id: string }

    const keysOf = (o: SpaceOverview, slug: string) => o.apps.find((a) => a.slug === slug)?.keys
    const asOwner = await get<SpaceOverview>(ws.cookie, '/overview')
    expect(keysOf(asOwner, 'owner-bot')).toEqual({ active: 1, lastUsedAt: null })
    expect(keysOf(asOwner, 'eve-bot')).toEqual({ active: 1, lastUsedAt: null })
    const asEditor = await get<SpaceOverview>(editor.cookie, '/overview')
    expect(keysOf(asEditor, 'owner-bot')).toBeNull()
    expect(keysOf(asEditor, 'eve-bot')).toEqual({ active: 1, lastUsedAt: null })

    const revoke = await app.request(`${space()}/apps/${eveApp.id}/keys/${revoked.id}`, {
      method: 'DELETE',
      headers: { cookie: editor.cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(revoke.status).toBe(204)
    expect(keysOf(await get<SpaceOverview>(editor.cookie, '/overview'), 'eve-bot')).toEqual({
      active: 0,
      lastUsedAt: null,
    })

    // 应用主人离开空间后，他的 Key 作废，不再算有效；重新加入后，之前签发的也不算
    await ws.issueKey(ownerApp.id)
    const another = await app.request(
      `${space()}/apps/${eveApp.id}/keys`,
      jsonRequest('POST', { name: 'k2', scopes: EDITOR_SCOPES }, { cookie: editor.cookie }),
    )
    expect(another.status).toBe(201)
    await database.db
      .delete(spaceMembers)
      .where(
        and(eq(spaceMembers.spaceId, ws.spaceId), eq(spaceMembers.accountId, editor.accountId)),
      )
    expect(keysOf(await get<SpaceOverview>(ws.cookie, '/overview'), 'eve-bot')).toEqual({
      active: 0,
      lastUsedAt: null,
    })
    await database.db
      .insert(spaceMembers)
      .values({ spaceId: ws.spaceId, accountId: editor.accountId, role: 'editor' })
    expect(keysOf(await get<SpaceOverview>(ws.cookie, '/overview'), 'eve-bot')?.active).toBe(0)
    expect(keysOf(await get<SpaceOverview>(ws.cookie, '/overview'), 'owner-bot')?.active).toBe(2)
  })

  it('实例的向量覆盖率与重建只给实例管理员', async () => {
    const editor = await seed()
    const status = (cookie: string) =>
      app.request('/v1/settings/embedding/status', { headers: { cookie } })
    const rebuild = (cookie: string) =>
      app.request('/v1/settings/embedding/rebuild', jsonRequest('POST', {}, { cookie }))
    expect((await status(editor.cookie)).status).toBe(403)
    expect((await rebuild(editor.cookie)).status).toBe(403)
    // 整个实例的口径：所有成员的、现在有效、不是 secret 的记忆
    expect(await (await status(ws.cookie)).json()).toEqual({
      eligible: 5,
      active: null,
      next: null,
      lastError: null,
    })
    expect((await rebuild(ws.cookie)).status).toBe(400)

    await saveEmbedding()
    const res = await rebuild(ws.cookie)
    // 测试里没有启动后台任务：没排进队列，不能返回已接受
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: expect.stringContaining('没有排进队列') })

    // 有后台任务时按入队结果返回，入队失败不能报成已排队
    for (const queued of [true, false]) {
      const withJobs = createApp({
        db: database.db,
        cookieSecure: false,
        masterKey: randomBytes(32),
        embedder: staticEmbedderSource(null),
        jobs: {
          enqueueEmbed() {},
          enqueueBackfill: async () => queued,
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
      const r = await withJobs.request(
        '/v1/settings/embedding/rebuild',
        jsonRequest('POST', {}, { cookie: ws.cookie }),
      )
      expect(r.status).toBe(queued ? 202 : 503)
      expect(await r.json()).toEqual(
        queued ? { queued: true } : { error: expect.stringContaining('没有排进队列') },
      )
    }
  })

  it('关键词索引按成员的可见范围：别人的私人层不在里面，secret 的只给能读 secret 的成员', async () => {
    const editor = await seed()
    await create(ws.cookie, { uri: 'projects://alpha2', content: '另一条', glossary: ['阿尔法'] })
    await create(ws.cookie, {
      uri: 'kb://lock',
      content: '锁',
      layer: 'base',
      sensitivity: 'secret',
      glossary: ['门锁'],
    })
    await create(editor.cookie, { uri: 'home://e', content: 'E 的', glossary: ['日记本'] })
    type Index = { entries: { keyword: string; uris: string[] }[]; truncated: boolean }
    const index = async (cookie: string) =>
      Object.fromEntries(
        (await get<Index>(cookie, '/memories/glossary')).entries.map((e) => [e.keyword, e.uris]),
      )
    const owner = await index(ws.cookie)
    expect(owner['阿尔法']).toEqual(['projects://alpha', 'projects://alpha2'])
    expect(owner['门锁']).toEqual(['kb://lock'])
    expect(owner['日记本']).toBeUndefined()
    const mine = await index(editor.cookie)
    expect(mine['日记本']).toEqual(['home://e'])
    expect(mine['阿尔法']).toBeUndefined()
    expect(mine['门锁']).toBeUndefined()
  })

  it('OpenAPI 文档里有新增的接口', async () => {
    const doc = (await (await app.request('/v1/openapi.json')).json()) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/spaces/{spaceId}/memories/list',
        '/v1/spaces/{spaceId}/memories/search',
        '/v1/spaces/{spaceId}/overview',
        '/v1/settings/embedding/status',
        '/v1/settings/embedding/rebuild',
      ]),
    )
  })
})
