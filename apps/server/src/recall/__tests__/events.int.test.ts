import { randomBytes } from 'node:crypto'

import type { KeyInfo } from '@kioku/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memoryRecallStats, recallEventHits, recallEvents, settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { pruneRecallEvents } from '../retention'

describe.skipIf(!testDatabaseUrl)('召回事件', () => {
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
    appId = (await ws.createApp('agent', { runtimeFamily: 'claudecode' })).id
    key = await ws.issueKey(appId)
    await create({ uri: 'projects://kioku', content: 'Kioku 是记忆服务', glossary: ['kioku'] })
    await create({ uri: 'notes://deploy', content: '部署步骤', glossary: ['部署'] })
  })

  const create = async (body: Record<string, unknown>) => {
    const res = await app.request('/v1/memories', jsonRequest('POST', body, bearer(key)))
    if (res.status !== 201) throw new Error(await res.text())
  }
  const post = (path: string, body: unknown) =>
    app.request(`/v1${path}`, jsonRequest('POST', body, bearer(key)))
  // 事件不挡住响应，写完要等一下
  const events = () =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(recallEvents).orderBy(asc(recallEvents.id)),
    )
  const eventCount = async () => (await events()).length

  it('REST 召回、每轮输入、会话开始的项目召回都记一条，带着命中的记忆、名次、分数与来路', async () => {
    await post('/recall', { query: 'kioku 怎么部署' })
    await post('/lifecycle/event', { event: 'prompt.submit', prompt: 'kioku 部署' })
    await post('/lifecycle/event', { event: 'session.start', project: { dirName: 'kioku' } })
    // 没有项目的会话开始不召回，只有空白的输入也不召回，都不记
    await post('/lifecycle/event', { event: 'session.start' })
    await post('/lifecycle/event', { event: 'prompt.submit', prompt: '   ' })
    await expect.poll(eventCount).toBe(3)

    const rows = await events()
    expect(rows.map((e) => e.source)).toEqual(['rest.recall', 'prompt.submit', 'session.start'])
    expect(rows.every((e) => e.appId === appId && e.ownerAccountId === ws.accountId)).toBe(true)
    expect(rows[2]!.query).toBe('kioku')
    const hits = await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .select()
        .from(recallEventHits)
        .where(eq(recallEventHits.eventId, rows[0]!.id))
        .orderBy(asc(recallEventHits.rank)),
    )
    expect(hits.map((h) => h.rank)).toEqual([1, 2])
    expect(hits[0]!.score).toBeGreaterThan(0)
    expect(hits[0]!.via).toContain('glossary')
  })

  it('MCP 搜索也记一条', async () => {
    const res = await app.request(
      '/v1/mcp',
      jsonRequest(
        'POST',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'kioku_search', arguments: { query: 'kioku' } },
        },
        { ...bearer(key), accept: 'application/json, text/event-stream' },
      ),
    )
    expect(res.status).toBe(200)
    await expect.poll(eventCount).toBe(1)
    expect((await events())[0]!.source).toBe('mcp.search')
  })

  it('提示语先打码再截到 200 字；应用关掉记录提示语时不存', async () => {
    const prompt = `路由器密码：hunter2 别记下来\n${'很长的一段话'.repeat(60)}`
    await post('/recall', { query: prompt })
    await expect.poll(eventCount).toBe(1)
    const [first] = await events()
    expect(first!.query).toHaveLength(200)
    expect(first!.query!.startsWith('路由器密码：***\n很长的一段话')).toBe(true)
    expect(first!.query).not.toContain('hunter2')

    const res = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${appId}`,
      jsonRequest('PATCH', { config: { recordPrompt: false } }, { cookie: ws.cookie }),
    )
    expect(res.status).toBe(200)
    await post('/recall', { query: 'kioku' })
    await expect.poll(eventCount).toBe(2)
    expect((await events())[1]!.query).toBeNull()
  })

  it('管理界面的启动预览与召回调试不记', async () => {
    const [info] = (await (
      await app.request(`/v1/spaces/${ws.spaceId}/apps/${appId}/keys`, {
        headers: { cookie: ws.cookie },
      })
    ).json()) as KeyInfo[]
    const base = `/v1/spaces/${ws.spaceId}/apps/${appId}/keys/${info!.id}`
    const cookie = { cookie: ws.cookie }
    expect(
      (
        await app.request(
          `${base}/preview`,
          jsonRequest('POST', { project: { dirName: 'kioku' } }, cookie),
        )
      ).status,
    ).toBe(200)
    expect(
      (await app.request(`${base}/debug`, jsonRequest('POST', { query: 'kioku' }, cookie))).status,
    ).toBe(200)
    // 再触发一次真实召回，等它写完，确认前面两次确实没有留下事件
    await post('/recall', { query: 'kioku' })
    await expect.poll(eventCount).toBe(1)
    expect((await events())[0]!.source).toBe('rest.recall')
  })

  it('记下事件发生时的应用主人：应用转给别人之后，之前的事件仍是原来的主人', async () => {
    await post('/recall', { query: 'kioku' })
    await expect.poll(eventCount).toBe(1)
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const res = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${appId}`,
      jsonRequest('PATCH', { ownerAccountId: bob.accountId }, { cookie: ws.cookie }),
    )
    expect(res.status).toBe(200)
    const [event] = await events()
    expect(event!.ownerAccountId).toBe(ws.accountId)
  })

  it('清理超过保留天数的明细，删之前把次数与最后一次的时间并入累计统计', async () => {
    await post('/recall', { query: 'kioku' })
    await post('/recall', { query: 'kioku 部署' })
    await post('/recall', { query: 'kioku' })
    await expect.poll(eventCount).toBe(3)
    const [old1, old2] = await events()
    // 前两条改成 40 天前、39 天前的
    await withSpace(database.db, ws.spaceId, async (tx) => {
      await tx
        .update(recallEvents)
        .set({ createdAt: sql`now() - interval '40 days'` })
        .where(eq(recallEvents.id, old1!.id))
      await tx
        .update(recallEvents)
        .set({ createdAt: sql`now() - interval '39 days'` })
        .where(eq(recallEvents.id, old2!.id))
    })

    expect(await pruneRecallEvents(database.db, 30)).toBe(2)
    expect(await eventCount()).toBe(1)
    const stats = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memoryRecallStats),
    )
    const counts = Object.fromEntries(stats.map((s) => [s.memoryId, s.count]))
    expect(Object.values(counts).sort()).toEqual([1, 2])
    const latest = Math.max(...stats.map((s) => s.lastRecalledAt.getTime()))
    expect(Date.now() - latest).toBeGreaterThan(38 * 86_400_000)

    // 再清一次：没有到期的明细，累计不变；新到期的接着累加
    expect(await pruneRecallEvents(database.db, 30)).toBe(0)
    expect(await pruneRecallEvents(database.db, 0)).toBe(1)
    const after = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memoryRecallStats),
    )
    expect(after.reduce((sum, s) => sum + s.count, 0)).toBe(
      stats.reduce((sum, s) => sum + s.count, 0) + 1,
    )
  })

  it('两次清理同时跑时不会把同一批明细并入两次', async () => {
    await post('/recall', { query: 'kioku' })
    await post('/recall', { query: 'kioku' })
    await expect.poll(eventCount).toBe(2)
    // 另一条连接锁住全部明细，让两次清理都等在锁上，再放开
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    const pending: Promise<number>[] = []
    try {
      await side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        await tx`select id from recall_events for update`
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }]
        pending.push(pruneRecallEvents(database.db, 0), pruneRecallEvents(database.db, 0))
        // 后一个清理排在前一个后面等同一批行锁，它被前一个挡住，不是直接被锁行的连接挡住
        for (let i = 0; ; i++) {
          const rows = await side<{ pid: number; by: number[] }[]>`
            select pid, pg_blocking_pids(pid) as by from pg_stat_activity
            where cardinality(pg_blocking_pids(pid)) > 0`
          const waiting = new Set([pid])
          for (let grew = true; grew;) {
            grew = false
            for (const row of rows) {
              if (!waiting.has(row.pid) && row.by.some((b) => waiting.has(b))) {
                waiting.add(row.pid)
                grew = true
              }
            }
          }
          if (waiting.size >= 3) break
          if (i >= 80) throw new Error('两次清理没有都等在明细的行锁上')
          await new Promise((r) => setTimeout(r, 25))
        }
      })
      const removed = await Promise.all(pending)
      expect(removed.reduce((a, b) => a + b, 0)).toBe(2)
    } finally {
      await Promise.allSettled(pending)
      await side.end()
    }
    const stats = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memoryRecallStats),
    )
    expect(stats.map((s) => s.count)).toEqual([2])
  })

  it('保留天数在实例设置里改，默认 30 天，只有实例管理员能改', async () => {
    const cookie = { cookie: ws.cookie }
    const view = await app.request('/v1/settings/recall', { headers: cookie })
    expect(await view.json()).toEqual({ retentionDays: 30 })
    const saved = await app.request(
      '/v1/settings/recall',
      jsonRequest('PUT', { retentionDays: 7 }, cookie),
    )
    expect(saved.status).toBe(200)
    expect(await (await app.request('/v1/settings/recall', { headers: cookie })).json()).toEqual({
      retentionDays: 7,
    })
    const member = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    expect(
      (await app.request('/v1/settings/recall', { headers: { cookie: member.cookie } })).status,
    ).toBe(403)
  })
})
