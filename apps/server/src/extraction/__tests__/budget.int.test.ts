import { randomBytes } from 'node:crypto'

import type { ExtractionUsage, SpaceOverview } from '@kioku/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { conversationTurns, extractionRuns, memories, settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Jobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import type { ChatMessage, ChatModel } from '../provider'
import { saveExtractionConfig } from '../settings'
import { processSession } from '../worker'

function fakeModel(reply: string) {
  const calls: ChatMessage[][] = []
  const model: ChatModel = {
    model: 'fake-model',
    async complete(messages) {
      calls.push(messages)
      return { content: reply, usage: { promptTokens: 40, completionTokens: 10 } }
    },
  }
  return { model, calls }
}

describe.skipIf(!testDatabaseUrl)('抽取预算', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let appId: string
  let key: string
  const masterKey = randomBytes(32)
  const jobs: Jobs = {
    enqueueEmbed() {},
    enqueueBackfill: async () => true,
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
    await database?.db.delete(settings).where(eq(settings.key, 'extraction'))
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    appId = (await ws.createApp('qq-bot', { runtimeFamily: 'astrbot' })).id
    key = await ws.issueKey(appId)
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
  })

  const budgetApi = (method: string, body?: unknown, cookie = ws.cookie) =>
    app.request(`/v1/spaces/${ws.spaceId}/extraction-budget`, jsonRequest(method, body, { cookie }))
  const usage = async () => (await (await budgetApi('GET')).json()) as ExtractionUsage
  const setBudget = (monthlyTokens: number, dailyWritesPerSubject: number) =>
    budgetApi('PUT', { monthlyTokens, dailyWritesPerSubject })
  const say = async (user: string, sender = '1001') => {
    const res = await app.request(
      '/v1/lifecycle/event',
      jsonRequest(
        'POST',
        {
          event: 'turn.end',
          sessionId: 's',
          context: {
            chatType: 'group',
            platform: 'qq',
            group: { id: '2001', name: '读书会' },
            sender: { id: sender, name: '小明' },
          },
          user,
          reply: '嗯',
        },
        bearer(key),
      ),
    )
    expect(res.status).toBe(200)
  }
  const extract = async (model: ChatModel) => {
    const [turn] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(conversationTurns).orderBy(asc(conversationTurns.id)).limit(1),
    )
    await processSession(
      database.db,
      masterKey,
      { spaceId: ws.spaceId, appId, scope: turn!.scope },
      () => model,
    )
  }
  const seedRun = (tokens: number, daysAgo = 0) =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(extractionRuns).values({
        spaceId: ws.spaceId,
        appId,
        scope: 'group:x',
        subjectIds: [],
        turns: 1,
        promptTokens: tokens,
        createdAt: sql`now() - make_interval(days => ${daysAgo}::int)` as unknown as Date,
      }),
    )
  const runs = () =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(extractionRuns).orderBy(asc(extractionRuns.id)),
    )
  const facts = () =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memories).where(eq(memories.form, 'extracted')),
    )

  it('默认每月 200 万 token、每个对象每天 20 条；只有空间 owner 能改，格式不对返回 400', async () => {
    const initial = await usage()
    expect(initial).toMatchObject({
      monthlyTokens: 2_000_000,
      dailyWritesPerSubject: 20,
      usedTokens: 0,
    })
    const start = new Date(initial.periodStart)
    expect(start.getUTCDate()).toBe(1)
    expect(start.getUTCHours()).toBe(0)

    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    expect((await budgetApi('GET', undefined, bob.cookie)).status).toBe(200)
    expect(
      (await budgetApi('PUT', { monthlyTokens: 1, dailyWritesPerSubject: 1 }, bob.cookie)).status,
    ).toBe(403)
    expect((await setBudget(-1, 20)).status).toBe(400)
    expect((await setBudget(500_000, 1.5)).status).toBe(400)
    const saved = await setBudget(500_000, 5)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ monthlyTokens: 500_000, dailyWritesPerSubject: 5 })
  })

  it('本月用量是这个月的抽取记录里用掉的 token（失败的那几次也算），上个月的不算；概览里也有', async () => {
    await seedRun(1_000)
    await seedRun(500)
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(extractionRuns).values({
        spaceId: ws.spaceId,
        appId,
        scope: 'group:x',
        subjectIds: [],
        turns: 1,
        promptTokens: 200,
        completionTokens: 50,
        error: '抽取模型的输出里没有约定格式的 JSON 对象',
      }),
    )
    await seedRun(9_999, 40)
    expect((await usage()).usedTokens).toBe(1_750)
    const overview = await app.request(`/v1/spaces/${ws.spaceId}/overview`, {
      headers: { cookie: ws.cookie },
    })
    expect(((await overview.json()) as SpaceOverview).extraction).toMatchObject({
      usedTokens: 1_750,
      monthlyTokens: 2_000_000,
    })
  })

  it('本月的预算用完了只写会话摘要：不给模型看已有的事实，也不写事实', async () => {
    await setBudget(1_000, 20)
    await seedRun(1_000)
    await say('我在学日语')
    const { model, calls } = fakeModel(
      JSON.stringify({
        facts: [{ subject: 'M1', op: 'add', content: '在学日语' }],
        summary: '聊了学日语',
      }),
    )
    await extract(model)
    expect(calls[0]![0]!.content).toContain('概括')
    expect(calls[0]![1]!.content).not.toContain('## 对象')
    expect(calls[0]![1]!.content).toContain('M1 小明：我在学日语')
    expect((await facts()).map((f) => [f.layer, f.content])).toEqual([['episode', '聊了学日语']])
    expect((await runs()).at(-1)).toMatchObject({ summaryOnly: true, added: 0, summarized: true })

    // 下个月恢复：本月的用量清零（这里把已有的记录挪到上个月）
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.update(extractionRuns).set({ createdAt: sql`now() - interval '40 days'` }),
    )
    await say('我还在学日语')
    await extract(
      fakeModel(JSON.stringify({ facts: [{ subject: 'M1', op: 'add', content: '在学日语' }] }))
        .model,
    )
    expect((await runs()).at(-1)).toMatchObject({ summaryOnly: false, added: 1 })
  })

  it('每个对象每天最多写这么多条，写满了的这次不写、计进 limited', async () => {
    await setBudget(2_000_000, 1)
    await say('我在学日语，也在学法语')
    await extract(
      fakeModel(
        JSON.stringify({
          facts: [
            { subject: 'M1', op: 'add', content: '在学日语' },
            { subject: 'M1', op: 'add', content: '在学法语' },
            { subject: 'G', op: 'add', content: '是个读书会' },
          ],
        }),
      ).model,
    )
    expect((await facts()).map((f) => f.content).sort()).toEqual(['在学日语', '是个读书会'])
    expect((await runs())[0]).toMatchObject({ added: 2, limited: 1 })

    // 同一天再来一批，这个人今天已经写满了
    await say('我还在学西班牙语')
    await extract(
      fakeModel(JSON.stringify({ facts: [{ subject: 'M1', op: 'add', content: '在学西班牙语' }] }))
        .model,
    )
    expect((await runs()).at(-1)).toMatchObject({ added: 0, limited: 1 })
  })
})
