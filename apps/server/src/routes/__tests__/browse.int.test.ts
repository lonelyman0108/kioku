import { randomBytes } from 'node:crypto'

import {
  isBootCandidate,
  type CircleOverview,
  type ConsoleEntryView,
  type ConsoleSearchResponse,
  type EmbeddingStatus,
  type EntryBrowseResponse,
  type EntryList,
  type GlossaryIndex,
  type LensKeyScopes,
} from '@kioku/contracts'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database } from '../../db/client'
import * as schema from '../../db/schema'
import { accounts, circleMembers, entries, settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { backfillEmbeddings, embedEntries } from '../../embedding/worker'
import { BOOT_CANDIDATE } from '../../memory/filter'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import {
  openTestDatabase,
  resetDatabase,
  summaryConversation,
  testDatabaseUrl,
} from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const EDITOR_SCOPES: LensKeyScopes = {
  readKinds: ['entry'],
  writeKinds: [],
  maxSensitivity: 'private',
  allowedRealms: null,
  admin: false,
  credentials: 'none',
}

describe.skipIf(!testDatabaseUrl)('管理界面的列表、浏览、搜索与概览', () => {
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
    // 实例设置不挂在记忆圈下，resetDatabase 清不到，嵌入设置要单独清掉
    await database.db.delete(settings)
    ws = await bootstrap(app)
  })

  const circle = (circleId = ws.circleId) => `/v1/circles/${circleId}`
  const create = async (cookie: string, body: Record<string, unknown>, circleId = ws.circleId) => {
    const res = await app.request(
      `${circle(circleId)}/entries`,
      jsonRequest('POST', body, { cookie }),
    )
    expect(res.status).toBe(201)
    return (await res.json()) as ConsoleEntryView
  }
  const get = async <T>(cookie: string, path: string, circleId = ws.circleId) => {
    const res = await app.request(`${circle(circleId)}${path}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    return (await res.json()) as T
  }
  const list = (cookie: string, query = '', circleId = ws.circleId) =>
    get<EntryList>(cookie, `/entries/list${query ? `?${query}` : ''}`, circleId)
  const titles = (l: { items: { title: string }[] }) => l.items.map((i) => i.title)
  const search = async (cookie: string, query: string, circleId = ws.circleId) => {
    const res = await app.request(
      `${circle(circleId)}/entries/search`,
      jsonRequest('POST', { query }, { cookie }),
    )
    expect(res.status).toBe(200)
    return (await res.json()) as ConsoleSearchResponse
  }
  const saveEmbedding = async () => {
    const prov = await app.request(
      '/v1/settings/models/providers',
      jsonRequest(
        'POST',
        {
          name: '嵌入服务商',
          format: 'openai-chat',
          baseUrl: 'https://embed.example.com/v1',
          profiles: [{ kind: 'embedding', model: 'fake-embedding' }],
        },
        { cookie: ws.cookie },
      ),
    )
    expect(prov.status).toBe(201)
    const profileId = ((await prov.json()) as { profiles: { id: string }[] }).profiles[0]!.id
    const res = await app.request(
      '/v1/settings/embedding',
      jsonRequest(
        'PUT',
        { model: 'fake-embedding', profileIds: [profileId] },
        { cookie: ws.cookie },
      ),
    )
    expect(res.status).toBe(200)
  }

  async function seed() {
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const agent = await create(ws.cookie, {
      title: '规则',
      content: '先读正文再信任',
      sensitivity: 'public',
      disclosure: '每次会话开始',
      topics: ['ops'],
    })
    const pref = await create(ws.cookie, {
      title: '偏好',
      content: '回答用中文',
      sensitivity: 'internal',
      disclosure: '和主人协作时',
    })
    const alpha = await create(ws.cookie, {
      title: '阿尔法',
      content: '阿尔法项目的说明',
      topics: ['projects'],
      when: { env: ['prod'] },
      glossary: ['阿尔法'],
    })
    const beta = await create(ws.cookie, {
      title: '贝塔',
      content: '贝塔项目',
      topics: ['projects'],
      disclosure: '提到贝塔时',
    })
    const wifi = await create(ws.cookie, {
      title: '无线密码',
      content: 'hunter2',
      sensitivity: 'secret',
      disclosure: '连无线网时',
    })
    // editor 在自己的个人圈还有一条词条
    const diary = await create(
      editor.cookie,
      { title: '日记', content: '个人日记', glossary: ['日记本'] },
      editor.personalCircleId,
    )
    return { editor, agent, pref, alpha, beta, wifi, diary }
  }

  it('列表按成员权限返回：secret 只有能读 secret 的成员列得出，个人圈各自隔离', async () => {
    const { editor } = await seed()
    expect(titles(await list(ws.cookie)).sort()).toEqual(
      ['偏好', '规则', '贝塔', '阿尔法', '无线密码'].sort(),
    )
    expect(titles(await list(editor.cookie)).sort()).toEqual(
      ['偏好', '规则', '贝塔', '阿尔法'].sort(),
    )
    expect(titles(await list(editor.cookie, '', editor.personalCircleId))).toEqual(['日记'])
    expect(
      (
        await app.request(`${circle(editor.personalCircleId)}/entries/list`, {
          headers: { cookie: ws.cookie },
        })
      ).status,
    ).toBe(403)
  })

  it('列表可以按敏感级、主题、切面、关键字与 disclosure 筛选', async () => {
    await seed()
    expect(titles(await list(ws.cookie, 'sensitivity=secret'))).toEqual(['无线密码'])
    expect(titles(await list(ws.cookie, 'topic=projects')).sort()).toEqual(['贝塔', '阿尔法'])
    expect(titles(await list(ws.cookie, 'dimensionKey=env&termSlug=prod'))).toEqual(['阿尔法'])

    // 关键字同时查标题、disclosure 与非机密正文，不区分大小写；% 与 _ 按字面匹配
    await create(ws.cookie, { title: 'my_notes', content: '下划线标题' })
    await create(ws.cookie, { title: 'myxnotes', content: '字母标题' })
    expect(titles(await list(ws.cookie, `q=${encodeURIComponent('my_notes')}`))).toEqual([
      'my_notes',
    ])
    expect(titles(await list(ws.cookie, `q=${encodeURIComponent('贝塔')}`))).toEqual(['贝塔'])
    expect(titles(await list(ws.cookie, `q=${encodeURIComponent('先读正文')}`))).toEqual(['规则'])
    expect((await list(ws.cookie, `q=${encodeURIComponent('%')}`)).items).toEqual([])
    expect(titles(await list(ws.cookie, 'missingDisclosure=true')).sort()).toEqual(
      ['my_notes', 'myxnotes', '阿尔法'].sort(),
    )
    expect((await list(ws.cookie, 'missingDisclosure=false')).items).toHaveLength(4)
  })

  it('三种排序逐页翻完，不重不漏，顺序与一次取完相同', async () => {
    const items: ConsoleEntryView[] = []
    for (const [i, priority] of [3, 1, 2, 1, 0, 2, 1].entries()) {
      items.push(await create(ws.cookie, { title: `n${i}`, content: `第 ${i} 条`, priority }))
    }
    const same = new Date('2026-01-01T00:00:00.123456Z')
    await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .update(entries)
        .set({ updatedAt: same })
        .where(inArray(entries.id, [items[1]!.id, items[2]!.id, items[3]!.id])),
    )
    const patched = await app.request(
      `${circle()}/entries`,
      jsonRequest('PATCH', { id: items[0]!.shortId, content: '改过' }, { cookie: ws.cookie }),
    )
    expect(patched.status).toBe(200)

    for (const sort of ['updated', 'priority', 'shortId'] as const) {
      const all = titles(await list(ws.cookie, `sort=${sort}&limit=200`))
      expect(all).toHaveLength(7)
      const paged: string[] = []
      let cursor: string | null = null
      do {
        const page: EntryList = await list(
          ws.cookie,
          `sort=${sort}&limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        )
        expect(page.items.length).toBeLessThanOrEqual(3)
        paged.push(...titles(page))
        cursor = page.nextCursor
      } while (cursor)
      expect(paged).toEqual(all)
    }
    expect(titles(await list(ws.cookie, 'sort=updated&limit=1'))).toEqual(['n0'])
    expect((await list(ws.cookie, 'sort=priority&limit=200')).items.map((i) => i.priority)).toEqual(
      [0, 1, 1, 1, 2, 2, 3],
    )
  })

  // 更新时间只按数据库的钟写：新建、修改与跨圈迁移都是。只假造应用的 Date，冻结在快或慢两分钟的那一刻
  for (const [name, skew] of [
    ['快', 120_000],
    ['慢', -120_000],
  ] as const) {
    it(`应用的时钟比数据库${name}两分钟：按更新时间排序就是按改动的先后`, async () => {
      const a = await create(ws.cookie, { title: 'a', content: 'a' })
      const b = await create(ws.cookie, { title: 'b', content: 'b' })
      await create(ws.cookie, { title: 'c', content: 'c' })

      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skew })
      try {
        const patched = await app.request(
          `${circle()}/entries`,
          jsonRequest('PATCH', { id: a.shortId, content: '改过' }, { cookie: ws.cookie }),
        )
        expect(patched.status).toBe(200)
        // 从个人圈迁入当前共享圈，迁移写入也以数据库时钟落盘
        const fromPersonal = await create(
          ws.cookie,
          { title: 'moved', content: '来自个人圈' },
          ws.personalCircleId,
        )
        const moved = await app.request(
          `${circle(ws.personalCircleId)}/entries/transfer`,
          jsonRequest(
            'POST',
            { entryId: fromPersonal.id, toCircleId: ws.circleId },
            { cookie: ws.cookie },
          ),
        )
        expect(moved.status).toBe(200)
        await create(ws.cookie, { title: 'd', content: '最后新建的' })
        expect(b.title).toBe('b')
      } finally {
        vi.useRealTimers()
      }
      expect(titles(await list(ws.cookie, 'sort=updated'))).toEqual(['d', 'moved', 'a', 'c', 'b'])
    })
  }

  it('列表可以按更新时间筛选并精确到微秒', async () => {
    const created: Record<string, ConsoleEntryView> = {}
    for (const name of ['old', 'mid', 'new']) {
      created[name] = await create(ws.cookie, { title: name, content: name })
    }
    const at = (id: string, iso: string) =>
      withCircle(database.db, ws.circleId, (tx) =>
        tx
          .update(entries)
          .set({ updatedAt: new Date(iso) })
          .where(eq(entries.id, id)),
      )
    await at(created.old!.id, '2026-01-01T00:00:00Z')
    await at(created.mid!.id, '2026-02-01T00:00:00Z')
    await at(created.new!.id, '2026-03-01T00:00:00Z')

    const range = (q: string) => list(ws.cookie, `sort=priority&${q}`)
    expect(
      titles(await range(`updatedAfter=${encodeURIComponent('2026-02-01T00:00:00Z')}`)).sort(),
    ).toEqual(['mid', 'new'])
    expect(
      titles(await range(`updatedBefore=${encodeURIComponent('2026-02-01T00:00:00+00:00')}`)),
    ).toEqual(['old'])
    expect(
      (
        await app.request(`${circle()}/entries/list?updatedAfter=yesterday`, {
          headers: { cookie: ws.cookie },
        })
      ).status,
    ).toBe(400)

    await withCircle(database.db, ws.circleId, (tx) =>
      tx.execute(
        sql`update entries set updated_at = '2026-02-01T00:00:00.000200Z' where id = ${created.mid!.id}`,
      ),
    )
    expect(
      titles(
        await range(`updatedBefore=${encodeURIComponent('2026-02-01T00:00:00.000500Z')}`),
      ).sort(),
    ).toEqual(['mid', 'old'])
    expect(
      titles(await range(`updatedAfter=${encodeURIComponent('2026-02-01T00:00:00.000500Z')}`)),
    ).toEqual(['new'])
  })

  it('翻页参数无效时返回 400', async () => {
    const x = await create(ws.cookie, { title: 'x', content: 'x' })
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const validPriorityCursor = encode([0, 'm-222222', '00000000-0000-4000-8000-000000000000'])
    for (const query of [
      'cursor=abc',
      `cursor=${encode([1, 2])}`,
      `cursor=${encode(['1', 'not-a-uuid'])}`,
      `sort=updated&cursor=${validPriorityCursor}`,
      `sort=updated&cursor=${encode(['9999999999999999999', '00000000-0000-4000-8000-000000000000'])}`,
      `sort=priority&cursor=${encode([3000000000, 'm-222222', '00000000-0000-4000-8000-000000000000'])}`,
    ]) {
      const res = await app.request(`${circle()}/entries/list?${query}`, {
        headers: { cookie: ws.cookie },
      })
      expect(res.status).toBe(400)
    }
    expect(titles(await list(ws.cookie, `sort=priority&cursor=${validPriorityCursor}`))).toEqual([
      x.title,
    ])
  })

  it('分组浏览中能读 secret 的 owner 看得到 secret 词条，editor 和 Key 都看不到', async () => {
    const { editor, wifi } = await seed()
    const collect = (b: EntryBrowseResponse) =>
      b.groups.flatMap((g) => g.items.map((i) => i.shortId))

    const ownerBrowse = await get<EntryBrowseResponse>(ws.cookie, '/entries/browse?groupBy=kind')
    expect(collect(ownerBrowse)).toContain(wifi.shortId)
    const editorBrowse = await get<EntryBrowseResponse>(
      editor.cookie,
      '/entries/browse?groupBy=kind',
    )
    expect(collect(editorBrowse)).not.toContain(wifi.shortId)

    // 接入方的 Key 即使是 secret 级，browse 也列不出 secret，只能按短 ID 显式读取
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const keyBrowse = (await (
      await app.request('/v1/entries/browse?groupBy=kind', { headers: bearer(key) })
    ).json()) as EntryBrowseResponse
    expect(collect(keyBrowse)).not.toContain(wifi.shortId)

    const direct = await app.request(`/v1/entries?id=${wifi.shortId}`, { headers: bearer(key) })
    expect(direct.status).toBe(200)
    expect(
      ((await direct.json()) as { variants: { content: string | null }[] }).variants[0]!.content,
    ).toBe('hunter2')
  })

  it('搜索：短 ID 与标题直接命中，召回候选不含 secret，editor 看不到 secret 与他人个人圈', async () => {
    const { editor, alpha, wifi, diary } = await seed()
    const byShortId = await search(ws.cookie, wifi.shortId)
    expect(byShortId.matches.map((m) => m.shortId)).toEqual([wifi.shortId])
    expect(byShortId.candidates.map((c) => c.shortId)).not.toContain(wifi.shortId)

    expect((await search(ws.cookie, '阿尔')).matches.map((m) => m.shortId)).toEqual([alpha.shortId])
    expect(
      (await search(ws.cookie, '阿尔法项目怎么样了')).candidates.map((c) => c.shortId),
    ).toContain(alpha.shortId)
    expect((await search(editor.cookie, wifi.shortId)).matches).toEqual([])
    expect((await search(ws.cookie, diary.shortId)).matches).toEqual([])
    expect(
      (await search(editor.cookie, diary.shortId, editor.personalCircleId)).matches.map(
        (m) => m.shortId,
      ),
    ).toEqual([diary.shortId])
  })

  it('概览按物种与敏感级计数，统计缺 disclosure 与向量覆盖率', async () => {
    const { alpha } = await seed()
    await saveEmbedding()
    await embedEntries(database.db, fakeEmbedder(), ws.circleId, [alpha.id])
    const o = await get<CircleOverview>(ws.cookie, '/overview')
    expect(o.total).toBe(5)
    expect(o.counts.sort((a, b) => a.sensitivity.localeCompare(b.sensitivity))).toEqual([
      { kind: 'entry', sensitivity: 'internal', count: 3 },
      { kind: 'entry', sensitivity: 'public', count: 1 },
      { kind: 'entry', sensitivity: 'secret', count: 1 },
    ])
    expect(o.missingDisclosure).toBe(1)
    expect(o.embedding).toEqual({
      configured: true,
      model: 'fake-embedding',
      eligible: 4,
      embedded: 1,
    })
  })

  it('未设触发场景只算要补的：会进启动加载的不算，机密照算；概览的数字和列表筛选的条数一致', async () => {
    const needed = [
      { title: 'n1', content: '基础 p2' },
      { title: 'n2', content: '私人 p1', priority: 1 },
      { title: 'n3', content: '只有空白', disclosure: '  ' },
      { title: 'n4', content: 'hunter2', sensitivity: 'secret', priority: 0 },
    ]
    const boot = [
      { title: 'b1', content: '启动 p0', priority: 0 },
      { title: 'b2', content: '内部 p0', sensitivity: 'internal', priority: 0, disclosure: '  ' },
    ]
    for (const body of [...needed, ...boot]) await create(ws.cookie, body)
    await create(ws.cookie, {
      title: 'wrote',
      content: '写了的',
      priority: 2,
      disclosure: '每次',
    })

    const lapsed = await create(ws.cookie, { title: 'lapsed', content: '到期了' })
    await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .update(entries)
        .set({ validTo: sql`statement_timestamp() - interval '1 minute'` })
        .where(eq(entries.id, lapsed.id)),
    )
    // 会话摘要不计入 entry 的 missingDisclosure，也不会成为 boot 候选
    await withCircle(database.db, ws.circleId, async (tx) =>
      tx.insert(entries).values({
        circleId: ws.circleId,
        circleKind: 'shared',
        shortId: 'm-ep3333',
        kind: 'episode',
        title: '抽取的摘要',
        sensitivity: 'public',
        provenance: 'agent',
        originScope: 'global',
        conversationId: await summaryConversation(tx, ws.circleId),
        priority: 1,
      }),
    )

    const expectedTitles = needed.map((n) => n.title).sort()
    expect((await get<CircleOverview>(ws.cookie, '/overview')).missingDisclosure).toBe(
      expectedTitles.length,
    )
    expect(titles(await list(ws.cookie, 'missingDisclosure=true&limit=200')).sort()).toEqual(
      expectedTitles,
    )
    const all = await list(ws.cookie, 'kind=entry&limit=200')
    expect(
      titles(await list(ws.cookie, 'missingDisclosure=false&kind=entry&limit=200')).sort(),
    ).toEqual(
      titles(all)
        .filter((t) => !expectedTitles.includes(t))
        .sort(),
    )
    const byRule = all.items
      .filter((m) => !m.disclosure?.trim() && !isBootCandidate(m))
      .map((m) => m.title)
      .sort()
    expect(byRule).toEqual(expectedTitles)

    const rows = await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .select({
          kind: entries.kind,
          priority: entries.priority,
          provenance: entries.provenance,
          sensitivity: entries.sensitivity,
          boot: sql<boolean>`${BOOT_CANDIDATE}`,
        })
        .from(entries)
        .where(and(isNull(entries.deletedAt))),
    )
    for (const { boot: isBoot, ...entry } of rows) {
      expect(isBootCandidate(entry)).toBe(isBoot)
    }
  })

  it('有已过期的词条时，概览与实例设置的向量数一样：都只算现在有效的', async () => {
    await saveEmbedding()
    for (const p of ['a', 'b', 'c']) {
      await create(ws.cookie, { title: p, content: p })
    }
    const lapsed = await create(ws.cookie, { title: 'lapsed', content: '到期了' })
    await create(ws.cookie, { title: 'wifi', content: 'hunter2', sensitivity: 'secret' })
    expect(await backfillEmbeddings(database.db, fakeEmbedder())).toBe(4)

    await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .update(entries)
        .set({ validTo: sql`statement_timestamp() - interval '1 minute'` })
        .where(eq(entries.id, lapsed.id)),
    )

    const overview = (await get<CircleOverview>(ws.cookie, '/overview')).embedding
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

  it('概览里 Key 的使用情况只给接入实例主人与记忆圈 owner 看，吊销、退圈与停用的不算', async () => {
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    await ws.issueKey((await ws.createClient('owner-bot')).id)
    const created = await app.request(
      `${circle()}/clients`,
      jsonRequest(
        'POST',
        { slug: 'eve-bot', name: 'eve-bot', runtimeFamily: 'mcp' },
        { cookie: editor.cookie },
      ),
    )
    expect(created.status).toBe(201)
    const eveClient = (await created.json()) as { id: string }
    const issued = await app.request(
      `${circle()}/clients/${eveClient.id}/keys`,
      jsonRequest('POST', { name: 'k', scopes: EDITOR_SCOPES }, { cookie: editor.cookie }),
    )
    expect(issued.status).toBe(201)
    const revoked = (await issued.json()) as { id: string }

    const keysOf = (o: CircleOverview, slug: string) => o.clients.find((a) => a.slug === slug)?.keys
    const asOwner = await get<CircleOverview>(ws.cookie, '/overview')
    expect(keysOf(asOwner, 'owner-bot')).toEqual({ active: 1, lastUsedAt: null })
    expect(keysOf(asOwner, 'eve-bot')).toEqual({ active: 1, lastUsedAt: null })
    const asEditor = await get<CircleOverview>(editor.cookie, '/overview')
    expect(keysOf(asEditor, 'owner-bot')).toBeNull()
    expect(keysOf(asEditor, 'eve-bot')).toEqual({ active: 1, lastUsedAt: null })

    const revoke = await app.request(`${circle()}/clients/${eveClient.id}/keys/${revoked.id}`, {
      method: 'DELETE',
      headers: { cookie: editor.cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(revoke.status).toBe(204)
    expect(keysOf(await get<CircleOverview>(editor.cookie, '/overview'), 'eve-bot')).toEqual({
      active: 0,
      lastUsedAt: null,
    })

    // 成员离开后旧密钥失效；重新加入后之前签发的也不恢复
    const another = await app.request(
      `${circle()}/clients/${eveClient.id}/keys`,
      jsonRequest('POST', { name: 'k2', scopes: EDITOR_SCOPES }, { cookie: editor.cookie }),
    )
    expect(another.status).toBe(201)
    await database.db
      .delete(circleMembers)
      .where(
        and(eq(circleMembers.circleId, ws.circleId), eq(circleMembers.accountId, editor.accountId)),
      )
    expect(keysOf(await get<CircleOverview>(ws.cookie, '/overview'), 'eve-bot')).toEqual({
      active: 0,
      lastUsedAt: null,
    })
    await database.db
      .insert(circleMembers)
      .values({ circleId: ws.circleId, accountId: editor.accountId, role: 'editor' })
    expect(keysOf(await get<CircleOverview>(ws.cookie, '/overview'), 'eve-bot')?.active).toBe(0)
    expect(keysOf(await get<CircleOverview>(ws.cookie, '/overview'), 'owner-bot')?.active).toBe(1)

    // 主人停用后 Key 失效，恢复后重计
    const k3 = await app.request(
      `${circle()}/clients/${eveClient.id}/keys`,
      jsonRequest('POST', { name: 'k3', scopes: EDITOR_SCOPES }, { cookie: editor.cookie }),
    )
    expect(k3.status).toBe(201)
    await database.db.execute(
      sql`update api_keys set last_used_at = now() where client_id = ${eveClient.id}`,
    )
    await database.db
      .update(accounts)
      .set({ disabledAt: sql`now()` })
      .where(eq(accounts.id, editor.accountId))
    expect(keysOf(await get<CircleOverview>(ws.cookie, '/overview'), 'eve-bot')).toEqual({
      active: 0,
      lastUsedAt: null,
    })
    await database.db
      .update(accounts)
      .set({ disabledAt: null })
      .where(eq(accounts.id, editor.accountId))
    expect(keysOf(await get<CircleOverview>(ws.cookie, '/overview'), 'eve-bot')?.active).toBe(1)
  })

  it('editor 打开概览时接入实例表只读一次', async () => {
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    await ws.createClient('owner-bot')
    const created = await app.request(
      `${circle()}/clients`,
      jsonRequest(
        'POST',
        { slug: 'eve-bot', name: 'eve-bot', runtimeFamily: 'mcp' },
        { cookie: editor.cookie },
      ),
    )
    expect(created.status).toBe(201)

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
      const res = await createApp(deps).request(`${circle()}/overview`, {
        headers: { cookie: editor.cookie },
      })
      expect(res.status).toBe(200)
      expect(queries.filter((q) => q.includes('from "clients"'))).toHaveLength(1)
    } finally {
      await client.end()
    }
  })

  it('实例的向量覆盖率与重建只给实例管理员', async () => {
    const { editor } = await seed()
    const status = (cookie: string) =>
      app.request('/v1/settings/embedding/status', { headers: { cookie } })
    const rebuild = (cookie: string) =>
      app.request('/v1/settings/embedding/rebuild', jsonRequest('POST', {}, { cookie }))
    expect((await status(editor.cookie)).status).toBe(403)
    expect((await rebuild(editor.cookie)).status).toBe(403)
    expect(await (await status(ws.cookie)).json()).toEqual({
      eligible: 5,
      active: null,
      next: null,
      lastError: null,
    })
    expect((await rebuild(ws.cookie)).status).toBe(400)

    await saveEmbedding()
    const res = await rebuild(ws.cookie)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: expect.stringContaining('未能加入队列') })

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

  it('关键词索引按成员可见范围：个人圈各自隔离，secret 只给能读 secret 的成员', async () => {
    const { editor, alpha, diary } = await seed()
    const alpha2 = await create(ws.cookie, {
      title: '阿尔法二',
      content: '另一条',
      glossary: ['阿尔法'],
    })
    const lock = await create(ws.cookie, {
      title: '门锁',
      content: '锁',
      sensitivity: 'secret',
      glossary: ['门锁'],
    })

    const index = async (cookie: string, circleId = ws.circleId) =>
      Object.fromEntries(
        (await get<GlossaryIndex>(cookie, '/entries/glossary', circleId)).entries.map((e) => [
          e.keyword,
          e.shortIds,
        ]),
      )
    const owner = await index(ws.cookie)
    expect(owner['阿尔法']).toEqual([alpha.shortId, alpha2.shortId].sort())
    expect(owner['门锁']).toEqual([lock.shortId])
    expect(owner['日记本']).toBeUndefined()

    const inShared = await index(editor.cookie)
    expect(inShared['阿尔法']).toEqual([alpha.shortId, alpha2.shortId].sort())
    expect(inShared['门锁']).toBeUndefined()

    const inPersonal = await index(editor.cookie, editor.personalCircleId)
    expect(inPersonal['日记本']).toEqual([diary.shortId])
  })

  it('OpenAPI 文档里有列表、浏览、搜索与概览接口', async () => {
    const doc = (await (await app.request('/v1/openapi.json')).json()) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/circles/{circleId}/entries/list',
        '/v1/circles/{circleId}/entries/browse',
        '/v1/circles/{circleId}/entries/search',
        '/v1/circles/{circleId}/entries/glossary',
        '/v1/circles/{circleId}/overview',
        '/v1/settings/embedding/status',
        '/v1/settings/embedding/rebuild',
      ]),
    )
  })
})
