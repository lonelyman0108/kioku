import { randomBytes } from 'node:crypto'

import type {
  CircleOverview,
  EntryRecallStat,
  EntryView,
  RecallEventList,
  RecallStats,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database } from '../../db/client'
import { circles, entries, recallEvents, settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { settleRecallEvents } from '../../recall/events'
import { pruneRecallEvents } from '../../recall/retention'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('召回分析', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let clientId: string
  let key: string
  let kiokuEntry: EntryView
  let deployEntry: EntryView
  let idleEntry: EntryView
  let vaultEntry: EntryView

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
    await database.db.delete(settings)
    ws = await bootstrap(app)
    clientId = (await ws.createClient('agent')).id
    key = await ws.issueKey(clientId)
    kiokuEntry = await create({
      title: 'projects/kioku',
      content: 'Kioku 是记忆服务',
      glossary: ['kioku'],
    })
    deployEntry = await create({
      title: 'notes/deploy',
      content: '部署步骤',
      glossary: ['部署'],
    })
    idleEntry = await create({ title: 'notes/idle', content: '一直没人问的事' })
    vaultEntry = await create({ title: 'notes/vault', content: '机密', sensitivity: 'secret' })
  })

  const create = async (body: Record<string, unknown>, k = key) => {
    const res = await app.request('/v1/entries', jsonRequest('POST', body, bearer(k)))
    if (res.status !== 201) throw new Error(await res.text())
    return (await res.json()) as EntryView
  }
  const recallAs = async (query: string, k = key) => {
    await app.request('/v1/recall', jsonRequest('POST', { query }, bearer(k)))
    await settleRecallEvents()
  }
  const get = async <T>(path: string, cookie = ws.cookie, circleId = ws.circleId) => {
    const res = await app.request(`/v1/circles/${circleId}${path}`, { headers: { cookie } })
    return { status: res.status, body: (await res.json()) as T }
  }
  // 把词条的建立时间往前挪，记忆圈当作早就建了（记忆圈建立之前不算开始记录召回事件）；
  // 开始记录召回事件的时间（迁移写的那一行）按需设置，测试开头会清掉设置表
  const backdate = async (days: number) => {
    await database.db
      .update(circles)
      .set({ createdAt: sql`now() - interval '400 days'` })
      .where(eq(circles.id, ws.circleId))
    await withCircle(database.db, ws.circleId, (tx) =>
      tx.update(entries).set({ createdAt: sql`now() - make_interval(days => ${days}::int)` }),
    )
  }
  const recordingStarted = (daysAgo: number) =>
    database.db.insert(settings).values({
      key: 'recall-started',
      value: sql`to_jsonb(now() - make_interval(days => ${daysAgo}::int))`,
    })

  it('列出被召回最多的、从没被召回的（不含 secret），以及各接入实例按来路的调用量', async () => {
    await recallAs('kioku')
    await recallAs('kioku 部署')
    await recallAs('kioku')
    await backdate(31)
    await recordingStarted(40)
    const { body } = await get<RecallStats>('/recall/stats')
    expect(body.retentionDays).toBe(30)
    expect(Date.now() - new Date(body.recordingSince).getTime()).toBeGreaterThan(39 * 86_400_000)
    expect(body.top.map((m) => [m.title, m.total])).toEqual([
      ['projects/kioku', 3],
      ['notes/deploy', 1],
    ])
    expect(body.never.map((m) => m.title)).toEqual(['notes/idle'])
    expect(body.neverTotal).toBe(1)
    expect(body.clients).toEqual([
      { clientId, name: 'agent', total: 3, sources: [{ source: 'rest.recall', count: 3 }] },
    ])
  })

  it('明细清理之后，次数并进累计照样算；一条词条的次数分保留期内的与累计的', async () => {
    await recallAs('kioku')
    await recallAs('kioku')
    expect((await get<EntryRecallStat>(`/recall/entry?id=${kiokuEntry.id}`)).body).toMatchObject({
      recent: 2,
      total: 2,
    })
    await pruneRecallEvents(database.db, 0)
    const { body } = await get<EntryRecallStat>(`/recall/entry?id=${kiokuEntry.id}`)
    expect(body).toMatchObject({ recent: 0, total: 2 })
    expect(body.lastRecalledAt).not.toBeNull()
    const stats = (await get<RecallStats>('/recall/stats')).body
    expect(stats.top.map((m) => [m.title, m.recent, m.total])).toContainEqual([
      'projects/kioku',
      0,
      2,
    ])
  })

  it('次数跟着词条的可见性走：无权读取的词条不出现在统计里，查它的次数是 404', async () => {
    const eve = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const eveClient = (
      (await (
        await app.request(
          `/v1/circles/${ws.circleId}/clients`,
          jsonRequest(
            'POST',
            { slug: 'eve-bot', name: 'eve-bot', runtimeFamily: 'mcp' },
            { cookie: eve.cookie },
          ),
        )
      ).json()) as { id: string }
    ).id
    const issued = await app.request(
      `/v1/circles/${ws.circleId}/clients/${eveClient}/keys`,
      jsonRequest(
        'POST',
        {
          name: 'k',
          linkedCircles: [{ circleId: eve.personalCircleId, mode: 'read_write' }],
          scopes: {
            readKinds: ['entry'],
            writeKinds: ['entry'],
            maxSensitivity: 'private',
            admin: false,
          },
        },
        { cookie: eve.cookie },
      ),
    )
    const eveKey = ((await issued.json()) as { key: string }).key
    const diary = await create(
      {
        circle: eve.personalCircleId,
        title: 'diary/eve',
        content: '伊芙的日记',
        glossary: ['日记'],
      },
      eveKey,
    )
    await recallAs('日记', eveKey)
    await recallAs('kioku')

    // 共享圈里，editor 看不到 secret 词条，查它的次数是 404，owner 可以看
    expect((await get(`/recall/entry?id=${vaultEntry.id}`, eve.cookie)).status).toBe(404)
    expect((await get(`/recall/entry?id=${vaultEntry.id}`, ws.cookie)).status).toBe(200)

    // 伊芙个人圈的日记命中只记在她个人圈；共享圈的 stats 看不到，查共享圈的它也是 404
    const mine = (await get<RecallStats>('/recall/stats')).body
    expect(mine.top.map((m) => m.title)).not.toContain('diary/eve')
    expect(mine.never.map((m) => m.title)).not.toContain('diary/eve')
    expect((await get(`/recall/entry?id=${diary.id}`)).status).toBe(404)
    // 伊芙个人圈自己看得到；共享圈的调用量里只有她能管 Key 的接入实例
    const evePersonalStats = (
      await get<RecallStats>('/recall/stats', eve.cookie, eve.personalCircleId)
    ).body
    expect(evePersonalStats.top.map((m) => m.title)).toContain('diary/eve')
    expect(
      (await get(`/recall/entry?id=${diary.id}`, ws.cookie, eve.personalCircleId)).status,
    ).toBe(403)
    const hers = (await get<RecallStats>('/recall/stats', eve.cookie)).body
    expect(hers.clients.map((a) => a.name)).toEqual(['eve-bot'])
    // 记忆圈 owner 看得到全部接入实例的调用量
    expect(
      (await get<RecallStats>('/recall/stats')).body.clients.map((a) => a.name).sort(),
    ).toEqual(['agent', 'eve-bot'])
  })

  it('明细只给事件发生时的接入实例主人：转给别人之后，前任的明细不给新主人', async () => {
    await recallAs('路由器密码：hunter2 kioku 怎么部署')
    const mine = (await get<RecallEventList>('/recall/events')).body
    expect(mine.items).toHaveLength(1)
    const [event] = mine.items
    expect(event!.query).toContain('密码：***')
    expect(event!.hits.map((h) => h.title)).toEqual(['projects/kioku', 'notes/deploy'])
    expect(event!.clientName).toBe('agent')
    expect(event!.keyName).toBe('test')

    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    expect((await get<RecallEventList>('/recall/events', bob.cookie)).body.items).toEqual([])
    const res = await app.request(
      `/v1/circles/${ws.circleId}/clients/${clientId}`,
      jsonRequest('PATCH', { ownerAccountId: bob.accountId }, { cookie: ws.cookie }),
    )
    expect(res.status).toBe(200)
    expect((await get<RecallEventList>('/recall/events', bob.cookie)).body.items).toEqual([])
    expect(
      (await get<RecallEventList>(`/recall/events?clientId=${clientId}`)).body.items,
    ).toHaveLength(1)
  })

  it('从没被召回的不算会进启动上下文的词条，也要等建了、开始记录都满保留天数', async () => {
    await create({ title: 'rules/agent', content: '基础规则', priority: 0 })
    await create({ title: 'notes/fresh', content: '刚建的' })
    await backdate(31)
    await recordingStarted(40)
    await create({ title: 'notes/newer', content: '昨天建的' })
    const stats = (await get<RecallStats>('/recall/stats')).body
    // priority 0 的词条每次会话开始都注入；notes/newer 建了还不到 30 天
    expect(stats.never.map((m) => m.title).sort()).toEqual([
      'notes/deploy',
      'notes/fresh',
      'notes/idle',
      'projects/kioku',
    ])
    expect((await get<CircleOverview>('/overview')).body.neverRecalled).toBe(4)

    // 开始记录召回事件才 1 天：之前的词条没机会被记下召回，都不算
    await database.db.delete(settings)
    await recordingStarted(1)
    const recent = (await get<RecallStats>('/recall/stats')).body
    expect(recent.never).toEqual([])
    expect(recent.neverTotal).toBe(0)
    expect((await get<CircleOverview>('/overview')).body.neverRecalled).toBe(0)

    // 开始记录的时间缺了（或读不出日期）时当作刚开始记录：不会把旧词条一下子全算进来
    await database.db.delete(settings)
    expect((await get<RecallStats>('/recall/stats')).body.neverTotal).toBe(0)
  })

  it('概览的「从没被召回」只数建了超过保留天数的', async () => {
    await recallAs('kioku')
    const before = (await get<CircleOverview>('/overview')).body
    expect(before.neverRecalled).toBe(0)
    await backdate(31)
    // 开始记录召回事件的时间也要满保留天数
    expect((await get<CircleOverview>('/overview')).body.neverRecalled).toBe(0)
    await recordingStarted(40)
    const after = (await get<CircleOverview>('/overview')).body
    // notes/deploy 与 notes/idle 没被召回；secret 不算
    expect(after.neverRecalled).toBe(2)
    expect(deployEntry.id).not.toBe(idleEntry.id)
    expect(
      await withCircle(database.db, ws.circleId, (tx) => tx.select().from(recallEvents)),
    ).toHaveLength(1)
  })
})
