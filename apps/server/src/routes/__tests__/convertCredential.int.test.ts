import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'

import {
  ConvertedToCredential,
  type ConsoleCredentialList,
  type CredentialEventList,
  type CredentialValues,
  type InboxCounts,
  type MemoryHistory,
  type MemoryList,
  type MemoryView,
  type SpaceOverview,
} from '@kioku/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { CredentialService } from '../../credential/service'
import { withSpace, type Database, type Tx } from '../../db/client'
import {
  credentials,
  dreamSuggestions,
  EMBEDDING_DIMENSIONS,
  memories,
  memoryEmbeddings,
  memoryEvents,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { embedMemories } from '../../embedding/worker'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

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
        enqueueEmbed: (_spaceId, memoryId) => void queued.push(memoryId),
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

  const inSpace = <T>(fn: (tx: Tx) => Promise<T>) => withSpace(database.db, ws.spaceId, fn)
  const send = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(
      `/v1/spaces/${ws.spaceId}${path}`,
      method === 'GET' || body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const remember = async (body: Record<string, unknown>, cookie = ws.cookie) =>
    ok<MemoryView>(await send('POST', '/memories', body, cookie), 201)
  const edit = async (body: Record<string, unknown>) =>
    ok<MemoryView>(await send('PATCH', '/memories', body))
  const seedNote = (extra: Record<string, unknown> = {}) =>
    remember({ uri: 'notes://wifi', content: BODY, ...extra })
  const convert = (
    m: { id: string; version: number },
    extra: Record<string, unknown> = {},
    cookie = ws.cookie,
  ) =>
    send(
      'POST',
      '/memories/convert-to-credential',
      {
        memoryId: m.id,
        expectedVersion: m.version,
        value: VALUE,
        identifier: 'wifi',
        name: '无线网络',
        field: 'password',
        ...extra,
      },
      cookie,
    )
  const converted = async (m: { id: string; version: number }, extra = {}) =>
    ConvertedToCredential.parse(await ok(await convert(m, extra)))
  const rowOf = async (id: string) =>
    (await inSpace((tx) => tx.select().from(memories).where(eq(memories.id, id))))[0]!
  const eventsOf = (id: string) =>
    inSpace((tx) =>
      tx
        .select()
        .from(memoryEvents)
        .where(eq(memoryEvents.memoryId, id))
        .orderBy(asc(memoryEvents.id)),
    )
  const credentialCount = async () =>
    (await inSpace((tx) => tx.select({ id: credentials.id }).from(credentials))).length

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
    expect(result.memory).toMatchObject({
      id: m.id,
      version: m.version + 1,
      content: `访客网络的密码：${placeholder}，别告诉别人。备用写法 ${placeholder}`,
      plaintextIgnored: false,
    })
    expect(result.credential).toMatchObject({
      identifier: 'wifi',
      name: '无线网络',
      description: '访客用',
      source: 'hosted',
      appIds: null,
      fields: [{ name: 'password', sourceField: null }],
      // 提交之后读的：这条记忆的引用已经算上了
      referenceCount: 1,
    })
    expect(result.memory.content).not.toContain(VALUE)

    // 值进了凭据，看得到
    const values = await ok<CredentialValues>(
      await send('POST', `/credentials/${result.credential.id}/reveal`),
    )
    expect(values.values).toEqual({ password: VALUE })
    // 库里只有密文
    const [row] = await inSpace((tx) =>
      tx.select().from(credentials).where(eq(credentials.id, result.credential.id)),
    )
    expect(row!.ciphertext!.toString('utf8')).not.toContain(VALUE)
    // 事件：凭据记一条新建（不带值），记忆记一条转存
    const events = await ok<CredentialEventList>(
      await send('GET', `/credentials/${result.credential.id}/events`),
    )
    expect(events.items.map((e) => e.type).sort()).toEqual(['access', 'create'])
    expect(JSON.stringify(events)).not.toContain(VALUE)
    const history = await ok<MemoryHistory>(await send('GET', `/memories/history?id=${m.id}`))
    expect(history.events.map((e) => e.type)).toEqual(['create', 'convert_credential'])
    expect(history.events[1]!.actor.accountName).toBe('alice')
    // 提交之后排队重新生成向量
    expect(queued).toContain(m.id)
  })

  it('历史里不再留这个值：每个事件的快照都换掉，包括这次转存自己的「改前」；恢复旧版本也带不回明文', async () => {
    const m = await seedNote({ disclosure: '连 Wi-Fi 时' })
    const noted = await edit({ uri: m.uri, content: `${BODY}\n第二版的备注` })
    const current = await edit({ uri: m.uri, priority: 5 })
    const ignored = await send('POST', '/memories/ignore-plaintext', {
      memoryId: m.id,
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
      await inSpace((tx) =>
        tx.execute(
          sql`select id from memory_events where before::text like ${`%${VALUE}%`} or after::text like ${`%${VALUE}%`}`,
        ),
      ),
    ).toEqual([])
    expect(result.scrubbedEvents).toBe(4)
    // 别的内容留着：第二版的备注、disclosure、版本号都还在，对比与恢复照常
    const history = await ok<MemoryHistory>(await send('GET', `/memories/history?id=${m.id}`))
    const update = history.events.find((e) => e.after?.version === noted.version)!
    expect(update.after!.content).toContain('第二版的备注')
    expect(update.after!.content).toContain('{{cred:wifi#password}}')
    expect(update.after!.disclosure).toBe('连 Wi-Fi 时')

    const first = history.events[0]!
    const restored = await ok<MemoryView>(
      await send('POST', '/memories/restore', {
        memoryId: m.id,
        eventId: first.id,
        expectedVersion: result.memory.version,
      }),
    )
    expect(restored.content).toContain('{{cred:wifi#password}}')
    expect(restored.content).not.toContain(VALUE)
    expect(restored.content).not.toContain('第二版的备注')
  })

  it('忽略过提示的：转存之后不留含这个值的正文的哈希', async () => {
    const m = await seedNote()
    const ignored = await send('POST', '/memories/ignore-plaintext', {
      memoryId: m.id,
      expectedVersion: m.version,
    })
    expect(ignored.status).toBe(200)
    expect((await rowOf(m.id)).plaintextIgnoredHash).not.toBeNull()
    await converted(m)
    expect((await rowOf(m.id)).plaintextIgnoredHash).toBeNull()
  })

  it('全文索引跟着新正文；向量在同一个事务里删掉，重新生成的按新正文', async () => {
    const m = await seedNote()
    const tokens = () =>
      inSpace((tx) =>
        tx
          .select({ fts: sql<string>`${memories.fts}::text` })
          .from(memories)
          .where(eq(memories.id, m.id)),
      )
    expect((await tokens())[0]!.fts.toLowerCase()).toContain('hunter2')
    await inSpace((tx) =>
      tx.insert(memoryEmbeddings).values({
        spaceId: ws.spaceId,
        memoryId: m.id,
        model: 'fake-embedding',
        contentHash: 'x',
        embedding: new Array<number>(EMBEDDING_DIMENSIONS).fill(0.01),
      }),
    )

    await converted(m)
    expect((await tokens())[0]!.fts.toLowerCase()).not.toContain('hunter2')
    expect(
      await inSpace((tx) =>
        tx.select().from(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, m.id)),
      ),
    ).toEqual([])

    const embedder = fakeEmbedder()
    // 只看发给嵌入接口的文字：写不写回要看实例设置里的模型，别的用例可能留下设置
    await embedMemories(database.db, embedder, ws.spaceId, [m.id])
    const sent = embedder.calls.flat().join('\n')
    expect(sent).toContain('{{cred:wifi#password}}')
    expect(sent).not.toContain(VALUE)
  })

  it('转存之后不再算疑似明文：列表、概览、待处理总数都没有', async () => {
    const m = await seedNote()
    await converted(m)
    const list = await ok<MemoryList>(await send('GET', '/memories/list?plaintext=true'))
    expect(list.items).toEqual([])
    const overview = await ok<SpaceOverview>(await send('GET', '/overview'))
    expect(overview.plaintextCredentials).toBe(0)
    expect((await ok<InboxCounts>(await send('GET', '/inbox/counts'))).plaintext).toBe(0)
  })

  it('值写在引号或反引号里：引号留着，占位符在里面，也不再算疑似明文', async () => {
    const m = await remember({ uri: 'notes://quoted', content: `密码：\`${VALUE}\`` })
    const { memory } = await converted(m)
    expect(memory.content).toBe('密码：`{{cred:wifi#password}}`')
    const list = await ok<MemoryList>(await send('GET', '/memories/list?plaintext=true'))
    expect(list.items).toEqual([])
  })

  it('已有的占位符不改坏：值就是占位符里的标识、或者是 cred，正文和历史都一样；只在占位符里出现算没有这段值', async () => {
    const credentialNamed = async (identifier: string) =>
      expect(
        (
          await send('POST', '/credentials', {
            identifier,
            name: identifier,
            source: { kind: 'hosted', values: { password: 'other' } },
          })
        ).status,
      ).toBe(201)
    await credentialNamed('prod-db')
    const m = await remember({
      uri: 'notes://db',
      content: '{{cred:prod-db#password}} 的主机是 prod-db',
    })
    const edited = await edit({
      uri: m.uri,
      content: '{{cred:prod-db#password}} 的主机是 prod-db，备机也是 prod-db',
    })
    const result = await converted(edited, { value: 'prod-db', identifier: 'host', field: 'name' })
    expect(result.replaced).toBe(2)
    const kept =
      '{{cred:prod-db#password}} 的主机是 {{cred:host#name}}，备机也是 {{cred:host#name}}'
    expect(result.memory.content).toBe(kept)
    const events = await eventsOf(m.id)
    expect((events[0]!.after as { content: string }).content).toBe(
      '{{cred:prod-db#password}} 的主机是 {{cred:host#name}}',
    )
    expect((events[1]!.after as { content: string }).content).toBe(kept)

    // 值是 cred：占位符的写法不受影响，别处的换掉
    await credentialNamed('foo')
    const other = await remember({ uri: 'notes://two', content: '{{cred:foo}} 是 cred 的例子' })
    const second = await converted(other, { value: 'cred', identifier: 'word', field: 'text' })
    expect(second.memory.content).toBe('{{cred:foo}} 是 {{cred:word#text}} 的例子')

    // 只在占位符里出现：正文里没有这段值
    const only = await remember({ uri: 'notes://three', content: '只有 {{cred:foo}}' })
    const res = await convert(only, { value: 'foo', identifier: 'bar', field: 'text' })
    expect(res.status).toBe(400)
    expect((await rowOf(only.id)).content).toBe(only.content)
  })

  it('换过的旧密码不是这个值，留在历史里：数出来告诉调用方；现在正文里别的明文不算历史', async () => {
    const m = await remember({ uri: 'notes://wifi', content: '密码：old-password-1' })
    const rotated = await edit({ uri: m.uri, content: `密码：${VALUE}` })
    const result = await converted(rotated)
    expect(result.plaintextVersions).toBe(1)
    const events = JSON.stringify(await eventsOf(m.id))
    expect(events).not.toContain(VALUE)
    expect(events).toContain('old-password-1')

    const other = await remember({ uri: 'notes://two', content: `密码：${VALUE} token=abcd1234` })
    const second = await converted(other, { identifier: 'two' })
    // 这一版换掉之后的正文还有 token，它就是现在的正文，不算历史版本
    expect(second.plaintextVersions).toBe(0)
  })

  it('别的记忆里还有这个值时数出来：调用方有权看到的，已删除、过期的也算；这次不动它们', async () => {
    const value = 'hunter2-copied'
    const m = await remember({ uri: 'notes://wifi', content: `密码：${value}` })
    // 数得到的：有效的、共享层的、触发场景里的、已删除的、过期的、来自对话的
    const copy = await remember({ uri: 'notes://copy', content: `也写着 ${value}` })
    await remember({ uri: 'kb://copy', content: `共享的 ${value}`, layer: 'base' })
    await remember({ uri: 'notes://hint', content: '正文没有', disclosure: `提到 ${value} 时` })
    const gone = await remember({ uri: 'notes://gone', content: `合并之前的 ${value}` })
    expect((await send('DELETE', `/memories?uri=${encodeURIComponent(gone.uri)}`)).status).toBe(204)
    const lapsed = await remember({ uri: 'notes://lapsed', content: `过期的 ${value}` })
    await inSpace(async (tx) => {
      await tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 1000) })
        .where(eq(memories.id, lapsed.id))
      await tx.insert(memories).values({
        spaceId: ws.spaceId,
        form: 'extracted',
        layer: 'episode',
        sensitivity: 'public',
        provenance: 'untrusted',
        content: `群里说的 ${value}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    })
    // 数不到的：别的成员的私人层、secret 的密文、只在占位符里的
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    await remember({ uri: 'notes://bobs', content: `bob 的 ${value}` }, bob.cookie)
    await remember({ uri: 'notes://vault', content: value, sensitivity: 'secret' })
    expect(
      (
        await send('POST', '/credentials', {
          identifier: value,
          name: '同名的',
          source: { kind: 'hosted', values: { password: 'other' } },
        })
      ).status,
    ).toBe(201)
    await remember({ uri: 'notes://ref', content: `{{cred:${value}}}` })

    const result = await converted(m, { value })
    expect(result.otherMemories).toBe(6)
    expect((await rowOf(copy.id)).content).toContain(value)
    expect(JSON.stringify(result)).not.toContain(value)
  })

  it('别的记忆里没有这个值时是 0', async () => {
    const m = await seedNote()
    await remember({ uri: 'notes://other', content: '没写' })
    expect((await converted(m)).otherMemories).toBe(0)
  })

  it('旧快照里残留的全文检索向量一起去掉', async () => {
    const m = await seedNote()
    await inSpace((tx) =>
      tx
        .update(memoryEvents)
        .set({
          after: sql`${memoryEvents.after} || jsonb_build_object('fts', ${"'hunter2':1"}::text)`,
        })
        .where(eq(memoryEvents.memoryId, m.id)),
    )
    await converted(m)
    for (const event of await eventsOf(m.id)) {
      expect(event.after ?? {}).not.toHaveProperty('fts')
      expect(event.before ?? {}).not.toHaveProperty('fts')
    }
  })

  it('改层之前的版本别的成员可能看得到：换成星号，不给标识；旧版本的 disclosure 与关键词也不留这个值', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const m = await remember({
      uri: 'kb://wifi',
      content: `密码：${VALUE}`,
      layer: 'base',
      sensitivity: 'private',
      disclosure: `提到 ${VALUE} 时`,
      glossary: [`词-${VALUE}`, '无线网络'],
    })
    await edit({ uri: m.uri, disclosure: '连 Wi-Fi 时', glossaryRemove: [`词-${VALUE}`] })
    const moved = await edit({ uri: m.uri, layer: 'private' })
    const result = await converted(moved)
    // 盖过的版本（密码：***）不算还有明文
    expect(result.plaintextVersions).toBe(0)

    // 写在引号里的值，盖过之后也不算
    const quoted = await remember({
      uri: 'kb://quoted',
      content: `password: "${VALUE}"`,
      layer: 'base',
      sensitivity: 'private',
    })
    const quotedAway = await edit({ uri: quoted.uri, layer: 'private' })
    const second = await converted(quotedAway, { identifier: 'quoted' })
    expect(second.plaintextVersions).toBe(0)
    expect(((await eventsOf(quoted.id))[0]!.after as { content: string }).content).toBe(
      'password: "***"',
    )

    const events = await eventsOf(m.id)
    expect(JSON.stringify(events)).not.toContain(VALUE)
    const created = events[0]!.after as { content: string; disclosure: string; glossary: string[] }
    expect(created.content).toBe('密码：***')
    expect(created.disclosure).toBe('提到 *** 时')
    expect(created.glossary).toEqual(['无线网络'])
    // 改层之前的版本 bob 看得到（离开的记录），里面没有私人层凭据的标识
    const seen = JSON.stringify(await inSpace((tx) => tx.select().from(memoryEvents)))
    expect(seen).toContain('密码：***')
    expect(bob.accountId).toBeTruthy()
    // 这条已经在私人层，那时候的版本（「改层」事件的改后）用占位符
    const layered = events.find((e) => (e.after as { layer?: string } | null)?.layer === 'private')!
    expect((layered.after as { content: string }).content).toBe('密码：{{cred:wifi#password}}')
  })

  it('改名之前的 URI 里有这个值：历史里也换掉，现在的 URI 里有才拒绝', async () => {
    const value = 'hunter2box'
    const m = await remember({ uri: `${value}://notes/${value}/a`, content: `密码：${value}` })
    const moved = await ok<MemoryView>(
      await send('POST', '/memories/move', { from: m.uri, to: 'notes://wifi' }),
    )
    await converted(moved, { value })

    const events = await eventsOf(m.id)
    expect(JSON.stringify(events)).not.toContain(value)
    expect(events[0]!.after).toMatchObject({ domain: '***', path: 'notes/***/a' })
    const history = await ok<MemoryHistory>(await send('GET', `/memories/history?id=${m.id}`))
    expect(history.events[0]!.after!.uri).toBe('***://notes/***/a')
    expect(history.events[1]!.before!.uri).toBe('***://notes/***/a')
    expect(history.events[1]!.after!.uri).toBe('notes://wifi')
  })

  it('Dream 的建议里抄下的这个值也换掉', async () => {
    const m = await seedNote()
    const other = await remember({ uri: 'notes://other', content: `也写着 ${VALUE}` })
    await inSpace((tx) =>
      tx.insert(dreamSuggestions).values([
        {
          spaceId: ws.spaceId,
          scope: `private:${ws.accountId}`,
          ownerAccountId: ws.accountId,
          kind: 'distill',
          memoryIds: [m.id],
          versions: [m.version],
          content: `提炼：Wi-Fi 是 ${VALUE}`,
          uri: `notes://${VALUE}`,
          disclosure: `提到 ${VALUE} 时`,
          reason: `都写着 ${VALUE}`,
          fingerprint: 'a',
        },
        // 不涉及这条记忆的不动
        {
          spaceId: ws.spaceId,
          scope: `private:${ws.accountId}`,
          ownerAccountId: ws.accountId,
          kind: 'stale',
          memoryIds: [other.id],
          versions: [other.version],
          reason: `另一条写着 ${VALUE}`,
          fingerprint: 'b',
        },
      ]),
    )
    await converted(m)
    const rows = await inSpace((tx) =>
      tx.select().from(dreamSuggestions).orderBy(asc(dreamSuggestions.fingerprint)),
    )
    expect(rows[0]).toMatchObject({
      content: '提炼：Wi-Fi 是 ***',
      uri: 'notes://***',
      disclosure: '提到 *** 时',
      reason: '都写着 ***',
    })
    expect(rows[1]!.reason).toContain(VALUE)
  })

  describe('现有的规则都走', () => {
    const untouched = async (m: MemoryView) => {
      const row = await rowOf(m.id)
      expect(row.version).toBe(m.version)
      expect(row.content).toBe(m.content)
      expect(await credentialCount()).toBe(0)
      expect((await eventsOf(m.id)).map((e) => e.eventType)).toEqual(['create'])
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
        source: { kind: 'hosted', values: { password: 'other' } },
      })
      expect(taken.status).toBe(201)
      const res = await convert(m)
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toContain('标识已被占用')
      const row = await rowOf(m.id)
      expect(row).toMatchObject({ version: m.version, content: m.content })
      expect((await eventsOf(m.id)).map((e) => e.eventType)).toEqual(['create'])
      const list = await ok<ConsoleCredentialList>(await send('GET', '/credentials'))
      expect(list.items.map((c) => c.name)).toEqual(['已有的'])
    })

    it('不在私人层、敏感级不够私密时拒绝，并说明要先怎么做', async () => {
      const shared = await remember({ uri: 'kb://wifi', content: BODY, layer: 'base' })
      const res = await convert(shared)
      expect(res.status).toBe(400)
      const { error } = (await res.json()) as { error: string }
      expect(error).toContain('私人层')
      expect(error).toContain('先')
      await untouched(shared)

      const open = await remember({
        uri: 'notes://open',
        content: BODY,
        layer: 'private',
        sensitivity: 'internal',
      })
      const lower = await convert(open)
      expect(lower.status).toBe(400)
      expect(((await lower.json()) as { error: string }).error).toContain('私密')
    })

    it('机密记忆不用转存', async () => {
      const m = await remember({ uri: 'notes://vault', content: BODY, sensitivity: 'secret' })
      const res = await convert(m)
      expect(res.status).toBe(400)
      expect(await credentialCount()).toBe(0)
    })

    it('托管凭据要空间所有者；viewer 写不了；读不到的和不存在一样', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      const viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
      const hers = await remember({ uri: 'notes://eve', content: BODY }, editor.cookie)
      const res = await convert(hers, {}, editor.cookie)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toContain('secret')
      expect((await rowOf(hers.id)).content).toBe(BODY)

      const mine = await seedNote()
      expect((await convert(mine, {}, editor.cookie)).status).toBe(404)
      expect((await convert(mine, {}, viewer.cookie)).status).toBe(404)
      const shared = await remember({ uri: 'kb://faq', content: BODY, layer: 'base' })
      expect((await convert(shared, {}, viewer.cookie)).status).toBe(403)
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
        `/v1/spaces/${ws.spaceId}/memories/convert-to-credential`,
        jsonRequest(
          'POST',
          {
            memoryId: m.id,
            expectedVersion: m.version,
            value: VALUE,
            identifier: 'wifi',
            name: '无线网络',
            field: 'password',
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

    it('URI、disclosure、关键词里也有这个值时拒绝：它们是明文，也放不了占位符', async () => {
      const inDisclosure = await seedNote({ disclosure: `提到 ${VALUE} 时` })
      const res = await convert(inDisclosure)
      expect(res.status).toBe(400)
      const { error } = (await res.json()) as { error: string }
      expect(error).toContain('触发场景')
      expect(error).not.toContain(VALUE)
      await untouched(inDisclosure)

      const inGlossary = await remember({
        uri: 'notes://two',
        content: BODY,
        glossary: [VALUE],
      })
      expect((await convert(inGlossary)).status).toBe(400)

      const inUri = await remember({ uri: 'notes://hunter2-box', content: '密码：hunter2-box' })
      expect((await convert(inUri, { value: 'hunter2-box' })).status).toBe(400)
    })

    it('换成占位符之后超过正文的长度上限时拒绝', async () => {
      const m = await remember({ uri: 'notes://long', content: 'abcd '.repeat(4000) })
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
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        await tx`select 1 from memories where id = ${m.id} for update`
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
        await tx`update memories set content = '别处改过的', version = version + 1 where id = ${m.id}`
      })
      expect((await pending!).status).toBe(409)
    } finally {
      await pending?.catch(() => {})
      await side.end()
    }
    expect(await credentialCount()).toBe(0)
    expect((await rowOf(m.id)).content).toBe('别处改过的')
    expect((await eventsOf(m.id)).map((e) => e.eventType)).toEqual(['create'])
  })

  it('改记忆这一步失败时凭据也不留下：两个服务在一个事务里', async () => {
    const m = await seedNote()
    queued.length = 0
    await database.db.execute(sql`
      create function test_fail_memory_update() returns trigger language plpgsql as $$
      begin raise exception 'boom'; end $$`)
    await database.db.execute(sql`
      create trigger test_fail_memory_update before update of content on memories
      for each row execute function test_fail_memory_update()`)
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
      await database.db.execute(sql`drop trigger test_fail_memory_update on memories`)
      await database.db.execute(sql`drop function test_fail_memory_update()`)
    }
    expect(await credentialCount()).toBe(0)
    const row = await rowOf(m.id)
    expect(row).toMatchObject({ version: m.version, content: BODY })
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
    expect(row).toMatchObject({ version: m.version, content: BODY })
    expect((await eventsOf(m.id)).map((e) => e.eventType)).toEqual(['create'])

    const retried = await converted(m)
    expect(retried.credential).toMatchObject({ identifier: 'wifi', referenceCount: 1 })
  })

  it('转存之后这条记忆的引用算数：凭据删不掉', async () => {
    const m = await seedNote()
    const { credential } = await converted(m)
    const del = await send('DELETE', `/credentials/${credential.id}`)
    expect(del.status).toBe(409)
  })
})
