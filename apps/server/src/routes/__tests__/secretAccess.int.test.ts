import { randomBytes } from 'node:crypto'

import {
  ConsoleMemoryChildren,
  ConsoleMemoryView,
  MemoryView,
  type ActivityList,
  type MemoryHistory,
  type SpaceOverview,
} from '@kioku/contracts'
import { and, asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { consoleAccess } from '../../access/access'
import { createApp } from '../../app'
import { withSpace, type Database, type Tx } from '../../db/client'
import { memories, memoryEvents } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { MemoryService, sealMemoryContent } from '../../memory/service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  addMember,
  bearer,
  bootstrap,
  FULL_SCOPES,
  jsonRequest,
  type Workspace,
} from '../../testing/fixtures'

const BODY = '机房的门禁码写在这里 8842'

describe.skipIf(!testDatabaseUrl)('查看机密留痕', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let key: string
  const masterKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
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
    key = await ws.issueKey((await ws.createApp('agent')).id)
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
  // 管理界面的响应都按它的契约解析：少了字段就报错
  const view = async (res: Response, status = 200) => ConsoleMemoryView.parse(await ok(res, status))
  const remember = async (body: Record<string, unknown>, cookie = ws.cookie) =>
    view(await send('POST', '/memories', body, cookie), 201)
  const secret = (uri = 'home://door', extra: Record<string, unknown> = {}) =>
    remember({ uri, content: BODY, sensitivity: 'secret', ...extra })
  const reveal = (memoryId: string, cookie = ws.cookie) =>
    send('POST', '/memories/reveal', { memoryId }, cookie)
  const accessOf = (memoryId: string) =>
    inSpace((tx) =>
      tx
        .select()
        .from(memoryEvents)
        .where(and(eq(memoryEvents.memoryId, memoryId), eq(memoryEvents.eventType, 'access')))
        .orderBy(asc(memoryEvents.id)),
    )
  const viaOf = async (memoryId: string) =>
    (await accessOf(memoryId)).map((e) => (e.context as { via: string }).via)
  const historyOf = async (id: string, cookie = ws.cookie) =>
    ok<MemoryHistory>(await send('GET', `/memories/history?id=${id}`, undefined, cookie))
  const keyGet = (uri: string, withKey = key) =>
    app.request(`/v1/memories?uri=${encodeURIComponent(uri)}`, { headers: bearer(withKey) })
  const keyCall = (method: string, path: string, body: unknown) =>
    app.request(`/v1${path}`, jsonRequest(method, body, bearer(key)))
  let rpcId = 0
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: {
        ...bearer(key),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    const body = (await res.json()) as { result: { content: { text: string }[] } }
    return body.result.content[0]!.text
  }

  describe('管理界面', () => {
    it('所有响应默认都不给机密正文，标着有正文要显式查看；不解密就不记访问', async () => {
      const created = await secret('home://door', { disclosure: '一' })
      expect(created).toMatchObject({ content: null, contentHidden: true })

      const got = await view(await send('GET', '/memories?uri=home%3A%2F%2Fdoor'))
      expect(got).toMatchObject({ content: null, contentHidden: true })

      await remember({ uri: 'home://door/child', content: '子节点' })
      const children = ConsoleMemoryChildren.parse(
        await ok(await send('GET', '/memories/children?of=home%3A%2F%2Fdoor')),
      )
      expect(children.parent).toMatchObject({ content: null, contentHidden: true })

      const edited = await view(
        await send('PATCH', '/memories', { uri: created.uri, disclosure: '二' }),
      )
      expect(edited).toMatchObject({ content: null, contentHidden: true, disclosure: '二' })
      // 带了新正文也不回显
      const rewritten = await view(
        await send('PATCH', '/memories', { uri: created.uri, content: `${BODY}！` }),
      )
      expect(rewritten).toMatchObject({ content: null, contentHidden: true })

      const moved = await view(
        await send('POST', '/memories/move', { from: created.uri, to: 'home://gate' }),
      )
      expect(moved).toMatchObject({ content: null, contentHidden: true, uri: 'home://gate' })

      const events = (await historyOf(created.id)).events
      const restored = await view(
        await send('POST', '/memories/restore', {
          memoryId: created.id,
          eventId: events[0]!.id,
          expectedVersion: moved.version,
        }),
      )
      expect(restored).toMatchObject({ content: null, contentHidden: true, disclosure: '一' })

      expect((await send('DELETE', '/memories?uri=home%3A%2F%2Fgate')).status).toBe(204)
      const back = await view(await send('POST', '/memories/undelete', { memoryId: created.id }))
      expect(back).toMatchObject({ content: null, contentHidden: true })

      await inSpace((tx) =>
        tx
          .update(memories)
          .set({ validTo: new Date(Date.now() - 1000) })
          .where(eq(memories.id, created.id)),
      )
      const revived = await view(
        await send('POST', '/memories/reactivate', {
          memoryId: created.id,
          expectedVersion: back.version,
        }),
      )
      expect(revived).toMatchObject({ content: null, contentHidden: true })

      expect(await accessOf(created.id)).toEqual([])
    })

    it('显式查看：给正文，不让缓存，记一条访问；历史里看得到谁、什么时候、经由哪里', async () => {
      const m = await secret()
      const res = await reveal(m.id)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await view(res)).toMatchObject({
        id: m.id,
        content: BODY,
        contentHidden: false,
        version: m.version,
      })
      // 查看不改记忆
      const [row] = await inSpace((tx) => tx.select().from(memories).where(eq(memories.id, m.id)))
      expect(row).toMatchObject({ version: m.version, content: null })

      const access = (await historyOf(m.id)).events.at(-1)!
      expect(access).toMatchObject({
        type: 'access',
        via: 'console',
        actor: { accountName: 'alice', keyName: null, appName: null },
        after: null,
        left: false,
      })
      expect(access.before).toMatchObject({ content: null, sensitivity: 'secret', uri: m.uri })
      expect(Date.parse(access.createdAt)).toBeGreaterThan(0)
      // 事件里没有正文
      expect(JSON.stringify(await accessOf(m.id))).not.toContain(BODY)

      await reveal(m.id)
      expect(await viaOf(m.id)).toEqual(['console', 'console'])
    })

    it('访问事件不进变更记录，概览的最近改动也没有；也不是能恢复的版本', async () => {
      const m = await secret()
      await view(await reveal(m.id))
      const activity = await ok<ActivityList>(await send('GET', '/activity'))
      expect(activity.items.map((i) => i.type)).toEqual(['create'])
      const overview = await ok<SpaceOverview>(await send('GET', '/overview'))
      expect(overview.recent.map((i) => i.type)).toEqual(['create'])
      const access = (await historyOf(m.id)).events.at(-1)!
      const res = await send('POST', '/memories/restore', {
        memoryId: m.id,
        eventId: access.id,
        expectedVersion: m.version,
      })
      expect(res.status).toBe(404)
    })

    it('别的敏感级的正文本来就给，查看不记', async () => {
      const m = await remember({ uri: 'home://plain', content: '普通的正文' })
      expect(m).toMatchObject({ content: '普通的正文', contentHidden: false })
      expect(await view(await reveal(m.id))).toMatchObject({ content: '普通的正文' })
      expect(await accessOf(m.id)).toEqual([])
    })

    it('读不到的和不存在一样是 404，不留记录', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      const viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
      const shared = await secret('kb://door', { layer: 'base' })
      const mine = await secret()
      expect((await reveal(shared.id, editor.cookie)).status).toBe(404)
      expect((await reveal(shared.id, viewer.cookie)).status).toBe(404)
      expect((await reveal(mine.id, editor.cookie)).status).toBe(404)
      expect((await reveal('00000000-0000-4000-8000-000000000000')).status).toBe(404)
      // 空间 owner 也读不到别的成员私人层里的
      const other = await addMember(database.db, ws.spaceId, 'bob', 'owner')
      expect((await reveal(mine.id, other.cookie)).status).toBe(404)
      expect((await historyOf(shared.id, ws.cookie)).events.map((e) => e.type)).toEqual(['create'])
      // 删掉、过期的读不到，这里也不给
      expect((await send('DELETE', '/memories?uri=home%3A%2F%2Fdoor')).status).toBe(204)
      expect((await reveal(mine.id)).status).toBe(404)
    })

    it('访问记录只给读得到这条机密的人：另一个空间 owner 看得到；降级之后 editor 读得到记忆，也看不到之前的访问记录', async () => {
      const other = await addMember(database.db, ws.spaceId, 'bob', 'owner')
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      const m = await secret('kb://door', { layer: 'base' })
      await view(await reveal(m.id))
      expect((await historyOf(m.id, other.cookie)).events.map((e) => e.type)).toContain('access')
      expect(
        (await send('GET', `/memories/history?id=${m.id}`, undefined, editor.cookie)).status,
      ).toBe(404)

      await view(await send('PATCH', '/memories', { uri: m.uri, sensitivity: 'private' }))
      const seen = await historyOf(m.id, editor.cookie)
      expect(seen.events.map((e) => e.type)).not.toContain('access')
      expect((await historyOf(m.id)).events.map((e) => e.type)).toContain('access')
    })

    it('没配主密钥时查看报错，不留记录', async () => {
      const m = await secret()
      const locked = createApp({
        db: database.db,
        cookieSecure: false,
        masterKey: null,
        embedder: staticEmbedderSource(null),
        jobs: null,
      })
      const res = await locked.request(
        `/v1/spaces/${ws.spaceId}/memories/reveal`,
        jsonRequest('POST', { memoryId: m.id }, { cookie: ws.cookie }),
      )
      expect(res.status).toBe(400)
      expect(await accessOf(m.id)).toEqual([])
    })
  })

  describe('Key', () => {
    it('REST 按 URI 读取：响应不变，记一条访问，看得到是哪个 Key、经由 REST', async () => {
      const m = await secret()
      const res = await keyGet(m.uri)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.content).toBe(BODY)
      // 响应就是接入方的 MemoryView，没有管理界面的字段
      expect(MemoryView.strict().safeParse(body).success).toBe(true)
      expect(await viaOf(m.id)).toEqual(['rest'])
      const access = (await historyOf(m.id)).events.at(-1)!
      expect(access).toMatchObject({
        type: 'access',
        via: 'rest',
        actor: { accountName: null, keyName: 'test', appName: 'agent' },
      })
      const [row] = await accessOf(m.id)
      expect(row!.actorKeyId).not.toBeNull()
    })

    it('kioku_get 记经由 kioku_get；kioku_list 列父节点时带着正文也算', async () => {
      const m = await secret()
      expect(await mcp('kioku_get', { uri: m.uri })).toContain(BODY)
      expect(await viaOf(m.id)).toEqual(['kioku_get'])
      expect(await mcp('kioku_list', { of: m.uri })).toContain(BODY)
      expect(await viaOf(m.id)).toEqual(['kioku_get', 'kioku_list'])
      // 只列 domain 不读正文
      await mcp('kioku_list', { of: 'home' })
      expect((await viaOf(m.id)).length).toBe(2)
    })

    it('REST 列子节点时父节点带着正文也算', async () => {
      const m = await secret()
      const res = await app.request(`/v1/memories/children?of=${encodeURIComponent(m.uri)}`, {
        headers: bearer(key),
      })
      expect(((await res.json()) as { parent: MemoryView }).parent.content).toBe(BODY)
      expect(await viaOf(m.id)).toEqual(['rest'])
    })

    it('写入的响应带着解出来的原文也算：改别的字段、移动；自己刚写的正文不算', async () => {
      const m = await secret()
      const edited = await keyCall('PATCH', '/memories', { uri: m.uri, priority: 3 })
      expect(((await edited.json()) as MemoryView).content).toBe(BODY)
      expect(await viaOf(m.id)).toEqual(['rest'])

      const moved = await keyCall('POST', '/memories/move', { from: m.uri, to: 'home://gate' })
      expect(((await moved.json()) as MemoryView).content).toBe(BODY)
      expect(await viaOf(m.id)).toEqual(['rest', 'rest'])

      expect(await mcp('kioku_update', { uri: 'home://gate', priority: 4 })).toContain(BODY)
      expect(await mcp('kioku_move', { from: 'home://gate', to: 'home://door' })).toContain(BODY)
      expect(await viaOf(m.id)).toEqual(['rest', 'rest', 'kioku_update', 'kioku_move'])

      const rewritten = await keyCall('PATCH', '/memories', { uri: 'home://door', content: '新的' })
      expect(((await rewritten.json()) as MemoryView).content).toBe('新的')
      const created = await keyCall('POST', '/memories', {
        uri: 'home://new',
        content: '自己写的',
        sensitivity: 'secret',
      })
      const fresh = (await created.json()) as MemoryView
      expect(fresh.content).toBe('自己写的')
      expect((await viaOf(m.id)).length).toBe(4)
      expect(await viaOf(fresh.id)).toEqual([])
    })

    it('普通记忆不记；读不到的不记', async () => {
      const plain = await remember({ uri: 'home://plain', content: '普通的正文' })
      await keyGet(plain.uri)
      expect(await accessOf(plain.id)).toEqual([])

      const m = await secret()
      const app2 = await ws.createApp('plain')
      const privateKey = await ws.issueKey(app2.id, { ...FULL_SCOPES, maxSensitivity: 'private' })
      expect((await keyGet(m.uri, privateKey)).status).toBe(404)
      expect(await accessOf(m.id)).toEqual([])
    })

    it('改成 secret 那一次的响应是原来的明文，不算读到机密', async () => {
      const plain = await remember({ uri: 'home://plain', content: '普通的正文' })
      const res = await keyCall('PATCH', '/memories', { uri: plain.uri, sensitivity: 'secret' })
      expect(((await res.json()) as MemoryView).content).toBe('普通的正文')
      expect(await accessOf(plain.id)).toEqual([])
    })
  })

  describe('写入检查的报错不带解出来的内容', () => {
    // 规则之前写下的旧数据：直接写密文，接口现在不收这样的正文
    const legacy = async (m: { id: string }, body: string, extra = {}) => {
      const sealed = sealMemoryContent(masterKey, m.id, body)
      await inSpace((tx) =>
        tx
          .update(memories)
          .set({ ...sealed, ...extra })
          .where(eq(memories.id, m.id)),
      )
    }
    const errorOf = async (res: Response, status = 400) => {
      expect(res.status).toBe(status)
      return ((await res.json()) as { error: string }).error
    }
    const FRAGMENT = '旧数据 {{cred:坏的片段'

    it('只改优先级：格式不对的片段不进报错，管理界面、REST 与 MCP 都一样，也不留访问记录', async () => {
      const m = await secret()
      await legacy(m, FRAGMENT)
      const fromConsole = await errorOf(
        await send('PATCH', '/memories', { uri: m.uri, priority: 3 }),
      )
      expect(fromConsole).toContain('占位符格式不对')
      expect(fromConsole).not.toContain('坏的片段')
      const fromKey = await errorOf(
        await keyCall('PATCH', '/memories', { uri: m.uri, priority: 3 }),
      )
      expect(fromKey).toContain('占位符格式不对')
      expect(fromKey).not.toContain('坏的片段')
      const fromTool = await mcp('kioku_update', { uri: m.uri, priority: 3 })
      expect(fromTool).toContain('占位符格式不对')
      expect(fromTool).not.toContain('坏的片段')
      expect(await accessOf(m.id)).toEqual([])
    })

    it('降级：查的是解出来的原文，同样不带', async () => {
      const m = await secret()
      await legacy(m, FRAGMENT)
      const error = await errorOf(
        await send('PATCH', '/memories', { uri: m.uri, sensitivity: 'private' }),
      )
      expect(error).not.toContain('坏的片段')
    })

    it('改层与移动：解出来的标识、字段名不进报错', async () => {
      const m = await secret('home://owned', { layer: 'owner' })
      await legacy(m, '旧数据 {{cred:missing-cred}}')
      const relayered = await errorOf(
        await send('PATCH', '/memories', { uri: m.uri, layer: 'private' }),
      )
      expect(relayered).toContain('不存在或不可用')
      expect(relayered).not.toContain('missing-cred')
      const moved = await errorOf(
        await send('POST', '/memories/move', { from: m.uri, to: 'home://moved', layer: 'private' }),
      )
      expect(moved).toContain('不存在或不可用')
      expect(moved).not.toContain('missing-cred')

      const credential = await send('POST', '/credentials', {
        identifier: 'nas',
        name: 'NAS',
        source: { kind: 'hosted', values: { password: 'nas-pass' } },
      })
      expect(credential.status).toBe(201)
      await legacy(m, '旧数据 {{cred:nas#missing-field}}')
      const field = await errorOf(
        await send('POST', '/memories/move', { from: m.uri, to: 'home://moved', layer: 'private' }),
      )
      expect(field).toContain('没有这个字段')
      expect(field).not.toContain('missing-field')
      expect(field).not.toContain('nas')
      expect(await accessOf(m.id)).toEqual([])
    })

    it('撤销删除：同样不带', async () => {
      const m = await secret('home://owned', { layer: 'owner' })
      await legacy(m, FRAGMENT)
      expect((await send('DELETE', `/memories?uri=${encodeURIComponent(m.uri)}`)).status).toBe(204)
      const error = await errorOf(await send('POST', '/memories/undelete', { memoryId: m.id }))
      expect(error).toContain('占位符格式不对')
      expect(error).not.toContain('坏的片段')
    })

    it('调用方这次写的正文照常报出片段：它本来就知道；普通记忆也一样', async () => {
      const m = await secret()
      const own = await errorOf(await send('PATCH', '/memories', { uri: m.uri, content: FRAGMENT }))
      expect(own).toContain('坏的片段')
      const plain = await errorOf(
        await send('POST', '/memories', { uri: 'home://plain', content: '{{cred:missing-cred}}' }),
      )
      expect(plain).toContain('missing-cred')
    })
  })

  describe('内部路径不受影响', () => {
    it('管理界面只改别的字段时正文原样封存，降级时照常解开，都不记访问', async () => {
      const m = await secret()
      const edited = await view(await send('PATCH', '/memories', { uri: m.uri, priority: 7 }))
      expect(await accessOf(m.id)).toEqual([])
      expect((await keyGet(m.uri)).status).toBe(200)
      const [{ content }] = [(await view(await reveal(m.id))) as { content: string | null }]
      expect(content).toBe(BODY)

      const lowered = await view(
        await send('PATCH', '/memories', { uri: m.uri, sensitivity: 'private' }),
      )
      expect(lowered).toMatchObject({ content: BODY, contentHidden: false, sensitivity: 'private' })
      expect(edited.version).toBeLessThan(lowered.version)
    })

    it('导入工具比对正文用的内部服务照常解密，不记访问', async () => {
      const m = await secret()
      const internal = new MemoryService({
        db: database.db,
        spaceId: ws.spaceId,
        access: { ...consoleAccess('owner', ws.accountId), writeProvenance: 'system' },
        personaId: 'all',
        masterKey,
        actor: { accountId: ws.accountId },
      })
      const got = await internal.get(m.uri)
      expect(got.content).toBe(BODY)
      expect(got).not.toHaveProperty('contentHidden')
      expect(await accessOf(m.id)).toEqual([])
    })
  })

  it('访问记录再多也不把改动挤出历史：两边各算上限，合起来按时间排', async () => {
    const m = await secret()
    await view(await send('PATCH', '/memories', { uri: m.uri, priority: 3 }))
    await inSpace((tx) =>
      tx.execute(sql`
        insert into memory_events (space_id, memory_id, event_type, actor_account_id, provenance, before, context)
        select ${ws.spaceId}::uuid, ${m.id}::uuid, 'access', ${ws.accountId}::uuid, 'owner',
          jsonb_build_object('layer', 'private', 'sensitivity', 'secret', 'originScope', 'global',
            'ownerAccountId', ${ws.accountId}::text, 'domain', 'home', 'path', 'door'),
          jsonb_build_object('via', 'rest')
        from generate_series(1, 600)`),
    )
    const history = await historyOf(m.id)
    const types = history.events.map((e) => e.type)
    expect(types.filter((t) => t === 'access').length).toBe(100)
    expect(types.filter((t) => t !== 'access')).toEqual(['create', 'update'])
    expect(history.truncated).toBe(true)
    const ids = history.events.map((e) => e.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })
})
