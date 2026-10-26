import { LAYERS, type CreatedKey, type Me } from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { staticEmbedderSource } from '../../embedding/source'
import type { Database } from '../../db/client'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'

const setupBody = {
  username: 'alice',
  displayName: 'Alice',
  password: 'correct horse battery',
  spaceName: '家',
}

describe.skipIf(!testDatabaseUrl)('初始化、登录与 API Key', () => {
  let database: Database
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: null,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
  })

  // 模拟浏览器的同源请求
  const sameSite = { 'sec-fetch-site': 'same-origin' }
  const json = (method: string, body: unknown, cookie?: string) => ({
    method,
    headers: { 'content-type': 'application/json', ...sameSite, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!

  async function setup() {
    const res = await app.request('/v1/setup', json('POST', setupBody))
    expect(res.status).toBe(201)
    return { cookie: cookieOf(res), me: (await res.json()) as Me }
  }

  it('首次初始化只能做一次', async () => {
    expect(await (await app.request('/v1/setup/status')).json()).toEqual({ needsSetup: true })
    await setup()
    expect(await (await app.request('/v1/setup/status')).json()).toEqual({ needsSetup: false })
    const again = await app.request('/v1/setup', json('POST', { ...setupBody, username: 'bob' }))
    expect(again.status).toBe(409)
  })

  it('初始化后带 Cookie 能取到自己和空间', async () => {
    const { cookie, me } = await setup()
    expect(me.spaces).toHaveLength(1)
    const res = await app.request('/v1/auth/me', { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Me).username).toBe('alice')
  })

  it('密码错误返回 401，连续失败后锁定', async () => {
    await setup()
    for (let i = 0; i < 5; i++) {
      const res = await app.request(
        '/v1/auth/login',
        json('POST', { username: 'alice', password: 'wrong' }),
      )
      expect(res.status).toBe(401)
    }
    const locked = await app.request(
      '/v1/auth/login',
      json('POST', { username: 'alice', password: setupBody.password }),
    )
    expect(locked.status).toBe(429)
  })

  it('退出后 Cookie 失效', async () => {
    const { cookie } = await setup()
    const logout = { method: 'POST', headers: { cookie, ...sameSite } }
    expect((await app.request('/v1/auth/logout', logout)).status).toBe(204)
    expect((await app.request('/v1/auth/me', { headers: { cookie } })).status).toBe(401)
  })

  it('建应用、签发 Key、用 Key 访问、吊销后失效', async () => {
    const { cookie, me } = await setup()
    const spaceId = me.spaces[0]!.id
    const created = await app.request(
      `/v1/spaces/${spaceId}/apps`,
      json(
        'POST',
        { slug: 'claude-code', name: 'Claude Code', runtimeFamily: 'claudecode' },
        cookie,
      ),
    )
    expect(created.status).toBe(201)
    const appInfo = (await created.json()) as { id: string; ownerAccountId: string }
    expect(appInfo.ownerAccountId).toBe(me.id)

    const scopes = {
      readLayers: [...LAYERS],
      writeLayers: [...LAYERS],
      maxSensitivity: 'private',
      admin: false,
    }
    const keyRes = await app.request(
      `/v1/spaces/${spaceId}/apps/${appInfo.id}/keys`,
      json('POST', { name: '本机', scopes }, cookie),
    )
    expect(keyRes.status).toBe(201)
    const key = (await keyRes.json()) as CreatedKey
    expect(key.key).toMatch(/^kioku_/)

    const listed = await app.request(`/v1/spaces/${spaceId}/apps/${appInfo.id}/keys`, {
      headers: { cookie },
    })
    expect(JSON.stringify(await listed.json())).not.toContain(key.key)

    const bearer = { headers: { authorization: `Bearer ${key.key}` } }
    const who = await app.request('/v1/whoami', bearer)
    expect(who.status).toBe(200)
    expect(await who.json()).toMatchObject({ spaceId, app: { slug: 'claude-code' }, scopes })

    const revoked = await app.request(`/v1/spaces/${spaceId}/apps/${appInfo.id}/keys/${key.id}`, {
      method: 'DELETE',
      headers: { cookie, ...sameSite },
    })
    expect(revoked.status).toBe(204)
    expect((await app.request('/v1/whoami', bearer)).status).toBe(401)
  })

  it('应用标识重复返回 409', async () => {
    const { cookie, me } = await setup()
    const body = json('POST', { slug: 'bot', name: 'Bot', runtimeFamily: 'astrbot' }, cookie)
    expect((await app.request(`/v1/spaces/${me.spaces[0]!.id}/apps`, body)).status).toBe(201)
    expect((await app.request(`/v1/spaces/${me.spaces[0]!.id}/apps`, body)).status).toBe(409)
  })

  it('不是成员的空间一律 403', async () => {
    const { cookie } = await setup()
    const other = '00000000-0000-4000-8000-000000000000'
    const res = await app.request(
      `/v1/spaces/${other}/apps`,
      json('POST', { slug: 'x', name: 'X', runtimeFamily: 'mcp' }, cookie),
    )
    expect(res.status).toBe(403)
  })

  it('带 Cookie 的跨站写请求被拒绝', async () => {
    const { cookie } = await setup()
    const crossSite = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
    })
    expect(crossSite.status).toBe(403)
    const wrongOrigin = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example.com', host: 'kioku.example.com' },
    })
    expect(wrongOrigin.status).toBe(403)
    const rightOrigin = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://kioku.example.com', host: 'kioku.example.com' },
    })
    expect(rightOrigin.status).toBe(204)
  })

  it('格式错误或伪造的 Key 返回 401', async () => {
    await setup()
    for (const auth of ['', 'Bearer nope', `Bearer kioku_${'a'.repeat(12)}_${'b'.repeat(40)}`]) {
      expect((await app.request('/v1/whoami', { headers: { authorization: auth } })).status).toBe(
        401,
      )
    }
  })

  it('请求体校验失败返回 400 和中文提示', async () => {
    const res = await app.request('/v1/setup', json('POST', { ...setupBody, password: 'short' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('password')
  })
})
