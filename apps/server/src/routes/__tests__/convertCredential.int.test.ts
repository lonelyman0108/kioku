import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'

import {
  CONVERT_SCOPE_TEXT,
  ConvertedToCredential,
  type CircleOverview,
  type ConsoleCredentialList,
  type ConsoleEntryView,
  type CredentialEventList,
  type CredentialValues,
  type EntryHistory,
  type EntryList,
  type InboxCounts,
} from '@kioku/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { CredentialService } from '../../credential/service'
import { withCircle, type Database, type Tx } from '../../db/client'
import {
  credentials,
  dreamSuggestions,
  EMBEDDING_DIMENSIONS,
  entries,
  entryEmbeddings,
  entryEvents,
  entryVariants,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { embedEntries } from '../../embedding/worker'
import {
  openTestDatabase,
  resetDatabase,
  summaryConversation,
  testDatabaseUrl,
} from '../../testing/db'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { setPlaintextContent } from '../../testing/plaintext'

const VALUE = 'hunter2-Very-Secret'
const BODY = `访客网络的密码：${VALUE}，别告诉别人。备用写法 ${VALUE}`

describe.skipIf(!testDatabaseUrl)('转存为凭据', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  const masterKey = randomBytes(32)
  const queued: string[] = []

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: {
        enqueueEmbed: (_circleId, entryId) => void queued.push(entryId),
        enqueueBackfill: async () => true,
        enqueueSwitch: async () => true,
        enqueuePrune: async () => true,
        enqueueBackup: async () => null,
        backupRun: async () => null,
        enqueueExtraction: async () => {},
        enqueueCleanup: async () => true,
        enqueueDream: async () => null,
        dreamRun: async () => null,
      },
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    queued.length = 0
  })

  const inCircle = <T>(circleId: string, fn: (tx: Tx) => Promise<T>) =>
    withCircle(database.db, circleId, fn)
  const inPersonal = <T>(fn: (tx: Tx) => Promise<T>) => inCircle(ws.personalCircleId, fn)
  const send = (
    method: string,
    path: string,
    body?: unknown,
    cookie = ws.cookie,
    circleId = ws.personalCircleId,
  ) =>
    app.request(
      `/v1/circles/${circleId}${path}`,
      method === 'GET' || body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const remember = async (
    body: Record<string, unknown>,
    cookie = ws.cookie,
    circleId = ws.personalCircleId,
  ) => {
    if (cookie === ws.cookie) {
      return ok<ConsoleEntryView>(
        await send('POST', '/entries', { ...body, allowPlaintext: true }, cookie, circleId),
        201,
      )
    }
    const view = await ok<ConsoleEntryView>(
      await send('POST', '/entries', { ...body, content: '待改的正文' }, cookie, circleId),
      201,
    )
    await setPlaintextContent(
      database.db,
      circleId,
      view.id,
      body.content as string,
      view.variants[0]!.id,
    )
    return {
      ...view,
      variants: view.variants.map((v, i) =>
        i === 0 ? { ...v, content: body.content as string } : v,
      ),
    }
  }
  const edit = async (body: Record<string, unknown>, circleId = ws.personalCircleId) =>
    ok<ConsoleEntryView>(
      await send('PATCH', '/entries', { ...body, allowPlaintext: true }, ws.cookie, circleId),
    )
  const move = async (entryId: string, toCircleId: string, fromCircleId = ws.circleId) =>
    ok<ConsoleEntryView>(
      await send('POST', '/entries/transfer', { entryId, toCircleId }, ws.cookie, fromCircleId),
    )
  const seedNote = (extra: Record<string, unknown> = {}) =>
    remember({ title: '访客无线网络', content: BODY, ...extra })

  const TARGET_KEYS = new Set(['identifier', 'name', 'description', 'field'])
  const convert = (
    m: { id: string; version: number },
    extra: Record<string, unknown> = {},
    cookie = ws.cookie,
    circleId = ws.personalCircleId,
  ) => {
    const pick = (inTarget: boolean) =>
      Object.fromEntries(Object.entries(extra).filter(([k]) => TARGET_KEYS.has(k) === inTarget))
    return send(
      'POST',
      '/entries/convert-to-credential',
      {
        entryId: m.id,
        expectedVersion: m.version,
        value: VALUE,
        target: {
          kind: 'new',
          identifier: 'wifi',
          name: '无线网络',
          field: 'password',
          ...pick(true),
        },
        ...pick(false),
      },
      cookie,
      circleId,
    )
  }
  const converted = async (
    m: { id: string; version: number },
    extra: Record<string, unknown> = {},
  ) => ConvertedToCredential.parse(await ok(await convert(m, extra)))
  const rowOf = async (id: string, circleId = ws.personalCircleId) =>
    (await inCircle(circleId, (tx) => tx.select().from(entries).where(eq(entries.id, id))))[0]!
  const variantOf = async (entryId: string, circleId = ws.personalCircleId) =>
    (
      await inCircle(circleId, (tx) =>
        tx.select().from(entryVariants).where(eq(entryVariants.entryId, entryId)),
      )
    )[0]!
  const eventsOf = (id: string, circleId = ws.personalCircleId) =>
    inCircle(circleId, (tx) =>
      tx.select().from(entryEvents).where(eq(entryEvents.entryId, id)).orderBy(asc(entryEvents.id)),
    )
  const credentialCount = async (circleId = ws.personalCircleId) =>
    (await inCircle(circleId, (tx) => tx.select({ id: credentials.id }).from(credentials))).length

  it('一次做完：建托管的凭据、正文里每一处都换成占位符、版本加一；响应不带值', async () => {
    const m = await seedNote()
    queued.length = 0
    const res = await convert(m, { description: '访客用' })
    const text = await res.clone().text()
    expect(res.status, text).toBe(200)
    expect(text).not.toContain(VALUE)
    const result = ConvertedToCredential.parse(await res.json())

    const placeholder = '{{cred:wifi#password}}'
    expect(result.replaced).toBe(2)
    expect(result.entry).toMatchObject({
      id: m.id,
      version: m.version + 1,
      plaintextIgnored: false,
    })
    expect(result.entry.variants[0]!.content).toBe(
      `访客网络的密码：${placeholder}，别告诉别人。备用写法 ${placeholder}`,
    )
    expect(result.credential).toMatchObject({
      identifier: 'wifi',
      name: '无线网络',
      description: '访客用',
      source: 'hosted',
      clientIds: null,
      fields: [{ name: 'password', itemField: null }],
      // 提交之后读的：这条词条的引用已经算上了
      referenceCount: 1,
    })

    // 值进了凭据，看得到
    const values = await ok<CredentialValues>(
      await send('POST', `/credentials/${result.credential.id}/reveal`),
    )
    expect(values.values).toEqual({ password: VALUE })
    // 库里只有密文
    const [row] = await inPersonal((tx) =>
      tx.select().from(credentials).where(eq(credentials.id, result.credential.id)),
    )
    expect(row!.ciphertext!.toString('utf8')).not.toContain(VALUE)
    // 事件：凭据记一条新建（不带值），词条记一条转存
    const events = await ok<CredentialEventList>(
      await send('GET', `/credentials/${result.credential.id}/events`),
    )
    expect(events.items.map((e) => e.type).sort()).toEqual(['access', 'create'])
    expect(JSON.stringify(events)).not.toContain(VALUE)
    const history = await ok<EntryHistory>(await send('GET', `/entries/history?id=${m.id}`))
    expect(history.events.map((e) => e.type)).toEqual(['convert_credential', 'create'])
    expect(history.events[0]!.actor.accountName).toBe('alice')
    // 提交之后排队重新生成向量
    expect(queued).toContain(m.id)
  })

  it('历史里不再留这个值：每个事件的快照都换掉，包括这次转存自己的「改前」；恢复旧版本也带不回明文', async () => {
    const m = await seedNote({ disclosure: '连 Wi-Fi 时' })
    const noted = await edit({ id: m.id, content: `${BODY}\n第二版的备注` })
    const current = await edit({ id: m.id, priority: 5 })
    const ignored = await send('POST', '/entries/ignore-plaintext', {
      entryId: m.id,
      expectedVersion: current.version,
    })
    expect(ignored.status).toBe(200)
    const eventsBefore = await eventsOf(m.id)
    expect(JSON.stringify(eventsBefore)).toContain(VALUE)

    const result = await converted(current)
    const events = await eventsOf(m.id)
    expect(events.map((e) => e.eventType)).toEqual([
      'create',
      'update',
      'update',
      'ignore_plaintext',
      'convert_credential',
    ])
    // 快照的原文里都没有这个值，事件的 context 也没有
    expect(JSON.stringify(events)).not.toContain(VALUE)
    expect(
      await inPersonal((tx) =>
        tx.execute(
          sql`select id from entry_events where before::text like ${`%${VALUE}%`} or after::text like ${`%${VALUE}%`}`,
        ),
      ),
    ).toEqual([])
    expect(result.scrubbedEvents).toBe(3)
    // 别的内容留着：第二版的备注、disclosure、版本号都还在，对比与恢复照常
    const history = await ok<EntryHistory>(await send('GET', `/entries/history?id=${m.id}`))
    const update = history.events.find((e) => e.after?.version === noted.version)!
    expect(update.after!.variants[0]!.content).toContain('第二版的备注')
    expect(update.after!.variants[0]!.content).toContain('***')
    expect(update.after!.variants[0]!.content).not.toContain(VALUE)
    expect(update.after!.disclosure).toBe('连 Wi-Fi 时')

    const first = history.events.find((e) => e.type === 'create')!
    const restored = await ok<ConsoleEntryView>(
      await send('POST', '/entries/restore', {
        entryId: m.id,
        eventId: first.id,
        expectedVersion: result.entry.version,
      }),
    )
    expect(restored.variants[0]!.content).toContain('***')
    expect(restored.variants[0]!.content).not.toContain(VALUE)
    expect(restored.variants[0]!.content).not.toContain('第二版的备注')
  })

  it('多变体切片一并替换与清洗', async () => {
    const m = await remember({
      title: '多环境密码',
      variants: [
        { when: {}, content: `通用密码：${VALUE}` },
        { when: { realm: ['work'] }, content: `公司内网密码：${VALUE}` },
      ],
    })
    const res = await converted(m, { identifier: 'multi-wifi' })
    expect(res.replaced).toBe(2)
    expect(res.entry.variants.map((v) => v.content)).toEqual([
      '通用密码：{{cred:multi-wifi#password}}',
      '公司内网密码：{{cred:multi-wifi#password}}',
    ])
    expect(JSON.stringify(await eventsOf(m.id))).not.toContain(VALUE)
  })

  it('忽略过提示的：转存之后不留含这个值的正文的哈希', async () => {
    const m = await seedNote()
    const ignored = await send('POST', '/entries/ignore-plaintext', {
      entryId: m.id,
      expectedVersion: m.version,
    })
    expect(ignored.status).toBe(200)
    expect((await variantOf(m.id)).plaintextIgnoredHash).not.toBeNull()
    await converted(m)
    expect((await variantOf(m.id)).plaintextIgnoredHash).toBeNull()
  })

  it('全文索引跟着新正文；向量在同一个事务里删掉，重新生成的按新正文', async () => {
    const m = await seedNote()
    const tokens = () =>
      inPersonal((tx) =>
        tx
          .select({ fts: sql<string>`${entryVariants.fts}::text` })
          .from(entryVariants)
          .where(eq(entryVariants.entryId, m.id)),
      )
    expect((await tokens())[0]!.fts.toLowerCase()).toContain('hunter2')
    await inPersonal((tx) =>
      tx.insert(entryEmbeddings).values({
        circleId: ws.personalCircleId,
        variantId: m.variants[0]!.id,
        entryId: m.id,
        model: 'fake-embedding',
        contentHash: 'x',
        embedding: new Array<number>(EMBEDDING_DIMENSIONS).fill(0.01),
      }),
    )

    await converted(m)
    expect((await tokens())[0]!.fts.toLowerCase()).not.toContain('hunter2')
    expect(
      await inPersonal((tx) =>
        tx.select().from(entryEmbeddings).where(eq(entryEmbeddings.entryId, m.id)),
      ),
    ).toEqual([])

    const embedder = fakeEmbedder()
    // 只看发给嵌入接口的文字：写不写回要看实例设置里的模型，别的用例可能留下设置
    await embedEntries(database.db, embedder, ws.personalCircleId, [m.id])
    const sent = embedder.calls.flat().join('\n')
    expect(sent).toContain('{{cred:wifi#password}}')
    expect(sent).not.toContain(VALUE)
  })

  it('转存之后不再算疑似明文：列表、概览、待处理总数都没有', async () => {
    const m = await seedNote()
    await converted(m)
    const list = await ok<EntryList>(await send('GET', '/entries/list?plaintext=true'))
    expect(list.items).toEqual([])
    const overview = await ok<CircleOverview>(await send('GET', '/overview'))
    expect(overview.plaintextCredentials).toBe(0)
    expect((await ok<InboxCounts>(await send('GET', '/inbox/counts'))).plaintext).toBe(0)
  })

  it('值写在引号或反引号里：引号留着，占位符在里面，也不再算疑似明文', async () => {
    const m = await remember({ title: '反引号密码', content: `密码：\`${VALUE}\`` })
    const { entry } = await converted(m)
    expect(entry.variants[0]!.content).toBe('密码：`{{cred:wifi#password}}`')
    const list = await ok<EntryList>(await send('GET', '/entries/list?plaintext=true'))
    expect(list.items).toEqual([])
  })

  it('已有的占位符不改坏：值就是占位符里的标识、或者是 cred，正文和历史都一样；只在占位符里出现算没有这段值', async () => {
    const credentialNamed = async (identifier: string) =>
      expect(
        (
          await send('POST', '/credentials', {
            identifier,
            name: identifier,
            source: { kind: 'new', values: { password: 'other' } },
          })
        ).status,
      ).toBe(201)
    await credentialNamed('prod-db')
    const m = await remember({
      title: '数据库连接',
      content: '{{cred:prod-db#password}} 的主机是 prod-db',
    })
    const edited = await edit({
      id: m.id,
      content: '{{cred:prod-db#password}} 的主机是 prod-db，备机也是 prod-db',
    })
    await inPersonal((tx) =>
      tx.insert(dreamSuggestions).values({
        circleId: ws.personalCircleId,
        scope: `personal:${ws.accountId}`,
        ownerAccountId: ws.accountId,
        kind: 'distill',
        entryIds: [m.id],
        versions: [edited.version],
        title: 'prod-db 整理',
        content: '{{cred:prod-db#password}} 的主机是 prod-db',
        reason: '都写着 prod-db',
        fingerprint: 'with-placeholder',
      }),
    )
    const result = await converted(edited, { value: 'prod-db', identifier: 'host', field: 'name' })
    expect(result.replaced).toBe(2)
    // Dream 的建议和正文、历史同一套规则
    const [suggestion] = await inPersonal((tx) =>
      tx
        .select({
          title: dreamSuggestions.title,
          content: dreamSuggestions.content,
          reason: dreamSuggestions.reason,
        })
        .from(dreamSuggestions)
        .where(eq(dreamSuggestions.fingerprint, 'with-placeholder')),
    )
    expect(suggestion).toEqual({
      title: '*** 整理',
      content: '{{cred:prod-db#password}} 的主机是 ***',
      reason: '都写着 ***',
    })
    const kept =
      '{{cred:prod-db#password}} 的主机是 {{cred:host#name}}，备机也是 {{cred:host#name}}'
    expect(result.entry.variants[0]!.content).toBe(kept)
    const events = await eventsOf(m.id)
    expect((events[0]!.after as { variants: { content: string }[] }).variants[0]!.content).toBe(
      '{{cred:prod-db#password}} 的主机是 ***',
    )
    expect((events[1]!.after as { variants: { content: string }[] }).variants[0]!.content).toBe(
      '{{cred:prod-db#password}} 的主机是 ***，备机也是 ***',
    )

    // 值是 cred：占位符的写法不受影响，别处的换掉
    await credentialNamed('foo')
    const other = await remember({
      title: '语法示例',
      content: '{{cred:foo}} 是 cred 的例子',
    })
    const second = await converted(other, { value: 'cred', identifier: 'word', field: 'text' })
    expect(second.entry.variants[0]!.content).toBe('{{cred:foo}} 是 {{cred:word#text}} 的例子')

    // 只在占位符里出现：正文里没有这段值
    const only = await remember({ title: '仅有占位符', content: '只有 {{cred:foo}}' })
    const res = await convert(only, { value: 'foo', identifier: 'bar', field: 'text' })
    expect(res.status).toBe(400)
    expect((await variantOf(only.id)).content).toBe(only.variants[0]!.content)
  })

  it('换过的旧密码不是这个值，留在历史里：数出来告诉调用方；现在正文里别的明文不算历史', async () => {
    const m = await remember({ title: '无线网络', content: '密码：old-password-1' })
    const rotated = await edit({ id: m.id, content: `密码：${VALUE}` })
    const result = await converted(rotated)
    expect(result.plaintextVersions).toBe(1)
    const events = JSON.stringify(await eventsOf(m.id))
    expect(events).not.toContain(VALUE)
    expect(events).toContain('old-password-1')

    const other = await remember({
      title: '双凭据',
      content: `密码：${VALUE} token=abcd1234`,
    })
    const second = await converted(other, { identifier: 'two' })
    // 这一版换掉之后的正文还有 token，它就是现在的正文，不算历史版本
    expect(second.plaintextVersions).toBe(0)
  })

  it('别的记忆里还有这个值时数出来：调用方有权看到的，已删除、过期的也算；这次不动它们', async () => {
    const value = 'hunter2-copied'
    const m = await remember({ title: '无线网络', content: `密码：${value}` })
    // 数得到的：有效的、共享圈的、触发场景里的、标题里的、关键词里的、已删除的、过期的、来自对话的
    const copy = await remember({ title: '副本', content: `也写着 ${value}` })
    await remember({ title: '共享副本', content: `共享的 ${value}` }, ws.cookie, ws.circleId)
    await remember({
      title: '提示词',
      content: '正文没有',
      disclosure: `提到 ${value} 时`,
    })
    await remember({ title: `笔记 ${value}`, content: '标题里有' })
    await remember({ title: '带关键词', content: '关键词里有', glossary: [`词 ${value}`] })
    const gone = await remember({ title: '已删笔记', content: `合并之前的 ${value}` })
    expect((await send('DELETE', `/entries?id=${encodeURIComponent(gone.shortId)}`)).status).toBe(
      204,
    )
    const lapsed = await remember({ title: '已过期笔记', content: `过期的 ${value}` })
    await inPersonal((tx) =>
      tx
        .update(entries)
        .set({ validTo: new Date(Date.now() - 1000) })
        .where(eq(entries.id, lapsed.id)),
    )
    await inCircle(ws.circleId, async (tx) => {
      const convId = await summaryConversation(tx, ws.circleId)
      const [ep] = await tx
        .insert(entries)
        .values({
          circleId: ws.circleId,
          shortId: 'm-ep2345',
          circleKind: 'shared',
          kind: 'episode',
          sensitivity: 'public',
          provenance: 'untrusted',
          originScope: 'global',
          conversationId: convId,
          title: '群聊摘要',
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId: ws.circleId,
        entryId: ep!.id,
        kind: 'episode',
        sensitivity: 'public',
        when: {},
        whenSignature: '{}',
        sortOrder: 0,
        content: `群里说的 ${value}`,
      })
    })
    // 数不到的：别的成员的个人圈、secret 的密文、只在占位符里的
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    await remember(
      { title: 'bob 的', content: `bob 的 ${value}` },
      bob.cookie,
      bob.personalCircleId,
    )
    await remember({ title: 'secret', content: value, sensitivity: 'secret' })
    expect(
      (
        await send('POST', '/credentials', {
          identifier: value,
          name: '同名的',
          source: { kind: 'new', values: { password: 'other' } },
        })
      ).status,
    ).toBe(201)
    await remember({ title: '纯引用', content: `{{cred:${value}}}` })
    // 占位符两边的文字拼起来才像这个值的不算
    expect(
      (
        await send('POST', '/credentials', {
          identifier: 'foo',
          name: '另一条',
          source: { kind: 'new', values: { password: 'other' } },
        })
      ).status,
    ).toBe(201)
    await remember({
      title: '拼接对比',
      content: `{{cred:${value}}} 和 hunter2{{cred:foo}}-copied`,
    })

    const result = await converted(m, { value })
    expect(result.otherEntries).toBe(8)
    expect((await variantOf(copy.id)).content).toContain(value)
    expect(JSON.stringify(result)).not.toContain(value)
  })

  it('别的记忆里没有这个值时是 0', async () => {
    const m = await seedNote()
    await remember({ title: '其它', content: '没写' })
    expect((await converted(m)).otherEntries).toBe(0)
  })

  it('旧快照里残留的全文检索字段一起去掉', async () => {
    const m = await seedNote()
    await inPersonal((tx) =>
      tx
        .update(entryEvents)
        .set({
          after: sql`${entryEvents.after} || jsonb_build_object('fts', ${"'hunter2':1"}::text)`,
        })
        .where(eq(entryEvents.entryId, m.id)),
    )
    await converted(m)
    for (const event of await eventsOf(m.id)) {
      expect(event.after ?? {}).not.toHaveProperty('fts')
      expect(event.before ?? {}).not.toHaveProperty('fts')
    }
  })

  it('迁入个人圈之后的事件快照与关键词一并脱敏', async () => {
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const m = await remember(
      {
        title: '无线网络',
        content: `密码：${VALUE}`,
        sensitivity: 'private',
        disclosure: `提到 ${VALUE} 时`,
        glossary: [`词-${VALUE}`, '无线网络'],
      },
      ws.cookie,
      ws.circleId,
    )
    await edit(
      { id: m.id, disclosure: '连 Wi-Fi 时', glossaryRemove: [`词-${VALUE}`] },
      ws.circleId,
    )
    const moved = await move(m.id, ws.personalCircleId, ws.circleId)
    const result = await converted(moved)
    expect(result.plaintextVersions).toBe(0)
    expect(bob.accountId).toBeTruthy()
    const events = await eventsOf(moved.id)
    expect(JSON.stringify(events)).not.toContain(VALUE)
    const transferred = events.find((e) => e.eventType === 'transfer_in')!
    expect((transferred.after as { variants: { content: string }[] }).variants[0]!.content).toBe(
      '密码：***',
    )
  })

  it('Dream 的建议里抄下的这个值也换掉', async () => {
    const m = await seedNote()
    const other = await remember({ title: '另一条', content: `也写着 ${VALUE}` })
    await inPersonal((tx) =>
      tx.insert(dreamSuggestions).values([
        {
          circleId: ws.personalCircleId,
          scope: `personal:${ws.accountId}`,
          ownerAccountId: ws.accountId,
          kind: 'distill',
          entryIds: [m.id],
          versions: [m.version],
          title: `无线 ${VALUE}`,
          content: `提炼：Wi-Fi 是 ${VALUE}`,
          disclosure: `提到 ${VALUE} 时`,
          reason: `都写着 ${VALUE}`,
          fingerprint: 'a',
        },
        // 不涉及这条词条的不动
        {
          circleId: ws.personalCircleId,
          scope: `personal:${ws.accountId}`,
          ownerAccountId: ws.accountId,
          kind: 'stale',
          entryIds: [other.id],
          versions: [other.version],
          reason: `另一条写着 ${VALUE}`,
          fingerprint: 'b',
        },
      ]),
    )
    await converted(m)
    const rows = await inPersonal((tx) =>
      tx.select().from(dreamSuggestions).orderBy(asc(dreamSuggestions.fingerprint)),
    )
    expect(rows[0]).toMatchObject({
      title: '无线 ***',
      content: '提炼：Wi-Fi 是 ***',
      disclosure: '提到 *** 时',
      reason: '都写着 ***',
    })
    expect(rows[1]!.reason).toContain(VALUE)
  })

  describe('现有的规则都走', () => {
    const untouched = async (m: ConsoleEntryView, circleId = ws.personalCircleId) => {
      const row = await rowOf(m.id, circleId)
      const vRow = await variantOf(m.id, circleId)
      expect(row.version).toBe(m.version)
      expect(vRow.content).toBe(m.variants[0]!.content)
      expect(await credentialCount(circleId)).toBe(0)
      expect((await eventsOf(m.id, circleId)).map((e) => e.eventType)).toEqual(['create'])
    }

    it('看过之后被改过：409，什么都不留下', async () => {
      const m = await seedNote()
      const res = await convert({ id: m.id, version: m.version + 1 })
      expect(res.status).toBe(409)
      await untouched(m)
    })

    it('标识冲突：409，什么都不留下', async () => {
      const m = await seedNote()
      const taken = await send('POST', '/credentials', {
        identifier: 'wifi',
        name: '已有的',
        source: { kind: 'new', values: { password: 'other' } },
      })
      expect(taken.status).toBe(201)
      const res = await convert(m)
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toContain('标识已被占用')
      const row = await rowOf(m.id)
      expect(row.version).toBe(m.version)
      expect((await variantOf(m.id)).content).toBe(m.variants[0]!.content)
      expect((await eventsOf(m.id)).map((e) => e.eventType)).toEqual(['create'])
      const list = await ok<ConsoleCredentialList>(await send('GET', '/credentials'))
      expect(list.items.map((c) => c.name)).toEqual(['已有的'])
    })

    it('不在个人圈、敏感级不够私密时拒绝，并说明要先怎么做', async () => {
      const shared = await remember({ title: '共享无线', content: BODY }, ws.cookie, ws.circleId)
      const res = await convert(shared, {}, ws.cookie, ws.circleId)
      expect(res.status).toBe(400)
      const { error } = (await res.json()) as { error: string }
      expect(error).toBe(CONVERT_SCOPE_TEXT)
      expect(error).toContain('个人圈')
      expect(error).toContain('先')
      await untouched(shared, ws.circleId)

      const open = await remember({
        title: '内部笔记',
        content: BODY,
        sensitivity: 'internal',
      })
      const lower = await convert(open)
      expect(lower.status).toBe(400)
      expect(((await lower.json()) as { error: string }).error).toContain('私密')
    })

    it('机密词条不用转存', async () => {
      const m = await remember({ title: '机密', content: BODY, sensitivity: 'secret' })
      const res = await convert(m)
      expect(res.status).toBe(400)
      expect(await credentialCount()).toBe(0)
    })

    it('托管凭据要记忆圈所有者；viewer 写不了；读不到的和不存在一样', async () => {
      const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
      const viewer = await addMember(database.db, ws.circleId, 'vic', 'viewer')
      const sharedEntry = await remember(
        { title: '共享条目', content: BODY },
        ws.cookie,
        ws.circleId,
      )
      const res = await convert(sharedEntry, {}, editor.cookie, ws.circleId)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toContain('记忆圈所有者')
      expect((await variantOf(sharedEntry.id, ws.circleId)).content).toBe(BODY)

      const mine = await seedNote()
      expect((await convert(mine, {}, editor.cookie, ws.personalCircleId)).status).toBe(403)
      expect((await convert(sharedEntry, {}, viewer.cookie, ws.circleId)).status).toBe(403)
      expect(await credentialCount()).toBe(0)
    })

    it('没配主密钥时不能保存托管的凭据', async () => {
      const m = await seedNote()
      const locked = createApp({
        db: database.db,
        cookieSecure: false,
        masterKey: null,
        embedder: staticEmbedderSource(null),
        jobs: null,
      })
      const res = await locked.request(
        `/v1/circles/${ws.personalCircleId}/entries/convert-to-credential`,
        jsonRequest(
          'POST',
          {
            entryId: m.id,
            expectedVersion: m.version,
            value: VALUE,
            target: { kind: 'new', identifier: 'wifi', name: '无线网络', field: 'password' },
          },
          { cookie: ws.cookie },
        ),
      )
      expect(res.status).toBe(400)
      await untouched(m)
    })

    it('正文里没有这段值时拒绝，报错不带值', async () => {
      const m = await seedNote()
      const res = await convert(m, { value: 'not-in-the-body' })
      expect(res.status).toBe(400)
      expect(await res.text()).not.toContain('not-in-the-body')
      await untouched(m)
    })

    it('标题、disclosure、关键词里也有这个值时拒绝：它们是明文，也放不了占位符', async () => {
      const inDisclosure = await seedNote({ disclosure: `提到 ${VALUE} 时` })
      const res = await convert(inDisclosure)
      expect(res.status).toBe(400)
      const { error } = (await res.json()) as { error: string }
      expect(error).toContain('触发场景')
      expect(error).not.toContain(VALUE)
      await untouched(inDisclosure)

      const inGlossary = await remember({
        title: '带关键词',
        content: BODY,
        glossary: [VALUE],
      })
      expect((await convert(inGlossary)).status).toBe(400)

      const inTitle = await remember({
        title: 'hunter2-box',
        content: '密码：hunter2-box',
      })
      expect((await convert(inTitle, { value: 'hunter2-box' })).status).toBe(400)
    })

    it('换成占位符之后超过正文的长度上限时拒绝', async () => {
      const m = await remember({ title: '长正文', content: 'abcd '.repeat(15000) })
      const res = await convert(m, { value: 'abcd' })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('长度上限')
      expect(await credentialCount()).toBe(0)
    })

    it('要转存的值不合规时 400：太短、前后有空白', async () => {
      const m = await seedNote()
      expect((await convert(m, { value: 'abc' })).status).toBe(400)
      expect((await convert(m, { value: ` ${VALUE}` })).status).toBe(400)
      expect((await convert(m, { identifier: 'Bad Name' })).status).toBe(400)
      expect((await convert(m, { field: 'Bad Field' })).status).toBe(400)
      // 标识、名称、说明与字段名都是明文
      const named = await convert(m, { name: `密码 ${VALUE}` })
      expect(named.status).toBe(400)
      expect(await named.text()).not.toContain(VALUE)
      await untouched(m)
    })
  })

  it('等锁期间正文被改了：返回 409，凭据不留下，改完的正文原样', async () => {
    const m = await seedNote()
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    let pending: Promise<Response> | undefined
    try {
      await side.begin(async (tx) => {
        await tx`select set_config('app.read_circles', ${ws.personalCircleId}, true)`
        await tx`select set_config('app.write_circles', ${ws.personalCircleId}, true)`
        await tx`select 1 from entries where id = ${m.id} for update`
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }]
        pending = Promise.resolve(convert(m))
        for (let i = 0; ; i++) {
          const [row] = await side<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where ${pid}::int = any(pg_blocking_pids(pid))`
          if (row!.n > 0) break
          if (i >= 200) throw new Error('请求没有等在这把锁上')
          await new Promise((r) => setTimeout(r, 25))
        }
        await tx`update entries set version = version + 1 where id = ${m.id}`
        await tx`update entry_variants set content = '别处改过的' where entry_id = ${m.id}`
      })
      expect((await pending!).status).toBe(409)
    } finally {
      await pending?.catch(() => {})
      await side.end()
    }
    expect(await credentialCount()).toBe(0)
    expect((await variantOf(m.id)).content).toBe('别处改过的')
    expect((await eventsOf(m.id)).map((e) => e.eventType)).toEqual(['create'])
  })

  it('改词条这一步失败时凭据也不留下：两个服务在一个事务里', async () => {
    const m = await seedNote()
    queued.length = 0
    await database.db.execute(sql`
      create function test_fail_variant_update() returns trigger language plpgsql as $$
      begin raise exception 'boom'; end $$`)
    await database.db.execute(sql`
      create trigger test_fail_variant_update before update of content on entry_variants
      for each row execute function test_fail_variant_update()`)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await convert(m)
      expect(res.status).toBe(500)
      expect(await res.text()).not.toContain(VALUE)
      // 日志不带 SQL 的参数（正文与值）
      expect(logged).toHaveBeenCalled()
      expect(inspect(logged.mock.calls, { depth: 10 })).not.toContain(VALUE)
    } finally {
      logged.mockRestore()
      await database.db.execute(sql`drop trigger test_fail_variant_update on entry_variants`)
      await database.db.execute(sql`drop function test_fail_variant_update()`)
    }
    expect(await credentialCount()).toBe(0)
    const row = await rowOf(m.id)
    expect(row.version).toBe(m.version)
    expect((await variantOf(m.id)).content).toBe(BODY)
    expect((await eventsOf(m.id)).map((e) => e.eventType)).toEqual(['create'])
    expect(queued).not.toContain(m.id)
  })

  it('读响应用的凭据失败时什么都不留下，重试能成功：不会数据改了却报错', async () => {
    const m = await seedNote()
    const failing = vi
      .spyOn(CredentialService.prototype, 'viewIn')
      .mockRejectedValueOnce(new Error('读失败'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await convert(m)
      expect(res.status).toBe(500)
    } finally {
      failing.mockRestore()
      logged.mockRestore()
    }
    expect(await credentialCount()).toBe(0)
    const row = await rowOf(m.id)
    expect(row.version).toBe(m.version)
    expect((await variantOf(m.id)).content).toBe(BODY)
    expect((await eventsOf(m.id)).map((e) => e.eventType)).toEqual(['create'])

    const retried = await converted(m)
    expect(retried.credential).toMatchObject({ identifier: 'wifi', referenceCount: 1 })
  })

  it('转存之后这条词条的引用算数：凭据删不掉', async () => {
    const m = await seedNote()
    const { credential } = await converted(m)
    const del = await send('DELETE', `/credentials/${credential.id}`)
    expect(del.status).toBe(409)
  })
})
