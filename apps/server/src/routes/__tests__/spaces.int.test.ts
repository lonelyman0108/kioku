import { randomBytes, randomUUID } from 'node:crypto'

import type {
  CreatedSpace,
  InstanceSpace,
  MemoryView,
  SpaceDetail,
  SpaceLimitView,
  SpaceMember,
} from '@kioku/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createSpace } from '../../access/spaces'
import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import {
  accounts,
  apiKeys,
  RLS_TABLES,
  settings,
  spaceDepartures,
  spaceMembers,
  spaces,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { dreamSpace } from '../../extraction/dream'
import { processSession } from '../../extraction/worker'
import { purgeExpired } from '../../jobs/retention'
import {
  openTestDatabase,
  resetDatabase,
  summaryConversation,
  testDatabaseUrl,
} from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('空间与成员', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  // alice：实例管理员，空间「家」的所有者
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
    if (!database) return
    await database.db.delete(settings).where(eq(settings.key, 'space-limit'))
    await database.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings).where(eq(settings.key, 'space-limit'))
    ws = await bootstrap(app)
  })

  const send = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(
      `/v1${path}`,
      body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (status === 204 ? undefined : await res.json()) as T
  }
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error
  const inSpace = (path = '') => `/spaces/${ws.spaceId}${path}`
  const membersOf = async (spaceId = ws.spaceId, cookie = ws.cookie) =>
    ok<SpaceMember[]>(await send('GET', `/spaces/${spaceId}/members`, cookie))
  const roles = async (spaceId = ws.spaceId) =>
    Object.fromEntries((await membersOf(spaceId)).map((m) => [m.username, m.role]))
  // 一个不在任何空间里的账号
  const loner = async (username: string) => {
    const [account] = await database.db
      .insert(accounts)
      .values({ username, displayName: username, passwordHash: 'x' })
      .returning()
    const { createSession } = await import('../../auth/session')
    return {
      accountId: account!.id,
      cookie: `kioku_session=${await createSession(database.db, account!.id)}`,
    }
  }

  describe('新建空间与空间数量上限', () => {
    const limitOf = async (cookie: string) =>
      ok<SpaceLimitView>(await send('GET', '/instance/space-limit', cookie))
    const setLimit = async (maxOwnedSpaces: number) =>
      ok<SpaceLimitView>(await send('PUT', '/instance/space-limit', ws.cookie, { maxOwnedSpaces }))
    const create = (cookie: string, name = '新的') => send('POST', '/spaces', cookie, { name })
    const ownedBy = async (accountId: string) =>
      (
        await database.db
          .select({ id: spaceMembers.spaceId })
          .from(spaceMembers)
          .where(and(eq(spaceMembers.accountId, accountId), eq(spaceMembers.role, 'owner')))
      ).length

    it('登录的账号都能新建，所有者是自己；实例管理员不能替别的账号建', async () => {
      const bob = await loner('bob')
      const mine = await ok<CreatedSpace>(
        await send('POST', '/spaces', ws.cookie, { name: '  工作  ' }),
        201,
      )
      expect(mine).toMatchObject({ name: '工作', ownerAccountId: ws.accountId })
      const bobs = await ok<CreatedSpace>(await create(bob.cookie, 'bob 的'), 201)
      expect(bobs.ownerAccountId).toBe(bob.accountId)
      expect((await membersOf(bobs.id, bob.cookie)).map((m) => [m.username, m.role])).toEqual([
        ['bob', 'owner'],
      ])
      // 请求里写别的账号不起作用：这个字段不在契约里，建出来的归当前账号
      const carol = await loner('carol')
      const forCarol = await ok<CreatedSpace>(
        await send('POST', '/spaces', ws.cookie, {
          name: '给 carol',
          ownerAccountId: carol.accountId,
        }),
        201,
      )
      expect(forCarol.ownerAccountId).toBe(ws.accountId)
      expect(await ownedBy(carol.accountId)).toBe(0)
      for (const name of ['', '   ', 'a'.repeat(65)]) {
        expect((await send('POST', '/spaces', ws.cookie, { name })).status).toBe(400)
      }
      expect((await app.request('/v1/spaces', jsonRequest('POST', { name: 'x' }))).status).toBe(401)
    })

    it('上限登录的账号都能读，只有实例管理员能改；默认 5 个，范围 1 到 100', async () => {
      const bob = await loner('bob')
      expect(await limitOf(bob.cookie)).toEqual({
        maxOwnedSpaces: 5,
        ownedSpaces: 0,
        canCreate: true,
      })
      expect(await limitOf(ws.cookie)).toEqual({
        maxOwnedSpaces: 5,
        ownedSpaces: 1,
        canCreate: true,
      })
      expect(
        (await send('PUT', '/instance/space-limit', bob.cookie, { maxOwnedSpaces: 9 })).status,
      ).toBe(403)
      for (const bad of [0, 101, 1.5, '3', null]) {
        expect(
          (await send('PUT', '/instance/space-limit', ws.cookie, { maxOwnedSpaces: bad })).status,
        ).toBe(400)
      }
      expect(await setLimit(1)).toEqual({ maxOwnedSpaces: 1, ownedSpaces: 1, canCreate: false })
      expect(await limitOf(bob.cookie)).toMatchObject({ maxOwnedSpaces: 1, canCreate: true })
      expect((await app.request('/v1/instance/space-limit')).status).toBe(401)
    })

    it('达到上限后不能再建，实例管理员自己也受限；调低之后已有的空间不动', async () => {
      const bob = await loner('bob')
      await setLimit(2)
      await ok(await create(bob.cookie, '一'), 201)
      await ok(await create(bob.cookie, '二'), 201)
      const third = await create(bob.cookie, '三')
      expect(third.status).toBe(409)
      expect(await errorOf(third)).toBe('已达空间数量上限：每个账号最多拥有 2 个空间')
      expect(await limitOf(bob.cookie)).toEqual({
        maxOwnedSpaces: 2,
        ownedSpaces: 2,
        canCreate: false,
      })
      // 管理员：自带的「家」算一个
      await ok(await create(ws.cookie, '管理员的第二个'), 201)
      expect((await create(ws.cookie, '管理员的第三个')).status).toBe(409)
      // 调低：已经超出的不动，只是不能再建
      await setLimit(1)
      expect(await ownedBy(bob.accountId)).toBe(2)
      expect((await create(bob.cookie, '三')).status).toBe(409)
      // 只算所有者：做别人空间的编辑者不占名额
      const carol = await loner('carol')
      await ok(
        await send('POST', inSpace('/members'), ws.cookie, { username: 'carol', role: 'editor' }),
        201,
      )
      await ok(await create(carol.cookie, 'carol 的'), 201)
    })

    it('同一个账号并发新建不会一起超限', async () => {
      const bob = await loner('bob')
      await setLimit(3)
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => create(bob.cookie, `并发 ${i}`)),
      )
      const statuses = results.map((r) => r.status).sort()
      expect(statuses).toEqual([201, 201, 201, 409, 409, 409, 409, 409])
      expect(await ownedBy(bob.accountId)).toBe(3)
    })

    it('接受转让、被加为或升为所有者也占名额，对方已达上限时 409，什么都不变', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      await setLimit(1)
      await ok(await create(bob.cookie, 'bob 的'), 201)
      const text = '对方拥有的空间已达上限（每个账号最多 1 个），不能再成为所有者'
      const promoted = await send('PATCH', inSpace(`/members/${bob.accountId}`), ws.cookie, {
        role: 'owner',
      })
      expect(promoted.status).toBe(409)
      expect(await errorOf(promoted)).toBe(text)
      const transferred = await send('POST', inSpace('/transfer-ownership'), ws.cookie, {
        accountId: bob.accountId,
      })
      expect(transferred.status).toBe(409)
      expect(await errorOf(transferred)).toBe(text)
      expect(await roles()).toEqual({ alice: 'owner', bob: 'editor' })
      // 直接加为所有者
      const carol = await loner('carol')
      await ok(await create(carol.cookie, 'carol 的'), 201)
      const added = await send('POST', inSpace('/members'), ws.cookie, {
        username: 'carol',
        role: 'owner',
      })
      expect(added.status).toBe(409)
      expect(await errorOf(added)).toBe(text)
      expect(await roles()).toEqual({ alice: 'owner', bob: 'editor' })
      // 名额够了就行；已经是所有者的再转让给他不多占
      await setLimit(2)
      await ok(
        await send('PATCH', inSpace(`/members/${bob.accountId}`), ws.cookie, { role: 'owner' }),
      )
      await ok(
        await send('POST', inSpace('/transfer-ownership'), ws.cookie, { accountId: bob.accountId }),
      )
      expect(await roles()).toEqual({ alice: 'editor', bob: 'owner' })
      expect(await ownedBy(bob.accountId)).toBe(2)
    })

    it('并发地新建与被升为所有者不会一起超限', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      await setLimit(1)
      const [created, promoted] = await Promise.all([
        create(bob.cookie, 'bob 的'),
        send('PATCH', inSpace(`/members/${bob.accountId}`), ws.cookie, { role: 'owner' }),
      ])
      expect([
        [201, 409],
        [409, 200],
      ]).toContainEqual([created.status, promoted.status])
      expect(await ownedBy(bob.accountId)).toBe(1)
    })

    it('管理员新建账号时自带的个人空间不受上限约束，但算一个名额', async () => {
      await setLimit(1)
      const res = await send('POST', '/instance/accounts', ws.cookie, {
        username: 'frank',
        displayName: 'Frank',
        isAdmin: false,
      })
      const created = await ok<{ account: { id: string } }>(res, 201)
      expect(await ownedBy(created.account.id)).toBe(1)
    })

    it('实例的空间列表只给实例管理员：名字、建立时间、所有者与成员数，没有内容数据', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
      await addMember(database.db, ws.spaceId, 'carol', 'viewer')
      const key = await ws.issueKey((await ws.createApp('bot')).id)
      expect(
        (
          await app.request(
            '/v1/memories',
            jsonRequest('POST', { uri: 'core://notes/x', content: '内容' }, bearer(key)),
          )
        ).status,
      ).toBe(201)
      expect((await send('GET', '/instance/spaces', bob.cookie)).status).toBe(403)
      const list = await ok<InstanceSpace[]>(await send('GET', '/instance/spaces', ws.cookie))
      expect(list).toEqual([
        {
          id: ws.spaceId,
          name: '家',
          createdAt: expect.any(String),
          owners: [
            { accountId: ws.accountId, username: 'alice', displayName: 'alice' },
            { accountId: bob.accountId, username: 'bob', displayName: 'bob' },
          ],
          memberCount: 3,
        },
      ])
    })
  })

  describe('空间概况、改名与删除', () => {
    it('概况成员都能看；改名只有空间所有者', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const outsider = await loner('eve')
      expect(await ok<SpaceDetail>(await send('GET', inSpace(), editor.cookie))).toEqual({
        id: ws.spaceId,
        name: '家',
        createdAt: expect.any(String),
        role: 'editor',
        memberCount: 2,
      })
      expect((await send('GET', inSpace(), outsider.cookie)).status).toBe(403)
      expect((await send('PATCH', inSpace(), editor.cookie, { name: '新家' })).status).toBe(403)
      expect((await send('PATCH', inSpace(), outsider.cookie, { name: '新家' })).status).toBe(403)
      expect((await send('PATCH', inSpace(), ws.cookie, { name: ' ' })).status).toBe(400)
      expect(
        await ok<{ name: string }>(await send('PATCH', inSpace(), ws.cookie, { name: '新家' })),
      ).toMatchObject({ name: '新家' })
      // 实例管理员不是成员时也不能改别人的空间名
      const other = await ok<CreatedSpace>(
        await send('POST', '/spaces', outsider.cookie, { name: 'eve 的' }),
        201,
      )
      expect((await send('PATCH', `/spaces/${other.id}`, ws.cookie, { name: '改' })).status).toBe(
        403,
      )
    })

    it('删除要带上现在的空间名；空间所有者或实例管理员能删，编辑者、查看者、别人不能', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const viewer = await addMember(database.db, ws.spaceId, 'carol', 'viewer')
      const outsider = await loner('eve')
      const remove = (cookie: string, confirmName: string, spaceId = ws.spaceId) =>
        send('DELETE', `/spaces/${spaceId}`, cookie, { confirmName })
      expect((await remove(editor.cookie, '家')).status).toBe(403)
      expect((await remove(viewer.cookie, '家')).status).toBe(403)
      expect((await remove(outsider.cookie, '家')).status).toBe(403)
      const mismatch = await remove(ws.cookie, '家 ')
      expect(mismatch.status).toBe(400)
      expect(await errorOf(mismatch)).toBe('空间名不一致')
      // 不存在的空间：别人看到的和不是成员一样，只有实例管理员看到 404
      expect((await remove(outsider.cookie, '家', randomUUID())).status).toBe(403)
      expect((await remove(ws.cookie, '家', randomUUID())).status).toBe(404)
      // 实例管理员不是成员也能删
      const eveSpace = await ok<CreatedSpace>(
        await send('POST', '/spaces', outsider.cookie, { name: 'eve 的' }),
        201,
      )
      await ok(await remove(ws.cookie, 'eve 的', eveSpace.id), 204)
      await ok(await remove(ws.cookie, '家'), 204)
      expect(await database.db.select().from(spaces)).toEqual([])
    })

    it('删除空间级联删掉整个空间的内容（RLS 下也删得干净），别的空间不动；后台任务遇到删掉的空间不报错', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
      const persona = await ws.createPersona('doubao')
      const bot = await ws.createApp('bot', { defaultPersonaId: persona.id })
      const key = await ws.issueKey(bot.id)
      const viaKey = (body: object) =>
        app.request('/v1/memories', jsonRequest('POST', body, bearer(key)))
      for (const body of [
        { uri: 'core://notes/x', content: '共享', glossary: ['关键词'] },
        { uri: 'user://notes/y', content: '本人', sensitivity: 'secret' },
        { uri: 'persona://doubao/soul', content: '人格' },
      ]) {
        await ok(await viaKey(body), 201)
      }
      expect(
        (
          await app.request(
            '/v1/recall',
            jsonRequest(
              'POST',
              {
                query: '你好',
                context: {
                  chatType: 'group',
                  platform: 'qq',
                  group: { id: '1', name: '群' },
                  sender: { id: '2', name: '人' },
                },
              },
              bearer(key),
            ),
          )
        ).status,
      ).toBe(200)
      await ok(
        await send('POST', inSpace('/credentials'), ws.cookie, {
          identifier: 'nas',
          name: 'NAS',
          source: { kind: 'new', values: { password: 'pw' } },
        }),
        201,
      )
      await withSpace(database.db, ws.spaceId, (tx) => summaryConversation(tx, ws.spaceId))
      // 离开过的成员
      await ok(await send('DELETE', inSpace(`/members/${bob.accountId}`), ws.cookie), 204)
      // 另一个空间
      const other = await ok<CreatedSpace>(
        await send('POST', '/spaces', ws.cookie, { name: '别处' }),
        201,
      )
      const otherApp = await ok<{ id: string }>(
        await send('POST', `/spaces/${other.id}/apps`, ws.cookie, {
          slug: 'bot',
          name: 'bot',
          runtimeFamily: 'mcp',
        }),
        201,
      )
      const otherKey = await ok<{ key: string }>(
        await send('POST', `/spaces/${other.id}/apps/${otherApp.id}/keys`, ws.cookie, {
          name: 'k',
          scopes: {
            readLayers: ['core'],
            writeLayers: ['core'],
            maxSensitivity: 'internal',
            admin: false,
          },
        }),
        201,
      )
      expect(
        (
          await app.request(
            '/v1/memories',
            jsonRequest('POST', { uri: 'core://notes/z', content: '别处的' }, bearer(otherKey.key)),
          )
        ).status,
      ).toBe(201)

      const count = (spaceId: string) =>
        withSpace(database.db, spaceId, async (tx) => {
          const counts: Record<string, number> = {}
          for (const table of RLS_TABLES) {
            const [row] = await tx.execute<{ n: number }>(
              sql`select count(*)::int as n from ${sql.identifier(table)} where space_id = ${spaceId}`,
            )
            counts[table] = row!.n
          }
          return counts
        })
      const before = await count(ws.spaceId)
      for (const table of ['apps', 'memories', 'memory_events', 'credentials', 'conversations']) {
        expect(before[table], table).toBeGreaterThan(0)
      }
      const otherBefore = await count(other.id)

      await ok(await send('DELETE', inSpace(), ws.cookie, { confirmName: '家' }), 204)
      const after = await count(ws.spaceId)
      expect(
        Object.values(after).every((n) => n === 0),
        JSON.stringify(after),
      ).toBe(true)
      expect(
        await database.db.select().from(apiKeys).where(eq(apiKeys.spaceId, ws.spaceId)),
      ).toEqual([])
      expect(
        await database.db.select().from(spaceMembers).where(eq(spaceMembers.spaceId, ws.spaceId)),
      ).toEqual([])
      expect(
        await database.db
          .select()
          .from(spaceDepartures)
          .where(eq(spaceDepartures.spaceId, ws.spaceId)),
      ).toEqual([])
      expect(await count(other.id)).toEqual(otherBefore)
      // 删掉的空间的 Key 用不了，别处的照常
      expect((await app.request('/v1/whoami', { headers: bearer(key) })).status).toBe(401)
      expect((await app.request('/v1/whoami', { headers: bearer(otherKey.key) })).status).toBe(200)
      // 排着的后台任务执行时空间已经不在了
      expect(
        await dreamSpace(database.db, null, {
          spaceId: ws.spaceId,
          runId: randomUUID(),
          trigger: 'scheduled',
        }),
      ).toEqual({ outcome: 'skipped', reason: null })
      await processSession(database.db, null, {
        spaceId: ws.spaceId,
        appId: bot.id,
        scope: 'global',
      })
    })
  })

  describe('成员', () => {
    it('成员表成员都能看：账号、角色、加入时间与拥有的应用数，没有别的数量；别人看不到', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const viewer = await addMember(database.db, ws.spaceId, 'carol', 'viewer')
      const outsider = await loner('eve')
      await ws.createApp('a1')
      await ws.createApp('a2')
      await ok(
        await send('POST', inSpace('/apps'), bob.cookie, {
          slug: 'b1',
          name: 'b1',
          runtimeFamily: 'mcp',
        }),
        201,
      )
      await ok(
        await send('POST', inSpace('/memories'), bob.cookie, {
          uri: 'user://notes/x',
          content: 'bob 的',
        }),
        201,
      )
      const list = await membersOf(ws.spaceId, viewer.cookie)
      expect(list).toEqual([
        {
          accountId: ws.accountId,
          username: 'alice',
          displayName: 'alice',
          role: 'owner',
          joinedAt: expect.any(String),
          appCount: 2,
        },
        {
          accountId: bob.accountId,
          username: 'bob',
          displayName: 'bob',
          role: 'editor',
          joinedAt: expect.any(String),
          appCount: 1,
        },
        {
          accountId: viewer.accountId,
          username: 'carol',
          displayName: 'carol',
          role: 'viewer',
          joinedAt: expect.any(String),
          appCount: 0,
        },
      ])
      expect((await send('GET', inSpace('/members'), outsider.cookie)).status).toBe(403)
    })

    it('按用户名精确添加：只有空间所有者；账号不存在如实说明，已是成员 409', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const viewer = await addMember(database.db, ws.spaceId, 'carol', 'viewer')
      const dave = await loner('dave')
      const outsider = await loner('eve')
      const add = (cookie: string, username: string, role = 'editor') =>
        send('POST', inSpace('/members'), cookie, { username, role })
      for (const cookie of [editor.cookie, viewer.cookie, outsider.cookie]) {
        expect((await add(cookie, 'dave')).status).toBe(403)
      }
      const missing = await add(ws.cookie, 'nobody')
      expect(missing.status).toBe(404)
      expect(await errorOf(missing)).toBe('账号不存在')
      // 前缀不算；大小写不论，先转小写再精确匹配
      expect((await add(ws.cookie, 'dav')).status).toBe(404)
      expect((await add(ws.cookie, 'dave', 'admin')).status).toBe(400)
      const added = await ok<SpaceMember>(await add(ws.cookie, ' DaVe ', 'viewer'), 201)
      expect(added).toMatchObject({ accountId: dave.accountId, role: 'viewer', appCount: 0 })
      const again = await add(ws.cookie, 'dave')
      expect(again.status).toBe(409)
      expect(await errorOf(again)).toBe('已是此空间的成员')
      expect((await add(ws.cookie, 'bob')).status).toBe(409)
      expect((await send('GET', inSpace('/members'), dave.cookie)).status).toBe(200)
    })

    it('停用的账号不能加为成员、做新空间的所有者，也不能转让给他或把他升为所有者', async () => {
      const dave = await loner('dave')
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      await database.db
        .update(accounts)
        .set({ disabledAt: new Date() })
        .where(inArray(accounts.id, [dave.accountId, bob.accountId]))
      const added = await send('POST', inSpace('/members'), ws.cookie, {
        username: 'dave',
        role: 'editor',
      })
      expect(added.status).toBe(409)
      expect(await errorOf(added)).toBe('账号已停用')
      expect(
        await createSpace(database.db, { name: '给停用的账号', ownerAccountId: dave.accountId }),
      ).toEqual({ ok: false, reason: 'disabled' })
      const promoted = await send('PATCH', inSpace(`/members/${bob.accountId}`), ws.cookie, {
        role: 'owner',
      })
      expect(promoted.status).toBe(409)
      const transferred = await send('POST', inSpace('/transfer-ownership'), ws.cookie, {
        accountId: bob.accountId,
      })
      expect(transferred.status).toBe(409)
      expect(await roles()).toMatchObject({ alice: 'owner', bob: 'editor' })
      // 降级、移除不受影响：管理员停用一个成员之后，空间所有者照样能收回他的角色
      const demoted = await send('PATCH', inSpace(`/members/${bob.accountId}`), ws.cookie, {
        role: 'viewer',
      })
      expect(demoted.status).toBe(200)
      expect((await send('DELETE', inSpace(`/members/${bob.accountId}`), ws.cookie)).status).toBe(
        204,
      )
    })

    it('改角色只有空间所有者，任何时候至少一个所有者', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const outsider = await loner('eve')
      const setRole = (cookie: string, accountId: string, role: string) =>
        send('PATCH', inSpace(`/members/${accountId}`), cookie, { role })
      expect((await setRole(editor.cookie, editor.accountId, 'owner')).status).toBe(403)
      expect((await setRole(outsider.cookie, editor.accountId, 'viewer')).status).toBe(403)
      expect((await setRole(ws.cookie, outsider.accountId, 'viewer')).status).toBe(404)
      expect((await setRole(ws.cookie, editor.accountId, 'boss')).status).toBe(400)
      const last = await setRole(ws.cookie, ws.accountId, 'editor')
      expect(last.status).toBe(409)
      expect(await errorOf(last)).toBe(
        '空间至少要有一个未停用的所有者：先把所有者转让给未停用的成员，或请实例管理员启用另一个所有者',
      )
      // 所有者改自己为所有者不算降级
      expect((await setRole(ws.cookie, ws.accountId, 'owner')).status).toBe(200)
      expect(
        await ok<SpaceMember>(await setRole(ws.cookie, editor.accountId, 'owner')),
      ).toMatchObject({ role: 'owner' })
      // 两个所有者时可以把自己降下来，降完就不能再改别人
      await ok(await setRole(ws.cookie, ws.accountId, 'viewer'))
      expect((await setRole(ws.cookie, editor.accountId, 'viewer')).status).toBe(403)
      expect((await setRole(editor.cookie, editor.accountId, 'editor')).status).toBe(409)
      expect(await roles()).toEqual({ alice: 'viewer', bob: 'owner' })
    })

    it('两个所有者同时互相降级、同时离开：总有一个留下来', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
      const demote = await Promise.all([
        send('PATCH', inSpace(`/members/${bob.accountId}`), ws.cookie, { role: 'editor' }),
        send('PATCH', inSpace(`/members/${ws.accountId}`), bob.cookie, { role: 'editor' }),
      ])
      expect(demote.map((r) => r.status).sort()).toEqual([200, 403])
      expect(Object.values(await roles()).filter((r) => r === 'owner')).toHaveLength(1)

      await database.db
        .update(spaceMembers)
        .set({ role: 'owner' })
        .where(eq(spaceMembers.spaceId, ws.spaceId))
      const leave = await Promise.all([
        send('DELETE', inSpace(`/members/${ws.accountId}`), ws.cookie),
        send('DELETE', inSpace(`/members/${bob.accountId}`), bob.cookie),
      ])
      expect(leave.map((r) => r.status).sort()).toEqual([204, 409])
      const left = await database.db
        .select()
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, ws.spaceId))
      expect(left.map((m) => m.role)).toEqual(['owner'])
    })

    it('移除别人只有空间所有者，成员都能离开；最后一个所有者不能离开、不能被移除', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const viewer = await addMember(database.db, ws.spaceId, 'carol', 'viewer')
      const outsider = await loner('eve')
      const remove = (cookie: string, accountId: string) =>
        send('DELETE', inSpace(`/members/${accountId}`), cookie)
      expect((await remove(editor.cookie, viewer.accountId)).status).toBe(403)
      expect((await remove(outsider.cookie, viewer.accountId)).status).toBe(403)
      expect((await remove(outsider.cookie, outsider.accountId)).status).toBe(403)
      expect((await remove(ws.cookie, outsider.accountId)).status).toBe(404)
      const last = await remove(ws.cookie, ws.accountId)
      expect(last.status).toBe(409)
      // 查看者自己离开
      await ok(await remove(viewer.cookie, viewer.accountId), 204)
      expect((await send('GET', inSpace('/members'), viewer.cookie)).status).toBe(403)
      // 所有者移除编辑者
      await ok(await remove(ws.cookie, editor.accountId), 204)
      expect(await roles()).toEqual({ alice: 'owner' })
      // 两个所有者时可以移除另一个所有者，也可以自己离开
      const bob2 = await addMember(database.db, ws.spaceId, 'dave', 'owner')
      await ok(await remove(ws.cookie, bob2.accountId), 204)
      expect((await remove(ws.cookie, ws.accountId)).status).toBe(409)
      const departed = await database.db
        .select({ accountId: spaceDepartures.accountId })
        .from(spaceDepartures)
        .where(eq(spaceDepartures.spaceId, ws.spaceId))
      expect(departed.map((d) => d.accountId).sort()).toEqual(
        [viewer.accountId, editor.accountId, bob2.accountId].sort(),
      )
    })

    it('停用的所有者不算：只剩停用的所有者时，最后一个没停用的不能降级、离开', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
      await database.db
        .update(accounts)
        .set({ disabledAt: new Date() })
        .where(eq(accounts.id, bob.accountId))
      const demote = await send('PATCH', inSpace(`/members/${ws.accountId}`), ws.cookie, {
        role: 'editor',
      })
      expect(demote.status).toBe(409)
      expect(await errorOf(demote)).toBe(
        '空间至少要有一个未停用的所有者：先把所有者转让给未停用的成员，或请实例管理员启用另一个所有者',
      )
      const leave = await send('DELETE', inSpace(`/members/${ws.accountId}`), ws.cookie)
      expect(leave.status).toBe(409)
      expect(await errorOf(leave)).toBe(
        '空间至少要有一个未停用的所有者：先把所有者转让给未停用的成员，或请实例管理员启用另一个所有者',
      )
      // 停用的所有者照样能降级、移除：还剩 alice
      await ok(
        await send('PATCH', inSpace(`/members/${bob.accountId}`), ws.cookie, { role: 'editor' }),
      )
      await ok(await send('DELETE', inSpace(`/members/${bob.accountId}`), ws.cookie), 204)
      expect(await roles()).toEqual({ alice: 'owner' })
    })

    it('转让所有者：对方成为所有者、自己改为编辑者；对方必须是别的成员，失败时什么都不变', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'viewer')
      const outsider = await loner('eve')
      const transfer = (cookie: string, accountId: string) =>
        send('POST', inSpace('/transfer-ownership'), cookie, { accountId })
      expect((await transfer(bob.cookie, bob.accountId)).status).toBe(403)
      expect((await transfer(ws.cookie, ws.accountId)).status).toBe(400)
      expect((await transfer(ws.cookie, outsider.accountId)).status).toBe(404)
      expect(await roles()).toEqual({ alice: 'owner', bob: 'viewer' })
      const result = await ok<SpaceMember[]>(await transfer(ws.cookie, bob.accountId))
      expect(result.map((m) => [m.username, m.role])).toEqual([
        ['bob', 'owner'],
        ['alice', 'editor'],
      ])
      expect(await roles()).toEqual({ alice: 'editor', bob: 'owner' })
      expect((await transfer(ws.cookie, bob.accountId)).status).toBe(403)
    })

    it('转让与对方离开、两个所有者互相转让同时发生时，总有至少一个所有者', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
      const swap = await Promise.all([
        send('POST', inSpace('/transfer-ownership'), ws.cookie, { accountId: bob.accountId }),
        send('POST', inSpace('/transfer-ownership'), bob.cookie, { accountId: ws.accountId }),
      ])
      expect(swap.map((r) => r.status)).toEqual([200, 200])
      expect(Object.values(await roles()).filter((r) => r === 'owner')).toHaveLength(1)

      const carol = await addMember(database.db, ws.spaceId, 'carol', 'editor')
      const [owner] = (await membersOf()).filter((m) => m.role === 'owner')
      const ownerCookie = owner!.accountId === ws.accountId ? ws.cookie : bob.cookie
      await Promise.all([
        send('POST', inSpace('/transfer-ownership'), ownerCookie, { accountId: carol.accountId }),
        send('DELETE', inSpace(`/members/${carol.accountId}`), carol.cookie),
      ])
      const rows = await database.db
        .select({ role: spaceMembers.role })
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, ws.spaceId))
      expect(rows.filter((r) => r.role === 'owner')).toHaveLength(1)
    })
  })

  describe('离开之后', () => {
    it('他的应用的访问密钥立即作废；本人记忆不删、谁也看不到；重新加入后恢复可见，旧 Key 仍然作废', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const bobApp = await ok<{ id: string }>(
        await send('POST', inSpace('/apps'), bob.cookie, {
          slug: 'bob-bot',
          name: 'bob-bot',
          runtimeFamily: 'mcp',
        }),
        201,
      )
      const issued = await ok<{ id: string; key: string }>(
        await send('POST', inSpace(`/apps/${bobApp.id}/keys`), bob.cookie, {
          name: 'k',
          scopes: {
            readLayers: ['user'],
            writeLayers: ['user'],
            maxSensitivity: 'private',
            admin: false,
          },
        }),
        201,
      )
      const note = await ok<MemoryView>(
        await send('POST', inSpace('/memories'), bob.cookie, {
          uri: 'user://notes/bob',
          content: 'bob 的笔记',
        }),
        201,
      )
      // bob 关掉了 Dream 整理他的本人记忆
      await ok(await send('PUT', inSpace('/me/dream'), bob.cookie, { includePrivate: false }))
      expect((await app.request('/v1/whoami', { headers: bearer(issued.key) })).status).toBe(200)
      const readNote = (cookie: string) =>
        send('GET', inSpace(`/memories?uri=${encodeURIComponent('user://notes/bob')}`), cookie)
      expect((await readNote(bob.cookie)).status).toBe(200)

      await ok(await send('DELETE', inSpace(`/members/${bob.accountId}`), bob.cookie), 204)
      expect((await app.request('/v1/whoami', { headers: bearer(issued.key) })).status).toBe(401)
      const [key] = await database.db.select().from(apiKeys).where(eq(apiKeys.id, issued.id))
      expect(key!.revokedAt).not.toBeNull()
      expect((await readNote(bob.cookie)).status).toBe(403)
      expect((await readNote(ws.cookie)).status).toBe(404)
      // 数据还在，应用也还在
      const kept = await withSpace(database.db, ws.spaceId, (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from memories where id = ${note.id}`,
        ),
      )
      expect(kept[0]!.n).toBe(1)
      expect((await membersOf()).map((m) => m.username)).toEqual(['alice'])

      await ok(
        await send('POST', inSpace('/members'), ws.cookie, { username: 'bob', role: 'editor' }),
        201,
      )
      expect((await readNote(bob.cookie)).status).toBe(200)
      expect((await readNote(ws.cookie)).status).toBe(404)
      expect((await app.request('/v1/whoami', { headers: bearer(issued.key) })).status).toBe(401)
      expect(
        await database.db
          .select()
          .from(spaceDepartures)
          .where(
            and(
              eq(spaceDepartures.spaceId, ws.spaceId),
              eq(spaceDepartures.accountId, bob.accountId),
            ),
          ),
      ).toEqual([])
      // 离开之前的设置照旧
      const [member] = await database.db
        .select({ dreamPrivate: spaceMembers.dreamPrivate })
        .from(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, ws.spaceId), eq(spaceMembers.accountId, bob.accountId)))
      expect(member!.dreamPrivate).toBe(false)
      // 重新加入之后签发的 Key 照常可用
      const fresh = await ok<{ key: string }>(
        await send('POST', inSpace(`/apps/${bobApp.id}/keys`), bob.cookie, {
          name: 'k2',
          scopes: {
            readLayers: ['user'],
            writeLayers: ['user'],
            maxSensitivity: 'private',
            admin: false,
          },
        }),
        201,
      )
      expect((await app.request('/v1/whoami', { headers: bearer(fresh.key) })).status).toBe(200)
    })

    describe('清除开始之前能加回，开始之后要等完成', () => {
      const DAY = 86_400_000
      const PURGING = '离开后的本人记忆与凭据已开始清除，清除完成后才能重新加入'
      let bob: Awaited<ReturnType<typeof addMember>>
      let noteId: string

      beforeEach(async () => {
        bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
        const note = await ok<MemoryView>(
          await send('POST', inSpace('/memories'), bob.cookie, {
            uri: 'user://notes/bob',
            content: 'bob 的笔记',
          }),
          201,
        )
        noteId = note.id
        await ok(await send('PUT', inSpace('/me/dream'), bob.cookie, { includePrivate: false }))
      })

      const add = () =>
        send('POST', inSpace('/members'), ws.cookie, { username: 'bob', role: 'editor' })
      const readNote = () =>
        send('GET', inSpace(`/memories?uri=${encodeURIComponent('user://notes/bob')}`), bob.cookie)
      const leaveDaysAgo = async (days: number) => {
        await ok(await send('DELETE', inSpace(`/members/${bob.accountId}`), bob.cookie), 204)
        await database.db
          .update(spaceDepartures)
          .set({ leftAt: new Date(Date.now() - days * DAY) })
          .where(eq(spaceDepartures.accountId, bob.accountId))
      }
      const departure = async () =>
        (
          await database.db
            .select()
            .from(spaceDepartures)
            .where(eq(spaceDepartures.accountId, bob.accountId))
        )[0]
      const dreamPrivate = async () => {
        const [member] = await database.db
          .select({ dreamPrivate: spaceMembers.dreamPrivate })
          .from(spaceMembers)
          .where(
            and(eq(spaceMembers.spaceId, ws.spaceId), eq(spaceMembers.accountId, bob.accountId)),
          )
        return member?.dreamPrivate
      }
      const noteCount = async () =>
        (
          await withSpace(database.db, ws.spaceId, (tx) =>
            tx.execute<{ n: number }>(
              sql`select count(*)::int as n from memories where id = ${noteId}`,
            ),
          )
        )[0]!.n
      const purge = (paused = false) =>
        purgeExpired(database.db, { days: 30, now: new Date(), paused })
      // 另开一条连接，在事务里做 hold；fn 在事务开着时执行，返回之后提交
      const holding = async <T>(
        hold: (tx: postgres.TransactionSql) => Promise<unknown>,
        fn: (blocked: () => Promise<void>) => Promise<T>,
      ): Promise<T> => {
        const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
        try {
          let result: T | undefined
          await side.begin(async (tx) => {
            await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
            await hold(tx)
            const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [
              { pid: number },
            ]
            // 在另一条连接上查（测试的连接池只有 2 条，请求可能都占着）
            result = await fn(() => blockedOn(side, pid))
          })
          return result!
        } finally {
          await side.end()
        }
      }
      // 等别的连接上的请求等在 pid 持有的锁上
      const blockedOn = async (side: postgres.Sql, pid: number) => {
        for (let i = 0; ; i++) {
          const [row] = await side<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where ${pid}::int = any(pg_blocking_pids(pid))`
          if (row!.n > 0) return
          if (i >= 200) throw new Error('请求没有等在这把锁上')
          await new Promise((r) => setTimeout(r, 25))
        }
      }

      it('没开始清除的，不管离开多久都能加回并恢复，包括保留期暂停期间', async () => {
        await leaveDaysAgo(29)
        await ok(await add(), 201)
        expect((await readNote()).status).toBe(200)
        expect(await dreamPrivate()).toBe(false)

        await leaveDaysAgo(40)
        expect((await purge(true)).counts.departedMembers).toBe(0)
        expect((await departure())?.purgeStartedAt).toBeNull()
        await ok(await add(), 201)
        expect((await readNote()).status).toBe(200)
        expect(await dreamPrivate()).toBe(false)
        expect(await departure()).toBeUndefined()
      })

      it('第一批之后不能加回；清除完成之后作为新成员加回', async () => {
        await leaveDaysAgo(31)
        // 锁住他的笔记：第一批跳过它，清除开始了、没做完
        await holding(
          (tx) => tx`select id from memories where id = ${noteId} for update`,
          async () => {
            const { counts } = await purge()
            expect(counts.departedMembers).toBe(0)
          },
        )
        expect((await departure())?.purgeStartedAt).not.toBeNull()
        expect(await noteCount()).toBe(1)
        const refused = await add()
        expect(refused.status).toBe(409)
        expect(await errorOf(refused)).toBe(PURGING)
        expect(await dreamPrivate()).toBeUndefined()
        // 开始之后接着清，不再看离开的时间
        await database.db
          .update(spaceDepartures)
          .set({ leftAt: new Date() })
          .where(eq(spaceDepartures.accountId, bob.accountId))
        expect((await purge()).counts.departedMembers).toBe(1)
        expect(await noteCount()).toBe(0)
        await ok(await add(), 201)
        expect((await readNote()).status).toBe(404)
        expect(await dreamPrivate()).toBe(true)
      })

      it('清除的一批正锁着离开记录时，加回等它提交，之后拒绝', async () => {
        await leaveDaysAgo(31)
        let pending: Promise<Response> | undefined
        await holding(
          (tx) =>
            tx`update space_departures set purge_started_at = now()
              where account_id = ${bob.accountId}`,
          async (blocked) => {
            pending = Promise.resolve(add())
            await blocked()
          },
        )
        const res = await pending!
        expect(res.status).toBe(409)
        expect(await errorOf(res)).toBe(PURGING)
        expect(await noteCount()).toBe(1)
      })

      it('加回正锁着离开记录时，清除跳过他，提交之后他是成员、数据都在', async () => {
        await leaveDaysAgo(31)
        await holding(
          async (tx) => {
            await tx`select 1 from space_departures where account_id = ${bob.accountId} for update`
            await tx`delete from space_departures where account_id = ${bob.accountId}`
            await tx`insert into space_members (space_id, account_id, role, dream_private)
              values (${ws.spaceId}, ${bob.accountId}, 'editor', false)`
          },
          async () => {
            expect((await purge()).counts).toMatchObject({ departedMembers: 0, deletedMemories: 0 })
          },
        )
        expect((await purge()).counts.departedMembers).toBe(0)
        expect(await noteCount()).toBe(1)
        expect((await readNote()).status).toBe(200)
      })
    })

    it('再次离开时离开时间换成这一次的', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      await ok(await send('DELETE', inSpace(`/members/${bob.accountId}`), ws.cookie), 204)
      const old = new Date(Date.now() - 20 * 86_400_000)
      await database.db.update(spaceDepartures).set({ leftAt: old })
      // 中途重新加入又离开
      await database.db
        .insert(spaceMembers)
        .values({ spaceId: ws.spaceId, accountId: bob.accountId, role: 'editor' })
      await ok(await send('DELETE', inSpace(`/members/${bob.accountId}`), ws.cookie), 204)
      const [row] = await database.db.select().from(spaceDepartures)
      expect(row!.leftAt.getTime()).toBeGreaterThan(old.getTime())
    })
  })
})
