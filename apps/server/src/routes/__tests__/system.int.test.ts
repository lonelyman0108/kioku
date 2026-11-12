import { randomBytes } from 'node:crypto'

import { SpaceOverview, SystemInfo, UpdateCheckView } from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import type { Database } from '../../db/client'
import { settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { BUILD } from '../../version'

describe.skipIf(!testDatabaseUrl)('系统信息', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  // GitHub 的回应：每次请求记一次
  let release: () => Response
  const fetches: string[] = []
  const fakeFetch = (async (input: string | URL | Request) => {
    fetches.push(String(input))
    return release()
  }) as typeof fetch
  const releaseOf = (tag: string, extra: Record<string, unknown> = {}) =>
    Response.json({ tag_name: tag, draft: false, prerelease: false, ...extra })

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
      trustedProxies: 1,
      updateCheck: { fetch: fakeFetch, current: '0.1.0' },
    })
  })
  afterAll(async () => {
    if (!database) return
    await database.db.execute(sql`delete from settings where key like 'update-check%'`)
    await database.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.execute(sql`delete from settings where key like 'update-check%'`)
    fetches.length = 0
    release = () => releaseOf('v0.2.0')
    ws = await bootstrap(app)
  })

  const get = (path: string, cookie = ws.cookie) =>
    app.request(`/v1${path}`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
  const info = async () => {
    const res = await get('/instance/system')
    expect(res.status).toBe(200)
    return SystemInfo.parse(await res.json())
  }
  const toggle = async (enabled: boolean, cookie = ws.cookie) =>
    app.request('/v1/instance/update-check', jsonRequest('PUT', { enabled }, { cookie }))
  const overview = async (cookie = ws.cookie) =>
    SpaceOverview.parse(await (await get(`/spaces/${ws.spaceId}/overview`, cookie)).json())

  it('只给实例管理员：别的成员 403', async () => {
    const owner = await addMember(database.db, ws.spaceId, 'bob', 'owner')
    expect((await get('/instance/system', owner.cookie)).status).toBe(403)
    expect((await toggle(true, owner.cookie)).status).toBe(403)
    expect(
      await database.db.select().from(settings).where(eq(settings.key, 'update-check')),
    ).toEqual([])
  })

  it('四组都有，诊断信息不含库名、主机与主密钥标识', async () => {
    const body = await info()
    expect(body.build).toEqual(BUILD)
    expect(body.runtime.node).toBe(process.version)
    expect(body.runtime.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(body.database.version).toMatch(/^\d+/)
    expect(body.database.pgvector).toMatch(/^\d+\./)
    expect(body.database.zhparser).toMatch(/^\d+\./)
    expect(body.database.migration).toMatch(/^\d{4}_/)
    const url = new URL(testDatabaseUrl!)
    expect(body.database.name).toBe(url.pathname.slice(1))
    expect(body.database.host).toContain(url.hostname)
    expect(body.database.host).not.toContain(url.username)
    expect(body.config).toMatchObject({
      masterKey: { configured: true, rotating: false },
      cookieSecure: false,
      trustedProxies: 1,
      webUi: 'off',
      jobs: false,
      embedding: false,
      extraction: false,
    })
    expect(body.config.masterKey.id).toMatch(/^[0-9a-f]{16}$/)
    expect(body.diagnostics).toContain(`版本：${BUILD.version}`)
    for (const hidden of [body.database.name!, url.hostname, body.config.masterKey.id!]) {
      expect(body.diagnostics).not.toContain(hidden)
    }
  })

  it('检查新版本默认关闭，不向 GitHub 发请求', async () => {
    expect((await info()).updates).toEqual({
      enabled: false,
      applicable: true,
      checkedAt: null,
      failed: false,
      latest: null,
      available: null,
    })
    expect((await overview()).update).toBeNull()
    expect(fetches).toEqual([])
  })

  it('打开后查一次，一天之内不再请求；有新的正式版时系统信息与概览都提示，只给实例管理员', async () => {
    const res = await toggle(true)
    expect(res.status).toBe(200)
    const notice = {
      version: '0.2.0',
      url: 'https://github.com/lonelyman0108/kioku/releases/tag/v0.2.0',
    }
    expect(UpdateCheckView.parse(await res.json())).toMatchObject({
      enabled: true,
      failed: false,
      latest: '0.2.0',
      available: notice,
    })
    expect(fetches).toEqual(['https://api.github.com/repos/lonelyman0108/kioku/releases/latest'])
    expect((await info()).updates.available).toEqual(notice)
    expect((await overview()).update).toEqual(notice)
    const viewer = await addMember(database.db, ws.spaceId, 'carol', 'viewer')
    expect((await overview(viewer.cookie)).update).toBeNull()
    await toggle(false)
    await toggle(true)
    expect(fetches).toHaveLength(1)
    // 关掉之后不提示
    await toggle(false)
    expect((await overview()).update).toBeNull()
    expect((await info()).updates.available).toBeNull()
  })

  it('过了一天再查；预发布、同一版本不提示；失败只记下失败，留着上一次的结果', async () => {
    const ageCheck = () =>
      database.db.execute(sql`
        update settings set value = jsonb_set(value, '{attemptedAt}', to_jsonb(now() - interval '25 hours'))
        where key = 'update-check-state'`)
    await toggle(true)
    expect((await info()).updates.latest).toBe('0.2.0')

    await ageCheck()
    release = () => releaseOf('v0.3.0-rc.1', { prerelease: true })
    expect((await info()).updates).toMatchObject({ latest: null, available: null, failed: false })

    await ageCheck()
    release = () => releaseOf('0.1.0')
    expect((await info()).updates).toMatchObject({ latest: '0.1.0', available: null })

    await ageCheck()
    release = () => new Response('<html>rate limited</html>', { status: 403 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await info()).updates).toMatchObject({ latest: '0.1.0', failed: true })
      expect(String(warn.mock.calls[0])).not.toContain('rate limited')
    } finally {
      warn.mockRestore()
    }
    expect(fetches).toHaveLength(4)
  })

  it('当前不是正式版时不请求', async () => {
    const dev = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: null,
      embedder: staticEmbedderSource(null),
      jobs: null,
      updateCheck: { fetch: fakeFetch, current: 'dev' },
    })
    const res = await dev.request(
      '/v1/instance/update-check',
      jsonRequest('PUT', { enabled: true }, { cookie: ws.cookie }),
    )
    expect(UpdateCheckView.parse(await res.json())).toMatchObject({
      enabled: true,
      applicable: false,
      checkedAt: null,
    })
    expect(fetches).toEqual([])
  })
})
