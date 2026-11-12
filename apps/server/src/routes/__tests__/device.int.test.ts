import { randomBytes } from 'node:crypto'

import {
  DEVICE_KEY_DENIALS,
  type DeviceAuthorization,
  type DeviceGrantApproved,
  type DeviceGrantInfo,
  type DeviceGrantProblem,
  type DeviceTokenResponse,
  type KeyScopes,
  type WhoAmI,
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
  // 单个平台的申请：确认时只有一项，extra 改这一项（runtimeFamily 默认 codex）
  const approve = (
    userCode: string,
    extra: Record<string, unknown> = {},
    cookie: string = ws.cookie,
  ) =>
    web('/v1/device/grants/approve', cookie, {
      userCode,
      spaceId: ws.spaceId,
      items: [
        {
          runtimeFamily: 'codex',
          app: { slug: 'codex', name: 'Codex' },
          keyName: 'laptop',
          scopes: SCOPES,
          ...extra,
        },
      ],
    })
  // 单个平台的申请取到的结果：照早期的形状，只有 key 与 app
  const single = (result: DeviceTokenResponse) => {
    if (result.status !== 'approved' || !('key' in result)) {
      throw new Error(`没有取到：${JSON.stringify(result)}`)
    }
    return result
  }
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
    // 单个平台的申请也规整成一项
    expect((await seen.json()) as DeviceGrantInfo).toMatchObject({
      platforms: [{ runtimeFamily: 'codex', clientName: null }],
      clientName: 'laptop',
    })

    const approved = await approve(grant.userCode)
    expect(approved.status).toBe(200)
    // 确认时还没有 Key
    expect(await keys()).toHaveLength(0)

    await rewind()
    const result = single(await poll(grant.deviceCode))
    // 早期的命令行只认这两个字段，不多给
    expect(Object.keys(result).sort()).toEqual(['app', 'key', 'status'])
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
      platforms: [{ runtimeFamily: 'pi', clientName: null }],
      clientName: null,
    })
  })

  it('同一个客户端待确认的申请有上限；取走、拒绝、过期的不占名额；认不出客户端时不按客户端数', async () => {
    // 认得出客户端：经一层受信代理，地址取自转发头
    const proxied = createApp({ ...deps, trustedProxies: 1 })
    const from = (address: string) =>
      proxied.request('/v1/device/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
        body: JSON.stringify({ runtimeFamily: 'codex' }),
      })
    const codes: DeviceAuthorization[] = []
    for (let i = 0; i < 10; i++) {
      const res = await from('203.0.113.7')
      expect(res.status).toBe(201)
      codes.push((await res.json()) as DeviceAuthorization)
    }
    expect((await from('203.0.113.7')).status).toBe(429)
    // 别的客户端不受影响
    expect((await from('203.0.113.8')).status).toBe(201)
    // 拒绝、确认过的不占名额
    await web('/v1/device/grants/deny', ws.cookie, { userCode: codes[0]!.userCode })
    expect((await from('203.0.113.7')).status).toBe(201)
    expect((await from('203.0.113.7')).status).toBe(429)
    await approve(codes[1]!.userCode)
    expect((await from('203.0.113.7')).status).toBe(201)
    // 过期的不占名额
    await database.db.update(deviceGrants).set({ expiresAt: sql`now() - interval '1 second'` })
    expect((await from('203.0.113.7')).status).toBe(201)

    // 取不到地址的请求不按客户端数：否则所有人共用一个名额，几条申请就挤得别人都申请不了
    for (let i = 0; i < 12; i++) await request()
  })

  it('确认之后离开过空间的确认人，重新加入也取不到：离开前确认的申请不能留下一个访问密钥', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
    const grant = await request()
    expect((await approve(grant.userCode, {}, bob.cookie)).status).toBe(200)
    await database.db.delete(spaceMembers).where(eq(spaceMembers.accountId, bob.accountId))
    await database.db
      .insert(spaceMembers)
      .values({ spaceId: ws.spaceId, accountId: bob.accountId, role: 'owner' })
    expect(await poll(grant.deviceCode)).toEqual({ status: 'denied' })
    expect(await keys()).toHaveLength(0)
  })

  it('已有的应用要和申请的运行时一致', async () => {
    const bot = await ws.createApp('bot', { runtimeFamily: 'astrbot' })
    const grant = await request('codex')
    const res = await approve(grant.userCode, { app: { id: bot.id } })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('运行时')
    // 申请还在
    expect((await approve(grant.userCode)).status).toBe(200)
  })

  it('快到期时确认的留出取走的时间', async () => {
    const grant = await request()
    await database.db.update(deviceGrants).set({ expiresAt: sql`now() + interval '2 seconds'` })
    expect((await approve(grant.userCode)).status).toBe(200)
    const [row] = await database.db
      .select({ left: sql<number>`extract(epoch from ${deviceGrants.expiresAt} - now())::float` })
      .from(deviceGrants)
    expect(row!.left).toBeGreaterThan(50)
    expect((await poll(grant.deviceCode)).status).toBe('approved')
  })

  it('取走与删除应用同时进行不会互相卡死', async () => {
    for (let round = 0; round < 5; round++) {
      const grant = await request()
      await approve(grant.userCode, { app: { slug: `race-${round}`, name: 'x' } })
      const [target] = (await spaceApps()).filter((a) => a.slug === `race-${round}`)
      const [taken, removed] = await Promise.all([
        cli('/v1/device/token', { deviceCode: grant.deviceCode }),
        app.request(`/v1/spaces/${ws.spaceId}/apps/${target!.id}`, {
          method: 'DELETE',
          headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' },
        }),
      ])
      // 谁先谁后都行，但都不能是 500
      expect(taken.status, `第 ${round} 轮取走`).toBe(200)
      expect(removed.status, `第 ${round} 轮删除`).toBeLessThan(500)
    }
  })

  it('轮询得太勤回 429，不影响之后取走', async () => {
    const grant = await request()
    expect(await poll(grant.deviceCode)).toEqual({ status: 'pending' })
    expect((await cli('/v1/device/token', { deviceCode: grant.deviceCode })).status).toBe(429)
    await approve(grant.userCode)
    // 确认之后不用等
    expect((await poll(grant.deviceCode)).status).toBe('approved')
  })

  describe('一次申请几个平台', () => {
    const PLATFORMS = [
      { runtimeFamily: 'codex', clientName: 'work' },
      { runtimeFamily: 'pi' },
      { runtimeFamily: 'hermes' },
    ]
    async function requestMany(platforms: unknown[] = PLATFORMS, clientName = 'mac') {
      const res = await cli('/v1/device/authorize', { platforms, clientName })
      expect(res.status).toBe(201)
      return (await res.json()) as DeviceAuthorization
    }
    const item = (runtimeFamily: string, extra: Record<string, unknown> = {}) => ({
      runtimeFamily,
      app: { slug: `${runtimeFamily}-mac`, name: `${runtimeFamily} · mac` },
      keyName: 'mac',
      scopes: SCOPES,
      ...extra,
    })
    const approveMany = (userCode: string, items: unknown[], cookie: string = ws.cookie) =>
      web('/v1/device/grants/approve', cookie, { userCode, spaceId: ws.spaceId, items })
    const many = (result: DeviceTokenResponse) => {
      if (result.status !== 'approved' || !('keys' in result)) {
        throw new Error(`没有取到：${JSON.stringify(result)}`)
      }
      return result.keys
    }

    it('查看、确认一次、取走：每个平台一项，顺序和申请的一样，取消勾选的是 skipped', async () => {
      const hermes = await ws.createApp('hermes-old', { runtimeFamily: 'hermes' })
      const grant = await requestMany()
      expect(await poll(grant.deviceCode)).toEqual({ status: 'pending' })
      const seen = await web('/v1/device/grants/lookup', ws.cookie, { userCode: grant.userCode })
      expect((await seen.json()) as DeviceGrantInfo).toMatchObject({
        platforms: [
          { runtimeFamily: 'codex', clientName: 'work' },
          { runtimeFamily: 'pi', clientName: null },
          { runtimeFamily: 'hermes', clientName: null },
        ],
        clientName: 'mac',
      })

      // 顺序不必和申请一致：按运行时对上
      const res = await approveMany(grant.userCode, [
        item('hermes', { app: { id: hermes.id }, keyName: 'mac hermes' }),
        { runtimeFamily: 'pi', skip: true },
        item('codex'),
      ])
      expect(res.status).toBe(200)
      expect(
        ((await res.json()) as DeviceGrantApproved).items.map((i) => [i.runtimeFamily, i.app.slug]),
      ).toEqual([
        ['codex', 'codex-mac'],
        ['hermes', 'hermes-old'],
      ])
      expect(await keys()).toHaveLength(0)

      await rewind()
      const result = await poll(grant.deviceCode)
      const issued = many(result)
      expect(issued.map((k) => [k.runtimeFamily, k.status])).toEqual([
        ['codex', 'issued'],
        ['pi', 'skipped'],
        ['hermes', 'issued'],
      ])
      for (const k of issued) {
        if (k.status !== 'issued') continue
        const who = await app.request('/v1/whoami', { headers: bearer(k.key) })
        expect(who.status).toBe(200)
      }
      expect(issued[0]).toMatchObject({ app: { slug: 'codex-mac', runtimeFamily: 'codex' } })
      expect(issued[2]).toMatchObject({ app: { slug: 'hermes-old', runtimeFamily: 'hermes' } })
      expect((await keys()).map((k) => k.name).sort()).toEqual(['mac', 'mac hermes'])
      expect(JSON.stringify(await keys())).not.toContain((issued[0] as { key: string }).key)
      expect(await grants()).toHaveLength(0)
      expect(await poll(grant.deviceCode)).toEqual({ status: 'expired' })
    })

    it('申请：两种写法二选一，平台 1 到 8 个、运行时不重复', async () => {
      for (const body of [
        { runtimeFamily: 'codex', platforms: [{ runtimeFamily: 'pi' }] },
        { clientName: 'mac' },
        { platforms: [] },
        { platforms: [{ runtimeFamily: 'pi' }, { runtimeFamily: 'pi', clientName: 'x' }] },
        { platforms: [{ runtimeFamily: 'nope' }] },
        { platforms: [{ runtimeFamily: 'pi', clientName: 'a\nb' }] },
        {
          platforms: [
            'claudecode',
            'codex',
            'openclaw',
            'hermes',
            'opencode',
            'pi',
            'dsh',
            'astrbot',
            'mcp',
          ].map((runtimeFamily) => ({ runtimeFamily })),
        },
      ]) {
        expect((await cli('/v1/device/authorize', body)).status, JSON.stringify(body)).toBe(400)
      }
      await requestMany([{ runtimeFamily: 'pi' }])
    })

    it('确认：每个平台恰好一项、至少一项不跳过；不合规则时整体不确认，申请还在', async () => {
      const grant = await requestMany()
      const skip = (runtimeFamily: string) => ({ runtimeFamily, skip: true })
      for (const items of [
        // 少一项
        [item('codex'), item('pi')],
        // 多一项
        [item('codex'), item('pi'), item('hermes'), item('mcp')],
        // 同一个平台两项
        [item('codex'), item('pi'), item('pi', { app: { slug: 'pi-2', name: 'x' } })],
        // 全部跳过
        [skip('codex'), skip('pi'), skip('hermes')],
      ]) {
        expect((await approveMany(grant.userCode, items)).status).toBe(400)
      }
      // 编辑者给不了机密级：指出是哪个平台，一个应用都不建
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const refused = await approveMany(
        grant.userCode,
        [
          item('codex'),
          item('pi', { scopes: { ...SCOPES, maxSensitivity: 'secret' } }),
          skip('hermes'),
        ],
        bob.cookie,
      )
      expect(refused.status).toBe(403)
      const problem = (await refused.json()) as DeviceGrantProblem
      expect(problem.runtimeFamily).toBe('pi')
      expect(problem.error).toMatch(/^Pi：/)
      expect(await spaceApps()).toHaveLength(0)
      expect(
        (await approveMany(grant.userCode, [item('codex'), skip('pi'), skip('hermes')])).status,
      ).toBe(200)
    })

    it('新建应用的标识被占用时回 409 并指出是哪一项，前面新建的应用不留下', async () => {
      await ws.createApp('pi-mac', { runtimeFamily: 'pi' })
      const grant = await requestMany()
      const res = await approveMany(grant.userCode, [item('codex'), item('pi'), item('hermes')])
      expect(res.status).toBe(409)
      const problem = (await res.json()) as DeviceGrantProblem
      expect(problem).toMatchObject({ runtimeFamily: 'pi' })
      expect(problem.error).toContain('pi-mac')
      // codex 那一项先建了应用，跟着回滚
      expect((await spaceApps()).map((a) => a.slug)).toEqual(['pi-mac'])
      // 同一个请求里两项用同一个标识也是 409
      const twice = await approveMany(grant.userCode, [
        item('codex', { app: { slug: 'same', name: 'x' } }),
        item('pi', { app: { slug: 'same', name: 'x' } }),
        item('hermes'),
      ])
      expect(twice.status).toBe(409)
      expect(((await twice.json()) as DeviceGrantProblem).runtimeFamily).toBe('pi')
      // 已有的应用运行时对不上也指出是哪一项
      const [pi] = await spaceApps()
      const mismatch = await approveMany(grant.userCode, [
        item('codex', { app: { id: pi!.id } }),
        { runtimeFamily: 'pi', skip: true },
        { runtimeFamily: 'hermes', skip: true },
      ])
      expect(mismatch.status).toBe(409)
      expect(((await mismatch.json()) as DeviceGrantProblem).runtimeFamily).toBe('codex')
      expect(
        (
          await approveMany(grant.userCode, [
            item('codex'),
            item('pi', { app: { slug: 'pi-mac-2', name: 'x' } }),
            item('hermes'),
          ])
        ).status,
      ).toBe(200)
    })

    it('取走时逐项再核对：降级后超出范围的那一项 denied，别的照常签发', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
      const grant = await requestMany()
      const res = await approveMany(
        grant.userCode,
        [
          item('codex', { scopes: { ...SCOPES, credentials: 'use' } }),
          item('pi'),
          { runtimeFamily: 'hermes', skip: true },
        ],
        bob.cookie,
      )
      expect(res.status).toBe(200)
      await database.db
        .update(spaceMembers)
        .set({ role: 'editor' })
        .where(eq(spaceMembers.accountId, bob.accountId))
      const result = many(await poll(grant.deviceCode))
      expect(result).toEqual([
        { runtimeFamily: 'codex', status: 'denied', reason: DEVICE_KEY_DENIALS.role },
        expect.objectContaining({ runtimeFamily: 'pi', status: 'issued' }),
        { runtimeFamily: 'hermes', status: 'skipped' },
      ])
      expect(await keys()).toHaveLength(1)
    })

    it('确认之后应用所有者被停用：每一项都是 denied，不签发', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
      const grant = await requestMany()
      await approveMany(grant.userCode, [item('codex'), item('pi'), item('hermes')], bob.cookie)
      await database.db
        .update(accounts)
        .set({ disabledAt: new Date() })
        .where(eq(accounts.id, bob.accountId))
      const result = many(await poll(grant.deviceCode))
      expect(result.map((k) => k.status)).toEqual(['denied', 'denied', 'denied'])
      expect(
        result.every((k) => k.status === 'denied' && k.reason === DEVICE_KEY_DENIALS.member),
      ).toBe(true)
      expect(await keys()).toHaveLength(0)
      expect(await grants()).toHaveLength(0)
    })

    it('确认之后删掉其中一个应用：那一项 denied，别的平台不受连累', async () => {
      const grant = await requestMany()
      await approveMany(grant.userCode, [item('codex'), item('pi'), item('hermes')])
      const [pi] = (await spaceApps()).filter((a) => a.slug === 'pi-mac')
      const removed = await app.request(`/v1/spaces/${ws.spaceId}/apps/${pi!.id}`, {
        method: 'DELETE',
        headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' },
      })
      expect(removed.status).toBeLessThan(300)
      const result = many(await poll(grant.deviceCode))
      expect(result.map((k) => k.status)).toEqual(['issued', 'denied', 'issued'])
      expect(result[1]).toMatchObject({ reason: DEVICE_KEY_DENIALS.app })
    })

    it('同时来的两次轮询只有一次取得到；取走与删除应用同时进行不会互相卡死', async () => {
      const grant = await requestMany()
      await approveMany(grant.userCode, [item('codex'), item('pi'), item('hermes')])
      const results = await Promise.all([poll(grant.deviceCode), poll(grant.deviceCode)])
      expect(results.map((r) => r.status).sort()).toEqual(['approved', 'expired'])
      expect(await keys()).toHaveLength(3)

      for (let round = 0; round < 5; round++) {
        const next = await requestMany()
        const items = ['codex', 'pi', 'hermes'].map((rf) =>
          item(rf, { app: { slug: `${rf}-race-${round}`, name: 'x' } }),
        )
        expect((await approveMany(next.userCode, items)).status).toBe(200)
        const targets = (await spaceApps()).filter((a) => a.slug.endsWith(`-race-${round}`))
        const [taken, ...removed] = await Promise.all([
          cli('/v1/device/token', { deviceCode: next.deviceCode }),
          ...targets.map((target) =>
            app.request(`/v1/spaces/${ws.spaceId}/apps/${target.id}`, {
              method: 'DELETE',
              headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' },
            }),
          ),
        ])
        expect(taken!.status, `第 ${round} 轮取走`).toBe(200)
        for (const res of removed) expect(res.status, `第 ${round} 轮删除`).toBeLessThan(500)
      }
    })

    it('申请的上限照旧：几个平台的申请按一条算', async () => {
      const proxied = createApp({ ...deps, trustedProxies: 1 })
      const from = () =>
        proxied.request('/v1/device/authorize', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
          body: JSON.stringify({ platforms: PLATFORMS }),
        })
      for (let i = 0; i < 10; i++) expect((await from()).status).toBe(201)
      expect((await from()).status).toBe(429)
      expect(await grants()).toHaveLength(10)
    })
  })
})
