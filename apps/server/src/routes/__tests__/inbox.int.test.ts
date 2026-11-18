import { randomBytes } from 'node:crypto'

import {
  InboxCounts,
  type CircleOverview,
  type ConsoleCredentialList,
  type ConsoleEntryView,
  type DreamSuggestionList,
  type EntryList,
  type ReviewList,
} from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database, type Tx } from '../../db/client'
import {
  conversations,
  credentials,
  dreamSuggestions,
  entries,
  entryVariants,
  subjectBindings,
  subjects,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { generateShortId } from '../../memory/shortId'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { setPlaintextContent } from '../../testing/plaintext'

describe.skipIf(!testDatabaseUrl)('待处理总数', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let editor: { accountId: string; personalCircleId: string; cookie: string }
  let viewer: { accountId: string; personalCircleId: string; cookie: string }
  let botClientId: string

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
    editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    viewer = await addMember(database.db, ws.circleId, 'vic', 'viewer')
    botClientId = (await ws.createClient('bot-inbox', { runtimeFamily: 'astrbot' })).id
  })

  const inCircle = <T>(fn: (tx: Tx) => Promise<T>) => withCircle(database.db, ws.circleId, fn)
  const get = async <T>(path: string, cookie = ws.cookie) => {
    const res = await app.request(`/v1/circles/${ws.circleId}${path}`, { headers: { cookie } })
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as T
  }
  const counts = (cookie = ws.cookie) => get<InboxCounts>('/inbox/counts', cookie)
  // 记忆圈 owner 带着疑似明文照样保存
  const remember = async (body: Record<string, unknown>, cookie = ws.cookie) => {
    const res = await app.request(
      `/v1/circles/${ws.circleId}/entries`,
      jsonRequest('POST', { ...body, allowPlaintext: true }, { cookie }),
    )
    expect(res.status, await res.clone().text()).toBe(201)
    return (await res.json()) as ConsoleEntryView
  }
  const insertEntryWithVariant = async (
    tx: Tx,
    row: Omit<typeof entries.$inferInsert, 'circleId' | 'circleKind' | 'shortId' | 'title'> & {
      title?: string
    },
    variant: {
      content: string | null
      ciphertext?: Buffer | null
      wrappedKey?: Buffer | null
      keyId?: string | null
    },
  ) => {
    const title = row.title ?? variant.content ?? '加密词条'
    const [inserted] = await tx
      .insert(entries)
      .values({
        circleId: ws.circleId,
        circleKind: 'shared',
        shortId: generateShortId(),
        title,
        ...row,
      })
      .returning()
    await tx.insert(entryVariants).values({
      circleId: ws.circleId,
      entryId: inserted!.id,
      kind: inserted!.kind,
      sensitivity: inserted!.sensitivity,
      when: {},
      whenSignature: '{}',
      sortOrder: 0,
      content: variant.content,
      searchHeader: inserted!.sensitivity === 'secret' ? '' : title,
      ciphertext: variant.ciphertext ?? null,
      wrappedKey: variant.wrappedKey ?? null,
      keyId: variant.keyId ?? null,
    })
    return inserted!
  }

  let seq = 0
  const suggestion = (
    entry: { id: string; version: number },
    extra: Partial<typeof dreamSuggestions.$inferInsert> = {},
  ) => ({
    circleId: ws.circleId,
    scope: 'circle',
    kind: 'stale',
    entryIds: [entry.id],
    versions: [entry.version],
    reason: '过时了',
    fingerprint: `fp-${++seq}`,
    ...extra,
  })

  // 一条等 accountId 确认的绑定：发码的对象标记成了 marked（默认就是 accountId）
  const binding = async (
    accountId: string,
    extra: Partial<typeof subjectBindings.$inferInsert> = {},
    marked = accountId,
  ) => {
    const bot = await ws.createClient(`bot-${++seq}`, { runtimeFamily: 'astrbot' })
    await inCircle(async (tx) => {
      const [kept, merged] = await tx
        .insert(subjects)
        .values([
          { circleId: ws.circleId, kind: 'person', displayName: '本人', accountId: marked },
          { circleId: ws.circleId, kind: 'person', displayName: '小号' },
        ])
        .returning()
      await tx.insert(subjectBindings).values({
        circleId: ws.circleId,
        clientId: bot.id,
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

  // 五类都有：共享的、只有某个成员看得到的，以及对应的列表里不该出现的
  async function seed() {
    // 疑似明文：共享的一条、alice 与 eve 本机会话摘要各一条；secret 的正文是密文不算，没写明文的不算
    await remember({ title: 'API 配置', content: 'token = abc123' })
    await remember({ title: '保险箱', content: '密码：hunter2', sensitivity: 'secret' })
    const plain = await remember({ title: '常见问题', content: '常见问题' })
    const changed = await remember({ title: '会改的', content: '会改的' })

    const alicePlainEp = await inCircle(async (tx) => {
      const [groupSubject] = await tx
        .insert(subjects)
        .values({ circleId: ws.circleId, kind: 'group', displayName: '读书会' })
        .returning()
      const [groupConv] = await tx
        .insert(conversations)
        .values({
          circleId: ws.circleId,
          clientId: botClientId,
          kind: 'group',
          subjectId: groupSubject!.id,
        })
        .returning()
      const [aliceLocalConv] = await tx
        .insert(conversations)
        .values({
          circleId: ws.circleId,
          clientId: botClientId,
          kind: 'none',
          ownerAccountId: ws.accountId,
          deviceKey: 'dev-alice',
          projectSlug: 'proj-alice',
        })
        .returning()
      const [eveLocalConv] = await tx
        .insert(conversations)
        .values({
          circleId: ws.circleId,
          clientId: botClientId,
          kind: 'none',
          ownerAccountId: editor.accountId,
          deviceKey: 'dev-eve',
          projectSlug: 'proj-eve',
        })
        .returning()

      // 本机会话摘要含疑似明文（先写成普通正文，再通过测试工具改成疑似明文，各成员只见自己的）
      const aliceEp = await insertEntryWithVariant(
        tx,
        {
          kind: 'episode',
          sensitivity: 'private',
          provenance: 'agent',
          originScope: 'global',
          ownerAccountId: ws.accountId,
          conversationId: aliceLocalConv!.id,
          priority: 2,
          expiresAt: new Date(Date.now() + 86_400_000),
          title: 'alice 本机会话',
        },
        { content: '待改的正文' },
      )
      const eveEp = await insertEntryWithVariant(
        tx,
        {
          kind: 'episode',
          sensitivity: 'private',
          provenance: 'agent',
          originScope: 'global',
          ownerAccountId: editor.accountId,
          conversationId: eveLocalConv!.id,
          priority: 2,
          expiresAt: new Date(Date.now() + 86_400_000),
          title: 'eve 本机会话',
        },
        { content: '待改的正文' },
      )

      // 待确认内容（共享群摘要）：现在有效的两条；到期的、删掉的、受信来源的不算
      const sharedUntrusted = (content: string, extra: Partial<typeof entries.$inferInsert> = {}) =>
        insertEntryWithVariant(
          tx,
          {
            kind: 'episode',
            sensitivity: 'public',
            provenance: 'untrusted',
            originScope: `group:${groupSubject!.id}`,
            conversationId: groupConv!.id,
            priority: 2,
            expiresAt: new Date(Date.now() + 86_400_000),
            ...extra,
          },
          { content },
        )
      await sharedUntrusted('群里聊了学日语')
      await sharedUntrusted('又聊了一次')
      await sharedUntrusted('过期摘要', { expiresAt: new Date(Date.now() - 1000) })
      await sharedUntrusted('已删摘要', { deletedAt: new Date() })
      await sharedUntrusted('可信摘要', { provenance: 'agent' })

      await tx.insert(dreamSuggestions).values([
        // 共享范围的一条，所有成员都看得到；alice 本机会话的一条只有她看得到
        suggestion(plain),
        suggestion(aliceEp, { scope: `local:${aliceLocalConv!.id}` }),
        // 处理过的、涉及的词条版本对不上都不算
        suggestion(plain, { status: 'rejected' }),
        suggestion(changed, { versions: [changed.version + 1] }),
      ])
      return { aliceId: aliceEp.id, eveId: eveEp.id }
    })

    await setPlaintextContent(
      database.db,
      ws.circleId,
      alicePlainEp.aliceId,
      '访客密码：guest-1234',
    )
    await setPlaintextContent(database.db, ws.circleId, alicePlainEp.eveId, 'password = eve-1234')

    // 账号绑定：等 alice 的一条；过了期限的、作废的、对象已经不再标记成她的不算；等别人的只有那个人算
    await binding(ws.accountId)
    await binding(ws.accountId, { expiresAt: new Date(Date.now() - 1000) })
    await binding(ws.accountId, {}, editor.accountId)
    await binding(ws.accountId, { status: 'cancelled', decidedAt: new Date() })
    await binding(editor.accountId)

    // 凭据：只算各成员自己的。alice 的快到期、已到期、需要轮换各一条；离到期还远的、没设到期的、删掉的不算
    const day = 86_400_000
    const credential = (identifier: string, owner: string, extra = {}) => ({
      circleId: ws.circleId,
      ownerAccountId: owner,
      identifier,
      name: identifier,
      source: 'hosted' as const,
      fields: [{ name: 'password', itemField: null }],
      ciphertext: Buffer.from('c'),
      wrappedKey: Buffer.from('k'),
      ...extra,
    })
    await inCircle((tx) =>
      tx.insert(credentials).values([
        credential('soon', ws.accountId, { expiresAt: new Date(Date.now() + 3 * day) }),
        credential('gone', ws.accountId, { expiresAt: new Date(Date.now() - day) }),
        credential('leak', ws.accountId, { rotationRequestedAt: new Date() }),
        credential('far', ws.accountId, { expiresAt: new Date(Date.now() + 30 * day) }),
        credential('plain', ws.accountId),
        credential('removed', ws.accountId, {
          expiresAt: new Date(Date.now() - day),
          deletedAt: new Date(),
        }),
        credential('eve-gone', editor.accountId, { expiresAt: new Date(Date.now() - day) }),
      ]),
    )
  }

  it('五类各按对应列表的条件数，合计是五类之和；调用方看不到的不算', async () => {
    await seed()
    expect(await counts()).toEqual({
      bindings: 1,
      review: 2,
      dreamSuggestions: 2,
      plaintext: 2,
      credentials: 3,
      total: 10,
    })
    expect(await counts(editor.cookie)).toEqual({
      bindings: 1,
      review: 2,
      dreamSuggestions: 1,
      plaintext: 2,
      credentials: 1,
      total: 7,
    })
    expect(await counts(viewer.cookie)).toEqual({
      bindings: 0,
      review: 2,
      dreamSuggestions: 1,
      plaintext: 1,
      credentials: 0,
      total: 4,
    })
  })

  it('和列表对得上：不同角色看到的条数都和各自的列表一样，概览用的是同一份', async () => {
    await seed()
    for (const cookie of [ws.cookie, editor.cookie, viewer.cookie]) {
      const inbox = await counts(cookie)
      const overview = await get<CircleOverview>('/overview', cookie)
      expect(overview.inbox).toEqual(inbox)
      expect(overview.pendingBindings.length).toBe(inbox.bindings)
      expect(overview.plaintextCredentials).toBe(inbox.plaintext)
      expect((await get<ReviewList>('/review', cookie)).total).toBe(inbox.review)
      expect((await get<DreamSuggestionList>('/dream/suggestions', cookie)).total).toBe(
        inbox.dreamSuggestions,
      )
      expect((await get<EntryList>('/entries/list?plaintext=true', cookie)).items.length).toBe(
        inbox.plaintext,
      )
    }
    // 凭据一类和凭据列表的 attention 筛选同一个条件（列表只给能管理凭据的所有者）
    const attention = await get<ConsoleCredentialList>('/credentials?attention=true')
    expect(attention.items.map((c) => [c.identifier, c.expiry, !!c.rotationRequestedAt])).toEqual([
      ['gone', 'expired', false],
      ['leak', null, true],
      ['soon', 'expiring', false],
    ])
  })

  it('概览单独给出来自对话的条数：按种类与敏感级分组，读权限和别处一样；counts 与 total 只算正式词条', async () => {
    await remember({ title: '常见问题', content: '常见问题', sensitivity: 'public' })
    const past = new Date(Date.now() - 1000)
    await inCircle(async (tx) => {
      const [groupSubject] = await tx
        .insert(subjects)
        .values({ circleId: ws.circleId, kind: 'group', displayName: '读书会' })
        .returning()
      const [groupConv] = await tx
        .insert(conversations)
        .values({
          circleId: ws.circleId,
          clientId: botClientId,
          kind: 'group',
          subjectId: groupSubject!.id,
        })
        .returning()
      const [person] = await tx
        .insert(subjects)
        .values({ circleId: ws.circleId, kind: 'person', displayName: '小明' })
        .returning()
      const ep = (content: string, extra: Partial<typeof entries.$inferInsert> = {}) =>
        insertEntryWithVariant(
          tx,
          {
            kind: 'episode',
            sensitivity: 'public',
            provenance: 'untrusted',
            originScope: `group:${groupSubject!.id}`,
            conversationId: groupConv!.id,
            priority: 2,
            expiresAt: new Date(Date.now() + 86_400_000),
            ...extra,
          },
          { content },
        )
      const fact = (
        content: string | null,
        extra: Partial<typeof entries.$inferInsert> = {},
        secret = false,
      ) =>
        insertEntryWithVariant(
          tx,
          {
            kind: 'fact',
            subjectId: person!.id,
            subjectKind: 'person',
            sensitivity: secret ? 'secret' : 'public',
            provenance: 'untrusted',
            originScope: `group:${groupSubject!.id}`,
            priority: 2,
            title: secret ? '秘密事实' : (content ?? '事实'),
            ...extra,
          },
          secret
            ? {
                content: null,
                ciphertext: Buffer.from('c'),
                wrappedKey: Buffer.from('k'),
                keyId: 'k1',
              }
            : { content },
        )
      await fact('在学日语')
      await fact('住在上海', { sensitivity: 'internal', provenance: 'owner' })
      await ep('群里聊了学日语')
      await ep('又聊了一次')
      // 读不到的不算：被推翻的、到期的、删掉的
      await fact('以前的说法', { validTo: past })
      await ep('过期摘要', { expiresAt: past })
      await ep('已删摘要', { deletedAt: new Date() })
      // 只有读得到 secret 的成员算
      await fact(null, { provenance: 'owner' }, true)
    })

    const byKey = (list: CircleOverview['extractedCounts']) =>
      [...list].sort((a, b) =>
        `${a.kind}:${a.sensitivity}`.localeCompare(`${b.kind}:${b.sensitivity}`),
      )
    const shared = byKey([
      { kind: 'fact', sensitivity: 'public', count: 1 },
      { kind: 'fact', sensitivity: 'internal', count: 1 },
      { kind: 'episode', sensitivity: 'public', count: 2 },
    ])
    const owner = await get<CircleOverview>('/overview')
    expect(byKey(owner.extractedCounts)).toEqual(
      byKey([...shared, { kind: 'fact', sensitivity: 'secret', count: 1 }]),
    )
    expect(owner.counts).toEqual([{ kind: 'entry', sensitivity: 'public', count: 1 }])
    expect(owner.total).toBe(1)
    for (const cookie of [editor.cookie, viewer.cookie]) {
      const o = await get<CircleOverview>('/overview', cookie)
      expect(byKey(o.extractedCounts)).toEqual(shared)
      expect(o.total).toBe(1)
    }
  })

  it('空记忆圈全是 0，只有条数，不带内容', async () => {
    const empty = await counts()
    expect(empty).toEqual({
      bindings: 0,
      review: 0,
      dreamSuggestions: 0,
      plaintext: 0,
      credentials: 0,
      total: 0,
    })
    expect(InboxCounts.strict().safeParse(empty).success).toBe(true)
    const overview = await get<CircleOverview>('/overview')
    expect(overview.extractedCounts).toEqual([])
  })

  it('不是成员返回 403，没登录返回 401', async () => {
    const res = await app.request('/v1/circles/00000000-0000-4000-8000-000000000000/inbox/counts', {
      headers: { cookie: ws.cookie },
    })
    expect(res.status).toBe(403)
    expect((await app.request(`/v1/circles/${ws.circleId}/inbox/counts`)).status).toBe(401)
  })
})
