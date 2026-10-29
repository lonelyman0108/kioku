import { randomBytes } from 'node:crypto'

import type { ReviewList, ReviewResult, SessionContextInput } from '@kioku/contracts'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import postgres from 'postgres'
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
    enqueueSwitch: async () => true,
    enqueuePrune: async () => true,
    enqueueBackup: async () => null,
    backupRun: async () => null,
    enqueueExtraction: async () => {},
    enqueueCleanup: async () => true,
    enqueueDream: async () => null,
    dreamRun: async () => null,
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
  type Seen = { id: string; version: number }
  const act = async (action: 'confirm' | 'delete', items: Seen[], cookie = ws.cookie) => {
    const body = { action, items: items.map(({ id, version }) => ({ id, version })) }
    const res = await api('POST', '/review', body, cookie)
    return { status: res.status, body: (await res.json()) as ReviewResult }
  }
  const group: SessionContextInput = {
    chatType: 'group',
    platform: 'qq',
    group: { id: '2001', name: '读书会' },
    sender: { id: '1001', name: '小明' },
  }
  // 群里说一句，抽取出小明与群的两条事实和一条会话摘要（都是不可信来源）
  const chatInGroup = async (
    reply: unknown = {
      facts: [
        { subject: 'M1', op: 'add', content: '在学日语' },
        { subject: 'G', op: 'add', content: '是个读书会' },
      ],
      summary: '群里聊了学日语',
    },
  ) => {
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
      () => fakeModel(reply),
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

    // 每页 50 条；总数只在第一页给
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(memories).values(
        Array.from({ length: 55 }, (_, i) => ({
          spaceId: ws.spaceId,
          form: 'extracted' as const,
          layer: 'episode' as const,
          sensitivity: 'public' as const,
          provenance: 'untrusted' as const,
          originScope: 'global',
          content: `摘要${i}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        })),
      ),
    )
    const first = await queue('?layer=episode')
    expect([first.items.length, first.total]).toEqual([50, 56])
    const second = await queue(`?layer=episode&cursor=${first.nextCursor}`)
    expect([second.items.length, second.total, second.nextCursor]).toEqual([6, null, null])
  })

  it('确认：来源改成主人、记一条确认事件，离开队列；删除和删记忆一样；处理过的再处理就跳过', async () => {
    await chatInGroup()
    const items = (await queue()).items
    const facts = items.filter((i) => i.layer === 'subject')
    const factIds = facts.map((f) => f.id)
    const summary = items.find((i) => i.layer === 'episode')!

    // 同一条出现两次的请求不收
    expect((await act('confirm', [...facts, facts[0]!])).status).toBe(400)
    expect(await act('confirm', facts)).toEqual({
      status: 200,
      body: { done: 2, skipped: 0 },
    })
    expect((await rowsOf(factIds)).map((r) => [r.provenance, r.version])).toEqual([
      ['owner', 2],
      ['owner', 2],
    ])
    expect(await eventsOf(factIds)).toEqual([
      { type: 'confirm', accountId: ws.accountId },
      { type: 'confirm', accountId: ws.accountId },
    ])
    expect((await queue()).items.map((i) => i.id)).toEqual([summary.id])

    // 看过之后被改过（版本对不上）的不处理
    expect(await act('delete', [{ id: summary.id, version: summary.version + 1 }])).toEqual({
      status: 200,
      body: { done: 0, skipped: 1 },
    })
    expect(await act('delete', [summary])).toEqual({ status: 200, body: { done: 1, skipped: 0 } })
    expect((await rowsOf([summary.id]))[0]!.deletedAt).not.toBeNull()
    expect((await queue()).total).toBe(0)

    // 已经处理过、删掉了、不存在的都跳过
    expect(
      await act('confirm', [...facts, summary, { id: crypto.randomUUID(), version: 1 }]),
    ).toEqual({
      status: 200,
      body: { done: 0, skipped: 4 },
    })
  })

  it('确认过的事实不会被群里的抽取推翻：模型说要更新它时，当作一条新的待审事实', async () => {
    await chatInGroup()
    const fact = (await queue('?layer=subject')).items.find((i) => i.content === '在学日语')!
    expect((await act('confirm', [fact])).body.done).toBe(1)

    // 抽取时给模型看的已有事实里，确认过的这条是 F1
    await chatInGroup({
      facts: [{ subject: 'M1', op: 'update', replaces: 'F1', content: '在学韩语' }],
    })
    const [kept] = await rowsOf([fact.id])
    expect([kept!.provenance, kept!.validTo]).toEqual(['owner', null])
    expect((await queue('?layer=subject')).items.map((i) => i.content)).toContain('在学韩语')
  })

  it('正在被别的写入改着的行不等锁，直接跳过', async () => {
    await chatInGroup()
    const [first, second] = (await queue('?layer=subject')).items
    const side = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
    try {
      await side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        await tx`select id from memories where id = ${first!.id} for update`
        // 锁还在的时候处理：被锁住的那条跳过，另一条照常确认，请求不会卡住
        expect(await act('confirm', [first!, second!])).toEqual({
          status: 200,
          body: { done: 1, skipped: 1 },
        })
      })
    } finally {
      await side.end()
    }
    expect((await queue('?layer=subject')).items.map((i) => i.id)).toEqual([first!.id])
  })

  it('viewer 只能看；别的空间的记忆碰不到', async () => {
    await chatInGroup()
    const carol = await addMember(database.db, ws.spaceId, 'carol', 'viewer')
    const seen = (await queue('', carol.cookie)).items
    expect(seen).toHaveLength(3)
    expect((await act('confirm', seen, carol.cookie)).status).toBe(403)
    expect((await queue()).total).toBe(3)

    // 另一个空间的同一批 id 读不到，当作不在队列里
    const [other] = await database.db.insert(spaces).values({ name: '别人家' }).returning()
    const outsider = await addMember(database.db, other!.id, 'dave', 'owner')
    const res = await app.request(
      `/v1/spaces/${other!.id}/review`,
      jsonRequest(
        'POST',
        { action: 'delete', items: seen.map(({ id, version }) => ({ id, version })) },
        { cookie: outsider.cookie },
      ),
    )
    expect(await res.json()).toEqual({ done: 0, skipped: 3 })
    expect((await queue()).total).toBe(3)
  })
})
