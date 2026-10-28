import { randomBytes } from 'node:crypto'

import type { LifecycleResponse } from '@kioku/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { conversationTurns, settings, subjectIdentities } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Jobs } from '../../jobs/queue'
import { startJobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bearer, bootstrap, FULL_SCOPES, jsonRequest, type Workspace } from '../../testing/fixtures'
import {
  BATCH_TURNS,
  IDLE_SECONDS,
  MAX_BUFFERED_TURNS,
  pruneConversationTurns,
  type BufferedSession,
} from '../buffer'
import { saveExtractionConfig } from '../settings'
import { processSession } from '../worker'

describe.skipIf(!testDatabaseUrl)('会话缓冲', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let appId: string
  let key: string
  const masterKey = randomBytes(32)
  // 记下排了哪些抽取任务，不启动后台任务
  const queued: [BufferedSession, number][] = []
  const jobs: Jobs = {
    enqueueEmbed() {},
    enqueueBackfill: async () => true,
    enqueueExtraction: async (target, delay) => void queued.push([target, delay]),
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
    await database?.db.delete(settings).where(eq(settings.key, 'extraction'))
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings).where(eq(settings.key, 'extraction'))
    queued.length = 0
    ws = await bootstrap(app)
    appId = (await ws.createApp('qq-bot', { runtimeFamily: 'astrbot' })).id
    key = await ws.issueKey(appId)
  })

  const turnEnd = async (body: Record<string, unknown>, k = key) => {
    const res = await app.request(
      '/v1/lifecycle/event',
      jsonRequest('POST', { event: 'turn.end', ...body }, bearer(k)),
    )
    return { status: res.status, body: (await res.json()) as LifecycleResponse }
  }
  const direct = { chatType: 'direct', platform: 'qq', sender: { id: '1001', name: '小明' } }
  const group = {
    chatType: 'group',
    platform: 'qq',
    group: { id: '2001', name: '读书会' },
    sender: { id: '1002', name: '群名片' },
  }
  const turns = () =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(conversationTurns).orderBy(asc(conversationTurns.id)),
    )
  const subjectOf = async (kind: 'person' | 'group', externalId: string) => {
    const rows = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(subjectIdentities).where(eq(subjectIdentities.externalId, externalId)),
    )
    return rows.find((r) => r.kind === kind)!.subjectId
  }
  const session = (sessionId: string): BufferedSession => ({
    spaceId: ws.spaceId,
    appId,
    sessionId,
  })

  it('格式不对返回 400：要带会话、私聊群聊或频道的上下文，群里要带发言人', async () => {
    for (const body of [
      { context: direct, user: '你好', reply: '你好呀' },
      { sessionId: 's1', user: '你好', reply: '你好呀' },
      { sessionId: 's1', context: { chatType: 'cron' }, user: '你好', reply: '你好呀' },
      {
        sessionId: 's1',
        context: { chatType: 'group', platform: 'qq', group: { id: '2001' } },
        user: '你好',
        reply: '你好呀',
      },
      { sessionId: 's1', context: direct, user: '', reply: '你好呀' },
      { sessionId: '', context: direct, user: '你好', reply: '你好呀' },
    ]) {
      expect((await turnEnd(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await turns()).toEqual([])
    expect(queued).toEqual([])
  })

  it('私聊与群聊的一轮进缓冲，记下对象与这一轮的发言人名字；不满一批时等会话空闲再抽取', async () => {
    const first = await turnEnd({
      sessionId: 'qq:1001',
      context: direct,
      user: '我在学日语',
      reply: '加油',
    })
    expect(first).toEqual({
      status: 200,
      body: { hostOutput: { mode: 'none', value: null }, nodeUris: [] },
    })
    await turnEnd({ sessionId: 'qq:g2001', context: group, user: '周五读什么', reply: '还没定' })
    const rows = await turns()
    expect(rows).toMatchObject([
      {
        appId,
        sessionId: 'qq:1001',
        chatType: 'direct',
        groupSubjectId: null,
        senderSubjectId: await subjectOf('person', '1001'),
        senderName: '小明',
        userText: '我在学日语',
        replyText: '加油',
      },
      {
        sessionId: 'qq:g2001',
        chatType: 'group',
        groupSubjectId: await subjectOf('group', '2001'),
        senderSubjectId: await subjectOf('person', '1002'),
        senderName: '群名片',
      },
    ])
    expect(queued).toEqual([
      [session('qq:1001'), IDLE_SECONDS],
      [session('qq:g2001'), IDLE_SECONDS],
    ])
  })

  it('攒满一批就马上排抽取', async () => {
    for (let i = 1; i <= BATCH_TURNS; i++) {
      await turnEnd({ sessionId: 's', context: direct, user: `第 ${i} 句`, reply: '嗯' })
    }
    expect(queued.map(([, delay]) => delay)).toEqual([
      ...Array<number>(BATCH_TURNS - 1).fill(IDLE_SECONDS),
      0,
    ])
  })

  it('Key 写不了对象层与情节层时不缓冲：抽取出的东西写不进去，不必存下别人的话', async () => {
    const readOnly = await ws.issueKey(appId, { ...FULL_SCOPES, writeLayers: [] })
    const privateOnly = await ws.issueKey(appId, { ...FULL_SCOPES, writeLayers: ['private'] })
    for (const k of [readOnly, privateOnly]) {
      const res = await turnEnd({ sessionId: 's', context: direct, user: '你好', reply: '嗯' }, k)
      expect(res.status).toBe(200)
      expect(res.body.hostOutput.mode).toBe('none')
    }
    expect(await turns()).toEqual([])
    expect(queued).toEqual([])
  })

  it(`每个会话最多留 ${MAX_BUFFERED_TURNS} 轮，多出来的丢掉最早的；别的会话不受影响`, async () => {
    await turnEnd({ sessionId: 'other', context: direct, user: '别的会话', reply: '嗯' })
    await turnEnd({ sessionId: 's', context: direct, user: '第 0 句', reply: '嗯' })
    const [seed] = await turns()
    // 直接写库补满，省得发一百多个请求
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(conversationTurns).values(
        Array.from({ length: MAX_BUFFERED_TURNS + 1 }, (_, i) => ({
          ...seed!,
          id: undefined,
          sessionId: 's',
          userText: `补的第 ${i + 1} 句`,
        })),
      ),
    )
    await turnEnd({ sessionId: 's', context: direct, user: '最后一句', reply: '嗯' })
    const rows = (await turns()).filter((r) => r.sessionId === 's')
    expect(rows).toHaveLength(MAX_BUFFERED_TURNS)
    expect(rows[0]!.userText).toBe('补的第 3 句')
    expect(rows.at(-1)!.userText).toBe('最后一句')
    expect((await turns()).filter((r) => r.sessionId === 'other')).toHaveLength(1)
  })

  it('抽取任务：没配抽取模型时丢掉这个会话的缓冲，配了时留给抽取', async () => {
    await turnEnd({ sessionId: 'a', context: direct, user: '一', reply: '嗯' })
    await turnEnd({ sessionId: 'b', context: direct, user: '二', reply: '嗯' })
    await processSession(database.db, masterKey, session('a'))
    expect((await turns()).map((r) => r.sessionId)).toEqual(['b'])

    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
    await processSession(database.db, masterKey, session('b'))
    expect((await turns()).map((r) => r.sessionId)).toEqual(['b'])
  })

  it('清理任务删掉放了超过一天的对话', async () => {
    await turnEnd({ sessionId: 'old', context: direct, user: '很久以前', reply: '嗯' })
    await turnEnd({ sessionId: 'new', context: direct, user: '刚才', reply: '嗯' })
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(conversationTurns)
        .set({ createdAt: sql`now() - interval '25 hours'` })
        .where(eq(conversationTurns.sessionId, 'old')),
    )
    expect(await pruneConversationTurns(database.db)).toBe(1)
    expect((await turns()).map((r) => r.sessionId)).toEqual(['new'])
  })

  it('后台任务：同一个会话只排一个，再来一轮就把开始时间推后；到点后没配模型就丢掉缓冲', async () => {
    const real = await startJobs({
      connectionString: testDatabaseUrl!,
      db: database.db,
      embedder: async () => null,
      masterKey,
    })
    const pending = () =>
      database.db.execute<{ state: string; delay: number }>(sql`
        select state, extract(epoch from start_after - now())::int as delay from pgboss.job
        where name = 'extract-session' and singleton_key = ${`${appId}:debounce`}
          and state in ('created', 'retry', 'active')`)
    try {
      await turnEnd({ sessionId: 'debounce', context: direct, user: '一', reply: '嗯' })
      await real.enqueueExtraction(session('debounce'), IDLE_SECONDS)
      await real.enqueueExtraction(session('debounce'), 300)
      const waiting = await pending()
      expect(waiting).toHaveLength(1)
      expect(waiting[0]!.state).toBe('created')
      expect(waiting[0]!.delay).toBeGreaterThan(290)
      expect(waiting[0]!.delay).toBeLessThanOrEqual(300)

      await real.enqueueExtraction(session('debounce'), 0)
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && (await turns()).length > 0) {
        await new Promise((r) => setTimeout(r, 250))
      }
      expect(await turns()).toEqual([])
    } finally {
      await real.stop()
    }
  }, 30_000)
})
