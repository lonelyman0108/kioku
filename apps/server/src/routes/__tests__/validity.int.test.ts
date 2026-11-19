import { randomBytes } from 'node:crypto'

import type {
  ActivityList,
  BootResponse,
  ConsoleEntryView,
  DeletedEntryList,
  EntryHistory,
  EntryList,
  EntryView,
  ExpiredEntryList,
  LifecycleResponse,
  RecallResponse,
  SubjectDetail,
} from '@kioku/contracts'
import { and, asc, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database } from '../../db/client'
import {
  conversationTurns,
  entries,
  entryEvents,
  entryVariants,
  settings,
  subjectIdentities,
  subjects,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { ChatModel } from '../../extraction/provider'
import { saveExtractionConfig } from '../../extraction/settings'
import { processSession } from '../../extraction/worker'
import type { Jobs } from '../../jobs/queue'
import {
  databaseNow,
  openTestDatabase,
  resetDatabase,
  summaryConversation,
  testDatabaseUrl,
} from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const fakeModel = (reply: unknown): ChatModel => ({
  model: 'fake-model',
  async complete() {
    return { content: JSON.stringify(reply), usage: { promptTokens: 40, completionTokens: 10 } }
  },
})

const DAY = 86_400_000
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString()

describe.skipIf(!testDatabaseUrl)('有效期与重新生效', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let key: string
  const masterKey = randomBytes(32)
  // 排队生成向量的词条：重新生效之后要重新排
  const queued: string[] = []
  const jobs: Jobs = {
    enqueueEmbed: (_circleId, entryId) => void queued.push(entryId),
    enqueueBackfill: async () => true,
    enqueueSwitch: async () => true,
    enqueuePrune: async () => true,
    enqueueBackup: async () => null,
    backupRun: async () => null,
    enqueueCleanup: async () => true,
    enqueueDream: async () => null,
    dreamRun: async () => null,
    enqueueExtraction: async () => {},
  }

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs,
    })
  })
  afterAll(async () => {
    await database?.db.delete(settings)
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    key = await ws.issueKey((await ws.createClient('agent', { runtimeFamily: 'claudecode' })).id)
    queued.length = 0
  })

  const circle = () => `/v1/circles/${ws.circleId}`
  const ok = async <T>(res: Response, status = 200) => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const errorOf = async (res: Response, status: number) => {
    expect(res.status).toBe(status)
    return ((await res.json()) as { error: string }).error
  }
  const keyCreate = (body: Record<string, unknown>) =>
    app.request('/v1/entries', jsonRequest('POST', body, bearer(key)))
  const keyPatch = (body: Record<string, unknown>) =>
    app.request('/v1/entries', jsonRequest('PATCH', body, bearer(key)))
  const keyGet = (id: string) =>
    app.request(`/v1/entries?id=${encodeURIComponent(id)}`, { headers: bearer(key) })

  const create = (body: Record<string, unknown>, cookie = ws.cookie) =>
    app.request(`${circle()}/entries`, jsonRequest('POST', body, { cookie }))
  const get = (id: string, cookie = ws.cookie) =>
    app.request(`${circle()}/entries?id=${encodeURIComponent(id)}`, { headers: { cookie } })
  const remove = async (m: { shortId: string; version: number }, cookie = ws.cookie) => {
    const query = `id=${encodeURIComponent(m.shortId)}&expectedVersion=${m.version}`
    const res = await app.request(`${circle()}/entries?${query}`, {
      method: 'DELETE',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(204)
  }
  const list = (path: string, cookie = ws.cookie) =>
    app.request(`${circle()}${path}`, { headers: { cookie } })
  const expired = async (cookie = ws.cookie, query = '') =>
    ok<ExpiredEntryList>(await list(`/entries/expired${query}`, cookie))
  const deleted = async (cookie = ws.cookie) =>
    ok<DeletedEntryList>(await list('/entries/deleted', cookie))
  const history = async (id: string, cookie = ws.cookie) =>
    ok<EntryHistory>(await list(`/entries/history?id=${id}`, cookie))
  const reactivate = (entryId: string, expectedVersion: number, cookie = ws.cookie) =>
    app.request(
      `${circle()}/entries/reactivate`,
      jsonRequest('POST', { entryId, expectedVersion }, { cookie }),
    )
  const undelete = (entryId: string, cookie = ws.cookie) =>
    app.request(`${circle()}/entries/undelete`, jsonRequest('POST', { entryId }, { cookie }))

  const dbNow = async () => (await databaseNow(database.db)).getTime()
  const expire = (id: string) =>
    withCircle(database.db, ws.circleId, (tx) =>
      tx
        .update(entries)
        .set({ validTo: sql`statement_timestamp() - interval '1 minute'` })
        .where(eq(entries.id, id)),
    )
  // 删掉的词条之后又到期：两分钟前删除、一分钟前到期，删除时仍有效
  const deletedThenExpired = async (id: string) => {
    const now = await dbNow()
    const validTo = new Date(now - 60_000)
    await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .update(entries)
        .set({ deletedAt: new Date(now - 120_000), validTo })
        .where(eq(entries.id, id)),
    )
    return validTo.toISOString()
  }
  const rowOf = async (id: string) =>
    (
      await withCircle(database.db, ws.circleId, (tx) =>
        tx.select().from(entries).where(eq(entries.id, id)),
      )
    )[0]!
  const variantOf = async (entryId: string) =>
    (
      await withCircle(database.db, ws.circleId, (tx) =>
        tx.select().from(entryVariants).where(eq(entryVariants.entryId, entryId)),
      )
    )[0]!
  const recallShortIds = async (query: string) =>
    (
      await ok<RecallResponse>(
        await app.request('/v1/recall', jsonRequest('POST', { query }, bearer(key))),
      )
    ).candidates.map((c) => c.shortId)
  const bootShortIds = async () =>
    (await ok<BootResponse>(await app.request('/v1/boot', { headers: bearer(key) }))).entries.map(
      (e) => e.shortId,
    )
  const sessionStart = async () =>
    JSON.stringify(
      await ok<LifecycleResponse>(
        await app.request(
          '/v1/lifecycle/event',
          jsonRequest('POST', { event: 'session.start', sessionId: 's' }, bearer(key)),
        ),
      ),
    )

  // 另开一条连接拿住行锁，确认请求阻塞后执行 between，再提交释放锁
  async function whileBlocking<T>(
    lock: (tx: postgres.TransactionSql) => Promise<unknown>,
    request: () => T | Promise<T>,
    between: (tx: postgres.TransactionSql) => Promise<unknown>,
  ): Promise<T> {
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    let pending: Promise<T> | undefined
    try {
      await side.begin(async (tx) => {
        await tx`select set_config('app.read_circles', ${ws.circleId}, true)`
        await tx`select set_config('app.write_circles', ${ws.circleId}, true)`
        await lock(tx)
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }]
        pending = Promise.resolve(request())
        for (let i = 0; ; i++) {
          const [row] = await side<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where ${pid}::int = any(pg_blocking_pids(pid))`
          if (row!.n > 0) break
          if (i >= 200) throw new Error('请求没有等在这把锁上')
          await new Promise((r) => setTimeout(r, 25))
        }
        await between(tx)
      })
      return await pending!
    } finally {
      await pending?.catch(() => {})
      await side.end()
    }
  }
  const sleepPast = async (at: Date) => {
    const wait = at.getTime() - (await dbNow()) + 200
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)))
  }

  describe('设有效到', () => {
    for (const [name, skew] of [
      ['快', 120_000],
      ['慢', -120_000],
    ] as const) {
      it(`应用的时钟比数据库${name}两分钟时，有效到按数据库的时间比：晚 30 秒的拒绝、晚 90 秒的可以`, async () => {
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skew })
        try {
          const soon = new Date((await dbNow()) + 30_000).toISOString()
          expect(
            await errorOf(await keyCreate({ title: 'soon', content: 'x', validTo: soon }), 400),
          ).toContain('至少晚一分钟')
          const later = new Date((await dbNow()) + 90_000).toISOString()
          const m = await ok<EntryView>(
            await keyCreate({ title: 'later', content: 'y', validTo: later }),
            201,
          )
          expect(m.validTo).toBe(later)
        } finally {
          vi.useRealTimers()
        }
      })
    }

    it('Key 新建与修改时设有效到、改掉、清掉；不提它时不动，列表与历史里看得到', async () => {
      const until = new Date(Date.now() + 3 * DAY)
      const local = new Date(until.getTime() + 8 * 3_600_000).toISOString().replace('Z', '+08:00')
      const m = await ok<EntryView>(
        await keyCreate({ title: 'plan', content: '下周出差', validTo: local }),
        201,
      )
      expect(m.validTo).toBe(until.toISOString())

      const later = inDays(5)
      const moved = await ok<EntryView>(await keyPatch({ id: m.shortId, validTo: later }))
      expect(moved.validTo).toBe(later)
      const edited = await ok<EntryView>(await keyPatch({ id: m.shortId, content: '下周三出差' }))
      expect(edited.validTo).toBe(later)
      const cleared = await ok<EntryView>(await keyPatch({ id: m.shortId, validTo: null }))
      expect(cleared.validTo).toBeNull()
      expect(
        (await ok<EntryView>(await keyPatch({ id: m.shortId, priority: 1 }))).validTo,
      ).toBeNull()

      const soon = inDays(1)
      await ok<ConsoleEntryView>(
        await create({ title: 'visa', content: '签证', validTo: soon }),
        201,
      )
      const items = (await ok<EntryList>(await list('/entries/list?sort=priority'))).items
      expect(items.map((i) => [i.title, i.validTo])).toEqual([
        ['plan', null],
        ['visa', soon],
      ])

      const h = await history(m.id)
      expect(h.entry).toMatchObject({ validTo: null })
      expect(h.events.map((e) => [e.type, e.after?.validTo])).toEqual([
        ['update', null],
        ['update', null],
        ['update', later],
        ['update', later],
        ['create', until.toISOString()],
      ])
      const activity = await ok<ActivityList>(await list('/activity'))
      const changes = activity.items.filter((i) => i.entryId === m.id).map((i) => i.changes)
      expect(changes).toEqual([['priority'], ['validTo'], ['content'], ['validTo'], []])
    })

    it('修改时原样带回没改过的有效到不检查：在最后一分钟里改别的字段照样成功，换成别的近时间照样拒绝', async () => {
      const m = await ok<EntryView>(
        await keyCreate({ title: 'last', content: '旧的', validTo: inDays(1) }),
        201,
      )
      const soon = new Date((await dbNow()) + 30_000)
      await withCircle(database.db, ws.circleId, (tx) =>
        tx.update(entries).set({ validTo: soon }).where(eq(entries.id, m.id)),
      )
      const read = await ok<EntryView>(await keyGet(m.shortId))
      expect(read.validTo).toBe(soon.toISOString())
      const saved = await ok<EntryView>(
        await keyPatch({ id: m.shortId, content: '新的', validTo: read.validTo }),
      )
      expect(saved.validTo).toBe(soon.toISOString())
      expect(saved.variants[0]!.content).toBe('新的')
      const other = new Date(soon.getTime() + 10_000).toISOString()
      expect(await errorOf(await keyPatch({ id: m.shortId, validTo: other }), 400)).toContain(
        '至少晚一分钟',
      )
    })

    it('有效到要比现在晚至少一分钟：过去的、半分钟之后的、不带时区的都拒绝，原来的有效期不变', async () => {
      const now = await dbNow()
      const past = new Date(now - 60_000).toISOString()
      const soon = new Date(now + 30_000).toISOString()
      for (const validTo of [past, soon]) {
        expect(
          await errorOf(await keyCreate({ title: 'bad1', content: 'x', validTo }), 400),
        ).toContain('至少晚一分钟')
        expect(
          await errorOf(await create({ title: 'bad2', content: 'x', validTo }), 400),
        ).toContain('至少晚一分钟')
      }
      expect(
        (await keyCreate({ title: 'notz', content: 'x', validTo: '2030-01-01T00:00:00' })).status,
      ).toBe(400)
      expect((await keyGet('notz')).status).toBe(404)

      const later = new Date((await dbNow()) + 120_000).toISOString()
      expect(
        (await ok<EntryView>(await keyCreate({ title: 'good', content: 'y', validTo: later }), 201))
          .validTo,
      ).toBe(later)

      const until = inDays(2)
      const m = await ok<EntryView>(
        await keyCreate({ title: 'keep', content: 'x', validTo: until }),
        201,
      )
      expect((await keyPatch({ id: m.shortId, validTo: past })).status).toBe(400)
      expect((await keyPatch({ id: m.shortId, validTo: soon })).status).toBe(400)
      expect(
        (
          await keyPatch({
            id: m.shortId,
            validTo: new Date(await dbNow()).toISOString(),
            content: '新的',
          })
        ).status,
      ).toBe(400)
      const current = await ok<EntryView>(await keyGet(m.shortId))
      expect(current).toMatchObject({ validTo: until, version: 1 })
      expect(current.variants[0]!.content).toBe('x')
    })
  })

  describe('并发与到期的边界', () => {
    it('重新生效时版本号和锁到的那一版比：等锁期间被改过的返回 409', async () => {
      const m = await ok<EntryView>(
        await keyCreate({ title: 'race', content: '过期的', validTo: inDays(1) }),
        201,
      )
      await expire(m.id)
      const res = await whileBlocking(
        (tx) => tx`select id from entries where id = ${m.id} for update`,
        () => reactivate(m.id, m.version),
        (tx) => tx`update entries set version = version + 1 where id = ${m.id}`,
      )
      expect(res.status).toBe(409)
      expect((await rowOf(m.id)).validTo).not.toBeNull()
    })

    it('等锁期间到期的事实：按事务开头的时刻判断，那时还有效就照样删掉', async () => {
      const [subject] = await withCircle(database.db, ws.circleId, (tx) =>
        tx
          .insert(subjects)
          .values({ circleId: ws.circleId, kind: 'person', displayName: '小明' })
          .returning(),
      )
      const until = new Date((await dbNow()) + 3_000)
      const [fact] = await withCircle(database.db, ws.circleId, (tx) =>
        tx
          .insert(entries)
          .values({
            circleId: ws.circleId,
            circleKind: 'shared',
            shortId: 'm-fc2222',
            kind: 'fact',
            title: '在学日语',
            subjectId: subject!.id,
            subjectKind: 'person',
            sensitivity: 'public',
            provenance: 'untrusted',
            originScope: 'global',
            validTo: until,
          })
          .returning(),
      )
      await withCircle(database.db, ws.circleId, (tx) =>
        tx.insert(entryVariants).values({
          circleId: ws.circleId,
          entryId: fact!.id,
          kind: 'fact',
          sensitivity: 'public',
          content: '在学日语',
        }),
      )
      const res = await whileBlocking(
        (tx) => tx`select id from entries where id = ${fact!.id} for update`,
        () =>
          app.request(
            `${circle()}/subjects/${subject!.id}/facts/${fact!.id}?version=${fact!.version}`,
            { method: 'DELETE', headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' } },
          ),
        () => sleepPast(until),
      )
      expect(res.status).toBe(204)
      const row = await rowOf(fact!.id)
      expect(row.deletedAt).not.toBeNull()
      expect(row.deletedAt!.getTime()).toBeLessThan(until.getTime())
    })

    it('待审里等锁期间到期：按事务开头的时刻判断，照样删掉', async () => {
      const until = new Date((await dbNow()) + 3_000)
      const [item] = await withCircle(database.db, ws.circleId, async (tx) =>
        tx
          .insert(entries)
          .values({
            circleId: ws.circleId,
            circleKind: 'shared',
            shortId: 'm-ep2222',
            kind: 'episode',
            title: '下周三停电',
            sensitivity: 'public',
            provenance: 'untrusted',
            originScope: 'global',
            conversationId: await summaryConversation(tx, ws.circleId),
            expiresAt: until,
          })
          .returning(),
      )
      await withCircle(database.db, ws.circleId, (tx) =>
        tx.insert(entryVariants).values({
          circleId: ws.circleId,
          entryId: item!.id,
          kind: 'episode',
          sensitivity: 'public',
          content: '群里说下周三停电',
        }),
      )
      const res = await whileBlocking(
        (tx) => tx`lock table entries in access exclusive mode`,
        () =>
          app.request(
            `${circle()}/review`,
            jsonRequest(
              'POST',
              { action: 'delete', items: [{ id: item!.id, version: item!.version }] },
              { cookie: ws.cookie },
            ),
          ),
        () => sleepPast(until),
      )
      expect(await ok<{ done: number; skipped: number }>(res)).toEqual({ done: 1, skipped: 0 })
      const row = await rowOf(item!.id)
      expect(row.deletedAt).not.toBeNull()
      expect(row.deletedAt!.getTime()).toBeLessThan(until.getTime())
    })

    it('等锁期间别人提交了修改：等完再写，更新时间不早于那次修改', async () => {
      const m = await ok<EntryView>(await keyCreate({ title: 'wait', content: '旧的' }), 201)
      let theirs: Date | undefined
      const res = await whileBlocking(
        (tx) => tx`select id from entries where id = ${m.id} for update`,
        () => keyPatch({ id: m.shortId, content: '新的' }),
        async (tx) => {
          const [row] = (await tx`
            update entries set updated_at = statement_timestamp() where id = ${m.id}
            returning updated_at`) as unknown as [{ updated_at: Date }]
          theirs = row.updated_at
        },
      )
      const saved = await ok<EntryView>(res)
      expect(saved.variants[0]!.content).toBe('新的')
      expect(new Date(saved.updatedAt).getTime()).toBeGreaterThanOrEqual(theirs!.getTime())
      expect((await rowOf(m.id)).updatedAt.getTime()).toBeGreaterThanOrEqual(theirs!.getTime())
    })
  })

  describe('到期之后', () => {
    it('按短 ID 读不到、不在列表与浏览里、不召回、不进 boot 与会话开始，历史与已过期里看得到', async () => {
      const rule = await ok<EntryView>(
        await keyCreate({
          title: 'deadline',
          content: '截止日期之前每天提醒一次进度',
          priority: 0,
          glossary: ['截止提醒'],
          validTo: inDays(1),
        }),
        201,
      )
      const agent = await ok<EntryView>(
        await keyCreate({
          title: 'agent',
          content: '先读正文再信任',
          priority: 0,
        }),
        201,
      )
      expect(await bootShortIds()).toContain(rule.shortId)
      expect(await recallShortIds('截止提醒的安排')).toContain(rule.shortId)
      expect(await sessionStart()).toContain('每天提醒一次进度')

      await expire(rule.id)
      expect((await keyGet(rule.shortId)).status).toBe(404)
      expect((await get(rule.shortId)).status).toBe(404)
      expect(
        (await ok<EntryList>(await list('/entries/list'))).items.map((i) => i.shortId),
      ).toEqual([agent.shortId])
      expect(await bootShortIds()).toEqual([agent.shortId])
      expect(await recallShortIds('截止提醒的安排')).not.toContain(rule.shortId)
      const start = await sessionStart()
      expect(start).not.toContain('每天提醒一次进度')
      expect(start).not.toContain(rule.shortId)

      const h = await history(rule.id)
      expect(h.entry.validTo).not.toBeNull()
      expect(h.events.map((e) => e.type)).toEqual(['create'])
      const activity = await ok<ActivityList>(await list('/activity'))
      expect(activity.items.map((i) => [i.shortId, i.expired])).toEqual([
        [agent.shortId, false],
        [rule.shortId, true],
      ])
      expect((await expired()).items).toMatchObject([
        { id: rule.id, shortId: rule.shortId, expiredAt: h.entry.validTo },
      ])
      expect((await deleted()).items).toEqual([])
    })

    for (const [name, skew] of [
      ['快', 120_000],
      ['慢', -120_000],
    ] as const) {
      it(`应用的时钟比数据库${name}两分钟、有效到落在两个钟之间时，各处都按数据库的时间判断`, async () => {
        const m = await ok<EntryView>(
          await keyCreate({ title: 'deadline', content: '截止日期之前每天提醒一次进度' }),
          201,
        )
        const now = await dbNow()
        const validTo = new Date(now + skew / 2)
        await withCircle(database.db, ws.circleId, (tx) =>
          tx.update(entries).set({ validTo }).where(eq(entries.id, m.id)),
        )
        const alive = skew > 0
        vi.useFakeTimers({ toFake: ['Date'], now: now + skew })
        try {
          expect((await keyGet(m.shortId)).status).toBe(alive ? 200 : 404)
          expect((await get(m.shortId)).status).toBe(alive ? 200 : 404)
          const listed = (await ok<EntryList>(await list('/entries/list'))).items
          expect(listed.map((i) => i.id)).toEqual(alive ? [m.id] : [])
          expect((await expired()).items.map((i) => i.id)).toEqual(alive ? [] : [m.id])
          expect(await recallShortIds('每天提醒进度')).toEqual(alive ? [m.shortId] : [])
        } finally {
          vi.useRealTimers()
        }
      })
    }
  })

  describe('重新生效', () => {
    it('清掉有效期，回到读取、召回与 boot；记一条事件，重新排队生成向量；已经有效的不再重新生效', async () => {
      const m = await ok<EntryView>(
        await keyCreate({
          title: 'deadline',
          content: '每天提醒进度',
          priority: 0,
          validTo: inDays(1),
        }),
        201,
      )
      await expire(m.id)
      queued.length = 0
      expect(await errorOf(await reactivate(m.id, m.version + 1), 409)).toContain(
        '已经被其他请求修改',
      )

      const back = await ok<ConsoleEntryView>(await reactivate(m.id, m.version))
      expect(back).toMatchObject({ id: m.id, validTo: null, version: m.version + 1 })
      expect(await ok<EntryView>(await keyGet(m.shortId))).toMatchObject({
        id: m.id,
        validTo: null,
      })
      expect(await bootShortIds()).toContain(m.shortId)
      expect(queued).toContain(m.id)
      expect((await expired()).items).toEqual([])

      const h = await history(m.id)
      expect(h.events.map((e) => e.type)).toEqual(['reactivate', 'create'])
      const event = h.events[0]!
      expect(event.before?.validTo).not.toBeNull()
      expect(event.after?.validTo).toBeNull()
      expect(event.actor.accountName).toBe('alice')
      expect(await errorOf(await reactivate(m.id, back.version), 409)).toContain('仍有效')
    })

    it('删掉之后才过期的：列在已删除里，撤销删除不动有效期，回到已过期里，再重新生效', async () => {
      const m = await ok<EntryView>(
        await keyCreate({ title: 'gone', content: '删掉的', validTo: inDays(1) }),
        201,
      )
      await remove(m)
      const validTo = await deletedThenExpired(m.id)
      expect((await deleted()).items).toMatchObject([{ id: m.id, validTo }])
      expect((await expired()).items).toEqual([])
      expect(await errorOf(await reactivate(m.id, (await rowOf(m.id)).version), 409)).toContain(
        '先恢复已删除',
      )

      const undone = await ok<ConsoleEntryView>(await undelete(m.id))
      expect(undone).toMatchObject({ id: m.id, validTo })
      expect((await rowOf(m.id)).deletedAt).toBeNull()
      expect((await keyGet(m.shortId)).status).toBe(404)
      expect((await deleted()).items).toEqual([])
      expect((await expired()).items).toMatchObject([{ id: m.id }])

      const back = await ok<ConsoleEntryView>(await reactivate(m.id, undone.version))
      expect(back).toMatchObject({ id: m.id, validTo: null })
      expect((await keyGet(m.shortId)).status).toBe(200)
      expect((await history(m.id)).events.map((e) => e.type)).toEqual([
        'reactivate',
        'undelete',
        'delete',
        'create',
      ])
    })

    it('读不到的 404、写不了的 403；editor 看不到 secret；Key 没有这个接口', async () => {
      const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
      const viewer = await addMember(database.db, ws.circleId, 'vic', 'viewer')
      const secret = await ok<ConsoleEntryView>(
        await create({
          title: 'token',
          content: 'x',
          sensitivity: 'secret',
          validTo: inDays(1),
        }),
        201,
      )
      const shared = await ok<ConsoleEntryView>(
        await create({ title: 'faq', content: '常见问题', validTo: inDays(1) }),
        201,
      )
      for (const m of [secret, shared]) await expire(m.id)

      expect((await expired(editor.cookie)).items.map((i) => i.shortId)).toEqual([shared.shortId])
      expect((await reactivate(secret.id, secret.version, editor.cookie)).status).toBe(404)
      expect((await reactivate(shared.id, shared.version, viewer.cookie)).status).toBe(403)
      expect((await reactivate('00000000-0000-4000-8000-000000000000', 1)).status).toBe(404)
      const viaKey = await app.request(
        '/v1/entries/reactivate',
        jsonRequest('POST', { entryId: shared.id, expectedVersion: 1 }, bearer(key)),
      )
      expect(viaKey.status).toBe(404)
      expect((await rowOf(secret.id)).validTo).not.toBeNull()
      expect((await reactivate(shared.id, shared.version, editor.cookie)).status).toBe(200)
    })

    it('已过期列表最近过期的在前，能翻页', async () => {
      const created: ConsoleEntryView[] = []
      for (const [i, name] of ['a', 'b', 'c'].entries()) {
        const m = await ok<ConsoleEntryView>(
          await keyCreate({ title: name, content: name, validTo: inDays(1) }),
          201,
        )
        await withCircle(database.db, ws.circleId, (tx) =>
          tx
            .update(entries)
            .set({ validTo: sql`statement_timestamp() - make_interval(mins => ${3 - i}::int)` })
            .where(eq(entries.id, m.id)),
        )
        created.push(m)
      }
      const first = await expired(ws.cookie, '?limit=2')
      const second = await expired(ws.cookie, `?limit=2&cursor=${first.nextCursor}`)
      expect([...first.items, ...second.items].map((i) => i.shortId)).toEqual([
        created[2]!.shortId,
        created[1]!.shortId,
        created[0]!.shortId,
      ])
      expect(second.nextCursor).toBeNull()
      expect((await list('/entries/expired?cursor=abc')).status).toBe(400)
    })
  })

  describe('被推翻的事实', () => {
    let botKey: string
    const group = {
      chatType: 'group',
      platform: 'qq',
      group: { id: '2001', name: '读书会' },
      sender: { id: '1001', name: '小明' },
    }
    const say = async (user: string) => {
      const res = await app.request(
        '/v1/lifecycle/event',
        jsonRequest(
          'POST',
          { event: 'turn.end', sessionId: 's', context: group, user, reply: '嗯' },
          bearer(botKey),
        ),
      )
      expect(res.status).toBe(200)
    }
    const extract = async (reply: unknown) => {
      const [turn] = await withCircle(database.db, ws.circleId, (tx) =>
        tx.select().from(conversationTurns).orderBy(asc(conversationTurns.id)).limit(1),
      )
      await processSession(
        database.db,
        masterKey,
        { circleId: ws.circleId, clientId: turn!.clientId, scope: turn!.scope },
        () => fakeModel(reply),
      )
    }
    const subjectOf = async (kind: 'person' | 'group', externalId: string) =>
      (
        await withCircle(database.db, ws.circleId, (tx) =>
          tx
            .select()
            .from(subjectIdentities)
            .where(
              and(eq(subjectIdentities.kind, kind), eq(subjectIdentities.externalId, externalId)),
            ),
        )
      )[0]!.subjectId
    const subjectId = () => subjectOf('person', '1001')
    const detail = async (id: string) => ok<SubjectDetail>(await list(`/subjects/${id}`))
    const reactivateFact = (subject: string, fact: string, version: number, cookie = ws.cookie) =>
      app.request(
        `${circle()}/subjects/${subject}/facts/${fact}/reactivate`,
        jsonRequest('POST', { version }, { cookie }),
      )
    const recalled = async () =>
      (
        await ok<RecallResponse>(
          await app.request(
            '/v1/recall',
            jsonRequest('POST', { query: '你好', context: group }, bearer(botKey)),
          ),
        )
      ).subjects.flatMap((s) => s.facts.map((f) => f.content))

    beforeEach(async () => {
      botKey = await ws.issueKey((await ws.createClient('qq-bot', { runtimeFamily: 'astrbot' })).id)
      await saveExtractionConfig(database.db, masterKey, {
        baseUrl: 'https://llm.example.com/v1',
        model: 'm',
      })
      await say('我在学日语')
      await extract({
        facts: [{ subject: 'M1', op: 'add', content: '在学日语', quote: '我在学日语' }],
      })
      await say('我改学韩语了')
      await extract({
        facts: [
          {
            subject: 'M1',
            op: 'update',
            replaces: 'F1',
            content: '在学韩语',
            quote: '我改学韩语了',
          },
        ],
      })
    })

    it('列在对象页上，带着推翻它的那条；重新生效之后两条都有效，记一条事件', async () => {
      const id = await subjectId()
      const before = await detail(id)
      expect(before.facts.map((f) => f.content)).toEqual(['在学韩语'])
      expect(before.supersededFacts).toMatchObject([
        { content: '在学日语', supersededBy: '在学韩语' },
      ])
      const old = before.supersededFacts[0]!
      expect(await errorOf(await reactivateFact(id, old.id, old.version + 1), 409)).toContain(
        '已经被其他请求修改',
      )

      queued.length = 0
      expect((await reactivateFact(id, old.id, old.version)).status).toBe(204)
      expect(queued).toEqual([old.id])
      const after = await detail(id)
      expect(after.facts.map((f) => f.content).sort()).toEqual(['在学日语', '在学韩语'])
      expect(after.supersededFacts).toEqual([])
      expect((await recalled()).sort()).toEqual(['在学日语', '在学韩语'])
      const events = await withCircle(database.db, ws.circleId, (tx) =>
        tx
          .select()
          .from(entryEvents)
          .where(eq(entryEvents.entryId, old.id))
          .orderBy(asc(entryEvents.id)),
      )
      expect(events.map((e) => e.eventType)).toEqual(['create', 'update', 'reactivate'])
      expect((events[2]!.after as { validTo: unknown }).validTo).toBeNull()
      expect(await errorOf(await reactivateFact(id, old.id, old.version + 1), 409)).toContain(
        '仍有效',
      )
    })

    for (const [name, skew] of [
      ['快', 120_000],
      ['慢', -120_000],
    ] as const) {
      it(`应用的时钟比数据库${name}两分钟时推翻：旧的马上在已推翻里，不在现在的事实里，也不召回`, async () => {
        await say('我又改学法语了')
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skew })
        try {
          await extract({
            facts: [
              {
                subject: 'M1',
                op: 'update',
                replaces: 'F1',
                content: '在学法语',
                quote: '我又改学法语了',
              },
            ],
          })
          const after = await detail(await subjectId())
          expect(after.facts.map((f) => f.content)).toEqual(['在学法语'])
          expect(after.supersededFacts.map((f) => f.content).sort()).toEqual([
            '在学日语',
            '在学韩语',
          ])
          expect(await recalled()).toEqual(['在学法语'])
        } finally {
          vi.useRealTimers()
        }
      })
    }

    it('推翻时等锁期间别的事务已经把旧事实设为过时：锁到之后按它现在的状态判断，不重复推翻', async () => {
      const id = await subjectId()
      const [current] = (await detail(id)).facts
      expect(current!.content).toBe('在学韩语')
      await say('我又改学法语了')
      let theirs: { valid_to: Date; version: number } | undefined
      await whileBlocking(
        (tx) => tx`select id from entries where id = ${current!.id} for update`,
        () =>
          extract({
            facts: [
              {
                subject: 'M1',
                op: 'update',
                replaces: 'F1',
                content: '在学法语',
                quote: '我又改学法语了',
              },
            ],
          }),
        async (tx) => {
          const [row] = (await tx`
            update entries
            set valid_to = statement_timestamp(), updated_at = statement_timestamp(),
              version = version + 1
            where id = ${current!.id}
            returning valid_to, version`) as unknown as [{ valid_to: Date; version: number }]
          theirs = row
        },
      )
      const row = await rowOf(current!.id)
      expect(row.version).toBe(theirs!.version)
      expect(row.validTo).toEqual(theirs!.valid_to)
      const events = await withCircle(database.db, ws.circleId, (tx) =>
        tx.select().from(entryEvents).where(eq(entryEvents.entryId, current!.id)),
      )
      expect(events.map((e) => e.eventType)).toEqual(['create'])
      expect((await detail(id)).facts.map((f) => f.content)).toEqual(['在学法语'])
    })

    it('模型读到之后旧事实的正文被改过：按版本核对，不推翻，新的那条当作新的事实', async () => {
      const id = await subjectId()
      const [current] = (await detail(id)).facts
      expect(current!.content).toBe('在学韩语')
      await say('我又改学法语了')
      const [turn] = await withCircle(database.db, ws.circleId, (tx) =>
        tx.select().from(conversationTurns).orderBy(asc(conversationTurns.id)).limit(1),
      )
      const model: ChatModel = {
        model: 'fake-model',
        async complete() {
          await withCircle(database.db, ws.circleId, async (tx) => {
            await tx
              .update(entries)
              .set({ title: '在学韩语和日语', version: sql`${entries.version} + 1` })
              .where(eq(entries.id, current!.id))
            await tx
              .update(entryVariants)
              .set({ content: '在学韩语和日语' })
              .where(eq(entryVariants.entryId, current!.id))
          })
          return {
            content: JSON.stringify({
              facts: [
                {
                  subject: 'M1',
                  op: 'update',
                  replaces: 'F1',
                  content: '在学法语',
                  quote: '我又改学法语了',
                },
              ],
            }),
            usage: { promptTokens: 40, completionTokens: 10 },
          }
        },
      }
      await processSession(
        database.db,
        masterKey,
        { circleId: ws.circleId, clientId: turn!.clientId, scope: turn!.scope },
        () => model,
      )
      expect(await rowOf(current!.id)).toMatchObject({
        version: current!.version + 1,
        validTo: null,
      })
      expect((await variantOf(current!.id)).content).toBe('在学韩语和日语')
      expect((await detail(id)).facts.map((f) => f.content).sort()).toEqual([
        '在学法语',
        '在学韩语和日语',
      ])
    })

    it('仅 expiresAt 到期（未设 validTo）的事实调用 reactivateFact 返回 409', async () => {
      const id = await subjectId()
      const past = new Date((await dbNow()) - 60_000)
      const [lapsed] = await withCircle(database.db, ws.circleId, (tx) =>
        tx
          .insert(entries)
          .values({
            circleId: ws.circleId,
            circleKind: 'shared',
            shortId: 'm-fx2222',
            kind: 'fact',
            title: '临时事实',
            subjectId: id,
            subjectKind: 'person',
            sensitivity: 'public',
            provenance: 'untrusted',
            originScope: 'global',
            expiresAt: past,
          })
          .returning(),
      )
      await withCircle(database.db, ws.circleId, (tx) =>
        tx.insert(entryVariants).values({
          circleId: ws.circleId,
          entryId: lapsed!.id,
          kind: 'fact',
          sensitivity: 'public',
          content: '临时事实',
        }),
      )
      expect(await errorOf(await reactivateFact(id, lapsed!.id, lapsed!.version), 409)).toContain(
        '仍有效',
      )
      expect(await rowOf(lapsed!.id)).toMatchObject({ validTo: null, version: 1 })
    })

    it('viewer 不能重新生效；别的对象上的、不存在的 404；推翻它的那条删掉之后不再给出', async () => {
      const id = await subjectId()
      const viewer = await addMember(database.db, ws.circleId, 'vic', 'viewer')
      const { supersededFacts, facts } = await detail(id)
      const old = supersededFacts[0]!
      expect((await reactivateFact(id, old.id, old.version, viewer.cookie)).status).toBe(403)
      expect(
        (await reactivateFact(await subjectOf('group', '2001'), old.id, old.version)).status,
      ).toBe(404)
      expect((await reactivateFact(id, '00000000-0000-4000-8000-000000000000', 1)).status).toBe(404)

      const removed = await app.request(
        `${circle()}/subjects/${id}/facts/${facts[0]!.id}?version=${facts[0]!.version}`,
        { method: 'DELETE', headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' } },
      )
      expect(removed.status).toBe(204)
      expect((await detail(id)).supersededFacts).toMatchObject([{ id: old.id, supersededBy: null }])
      expect((await rowOf(old.id)).validTo).not.toBeNull()
    })
  })
})
