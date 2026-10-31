import { randomBytes } from 'node:crypto'

import {
  ConsoleMemoryView,
  type ActivityList,
  type InboxCounts,
  type MemoryHistory,
  type MemoryList,
  type SpaceOverview,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database, type Tx } from '../../db/client'
import { memories, memoryEvents } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { applySync } from '../../importer/lore'
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
      method === 'GET' ? { headers: { cookie } } : jsonRequest(method, body, { cookie }),
    )
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const remember = async (body: Record<string, unknown>, cookie = ws.cookie) =>
    ConsoleMemoryView.parse(await ok(await send('POST', '/memories', body, cookie), 201))
  const edit = async (body: Record<string, unknown>) =>
    ConsoleMemoryView.parse(await ok(await send('PATCH', '/memories', body)))
  const ignore = (m: { id: string; version: number }, cookie = ws.cookie) =>
    send(
      'POST',
      '/memories/ignore-plaintext',
      { memoryId: m.id, expectedVersion: m.version },
      cookie,
    )
  const unignore = (m: { id: string; version: number }, cookie = ws.cookie) =>
    send(
      'POST',
      '/memories/unignore-plaintext',
      { memoryId: m.id, expectedVersion: m.version },
      cookie,
    )
  const listed = async (plaintext: string) =>
    (
      await ok<MemoryList>(await send('GET', `/memories/list?plaintext=${plaintext}&sort=uri`))
    ).items.map((m) => m.uri)
  const suspects = async () => ({
    list: await listed('true'),
    overview: (await ok<SpaceOverview>(await send('GET', '/overview'))).plaintextCredentials,
    counts: (await ok<InboxCounts>(await send('GET', '/inbox/counts'))).plaintext,
  })
  const historyOf = async (id: string) =>
    ok<MemoryHistory>(await send('GET', `/memories/history?id=${id}`))

  it('忽略之后列表筛选、概览与待处理总数都不再算；能单独列出忽略掉的；记忆本身不变', async () => {
    const m = await remember({ uri: 'notes://wifi', content: '访客网络密码：guest-1234' })
    await remember({ uri: 'notes://api', content: 'token = abc123' })
    expect(await suspects()).toEqual({
      list: ['notes://api', 'notes://wifi'],
      overview: 2,
      counts: 2,
    })

    const ignored = ConsoleMemoryView.parse(await ok(await ignore(m)))
    expect(ignored).toMatchObject({ plaintextIgnored: true, version: m.version })
    expect(ignored.updatedAt).toBe(m.updatedAt)
    expect(ignored.content).toBe(m.content)
    expect(await suspects()).toEqual({ list: ['notes://api'], overview: 1, counts: 1 })
    expect(await listed('ignored')).toEqual(['notes://wifi'])
    expect(await listed('false')).toEqual(['notes://wifi'])
    // 读的时候也知道被忽略了：界面按它显示「撤销忽略」
    const read = ConsoleMemoryView.parse(
      await ok(await send('GET', '/memories?uri=notes%3A%2F%2Fwifi')),
    )
    expect(read.plaintextIgnored).toBe(true)
    // 向量任务按 xmin 判断记忆被改过没有：这次写入也要排一次，正文没变它会直接跳过
    expect(queued).toContain(m.id)
  })

  it('历史里看得到是谁忽略、谁撤销的；进变更记录；快照里没有正文和哈希；不是一个能恢复的版本', async () => {
    const m = await remember({ uri: 'notes://wifi', content: '访客网络密码：guest-1234' })
    await ok(await ignore(m))
    await ok(await unignore(m))
    const history = await historyOf(m.id)
    expect(history.events.map((e) => e.type)).toEqual([
      'create',
      'ignore_plaintext',
      'unignore_plaintext',
    ])
    const [, ignored, undone] = history.events
    expect(ignored).toMatchObject({ actor: { accountName: 'alice' }, after: null, via: null })
    expect(ignored!.before).toMatchObject({ content: null, uri: m.uri, version: m.version })
    expect(undone).toMatchObject({ actor: { accountName: 'alice' }, after: null })
    expect(history.memory.version).toBe(m.version)

    const activity = await ok<ActivityList>(await send('GET', '/activity'))
    expect(activity.items.map((i) => i.type)).toEqual([
      'unignore_plaintext',
      'ignore_plaintext',
      'create',
    ])
    expect(activity.items[0]!.changes).toEqual([])

    const rows = await inSpace((tx) =>
      tx.select().from(memoryEvents).where(eq(memoryEvents.memoryId, m.id)),
    )
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain('plaintextIgnoredHash')
    // 新建事件照常有正文；忽略的两条不再存一份
    expect(stored.split('guest-1234').length - 1).toBe(1)
    const restore = await send('POST', '/memories/restore', {
      memoryId: m.id,
      eventId: ignored!.id,
      expectedVersion: m.version,
    })
    expect(restore.status).toBe(404)
  })

  it('撤销之后提示回来；连点两次只留一条事件；没被忽略时撤销什么都不写', async () => {
    const m = await remember({ uri: 'notes://wifi', content: '访客网络密码：guest-1234' })
    await ok(await unignore(m))
    await ok(await ignore(m))
    await ok(await ignore(m))
    expect((await historyOf(m.id)).events.map((e) => e.type)).toEqual([
      'create',
      'ignore_plaintext',
    ])
    const back = ConsoleMemoryView.parse(await ok(await unignore(m)))
    expect(back.plaintextIgnored).toBe(false)
    expect((await suspects()).list).toEqual(['notes://wifi'])
  })

  describe('正文改了提示自动回来', () => {
    const FIRST = '访客网络密码：guest-1234'
    const SECOND = '访客网络密码：guest-5678'

    it('修改', async () => {
      const m = await remember({ uri: 'notes://wifi', content: FIRST })
      await ok(await ignore(m))
      const edited = await edit({ uri: m.uri, content: SECOND })
      expect(edited.plaintextIgnored).toBe(false)
      expect((await suspects()).list).toEqual([m.uri])
    })

    it('只改别的字段不算：提示不回来', async () => {
      const m = await remember({ uri: 'notes://wifi', content: FIRST })
      await ok(await ignore(m))
      expect((await edit({ uri: m.uri, priority: 5 })).plaintextIgnored).toBe(true)
      expect((await suspects()).list).toEqual([])
    })

    it('通过 Key 修改', async () => {
      const m = await remember({ uri: 'notes://wifi', content: FIRST })
      await ok(await ignore(m))
      const key = await ws.issueKey((await ws.createApp('agent')).id)
      const res = await app.request(
        '/v1/memories',
        jsonRequest('PATCH', { uri: m.uri, content: SECOND }, bearer(key)),
      )
      expect(res.status).toBe(200)
      expect((await suspects()).list).toEqual([m.uri])
    })

    it('恢复旧版本：恢复成别的正文时回来；再恢复成忽略时的那段正文也要重新忽略，哈希已经清掉了', async () => {
      const m = await remember({ uri: 'notes://wifi', content: SECOND })
      const edited = await edit({ uri: m.uri, content: FIRST })
      await ok(await ignore(edited))
      expect((await suspects()).list).toEqual([])

      const events = (await historyOf(m.id)).events
      const created = events.find((e) => e.type === 'create')!
      const update = events.find((e) => e.type === 'update')!
      const toSecond = ConsoleMemoryView.parse(
        await ok(
          await send('POST', '/memories/restore', {
            memoryId: m.id,
            eventId: created.id,
            expectedVersion: edited.version,
          }),
        ),
      )
      expect(toSecond.plaintextIgnored).toBe(false)
      expect((await suspects()).list).toEqual([m.uri])

      const toFirst = ConsoleMemoryView.parse(
        await ok(
          await send('POST', '/memories/restore', {
            memoryId: m.id,
            eventId: update.id,
            expectedVersion: toSecond.version,
          }),
        ),
      )
      expect(toFirst.plaintextIgnored).toBe(false)
      expect((await suspects()).list).toEqual([m.uri])
    })

    it('导入同步', async () => {
      const m = await remember({ uri: 'notes://wifi', content: FIRST })
      await ok(await ignore(m))
      const result = await applySync(
        { db: database.db, spaceId: ws.spaceId, accountId: ws.accountId, masterKey },
        {
          items: [
            {
              source: 'core://wifi',
              uri: m.uri,
              state: 'update',
              changes: ['content'],
              request: {
                uri: m.uri,
                expectedId: m.id,
                expectedVersion: m.version,
                content: SECOND,
              },
              context: { source: 'lore' },
            },
          ],
          goneFromLore: [],
        },
      )
      expect(result.failed).toEqual([])
      expect((await suspects()).list).toEqual([m.uri])
    })
  })

  it('正文一变就清掉哈希：它是含旧值的正文的 SHA-256，留着能离线猜解；只改别的字段时留着', async () => {
    const hashOf = async (id: string) =>
      (
        await inSpace((tx) =>
          tx
            .select({ hash: memories.plaintextIgnoredHash })
            .from(memories)
            .where(eq(memories.id, id)),
        )
      )[0]!.hash
    const m = await remember({ uri: 'notes://wifi', content: '访客网络密码：guest-1234' })
    await ok(await ignore(m))
    expect(await hashOf(m.id)).toMatch(/^[0-9a-f]{64}$/)

    await edit({ uri: m.uri, priority: 5 })
    await edit({ uri: m.uri, disclosure: '连 Wi-Fi 时' })
    expect(await hashOf(m.id)).not.toBeNull()
    // 正文写回一样的不算变化
    await edit({ uri: m.uri, content: '访客网络密码：guest-1234' })
    expect(await hashOf(m.id)).not.toBeNull()

    await edit({ uri: m.uri, content: '访客网络密码：guest-5678' })
    expect(await hashOf(m.id)).toBeNull()
  })

  it('改成 secret 时清掉哈希（密文的哈希不留在明文列里），之后不算；降级回来提示也回来', async () => {
    const m = await remember({ uri: 'notes://wifi', content: '访客网络密码：guest-1234' })
    await ok(await ignore(m))
    const raised = await edit({ uri: m.uri, sensitivity: 'secret' })
    const [row] = await inSpace((tx) => tx.select().from(memories).where(eq(memories.id, m.id)))
    expect(row!.plaintextIgnoredHash).toBeNull()
    expect((await suspects()).list).toEqual([])
    // 机密的正文是密文，没有明文提示
    expect((await ignore(raised)).status).toBe(400)

    await edit({ uri: m.uri, sensitivity: 'private', allowPlaintext: true })
    expect((await suspects()).list).toEqual([m.uri])
  })

  it('写权限和改这条记忆一样：viewer 不行，读不到的和不存在一样；看过之后被改过的 409；没有疑似明文的不用忽略', async () => {
    const viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const shared = await remember({ uri: 'kb://api', content: 'token = abc123', layer: 'base' })
    const mine = await remember({ uri: 'notes://wifi', content: '访客网络密码：guest-1234' })
    const secret = await remember({
      uri: 'kb://vault',
      content: '密码：hunter2',
      layer: 'base',
      sensitivity: 'secret',
    })
    const plain = await remember({ uri: 'notes://plain', content: '普通的一段话' })

    expect((await ignore(shared, viewer.cookie)).status).toBe(403)
    expect((await unignore(shared, viewer.cookie)).status).toBe(403)
    // 别的成员的私人记忆与读不到的机密
    expect((await ignore(mine, editor.cookie)).status).toBe(404)
    expect((await ignore(secret, editor.cookie)).status).toBe(404)
    expect((await ignore(plain)).status).toBe(400)
    expect((await ignore({ id: shared.id, version: shared.version + 1 })).status).toBe(409)
    expect((await unignore({ id: shared.id, version: shared.version + 1 })).status).toBe(409)
    // 删掉的和读不到一样
    await send('DELETE', `/memories?uri=${encodeURIComponent(mine.uri)}`)
    expect((await ignore(mine)).status).toBe(404)
    // editor 写得了共享的层
    await ok(await ignore(shared, editor.cookie))
    expect(await listed('ignored')).toEqual([shared.uri])
  })

  it('应用层只有写得了这个应用的成员能忽略', async () => {
    const owned = await ws.createApp('agent')
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const m = await remember({ uri: 'app://agent/config', content: 'token = abc123' })
    expect((await ignore(m, editor.cookie)).status).toBe(403)
    expect(owned.id).toBeTruthy()
    await ok(await ignore(m))
  })

  it('数据库与 JS 算的哈希一样：中文、emoji、全角空格都对得上', async () => {
    const content = '密码：　p@ss😀word 中文 \t\n第二行 "引号" \\ 反斜杠'
    const m = await remember({ uri: 'notes://mixed', content })
    await ok(await ignore(m))
    expect(await listed('ignored')).toEqual([m.uri])
    const read = ConsoleMemoryView.parse(
      await ok(await send('GET', `/memories?uri=${encodeURIComponent(m.uri)}`)),
    )
    expect(read.plaintextIgnored).toBe(true)
    const [row] = await inSpace((tx) =>
      tx
        .select({
          stored: memories.plaintextIgnoredHash,
          computed: sql<string>`encode(sha256(convert_to(${memories.content}, 'UTF8')), 'hex')`,
        })
        .from(memories)
        .where(eq(memories.id, m.id)),
    )
    expect(row!.stored).toBe(row!.computed)
  })

  it('等锁期间正文被改了：不替新的正文做决定，返回 409，新的明文照常提示', async () => {
    const m = await remember({ uri: 'notes://wifi', content: '访客网络密码：guest-1234' })
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    let pending: Promise<Response> | undefined
    try {
      await side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        await tx`select 1 from memories where id = ${m.id} for update`
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
        await tx`update memories set content = '新的密码：real-secret', version = version + 1 where id = ${m.id}`
      })
      expect((await pending!).status).toBe(409)
    } finally {
      await pending?.catch(() => {})
      await side.end()
    }
    expect((await suspects()).list).toEqual([m.uri])
    expect((await historyOf(m.id)).events.map((e) => e.type)).toEqual(['create'])
  })

  it('接入方的响应不带这两个字段', async () => {
    const m = await remember({ uri: 'notes://wifi', content: '访客网络密码：guest-1234' })
    await ok(await ignore(m))
    const key = await ws.issueKey((await ws.createApp('agent')).id, FULL_SCOPES)
    const res = await app.request(`/v1/memories?uri=${encodeURIComponent(m.uri)}`, {
      headers: bearer(key),
    })
    const body = (await res.json()) as Record<string, unknown>
    expect(body).not.toHaveProperty('plaintextIgnored')
    expect(body).not.toHaveProperty('contentHidden')
    expect(body).not.toHaveProperty('plaintextIgnoredHash')
  })
})
