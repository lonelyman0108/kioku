import { MeResponse, SessionsResponse, SetupStatusResponse } from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  clearLoginFailures,
  refundLoginAttempt,
  reserveLoginAttempt,
  resetLoginLimitsForTest,
} from '../rateLimit'
import { SetupGate } from '../setupCode'
import type { Database } from '../../db/client'
import type { SetupHost } from '../../http/env'
import {
  createTestApp,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'

function extractCookies(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]!)
}

function cookieHeader(cookies: string[]): string {
  return cookies.join('; ')
}

function createFakeSetupHost(code: string): SetupHost {
  const gate = new SetupGate(code)
  gate.open()
  return {
    gate,
    masterKey: true,
    migrationsFolder: '',
    database: () => ({ state: 'ready', source: 'env', url: testDatabaseUrl!, check: null }),
    activate: async () => 'switched' as const,
    exclusive: async (fn) => fn(),
  }
}

describe.skipIf(!testDatabaseUrl)('单人初始化、会话鉴权与限流', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    resetLoginLimitsForTest()
  })

  afterAll(async () => {
    await database.close()
  })

  it('完成首次初始化（兼容忽略 spaceName）、锁死二次初始化并支持登录/改名/改密/会话吊销', async () => {
    const setupCode = 'TEST-SETUP-CODE-0001'
    const app = createTestApp(database, {
      masterKey: testMasterKey(),
      setup: createFakeSetupHost(setupCode),
    })

    const statusBefore = SetupStatusResponse.parse(
      await (await app.request('/v1/setup/status')).json(),
    )
    expect(statusBefore.needsSetup).toBe(true)

    // 错误初始化码返回 403
    const badCode = await app.request('/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setupCode: 'WRONG',
        username: 'owner',
        displayName: 'Owner',
        password: 'correct horse battery',
      }),
    })
    expect(badCode.status).toBe(403)

    // 正确初始化码 + 兼容字段 spaceName，返回 201 且自动种下会话 Cookie
    const setupRes = await app.request('/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setupCode,
        username: 'owner',
        displayName: 'Owner',
        password: 'correct horse battery',
        spaceName: 'ignored-legacy-space',
      }),
    })
    expect(setupRes.status).toBe(201)
    const me = MeResponse.parse(await setupRes.json())
    expect(me.username).toBe('owner')
    expect(me.displayName).toBe('Owner')
    expect(me.hasMasterKey).toBe(true)
    const session1Cookies = extractCookies(setupRes)
    expect(session1Cookies.some((c) => c.startsWith('kioku_session='))).toBe(true)
    expect(session1Cookies.some((c) => c.startsWith('kioku_device='))).toBe(true)

    // 二次初始化被锁死返回 409
    const secondSetup = await app.request('/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setupCode,
        username: 'other',
        displayName: 'Other',
        password: 'correct horse battery',
      }),
    })
    expect(secondSetup.status).toBe(409)

    const statusAfter = SetupStatusResponse.parse(
      await (await app.request('/v1/setup/status')).json(),
    )
    expect(statusAfter.needsSetup).toBe(false)

    // 跨站无同源头写请求被 CSRF 拦截返回 403
    const csrfBlocked = await app.request('/v1/auth/me', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(session1Cookies),
      },
      body: JSON.stringify({ displayName: 'Blocked' }),
    })
    expect(csrfBlocked.status).toBe(403)

    // PATCH /v1/auth/me 更新显示名称
    const patched = await app.request('/v1/auth/me', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        cookie: cookieHeader(session1Cookies),
      },
      body: JSON.stringify({ displayName: 'New Name' }),
    })
    expect(patched.status).toBe(200)
    expect(MeResponse.parse(await patched.json()).displayName).toBe('New Name')

    // 第二个客户端登录，形成两个活跃会话
    const login2 = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'SecondBrowser/1.0' },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery' }),
    })
    expect(login2.status).toBe(200)
    const session2Cookies = extractCookies(login2)

    const sessionsBefore = SessionsResponse.parse(
      await (
        await app.request('/v1/auth/sessions', {
          headers: { cookie: cookieHeader(session2Cookies) },
        })
      ).json(),
    )
    expect(sessionsBefore.items).toHaveLength(2)
    expect(sessionsBefore.items.filter((s) => s.current)).toHaveLength(1)

    // 修改密码后自动吊销其余会话，只保留当前会话
    const changePw = await app.request('/v1/auth/password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        cookie: cookieHeader(session2Cookies),
      },
      body: JSON.stringify({
        currentPassword: 'correct horse battery',
        newPassword: 'new stronger passphrase',
      }),
    })
    expect(changePw.status).toBe(204)

    // 旧会话已被吊销
    const oldMe = await app.request('/v1/auth/me', {
      headers: { cookie: cookieHeader(session1Cookies) },
    })
    expect(oldMe.status).toBe(401)

    // 当前会话依然有效，且仅剩 1 条会话
    const sessionsAfter = SessionsResponse.parse(
      await (
        await app.request('/v1/auth/sessions', {
          headers: { cookie: cookieHeader(session2Cookies) },
        })
      ).json(),
    )
    expect(sessionsAfter.items).toHaveLength(1)

    // 退出登录
    const logout = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: {
        'sec-fetch-site': 'same-origin',
        cookie: cookieHeader(session2Cookies),
      },
    })
    expect(logout.status).toBe(204)

    const afterLogout = await app.request('/v1/auth/me', {
      headers: { cookie: cookieHeader(session2Cookies) },
    })
    expect(afterLogout.status).toBe(401)
  })

  it('登录失败限流生效，但已登录过的受信设备 Cookie 不被外部刷错锁死', async () => {
    const app = createTestApp(database, {
      masterKey: testMasterKey(),
      trustedProxies: 1,
    })

    const setupRes = await app.request('/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setupCode: 'ANY',
        username: 'owner',
        displayName: 'Owner',
        password: 'correct horse battery',
      }),
    })
    expect(setupRes.status).toBe(201)
    const trustedDeviceCookie = extractCookies(setupRes).find((c) => c.startsWith('kioku_device='))!
    expect(trustedDeviceCookie).toBeTruthy()

    // 陌生客户端连续 10 次输错触发本客户端限流 429
    for (let i = 0; i < 10; i++) {
      const bad = await app.request('/v1/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.10',
        },
        body: JSON.stringify({ username: 'owner', password: 'wrong password 123' }),
      })
      expect(bad.status).toBe(401)
    }

    const blocked = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.10',
      },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery' }),
    })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()

    // 再从另外 2 个来源刷满 30 次合计上限，新的陌生客户端也会被合计限流拦住
    for (const ip of ['203.0.113.11', '203.0.113.12']) {
      for (let i = 0; i < 10; i++) {
        await app.request('/v1/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({ username: 'owner', password: 'wrong password 123' }),
        })
      }
    }
    const totalBlocked = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.88' },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery' }),
    })
    expect(totalBlocked.status).toBe(429)

    // 另一台携带受信设备 Cookie 的合法终端越过合计上限，仍能成功登录
    const trustedLogin = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.99',
        cookie: trustedDeviceCookie,
      },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery' }),
    })
    expect(trustedLogin.status).toBe(200)
  })

  it('未知用户名走恒定等待填充防时序探测，改密失败同样受限流保护，预扣/退还原子生效', async () => {
    // 1) 原子预扣与繁忙退还单元测试：连续 10 次预扣后第 11 次立刻被拒，退还 1 次后恢复 1 个名额
    resetLoginLimitsForTest()
    for (let i = 0; i < 10; i++) {
      expect(reserveLoginAttempt('alice', 'ip:198.51.100.1').limited).toBe(false)
    }
    expect(reserveLoginAttempt('alice', 'ip:198.51.100.1').limited).toBe(true)
    refundLoginAttempt('alice', 'ip:198.51.100.1')
    expect(reserveLoginAttempt('alice', 'ip:198.51.100.1').limited).toBe(false)
    clearLoginFailures('alice', 'ip:198.51.100.1')
    expect(reserveLoginAttempt('alice', 'ip:198.51.100.1').limited).toBe(false)
    resetLoginLimitsForTest()

    const app = createTestApp(database, {
      masterKey: testMasterKey(),
      trustedProxies: 1,
    })

    const setupRes = await app.request('/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setupCode: 'ANY',
        username: 'owner',
        displayName: 'Owner',
        password: 'correct horse battery',
      }),
    })
    expect(setupRes.status).toBe(201)
    const sessionCookies = extractCookies(setupRes)

    // 2) 不存在的用户名登录：不应在 0ms 内秒回，走恒定填充等待（至少 60ms）
    const t0 = Date.now()
    const missing = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.50',
      },
      body: JSON.stringify({ username: 'nonexistent', password: 'some password 123' }),
    })
    const elapsed = Date.now() - t0
    expect(missing.status).toBe(401)
    expect(elapsed).toBeGreaterThanOrEqual(60)

    // 3) POST /v1/auth/password 连续输错当前密码 10 次后触发 429 限流并携带 Retry-After
    for (let i = 0; i < 10; i++) {
      const badPw = await app.request('/v1/auth/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          'x-forwarded-for': '203.0.113.60',
          cookie: cookieHeader(sessionCookies),
        },
        body: JSON.stringify({
          currentPassword: 'wrong current pass',
          newPassword: 'another long password',
        }),
      })
      expect(badPw.status).toBe(401)
    }

    const pwBlocked = await app.request('/v1/auth/password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'x-forwarded-for': '203.0.113.60',
        cookie: cookieHeader(sessionCookies),
      },
      body: JSON.stringify({
        currentPassword: 'correct horse battery',
        newPassword: 'another long password',
      }),
    })
    expect(pwBlocked.status).toBe(429)
    expect(pwBlocked.headers.get('retry-after')).toBeTruthy()
  })
})
