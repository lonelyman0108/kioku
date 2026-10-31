import { randomBytes } from 'node:crypto'

import {
  InboxCounts,
  type DreamSuggestionList,
  type MemoryList,
  type MemoryView,
  type ReviewList,
  type SpaceOverview,
} from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database, type Tx } from '../../db/client'
import { dreamSuggestions, memories, subjectBindings, subjects } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('待处理总数', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let editor: { accountId: string; cookie: string }
  let viewer: { accountId: string; cookie: string }

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
    ws = await bootstrap(app)
    editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
  })

  const inSpace = <T>(fn: (tx: Tx) => Promise<T>) => withSpace(database.db, ws.spaceId, fn)
  const get = async <T>(path: string, cookie = ws.cookie) => {
    const res = await app.request(`/v1/spaces/${ws.spaceId}${path}`, { headers: { cookie } })
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as T
  }
  const counts = (cookie = ws.cookie) => get<InboxCounts>('/inbox/counts', cookie)
  const remember = async (body: Record<string, unknown>, cookie = ws.cookie) => {
    const res = await app.request(
      `/v1/spaces/${ws.spaceId}/memories`,
      jsonRequest('POST', body, { cookie }),
    )
    expect(res.status, await res.clone().text()).toBe(201)
    return (await res.json()) as MemoryView
  }
  // 不可信来源写下的对象层、情节层记忆：待确认内容
  const untrusted = (extra: Partial<typeof memories.$inferInsert> = {}) => ({
    spaceId: ws.spaceId,
    form: 'extracted' as const,
    layer: 'episode' as const,
    sensitivity: 'public' as const,
    provenance: 'untrusted' as const,
    content: '群里聊了学日语',
    expiresAt: new Date(Date.now() + 86_400_000),
    ...extra,
  })
  let fingerprint = 0
  const suggestion = (
    memory: MemoryView,
    extra: Partial<typeof dreamSuggestions.$inferInsert> = {},
  ) => ({
    spaceId: ws.spaceId,
    scope: 'base',
    kind: 'stale',
    memoryIds: [memory.id],
    versions: [memory.version],
    reason: '过时了',
    fingerprint: `fp-${++fingerprint}`,
    ...extra,
  })
  // 一条等 accountId 确认的绑定：发码的对象标记成了 marked（默认就是 accountId）
  const binding = async (
    accountId: string,
    extra: Partial<typeof subjectBindings.$inferInsert> = {},
    marked = accountId,
  ) => {
    const bot = await ws.createApp(`bot-${++fingerprint}`, { runtimeFamily: 'astrbot' })
    await inSpace(async (tx) => {
      const [kept, merged] = await tx
        .insert(subjects)
        .values([
          { spaceId: ws.spaceId, kind: 'person', displayName: '本人', accountId: marked },
          { spaceId: ws.spaceId, kind: 'person', displayName: '小号' },
        ])
        .returning()
      await tx.insert(subjectBindings).values({
        spaceId: ws.spaceId,
        appId: bot.id,
        keyId: bot.id,
        subjectId: kept!.id,
        fromSubjectId: merged!.id,
        platform: 'tg',
        externalId: 'u1',
        displayName: '明',
        issuedPlatform: 'qq',
        issuedExternalId: '1001',
        issuedAt: new Date(),
        status: 'pending',
        accountId,
        expiresAt: new Date(Date.now() + 86_400_000),
        ...extra,
      })
    })
  }

  // 四类都有：共享的、只有某个成员看得到的，以及对应的列表里不该出现的
  async function seed() {
    // 疑似明文：共享的一条、alice 与 eve 私人层各一条；secret 的正文是密文不算，没写明文的不算
    await remember({ uri: 'kb://api', content: 'token = abc123', layer: 'base' })
    const aliceNote = await remember({ uri: 'notes://wifi', content: '访客网络密码：guest-1234' })
    await remember({ uri: 'notes://eve', content: 'password = eve-1234' }, editor.cookie)
    await remember({ uri: 'notes://vault', content: '密码：hunter2', sensitivity: 'secret' })
    const plain = await remember({ uri: 'kb://faq', content: '常见问题', layer: 'base' })
    const changed = await remember({ uri: 'kb://changed', content: '会改的', layer: 'base' })

    await inSpace(async (tx) => {
      // 待确认内容：现在有效的两条；到期的、删掉的、受信来源的不算
      await tx
        .insert(memories)
        .values([
          untrusted(),
          untrusted({ content: '又聊了一次' }),
          untrusted({ expiresAt: new Date(Date.now() - 1000) }),
          untrusted({ deletedAt: new Date() }),
          untrusted({ provenance: 'agent' }),
        ])
      await tx.insert(dreamSuggestions).values([
        // 共享层的一条，所有成员都看得到；alice 私人层的一条只有她看得到
        suggestion(plain),
        suggestion(aliceNote, { scope: `private:${ws.accountId}` }),
        // 处理过的、涉及的记忆改过的不算
        suggestion(plain, { status: 'rejected' }),
        suggestion(changed, { versions: [changed.version + 1] }),
      ])
    })
    // 账号绑定：等 alice 的一条；过了期限的、作废的、对象已经不再标记成她的不算；等别人的只有那个人算
    await binding(ws.accountId)
    await binding(ws.accountId, { expiresAt: new Date(Date.now() - 1000) })
    await binding(ws.accountId, {}, editor.accountId)
    await binding(ws.accountId, { status: 'cancelled', decidedAt: new Date() })
    await binding(editor.accountId)
  }

  it('四类各按对应列表的条件数，合计是四类之和；调用方看不到的不算', async () => {
    await seed()
    expect(await counts()).toEqual({
      bindings: 1,
      review: 2,
      dreamSuggestions: 2,
      plaintext: 2,
      total: 7,
    })
    expect(await counts(editor.cookie)).toEqual({
      bindings: 1,
      review: 2,
      dreamSuggestions: 1,
      plaintext: 2,
      total: 6,
    })
    expect(await counts(viewer.cookie)).toEqual({
      bindings: 0,
      review: 2,
      dreamSuggestions: 1,
      plaintext: 1,
      total: 4,
    })
  })

  it('和列表对得上：不同角色看到的条数都和各自的列表一样，概览用的是同一份', async () => {
    await seed()
    for (const cookie of [ws.cookie, editor.cookie, viewer.cookie]) {
      const inbox = await counts(cookie)
      const overview = await get<SpaceOverview>('/overview', cookie)
      expect(overview.inbox).toEqual(inbox)
      expect(overview.pendingBindings.length).toBe(inbox.bindings)
      expect(overview.plaintextCredentials).toBe(inbox.plaintext)
      expect((await get<ReviewList>('/review', cookie)).total).toBe(inbox.review)
      expect((await get<DreamSuggestionList>('/dream/suggestions', cookie)).total).toBe(
        inbox.dreamSuggestions,
      )
      expect((await get<MemoryList>('/memories/list?plaintext=true', cookie)).items.length).toBe(
        inbox.plaintext,
      )
    }
  })

  it('概览单独给出来自对话的条数：按层与敏感级分组，读权限和别处一样；counts 与 total 只算策展记忆', async () => {
    await remember({ uri: 'kb://faq', content: '常见问题', layer: 'base', sensitivity: 'public' })
    const past = new Date(Date.now() - 1000)
    await inSpace(async (tx) => {
      const [person] = await tx
        .insert(subjects)
        .values({ spaceId: ws.spaceId, kind: 'person', displayName: '小明' })
        .returning()
      const fact = (extra: Partial<typeof memories.$inferInsert> = {}) =>
        untrusted({ layer: 'subject', subjectId: person!.id, expiresAt: null, ...extra })
      await tx.insert(memories).values([
        fact({ content: '在学日语' }),
        fact({ content: '住在上海', sensitivity: 'internal', provenance: 'owner' }),
        untrusted(),
        untrusted({ content: '又聊了一次' }),
        // 读不到的不算：被推翻的、到期的、删掉的
        fact({ content: '以前的说法', validTo: past }),
        untrusted({ expiresAt: past }),
        untrusted({ deletedAt: new Date() }),
        // 只有读得到 secret 的成员算
        untrusted({
          sensitivity: 'secret',
          content: null,
          ciphertext: Buffer.from('c'),
          wrappedKey: Buffer.from('k'),
        }),
      ])
    })

    const shared = [
      { layer: 'subject', sensitivity: 'public', count: 1 },
      { layer: 'subject', sensitivity: 'internal', count: 1 },
      { layer: 'episode', sensitivity: 'public', count: 2 },
    ]
    const owner = await get<SpaceOverview>('/overview')
    expect(owner.extractedCounts).toEqual([
      ...shared,
      { layer: 'episode', sensitivity: 'secret', count: 1 },
    ])
    expect(owner.counts).toEqual([{ layer: 'base', sensitivity: 'public', count: 1 }])
    expect(owner.total).toBe(1)
    for (const cookie of [editor.cookie, viewer.cookie]) {
      const o = await get<SpaceOverview>('/overview', cookie)
      expect(o.extractedCounts).toEqual(shared)
      expect(o.total).toBe(1)
    }
  })

  it('空空间全是 0，只有条数，不带内容', async () => {
    const empty = await counts()
    expect(empty).toEqual({ bindings: 0, review: 0, dreamSuggestions: 0, plaintext: 0, total: 0 })
    expect(InboxCounts.strict().safeParse(empty).success).toBe(true)
    const overview = await get<SpaceOverview>('/overview')
    expect(overview.extractedCounts).toEqual([])
  })

  it('不是成员返回 403，没登录返回 401', async () => {
    const res = await app.request('/v1/spaces/00000000-0000-4000-8000-000000000000/inbox/counts', {
      headers: { cookie: ws.cookie },
    })
    expect(res.status).toBe(403)
    expect((await app.request(`/v1/spaces/${ws.spaceId}/inbox/counts`)).status).toBe(401)
  })
})
