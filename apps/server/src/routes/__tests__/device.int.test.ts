import { randomBytes } from 'node:crypto'

import type {
  DeviceAuthorization,
  DeviceGrantInfo,
  DeviceTokenResponse,
  KeyScopes,
  WhoAmI,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { accounts, apiKeys, apps, deviceGrants, spaceMembers } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps } from '../../http/env'
import { cleanupExpired } from '../../jobs/cleanup'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const SCOPES: KeyScopes = {
  readLayers: ['core', 'persona', 'app', 'user'],
  writeLayers: ['app', 'user'],
  maxSensitivity: 'private',
  admin: false,
  credentials: 'none',
}

describe.skipIf(!testDatabaseUrl)('浏览器授权', () => {
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

  // 命令行：不带 Cookie，也不带浏览器的同源标记
  const cli = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const web = (path: string, cookie: string | null, body: unknown) =>
    app.request(path, jsonRequest('POST', body, cookie ? { cookie } : {}))

  // clientName 为 null 时不带名字
  async function request(runtimeFamily = 'codex', clientName: string | null = 'laptop') {
    const res = await cli('/v1/device/authorize', {
      runtimeFamily,
      ...(clientName === null ? {} : { clientName }),
    })
    expect(res.status).toBe(201)
    return (await res.json()) as DeviceAuthorization
  }
  async function poll(deviceCode: string) {
    const res = await cli('/v1/device/token', { deviceCode })
    expect(res.status).toBe(200)
    return (await res.json()) as DeviceTokenResponse
  }
  const approve = (
    userCode: string,
    extra: Record<string, unknown> = {},
    cookie: string = ws.cookie,
  ) =>
    web('/v1/device/grants/approve', cookie, {
      userCode,
      spaceId: ws.spaceId,
      app: { slug: 'codex', name: 'Codex' },
      keyName: 'laptop',
      scopes: SCOPES,
      ...extra,
    })
  // 轮询之间至少隔一秒，测试里把上次轮询的时间往回拨
  const rewind = () => database.db.update(deviceGrants).set({ lastPolledAt: null })
  const grants = () => database.db.select().from(deviceGrants)
  // 应用与 Key 是内容表，要在空间里读
  const inSpace = <T>(fn: Parameters<typeof withSpace<T>>[2]) =>
    withSpace(database.db, ws.spaceId, fn)
  const keys = () => inSpace((tx) => tx.select().from(apiKeys))
  const spaceApps = () => inSpace((tx) => tx.select().from(apps))

  it('申请、确认、取走：访问密钥只给一次，能用，库里没有明文', async () => {
    const grant = await request()
    expect(grant).toMatchObject({ verificationPath: '/authorize', expiresIn: 600, interval: 3 })
    expect(grant.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    // 两个码都只存哈希
    const [stored] = await grants()
    const dump = JSON.stringify(stored)
    expect(dump).not.toContain(grant.deviceCode)
    expect(dump).not.toContain(grant.userCode.replace('-', ''))

    expect(await poll(grant.deviceCode)).toEqual({ status: 'pending' })

    // 确认码输入时不计较大小写、空格与连字符
    const seen = await web('/v1/device/grants/lookup', ws.cookie, {
      userCode: ` ${grant.userCode.toLowerCase().replace('-', ' ')} `,
    })
    expect(seen.status).toBe(200)
    expect((await seen.json()) as DeviceGrantInfo).toMatchObject({
      runtimeFamily: 'codex',
      clientName: 'laptop',
    })

    const approved = await approve(grant.userCode)
    expect(approved.status).toBe(200)
    // 确认时还没有 Key
    expect(await keys()).toHaveLength(0)

    await rewind()
    const result = await poll(grant.deviceCode)
    if (result.status !== 'approved') throw new Error(`没有取到：${result.status}`)
    expect(result.app).toEqual({ slug: 'codex', name: 'Codex', runtimeFamily: 'codex' })
    const who = await app.request('/v1/whoami', { headers: bearer(result.key) })
    expect(who.status).toBe(200)
    expect(((await who.json()) as WhoAmI).scopes).toMatchObject({
      maxSensitivity: 'private',
      credentials: 'none',
    })

    // 这条申请没有了，再取是过期；库里只有 Key 的哈希
    expect(await grants()).toHaveLength(0)
    expect(await poll(grant.deviceCode)).toEqual({ status: 'expired' })
    const [key] = await keys()
    expect(key).toMatchObject({ name: 'laptop', scopes: SCOPES })
    expect(JSON.stringify(key)).not.toContain(result.key)
    const [created] = await spaceApps()
    expect(created).toMatchObject({
      slug: 'codex',
      runtimeFamily: 'codex',
      ownerAccountId: ws.accountId,
    })
  })

  it('同时来的两次轮询只有一次取得到访问密钥', async () => {
    const grant = await request()
    await approve(grant.userCode)
    const results = await Promise.all([poll(grant.deviceCode), poll(grant.deviceCode)])
    expect(results.map((r) => r.status).sort()).toEqual(['approved', 'expired'])
    expect(await keys()).toHaveLength(1)
  })

  it('用确认人自己已有的应用；别人的应用不行', async () => {
    const mine = await ws.createApp('mine', { runtimeFamily: 'codex' })
    const grant = await request()
    expect((await approve(grant.userCode, { app: { id: mine.id } })).status).toBe(200)
    const result = await poll(grant.deviceCode)
    expect(result).toMatchObject({ status: 'approved', app: { slug: 'mine' } })

    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const second = await request()
    const refused = await approve(second.userCode, { app: { id: mine.id } }, bob.cookie)
    expect(refused.status).toBe(403)
    // 申请还在，换个应用可以接着确认
    expect((await approve(second.userCode, {}, bob.cookie)).status).toBe(200)
    expect(
      (
        await approve((await request()).userCode, {
          app: { id: '00000000-0000-4000-8000-000000000000' },
        })
      ).status,
    ).toBe(404)
  })

  it('应用的标识被占用时回 409，申请还在', async () => {
    await ws.createApp('codex')
    const grant = await request()
    expect((await approve(grant.userCode)).status).toBe(409)
    expect(
      (await approve(grant.userCode, { app: { slug: 'codex-2', name: 'Codex' } })).status,
    ).toBe(200)
    // 确认过的不能再确认、再拒绝一次
    expect(
      (await approve(grant.userCode, { app: { slug: 'codex-3', name: 'Codex' } })).status,
    ).toBe(404)
    expect(
      (await web('/v1/device/grants/deny', ws.cookie, { userCode: grant.userCode })).status,
    ).toBe(404)
  })

  it('拒绝：命令行得到 denied，之后是过期，不签发', async () => {
    const grant = await request()
    const res = await web('/v1/device/grants/deny', ws.cookie, { userCode: grant.userCode })
    expect(res.status).toBe(204)
    expect(await poll(grant.deviceCode)).toEqual({ status: 'denied' })
    expect(await poll(grant.deviceCode)).toEqual({ status: 'expired' })
    expect(await keys()).toHaveLength(0)
  })

  it('过期的申请查不到、确认不了、取不到，由定时清理删掉', async () => {
    const pending = await request()
    const approved = await request()
    await approve(approved.userCode)
    await database.db.update(deviceGrants).set({ expiresAt: sql`now() - interval '1 second'` })
    expect(
      (await web('/v1/device/grants/lookup', ws.cookie, { userCode: pending.userCode })).status,
    ).toBe(404)
    expect((await approve(pending.userCode, { app: { slug: 'x', name: 'x' } })).status).toBe(404)
    expect(await poll(approved.deviceCode)).toEqual({ status: 'expired' })
    expect(await keys()).toHaveLength(0)
    // 轮询到过期的顺手删了，剩下的一条归定时清理
    expect(await grants()).toHaveLength(1)
    expect((await cleanupExpired(database.db)).deviceGrants).toBe(1)
    expect(await grants()).toHaveLength(0)
  })

  it('签发的规则照旧：查看者不能确认，编辑者给不了机密级与凭据能力，不是成员的进不了这个空间', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const viewer = await addMember(database.db, ws.spaceId, 'carol', 'viewer')
    // 登录着、但不是这个空间的成员
    const outsider = await addMember(database.db, ws.spaceId, 'dave', 'owner')
    await database.db.delete(spaceMembers).where(eq(spaceMembers.accountId, outsider.accountId))
    const grant = await request()
    expect((await approve(grant.userCode, {}, viewer.cookie)).status).toBe(403)
    expect((await approve(grant.userCode, {}, outsider.cookie)).status).toBe(403)
    for (const scopes of [
      { ...SCOPES, maxSensitivity: 'secret' },
      { ...SCOPES, credentials: 'use' },
      { ...SCOPES, admin: true },
    ]) {
      expect((await approve(grant.userCode, { scopes }, editor.cookie)).status).toBe(403)
      expect(
        (
          await approve((await request()).userCode, {
            app: { slug: `s${Math.random().toString(36).slice(2, 8)}`, name: 'x' },
            scopes,
          })
        ).status,
      ).toBe(200)
    }
    // 被拒的那几次没有动这条申请，也没有留下应用
    expect((await approve(grant.userCode, {}, editor.cookie)).status).toBe(200)
  })

  it('确认之后、取走之前确认人被降级、停用、移出空间，或者应用转给了别人：取不到，不签发', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
    const changes = [
      () =>
        database.db
          .update(spaceMembers)
          .set({ role: 'viewer' })
          .where(eq(spaceMembers.accountId, bob.accountId)),
      () =>
        database.db
          .update(accounts)
          .set({ disabledAt: new Date() })
          .where(eq(accounts.id, bob.accountId)),
      () => database.db.delete(spaceMembers).where(eq(spaceMembers.accountId, bob.accountId)),
      () =>
        inSpace((tx) =>
          tx
            .update(apps)
            .set({ ownerAccountId: ws.accountId })
            .where(eq(apps.ownerAccountId, bob.accountId)),
        ),
    ]
    for (const [index, change] of changes.entries()) {
      // 每轮从头来：恢复成所有者、没停用
      await database.db
        .insert(spaceMembers)
        .values({ spaceId: ws.spaceId, accountId: bob.accountId, role: 'owner' })
        .onConflictDoUpdate({
          target: [spaceMembers.spaceId, spaceMembers.accountId],
          set: { role: 'owner' },
        })
      await database.db.update(accounts).set({ disabledAt: null })
      const grant = await request()
      const res = await approve(
        grant.userCode,
        { app: { slug: `bob-${index}`, name: 'x' }, scopes: { ...SCOPES, credentials: 'use' } },
        bob.cookie,
      )
      expect(res.status, `第 ${index} 种`).toBe(200)
      await change()
      expect(await poll(grant.deviceCode), `第 ${index} 种`).toEqual({ status: 'denied' })
      expect(await poll(grant.deviceCode)).toEqual({ status: 'expired' })
    }
    expect(await keys()).toHaveLength(0)
  })

  it('应用被删掉时，确认过还没取走的申请一起没了', async () => {
    const grant = await request()
    await approve(grant.userCode)
    const [target] = await spaceApps()
    const res = await app.request(`/v1/spaces/${ws.spaceId}/apps/${target!.id}`, {
      method: 'DELETE',
      headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBeLessThan(300)
    expect(await poll(grant.deviceCode)).toEqual({ status: 'expired' })
    expect(await keys()).toHaveLength(0)
  })

  it('确认页的接口要登录；确认码不对、格式不对分别是 404 与 400', async () => {
    const grant = await request()
    for (const path of ['lookup', 'approve', 'deny']) {
      const res = await web(`/v1/device/grants/${path}`, null, { userCode: grant.userCode })
      expect(res.status, path).toBe(401)
    }
    expect(
      (await web('/v1/device/grants/lookup', ws.cookie, { userCode: 'BCDF-GHJK' })).status,
    ).toBe(404)
    expect((await web('/v1/device/grants/lookup', ws.cookie, { userCode: 'AEIOU' })).status).toBe(
      400,
    )
    expect((await approve('BCDF-GHJK')).status).toBe(404)
    // 命令行的两个接口不用登录；设备码不对和过期答得一样
    expect(await poll('不存在的设备码')).toEqual({ status: 'expired' })
    // 带着会话 Cookie 的跨站请求照样被拦
    const forged = await app.request('/v1/device/grants/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: ws.cookie,
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ userCode: grant.userCode }),
    })
    expect(forged.status).toBe(403)
  })

  it('申请的内容：运行时要认得，名字单行、不含控制字符，不给也行', async () => {
    for (const body of [
      { runtimeFamily: 'nope' },
      { runtimeFamily: 'codex', clientName: 'a\nb' },
      { runtimeFamily: 'codex', clientName: 'a‮b' },
      { runtimeFamily: 'codex', clientName: 'x'.repeat(65) },
      {},
    ]) {
      expect((await cli('/v1/device/authorize', body)).status).toBe(400)
    }
    const grant = await request('pi', null)
    const seen = await web('/v1/device/grants/lookup', ws.cookie, { userCode: grant.userCode })
    expect((await seen.json()) as DeviceGrantInfo).toMatchObject({
      runtimeFamily: 'pi',
      clientName: null,
    })
  })

  it('同一个客户端待确认的申请有上限；取走、拒绝、过期的不占名额', async () => {
    const first = await request()
    for (let i = 1; i < 10; i++) await request()
    expect((await cli('/v1/device/authorize', { runtimeFamily: 'codex' })).status).toBe(429)
    await web('/v1/device/grants/deny', ws.cookie, { userCode: first.userCode })
    const next = await request()
    expect((await cli('/v1/device/authorize', { runtimeFamily: 'codex' })).status).toBe(429)
    await approve(next.userCode)
    await request()
    await database.db.update(deviceGrants).set({ expiresAt: sql`now() - interval '1 second'` })
    await request()
  })

  it('轮询得太勤回 429，不影响之后取走', async () => {
    const grant = await request()
    expect(await poll(grant.deviceCode)).toEqual({ status: 'pending' })
    expect((await cli('/v1/device/token', { deviceCode: grant.deviceCode })).status).toBe(429)
    await approve(grant.userCode)
    // 确认之后不用等
    expect((await poll(grant.deviceCode)).status).toBe('approved')
  })
})
