import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DATABASE_UNAVAILABLE_CODE,
  type DatabaseCheck,
  type DatabaseConnection,
  type DatabaseInspection,
  type SetupStatus,
} from '@kioku/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig, type Config } from '../config'
import type { Database } from '../db/client'
import { summarize } from '../db/probe'
import { FatalStartupError, startRuntime, type Runtime } from '../runtime'
import { StartupError, startService } from '../service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../testing/db'

const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url))
const CODE = 'TEST-SETUP-CODE-0001'

// 测试库的连接，按表单的字段拆开
function testConnection(): DatabaseConnection {
  const s = summarize(testDatabaseUrl!)!
  const password = decodeURIComponent(new URL(testDatabaseUrl!).password)
  return {
    host: s.host,
    port: s.port,
    database: s.database,
    username: s.username,
    password,
    ssl: 'disable',
  }
}

const admin = {
  setupCode: CODE,
  username: 'alice',
  displayName: 'Alice',
  password: 'correct horse battery',
  spaceName: '家',
}

describe.skipIf(!testDatabaseUrl)('没有配置数据库时启动，在初始化页接上', () => {
  let database: Database
  let dataDir: string
  let runtime: Runtime | null = null

  const configFor = (env: Record<string, string> = {}): Config => ({
    ...loadConfig({ KIOKU_DATA_DIR: dataDir, KIOKU_SETUP_CODE: CODE, ...env }),
    migrationsFolder,
    webDir: '',
  })
  const call = (path: string, body?: unknown) =>
    runtime!.fetch(
      new Request(`http://localhost/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        // 不带同源请求头：初始化这几个接口靠初始化码保护，脚本化初始化也能用
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const status = async () => (await (await call('/setup/status')).json()) as SetupStatus

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    dataDir = await mkdtemp(join(tmpdir(), 'kioku-runtime-'))
  })
  afterEach(async () => {
    await runtime?.stop()
    runtime = null
    await rm(dataDir, { recursive: true, force: true })
  })

  it('只提供初始化：别的接口 503 带 code，健康检查照常，打印初始化码', async () => {
    const lines: string[] = []
    runtime = await startRuntime(configFor(), { log: (line) => lines.push(line) })
    expect(runtime.state()).toBe('missing')
    expect(lines.join('\n')).toContain(`初始化码：${CODE}`)
    expect(await status()).toEqual({
      needsSetup: true,
      database: { state: 'missing', source: null, failure: null },
      masterKey: false,
    })
    expect((await call('/health')).status).toBe(200)
    for (const path of ['/auth/me', '/spaces', '/openapi.json']) {
      const res = await call(path)
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ code: DATABASE_UNAVAILABLE_CODE })
    }
    // 建管理员要先接上数据库
    expect((await call('/setup', admin)).status).toBe(503)
    const inspected = (await (
      await call('/setup/database/inspect', { setupCode: CODE })
    ).json()) as DatabaseInspection
    expect(inspected).toEqual({ source: null, state: 'missing', summary: null, check: null })
  })

  it('初始化码错误被拒，同一客户端错 5 次之后限流，别的客户端不受影响', async () => {
    runtime = await startRuntime(configFor({ KIOKU_TRUSTED_PROXIES: '1' }), { log: () => {} })
    const from = (address: string, setupCode: string) =>
      runtime!.fetch(
        new Request('http://localhost/v1/setup/database/inspect', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
          body: JSON.stringify({ setupCode }),
        }),
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      )
    for (let i = 0; i < 5; i++) expect((await from('203.0.113.7', 'WRONG-CODE')).status).toBe(403)
    expect((await from('203.0.113.7', CODE)).status).toBe(429)
    // IPv6 按 /64 分桶：同一个 /64 换后缀也算同一个客户端
    for (let i = 0; i < 5; i++) {
      expect((await from(`2001:db8:1:2::${i + 1}`, 'WRONG-CODE')).status).toBe(403)
    }
    expect((await from('2001:db8:1:2::99', CODE)).status).toBe(429)
    // 没有全实例的合计上限：部署的人从别处照样能用
    expect((await from('198.51.100.1', CODE)).status).toBe(200)
  })

  it('检查：连不上、认证失败、库不存在只给类别', async () => {
    runtime = await startRuntime(configFor(), { log: () => {} })
    const conn = testConnection()
    const check = async (connection: DatabaseConnection) => {
      const res = await call('/setup/database/check', { setupCode: CODE, connection })
      expect(res.status).toBe(200)
      return (await res.json()) as DatabaseCheck
    }
    expect((await check({ ...conn, host: '127.0.0.1', port: 1 })).failure).toBe('unreachable')
    const wrong = await check({ ...conn, password: 'definitely-wrong' })
    expect(wrong.failure).toBe('auth_failed')
    expect(JSON.stringify(wrong)).not.toContain('definitely-wrong')
    expect((await check({ ...conn, database: 'kioku_no_such_db' })).failure).toBe(
      'database_missing',
    )
    const ok = await check(conn)
    expect(ok).toMatchObject({
      failure: null,
      role: { superuser: false, bypassRls: false },
      existing: 'kioku',
      accounts: 0,
      unrelatedTables: 0,
      ready: true,
    })
    expect(ok.extensions.every((e) => e.state === 'installed')).toBe(true)
  })

  it('保存后当场接上：写 kioku.json（600），能建管理员，之后初始化码作废；重启后从文件接上', async () => {
    runtime = await startRuntime(configFor(), { log: () => {} })
    const res = await call('/setup/database', { setupCode: CODE, connection: testConnection() })
    expect(res.status).toBe(200)
    expect(runtime.state()).toBe('ready')
    expect(await status()).toEqual({
      needsSetup: true,
      database: { state: 'ready', source: 'file', failure: null },
      masterKey: false,
    })
    const file = join(dataDir, 'kioku.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8')).databaseUrl).toContain('sslmode=disable')
    // 接上之后不能再改
    const again = await call('/setup/database', { setupCode: CODE, connection: testConnection() })
    expect(again.status).toBe(409)

    expect((await call('/setup', { ...admin, setupCode: 'WRONG-CODE' })).status).toBe(403)
    expect((await call('/setup', admin)).status).toBe(201)
    expect(runtime.gate.isOpen).toBe(false)
    expect((await status()).needsSetup).toBe(false)
    expect((await call('/setup/database/inspect', { setupCode: CODE })).status).toBe(409)

    await runtime.stop()
    runtime = await startRuntime(configFor(), { log: () => {} })
    expect(runtime.state()).toBe('ready')
    expect((await status()).database).toEqual({ state: 'ready', source: 'file', failure: null })
    // 有账号了，不打开初始化码
    expect(runtime.gate.isOpen).toBe(false)
  })

  it('检查没过的不保存、不接上', async () => {
    runtime = await startRuntime(configFor(), { log: () => {} })
    const res = await call('/setup/database', {
      setupCode: CODE,
      connection: { ...testConnection(), password: 'definitely-wrong' },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ failure: 'auth_failed' })
    expect(runtime.state()).toBe('missing')
    await expect(stat(join(dataDir, 'kioku.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('环境变量优先：照它接上，初始化页只显示、不能改，不写 kioku.json', async () => {
    runtime = await startRuntime(configFor({ DATABASE_URL: testDatabaseUrl! }), { log: () => {} })
    expect(runtime.state()).toBe('ready')
    expect(runtime.gate.isOpen).toBe(true)
    expect((await status()).database).toEqual({ state: 'ready', source: 'env', failure: null })
    const inspected = (await (
      await call('/setup/database/inspect', { setupCode: CODE })
    ).json()) as DatabaseInspection
    expect(inspected).toMatchObject({ source: 'env', state: 'ready', check: { ready: true } })
    expect(inspected.summary).toMatchObject({
      database: testConnection().database,
      passwordSet: true,
    })
    const check = await call('/setup/database/check', {
      setupCode: CODE,
      connection: testConnection(),
    })
    expect(check.status).toBe(409)
    expect((await call('/setup', admin)).status).toBe(201)
    await expect(stat(join(dataDir, 'kioku.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('配了的库暂时连不上：不当作要初始化、不开初始化码，健康检查 503，接口 503', async () => {
    const lines: string[] = []
    const config = configFor({ DATABASE_URL: 'postgres://kioku:x@127.0.0.1:1/kioku' })
    runtime = await startRuntime(config, { log: (line) => lines.push(line), retryMs: 60_000 })
    expect(runtime.state()).toBe('unavailable')
    expect(await status()).toEqual({
      needsSetup: false,
      database: { state: 'unavailable', source: 'env', failure: 'unreachable' },
      masterKey: false,
    })
    expect(runtime.gate.isOpen).toBe(false)
    expect(lines.join('\n')).not.toContain('初始化码')
    const health = await call('/health')
    expect(health.status).toBe(503)
    expect(await health.json()).toMatchObject({ status: 'unavailable' })
    expect((await call('/auth/me')).status).toBe(503)
    expect((await call('/setup/database/inspect', { setupCode: CODE })).status).toBe(503)
    expect((await call('/setup', admin)).status).toBe(503)
  })

  it('重试接住意外的错误接着试；账号数读不出时不切换；接上后没有账号才打开初始化码', async () => {
    const lines: string[] = []
    let calls = 0
    const start: typeof startService = async (...args) => {
      calls++
      // 第一次：库在检查之后断了（暂时的）；第二次：不是 StartupError 的意外；
      // 第三次：起来了，但数账号失败；之后照常
      if (calls === 1)
        throw new StartupError('connect', Object.assign(new Error('x'), { code: 'ECONNRESET' }))
      if (calls === 2) throw new Error('意外')
      const svc = await startService(...args)
      if (calls === 3) {
        return { ...svc, accounts: () => Promise.reject(new Error('读不出')) }
      }
      return svc
    }
    runtime = await startRuntime(configFor({ DATABASE_URL: testDatabaseUrl! }), {
      log: (line) => lines.push(line),
      start,
      retryMs: 20,
      maxRetryMs: 40,
    })
    expect(runtime.state()).toBe('unavailable')
    expect(runtime.gate.isOpen).toBe(false)
    await vi.waitFor(() => expect(runtime!.state()).toBe('ready'), {
      timeout: 30_000,
      interval: 50,
    })
    expect(calls).toBe(4)
    expect(runtime.gate.isOpen).toBe(true)
    expect(lines.join('\n')).toContain(`初始化码：${CODE}`)
    expect((await call('/health')).status).toBe(200)
  })

  it('冷启动时不会自己好的问题拒绝启动', async () => {
    const start: typeof startService = () =>
      Promise.reject(new StartupError('master_key', new Error('主密钥对不上')))
    await expect(
      startRuntime(configFor({ DATABASE_URL: testDatabaseUrl! }), { log: () => {}, start }),
    ).rejects.toThrow(FatalStartupError)
  })

  it('接入的准备阶段失败：不切换、不写 kioku.json', async () => {
    const start: typeof startService = async (...args) => {
      const svc = await startService(...args)
      return { ...svc, accounts: () => Promise.reject(new Error('读不出')) }
    }
    runtime = await startRuntime(configFor(), { log: () => {}, start })
    const res = await call('/setup/database', { setupCode: CODE, connection: testConnection() })
    expect(res.status).toBe(500)
    expect(runtime.state()).toBe('missing')
    await expect(stat(join(dataDir, 'kioku.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
