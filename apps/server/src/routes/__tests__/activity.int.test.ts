import { randomBytes } from 'node:crypto'

import type {
  ActivityDays,
  ActivityEvent,
  ActivityFacets,
  ActivityItem,
  ActivityList,
  MemoryView,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memories, memoryEvents } from '../../db/schema'
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

  const space = () => `/v1/spaces/${ws.spaceId}`
  const ok = async <T>(res: Response, status = 200) => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const get = (cookie: string, path: string, query: Record<string, string> = {}) =>
    app.request(`${space()}${path}?${new URLSearchParams(query)}`, { headers: { cookie } })
  // 一页一页读完
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
    ok<MemoryView>(
      await app.request(`${space()}/memories`, jsonRequest('POST', body, { cookie })),
      201,
    )
  const patch = async (cookie: string, body: Record<string, unknown>) =>
    ok<MemoryView>(await app.request(`${space()}/memories`, jsonRequest('PATCH', body, { cookie })))
  const move = async (cookie: string, from: string, to: string) =>
    ok<MemoryView>(
      await app.request(`${space()}/memories/move`, jsonRequest('POST', { from, to }, { cookie })),
    )
  const remove = async (cookie: string, m: MemoryView) => {
    const query = `uri=${encodeURIComponent(m.uri)}&expectedId=${m.id}&expectedVersion=${m.version}`
    const res = await app.request(`${space()}/memories?${query}`, {
      method: 'DELETE',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(204)
  }
  const setTimes = (ids: number[], at: string) =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memoryEvents)
        .set({ createdAt: new Date(at) })
        .where(sql`${memoryEvents.id} in ${ids}`),
    )
  const eventIds = (memoryId: string) =>
    withSpace(database.db, ws.spaceId, async (tx) =>
      (
        await tx
          .select({ id: memoryEvents.id })
          .from(memoryEvents)
          .where(eq(memoryEvents.memoryId, memoryId))
      ).map((r) => r.id),
    )

  // 一个空间里各种情况都有一点：共享的、本人的（两个成员的）、机密、删除、过期、移进别人的本人（离开）、
  // 通过访问密钥写的、测试台写的
  async function seed() {
    const eve = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const vic = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
    const appId = (await ws.createApp('agent')).id
    const key = await ws.issueKey(appId)
    const viaKey = async (body: Record<string, unknown>) =>
      ok<MemoryView>(await app.request('/v1/memories', jsonRequest('POST', body, bearer(key))), 201)
    const shared = await create(ws.cookie, {
      uri: 'core://kb/shared',
      content: '一\n二',
      title: '共享',
    })
    await patch(ws.cookie, {
      uri: shared.uri,
      content: '一\n三\n四',
      priority: 3,
      glossaryAdd: ['词语'],
    })
    const secret = await create(ws.cookie, {
      uri: 'core://kb/vault',
      content: '机密正文',
      sensitivity: 'secret',
    })
    await patch(ws.cookie, { uri: secret.uri, content: '新的机密正文' })
    const mine = await create(ws.cookie, { uri: 'user://notes/alice', content: 'alice 的' })
    const theirs = await create(eve.cookie, { uri: 'user://notes/eve', content: 'eve 的' })
    await patch(eve.cookie, { uri: theirs.uri, title: 'eve 的笔记' })
    const gone = await create(ws.cookie, { uri: 'core://kb/gone', content: '要删掉' })
    await remove(ws.cookie, gone)
    const stale = await create(ws.cookie, { uri: 'core://kb/stale', content: '会过期' })
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 60_000) })
        .where(eq(memories.id, stale.id)),
    )
    // eve 把共享的记忆移进自己的本人：对别人是离开
    const taken = await create(ws.cookie, {
      uri: 'core://kb/taken',
      content: '会被移走',
      sensitivity: 'internal',
    })
    await move(eve.cookie, taken.uri, 'user://notes/taken')
    await viaKey({ uri: 'core://kb/agent', content: '应用写的' })
    const bench = await create(ws.cookie, { uri: 'core://bench/sample', content: '测试台' })
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memoryEvents)
        .set({ context: { bench: { account: ws.accountId, run: 'r-1' } } })
        .where(eq(memoryEvents.memoryId, bench.id)),
    )
    // 分散到几天：每条记忆的事件放在不同的日子，零点前后都有
    const spread: [string, string][] = [
      [shared.id, '2026-11-01T15:30:00Z'],
      [secret.id, '2026-11-01T16:30:00Z'],
      [mine.id, '2026-11-02T03:00:00Z'],
      [theirs.id, '2026-11-02T23:59:00Z'],
      [gone.id, '2026-11-03T00:01:00Z'],
      [stale.id, '2026-11-04T12:00:00Z'],
      [taken.id, '2026-11-05T08:00:00Z'],
      [bench.id, '2026-11-06T10:00:00Z'],
    ]
    for (const [id, at] of spread) await setTimes(await eventIds(id), at)
    return { eve, vic, appId }
  }

  // 按列表算出的筛选计数：每一组在除了它自己以外的筛选下
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
      layers: tally(items.filter((i) => pass(i, 'layer')).map((i) => i.layer)),
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
    layers: f.layers
      .map((a) => [a.layer, a.count] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
    fields: f.fields
      .map((a) => [a.field, a.count] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  })

  it('计数和列表一致：每个成员、每个筛选组合，看不到的不算，离开的照常算', async () => {
    const { eve, vic, appId } = await seed()
    const filters: JsFilter[] = [
      {},
      { type: ['update'] },
      { layer: ['core'] },
      { layer: ['user'], type: ['create', 'move'] },
      { actor: [`account:${ws.accountId}`] },
      { actor: [`app:${appId}`, 'bench'] },
      { exceptActor: [`account:${ws.accountId}`], layer: ['core'] },
      { field: ['content'] },
      { field: ['priority', 'none'] },
      { q: 'kb/s' },
      { q: '笔记', layer: ['user'] },
      { from: '2026-11-02T00:00:00Z', to: '2026-11-04T00:00:00Z' },
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

    // 各个成员看到的确实不同：别人的本人、机密只有读得到的人有，离开的只给改前看得到的
    const alice = await list(ws.cookie)
    const eveItems = await list(eve.cookie)
    const vicItems = await list(vic.cookie)
    expect(alice.some((i) => i.uri === 'user://notes/eve')).toBe(false)
    expect(eveItems.some((i) => i.uri === 'user://notes/alice')).toBe(false)
    expect(eveItems.some((i) => i.uri === 'core://kb/vault')).toBe(false)
    expect(alice.some((i) => i.uri === 'core://kb/vault')).toBe(true)
    const left = alice.find((i) => i.left)!
    expect(left).toMatchObject({ uri: 'core://kb/taken', layer: 'core', changes: [] })
    expect(left.fieldChanges).toEqual([])
    expect(vicItems.some((i) => i.left)).toBe(true)
    expect(eveItems.some((i) => i.uri === 'user://notes/taken' && !i.left)).toBe(true)
    expect(alice.find((i) => i.uri === 'core://kb/gone')?.deleted).toBe(true)
    expect(alice.find((i) => i.uri === 'core://kb/stale')?.expired).toBe(true)
    expect(alice.find((i) => i.uri === 'core://bench/sample')?.actorKey).toBe('bench')
    expect(alice.find((i) => i.uri === 'core://kb/agent')?.actorKey).toBe(`app:${appId}`)
  })

  it('按时区分天：零点前后的事件分在各自的那一天', async () => {
    await seed()
    const range = { from: '2026-11-01T00:00:00Z', to: '2026-11-07T00:00:00Z' }
    const shanghai = await days(ws.cookie, { ...range, tz: 'Asia/Shanghai' })
    const utc = await days(ws.cookie, { ...range, tz: 'UTC' })
    const la = await days(ws.cookie, { ...range, tz: 'America/Los_Angeles' })
    // 11-01 15:30Z 与 16:30Z 各两条：上海是 11-01 23:30 与 11-02 00:30；11-02 03:00Z 一条是上海的 11-02
    expect(utc.find((d) => d.day === '2026-11-01')!.count).toBe(4)
    expect(shanghai.find((d) => d.day === '2026-11-01')!.count).toBe(2)
    expect(shanghai.find((d) => d.day === '2026-11-02')!.count).toBe(3)
    // 洛杉矶 11-03 00:01Z 是 11-02 17:01
    expect(la.find((d) => d.day === '2026-11-03')).toBeUndefined()
    const total = (list: ActivityDays['days']) => list.reduce((sum, d) => sum + d.count, 0)
    expect(total(shanghai)).toBe(total(utc))
    expect(total(la)).toBe(total(utc))
  })

  it('改动字段的 SQL 判断和 JS 的 changedFields 逐条一致', async () => {
    const m = await create(ws.cookie, { uri: 'core://kb/fields', content: '一' })
    const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memories).where(eq(memories.id, m.id)),
    )
    const base: Record<string, unknown> = JSON.parse(JSON.stringify({ ...row, glossary: ['a'] }))
    for (const k of ['ciphertext', 'wrappedKey', 'keyId', 'fts', 'plaintextIgnoredHash'])
      delete base[k]
    const variants: Record<string, unknown>[] = [
      {},
      { domain: 'core', path: 'kb/other' },
      { path: null },
      { title: 'x' },
      { title: null },
      { title: 3 },
      { sensitivity: 'private' },
      { priority: 2 },
      { priority: '2' },
      { priority: null },
      { disclosure: '当' },
      { glossary: [] },
      { glossary: ['a', 'b'] },
      { glossary: ['b', 'a'] },
      { glossary: ['a', 1] },
      { glossary: 'a' },
      { content: null },
      { content: '二' },
      { content: 1 },
      { validTo: '2030-01-01T00:00:00.000Z' },
    ]
    await withSpace(database.db, ws.spaceId, async (tx) => {
      for (const b of variants) {
        for (const a of variants) {
          await tx.insert(memoryEvents).values({
            spaceId: ws.spaceId,
            memoryId: m.id,
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
      'disclosure',
      'priority',
      'sensitivity',
      'layer',
      'uri',
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
    // 每一种都既有改了的、也有没改的（layer 在这里不变，只有没改的）
    for (const field of fields.filter((f) => f !== 'layer')) {
      expect(count.get(field), field).toBeGreaterThan(0)
      expect(count.get(field), field).toBeLessThan(all.length)
    }
  })

  it('字段的前后值：正文给增删行数，机密不给，关键词给增删的词，标量给前后', async () => {
    const m = await create(ws.cookie, {
      uri: 'core://kb/values',
      content: '一\n二\n三',
      title: '旧标题',
      glossary: ['甲方', '乙方'],
    })
    await patch(ws.cookie, {
      uri: m.uri,
      content: '一\n二改\n三\n四',
      title: '新标题',
      priority: 4,
      disclosure: '写代码时',
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
        { field: 'glossary', added: ['丙方'], removed: ['甲方'] },
      ]),
    )
    expect(edit!.fieldChanges.map((c) => c.field)).toEqual(edit!.changes)
    expect(edit).toMatchObject({ versionBefore: 1, versionAfter: 2 })

    // 机密：改成机密时之前快照里的正文抹掉，机密期间的改动看不出正文改没改；从机密降回来时正文只给字段名
    const s = await create(ws.cookie, {
      uri: 'core://kb/vault',
      content: '明文',
      sensitivity: 'internal',
    })
    await patch(ws.cookie, { uri: s.uri, sensitivity: 'secret' })
    await patch(ws.cookie, { uri: s.uri, content: '机密之后' })
    await patch(ws.cookie, { uri: s.uri, sensitivity: 'private' })
    const [down, inSecret, toSecret] = await list(ws.cookie, { q: 'vault' })
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
    const eve = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const event = (cookie: string, id: number) => get(cookie, `/activity/${id}`)
    const shared = await create(ws.cookie, { uri: 'core://kb/one', content: '一\n二' })
    await patch(ws.cookie, { uri: shared.uri, content: '一\n三' })
    const [edit] = await list(ws.cookie, { q: 'kb/one' })
    const body = await ok<ActivityEvent>(await event(ws.cookie, edit!.id))
    expect(body.item).toEqual(edit)
    expect(body.before?.content).toBe('一\n二')
    expect(body.after?.content).toBe('一\n三')

    // 别的成员的本人记忆：和不存在一样
    const theirs = await create(eve.cookie, { uri: 'user://notes/eve', content: 'eve 的' })
    const [theirEvent] = await list(eve.cookie, { q: 'notes/eve' })
    expect(theirEvent!.memoryId).toBe(theirs.id)
    expect((await event(ws.cookie, theirEvent!.id)).status).toBe(404)
    expect((await event(eve.cookie, theirEvent!.id)).status).toBe(200)
    expect((await event(ws.cookie, 999_999_999)).status).toBe(404)

    // 机密：快照里没有正文
    const vault = await create(ws.cookie, {
      uri: 'core://kb/vault',
      content: '机密正文',
      sensitivity: 'secret',
    })
    await patch(ws.cookie, { uri: vault.uri, content: '新的机密正文' })
    const [secretEdit] = await list(ws.cookie, { q: 'kb/vault' })
    const secretBody = await ok<ActivityEvent>(await event(ws.cookie, secretEdit!.id))
    expect(secretBody.before?.content).toBeNull()
    expect(secretBody.after?.content).toBeNull()
    expect((await event(eve.cookie, secretEdit!.id)).status).toBe(404)

    // 离开：eve 把共享的移进自己的本人，对 alice 只给改前
    const taken = await create(ws.cookie, {
      uri: 'core://kb/taken',
      content: '会被移走',
      sensitivity: 'internal',
    })
    await move(eve.cookie, taken.uri, 'user://notes/taken')
    const [leftItem] = (await list(ws.cookie, { q: 'kb/taken' })).filter((i) => i.left)
    const leftBody = await ok<ActivityEvent>(await event(ws.cookie, leftItem!.id))
    expect(leftBody.item.left).toBe(true)
    expect(leftBody.before?.uri).toBe('core://kb/taken')
    expect(leftBody.after).toBeNull()

    // 访问事件不进变更记录
    const [access] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .insert(memoryEvents)
        .values({
          spaceId: ws.spaceId,
          memoryId: shared.id,
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

  it('查看者也能看；访问密钥的名字只给应用所有者与空间所有者，计数按应用分组', async () => {
    const eve = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const vic = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
    const appId = (await ws.createApp('agent')).id
    const key = await ws.issueKey(appId)
    await ok(
      await app.request(
        '/v1/memories',
        jsonRequest('POST', { uri: 'core://kb/k', content: '应用写的' }, bearer(key)),
      ),
      201,
    )
    for (const member of [eve, vic]) {
      const [item] = await list(member.cookie)
      expect(item!.actor).toEqual({ accountName: null, keyName: null, appName: 'agent' })
      const f = await facets(member.cookie)
      expect(f.actors).toEqual([{ key: `app:${appId}`, kind: 'app', name: 'agent', count: 1 }])
    }
    expect((await list(ws.cookie))[0]!.actor.keyName).toBe('test')
  })

  it('参数不对时 400', async () => {
    const bad: Record<string, string>[] = [
      { type: 'access' },
      { actor: 'key:1' },
      { layer: 'nope' },
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
    // 时区以 PostgreSQL 的时区库为准：库里没有的名字回 400，不落到 at time zone 报错成 500；
    // 库里没有的名字带上 code，界面只在这种 400 时退回 UTC
    for (const tz of ['Mars/Base', 'America/Nowhere']) {
      const res = await get(ws.cookie, '/activity/days', { tz })
      expect(res.status, tz).toBe(400)
      expect(((await res.json()) as { code?: string }).code).toBe('unknown_time_zone')
    }
    // 裸偏移写法在 PostgreSQL 里正负号相反，写法本身就不收，这种 400 不带 code
    for (const tz of ["UTC'; select 1", '+08', 'UTC+8']) {
      const res = await get(ws.cookie, '/activity/days', { tz })
      expect(res.status, tz).toBe(400)
      expect(((await res.json()) as { code?: string }).code, tz).toBeUndefined()
    }
    const window = { from: '2026-11-01T00:00:00Z', to: '2026-11-03T00:00:00Z' }
    for (const tz of ['UTC', 'Asia/Shanghai', 'America/Argentina/Buenos_Aires', 'Etc/UTC']) {
      expect((await get(ws.cookie, '/activity/days', { ...window, tz })).status, tz).toBe(200)
    }
    // IANA 的 Etc/GMT-8 在 PostgreSQL 里就是 UTC+8，和浏览器一样：UTC 16:30 分到第二天
    await create(ws.cookie, { uri: 'core://kb/etc', content: '一' })
    const etc = await list(ws.cookie, { q: 'kb/etc' })
    await setTimes(
      etc.map((i) => i.id),
      '2026-11-01T16:30:00Z',
    )
    expect(await days(ws.cookie, { ...window, q: 'kb/etc', tz: 'Etc/GMT-8' })).toEqual([
      { day: '2026-11-02', count: 1 },
    ])
    // 跨过夏令时回拨的 400 个本地日比 400×24 小时多一个小时，照样收
    const berlin = { from: '2025-09-30T22:00:00Z', to: '2026-11-04T23:00:00Z' }
    expect((await get(ws.cookie, '/activity', berlin)).status).toBe(200)
    expect(
      (await get(ws.cookie, '/activity/days', { ...berlin, tz: 'Europe/Berlin' })).status,
    ).toBe(200)
    // q 里的 % 与 _ 照字面找
    await create(ws.cookie, { uri: 'core://kb/a_b', content: '一' })
    await create(ws.cookie, { uri: 'core://kb/axb', content: '一' })
    expect((await list(ws.cookie, { q: 'a_b' })).map((i) => i.uri)).toEqual(['core://kb/a_b'])
    expect(await list(ws.cookie, { q: '%' })).toEqual([])
  })
})

interface JsFilter {
  from?: string
  to?: string
  actor?: string[]
  exceptActor?: string[]
  type?: string[]
  layer?: string[]
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
    case 'layer':
      return filter.layer!.includes(i.layer)
    case 'field':
      return i.changes.length
        ? i.changes.some((c) => filter.field!.includes(c))
        : filter.field!.includes('none')
    case 'q': {
      const q = filter.q!.toLowerCase()
      return i.title.toLowerCase().includes(q) || i.uri.toLowerCase().includes(q)
    }
  }
}
