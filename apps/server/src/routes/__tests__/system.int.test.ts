import { randomBytes } from 'node:crypto'

import { SpaceOverview, SystemInfo } from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import type { Database } from '../../db/client'
import { settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { settleUpdateChecks } from '../../settings/updateCheck'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { BUILD } from '../../version'

describe.skipIf(!testDatabaseUrl)('系统信息', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  // GitHub 的回应：每次请求记一次
  let release: (signal: AbortSignal) => Response | Promise<Response>
  const fetches: string[] = []
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetches.push(String(input))
    return release(init!.signal!)
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
    await settleUpdateChecks()
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

  // 打开一次页面（到了间隔时开始检查），等后台的检查写完再读
  const settled = async () => {
    await info()
    await settleUpdateChecks()
    return (await info()).updates
  }
  // 把上一次尝试（与完成）的时间往前挪
  const age = (interval: string) =>
    database.db.execute(sql`
      update settings set value = value
        || jsonb_build_object('attemptedAt', now() - ${interval}::interval)
        || case when value ? 'checkedAt' then jsonb_build_object('checkedAt', now() - ${interval}::interval) else '{}'::jsonb end
      where key = 'update-check-state'`)

  it('检查新版本默认关闭，不向 GitHub 发请求', async () => {
    expect((await info()).updates).toEqual({
      enabled: false,
      applicable: true,
      checking: false,
      checkedAt: null,
      attemptedAt: null,
      failed: false,
      latest: null,
      available: null,
    })
    expect((await overview()).update).toBeNull()
    expect(fetches).toEqual([])
  })

  it('打开后在后台查，不等 GitHub；有新的正式版时系统信息与概览都提示，只给实例管理员', async () => {
    let answer!: () => void
    release = () => new Promise((resolve) => (answer = () => resolve(releaseOf('v0.2.0'))))
    const res = await toggle(true)
    expect(res.status).toBe(200)
    // 返回整份系统信息：请求还没回来，诊断信息里的开关已经是开着的
    const body = SystemInfo.parse(await res.json())
    expect(body.updates).toMatchObject({ enabled: true, checking: true, latest: null })
    expect(body.diagnostics).toContain('检查新版本：开启')
    expect(fetches).toEqual(['https://api.github.com/repos/lonelyman0108/kioku/releases/latest'])
    answer()
    const notice = {
      version: '0.2.0',
      url: 'https://github.com/lonelyman0108/kioku/releases/tag/v0.2.0',
    }
    expect(await settled()).toMatchObject({
      enabled: true,
      checking: false,
      failed: false,
      latest: '0.2.0',
      available: notice,
    })
    expect((await overview()).update).toEqual(notice)
    const viewer = await addMember(database.db, ws.spaceId, 'carol', 'viewer')
    expect((await overview(viewer.cookie)).update).toBeNull()
    // 一天之内打开页面、概览都不再请求
    await info()
    await overview()
    await settleUpdateChecks()
    expect(fetches).toHaveLength(1)
    // 关掉之后不提示
    await toggle(false)
    expect((await overview()).update).toBeNull()
    expect((await info()).updates.available).toBeNull()
  })

  it('关了再开马上再查一次', async () => {
    await toggle(true)
    await settled()
    await toggle(false)
    await toggle(true)
    await settled()
    expect(fetches).toHaveLength(2)
    // 开着时再存一次开着不算从关到开
    await toggle(true)
    await settled()
    expect(fetches).toHaveLength(2)
  })

  it('成功之后隔一天再查；预发布、不是正式版的回应不抹掉已知的正式版', async () => {
    await toggle(true)
    expect((await settled()).latest).toBe('0.2.0')

    await age('23 hours')
    await settled()
    expect(fetches).toHaveLength(1)

    await age('25 hours')
    release = () => releaseOf('v0.3.0-rc.1', { prerelease: true })
    expect(await settled()).toMatchObject({ latest: '0.2.0', failed: false })

    await age('25 hours')
    release = () => releaseOf('nightly')
    expect(await settled()).toMatchObject({ latest: '0.2.0', failed: false })

    await age('25 hours')
    release = () => releaseOf('0.1.0')
    expect(await settled()).toMatchObject({ latest: '0.1.0', available: null })
    expect(fetches).toHaveLength(4)
  })

  it('失败之后隔一小时再查，留着已知的结果；日志不带响应正文', async () => {
    await toggle(true)
    await settled()
    await age('25 hours')
    release = () => new Response('<html>rate limited</html>', { status: 403 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await settled()).toMatchObject({ latest: '0.2.0', failed: true })
      expect(String(warn.mock.calls[0])).not.toContain('rate limited')
    } finally {
      warn.mockRestore()
    }
    await age('30 minutes')
    await settled()
    expect(fetches).toHaveLength(2)
    await age('61 minutes')
    release = () => releaseOf('v0.2.1')
    expect(await settled()).toMatchObject({ latest: '0.2.1', failed: false })
    expect(fetches).toHaveLength(3)
  })

  it('超时与连不上分开说', async () => {
    const timed = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: null,
      embedder: staticEmbedderSource(null),
      jobs: null,
      updateCheck: { fetch: fakeFetch, current: '0.1.0', timeoutMs: 20 },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      release = (signal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
      await timed.request(
        '/v1/instance/update-check',
        jsonRequest('PUT', { enabled: true }, { cookie: ws.cookie }),
      )
      await settleUpdateChecks()
      expect(String(warn.mock.calls.at(-1))).toContain('秒内未返回')

      await age('2 hours')
      release = () =>
        Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))
      await timed.request('/v1/instance/system', { headers: { cookie: ws.cookie } })
      await settleUpdateChecks()
      expect(String(warn.mock.calls.at(-1))).toContain('无法连接GitHub（ECONNREFUSED）')
    } finally {
      warn.mockRestore()
    }
  })

  it('尝试了却没有完成（服务中途停了）：一分钟内算正在检查，之后按失败显示，隔一小时再查', async () => {
    await database.db.execute(sql`
      insert into settings (key, value) values ('update-check', '{"enabled": true}'::jsonb),
        ('update-check-state', jsonb_build_object('attemptedAt', now()))`)
    expect((await info()).updates).toMatchObject({ checking: true, failed: false })
    await age('5 minutes')
    expect((await info()).updates).toMatchObject({ checking: false, failed: true })
    expect(fetches).toEqual([])
    await age('61 minutes')
    expect(await settled()).toMatchObject({ checking: false, failed: false, latest: '0.2.0' })
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
    expect(SystemInfo.parse(await res.json()).updates).toMatchObject({
      enabled: true,
      applicable: false,
      checking: false,
      checkedAt: null,
    })
    await settleUpdateChecks()
    expect(fetches).toEqual([])
  })
})
