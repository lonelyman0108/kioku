import { randomBytes } from 'node:crypto'

import {
  isBootCandidate,
  type ConsoleSearchResponse,
  type EmbeddingStatus,
  type KeyScopes,
  type MemoryChildren,
  type MemoryList,
  type MemoryView,
  type SpaceOverview,
} from '@kioku/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import * as schema from '../../db/schema'
import { accounts, apps, memories, settings, spaceMembers } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { backfillEmbeddings, embedMemories } from '../../embedding/worker'
import { memoryServiceForConsole } from '../../memory/context'
import { BOOT_CANDIDATE } from '../../memory/filter'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import {
  openTestDatabase,
  resetDatabase,
  summaryConversation,
  testDatabaseUrl,
} from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const EDITOR_SCOPES: KeyScopes = {
  readLayers: ['core'],
  writeLayers: [],
  maxSensitivity: 'private',
  admin: false,
  credentials: 'none',
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
      disclosure: '每次会话开始',
    })
    await create(ws.cookie, {
      uri: 'user://preferences/user',
      sensitivity: 'internal',
      content: '回答用中文',
      disclosure: '和主人协作时',
    })
    await create(ws.cookie, {
      uri: 'user://projects/alpha',
      content: '阿尔法项目的说明',
      glossary: ['阿尔法'],
    })
    await create(ws.cookie, {
      uri: 'user://projects/beta',
      content: '贝塔项目',
      disclosure: '提到贝塔时',
    })
    await create(ws.cookie, {
      uri: 'core://kb/wifi',
      content: 'hunter2',
      sensitivity: 'secret',
      disclosure: '连无线网时',
    })
    await create(editor.cookie, { uri: 'user://home/diary', content: '日记' })
    return editor
  }

  it('列表按成员权限返回：别人的私人层看不到，secret 只有能读 secret 的成员列得出', async () => {
    const editor = await seed()
    expect(uris(await list(ws.cookie)).sort()).toEqual([
      'core://agent',
      'core://kb/wifi',
      'user://preferences/user',
      'user://projects/alpha',
      'user://projects/beta',
    ])
    expect(uris(await list(editor.cookie)).sort()).toEqual(['core://agent', 'user://home/diary'])
  })

  it('列表可以按归属、敏感级、位置、关键字与 disclosure 筛选', async () => {
    await seed()
    expect(uris(await list(ws.cookie, 'layer=user')).sort()).toEqual([
      'user://preferences/user',
      'user://projects/alpha',
      'user://projects/beta',
    ])
    expect(uris(await list(ws.cookie, 'sensitivity=secret'))).toEqual(['core://kb/wifi'])
    const under = (prefix: string) => `under=${encodeURIComponent(prefix)}`
    expect(uris(await list(ws.cookie, under('user://projects'))).sort()).toEqual([
      'user://projects/alpha',
      'user://projects/beta',
    ])
    // 位置连同它本身；只按整段匹配，user://project 不算 user://projects 的上一级
    expect(uris(await list(ws.cookie, under('user://projects/alpha')))).toEqual([
      'user://projects/alpha',
    ])
    expect((await list(ws.cookie, under('user://project'))).items).toEqual([])
    // 位置里的 _ 按字面匹配，不当作通配符
    await create(ws.cookie, { uri: 'user://my_notes/a', content: 'a' })
    await create(ws.cookie, { uri: 'user://myxnotes/b', content: 'b' })
    expect(uris(await list(ws.cookie, under('user://my_notes')))).toEqual(['user://my_notes/a'])
    // 别的成员的本人记忆按位置也筛不出来
    expect((await list(ws.cookie, under('user://home'))).items).toEqual([])
    const badPrefix = await app.request(`${space()}/memories/list?${under('notes://x')}`, {
      headers: { cookie: ws.cookie },
    })
    expect(badPrefix.status).toBe(400)
    // 关键字同时查 URI 与 disclosure，不区分大小写；% 与 _ 按字面匹配
    expect(uris(await list(ws.cookie, 'q=AGENT'))).toEqual(['core://agent'])
    expect(uris(await list(ws.cookie, `q=${encodeURIComponent('贝塔')}`))).toEqual([
      'user://projects/beta',
    ])
    expect((await list(ws.cookie, `q=${encodeURIComponent('%')}`)).items).toEqual([])
    expect((await list(ws.cookie, 'missingDisclosure=false')).items).toHaveLength(4)
    expect(uris(await list(ws.cookie, 'missingDisclosure=true')).sort()).toEqual([
      'user://my_notes/a',
      'user://myxnotes/b',
      'user://projects/alpha',
    ])
  })

  it('三种排序逐页翻完，不重不漏，顺序与一次取完相同', async () => {
    for (const [i, priority] of [3, 1, 2, 1, 0, 2, 1].entries()) {
      await create(ws.cookie, { uri: `user://notes/n${i}`, content: `第 ${i} 条`, priority })
    }
    // 几条的更新时间相同，靠 id 决定先后
    const same = new Date('2026-01-01T00:00:00.123456Z')
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ updatedAt: same })
        .where(inArray(memories.path, ['notes/n1', 'notes/n2', 'notes/n3'])),
    )
    const patched = await app.request(
      `${space()}/memories`,
      jsonRequest('PATCH', { uri: 'user://notes/n0', content: '改过' }, { cookie: ws.cookie }),
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
    expect(uris(await list(ws.cookie, 'sort=updated&limit=1'))).toEqual(['user://notes/n0'])
    expect(uris(await list(ws.cookie, 'sort=priority&limit=200'))).toEqual([
      'user://notes/n4',
      'user://notes/n1',
      'user://notes/n3',
      'user://notes/n6',
      'user://notes/n2',
      'user://notes/n5',
      'user://notes/n0',
    ])
  })

  it('路径很长的记忆排在一页末尾时，游标照样能翻到下一页', async () => {
    // 坐标允许的最长路径：开头之后 16 段，每段 64 个字符
    const long = Array.from({ length: 16 }, (_, i) => String(i % 10).repeat(64)).join('/')
    await create(ws.cookie, { uri: `user://${long}`, content: '很长的路径', priority: 0 })
    await create(ws.cookie, { uri: 'user://notes/short', content: '短的', priority: 1 })
    for (const sort of ['uri', 'priority'] as const) {
      const first = await list(ws.cookie, `sort=${sort}&limit=1`)
      expect(uris(first)).toEqual([`user://${long}`])
      const second = await list(ws.cookie, `sort=${sort}&limit=1&cursor=${first.nextCursor}`)
      expect(uris(second)).toEqual(['user://notes/short'])
    }
  })

  it('列表可以按更新时间筛选', async () => {
    for (const name of ['old', 'mid', 'new']) {
      await create(ws.cookie, { uri: `user://notes/${name}`, content: name })
    }
    const at = (path: string, iso: string) =>
      withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(memories)
          .set({ updatedAt: new Date(iso) })
          .where(inArray(memories.path, [`notes/${path}`])),
      )
    await at('old', '2026-01-01T00:00:00Z')
    await at('mid', '2026-02-01T00:00:00Z')
    await at('new', '2026-03-01T00:00:00Z')
    const range = (q: string) => list(ws.cookie, `sort=uri&${q}`)
    expect(uris(await range(`updatedAfter=${encodeURIComponent('2026-02-01T00:00:00Z')}`))).toEqual(
      ['user://notes/mid', 'user://notes/new'],
    )
    expect(
      uris(await range(`updatedBefore=${encodeURIComponent('2026-02-01T00:00:00+00:00')}`)),
    ).toEqual(['user://notes/old'])
    const res = await app.request(`${space()}/memories/list?updatedAfter=yesterday`, {
      headers: { cookie: ws.cookie },
    })
    expect(res.status).toBe(400)

    // 精确到微秒：边界不能因为换算成 JS 的 Date 而挪动
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.execute(
        sql`update memories set updated_at = '2026-02-01T00:00:00.000200Z' where path = 'notes/mid'`,
      ),
    )
    expect(
      uris(await range(`updatedBefore=${encodeURIComponent('2026-02-01T00:00:00.000500Z')}`)),
    ).toEqual(['user://notes/mid', 'user://notes/old'])
    expect(
      uris(await range(`updatedAfter=${encodeURIComponent('2026-02-01T00:00:00.000500Z')}`)),
    ).toEqual(['user://notes/new'])
  })

  it('翻页参数无效时返回 400', async () => {
    await create(ws.cookie, { uri: 'user://notes/x', content: 'x' })
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
    expect(uris(await list(ws.cookie, `sort=uri&cursor=${uriCursor}`))).toEqual(['user://notes/x'])
  })

  it('树里能读 secret 的成员看得到 secret 记忆，editor 和 Key 都看不到', async () => {
    const editor = await seed()
    const kb = `/memories/children?of=${encodeURIComponent('core://kb')}`
    const ownerKb = await get<MemoryChildren>(ws.cookie, kb)
    expect(ownerKb.children.map((c) => [c.uri, c.sensitivity])).toEqual([
      ['core://kb/wifi', 'secret'],
    ])
    // editor 读不到下面唯一的一条：这个位置和不存在一样，上一级里也没有它
    const editorKb = await app.request(`${space()}${kb}`, { headers: { cookie: editor.cookie } })
    expect(editorKb.status).toBe(404)
    const core = async (cookie: string) =>
      (await get<MemoryChildren>(cookie, '/memories/children?of=core')).children.map((c) => c.uri)
    expect(await core(ws.cookie)).toEqual(['core://agent', 'core://kb'])
    expect(await core(editor.cookie)).toEqual(['core://agent'])

    // 接入方的 Key 即使是 secret 级，浏览时也列不出 secret：只能按 URI 显式读取
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const viaKey = (await (
      await app.request('/v1/memories/children?of=core', { headers: bearer(key) })
    ).json()) as MemoryChildren
    expect(viaKey.children.map((c) => c.uri)).toEqual(['core://agent'])
    const read = await app.request(`/v1/memories?uri=${encodeURIComponent('core://kb/wifi')}`, {
      headers: bearer(key),
    })
    expect(((await read.json()) as MemoryView).content).toBe('hunter2')
  })

  it('搜索：URI 与关键词直接命中，召回候选不含 secret，看不到别人的私人层', async () => {
    const editor = await seed()
    const byUri = await search(ws.cookie, 'wifi')
    expect(byUri.matches.map((m) => m.uri)).toEqual(['core://kb/wifi'])
    expect(byUri.candidates.map((c) => c.uri)).not.toContain('core://kb/wifi')
    expect((await search(ws.cookie, '阿尔')).matches.map((m) => m.uri)).toEqual([
      'user://projects/alpha',
    ])
    // 测试里没有嵌入模型，召回走全文与关键词
    expect((await search(ws.cookie, '阿尔法项目怎么样了')).candidates.map((c) => c.uri)).toContain(
      'user://projects/alpha',
    )
    expect(
      (await search(editor.cookie, '阿尔法项目怎么样了')).candidates.map((c) => c.uri),
    ).not.toContain('user://projects/alpha')
    expect((await search(editor.cookie, 'wifi')).matches).toEqual([])
    expect((await search(ws.cookie, 'diary')).matches).toEqual([])
    expect((await search(editor.cookie, 'diary')).matches.map((m) => m.uri)).toEqual([
      'user://home/diary',
    ])
  })

  it('概览按层与敏感级计数，统计缺 disclosure 与向量覆盖率', async () => {
    await seed()
    await saveEmbedding()
    const alpha = await get<MemoryView>(
      ws.cookie,
      `/memories?uri=${encodeURIComponent('user://projects/alpha')}`,
    )
    await embedMemories(database.db, fakeEmbedder(), ws.spaceId, [alpha.id])
    const o = await get<SpaceOverview>(ws.cookie, '/overview')
    expect(o.total).toBe(5)
    expect(o.counts).toEqual([
      { layer: 'core', sensitivity: 'public', count: 1 },
      { layer: 'core', sensitivity: 'secret', count: 1 },
      { layer: 'user', sensitivity: 'internal', count: 1 },
      { layer: 'user', sensitivity: 'private', count: 2 },
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

  it('未设触发场景只算要补的：会进启动加载的不算，机密照算；概览的数字和列表筛选的条数一致', async () => {
    await ws.createPersona('muse')
    await ws.createApp('bot')
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const needed = [
      { uri: 'core://notes', content: '基础层 p2' },
      { uri: 'user://projects/p1', content: '私人层 p1', priority: 1 },
      { uri: 'user://projects/blank', content: '只有空白', disclosure: '  ' },
      { uri: 'persona://muse/more', content: '人格层 p2' },
      { uri: 'app://bot/agent/extra', content: '应用层 p2' },
      // 机密不进启动加载，写清在什么场景下需要它才知道要不要读
      { uri: 'core://kb/key', content: 'hunter2', sensitivity: 'secret', priority: 0 },
    ]
    const boot = [
      { uri: 'core://boot', content: '基础层 p0', priority: 0 },
      { uri: 'user://preferences/top', sensitivity: 'internal', content: '主人层 p0', priority: 0 },
      { uri: 'user://projects/top', content: '私人层 p0', priority: 0, disclosure: '  ' },
      { uri: 'persona://muse/style', content: '人格层 p1', priority: 1 },
      { uri: 'app://bot/agent', content: '应用层 p1', priority: 1 },
    ]
    for (const body of [...needed, ...boot]) await create(ws.cookie, body)
    await create(ws.cookie, {
      uri: 'core://agent',
      content: '写了的',
      priority: 2,
      disclosure: '每次',
    })
    // 已过期的不在列表里，也不算；别人的私人层看不到，也不算
    const lapsed = await create(ws.cookie, { uri: 'user://projects/lapsed', content: '到期了' })
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 60_000) })
        .where(eq(memories.id, lapsed.id)),
    )
    await create(editor.cookie, { uri: 'user://home/diary', content: '日记' })
    // 来自对话的记忆（这里是一条受信的会话摘要）优先级也够：它没有坐标，不进启动加载，不在列表里，也不算要补的
    await withSpace(database.db, ws.spaceId, async (tx) =>
      tx.insert(memories).values({
        spaceId: ws.spaceId,
        form: 'extracted',
        layer: 'episode',
        sensitivity: 'public',
        provenance: 'agent',
        conversationId: await summaryConversation(tx, ws.spaceId),
        content: '抽取的摘要',
        priority: 0,
      }),
    )

    const expected = needed.map((m) => m.uri).sort()
    expect((await get<SpaceOverview>(ws.cookie, '/overview')).missingDisclosure).toBe(
      expected.length,
    )
    const flagged = uris(await list(ws.cookie, 'missingDisclosure=true&limit=200')).sort()
    expect(flagged).toEqual(expected)
    // false 列别的那些，两边合起来就是整个列表
    const all = await list(ws.cookie, 'limit=200')
    const rest = uris(await list(ws.cookie, 'missingDisclosure=false&limit=200')).sort()
    expect(rest).toEqual(
      uris(all)
        .filter((uri) => !expected.includes(uri))
        .sort(),
    )
    // 列表筛出来的就是没写触发场景、又不是 isBootCandidate 的（列表只有目录里的记忆）
    const byRule = all.items
      .filter((m) => !m.disclosure?.trim() && !isBootCandidate({ ...m, form: 'curated' }))
      .map((m) => m.uri)
      .sort()
    expect(byRule).toEqual(expected)
    // SQL 的 BOOT_CANDIDATE 和 contracts 的 isBootCandidate 逐行对上，抽取的与看不到的也算在内
    const rows = await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .select({
          form: memories.form,
          layer: memories.layer,
          priority: memories.priority,
          provenance: memories.provenance,
          sensitivity: memories.sensitivity,
          boot: sql<boolean>`${BOOT_CANDIDATE}`,
        })
        .from(memories),
    )
    expect(rows.filter((r) => r.form === 'extracted' && r.layer === 'episode')).toHaveLength(1)
    expect(rows.filter((r) => r.boot).length).toBeGreaterThan(4)
    for (const { boot, ...memory } of rows) expect(isBootCandidate(memory)).toBe(boot)
  })

  it('有已过期的记忆时，概览与实例设置的向量数一样：都只算现在有效的', async () => {
    await saveEmbedding()
    for (const p of ['a', 'b', 'c']) {
      await create(ws.cookie, { uri: `user://kb/${p}`, content: p })
    }
    const lapsed = await create(ws.cookie, { uri: 'core://kb/lapsed', content: '到期了' })
    await create(ws.cookie, { uri: 'user://home/wifi', content: 'hunter2', sensitivity: 'secret' })
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

  it('概览里应用主人停用后 Key 不算有效，重新启用后恢复', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const created = await app.request(
      `${space()}/apps`,
      jsonRequest(
        'POST',
        { slug: 'eve-bot', name: 'eve-bot', runtimeFamily: 'mcp' },
        { cookie: editor.cookie },
      ),
    )
    const eveApp = (await created.json()) as { id: string }
    for (const name of ['k1', 'k2']) {
      const issued = await app.request(
        `${space()}/apps/${eveApp.id}/keys`,
        jsonRequest('POST', { name, scopes: EDITOR_SCOPES }, { cookie: editor.cookie }),
      )
      expect(issued.status).toBe(201)
    }
    await database.db.execute(
      sql`update api_keys set last_used_at = now() where app_id = ${eveApp.id}`,
    )
    const keysOf = async () =>
      (await get<SpaceOverview>(ws.cookie, '/overview')).apps.find((a) => a.slug === 'eve-bot')
        ?.keys
    expect((await keysOf())?.active).toBe(2)

    await database.db
      .update(accounts)
      .set({ disabledAt: sql`now()` })
      .where(eq(accounts.id, editor.accountId))
    expect(await keysOf()).toEqual({ active: 0, lastUsedAt: null })

    await database.db
      .update(accounts)
      .set({ disabledAt: null })
      .where(eq(accounts.id, editor.accountId))
    expect((await keysOf())?.active).toBe(2)
  })

  it('editor 打开概览时应用表只读一次；能写哪些应用的应用层照旧只看自己是不是主人', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    await ws.createApp('owner-bot')
    const created = await app.request(
      `${space()}/apps`,
      jsonRequest(
        'POST',
        { slug: 'eve-bot', name: 'eve-bot', runtimeFamily: 'mcp' },
        { cookie: editor.cookie },
      ),
    )
    expect(created.status).toBe(201)
    const eveApp = (await created.json()) as { id: string }

    // 另起一个记下每条查询的连接，看概览查了几次应用表（待确认的绑定连带着读应用名，是别的表上的查询）
    const queries: string[] = []
    const client = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    const deps = {
      db: drizzle(client, {
        schema,
        casing: 'snake_case',
        logger: { logQuery: (query: string) => void queries.push(query) },
      }),
      cookieSecure: false,
      masterKey: null,
      embedder: staticEmbedderSource(null),
      jobs: null,
    }
    try {
      const res = await createApp(deps).request(`${space()}/overview`, {
        headers: { cookie: editor.cookie },
      })
      expect(res.status).toBe(200)
      expect(queries.filter((q) => q.includes('from "apps"'))).toHaveLength(1)

      // 概览从读出的全部应用里挑，和别的管理界面接口自己查出来的一样
      const all = await withSpace(database.db, ws.spaceId, (tx) => tx.select().from(apps))
      const queried = await memoryServiceForConsole(deps, ws.spaceId, editor.accountId, 'editor')
      const picked = await memoryServiceForConsole(
        deps,
        ws.spaceId,
        editor.accountId,
        'editor',
        all,
      )
      expect(picked.access.writableAppIds).toEqual(new Set([eveApp.id]))
      expect(picked.access).toEqual(queried.access)
    } finally {
      await client.end()
    }
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
    expect(await res.json()).toEqual({ error: expect.stringContaining('未能加入队列') })

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
        queued ? { queued: true } : { error: expect.stringContaining('未能加入队列') },
      )
    }
  })

  it('关键词索引按成员的可见范围：别人的私人层不在里面，secret 的只给能读 secret 的成员', async () => {
    const editor = await seed()
    await create(ws.cookie, {
      uri: 'user://projects/alpha2',
      content: '另一条',
      glossary: ['阿尔法'],
    })
    await create(ws.cookie, {
      uri: 'core://kb/lock',
      content: '锁',
      sensitivity: 'secret',
      glossary: ['门锁'],
    })
    await create(editor.cookie, { uri: 'user://home/e', content: 'E 的', glossary: ['日记本'] })
    type Index = { entries: { keyword: string; uris: string[] }[]; truncated: boolean }
    const index = async (cookie: string) =>
      Object.fromEntries(
        (await get<Index>(cookie, '/memories/glossary')).entries.map((e) => [e.keyword, e.uris]),
      )
    const owner = await index(ws.cookie)
    expect(owner['阿尔法']).toEqual(['user://projects/alpha', 'user://projects/alpha2'])
    expect(owner['门锁']).toEqual(['core://kb/lock'])
    expect(owner['日记本']).toBeUndefined()
    const mine = await index(editor.cookie)
    expect(mine['日记本']).toEqual(['user://home/e'])
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
