import { randomBytes } from 'node:crypto'

import type { ReviewList, ReviewResult, SessionContextInput } from '@kioku/contracts'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { conversationTurns, memories, memoryEvents, settings, spaces } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { ChatModel } from '../../extraction/provider'
import { saveExtractionConfig } from '../../extraction/settings'
import { processSession } from '../../extraction/worker'
import type { Jobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const fakeModel = (reply: unknown): ChatModel => ({
  model: 'fake-model',
  async complete() {
    return { content: JSON.stringify(reply), usage: { promptTokens: 40, completionTokens: 10 } }
  },
})

describe.skipIf(!testDatabaseUrl)('待审队列', () => {
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

  const api = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(
      `/v1/spaces/${ws.spaceId}${path}`,
      method === 'GET' ? { headers: { cookie } } : jsonRequest(method, body, { cookie }),
    )
  const queue = async (query = '', cookie = ws.cookie) => {
    const res = await api('GET', `/review${query}`, undefined, cookie)
    expect(res.status).toBe(200)
    return (await res.json()) as ReviewList
  }
  const act = async (action: 'confirm' | 'delete', ids: string[], cookie = ws.cookie) => {
    const res = await api('POST', '/review', { action, ids }, cookie)
    return { status: res.status, body: (await res.json()) as ReviewResult }
  }
  const group: SessionContextInput = {
    chatType: 'group',
    platform: 'qq',
    group: { id: '2001', name: '读书会' },
    sender: { id: '1001', name: '小明' },
  }
  // 群里说一句，抽取出小明与群的两条事实和一条会话摘要（都是不可信来源）
  const chatInGroup = async () => {
    const res = await app.request(
      '/v1/lifecycle/event',
      jsonRequest(
        'POST',
        { event: 'turn.end', sessionId: 's', context: group, user: '我在学日语', reply: '嗯' },
        bearer(key),
      ),
    )
    expect(res.status).toBe(200)
    const [turn] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(conversationTurns).orderBy(asc(conversationTurns.id)).limit(1),
    )
    await processSession(
      database.db,
      masterKey,
      { spaceId: ws.spaceId, appId, scope: turn!.scope },
      () =>
        fakeModel({
          facts: [
            { subject: 'M1', op: 'add', content: '在学日语' },
            { subject: 'G', op: 'add', content: '是个读书会' },
          ],
          summary: '群里聊了学日语',
        }),
    )
  }
  const rowsOf = (ids: string[]) =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memories).where(inArray(memories.id, ids)),
    )
  const eventsOf = (ids: string[]) =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .select({ type: memoryEvents.eventType, accountId: memoryEvents.actorAccountId })
        .from(memoryEvents)
        .where(and(inArray(memoryEvents.memoryId, ids), eq(memoryEvents.eventType, 'confirm'))),
    )

  it('列出不可信来源写进对象层与情节层的、现在有效的记忆，带对象与来源；能按层筛选', async () => {
    await chatInGroup()
    const all = await queue()
    expect(all.total).toBe(3)
    expect(all.items.map((i) => [i.layer, i.content]).sort()).toEqual([
      ['episode', '群里聊了学日语'],
      ['subject', '在学日语'],
      ['subject', '是个读书会'],
    ])
    const fact = all.items.find((i) => i.content === '在学日语')!
    expect(fact).toMatchObject({
      uri: null,
      subject: { kind: 'person', displayName: '小明' },
      scope: { kind: 'group', name: '读书会' },
    })
    expect((await queue('?layer=episode')).items.map((i) => i.content)).toEqual(['群里聊了学日语'])

    // 失效的不在队列里
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ validTo: sql`now()` })
        .where(eq(memories.content, '是个读书会')),
    )
    expect((await queue()).total).toBe(2)
    expect((await api('GET', '/review?cursor=abc')).status).toBe(400)
  })

  it('确认：来源改成主人、记一条确认事件，离开队列；删除和删记忆一样；处理过的再处理就跳过', async () => {
    await chatInGroup()
    const items = (await queue()).items
    const facts = items.filter((i) => i.layer === 'subject').map((i) => i.id)
    const summary = items.find((i) => i.layer === 'episode')!.id

    expect(await act('confirm', [...facts, facts[0]!])).toEqual({
      status: 200,
      body: { done: 2, skipped: 0 },
    })
    expect((await rowsOf(facts)).map((r) => [r.provenance, r.version])).toEqual([
      ['owner', 2],
      ['owner', 2],
    ])
    expect(await eventsOf(facts)).toEqual([
      { type: 'confirm', accountId: ws.accountId },
      { type: 'confirm', accountId: ws.accountId },
    ])
    expect((await queue()).items.map((i) => i.id)).toEqual([summary])

    expect(await act('delete', [summary])).toEqual({ status: 200, body: { done: 1, skipped: 0 } })
    expect((await rowsOf([summary]))[0]!.deletedAt).not.toBeNull()
    expect((await queue()).total).toBe(0)

    // 已经处理过、删掉了、不存在的都跳过
    expect(await act('confirm', [...facts, summary, crypto.randomUUID()])).toEqual({
      status: 200,
      body: { done: 0, skipped: 4 },
    })
  })

  it('viewer 只能看；别的空间的记忆碰不到', async () => {
    await chatInGroup()
    const carol = await addMember(database.db, ws.spaceId, 'carol', 'viewer')
    const ids = (await queue('', carol.cookie)).items.map((i) => i.id)
    expect(ids).toHaveLength(3)
    expect((await act('confirm', ids, carol.cookie)).status).toBe(403)
    expect((await queue()).total).toBe(3)

    // 另一个空间的同一批 id 读不到，当作不在队列里
    const [other] = await database.db.insert(spaces).values({ name: '别人家' }).returning()
    const outsider = await addMember(database.db, other!.id, 'dave', 'owner')
    const res = await app.request(
      `/v1/spaces/${other!.id}/review`,
      jsonRequest('POST', { action: 'delete', ids }, { cookie: outsider.cookie }),
    )
    expect(await res.json()).toEqual({ done: 0, skipped: 3 })
    expect((await queue()).total).toBe(3)
  })
})
