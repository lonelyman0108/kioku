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
import { clearExtractionConfig, saveExtractionConfig } from '../settings'
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
    queued.length = 0
    ws = await bootstrap(app)
    appId = (await ws.createApp('qq-bot', { runtimeFamily: 'astrbot' })).id
    key = await ws.issueKey(appId)
    // 没配抽取模型时不缓冲；用到的用例单独清掉
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
  })

  const turnEnd = async (body: Record<string, unknown>, k = key) => {
    const res = await app.request(
      '/v1/lifecycle/event',
      jsonRequest('POST', { event: 'turn.end', ...body }, bearer(k)),
    )
    return { status: res.status, body: (await res.json()) as LifecycleResponse }
  }
  const direct = (id = '1001', name = '小明') => ({
    chatType: 'direct',
    platform: 'qq',
    sender: { id, name },
  })
  const group = (id = '2001', sender = '1002') => ({
    chatType: 'group',
    platform: 'qq',
    group: { id, name: '读书会' },
    sender: { id: sender, name: '群名片' },
  })
  const turns = () =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(conversationTurns).orderBy(asc(conversationTurns.id)),
    )
  const identities = () =>
    withSpace(database.db, ws.spaceId, (tx) => tx.select().from(subjectIdentities))
  const subjectOf = async (kind: 'person' | 'group', externalId: string) =>
    (await identities()).find((r) => r.kind === kind && r.externalId === externalId)!.subjectId
  const batch = (scope: string): BufferedSession => ({ spaceId: ws.spaceId, appId, scope })

  it('格式不对返回 400：要带会话、私聊群聊或频道的上下文，群里要带发言人', async () => {
    for (const body of [
      { context: direct(), user: '你好', reply: '你好呀' },
      { sessionId: 's1', user: '你好', reply: '你好呀' },
      { sessionId: 's1', context: { chatType: 'cron' }, user: '你好', reply: '你好呀' },
      {
        sessionId: 's1',
        context: { chatType: 'group', platform: 'qq', group: { id: '2001' } },
        user: '你好',
        reply: '你好呀',
      },
      { sessionId: 's1', context: direct(), user: '', reply: '你好呀' },
      { sessionId: '', context: direct(), user: '你好', reply: '你好呀' },
    ]) {
      expect((await turnEnd(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await turns()).toEqual([])
    expect(queued).toEqual([])
  })

  it('私聊与群聊的一轮进缓冲，按来源作用域分批；不满一批时等空闲再抽取', async () => {
    const first = await turnEnd({
      sessionId: 'qq:1001',
      context: direct(),
      user: '我在学日语',
      reply: '加油',
    })
    expect(first).toEqual({
      status: 200,
      body: { hostOutput: { mode: 'none', value: null }, nodeUris: [] },
    })
    await turnEnd({ sessionId: 'qq:g2001', context: group(), user: '周五读什么', reply: '还没定' })
    const person = await subjectOf('person', '1001')
    const g = await subjectOf('group', '2001')
    expect(await turns()).toMatchObject([
      {
        appId,
        scope: `direct:${person}`,
        sessionId: 'qq:1001',
        chatType: 'direct',
        groupSubjectId: null,
        senderSubjectId: person,
        senderName: '小明',
        userText: '我在学日语',
        replyText: '加油',
      },
      {
        scope: `group:${g}`,
        sessionId: 'qq:g2001',
        chatType: 'group',
        groupSubjectId: g,
        senderSubjectId: await subjectOf('person', '1002'),
        senderName: '群名片',
      },
    ])
    expect(queued).toEqual([
      [batch(`direct:${person}`), IDLE_SECONDS],
      [batch(`group:${g}`), IDLE_SECONDS],
    ])
  })

  it('插件给的会话标识重了也不会把私聊混进群里的那一批', async () => {
    await turnEnd({ sessionId: 'same', context: group(), user: '群里说的', reply: '嗯' })
    await turnEnd({ sessionId: 'same', context: direct(), user: '私下说的', reply: '嗯' })
    const scopes = (await turns()).map((r) => r.scope)
    expect(new Set(scopes).size).toBe(2)
    expect(queued.map(([target]) => target.scope)).toEqual(scopes)
  })

  it('攒满一批就马上排抽取', async () => {
    for (let i = 1; i <= BATCH_TURNS; i++) {
      await turnEnd({ sessionId: 's', context: direct(), user: `第 ${i} 句`, reply: '嗯' })
    }
    expect(queued.map(([, delay]) => delay)).toEqual([
      ...Array<number>(BATCH_TURNS - 1).fill(IDLE_SECONDS),
      0,
    ])
  })

  it('没配抽取模型时不缓冲，也不排任务', async () => {
    await clearExtractionConfig(database.db)
    const res = await turnEnd({ sessionId: 's', context: direct(), user: '你好', reply: '嗯' })
    expect(res.status).toBe(200)
    expect(await turns()).toEqual([])
    expect(queued).toEqual([])
  })

  it('Key 写不了对象层与情节层时不缓冲，也不解析会话、不建对象', async () => {
    const readOnly = await ws.issueKey(appId, { ...FULL_SCOPES, writeLayers: [] })
    const privateOnly = await ws.issueKey(appId, { ...FULL_SCOPES, writeLayers: ['private'] })
    for (const k of [readOnly, privateOnly]) {
      const res = await turnEnd({ sessionId: 's', context: group(), user: '你好', reply: '嗯' }, k)
      expect(res.status).toBe(200)
      expect(res.body.hostOutput.mode).toBe('none')
    }
    expect(await turns()).toEqual([])
    expect(await identities()).toEqual([])
    expect(queued).toEqual([])
  })

  it(`每一批最多留 ${MAX_BUFFERED_TURNS} 轮，多出来的丢掉最早的；别的批不受影响`, async () => {
    await turnEnd({ sessionId: 'other', context: direct('1009'), user: '别的人', reply: '嗯' })
    await turnEnd({ sessionId: 's', context: direct(), user: '第 0 句', reply: '嗯' })
    const seed = (await turns()).at(-1)!
    // 直接写库补满，省得发一百多个请求
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(conversationTurns).values(
        Array.from({ length: MAX_BUFFERED_TURNS + 1 }, (_, i) => ({
          ...seed,
          id: undefined,
          userText: `补的第 ${i + 1} 句`,
        })),
      ),
    )
    await turnEnd({ sessionId: 's', context: direct(), user: '最后一句', reply: '嗯' })
    const rows = (await turns()).filter((r) => r.scope === seed.scope)
    expect(rows).toHaveLength(MAX_BUFFERED_TURNS)
    expect(rows[0]!.userText).toBe('补的第 3 句')
    expect(rows.at(-1)!.userText).toBe('最后一句')
    expect((await turns()).filter((r) => r.scope !== seed.scope)).toHaveLength(1)
  })

  it('抽取任务：缓冲之后抽取模型的设置被清掉了，就把这一批丢掉，别的批不动', async () => {
    await turnEnd({ sessionId: 'a', context: direct('1001'), user: '一', reply: '嗯' })
    await turnEnd({ sessionId: 'b', context: direct('1002'), user: '二', reply: '嗯' })
    const [first, second] = await turns()
    await clearExtractionConfig(database.db)
    await processSession(database.db, masterKey, batch(first!.scope))
    expect((await turns()).map((r) => r.scope)).toEqual([second!.scope])
  })

  it('清理任务整批删掉空闲超过一天的缓冲，还在聊的那批连同旧的几轮都留着', async () => {
    await turnEnd({ sessionId: 'idle', context: direct('1001'), user: '很久以前', reply: '嗯' })
    await turnEnd({ sessionId: 'live', context: direct('1002'), user: '昨天', reply: '嗯' })
    await turnEnd({ sessionId: 'live', context: direct('1002'), user: '刚才', reply: '嗯' })
    const [idle, live] = await turns()
    await withSpace(database.db, ws.spaceId, async (tx) => {
      await tx
        .update(conversationTurns)
        .set({ createdAt: sql`now() - interval '25 hours'` })
        .where(eq(conversationTurns.id, idle!.id))
      await tx
        .update(conversationTurns)
        .set({ createdAt: sql`now() - interval '25 hours'` })
        .where(eq(conversationTurns.id, live!.id))
    })
    expect(await pruneConversationTurns(database.db)).toBe(1)
    expect((await turns()).map((r) => r.userText)).toEqual(['昨天', '刚才'])
  })

  it('后台任务：同一批只排一个，再来一轮就把开始时间推后；到点后设置没了就丢掉缓冲', async () => {
    const real = await startJobs({
      connectionString: testDatabaseUrl!,
      db: database.db,
      embedder: async () => null,
      masterKey,
    })
    try {
      await turnEnd({ sessionId: 'debounce', context: direct(), user: '一', reply: '嗯' })
      const target = batch((await turns())[0]!.scope)
      const pending = () =>
        database.db.execute<{ state: string; delay: number }>(sql`
          select state, extract(epoch from start_after - now())::int as delay from pgboss.job
          where name = 'extract-session' and singleton_key = ${`${appId}|${target.scope}`}
            and state in ('created', 'retry', 'active')`)
      await real.enqueueExtraction(target, IDLE_SECONDS)
      await real.enqueueExtraction(target, 300)
      const waiting = await pending()
      expect(waiting).toHaveLength(1)
      expect(waiting[0]!.state).toBe('created')
      expect(waiting[0]!.delay).toBeGreaterThan(290)
      expect(waiting[0]!.delay).toBeLessThanOrEqual(300)

      await clearExtractionConfig(database.db)
      await real.enqueueExtraction(target, 0)
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
