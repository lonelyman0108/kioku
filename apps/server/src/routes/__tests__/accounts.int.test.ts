import { randomBytes } from 'node:crypto'

import type {
  AccountLink,
  AdminAccount,
  AdminAccountList,
  CreatedAccount,
  KeyInfo,
  LoginSessionList,
  Me,
  PasswordLinkInfo,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { isTrustedDevice } from '../../auth/deviceCookie'
import { USER_AGENT_MAX_LENGTH } from '../../auth/session'
import type { Database } from '../../db/client'
import { accountLinks, accounts, sessions, spaceMembers, spaces } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps } from '../../http/env'
import { cleanupExpired } from '../../jobs/cleanup'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const PASSWORD = 'correct horse battery'
const NEW_PASSWORD = 'another long passphrase'

describe.skipIf(!testDatabaseUrl)('账号、一次性链接与登录设备', () => {
  let database: Database
  let deps: Deps
  let app: ReturnType<typeof createApp>
  let ws: Workspace

  beforeAll(async () => {
    database = await openTestDatabase()
    deps = {
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
    }
    app = createApp(deps)
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
  })

  const as = (cookie: string) => ({ cookie })
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(
      path,
      body === undefined
        ? { method, headers: { 'sec-fetch-site': 'same-origin', ...headers } }
        : jsonRequest(method, body, headers),
    )
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const cookiesOf = (res: Response) =>
    Object.fromEntries(
      res.headers.getSetCookie().map((c) => {
        const [pair] = c.split(';')
        const at = pair!.indexOf('=')
        return [pair!.slice(0, at), pair!.slice(at + 1)]
      }),
    ) as Record<string, string>
  const login = (username: string, password: string, headers: Record<string, string> = {}) =>
    send('POST', '/v1/auth/login', { username, password }, headers)
  const createAccount = async (username: string, isAdmin = false) =>
    ok<CreatedAccount>(
      await send(
        'POST',
        '/v1/instance/accounts',
        { username, displayName: username.toUpperCase(), isAdmin },
        as(ws.cookie),
      ),
      201,
    )
  const usePasswordLink = (token: string, password = PASSWORD) =>
    send('POST', '/v1/auth/password-link', { token, password })
  // 新建账号并用链接设好密码，返回它的会话 Cookie
  const activeAccount = async (username: string, isAdmin = false) => {
    const created = await createAccount(username, isAdmin)
    const res = await usePasswordLink(created.link.token)
    expect(res.status).toBe(200)
    return { id: created.account.id, cookie: `kioku_session=${cookiesOf(res).kioku_session}` }
  }
  const patchAccount = (cookie: string, id: string, body: unknown) =>
    send('PATCH', `/v1/instance/accounts/${id}`, body, as(cookie))

  describe('实例管理员的接口', () => {
    it('非管理员一律 403', async () => {
      const member = await addMember(database.db, ws.spaceId, 'bob', 'owner')
      expect(
        (await send('GET', '/v1/instance/accounts', undefined, as(member.cookie))).status,
      ).toBe(403)
      expect(
        (
          await send(
            'POST',
            '/v1/instance/accounts',
            { username: 'carol', displayName: 'Carol' },
            as(member.cookie),
          )
        ).status,
      ).toBe(403)
      expect(
        (
          await send(
            'POST',
            `/v1/instance/accounts/${ws.accountId}/link`,
            undefined,
            as(member.cookie),
          )
        ).status,
      ).toBe(403)
      expect((await patchAccount(member.cookie, ws.accountId, { disabled: true })).status).toBe(403)
      expect((await send('GET', '/v1/instance/accounts')).status).toBe(401)
    })

    it('新建账号：个人空间、本人是所有者，返回设置密码的链接；用户名沿用规则、不能重复', async () => {
      const created = await createAccount('bob')
      expect(created.link.purpose).toBe('setup')
      expect(created.link.token.length).toBeGreaterThanOrEqual(43)
      const expires = new Date(created.link.expiresAt).getTime() - Date.now()
      expect(expires).toBeGreaterThan(23.9 * 3600_000)
      expect(expires).toBeLessThanOrEqual(24 * 3600_000 + 5_000)
      expect(created.account).toMatchObject({
        username: 'bob',
        displayName: 'BOB',
        isAdmin: false,
        passwordSet: false,
        disabledAt: null,
        lastActiveAt: null,
        pendingLink: { purpose: 'setup', expiresAt: created.link.expiresAt },
      })
      expect(created.account.spaces).toEqual([
        { id: expect.any(String), name: 'BOB的空间', role: 'owner' },
      ])
      // 库里只存令牌的哈希
      const [row] = await database.db.select().from(accountLinks)
      expect(row!.tokenHash).not.toBe(created.link.token)
      expect(JSON.stringify(row)).not.toContain(created.link.token)

      const dup = await send(
        'POST',
        '/v1/instance/accounts',
        { username: 'bob', displayName: 'x' },
        as(ws.cookie),
      )
      expect(dup.status).toBe(409)
      const bad = await send(
        'POST',
        '/v1/instance/accounts',
        { username: 'Bob!', displayName: 'x' },
        as(ws.cookie),
      )
      expect(bad.status).toBe(400)
      // 没设密码之前登录不了，和密码错误一样
      const res = await login('bob', '')
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: '用户名或密码错误' })
    })

    it('账号列表：所在空间与角色、最近活动、待用的链接', async () => {
      const created = await createAccount('bob')
      await database.db
        .insert(spaceMembers)
        .values({ spaceId: ws.spaceId, accountId: created.account.id, role: 'viewer' })
      const list = await ok<AdminAccountList>(
        await send('GET', '/v1/instance/accounts', undefined, as(ws.cookie)),
      )
      expect(list.accounts.map((a) => a.username)).toEqual(['alice', 'bob'])
      const [alice, bob] = list.accounts as [AdminAccount, AdminAccount]
      expect(alice).toMatchObject({ isAdmin: true, passwordSet: true, pendingLink: null })
      expect(alice.lastActiveAt).not.toBeNull()
      expect(alice.spaces).toEqual([{ id: ws.spaceId, name: '家', role: 'owner' }])
      expect(bob.spaces.map((s) => [s.name, s.role])).toEqual([
        ['家', 'viewer'],
        ['BOB的空间', 'owner'],
      ])
      expect(bob.pendingLink?.purpose).toBe('setup')
      expect(JSON.stringify(list)).not.toContain(created.link.token)
    })

    it('改显示名、设为管理员；不能改自己的管理员身份与停用状态', async () => {
      const bob = await createAccount('bob')
      const updated = await ok<AdminAccount>(
        await patchAccount(ws.cookie, bob.account.id, { displayName: '鲍勃', isAdmin: true }),
      )
      expect(updated).toMatchObject({ displayName: '鲍勃', isAdmin: true })
      expect((await patchAccount(ws.cookie, ws.accountId, { isAdmin: false })).status).toBe(400)
      expect((await patchAccount(ws.cookie, ws.accountId, { disabled: true })).status).toBe(400)
      // 值没变不算改
      expect((await patchAccount(ws.cookie, ws.accountId, { isAdmin: true })).status).toBe(200)
      expect(
        (await ok<AdminAccount>(await patchAccount(ws.cookie, ws.accountId, { displayName: 'A' })))
          .displayName,
      ).toBe('A')
      expect(
        (await patchAccount(ws.cookie, '00000000-0000-4000-8000-000000000000', { isAdmin: true }))
          .status,
      ).toBe(404)
    })

    it('两个管理员同时停用或降级对方，至少留下一个可用的管理员', async () => {
      for (let round = 0; round < 4; round++) {
        await resetDatabase(database)
        ws = await bootstrap(app)
        const bob = await activeAccount('bob', true)
        const body = round % 2 ? { isAdmin: false } : { disabled: true }
        const results = await Promise.all([
          patchAccount(ws.cookie, bob.id, body),
          patchAccount(bob.cookie, ws.accountId, body),
        ])
        const statuses = results.map((r) => r.status).sort()
        // 后一个等到锁时自己已经不是可用的管理员了（或者在中间件那一步就被挡下）
        expect(statuses).toEqual([200, 403])
        const usable = await database.db
          .select()
          .from(accounts)
          .where(sql`${accounts.isAdmin} and ${accounts.disabledAt} is null`)
        expect(usable).toHaveLength(1)
      }
    }, 60_000)
  })

  describe('一次性链接', () => {
    it('读链接、设置密码后登录；链接只能用一次', async () => {
      const created = await createAccount('bob')
      const info = await ok<PasswordLinkInfo>(
        await send('POST', '/v1/auth/password-link/inspect', { token: created.link.token }),
      )
      expect(info).toEqual({
        username: 'bob',
        displayName: 'BOB',
        purpose: 'setup',
        expiresAt: created.link.expiresAt,
      })
      const res = await usePasswordLink(created.link.token)
      const me = await ok<Me>(res)
      expect(me).toMatchObject({ username: 'bob', isAdmin: false })
      expect(me.spaces[0]?.name).toBe('BOB的空间')
      const cookies = cookiesOf(res)
      expect(cookies.kioku_session).toBeTruthy()
      expect(cookies.kioku_device).toBeTruthy()
      expect(
        (await send('GET', '/v1/auth/me', undefined, as(`kioku_session=${cookies.kioku_session}`)))
          .status,
      ).toBe(200)

      expect((await usePasswordLink(created.link.token, NEW_PASSWORD)).status).toBe(404)
      expect(
        (await send('POST', '/v1/auth/password-link/inspect', { token: created.link.token }))
          .status,
      ).toBe(404)
      expect((await login('bob', PASSWORD)).status).toBe(200)
      expect((await login('bob', NEW_PASSWORD)).status).toBe(401)
      // 用过的链接由定时清理删掉
      expect((await cleanupExpired(database.db)).links).toBe(1)
      expect(await database.db.select().from(accountLinks)).toEqual([])
    })

    it('同一个链接并发提交，只有一个用得上', async () => {
      const created = await createAccount('bob')
      const results = await Promise.all([
        usePasswordLink(created.link.token, PASSWORD),
        usePasswordLink(created.link.token, NEW_PASSWORD),
      ])
      expect(results.map((r) => r.status).sort()).toEqual([200, 404])
    })

    it('无效、过期、作废的链接一律同样的 404', async () => {
      const created = await createAccount('bob')
      const inspect = (token: string) => send('POST', '/v1/auth/password-link/inspect', { token })
      const invalid = await inspect('nope')
      expect(invalid.status).toBe(404)
      const invalidBody = await invalid.json()

      // 重新生成：旧链接作废，新链接可用
      const next = await ok<AccountLink>(
        await send(
          'POST',
          `/v1/instance/accounts/${created.account.id}/link`,
          undefined,
          as(ws.cookie),
        ),
        201,
      )
      expect(next.purpose).toBe('setup')
      const voided = await inspect(created.link.token)
      expect(voided.status).toBe(404)
      expect(await voided.json()).toEqual(invalidBody)
      expect((await usePasswordLink(created.link.token)).status).toBe(404)
      expect((await inspect(next.token)).status).toBe(200)

      await database.db
        .update(accountLinks)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(accountLinks.accountId, created.account.id))
      const expired = await inspect(next.token)
      expect(expired.status).toBe(404)
      expect(await expired.json()).toEqual(invalidBody)
      expect((await usePasswordLink(next.token)).status).toBe(404)
      expect((await cleanupExpired(database.db)).links).toBe(1)
    })

    it('重置密码的链接不改现在的密码，用掉时才改，并清掉这个账号的全部会话', async () => {
      const bob = await activeAccount('bob')
      const other = cookiesOf(await login('bob', PASSWORD)).kioku_session
      const link = await ok<AccountLink>(
        await send('POST', `/v1/instance/accounts/${bob.id}/link`, undefined, as(ws.cookie)),
        201,
      )
      expect(link.purpose).toBe('reset')
      expect((await login('bob', PASSWORD)).status).toBe(200)
      const res = await usePasswordLink(link.token, NEW_PASSWORD)
      expect(res.status).toBe(200)
      for (const cookie of [bob.cookie, `kioku_session=${other}`]) {
        expect((await send('GET', '/v1/auth/me', undefined, as(cookie))).status).toBe(401)
      }
      const left = await database.db.select().from(sessions).where(eq(sessions.accountId, bob.id))
      expect(left).toHaveLength(1)
      expect((await login('bob', PASSWORD)).status).toBe(401)
      expect((await login('bob', NEW_PASSWORD)).status).toBe(200)
    })

    it('跨站提交被拒绝', async () => {
      const created = await createAccount('bob')
      const res = await app.request('/v1/auth/password-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: JSON.stringify({ token: created.link.token, password: PASSWORD }),
      })
      expect(res.status).toBe(403)
      expect((await usePasswordLink(created.link.token, 'short')).status).toBe(400)
      expect((await usePasswordLink(created.link.token)).status).toBe(200)
    })
  })

  describe('停用', () => {
    it('停用后会话与链接清掉、登录和密码错误一样被拒且照常计数；启用后恢复', async () => {
      const bob = await activeAccount('bob')
      await send('POST', `/v1/instance/accounts/${bob.id}/link`, undefined, as(ws.cookie))
      const disabled = await ok<AdminAccount>(
        await patchAccount(ws.cookie, bob.id, { disabled: true }),
      )
      expect(disabled.disabledAt).not.toBeNull()
      expect(disabled.pendingLink).toBeNull()
      expect((await send('GET', '/v1/auth/me', undefined, as(bob.cookie))).status).toBe(401)
      expect(
        await database.db.select().from(sessions).where(eq(sessions.accountId, bob.id)),
      ).toEqual([])
      expect(
        await database.db.select().from(accountLinks).where(eq(accountLinks.accountId, bob.id)),
      ).toEqual([])
      expect(
        (await send('POST', `/v1/instance/accounts/${bob.id}/link`, undefined, as(ws.cookie)))
          .status,
      ).toBe(409)

      const right = await login('bob', PASSWORD)
      const wrong = await login('bob', 'wrong password')
      expect(right.status).toBe(401)
      expect(wrong.status).toBe(401)
      expect(await right.json()).toEqual(await wrong.json())
      // 两次都计数：再错三次就锁住
      for (let i = 0; i < 3; i++) expect((await login('bob', PASSWORD)).status).toBe(401)
      expect((await login('bob', PASSWORD)).status).toBe(429)

      await patchAccount(ws.cookie, bob.id, { disabled: false })
      await database.db.execute(sql`truncate login_attempts`)
      expect((await login('bob', PASSWORD)).status).toBe(200)
    })

    it('会话鉴权也挡停用的账号', async () => {
      const bob = await activeAccount('bob')
      // 绕开接口直接改，会话还在
      await database.db
        .update(accounts)
        .set({ disabledAt: new Date() })
        .where(eq(accounts.id, bob.id))
      expect((await send('GET', '/v1/auth/me', undefined, as(bob.cookie))).status).toBe(401)
    })

    it('停用的账号的链接用不了', async () => {
      const created = await createAccount('bob')
      await database.db
        .update(accounts)
        .set({ disabledAt: new Date() })
        .where(eq(accounts.id, created.account.id))
      expect(
        (await send('POST', '/v1/auth/password-link/inspect', { token: created.link.token }))
          .status,
      ).toBe(404)
      expect((await usePasswordLink(created.link.token)).status).toBe(404)
    })

    it('应用所有者停用后，他的访问密钥在各个接口都作废；启用后恢复', async () => {
      const bob = await activeAccount('bob', true)
      await database.db
        .insert(spaceMembers)
        .values({ spaceId: ws.spaceId, accountId: bob.id, role: 'owner' })
      // Bob 建应用、签发 Key
      const bobApp = await ok<{ id: string }>(
        await send(
          'POST',
          `/v1/spaces/${ws.spaceId}/apps`,
          { slug: 'bob-agent', name: 'bob', runtimeFamily: 'mcp' },
          as(bob.cookie),
        ),
        201,
      )
      const key = (
        await ok<{ key: string }>(
          await send(
            'POST',
            `/v1/spaces/${ws.spaceId}/apps/${bobApp.id}/keys`,
            {
              name: 'k',
              scopes: {
                readLayers: ['core'],
                writeLayers: ['core'],
                maxSensitivity: 'internal',
                admin: false,
                credentials: 'use',
              },
            },
            as(bob.cookie),
          ),
          201,
        )
      ).key
      const calls = () => [
        send('GET', '/v1/whoami', undefined, bearer(key)),
        send('POST', '/v1/recall', { prompt: '你好' }, bearer(key)),
        send('GET', '/v1/boot', undefined, bearer(key)),
        send('POST', '/v1/lifecycle/event', { event: 'session_start' }, bearer(key)),
        send('POST', '/v1/memories', { uri: 'core://x', content: 'x' }, bearer(key)),
        send('POST', '/v1/credentials/resolve', { refs: [] }, bearer(key)),
        send(
          'POST',
          '/v1/mcp',
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          { ...bearer(key), accept: 'application/json, text/event-stream' },
        ),
      ]
      for (const res of await Promise.all(calls())) expect(res.status).not.toBe(401)

      await patchAccount(ws.cookie, bob.id, { disabled: true })
      for (const res of await Promise.all(calls())) expect(res.status).toBe(401)
      const keys = await ok<KeyInfo[]>(
        await send(
          'GET',
          `/v1/spaces/${ws.spaceId}/apps/${bobApp.id}/keys`,
          undefined,
          as(ws.cookie),
        ),
      )
      expect(keys[0]!.effectiveScopes).toBeNull()

      await patchAccount(ws.cookie, bob.id, { disabled: false })
      expect((await send('GET', '/v1/whoami', undefined, bearer(key))).status).toBe(200)
    })
  })

  describe('个人', () => {
    it('改显示名', async () => {
      const me = await ok<Me>(
        await send('PATCH', '/v1/auth/profile', { displayName: ' 爱丽丝 ' }, as(ws.cookie)),
      )
      expect(me.displayName).toBe('爱丽丝')
      expect(
        (await send('PATCH', '/v1/auth/profile', { displayName: '' }, as(ws.cookie))).status,
      ).toBe(400)
      expect((await send('PATCH', '/v1/auth/profile', { displayName: 'x' })).status).toBe(401)
    })

    it('改密码：错的当前密码和登录失败记在同一个计数上', async () => {
      for (let i = 0; i < 5; i++) {
        const res = await send(
          'POST',
          '/v1/auth/password',
          { currentPassword: 'wrong', newPassword: NEW_PASSWORD },
          as(ws.cookie),
        )
        expect(res.status).toBe(400)
      }
      expect((await login('alice', PASSWORD)).status).toBe(429)
      const blocked = await send(
        'POST',
        '/v1/auth/password',
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        as(ws.cookie),
      )
      expect(blocked.status).toBe(429)
    })

    it('改密码：其他会话退出、当前会话保留，设备 Cookie 换新，旧的失效', async () => {
      const first = await login('alice', PASSWORD)
      const oldDevice = cookiesOf(first).kioku_device!
      const current = `kioku_session=${cookiesOf(first).kioku_session}`
      const other = `kioku_session=${cookiesOf(await login('alice', PASSWORD)).kioku_session}`
      // 改密码时没用过的重置链接一起作废
      const link = await ok<AccountLink>(
        await send('POST', `/v1/instance/accounts/${ws.accountId}/link`, undefined, as(ws.cookie)),
        201,
      )

      const res = await send(
        'POST',
        '/v1/auth/password',
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        { cookie: `${current}; kioku_device=${oldDevice}` },
      )
      expect(res.status).toBe(204)
      const newDevice = cookiesOf(res).kioku_device!
      expect(newDevice).toBeTruthy()
      expect((await send('GET', '/v1/auth/me', undefined, as(current))).status).toBe(200)
      expect((await send('GET', '/v1/auth/me', undefined, as(other))).status).toBe(401)
      expect((await send('GET', '/v1/auth/me', undefined, as(ws.cookie))).status).toBe(401)
      expect((await usePasswordLink(link.token)).status).toBe(404)

      const [account] = await database.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, ws.accountId))
      expect(await isTrustedDevice(database.db, oldDevice, account)).toBe(false)
      expect(await isTrustedDevice(database.db, newDevice, account)).toBe(true)
      expect((await login('alice', PASSWORD)).status).toBe(401)
      expect((await login('alice', NEW_PASSWORD)).status).toBe(200)
    })

    it('登录设备：标出当前这个，记下地址与截断的 User-Agent；退出某一个与退出其他全部', async () => {
      const proxied = createApp({ ...deps, trustedProxies: 1 })
      const longAgent = `Mozilla/5.0 ${'a'.repeat(USER_AGENT_MAX_LENGTH)}`
      const res = await proxied.request(
        '/v1/auth/login',
        jsonRequest(
          'POST',
          { username: 'alice', password: PASSWORD },
          { 'x-forwarded-for': '198.51.100.7, 203.0.113.9', 'user-agent': longAgent },
        ),
      )
      expect(res.status).toBe(200)
      const current = `kioku_session=${cookiesOf(res).kioku_session}`
      const list = await ok<LoginSessionList>(
        await send('GET', '/v1/auth/sessions', undefined, as(current)),
      )
      expect(list.sessions).toHaveLength(2)
      const mine = list.sessions.find((s) => s.current)!
      expect(mine.clientAddress).toBe('203.0.113.9')
      expect(Array.from(mine.userAgent!)).toHaveLength(USER_AGENT_MAX_LENGTH)
      expect(mine.userAgent!.endsWith('�')).toBe(false)
      const setupSession = list.sessions.find((s) => !s.current)!

      // 别人的会话按不存在处理
      const bob = await activeAccount('bob')
      expect(
        (await send('DELETE', `/v1/auth/sessions/${setupSession.id}`, undefined, as(bob.cookie)))
          .status,
      ).toBe(404)
      expect(
        (await send('DELETE', `/v1/auth/sessions/${setupSession.id}`, undefined, as(current)))
          .status,
      ).toBe(204)
      expect((await send('GET', '/v1/auth/me', undefined, as(ws.cookie))).status).toBe(401)

      const third = `kioku_session=${cookiesOf(await login('alice', PASSWORD)).kioku_session}`
      expect(
        (await send('POST', '/v1/auth/sessions/sign-out-others', undefined, as(current))).status,
      ).toBe(204)
      expect((await send('GET', '/v1/auth/me', undefined, as(third))).status).toBe(401)
      expect((await send('GET', '/v1/auth/me', undefined, as(current))).status).toBe(200)
      expect((await send('GET', '/v1/auth/me', undefined, as(bob.cookie))).status).toBe(200)

      // 退出当前这个等于退出登录
      const self = list.sessions.find((s) => s.current)!
      expect(
        (await send('DELETE', `/v1/auth/sessions/${self.id}`, undefined, as(current))).status,
      ).toBe(204)
      expect((await send('GET', '/v1/auth/me', undefined, as(current))).status).toBe(401)
    })

    it('最近活动比上次晚 5 分钟以上才更新', async () => {
      const at = async () =>
        (await database.db.select().from(sessions).where(eq(sessions.accountId, ws.accountId)))[0]!
          .lastActiveAt
      const backdate = (minutes: number) =>
        database.db
          .update(sessions)
          .set({ lastActiveAt: sql`now() - make_interval(mins => ${minutes})` })
          .where(eq(sessions.accountId, ws.accountId))
      await backdate(4)
      const before = await at()
      await send('GET', '/v1/auth/me', undefined, as(ws.cookie))
      expect((await at()).getTime()).toBe(before.getTime())
      await backdate(6)
      const stale = await at()
      await send('GET', '/v1/auth/me', undefined, as(ws.cookie))
      const fresh = await at()
      expect(fresh.getTime()).toBeGreaterThan(stale.getTime() + 5 * 60_000)
    })
  })

  it('个人空间名按码点截断', async () => {
    const created = await ok<CreatedAccount>(
      await send(
        'POST',
        '/v1/instance/accounts',
        { username: 'long', displayName: '😀'.repeat(64) },
        as(ws.cookie),
      ),
      201,
    )
    const [space] = await database.db
      .select()
      .from(spaces)
      .where(eq(spaces.id, created.account.spaces[0]!.id))
    expect(space!.name).toBe(`${'😀'.repeat(60)}的空间`)
  })
})
