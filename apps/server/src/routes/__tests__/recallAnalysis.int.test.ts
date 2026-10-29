import { randomBytes } from 'node:crypto'

import type {
  MemoryRecallStat,
  MemoryView,
  RecallEventList,
  RecallStats,
  SpaceOverview,
} from '@kioku/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memories, recallEvents, settings, spaces } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { settleRecallEvents } from '../../recall/events'
import { pruneRecallEvents } from '../../recall/retention'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('召回分析', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let appId: string
  let key: string

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
    appId = (await ws.createApp('agent')).id
    key = await ws.issueKey(appId)
    await create({ uri: 'projects://kioku', content: 'Kioku 是记忆服务', glossary: ['kioku'] })
    await create({ uri: 'notes://deploy', content: '部署步骤', glossary: ['部署'] })
    await create({ uri: 'notes://idle', content: '一直没人问的事' })
    await create({ uri: 'notes://vault', content: '机密', sensitivity: 'secret' })
  })

  const create = async (body: Record<string, unknown>, k = key) => {
    const res = await app.request('/v1/memories', jsonRequest('POST', body, bearer(k)))
    if (res.status !== 201) throw new Error(await res.text())
    return (await res.json()) as MemoryView
  }
  const recallAs = async (query: string, k = key) => {
    await app.request('/v1/recall', jsonRequest('POST', { query }, bearer(k)))
    await settleRecallEvents()
  }
  const get = async <T>(path: string, cookie = ws.cookie) => {
    const res = await app.request(`/v1/spaces/${ws.spaceId}${path}`, { headers: { cookie } })
    return { status: res.status, body: (await res.json()) as T }
  }
  // 把记忆的建立时间往前挪，空间当作早就建了（空间建立之前不算开始记录召回事件）；
  // 开始记录召回事件的时间（0015 迁移写的那一行）按需设置，测试开头会清掉设置表
  const backdate = async (days: number) => {
    await database.db
      .update(spaces)
      .set({ createdAt: sql`now() - interval '400 days'` })
      .where(eq(spaces.id, ws.spaceId))
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.update(memories).set({ createdAt: sql`now() - make_interval(days => ${days}::int)` }),
    )
  }
  const recordingStarted = (daysAgo: number) =>
    database.db.insert(settings).values({
      key: 'recall-started',
      value: sql`to_jsonb(now() - make_interval(days => ${daysAgo}::int))`,
    })
  const idOf = async (uri: string) => {
    const [domain, path] = uri.split('://') as [string, string]
    const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .select({ id: memories.id })
        .from(memories)
        .where(and(eq(memories.domain, domain), eq(memories.path, path))),
    )
    return row!.id
  }

  it('列出被召回最多的、从没被召回的（不含 secret），以及各应用按来路的调用量', async () => {
    await recallAs('kioku')
    await recallAs('kioku 部署')
    await recallAs('kioku')
    await backdate(31)
    await recordingStarted(40)
    const { body } = await get<RecallStats>('/recall/stats')
    expect(body.retentionDays).toBe(30)
    expect(Date.now() - new Date(body.recordingSince).getTime()).toBeGreaterThan(39 * 86_400_000)
    expect(body.top.map((m) => [m.uri, m.total])).toEqual([
      ['projects://kioku', 3],
      ['notes://deploy', 1],
    ])
    expect(body.never.map((m) => m.uri)).toEqual(['notes://idle'])
    expect(body.neverTotal).toBe(1)
    expect(body.apps).toEqual([
      { appId, name: 'agent', total: 3, sources: [{ source: 'rest.recall', count: 3 }] },
    ])
  })

  it('明细清理之后，次数并进累计照样算；一条记忆的次数分保留期内的与累计的', async () => {
    await recallAs('kioku')
    await recallAs('kioku')
    const id = await idOf('projects://kioku')
    expect((await get<MemoryRecallStat>(`/recall/memory?id=${id}`)).body).toMatchObject({
      recent: 2,
      total: 2,
    })
    await pruneRecallEvents(database.db, 0)
    const { body } = await get<MemoryRecallStat>(`/recall/memory?id=${id}`)
    expect(body).toMatchObject({ recent: 0, total: 2 })
    expect(body.lastRecalledAt).not.toBeNull()
    const stats = (await get<RecallStats>('/recall/stats')).body
    expect(stats.top.map((m) => [m.uri, m.recent, m.total])).toContainEqual([
      'projects://kioku',
      0,
      2,
    ])
  })

  it('次数跟着记忆的可见性走：别的成员的私人记忆不出现在统计里，查它的次数是 404', async () => {
    const eve = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const eveApp = (
      (await (
        await app.request(
          `/v1/spaces/${ws.spaceId}/apps`,
          jsonRequest(
            'POST',
            { slug: 'eve-bot', name: 'eve-bot', runtimeFamily: 'mcp' },
            { cookie: eve.cookie },
          ),
        )
      ).json()) as { id: string }
    ).id
    const issued = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${eveApp}/keys`,
      jsonRequest(
        'POST',
        {
          name: 'k',
          scopes: {
            readLayers: ['private'],
            writeLayers: ['private'],
            maxSensitivity: 'private',
            admin: false,
          },
        },
        { cookie: eve.cookie },
      ),
    )
    const eveKey = ((await issued.json()) as { key: string }).key
    const diary = await create(
      { uri: 'diary://eve', content: '伊芙的日记', glossary: ['日记'] },
      eveKey,
    )
    await recallAs('日记', eveKey)
    await recallAs('kioku')

    const mine = (await get<RecallStats>('/recall/stats')).body
    expect(mine.top.map((m) => m.uri)).not.toContain('diary://eve')
    expect(mine.never.map((m) => m.uri)).not.toContain('diary://eve')
    expect((await get(`/recall/memory?id=${diary.id}`)).status).toBe(404)
    // 伊芙自己看得到；但各应用的调用量里只有她能管 Key 的应用
    const hers = (await get<RecallStats>('/recall/stats', eve.cookie)).body
    expect(hers.top.map((m) => m.uri)).toContain('diary://eve')
    expect(hers.apps.map((a) => a.name)).toEqual(['eve-bot'])
    // 空间 owner 看得到全部应用的调用量
    expect((await get<RecallStats>('/recall/stats')).body.apps.map((a) => a.name).sort()).toEqual([
      'agent',
      'eve-bot',
    ])
  })

  it('明细只给事件发生时的应用主人：应用转给别人之后，前任的明细不给新主人', async () => {
    await recallAs('路由器密码：hunter2 kioku 怎么部署')
    const mine = (await get<RecallEventList>('/recall/events')).body
    expect(mine.items).toHaveLength(1)
    const [event] = mine.items
    expect(event!.query).toContain('密码：***')
    expect(event!.hits.map((h) => h.uri)).toEqual(['projects://kioku', 'notes://deploy'])
    expect(event!.appName).toBe('agent')
    expect(event!.keyName).toBe('test')

    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    expect((await get<RecallEventList>('/recall/events', bob.cookie)).body.items).toEqual([])
    const res = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${appId}`,
      jsonRequest('PATCH', { ownerAccountId: bob.accountId }, { cookie: ws.cookie }),
    )
    expect(res.status).toBe(200)
    expect((await get<RecallEventList>('/recall/events', bob.cookie)).body.items).toEqual([])
    expect((await get<RecallEventList>(`/recall/events?appId=${appId}`)).body.items).toHaveLength(1)
  })

  it('从没被召回的不算会进启动上下文的节点，也要等建了、开始记录都满保留天数', async () => {
    await create({ uri: 'core://agent', content: '基础规则', layer: 'base', priority: 0 })
    await ws.createPersona('doubao')
    // 人格层由管理界面写：这个应用没有人格，它的 Key 写不了
    const persona = await app.request(
      `/v1/spaces/${ws.spaceId}/memories`,
      jsonRequest(
        'POST',
        { uri: 'persona://doubao/tone', content: '口吻', priority: 1 },
        { cookie: ws.cookie },
      ),
    )
    expect(persona.status).toBe(201)
    await create({ uri: 'notes://fresh', content: '刚建的' })
    await backdate(31)
    await recordingStarted(40)
    await create({ uri: 'notes://newer', content: '昨天建的' })
    const stats = (await get<RecallStats>('/recall/stats')).body
    // core://agent 与 persona 层 priority 1 的节点每次会话开始都注入；notes://newer 建了还不到 30 天
    expect(stats.never.map((m) => m.uri).sort()).toEqual([
      'notes://deploy',
      'notes://fresh',
      'notes://idle',
      'projects://kioku',
    ])
    expect((await get<SpaceOverview>('/overview')).body.neverRecalled).toBe(4)

    // 开始记录召回事件才 1 天：之前的记忆没机会被记下召回，都不算
    await database.db.delete(settings)
    await recordingStarted(1)
    const recent = (await get<RecallStats>('/recall/stats')).body
    expect(recent.never).toEqual([])
    expect(recent.neverTotal).toBe(0)
    expect((await get<SpaceOverview>('/overview')).body.neverRecalled).toBe(0)

    // 开始记录的时间缺了（或读不出日期）时当作刚开始记录：不会把旧记忆一下子全算进来
    await database.db.delete(settings)
    expect((await get<RecallStats>('/recall/stats')).body.neverTotal).toBe(0)
  })

  it('概览的「从没被召回」只数建了超过保留天数的', async () => {
    await recallAs('kioku')
    const before = (await get<SpaceOverview>('/overview')).body
    expect(before.neverRecalled).toBe(0)
    await backdate(31)
    // 开始记录召回事件的时间也要满保留天数
    expect((await get<SpaceOverview>('/overview')).body.neverRecalled).toBe(0)
    await recordingStarted(40)
    const after = (await get<SpaceOverview>('/overview')).body
    // notes://deploy 与 notes://idle 没被召回；secret 不算
    expect(after.neverRecalled).toBe(2)
    expect(
      await withSpace(database.db, ws.spaceId, (tx) => tx.select().from(recallEvents)),
    ).toHaveLength(1)
  })
})
