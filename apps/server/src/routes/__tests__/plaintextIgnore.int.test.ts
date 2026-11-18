import { randomBytes } from 'node:crypto'

import {
  ConsoleEntryView,
  type ActivityList,
  type CircleOverview,
  type EntryHistory,
  type EntryList,
  type InboxCounts,
  type IssuedKey,
} from '@kioku/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database, type Tx } from '../../db/client'
import { dreamSuggestions, entries, entryEvents, entryVariants, subjects } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  addMember,
  bearer,
  bootstrap,
  FULL_SCOPES,
  jsonRequest,
  type Workspace,
} from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('疑似明文的忽略', () => {
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
      method === 'GET' ? { headers: { cookie } } : jsonRequest(method, body, { cookie }),
    )
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const createPersonalClientKey = async () => {
    const cRes = await send('POST', '/clients', {
      slug: 'agent',
      name: 'agent',
      runtimeFamily: 'mcp',
    })
    const client = await ok<{ id: string }>(cRes, 201)
    const kRes = await send('POST', `/clients/${client.id}/keys`, {
      name: 'test',
      scopes: FULL_SCOPES,
    })
    return (await ok<IssuedKey>(kRes, 201)).key
  }
  const remember = async (
    body: Record<string, unknown>,
    cookie = ws.cookie,
    circleId = ws.personalCircleId,
  ) =>
    ConsoleEntryView.parse(
      await ok(
        await send('POST', '/entries', { ...body, allowPlaintext: true }, cookie, circleId),
        201,
      ),
    )
  const edit = async (body: Record<string, unknown>, circleId = ws.personalCircleId) =>
    ConsoleEntryView.parse(
      await ok(
        await send('PATCH', '/entries', { ...body, allowPlaintext: true }, ws.cookie, circleId),
      ),
    )
  const ignore = (
    m: { id: string; version: number },
    cookie = ws.cookie,
    circleId = ws.personalCircleId,
  ) =>
    send(
      'POST',
      '/entries/ignore-plaintext',
      { entryId: m.id, expectedVersion: m.version },
      cookie,
      circleId,
    )
  const unignore = (
    m: { id: string; version: number },
    cookie = ws.cookie,
    circleId = ws.personalCircleId,
  ) =>
    send(
      'POST',
      '/entries/unignore-plaintext',
      { entryId: m.id, expectedVersion: m.version },
      cookie,
      circleId,
    )
  const listed = async (plaintext: string, circleId = ws.personalCircleId) =>
    (
      await ok<EntryList>(
        await send('GET', `/entries/list?plaintext=${plaintext}`, undefined, ws.cookie, circleId),
      )
    ).items
      .map((m) => m.title)
      .sort()
  const suspects = async (circleId = ws.personalCircleId) => ({
    list: await listed('true', circleId),
    overview: (
      await ok<CircleOverview>(await send('GET', '/overview', undefined, ws.cookie, circleId))
    ).plaintextCredentials,
    counts: (
      await ok<InboxCounts>(await send('GET', '/inbox/counts', undefined, ws.cookie, circleId))
    ).plaintext,
  })
  const historyOf = async (id: string, circleId = ws.personalCircleId) =>
    ok<EntryHistory>(await send('GET', `/entries/history?id=${id}`, undefined, ws.cookie, circleId))

  it('忽略之后列表筛选、概览与待处理总数都不再算；能单独列出忽略掉的；词条本身不变', async () => {
    const m = await remember({ title: 'wifi', content: '访客网络密码：guest-1234' })
    await remember({ title: 'api', content: 'token = abc123' })
    expect(await suspects()).toEqual({
      list: ['api', 'wifi'],
      overview: 2,
      counts: 2,
    })

    const ignored = ConsoleEntryView.parse(await ok(await ignore(m)))
    expect(ignored).toMatchObject({ plaintextIgnored: true, version: m.version })
    expect(ignored.updatedAt).toBe(m.updatedAt)
    expect(ignored.variants[0]!.content).toBe(m.variants[0]!.content)
    expect(await suspects()).toEqual({ list: ['api'], overview: 1, counts: 1 })
    expect(await listed('ignored')).toEqual(['wifi'])
    expect(await listed('false')).toEqual(['wifi'])
    // 读的时候也知道被忽略了：界面按它显示「撤销忽略」
    const read = ConsoleEntryView.parse(
      await ok(await send('GET', `/entries?id=${encodeURIComponent(m.shortId)}`)),
    )
    expect(read.plaintextIgnored).toBe(true)
    // 向量任务按内容判断词条被改过没有：这次操作也要排一次，正文没变它会直接跳过
    expect(queued).toContain(m.id)
  })

  it('历史里看得到是谁忽略、谁撤销的；进变更记录；快照里没有正文和哈希；不是一个能恢复的版本', async () => {
    const m = await remember({ title: 'wifi', content: '访客网络密码：guest-1234' })
    await ok(await ignore(m))
    await ok(await unignore(m))
    const history = await historyOf(m.id)
    expect(history.events.map((e) => e.type)).toEqual([
      'unignore_plaintext',
      'ignore_plaintext',
      'create',
    ])
    const [undone, ignored] = history.events
    expect(ignored).toMatchObject({ actor: { accountName: 'alice' }, after: null, via: null })
    expect(ignored!.before).toMatchObject({
      shortId: m.shortId,
      version: m.version,
      variants: [{ when: {}, content: null }],
    })
    expect(undone).toMatchObject({ actor: { accountName: 'alice' }, after: null })
    expect(history.entry.version).toBe(m.version)

    const activity = await ok<ActivityList>(await send('GET', '/activity'))
    expect(activity.items.map((i) => i.type)).toEqual([
      'unignore_plaintext',
      'ignore_plaintext',
      'create',
    ])
    expect(activity.items[0]!.changes).toEqual([])

    const rows = await inPersonal((tx) =>
      tx.select().from(entryEvents).where(eq(entryEvents.entryId, m.id)),
    )
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain('plaintextIgnoredHash')
    // 新建事件照常有正文；忽略的两条不再存一份
    expect(stored.split('guest-1234').length - 1).toBe(1)
    const restore = await send('POST', '/entries/restore', {
      entryId: m.id,
      eventId: ignored!.id,
      expectedVersion: m.version,
    })
    expect(restore.status).toBe(404)
  })

  it('撤销之后提示回来；连点两次只留一条事件；没被忽略时撤销什么都不写', async () => {
    const m = await remember({ title: 'wifi', content: '访客网络密码：guest-1234' })
    await ok(await unignore(m))
    await ok(await ignore(m))
    await ok(await ignore(m))
    expect((await historyOf(m.id)).events.map((e) => e.type)).toEqual([
      'ignore_plaintext',
      'create',
    ])
    const back = ConsoleEntryView.parse(await ok(await unignore(m)))
    expect(back.plaintextIgnored).toBe(false)
    expect((await suspects()).list).toEqual(['wifi'])
  })

  describe('正文改了提示自动回来', () => {
    const FIRST = '访客网络密码：guest-1234'
    const SECOND = '访客网络密码：guest-5678'

    it('修改', async () => {
      const m = await remember({ title: 'wifi', content: FIRST })
      await ok(await ignore(m))
      const edited = await edit({ id: m.id, content: SECOND })
      expect(edited.plaintextIgnored).toBe(false)
      expect((await suspects()).list).toEqual(['wifi'])
    })

    it('只改别的字段不算：提示不回来', async () => {
      const m = await remember({ title: 'wifi', content: FIRST })
      await ok(await ignore(m))
      expect((await edit({ id: m.id, priority: 5 })).plaintextIgnored).toBe(true)
      expect((await suspects()).list).toEqual([])
    })

    it('通过 Key 修改', async () => {
      const m = await remember({ title: 'wifi', content: FIRST })
      await ok(await ignore(m))
      const key = await createPersonalClientKey()
      const res = await app.request(
        '/v1/entries',
        jsonRequest('PATCH', { id: m.shortId, content: SECOND, plaintextOk: true }, bearer(key)),
      )
      expect(res.status).toBe(200)
      expect((await suspects()).list).toEqual(['wifi'])
    })

    it('恢复旧版本：恢复成别的正文时回来；再恢复成忽略时的那段正文也要重新忽略，哈希已经清掉了', async () => {
      const m = await remember({ title: 'wifi', content: SECOND })
      const edited = await edit({ id: m.id, content: FIRST })
      await ok(await ignore(edited))
      expect((await suspects()).list).toEqual([])

      const events = (await historyOf(m.id)).events
      const created = events.find((e) => e.type === 'create')!
      const update = events.find((e) => e.type === 'update')!
      const toSecond = ConsoleEntryView.parse(
        await ok(
          await send('POST', '/entries/restore', {
            entryId: m.id,
            eventId: created.id,
            expectedVersion: edited.version,
          }),
        ),
      )
      expect(toSecond.plaintextIgnored).toBe(false)
      expect((await suspects()).list).toEqual(['wifi'])

      const toFirst = ConsoleEntryView.parse(
        await ok(
          await send('POST', '/entries/restore', {
            entryId: m.id,
            eventId: update.id,
            expectedVersion: toSecond.version,
          }),
        ),
      )
      expect(toFirst.plaintextIgnored).toBe(false)
      expect((await suspects()).list).toEqual(['wifi'])
    })
  })

  it('正文一变就清掉哈希：它是含旧值的正文的 SHA-256，留着能离线猜解；只改别的字段时留着', async () => {
    const hashOf = async (entryId: string) =>
      (
        await inPersonal((tx) =>
          tx
            .select({ hash: entryVariants.plaintextIgnoredHash })
            .from(entryVariants)
            .where(eq(entryVariants.entryId, entryId)),
        )
      )[0]!.hash
    const m = await remember({ title: 'wifi', content: '访客网络密码：guest-1234' })
    await ok(await ignore(m))
    expect(await hashOf(m.id)).toMatch(/^[0-9a-f]{64}$/)

    await edit({ id: m.id, priority: 5 })
    await edit({ id: m.id, disclosure: '连 Wi-Fi 时' })
    expect(await hashOf(m.id)).not.toBeNull()
    // 正文写回一样的不算变化
    await edit({ id: m.id, content: '访客网络密码：guest-1234' })
    expect(await hashOf(m.id)).not.toBeNull()

    await edit({ id: m.id, content: '访客网络密码：guest-5678' })
    expect(await hashOf(m.id)).toBeNull()
  })

  it('Dream 合并事实改了正文也清掉哈希；只设为过时的不动', async () => {
    const [person] = await inCircle(ws.circleId, (tx) =>
      tx
        .insert(subjects)
        .values({ circleId: ws.circleId, kind: 'person', displayName: '小明' })
        .returning(),
    )
    const factSpec = (shortId: string, title: string, content: string) => ({
      shortId,
      title,
      content,
    })
    const specs = [
      factSpec('m-dr2345', '喝茶一', '喜欢喝茶'),
      factSpec('m-dr3456', '喝茶二', '爱喝茶'),
      factSpec('m-dr4567', '城市', '住在上海'),
    ]
    const createdFacts: (typeof entries.$inferSelect)[] = []
    await inCircle(ws.circleId, async (tx) => {
      for (const s of specs) {
        const [e] = await tx
          .insert(entries)
          .values({
            circleId: ws.circleId,
            shortId: s.shortId,
            circleKind: 'shared',
            kind: 'fact',
            sensitivity: 'public',
            provenance: 'owner',
            originScope: 'global',
            subjectId: person!.id,
            subjectKind: 'person',
            title: s.title,
          })
          .returning()
        await tx.insert(entryVariants).values({
          circleId: ws.circleId,
          entryId: e!.id,
          kind: 'fact',
          sensitivity: 'public',
          when: {},
          whenSignature: '{}',
          sortOrder: 0,
          content: s.content,
          plaintextIgnoredHash: 'a'.repeat(64),
        })
        createdFacts.push(e!)
      }
    })
    const [keep, other, staled] = createdFacts
    const suggestion = (
      fingerprint: string,
      extra: Partial<typeof dreamSuggestions.$inferInsert>,
    ) => ({
      circleId: ws.circleId,
      scope: `talk:direct:${person!.id}`,
      reason: '整理',
      fingerprint,
      kind: 'stale',
      entryIds: [] as string[],
      versions: [] as number[],
      ...extra,
    })
    const [merge, stale] = await inCircle(ws.circleId, (tx) =>
      tx
        .insert(dreamSuggestions)
        .values([
          suggestion('merge', {
            kind: 'merge',
            entryIds: [keep!.id, other!.id],
            versions: [1, 1],
            keepId: keep!.id,
            content: '喜欢喝茶，尤其是绿茶',
          }),
          suggestion('stale', { entryIds: [staled!.id], versions: [1] }),
        ])
        .returning(),
    )
    await ok(
      await send('POST', `/dream/suggestions/${merge!.id}/apply`, {}, ws.cookie, ws.circleId),
    )
    await ok(
      await send('POST', `/dream/suggestions/${stale!.id}/apply`, {}, ws.cookie, ws.circleId),
    )
    const rows = await inCircle(ws.circleId, (tx) =>
      tx
        .select({
          entryId: entryVariants.entryId,
          content: entryVariants.content,
          hash: entryVariants.plaintextIgnoredHash,
        })
        .from(entryVariants)
        .where(inArray(entryVariants.entryId, [keep!.id, staled!.id])),
    )
    expect(rows.find((r) => r.entryId === keep!.id)).toMatchObject({
      content: '喜欢喝茶，尤其是绿茶',
      hash: null,
    })
    expect(rows.find((r) => r.entryId === staled!.id)!.hash).toBe('a'.repeat(64))
  })

  it('判断只看比较：哈希和现在的正文对不上就不算忽略，别的路径没清掉哈希也不会判错', async () => {
    const m = await remember({ title: 'wifi', content: '访客网络密码：guest-1234' })
    await ok(await ignore(m))
    // 不经过服务改正文，哈希留着：回滚到旧版本之后的写入就是这样
    await inPersonal((tx) =>
      tx
        .update(entryVariants)
        .set({ content: '访客网络密码：guest-9999' })
        .where(eq(entryVariants.entryId, m.id)),
    )
    expect((await suspects()).list).toEqual(['wifi'])
    expect(await listed('ignored')).toEqual([])
    const read = ConsoleEntryView.parse(
      await ok(await send('GET', `/entries?id=${encodeURIComponent(m.shortId)}`)),
    )
    expect(read.plaintextIgnored).toBe(false)
  })

  it('改成 secret 时清掉哈希（密文的哈希不留在明文列里），之后不算；降级回来提示也回来', async () => {
    const m = await remember({ title: 'wifi', content: '访客网络密码：guest-1234' })
    await ok(await ignore(m))
    const raised = await edit({ id: m.id, sensitivity: 'secret' })
    const [vRow] = await inPersonal((tx) =>
      tx.select().from(entryVariants).where(eq(entryVariants.entryId, m.id)),
    )
    expect(vRow!.plaintextIgnoredHash).toBeNull()
    expect((await suspects()).list).toEqual([])
    expect(await listed('ignored')).toEqual([])

    const lowered = await edit({ id: raised.id, sensitivity: 'private' })
    expect(lowered.plaintextIgnored).toBe(false)
    expect((await suspects()).list).toEqual(['wifi'])
  })

  it('写权限和改这条词条一样：viewer 不行，读不到的和不存在一样；看过之后被改过的 409；没有疑似明文的不用忽略', async () => {
    const viewer = await addMember(database.db, ws.circleId, 'vic', 'viewer')
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const shared = await remember(
      { title: 'kb-api', content: 'token = abc123' },
      ws.cookie,
      ws.circleId,
    )
    const mine = await remember({ title: 'wifi', content: '访客网络密码：guest-1234' })
    const secret = await remember(
      {
        title: 'kb-vault',
        content: '密码：hunter2',
        sensitivity: 'secret',
      },
      ws.cookie,
      ws.circleId,
    )
    const plain = await remember({ title: 'plain', content: '普通的一段话' })

    expect((await ignore(shared, viewer.cookie, ws.circleId)).status).toBe(403)
    expect((await unignore(shared, viewer.cookie, ws.circleId)).status).toBe(403)
    // 别的成员个人圈的私密词条（403 无权访问）与共享圈读不到的机密词条（404）
    expect((await ignore(mine, editor.cookie, ws.personalCircleId)).status).toBe(403)
    expect((await ignore(secret, editor.cookie, ws.circleId)).status).toBe(404)
    expect((await ignore(plain)).status).toBe(400)
    expect(
      (await ignore({ id: shared.id, version: shared.version + 1 }, ws.cookie, ws.circleId)).status,
    ).toBe(409)
    expect(
      (await unignore({ id: shared.id, version: shared.version + 1 }, ws.cookie, ws.circleId))
        .status,
    ).toBe(409)
    // 删掉的和读不到一样
    await send('DELETE', `/entries?id=${encodeURIComponent(mine.shortId)}`)
    expect((await ignore(mine)).status).toBe(404)
    // editor 写得了共享圈词条
    await ok(await ignore(shared, editor.cookie, ws.circleId))
    expect(await listed('ignored', ws.circleId)).toEqual(['kb-api'])
  })

  it('数据库与 JS 算的哈希一样：中文、emoji、全角空格都对得上', async () => {
    const content = '密码：　p@ss😀word 中文 \t\n第二行 "引号" \\ 反斜杠'
    const m = await remember({ title: 'mixed', content })
    await ok(await ignore(m))
    expect(await listed('ignored')).toEqual(['mixed'])
    const read = ConsoleEntryView.parse(
      await ok(await send('GET', `/entries?id=${encodeURIComponent(m.shortId)}`)),
    )
    expect(read.plaintextIgnored).toBe(true)
    const [row] = await inPersonal((tx) =>
      tx
        .select({
          stored: entryVariants.plaintextIgnoredHash,
          computed: sql<string>`encode(sha256(convert_to(${entryVariants.content}, 'UTF8')), 'hex')`,
        })
        .from(entryVariants)
        .where(eq(entryVariants.entryId, m.id)),
    )
    expect(row!.stored).toBe(row!.computed)
  })

  it('等锁期间正文被改了：不替新的正文做决定，返回 409，新的明文照常提示', async () => {
    const m = await remember({ title: 'wifi', content: '访客网络密码：guest-1234' })
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    let pending: Promise<Response> | undefined
    try {
      await side.begin(async (tx) => {
        await tx`select set_config('app.read_circles', ${ws.personalCircleId}, true)`
        await tx`select set_config('app.write_circles', ${ws.personalCircleId}, true)`
        await tx`select 1 from entries where id = ${m.id} for update`
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }]
        pending = Promise.resolve(ignore(m))
        for (let i = 0; ; i++) {
          const [row] = await side<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where ${pid}::int = any(pg_blocking_pids(pid))`
          if (row!.n > 0) break
          if (i >= 200) throw new Error('请求没有等在这把锁上')
          await new Promise((r) => setTimeout(r, 25))
        }
        await tx`update entries set version = version + 1 where id = ${m.id}`
        await tx`update entry_variants set content = '新的密码：real-secret' where entry_id = ${m.id}`
      })
      expect((await pending!).status).toBe(409)
    } finally {
      await pending?.catch(() => {})
      await side.end()
    }
    expect((await suspects()).list).toEqual(['wifi'])
    expect((await historyOf(m.id)).events.map((e) => e.type)).toEqual(['create'])
  })

  it('接入方的响应不带这两个字段', async () => {
    const m = await remember({ title: 'wifi', content: '访客网络密码：guest-1234' })
    await ok(await ignore(m))
    const key = await createPersonalClientKey()
    const res = await app.request(`/v1/entries?id=${encodeURIComponent(m.shortId)}`, {
      headers: bearer(key),
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(body).not.toHaveProperty('plaintextIgnored')
    expect(body).not.toHaveProperty('contentHidden')
    expect(body).not.toHaveProperty('plaintextIgnoredHash')
  })
})
