import { randomBytes } from 'node:crypto'

import {
  ConsoleEntryView,
  EntryView,
  type ActivityList,
  type CircleOverview,
  type EntryHistory,
} from '@kioku/contracts'
import { and, asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { consoleAccess } from '../../access/access'
import { createApp } from '../../app'
import { withCircle, type Database, type Tx } from '../../db/client'
import { entries, entryEvents, entryVariants } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { EntryService, sealVariantContent } from '../../memory/service'
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
  let personalKey: string
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
    key = await ws.issueKey((await ws.createClient('agent')).id)
    const pClientRes = await app.request(
      `/v1/circles/${ws.personalCircleId}/clients`,
      jsonRequest(
        'POST',
        { slug: 'p-agent', name: 'p-agent', runtimeFamily: 'mcp' },
        { cookie: ws.cookie },
      ),
    )
    expect(pClientRes.status).toBe(201)
    const pClient = (await pClientRes.json()) as { id: string }
    const pKeyRes = await app.request(
      `/v1/circles/${ws.personalCircleId}/clients/${pClient.id}/keys`,
      jsonRequest('POST', { name: 'pk', scopes: FULL_SCOPES }, { cookie: ws.cookie }),
    )
    expect(pKeyRes.status).toBe(201)
    personalKey = ((await pKeyRes.json()) as { key: string }).key
  })

  const inCircle = <T>(circleId: string, fn: (tx: Tx) => Promise<T>) =>
    withCircle(database.db, circleId, fn)
  const send = (
    method: string,
    path: string,
    body?: unknown,
    cookie = ws.cookie,
    circleId = ws.circleId,
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
  const view = async (res: Response, status = 200) => ConsoleEntryView.parse(await ok(res, status))
  const remember = async (
    body: Record<string, unknown>,
    cookie = ws.cookie,
    circleId = ws.circleId,
  ) => view(await send('POST', '/entries', body, cookie, circleId), 201)
  const secret = (title = '门禁码', extra: Record<string, unknown> = {}, circleId = ws.circleId) =>
    remember({ title, content: BODY, sensitivity: 'secret', ...extra }, ws.cookie, circleId)
  const reveal = (entryId: string, cookie = ws.cookie, circleId = ws.circleId) =>
    send('POST', '/entries/reveal', { entryId }, cookie, circleId)
  const accessOf = (entryId: string, circleId = ws.circleId) =>
    inCircle(circleId, (tx) =>
      tx
        .select()
        .from(entryEvents)
        .where(and(eq(entryEvents.entryId, entryId), eq(entryEvents.eventType, 'access')))
        .orderBy(asc(entryEvents.id)),
    )
  const viaOf = async (entryId: string, circleId = ws.circleId) =>
    (await accessOf(entryId, circleId)).map((e) => (e.context as { via: string }).via)
  const historyOf = async (id: string, cookie = ws.cookie, circleId = ws.circleId) =>
    ok<EntryHistory>(await send('GET', `/entries/history?id=${id}`, undefined, cookie, circleId))
  const keyGet = (id: string, withKey = key) =>
    app.request(`/v1/entries?id=${encodeURIComponent(id)}`, { headers: bearer(withKey) })
  const keyCall = (method: string, path: string, body: unknown, withKey = key) =>
    app.request(`/v1${path}`, jsonRequest(method, body, bearer(withKey)))
  let rpcId = 0
  const mcp = async (name: string, args: Record<string, unknown>, withKey = key) => {
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: {
        ...bearer(withKey),
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
      const created = await secret('door', { disclosure: '一' })
      expect(created).toMatchObject({ contentHidden: true })
      expect(created.variants[0]!.content).toBeNull()

      const got = await view(await send('GET', `/entries?id=${created.shortId}`))
      expect(got).toMatchObject({ contentHidden: true })
      expect(got.variants[0]!.content).toBeNull()

      const edited = await view(
        await send('PATCH', '/entries', { id: created.shortId, disclosure: '二' }),
      )
      expect(edited).toMatchObject({ contentHidden: true, disclosure: '二' })
      expect(edited.variants[0]!.content).toBeNull()
      // 带了新正文也不回显
      const rewritten = await view(
        await send('PATCH', '/entries', { id: created.shortId, content: `${BODY}！` }),
      )
      expect(rewritten).toMatchObject({ contentHidden: true })
      expect(rewritten.variants[0]!.content).toBeNull()

      const events = (await historyOf(created.id)).events
      const firstCreate = events.find((e) => e.type === 'create')!
      expect(
        (
          await send('POST', '/entries/restore', {
            entryId: created.id,
            eventId: firstCreate.id,
            expectedVersion: rewritten.version,
          })
        ).status,
      ).toBe(400)

      expect((await send('DELETE', `/entries?id=${created.shortId}`)).status).toBe(204)
      const back = await view(await send('POST', '/entries/undelete', { entryId: created.id }))
      expect(back).toMatchObject({ contentHidden: true })

      await inCircle(ws.circleId, (tx) =>
        tx
          .update(entries)
          .set({ validTo: new Date(Date.now() - 1000) })
          .where(eq(entries.id, created.id)),
      )
      const revived = await view(
        await send('POST', '/entries/reactivate', {
          entryId: created.id,
          expectedVersion: back.version,
        }),
      )
      expect(revived).toMatchObject({ contentHidden: true })

      expect(await accessOf(created.id)).toEqual([])
    })

    it('显式查看：给正文，不让缓存，记一条访问；历史里看得到谁、什么时候、经由哪里', async () => {
      const m = await secret()
      const res = await reveal(m.id)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const revealed = await view(res)
      expect(revealed).toMatchObject({
        id: m.id,
        contentHidden: false,
        version: m.version,
      })
      expect(revealed.variants[0]!.content).toBe(BODY)
      // 查看不改词条与加密列
      const [row] = await inCircle(ws.circleId, (tx) =>
        tx.select().from(entries).where(eq(entries.id, m.id)),
      )
      expect(row!.version).toBe(m.version)
      const [vRow] = await inCircle(ws.circleId, (tx) =>
        tx.select().from(entryVariants).where(eq(entryVariants.entryId, m.id)),
      )
      expect(vRow!.content).toBeNull()

      const access = (await historyOf(m.id)).events[0]!
      expect(access).toMatchObject({
        type: 'access',
        via: 'console',
        actor: { accountName: 'alice', keyName: null, clientName: null },
        before: null,
        after: null,
        left: false,
      })
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
      const overview = await ok<CircleOverview>(await send('GET', '/overview'))
      expect(overview.recent.map((i) => i.type)).toEqual(['create'])
      const access = (await historyOf(m.id)).events.find((e) => e.type === 'access')!
      const res = await send('POST', '/entries/restore', {
        entryId: m.id,
        eventId: access.id,
        expectedVersion: m.version,
      })
      expect(res.status).toBe(404)
    })

    it('别的敏感级的正文本来就给，查看不记', async () => {
      const m = await remember({ title: '普通', content: '普通的正文' })
      expect(m).toMatchObject({ contentHidden: false })
      expect(m.variants[0]!.content).toBe('普通的正文')
      expect((await view(await reveal(m.id))).variants[0]!.content).toBe('普通的正文')
      expect(await accessOf(m.id)).toEqual([])
    })

    it('读不到的和不存在一样是 404 或个人圈 403，不留记录', async () => {
      const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
      const viewer = await addMember(database.db, ws.circleId, 'vic', 'viewer')
      const shared = await secret('shared-secret', {}, ws.circleId)
      const mine = await secret('personal-secret', {}, ws.personalCircleId)
      expect((await reveal(shared.id, editor.cookie, ws.circleId)).status).toBe(404)
      expect((await reveal(shared.id, viewer.cookie, ws.circleId)).status).toBe(404)
      expect((await reveal(mine.id, editor.cookie, ws.personalCircleId)).status).toBe(403)
      expect((await reveal('00000000-0000-4000-8000-000000000000')).status).toBe(404)
      // 共享圈的另一个 owner 也看得到共享圈机密，但读不到别人的个人圈
      const other = await addMember(database.db, ws.circleId, 'bob', 'owner')
      expect((await reveal(mine.id, other.cookie, ws.personalCircleId)).status).toBe(403)
      expect((await historyOf(shared.id, ws.cookie)).events.map((e) => e.type)).toEqual(['create'])
      // 删掉的读不到，也不留访问记录
      expect((await send('DELETE', `/entries?id=${shared.shortId}`)).status).toBe(204)
      expect((await reveal(shared.id)).status).toBe(404)
      expect(await accessOf(shared.id)).toEqual([])
    })

    it('访问记录只给读得到这条机密的人：另一个 owner 看得到；降级之后 editor 读得到词条，也看不到之前的访问记录', async () => {
      const other = await addMember(database.db, ws.circleId, 'bob', 'owner')
      const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
      const m = await secret('shared-door')
      await view(await reveal(m.id))
      expect((await historyOf(m.id, other.cookie)).events.map((e) => e.type)).toContain('access')
      expect(
        (await send('GET', `/entries/history?id=${m.id}`, undefined, editor.cookie)).status,
      ).toBe(404)

      await view(await send('PATCH', '/entries', { id: m.shortId, sensitivity: 'private' }))
      const seen = await historyOf(m.id, editor.cookie)
      expect(seen.events.map((e) => e.type)).not.toContain('access')
      expect((await historyOf(m.id)).events.map((e) => e.type)).not.toContain('access')
      expect((await accessOf(m.id)).length).toBe(1)
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
        `/v1/circles/${ws.circleId}/entries/reveal`,
        jsonRequest('POST', { entryId: m.id }, { cookie: ws.cookie }),
      )
      expect(res.status).toBe(400)
      expect(await accessOf(m.id)).toEqual([])
    })
  })

  describe('Key', () => {
    it('REST 按短 ID 读取：响应不变，记一条访问，看得到是哪个 Key、经由 REST', async () => {
      const m = await secret()
      const res = await keyGet(m.shortId)
      const body = (await res.json()) as { variants: { content: string | null }[] }
      expect(body.variants[0]!.content).toBe(BODY)
      // 响应就是接入方的 EntryView，没有管理界面的字段
      expect(EntryView.strict().safeParse(body).success).toBe(true)
      expect(await viaOf(m.id)).toEqual(['rest'])
      const access = (await historyOf(m.id)).events[0]!
      expect(access).toMatchObject({
        type: 'access',
        via: 'rest',
        actor: { accountName: null, keyName: 'test', clientName: 'agent' },
      })
      const [row] = await accessOf(m.id)
      expect(row!.actorKeyId).not.toBeNull()
    })

    it('kioku_get 记经由 kioku_get；kioku_browse 不返回正文也不记访问', async () => {
      const m = await secret()
      expect(await mcp('kioku_get', { id: m.shortId })).toContain(BODY)
      expect(await viaOf(m.id)).toEqual(['kioku_get'])
      const browsed = await mcp('kioku_browse', { group_by: 'topic' })
      expect(browsed).not.toContain(BODY)
      expect(await viaOf(m.id)).toEqual(['kioku_get'])
    })

    it('写入的响应带着解出来的原文也算：改别的字段；自己刚写的正文与新建（maskSecret）不算', async () => {
      const m = await secret()
      const edited = await keyCall('PATCH', '/entries', { id: m.shortId, priority: 3 })
      expect(((await edited.json()) as EntryView).variants[0]!.content).toBe(BODY)
      expect(await viaOf(m.id)).toEqual(['rest'])

      expect(await mcp('kioku_update', { id: m.shortId, priority: 4 })).toContain(BODY)
      expect(await viaOf(m.id)).toEqual(['rest', 'kioku_update'])

      const rewritten = await keyCall('PATCH', '/entries', {
        id: m.shortId,
        content: '新的',
      })
      expect(((await rewritten.json()) as EntryView).variants[0]!.content).toBe('新的')
      const created = await keyCall('POST', '/entries', {
        title: '新建机密',
        content: '自己写的',
        sensitivity: 'secret',
      })
      const fresh = (await created.json()) as EntryView
      expect(fresh.variants[0]!.content).toBeNull()
      expect((await viaOf(m.id)).length).toBe(2)
      expect(await viaOf(fresh.id)).toEqual([])
    })

    it('普通记忆不记；读不到的不记', async () => {
      const plain = await remember({ title: '普通', content: '普通的正文' })
      await keyGet(plain.shortId)
      expect(await accessOf(plain.id)).toEqual([])

      const m = await secret()
      const client2 = await ws.createClient('plain')
      const privateKey = await ws.issueKey(client2.id, {
        ...FULL_SCOPES,
        maxSensitivity: 'private',
      })
      expect((await keyGet(m.shortId, privateKey)).status).toBe(404)
      expect(await accessOf(m.id)).toEqual([])
    })

    it('改成 secret 那一次的响应是原来的明文，不算读到机密', async () => {
      const plain = await remember({ title: '普通', content: '普通的正文' })
      const res = await keyCall('PATCH', '/entries', { id: plain.shortId, sensitivity: 'secret' })
      expect(((await res.json()) as EntryView).variants[0]!.content).toBe('普通的正文')
      expect(await accessOf(plain.id)).toEqual([])
    })
  })

  describe('写入检查的报错不带解出来的内容', () => {
    const legacy = async (
      m: { id: string; variants: { id: string }[] },
      body: string,
      circleId = ws.personalCircleId,
    ) => {
      const variantId = m.variants[0]!.id
      const sealed = sealVariantContent(masterKey, variantId, body)
      await inCircle(circleId, (tx) =>
        tx.update(entryVariants).set(sealed).where(eq(entryVariants.id, variantId)),
      )
    }
    const errorOf = async (res: Response, status = 400) => {
      expect(res.status).toBe(status)
      return ((await res.json()) as { error: string }).error
    }
    const FRAGMENT = '旧数据 {{cred:坏的片段'

    it('只改优先级：格式不对的片段不进报错，管理界面、REST 与 MCP 都一样，也不留访问记录', async () => {
      const m = await secret('p-secret', {}, ws.personalCircleId)
      await legacy(m, FRAGMENT)
      const fromConsole = await errorOf(
        await send(
          'PATCH',
          '/entries',
          { id: m.shortId, priority: 3 },
          ws.cookie,
          ws.personalCircleId,
        ),
      )
      expect(fromConsole).toContain('占位符格式错误')
      expect(fromConsole).not.toContain('坏的片段')
      const fromKey = await errorOf(
        await keyCall('PATCH', '/entries', { id: m.shortId, priority: 3 }, personalKey),
      )
      expect(fromKey).toContain('占位符格式错误')
      expect(fromKey).not.toContain('坏的片段')
      const fromTool = await mcp('kioku_update', { id: m.shortId, priority: 3 }, personalKey)
      expect(fromTool).toContain('占位符格式错误')
      expect(fromTool).not.toContain('坏的片段')
      expect(await accessOf(m.id, ws.personalCircleId)).toEqual([])
    })

    it('降级：查的是解出来的原文，同样不带', async () => {
      const m = await secret('p-secret', {}, ws.personalCircleId)
      await legacy(m, FRAGMENT)
      const error = await errorOf(
        await send(
          'PATCH',
          '/entries',
          { id: m.shortId, sensitivity: 'private' },
          ws.cookie,
          ws.personalCircleId,
        ),
      )
      expect(error).not.toContain('坏的片段')
    })

    it('跨圈迁入个人圈或降级：解出来的凭据标识、字段名不进报错', async () => {
      const m = await secret('shared-secret', {}, ws.circleId)
      await legacy(m, '旧数据 {{cred:missing-cred}}', ws.circleId)
      const missingErr = await errorOf(
        await send(
          'POST',
          '/entries/transfer',
          { entryId: m.id, toCircleId: ws.personalCircleId },
          ws.cookie,
          ws.circleId,
        ),
      )
      expect(missingErr).toContain('不存在或不可用')
      expect(missingErr).not.toContain('missing-cred')

      const credential = await send(
        'POST',
        '/credentials',
        {
          identifier: 'nas',
          name: 'NAS',
          source: { kind: 'new', values: { password: 'nas-pass' } },
        },
        ws.cookie,
        ws.personalCircleId,
      )
      expect(credential.status).toBe(201)
      await legacy(m, '旧数据 {{cred:nas#missing-field}}', ws.circleId)
      const fieldErr = await errorOf(
        await send(
          'POST',
          '/entries/transfer',
          { entryId: m.id, toCircleId: ws.personalCircleId },
          ws.cookie,
          ws.circleId,
        ),
      )
      expect(fieldErr).toContain('没有此字段')
      expect(fieldErr).not.toContain('missing-field')
      expect(fieldErr).not.toContain('nas')
      expect(await accessOf(m.id, ws.circleId)).toEqual([])
    })

    it('调用方这次写的正文照常报出片段：它本来就知道；普通词条也一样', async () => {
      const m = await secret('p-secret', {}, ws.personalCircleId)
      const own = await errorOf(
        await send(
          'PATCH',
          '/entries',
          { id: m.shortId, content: FRAGMENT },
          ws.cookie,
          ws.personalCircleId,
        ),
      )
      expect(own).toContain('坏的片段')
      const plain = await errorOf(
        await send(
          'POST',
          '/entries',
          {
            title: 'plain-err',
            content: '{{cred:missing-cred}}',
          },
          ws.cookie,
          ws.personalCircleId,
        ),
      )
      expect(plain).toContain('missing-cred')
    })
  })

  describe('内部路径不受影响', () => {
    it('管理界面只改别的字段时正文原样封存，降级时照常解开，都不记访问', async () => {
      const m = await secret()
      const edited = await view(await send('PATCH', '/entries', { id: m.shortId, priority: 7 }))
      expect(await accessOf(m.id)).toEqual([])
      expect((await keyGet(m.shortId)).status).toBe(200)
      const revealed = await view(await reveal(m.id))
      expect(revealed.variants[0]!.content).toBe(BODY)

      const lowered = await view(
        await send('PATCH', '/entries', { id: m.shortId, sensitivity: 'private' }),
      )
      expect(lowered).toMatchObject({ contentHidden: false, sensitivity: 'private' })
      expect(lowered.variants[0]!.content).toBe(BODY)
      expect(edited.version).toBeLessThan(lowered.version)
    })

    it('内部服务照常解密，不记访问', async () => {
      const m = await secret()
      const internal = new EntryService({
        db: database.db,
        access: {
          ...consoleAccess(ws.circleId, 'shared', 'owner', ws.accountId),
          writeProvenance: 'system',
        },
        masterKey,
        actor: { accountId: ws.accountId },
      })
      const got = await internal.get({ id: m.shortId }, 'rest')
      expect(got.variants[0]!.content).toBe(BODY)
      expect(got).not.toHaveProperty('contentHidden')
      expect(await accessOf(m.id)).toEqual([])
    })
  })

  it('访问记录再多也不把改动挤出历史：两边各算上限，合起来按时间排', async () => {
    const m = await secret()
    await view(await send('PATCH', '/entries', { id: m.shortId, priority: 3 }))
    await inCircle(ws.circleId, (tx) =>
      tx.execute(sql`
        insert into entry_events (circle_id, entry_id, short_id, event_type, actor_account_id, provenance, before, context)
        select ${ws.circleId}::uuid, ${m.id}::uuid, ${m.shortId}::text, 'access', ${ws.accountId}::uuid, 'owner',
          jsonb_build_object('circleId', ${ws.circleId}::text, 'kind', 'entry', 'sensitivity', 'secret',
            'originScope', 'global', 'shortId', ${m.shortId}::text),
          jsonb_build_object('via', 'rest')
        from generate_series(1, 600)`),
    )
    const history = await historyOf(m.id)
    const types = history.events.map((e) => e.type)
    expect(types.filter((t) => t === 'access').length).toBe(100)
    expect(types.filter((t) => t !== 'access')).toEqual(['update', 'create'])
    expect(history.truncated).toBe(true)
    const ids = history.events.map((e) => e.id)
    expect(ids).toEqual([...ids].sort((a, b) => b - a))
  })
})
