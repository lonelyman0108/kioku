import { randomBytes } from 'node:crypto'

import type {
  ActivityDays,
  ActivityEvent,
  ActivityFacets,
  ActivityItem,
  ActivityList,
  ConsoleEntryView,
  EntryView,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database } from '../../db/client'
import { entries, entryEvents, entryGlossary, entryVariants, subjects } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

type Member = { cookie: string; accountId: string }

describe.skipIf(!testDatabaseUrl)('变更记录的筛选、按天计数与筛选计数', () => {
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
      jobs: {
        enqueueEmbed: () => {},
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
  })

  const circle = () => `/v1/circles/${ws.circleId}`
  const ok = async <T>(res: Response, status = 200) => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const get = (cookie: string, path: string, query: Record<string, string> = {}) =>
    app.request(`${circle()}${path}?${new URLSearchParams(query)}`, { headers: { cookie } })
  const list = async (cookie: string, query: Record<string, string> = {}) => {
    const items: ActivityItem[] = []
    let cursor: string | null = null
    do {
      const page: ActivityList = await ok<ActivityList>(
        await get(cookie, '/activity', { limit: '200', ...query, ...(cursor ? { cursor } : {}) }),
      )
      items.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    return items
  }
  const days = async (cookie: string, query: Record<string, string>) =>
    (await ok<ActivityDays>(await get(cookie, '/activity/days', query))).days
  const facets = async (cookie: string, query: Record<string, string> = {}) =>
    ok<ActivityFacets>(await get(cookie, '/activity/facets', query))
  const create = async (cookie: string, body: Record<string, unknown>) =>
    ok<ConsoleEntryView>(
      await app.request(`${circle()}/entries`, jsonRequest('POST', body, { cookie })),
      201,
    )
  const patch = async (cookie: string, body: Record<string, unknown>) =>
    ok<ConsoleEntryView>(
      await app.request(`${circle()}/entries`, jsonRequest('PATCH', body, { cookie })),
    )
  const remove = async (cookie: string, m: ConsoleEntryView) => {
    const query = `id=${encodeURIComponent(m.shortId)}&expectedVersion=${m.version}`
    const res = await app.request(`${circle()}/entries?${query}`, {
      method: 'DELETE',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(204)
  }
  const setTimes = (ids: number[], at: string) =>
    withCircle(database.db, ws.circleId, (tx) =>
      tx
        .update(entryEvents)
        .set({ createdAt: new Date(at) })
        .where(sql`${entryEvents.id} in ${ids}`),
    )
  const eventIds = (entryId: string) =>
    withCircle(database.db, ws.circleId, async (tx) =>
      (
        await tx
          .select({ id: entryEvents.id })
          .from(entryEvents)
          .where(eq(entryEvents.entryId, entryId))
      ).map((r) => r.id),
    )

  // 构造共享词条、机密、已删除、已过期、转为 secret（对 editor 离开）、联系人事实、Key 与测试台写入
  async function seed() {
    const eve = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const vic = await addMember(database.db, ws.circleId, 'vic', 'viewer')
    const clientId = (await ws.createClient('agent')).id
    const key = await ws.issueKey(clientId)
    const viaKey = async (body: Record<string, unknown>) =>
      ok<EntryView>(await app.request('/v1/entries', jsonRequest('POST', body, bearer(key))), 201)

    const shared = await create(ws.cookie, {
      title: '共享',
      content: '一\n二',
      topics: ['alpha'],
    })
    await patch(ws.cookie, {
      id: shared.shortId,
      content: '一\n三\n四',
      priority: 3,
      topics: ['alpha', 'beta'],
      glossaryAdd: ['词语'],
    })

    const secret = await create(ws.cookie, {
      title: 'vault',
      content: '机密正文',
      sensitivity: 'secret',
    })
    await patch(ws.cookie, { id: secret.shortId, content: '新的机密正文' })

    const eveNote = await create(eve.cookie, { title: 'eve 笔记', content: 'eve 的' })
    await patch(eve.cookie, { id: eveNote.shortId, title: 'eve 笔记新版' })

    const gone = await create(ws.cookie, { title: '要删掉', content: '要删掉' })
    await remove(ws.cookie, gone)

    const stale = await create(ws.cookie, { title: '会过期', content: '会过期' })
    await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .update(entries)
        .set({ validTo: new Date(Date.now() - 60_000) })
        .where(eq(entries.id, stale.id)),
    )

    // eve 建的词条被 owner 升为 secret：对 eve 与 vic 来说是「离开」
    const taken = await create(eve.cookie, {
      title: '将被保护',
      content: '会被隐藏',
      sensitivity: 'internal',
    })
    await patch(ws.cookie, { id: taken.shortId, sensitivity: 'secret' })

    const fromKey = await viaKey({ title: '应用写的', content: '应用写的' })
    const bench = await create(ws.cookie, { title: '测试台样例', content: '测试台' })
    await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .update(entryEvents)
        .set({ context: { bench: { account: ws.accountId, run: 'r-1' } } })
        .where(eq(entryEvents.entryId, bench.id)),
    )

    const factEntry = await withCircle(database.db, ws.circleId, async (tx) => {
      const [sub] = await tx
        .insert(subjects)
        .values({ circleId: ws.circleId, kind: 'person', displayName: '张三' })
        .returning()
      const [f] = await tx
        .insert(entries)
        .values({
          circleId: ws.circleId,
          circleKind: 'shared',
          shortId: 'm-ft2222',
          kind: 'fact',
          title: '喜欢咖啡',
          subjectId: sub!.id,
          subjectKind: 'person',
          sensitivity: 'public',
          provenance: 'owner',
          originScope: 'global',
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId: ws.circleId,
        entryId: f!.id,
        kind: 'fact',
        sensitivity: 'public',
        content: '喜欢咖啡',
      })
      await tx.insert(entryEvents).values({
        circleId: ws.circleId,
        entryId: f!.id,
        shortId: f!.shortId,
        eventType: 'create',
        actorAccountId: ws.accountId,
        provenance: 'owner',
        before: null,
        after: {
          shortId: f!.shortId,
          title: f!.title,
          kind: 'fact',
          sensitivity: 'public',
          priority: 2,
          disclosure: null,
          topics: [],
          realms: [],
          glossary: [],
          variants: [{ when: {}, content: '喜欢咖啡' }],
          version: 1,
          deleted: false,
          validTo: null,
          circleId: ws.circleId,
          originScope: 'global',
          clientId: null,
          ownerAccountId: null,
          subjectKind: 'person',
          deletedAt: null,
          expiresAt: null,
        },
      })
      return f!
    })

    const spread: [string, string][] = [
      [shared.id, '2026-11-01T15:30:00Z'],
      [secret.id, '2026-11-01T16:30:00Z'],
      [eveNote.id, '2026-11-02T03:00:00Z'],
      [gone.id, '2026-11-02T23:59:00Z'],
      [stale.id, '2026-11-03T00:01:00Z'],
      [taken.id, '2026-11-04T12:00:00Z'],
      [fromKey.id, '2026-11-05T08:00:00Z'],
      [bench.id, '2026-11-06T10:00:00Z'],
      [factEntry.id, '2026-11-06T12:00:00Z'],
    ]
    for (const [id, at] of spread) await setTimes(await eventIds(id), at)
    return { eve, vic, clientId, shared, secret, gone, stale, taken, fromKey, bench, factEntry }
  }

  function expectedFacets(items: ActivityItem[], filter: JsFilter) {
    const pass = (i: ActivityItem, skip: keyof JsFilter | null) =>
      (Object.keys(filter) as (keyof JsFilter)[]).every(
        (g) => g === skip || (skip === 'actor' && g === 'exceptActor') || matches(i, g, filter),
      )
    const tally = (keys: string[]) => {
      const counts = new Map<string, number>()
      for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
      return [...counts].sort((a, b) => a[0].localeCompare(b[0]))
    }
    return {
      total: items.filter((i) => pass(i, null)).length,
      actors: tally(items.filter((i) => pass(i, 'actor')).map((i) => i.actorKey)),
      types: tally(items.filter((i) => pass(i, 'type')).map((i) => i.type)),
      kinds: tally(items.filter((i) => pass(i, 'kind')).map((i) => i.kind)),
      fields: tally(
        items
          .filter((i) => pass(i, 'field'))
          .flatMap((i) => (i.changes.length ? i.changes : ['none'])),
      ),
    }
  }
  const facetPairs = (f: ActivityFacets) => ({
    total: f.total,
    actors: f.actors.map((a) => [a.key, a.count] as const).sort((a, b) => a[0].localeCompare(b[0])),
    types: f.types.map((a) => [a.type, a.count] as const).sort((a, b) => a[0].localeCompare(b[0])),
    kinds: f.kinds.map((a) => [a.kind, a.count] as const).sort((a, b) => a[0].localeCompare(b[0])),
    fields: f.fields
      .map((a) => [a.field, a.count] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  })

  it('计数和列表一致：每个成员、每个筛选组合，看不到的不算，离开的照常算', async () => {
    const { eve, vic, clientId, secret, gone, stale, taken, fromKey, bench } = await seed()
    const filters: JsFilter[] = [
      {},
      { type: ['update'] },
      { kind: ['entry'] },
      { kind: ['fact'], type: ['create'] },
      { actor: [`account:${ws.accountId}`] },
      { actor: [`client:${clientId}`, 'bench'] },
      { exceptActor: [`account:${ws.accountId}`], kind: ['entry'] },
      { field: ['content'] },
      { field: ['priority', 'none'] },
      { q: '笔记' },
      { q: gone.shortId },
      { from: '2026-11-02T00:00:00Z', to: '2026-11-05T00:00:00Z' },
      {
        from: '2026-11-01T00:00:00Z',
        to: '2026-11-07T00:00:00Z',
        type: ['update'],
        field: ['content'],
      },
    ]
    const ids = (items: ActivityItem[]) => items.map((i) => i.id)
    for (const member of [ws as Member, eve, vic]) {
      const all = await list(member.cookie)
      for (const filter of filters) {
        const query = toQuery(filter)
        const want = all.filter((i) =>
          (Object.keys(filter) as (keyof JsFilter)[]).every((g) => matches(i, g, filter)),
        )
        expect(ids(await list(member.cookie, query)), JSON.stringify(filter)).toEqual(ids(want))
        expect(facetPairs(await facets(member.cookie, query)), JSON.stringify(filter)).toEqual(
          expectedFacets(all, filter),
        )
        const perDay = new Map<string, number>()
        for (const i of want) {
          const day = i.createdAt.slice(0, 10)
          perDay.set(day, (perDay.get(day) ?? 0) + 1)
        }
        expect(await days(member.cookie, { ...query, tz: 'UTC' })).toEqual(
          [...perDay].sort().map(([day, count]) => ({ day, count })),
        )
      }
    }

    const alice = await list(ws.cookie)
    const eveItems = await list(eve.cookie)
    const vicItems = await list(vic.cookie)
    expect(eveItems.some((i) => i.shortId === secret.shortId)).toBe(false)
    expect(alice.some((i) => i.shortId === secret.shortId)).toBe(true)
    const left = eveItems.find((i) => i.shortId === taken.shortId && i.left)!
    expect(left).toMatchObject({ kind: 'entry', changes: [] })
    expect(left.fieldChanges).toEqual([])
    expect(vicItems.some((i) => i.shortId === taken.shortId && i.left)).toBe(true)
    expect(alice.some((i) => i.shortId === taken.shortId && !i.left)).toBe(true)
    expect(alice.find((i) => i.shortId === gone.shortId)?.deleted).toBe(true)
    expect(alice.find((i) => i.shortId === stale.shortId)?.expired).toBe(true)
    expect(alice.find((i) => i.shortId === bench.shortId)?.actorKey).toBe('bench')
    expect(alice.find((i) => i.shortId === fromKey.shortId)?.actorKey).toBe(`client:${clientId}`)
  })

  it('按时区分天：零点前后的事件分在各自的那一天', async () => {
    await seed()
    const range = { from: '2026-11-01T00:00:00Z', to: '2026-11-07T00:00:00Z' }
    const shanghai = await days(ws.cookie, { ...range, tz: 'Asia/Shanghai' })
    const utc = await days(ws.cookie, { ...range, tz: 'UTC' })
    const la = await days(ws.cookie, { ...range, tz: 'America/Los_Angeles' })
    expect(utc.find((d) => d.day === '2026-11-01')!.count).toBe(4)
    expect(shanghai.find((d) => d.day === '2026-11-01')!.count).toBe(2)
    expect(shanghai.find((d) => d.day === '2026-11-02')!.count).toBe(4)
    expect(la.find((d) => d.day === '2026-11-03')).toBeUndefined()
    const total = (list: ActivityDays['days']) => list.reduce((sum, d) => sum + d.count, 0)
    expect(total(shanghai)).toBe(total(utc))
    expect(total(la)).toBe(total(utc))
  })

  it('改动字段的 SQL 判断和 JS 的 changedFields 逐条一致', async () => {
    const m = await create(ws.cookie, { title: 'fields', content: '一' })
    const [r, gRows] = await withCircle(database.db, ws.circleId, async (tx) => [
      (await tx.select().from(entries).where(eq(entries.id, m.id)))[0]!,
      await tx
        .select({ keyword: entryGlossary.keyword })
        .from(entryGlossary)
        .where(eq(entryGlossary.entryId, m.id)),
    ])
    const base: Record<string, unknown> = JSON.parse(
      JSON.stringify({
        shortId: r.shortId,
        title: r.title,
        kind: r.kind,
        sensitivity: r.sensitivity,
        priority: r.priority,
        disclosure: r.disclosure,
        topics: r.topics,
        realms: r.realms,
        glossary: ['a'],
        variants: [{ when: {}, whenSignature: '{}', content: '一' }],
        version: r.version,
        deleted: false,
        validTo: null,
        circleId: r.circleId,
        originScope: r.originScope,
        clientId: r.clientId,
        ownerAccountId: r.ownerAccountId,
        subjectKind: r.subjectKind,
        deletedAt: null,
        expiresAt: null,
      }),
    )
    expect(gRows).toEqual([])
    const variants: Record<string, unknown>[] = [
      {},
      { title: 'x' },
      { title: null },
      { title: 3 },
      { sensitivity: 'private' },
      { priority: 1 },
      { priority: '1' },
      { priority: null },
      { disclosure: '当' },
      { topics: [] },
      { topics: ['a', 'b'] },
      { topics: ['b', 'a'] },
      { glossary: [] },
      { glossary: ['a', 'b'] },
      { glossary: ['b', 'a'] },
      { glossary: ['a', 1] },
      { glossary: 'a' },
      { variants: [{ when: {}, whenSignature: '{}', content: null }] },
      { variants: [{ when: {}, whenSignature: '{}', content: '二' }] },
      { variants: [{ when: { env: ['prod'] }, whenSignature: '{"env":["prod"]}', content: '一' }] },
      { validTo: '2030-01-01T00:00:00.000Z' },
    ]
    await withCircle(database.db, ws.circleId, async (tx) => {
      for (const b of variants) {
        for (const a of variants) {
          await tx.insert(entryEvents).values({
            circleId: ws.circleId,
            entryId: m.id,
            shortId: m.shortId,
            eventType: 'update',
            provenance: 'owner',
            before: { ...base, ...b },
            after: { ...base, ...a },
          })
        }
      }
    })
    const all = await list(ws.cookie)
    expect(all.length).toBe(variants.length ** 2 + 1)
    const fields = [
      'content',
      'title',
      'variants',
      'topics',
      'disclosure',
      'priority',
      'sensitivity',
      'glossary',
      'validTo',
      'none',
    ]
    const count = new Map<string, number>()
    for (const field of fields) {
      const want = all
        .filter((i) => (field === 'none' ? !i.changes.length : i.changes.includes(field)))
        .map((i) => i.id)
      count.set(field, want.length)
      expect(
        (await list(ws.cookie, { field })).map((i) => i.id),
        field,
      ).toEqual(want)
    }
    for (const field of fields) {
      expect(count.get(field), field).toBeGreaterThan(0)
      expect(count.get(field), field).toBeLessThan(all.length)
    }
  })

  it('字段的前后值：正文给增删行数，机密不给，主题与关键词给增删词，变体给增删改，标量给前后', async () => {
    const m = await create(ws.cookie, {
      title: '旧标题',
      content: '一\n二\n三',
      topics: ['t1'],
      glossary: ['甲方', '乙方'],
    })
    await patch(ws.cookie, {
      id: m.shortId,
      content: '一\n二改\n三\n四',
      title: '新标题',
      priority: 4,
      disclosure: '写代码时',
      topics: ['t2'],
      glossaryAdd: ['丙方'],
      glossaryRemove: ['甲方'],
    })
    const [edit] = await list(ws.cookie)
    expect(edit!.fieldChanges).toEqual(
      expect.arrayContaining([
        { field: 'content', added: 2, removed: 1 },
        { field: 'title', before: '旧标题', after: '新标题' },
        { field: 'priority', before: m.priority, after: 4 },
        { field: 'disclosure', before: null, after: '写代码时' },
        { field: 'topics', added: ['t2'], removed: ['t1'] },
        { field: 'glossary', added: ['丙方'], removed: ['甲方'] },
      ]),
    )
    expect(edit!.fieldChanges.map((c) => c.field)).toEqual(edit!.changes)
    expect(edit).toMatchObject({ versionBefore: 1, versionAfter: 2 })

    const s = await create(ws.cookie, {
      title: 'vault',
      content: '明文',
      sensitivity: 'internal',
    })
    await patch(ws.cookie, { id: s.shortId, sensitivity: 'secret' })
    await patch(ws.cookie, { id: s.shortId, content: '机密之后' })
    await patch(ws.cookie, { id: s.shortId, sensitivity: 'private' })
    const [down, inSecret, toSecret] = await list(ws.cookie, { q: s.shortId })
    expect(toSecret!.fieldChanges).toEqual([
      { field: 'sensitivity', before: 'internal', after: 'secret' },
    ])
    expect(inSecret!.changes).toEqual([])
    expect(down!.fieldChanges).toEqual([
      { field: 'sensitivity', before: 'secret', after: 'private' },
      { field: 'content', added: null, removed: null },
    ])
  })

  it('单条改动：和列表同样的可见性，带前后快照；看不到的 404，离开的只给改前，机密没有正文', async () => {
    const eve = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const event = (cookie: string, id: number) => get(cookie, `/activity/${id}`)
    const shared = await create(ws.cookie, { title: 'one', content: '一\n二' })
    await patch(ws.cookie, { id: shared.shortId, content: '一\n三' })
    const [edit] = await list(ws.cookie, { q: shared.shortId })
    const body = await ok<ActivityEvent>(await event(ws.cookie, edit!.id))
    expect(body.item).toEqual(edit)
    expect(body.before?.variants[0]!.content).toBe('一\n二')
    expect(body.after?.variants[0]!.content).toBe('一\n三')

    expect((await event(ws.cookie, 999_999_999)).status).toBe(404)

    const vault = await create(ws.cookie, {
      title: 'vault',
      content: '机密正文',
      sensitivity: 'secret',
    })
    await patch(ws.cookie, { id: vault.shortId, content: '新的机密正文' })
    const [secretEdit] = await list(ws.cookie, { q: vault.shortId })
    const secretBody = await ok<ActivityEvent>(await event(ws.cookie, secretEdit!.id))
    expect(secretBody.before?.variants[0]!.content).toBeNull()
    expect(secretBody.after?.variants[0]!.content).toBeNull()
    expect((await event(eve.cookie, secretEdit!.id)).status).toBe(404)

    const taken = await create(eve.cookie, {
      title: 'taken',
      content: '会被隐藏',
      sensitivity: 'internal',
    })
    await patch(ws.cookie, { id: taken.shortId, sensitivity: 'secret' })
    const [leftItem] = (await list(eve.cookie, { q: taken.shortId })).filter((i) => i.left)
    const leftBody = await ok<ActivityEvent>(await event(eve.cookie, leftItem!.id))
    expect(leftBody.item.left).toBe(true)
    expect(leftBody.before?.shortId).toBe(taken.shortId)
    expect(leftBody.after).toBeNull()

    const [access] = await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .insert(entryEvents)
        .values({
          circleId: ws.circleId,
          entryId: shared.id,
          shortId: shared.shortId,
          eventType: 'access',
          provenance: 'owner',
          before: null,
          after: null,
        })
        .returning(),
    )
    expect((await event(ws.cookie, access!.id)).status).toBe(404)
    expect((await get(ws.cookie, '/activity/abc')).status).toBe(400)
  })

  it('查看者也能看；访问密钥的名字只给接入实例主人与记忆圈 owner，计数按接入实例分组', async () => {
    const eve = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const vic = await addMember(database.db, ws.circleId, 'vic', 'viewer')
    const clientId = (await ws.createClient('agent')).id
    const key = await ws.issueKey(clientId)
    await ok(
      await app.request(
        '/v1/entries',
        jsonRequest('POST', { title: 'k', content: '应用写的' }, bearer(key)),
      ),
      201,
    )
    for (const member of [eve, vic]) {
      const [item] = await list(member.cookie)
      expect(item!.actor).toEqual({ accountName: null, keyName: null, clientName: 'agent' })
      const f = await facets(member.cookie)
      expect(f.actors).toEqual([
        { key: `client:${clientId}`, kind: 'client', name: 'agent', count: 1 },
      ])
    }
    expect((await list(ws.cookie))[0]!.actor.keyName).toBe('test')
  })

  it('参数不对时 400', async () => {
    const bad: Record<string, string>[] = [
      { type: 'access' },
      { actor: 'key:1' },
      { kind: 'nope' },
      { field: 'version' },
      { q: 'x'.repeat(101) },
      { from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' },
      { from: '2025-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z' },
      { from: 'yesterday' },
    ]
    for (const query of bad) {
      expect((await get(ws.cookie, '/activity', query)).status, JSON.stringify(query)).toBe(400)
      expect((await get(ws.cookie, '/activity/facets', query)).status).toBe(400)
    }
    expect((await get(ws.cookie, '/activity/days', {})).status).toBe(400)
    for (const tz of ['Mars/Base', 'America/Nowhere']) {
      const res = await get(ws.cookie, '/activity/days', { tz })
      expect(res.status, tz).toBe(400)
      expect(((await res.json()) as { code?: string }).code).toBe('unknown_time_zone')
    }
    for (const tz of ["UTC'; select 1", '+08', 'UTC+8']) {
      const res = await get(ws.cookie, '/activity/days', { tz })
      expect(res.status, tz).toBe(400)
      expect(((await res.json()) as { code?: string }).code, tz).toBeUndefined()
    }
    const window = { from: '2026-11-01T00:00:00Z', to: '2026-11-03T00:00:00Z' }
    for (const tz of ['UTC', 'Asia/Shanghai', 'America/Argentina/Buenos_Aires', 'Etc/UTC']) {
      expect((await get(ws.cookie, '/activity/days', { ...window, tz })).status, tz).toBe(200)
    }
    const etcEntry = await create(ws.cookie, { title: 'etc', content: '一' })
    const etc = await list(ws.cookie, { q: etcEntry.shortId })
    await setTimes(
      etc.map((i) => i.id),
      '2026-11-01T16:30:00Z',
    )
    expect(await days(ws.cookie, { ...window, q: etcEntry.shortId, tz: 'Etc/GMT-8' })).toEqual([
      { day: '2026-11-02', count: 1 },
    ])
    const berlin = { from: '2025-09-30T22:00:00Z', to: '2026-11-04T23:00:00Z' }
    expect((await get(ws.cookie, '/activity', berlin)).status).toBe(200)
    expect(
      (await get(ws.cookie, '/activity/days', { ...berlin, tz: 'Europe/Berlin' })).status,
    ).toBe(200)

    await create(ws.cookie, { title: 'prefix_a_b', content: '一' })
    await create(ws.cookie, { title: 'prefix_axb', content: '一' })
    expect((await list(ws.cookie, { q: 'a_b' })).map((i) => i.title)).toEqual(['prefix_a_b'])
    expect(await list(ws.cookie, { q: '%' })).toEqual([])
  })
})

interface JsFilter {
  from?: string
  to?: string
  actor?: string[]
  exceptActor?: string[]
  type?: string[]
  kind?: string[]
  field?: string[]
  q?: string
}

function toQuery(filter: JsFilter): Record<string, string> {
  return Object.fromEntries(
    Object.entries(filter).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
  )
}

function matches(i: ActivityItem, group: keyof JsFilter, filter: JsFilter): boolean {
  switch (group) {
    case 'from':
      return Date.parse(i.createdAt) >= Date.parse(filter.from!)
    case 'to':
      return Date.parse(i.createdAt) < Date.parse(filter.to!)
    case 'actor':
      return filter.actor!.includes(i.actorKey)
    case 'exceptActor':
      return !filter.exceptActor!.includes(i.actorKey)
    case 'type':
      return filter.type!.includes(i.type)
    case 'kind':
      return filter.kind!.includes(i.kind)
    case 'field':
      return i.changes.length
        ? i.changes.some((c) => filter.field!.includes(c))
        : filter.field!.includes('none')
    case 'q': {
      const q = filter.q!.toLowerCase()
      return i.title.toLowerCase().includes(q) || i.shortId.toLowerCase().includes(q)
    }
  }
}
