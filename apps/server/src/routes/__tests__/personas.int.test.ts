import { randomBytes } from 'node:crypto'

import type { KeyAccessMatrix, KeyInfo, PersonaDetail, PersonaInfo } from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { personas, spaceMembers, spaces } from '../../db/schema'
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

describe.skipIf(!testDatabaseUrl)('人格、应用与 Key 的管理', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace

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
  })

  const as = (method: string, path: string, body: unknown = undefined, cookie = ws.cookie) =>
    app.request(
      `/v1/spaces/${ws.spaceId}${path}`,
      body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const createMemory = async (body: Record<string, unknown>) => {
    const res = await as('POST', '/memories', body)
    if (res.status !== 201) throw new Error(await res.text())
  }
  const deleteMemory = async (uri: string) => {
    const res = await as('DELETE', `/memories?uri=${encodeURIComponent(uri)}`)
    expect(res.status).toBe(204)
  }
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error

  describe('人格', () => {
    it('改名称、说明与继承，也能改成不继承；标识不变', async () => {
      const parent = await ws.createPersona('doubao')
      const child = await ws.createPersona('doubao-group')
      const res = await as('PATCH', `/personas/${child.id}`, {
        name: '豆包·群聊',
        description: '群里用的',
        extendsId: parent.id,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        slug: 'doubao-group',
        name: '豆包·群聊',
        description: '群里用的',
        extendsId: parent.id,
      })
      const cleared = await as('PATCH', `/personas/${child.id}`, { extendsId: null })
      expect(((await cleared.json()) as PersonaInfo).extendsId).toBeNull()
    })

    it('继承不能成环，被继承的人格要存在', async () => {
      const a = await ws.createPersona('a')
      const b = await ws.createPersona('b', a.id)
      const c = await ws.createPersona('c', b.id)
      for (const parent of [a.id, c.id]) {
        const res = await as('PATCH', `/personas/${a.id}`, { extendsId: parent })
        expect(res.status).toBe(400)
        expect(await errorOf(res)).toContain('成环')
      }
      const missing = await as('PATCH', `/personas/${a.id}`, {
        extendsId: '00000000-0000-4000-8000-000000000000',
      })
      expect(missing.status).toBe(404)
    })

    it('继承链最多 8 层：新建时按祖先算，改继承时连同继承它的人格一起算', async () => {
      let parent: string | undefined
      for (let i = 1; i <= 8; i++) parent = (await ws.createPersona(`p${i}`, parent)).id
      const ninth = await as('POST', '/personas', { slug: 'p9', name: 'p9', extendsId: parent })
      expect(ninth.status).toBe(400)

      // 两层的小树挂到第 7 层下面，最深的一条就是 9 层
      const root = await ws.createPersona('q1')
      await ws.createPersona('q2', root.id)
      const personas = (await (await as('GET', '/personas')).json()) as PersonaInfo[]
      const seventh = personas.find((p) => p.slug === 'p7')!.id
      const sixth = personas.find((p) => p.slug === 'p6')!.id
      expect((await as('PATCH', `/personas/${root.id}`, { extendsId: seventh })).status).toBe(400)
      expect((await as('PATCH', `/personas/${root.id}`, { extendsId: sixth })).status).toBe(200)
    })

    it('继承没变时不重新检查层数：上限之前建出的更深的链照样能改名', async () => {
      // 直接插一条 9 层的链，模拟加上上限之前建出来的数据
      let parent: string | null = null
      for (let i = 1; i <= 9; i++) {
        const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
          tx
            .insert(personas)
            .values({ spaceId: ws.spaceId, slug: `old${i}`, name: `old${i}`, extendsId: parent })
            .returning(),
        )
        parent = row!.id
      }
      const [deepest] = await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(personas).where(eq(personas.slug, 'old9')),
      )
      const res = await as('PATCH', `/personas/${deepest!.id}`, {
        name: '改个名',
        extendsId: deepest!.extendsId,
      })
      expect(res.status).toBe(200)
    })

    it('读出之后被并发删除的人格，修改返回 404 而不是 500', async () => {
      const persona = await ws.createPersona('doubao')
      const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
      let pending: Promise<Response> | undefined
      try {
        await side.begin(async (tx) => {
          await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
          await tx`select id from personas where id = ${persona.id} for update`
          const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [
            { pid: number },
          ]
          pending = Promise.resolve(as('PATCH', `/personas/${persona.id}`, { name: '改名' }))
          for (let i = 0; ; i++) {
            const [row] = await side<{ n: number }[]>`
              select count(*)::int as n from pg_stat_activity
              where ${pid}::int = any(pg_blocking_pids(pid))`
            if (row!.n > 0) break
            if (i >= 80) throw new Error('修改没有等在人格的行锁上')
            await new Promise((r) => setTimeout(r, 25))
          }
          await tx`delete from personas where id = ${persona.id}`
        })
        expect((await pending!).status).toBe(404)
      } finally {
        // 用例中途失败时也等发出的请求结束，免得它和下一个用例的清库交错
        await pending?.catch(() => {})
        await side.end()
      }
    })

    it('viewer 不能改、不能删', async () => {
      const persona = await ws.createPersona('doubao')
      const viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
      expect(
        (await as('PATCH', `/personas/${persona.id}`, { name: '改名' }, viewer.cookie)).status,
      ).toBe(403)
      expect((await as('DELETE', `/personas/${persona.id}`, undefined, viewer.cookie)).status).toBe(
        403,
      )
    })

    it('有应用在用、被别的人格继承、或还有人格层记忆（含已删除的）时删不掉', async () => {
      const used = await ws.createPersona('used')
      await ws.createApp('bot', { defaultPersonaId: used.id })
      const inherited = await ws.createPersona('inherited')
      await ws.createPersona('heir', inherited.id)
      const remembered = await ws.createPersona('remembered')
      await createMemory({ uri: 'persona://remembered/soul', content: '设定' })
      await deleteMemory('persona://remembered/soul')

      for (const [persona, reason] of [
        [used, '应用'],
        [inherited, '继承'],
        [remembered, '人格层记忆'],
      ] as const) {
        const res = await as('DELETE', `/personas/${persona.id}`)
        expect(res.status).toBe(409)
        expect(await errorOf(res)).toContain(reason)
      }

      const free = await ws.createPersona('free')
      expect((await as('DELETE', `/personas/${free.id}`)).status).toBe(204)
      const left = (await (await as('GET', '/personas')).json()) as PersonaInfo[]
      expect(left.map((p) => p.slug)).not.toContain('free')
      expect((await as('DELETE', `/personas/${free.id}`)).status).toBe(404)
    })

    it('详情列出继承链、自己的与继承来的节点（标出被谁覆盖）、用它的应用与记忆总数', async () => {
      const root = await ws.createPersona('doubao')
      const mid = await ws.createPersona('doubao-group', root.id)
      const leaf = await ws.createPersona('doubao-night', mid.id)
      const sibling = await ws.createPersona('doubao-quiet', mid.id)
      const bot = await ws.createApp('night-bot', { defaultPersonaId: leaf.id })
      await createMemory({ uri: 'persona://doubao/soul', content: '主人格', priority: 0 })
      await createMemory({ uri: 'persona://doubao/tone', content: '主人格的口吻', priority: 0 })
      await createMemory({ uri: 'persona://doubao-group/soul', content: '群聊版', priority: 0 })
      await createMemory({ uri: 'persona://doubao-night/tone', content: '夜间版口吻', priority: 1 })
      await createMemory({ uri: 'persona://doubao-night/old', content: '删掉的' })
      await deleteMemory('persona://doubao-night/old')

      const res = await as('GET', `/personas/${leaf.id}`)
      expect(res.status).toBe(200)
      const detail = (await res.json()) as PersonaDetail
      expect(detail.ancestors.map((p) => p.slug)).toEqual(['doubao-group', 'doubao'])
      expect(detail.children).toEqual([])
      expect(detail.apps).toEqual([{ id: bot.id, slug: 'night-bot', name: 'night-bot' }])
      expect(detail.storedMemories).toBe(2)
      expect(detail.own.map((n) => [n.uri, n.overriddenBy])).toEqual([
        ['persona://doubao-night/tone', null],
      ])
      expect(detail.inherited.map((n) => [n.uri, n.overriddenBy])).toEqual([
        ['persona://doubao-group/soul', null],
        ['persona://doubao/soul', 'persona://doubao-group/soul'],
        ['persona://doubao/tone', 'persona://doubao-night/tone'],
      ])

      const middle = (await (await as('GET', `/personas/${mid.id}`)).json()) as PersonaDetail
      expect(middle.children.map((p) => p.id).sort()).toEqual([leaf.id, sibling.id].sort())
    })

    it('详情里的节点按查看者的读权限算：editor 看不到 secret 节点', async () => {
      const persona = await ws.createPersona('doubao')
      await createMemory({ uri: 'persona://doubao/soul', content: '设定' })
      await createMemory({ uri: 'persona://doubao/vault', content: '机密', sensitivity: 'secret' })
      const ownerView = (await (await as('GET', `/personas/${persona.id}`)).json()) as PersonaDetail
      expect(ownerView.own.map((n) => n.uri)).toEqual([
        'persona://doubao/soul',
        'persona://doubao/vault',
      ])
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      const editorView = (await (
        await as('GET', `/personas/${persona.id}`, undefined, editor.cookie)
      ).json()) as PersonaDetail
      expect(editorView.own.map((n) => n.uri)).toEqual(['persona://doubao/soul'])
      expect(editorView.storedMemories).toBe(1)
      expect(ownerView.storedMemories).toBe(2)
    })

    it('删除被挡住时不说有几条记忆：里面可能有查看者读不到的 secret', async () => {
      const persona = await ws.createPersona('doubao')
      await createMemory({ uri: 'persona://doubao/vault', content: '机密', sensitivity: 'secret' })
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      const res = await as('DELETE', `/personas/${persona.id}`, undefined, editor.cookie)
      expect(res.status).toBe(409)
      const error = await errorOf(res)
      expect(error).toContain('人格层记忆')
      expect(error).not.toMatch(/\d/)
    })
  })

  describe('应用', () => {
    it('还有应用层记忆（含已删除的）时删不掉；删掉之后它的 Key 失效', async () => {
      const bot = await ws.createApp('bot')
      const key = await ws.issueKey(bot.id)
      await createMemory({ uri: 'app://bot/rules', content: '群规' })
      await deleteMemory('app://bot/rules')
      const blocked = await as('DELETE', `/apps/${bot.id}`)
      expect(blocked.status).toBe(409)
      const error = await errorOf(blocked)
      expect(error).toContain('应用层记忆')
      expect(error).not.toMatch(/\d/)

      const other = await ws.createApp('other')
      const otherKey = await ws.issueKey(other.id)
      expect((await app.request('/v1/whoami', { headers: bearer(otherKey) })).status).toBe(200)
      expect((await as('DELETE', `/apps/${other.id}`)).status).toBe(204)
      expect((await app.request('/v1/whoami', { headers: bearer(otherKey) })).status).toBe(401)
      expect((await app.request('/v1/whoami', { headers: bearer(key) })).status).toBe(200)
      expect((await as('DELETE', `/apps/${other.id}`)).status).toBe(404)
    })

    it('editor 不能删别人的应用，空间 owner 能删成员的应用', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      const mine = await ws.createApp('mine')
      expect((await as('DELETE', `/apps/${mine.id}`, undefined, editor.cookie)).status).toBe(403)
      const created = await as(
        'POST',
        '/apps',
        { slug: 'eve-bot', name: 'eve-bot', runtimeFamily: 'mcp' },
        editor.cookie,
      )
      const eveBot = (await created.json()) as { id: string }
      expect((await as('DELETE', `/apps/${eveBot.id}`)).status).toBe(204)
    })
  })

  it('成员列表给出名字与角色，只给本空间的成员看', async () => {
    await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const res = await as('GET', '/members')
    expect(res.status).toBe(200)
    expect(
      ((await res.json()) as { username: string; role: string }[]).map((m) => [m.username, m.role]),
    ).toEqual([
      ['alice', 'owner'],
      ['eve', 'editor'],
    ])
    // 别的空间的成员看不到
    const [other] = await database.db.insert(spaces).values({ name: '别处' }).returning()
    const stranger = await addMember(database.db, other!.id, 'oscar', 'owner')
    expect((await as('GET', '/members', undefined, stranger.cookie)).status).toBe(403)
  })

  describe('Key', () => {
    const keysOf = async (appId: string, cookie = ws.cookie) =>
      (await (await as('GET', `/apps/${appId}/keys`, undefined, cookie)).json()) as KeyInfo[]

    it('列表给出当前有效上限：主人被降级时收紧，吊销或主人离开空间后为空', async () => {
      const bot = await ws.createApp('bot')
      const revoked = await ws.issueKey(bot.id)
      const admin = await ws.issueKey(bot.id, { ...FULL_SCOPES, admin: true })
      const issued = (await keysOf(bot.id)).find((k) => admin.startsWith(`kioku_${k.prefix}_`))!
      expect(issued.effectiveScopes).toEqual(issued.scopes)

      await addMember(database.db, ws.spaceId, 'olga', 'owner')
      await database.db
        .update(spaceMembers)
        .set({ role: 'editor' })
        .where(and(eq(spaceMembers.spaceId, ws.spaceId), eq(spaceMembers.accountId, ws.accountId)))
      const clamped = (await keysOf(bot.id)).find((k) => k.id === issued.id)!
      expect(clamped.scopes).toMatchObject({ maxSensitivity: 'secret', admin: true })
      expect(clamped.effectiveScopes).toMatchObject({ maxSensitivity: 'private', admin: false })

      // 被降级的主人仍能吊销自己应用的 Key
      const revoke = (await keysOf(bot.id)).find((k) => revoked.startsWith(`kioku_${k.prefix}_`))!
      expect((await as('DELETE', `/apps/${bot.id}/keys/${revoke.id}`)).status).toBe(204)
      const afterRevoke = (await keysOf(bot.id)).find((k) => k.id === revoke.id)!
      expect(afterRevoke.effectiveScopes).toBeNull()

      const olga = await addMember(database.db, ws.spaceId, 'olga2', 'owner')
      await database.db
        .delete(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, ws.spaceId), eq(spaceMembers.accountId, ws.accountId)))
      for (const key of await keysOf(bot.id, olga.cookie)) expect(key.effectiveScopes).toBeNull()
    })

    it('权限矩阵按会话上下文给出每层每级能不能读写', async () => {
      const persona = await ws.createPersona('doubao')
      const bot = await ws.createApp('bot', {
        defaultPersonaId: persona.id,
        config: { elevateOwnerDirect: 'internal' },
      })
      await ws.issueKey(bot.id)
      const [key] = await keysOf(bot.id)
      const res = await as('GET', `/apps/${bot.id}/keys/${key!.id}/matrix`)
      expect(res.status).toBe(200)
      const { contexts } = (await res.json()) as KeyAccessMatrix
      const cell = (context: string, layer: string, sensitivity: string) =>
        contexts
          .find((c) => c.context === context)!
          .rows.find((r) => r.layer === layer)!
          .cells.find((c) => c.sensitivity === sensitivity)!

      expect(contexts.map((c) => [c.context, c.originScope])).toEqual([
        ['none', 'any'],
        ['direct', 'direct'],
        ['owner_direct', 'direct'],
        ['group', 'group'],
        ['cron', 'app'],
      ])
      expect(cell('none', 'private', 'private')).toMatchObject({ read: 'recall', write: true })
      expect(cell('none', 'private', 'secret')).toMatchObject({ read: 'explicit', write: true })
      expect(cell('none', 'persona', 'public')).toMatchObject({ read: 'recall', write: true })
      expect(cell('group', 'private', 'public')).toMatchObject({ read: 'none', write: false })
      expect(cell('group', 'base', 'public')).toMatchObject({ read: 'recall', write: false })
      expect(cell('group', 'base', 'internal').read).toBe('none')
      expect(cell('group', 'subject', 'public')).toMatchObject({ read: 'recall', write: true })
      expect(cell('direct', 'owner', 'public').read).toBe('none')
      expect(cell('owner_direct', 'owner', 'internal').read).toBe('recall')
      expect(cell('cron', 'base', 'internal')).toMatchObject({ read: 'recall', write: true })
      expect(cell('cron', 'owner', 'public').read).toBe('none')
    })

    it('矩阵只给应用主人与空间 owner；作废的 Key 返回 404', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      const bot = await ws.createApp('bot')
      await ws.issueKey(bot.id)
      const [key] = await keysOf(bot.id)
      const path = `/apps/${bot.id}/keys/${key!.id}/matrix`
      expect((await as('GET', path, undefined, editor.cookie)).status).toBe(403)
      // 不是主人时，不存在的 Key 也是 403：探不出 Key 在不在
      const made = `/apps/${bot.id}/keys/00000000-0000-4000-8000-000000000000/matrix`
      expect((await as('GET', made, undefined, editor.cookie)).status).toBe(403)
      expect(await errorOf(await as('GET', made))).toBe('Key 不存在')
      const noApp = `/apps/00000000-0000-4000-8000-000000000000/keys/${key!.id}/matrix`
      expect(await errorOf(await as('GET', noApp))).toBe('应用不存在')
      expect((await as('DELETE', `/apps/${bot.id}/keys/${key!.id}`)).status).toBe(204)
      expect((await as('GET', path)).status).toBe(404)
    })
  })
})
