import { randomBytes } from 'node:crypto'

import type {
  ConsoleCredential,
  CredentialEventList,
  KeyScopes,
  ResolvedCredentials,
  VaultConnection,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { principalForKeyId } from '../../auth/middleware'
import { defaultSession } from '../../access/session'
import { credentialServiceForKey } from '../../credential/context'
import { VaultConnections } from '../../credential/vault'
import { withSpace, type Database } from '../../db/client'
import { credentials } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps } from '../../http/env'
import { MemoryError } from '../../memory/service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeVault, type FakeVault } from '../../testing/fakeVault'
import { hasCachedSession } from '../../testing/vaultCache'
import { bearer, bootstrap, FULL_SCOPES, jsonRequest, type Workspace } from '../../testing/fixtures'

const HOSTED_PASSWORD = 'pw-correct-horse-staple'
const ROUTER_PASSWORD = 'router-pw-battery'
// RFC 6238 附录 B 的测试密钥（ASCII 12345678901234567890 的 base32）
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' // gitleaks:allow
const ROUTER_VALUES = {
  'login.username': 'admin',
  'login.password': ROUTER_PASSWORD,
  'login.totp': TOTP_SECRET,
  'field:Admin PIN': '2468',
}

describe.skipIf(!testDatabaseUrl)('kioku run 的取值接口', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let vault: FakeVault
  let routerItem: string
  let key: string
  let deps: Deps

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    vault = fakeVault()
    vault.addAccount('agent@example.com', 'master-pw')
    routerItem = vault.addItem({ name: '路由器', values: ROUTER_VALUES })
    vault.addAccount('second@example.com', 'master-pw')
    deps = {
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
      vault: vault.client,
    }
    app = createApp(deps)
    ws = await bootstrap(app)
    key = await keyFor()
  })

  const send = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    app.request(
      path,
      body === undefined
        ? { method, headers: { 'sec-fetch-site': 'same-origin', ...(headers ?? {}) } }
        : jsonRequest(method, body, headers ?? {}),
    )
  const asMember = (method: string, path: string, body?: unknown) =>
    send(method, `/v1/spaces/${ws.spaceId}${path}`, body, { cookie: ws.cookie })
  const resolve = (body: unknown, as = key) =>
    send('POST', '/v1/credentials/resolve', body, bearer(as))
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const errorOf = async (res: Response, status: number) => {
    const text = await res.text()
    expect(res.status, text).toBe(status)
    expect(text).not.toContain(HOSTED_PASSWORD)
    expect(text).not.toContain(ROUTER_PASSWORD)
    return (JSON.parse(text) as { error: string }).error
  }
  const keyFor = async (scopes: KeyScopes = FULL_SCOPES, slug = 'agent') =>
    ws.issueKey((await ws.createApp(slug)).id, scopes)

  const hosted = async (identifier = 'file-server') =>
    ok<ConsoleCredential>(
      await asMember('POST', '/credentials', {
        identifier,
        name: '文件服务器',
        source: { kind: 'hosted', values: { username: 'alice', password: HOSTED_PASSWORD } },
      }),
      201,
    )
  afterEach(() => {
    vi.restoreAllMocks()
  })
  const connect = async (email = 'agent@example.com') =>
    (
      await ok<{ kind: 'connected'; connection: VaultConnection }>(
        await asMember('POST', '/vault-connections', {
          serverUrl: 'https://vault.example.com',
          email,
          masterPassword: 'master-pw',
        }),
      )
    ).connection
  const router = async (connectionId: string, identifier = 'router', itemId = routerItem) =>
    ok<ConsoleCredential>(
      await asMember('POST', '/credentials', {
        identifier,
        name: '路由器',
        source: {
          kind: 'vault',
          connectionId,
          itemId,
          fields: [
            { name: 'username', itemField: 'login.username' },
            { name: 'password', itemField: 'login.password' },
            { name: 'pin', itemField: 'field:Admin PIN' },
            { name: 'otp', itemField: 'login.totp' },
          ],
        },
      }),
      201,
    )
  const accessEvents = async (credentialId: string) =>
    (
      await ok<CredentialEventList>(await asMember('GET', `/credentials/${credentialId}/events`))
    ).items
      .filter((e) => e.type === 'access')
      .map((e) => ({
        via: e.via,
        fields: e.fields,
        purpose: e.purpose,
        result: e.result,
        reason: e.reason,
        chatType: e.chatType,
      }))

  it('托管与密码库的一起取：按 refs 的顺序返回，同一条凭据只取一次条目，每条凭据记一条访问事件', async () => {
    const fileServer = await hosted()
    const connection = await connect()
    const routerCred = await router(connection.id)
    const before = vault.calls.item

    const res = await resolve({
      refs: [
        { identifier: 'router', field: 'password' },
        { identifier: 'file-server', field: 'password' },
        { identifier: 'router', field: 'username' },
        { identifier: 'file-server', field: 'username' },
        { identifier: 'router', field: 'pin' },
      ],
      purpose: '备份数据库',
    })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await ok<ResolvedCredentials>(res)).toEqual({
      values: [
        { identifier: 'router', field: 'password', value: ROUTER_PASSWORD },
        { identifier: 'file-server', field: 'password', value: HOSTED_PASSWORD },
        { identifier: 'router', field: 'username', value: 'admin' },
        { identifier: 'file-server', field: 'username', value: 'alice' },
        { identifier: 'router', field: 'pin', value: '2468' },
      ],
    })
    expect(vault.calls.item - before).toBe(1)

    const event = {
      via: 'run',
      purpose: '备份数据库',
      result: 'ok',
      reason: null,
      chatType: 'none',
    }
    expect(await accessEvents(routerCred.id)).toEqual([
      { ...event, fields: ['password', 'username', 'pin'] },
    ])
    expect(await accessEvents(fileServer.id)).toEqual([
      { ...event, fields: ['password', 'username'] },
    ])
  })

  it('一项不存在、没有这个字段或没有权限时整次失败：不返回值，也不向密码库请求', async () => {
    const fileServer = await hosted()
    const connection = await connect()
    const routerCred = await router(connection.id)
    const before = vault.calls.item

    expect(
      await errorOf(
        await resolve({
          refs: [
            { identifier: 'router', field: 'password' },
            { identifier: 'missing', field: 'password' },
          ],
        }),
        404,
      ),
    ).toBe('missing#password：凭据不存在')
    expect(
      await errorOf(
        await resolve({
          refs: [
            { identifier: 'router', field: 'password' },
            { identifier: 'file-server', field: 'pin' },
          ],
        }),
        404,
      ),
    ).toBe('file-server#pin：凭据没有这个字段')
    // 有几项取不到时报 refs 里最靠前的那一项
    expect(
      await errorOf(
        await resolve({
          refs: [
            { identifier: 'router', field: 'nope' },
            { identifier: 'missing', field: 'password' },
          ],
        }),
        404,
      ),
    ).toBe('router#nope：凭据没有这个字段')

    // 凭据能力不够：存不存在都是 403，存在的各记一条被拒
    const none = await keyFor({ ...FULL_SCOPES, credentials: 'none' }, 'none')
    const denied = await errorOf(
      await resolve(
        {
          refs: [
            { identifier: 'router', field: 'password' },
            { identifier: 'file-server', field: 'password' },
            { identifier: 'missing', field: 'password' },
          ],
          purpose: '试试',
        },
        none,
      ),
      403,
    )
    expect(denied).toMatch(/^router#password：访问密钥的凭据能力不足/)

    // 限定给别的应用的和不存在一样
    await ok(
      await asMember('PATCH', `/credentials/${fileServer.id}`, {
        expectedVersion: fileServer.version,
        appIds: [],
      }),
    )
    expect(
      await errorOf(
        await resolve({
          refs: [
            { identifier: 'router', field: 'password' },
            { identifier: 'file-server', field: 'password' },
          ],
        }),
        404,
      ),
    ).toBe('file-server#password：凭据不存在')

    expect(vault.calls.item).toBe(before)
    const deniedEvent = { via: 'run', fields: ['password'], chatType: 'none', result: 'denied' }
    expect(await accessEvents(routerCred.id)).toEqual([
      { ...deniedEvent, purpose: '试试', reason: 'capability' },
    ])
    expect(await accessEvents(fileServer.id)).toEqual([
      { ...deniedEvent, purpose: null, reason: 'app' },
      { ...deniedEvent, purpose: '试试', reason: 'capability' },
    ])
  })

  it('连接断开时 409，托管的那条不交出也不记', async () => {
    const fileServer = await hosted()
    const connection = await connect()
    const routerCred = await router(connection.id)
    await ok(await asMember('POST', `/vault-connections/${connection.id}/disconnect`))
    const before = vault.calls.item

    expect(
      await errorOf(
        await resolve({
          refs: [
            { identifier: 'file-server', field: 'password' },
            { identifier: 'router', field: 'username' },
            { identifier: 'router', field: 'password' },
          ],
          purpose: '登录',
        }),
        409,
      ),
    ).toBe('取不到 router 的值：连接已断开')
    expect(vault.calls.item).toBe(before)
    expect(await accessEvents(routerCred.id)).toEqual([
      {
        via: 'run',
        fields: ['username', 'password'],
        purpose: '登录',
        result: 'failed',
        reason: 'disconnected',
        chatType: 'none',
      },
    ])
    expect(await accessEvents(fileServer.id)).toEqual([])
  })

  it('向密码库取条目失败时整次失败：条目里没有的字段指出是哪一项，连不上时 502', async () => {
    const fileServer = await hosted()
    const connection = await connect()
    const routerCred = await router(connection.id)
    // 条目里的验证码密钥后来删掉了
    vault.setItemValues(routerItem, { ...ROUTER_VALUES, 'login.totp': '' })

    expect(
      await errorOf(
        await resolve({
          refs: [
            { identifier: 'file-server', field: 'password' },
            { identifier: 'router', field: 'password' },
            { identifier: 'router', field: 'otp' },
          ],
        }),
        409,
      ),
    ).toBe('取不到 router#otp 的值：条目里没有这个字段')

    vault.failNext('unreachable')
    expect(
      await errorOf(
        await resolve({
          refs: [
            { identifier: 'router', field: 'password' },
            { identifier: 'file-server', field: 'password' },
          ],
        }),
        502,
      ),
    ).toMatch(/^取不到 router 的值：密码库无法连接/)

    vault.removeItem(routerItem)
    expect(
      await errorOf(await resolve({ refs: [{ identifier: 'router', field: 'password' }] }), 409),
    ).toMatch(/^取不到 router 的值：/)

    expect((await accessEvents(routerCred.id)).map((e) => [e.result, e.reason, e.fields])).toEqual([
      ['failed', 'item_unavailable', ['password']],
      ['failed', 'unreachable', ['password']],
      ['failed', 'field_missing', ['password', 'otp']],
    ])
    // 密码库那条取不到，托管的值就不交出，也不记
    expect(await accessEvents(fileServer.id)).toEqual([])
  })

  it('托管的凭据声明了字段却没有存值：按条目里缺字段算失败、记一条失败；没声明的照旧 404、不记', async () => {
    const fileServer = await hosted()
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(credentials)
        .set({ fields: [...fileServer.fields, { name: 'pin', itemField: null }] })
        .where(eq(credentials.id, fileServer.id)),
    )
    expect(
      await errorOf(
        await resolve({
          refs: [
            { identifier: 'file-server', field: 'password' },
            { identifier: 'file-server', field: 'pin' },
          ],
          purpose: '登录',
        }),
        409,
      ),
    ).toBe('取不到 file-server#pin 的值：条目里没有这个字段')
    // use 也一样：取全部字段时整条失败，不给缺了值的那部分
    const use = (query: string) => send('GET', `/v1/credentials?${query}`, undefined, bearer(key))
    expect(await errorOf(await use('identifier=file-server'), 409)).toBe(
      '取不到 file-server 的值：条目里没有这个字段',
    )
    expect(await errorOf(await use('identifier=file-server&field=pin'), 409)).toBe(
      '取不到 file-server 的值：条目里没有这个字段',
    )
    expect(await errorOf(await use('identifier=file-server&field=nope'), 404)).toBe(
      '凭据 file-server 没有字段 nope',
    )
    expect(
      await errorOf(await resolve({ refs: [{ identifier: 'file-server', field: 'nope' }] }), 404),
    ).toBe('file-server#nope：凭据没有这个字段')
    expect(
      (await accessEvents(fileServer.id)).map((e) => [e.via, e.result, e.reason, e.fields]),
    ).toEqual([
      ['rest', 'failed', 'field_missing', ['pin']],
      ['rest', 'failed', 'field_missing', ['password', 'username', 'pin']],
      ['run', 'failed', 'field_missing', ['password', 'pin']],
    ])
  })

  // 准备时读到可用，读完之后断开提交，会话这才放回缓存（并发的断开与取用交错）
  const disconnectAfterLoad = (connectionId: string) => {
    const load = VaultConnections.prototype.load
    let raced = false
    vi.spyOn(VaultConnections.prototype, 'load').mockImplementation(async function (
      this: VaultConnections,
      tx,
      id,
    ) {
      const row = await load.call(this, tx, id)
      if (id === connectionId && !raced) {
        raced = true
        await ok(await asMember('POST', `/vault-connections/${connectionId}/disconnect`))
      }
      return row
    })
  }

  it('前面的密码库凭据取不到时，后面准备过、没轮到取的也确认连接状态：断开了就清掉缓存里的会话', async () => {
    const first = await connect()
    const second = await connect('second@example.com')
    await router(first.id)
    const otherItem = vault.addItem({ name: '交换机', values: ROUTER_VALUES })
    await router(second.id, 'switch', otherItem)
    vault.removeItem(routerItem)
    disconnectAfterLoad(second.id)

    expect(
      await errorOf(
        await resolve({
          refs: [
            { identifier: 'router', field: 'password' },
            { identifier: 'switch', field: 'password' },
          ],
        }),
        409,
      ),
    ).toMatch(/^取不到 router 的值：/)
    expect(hasCachedSession(vault.client, second.id)).toBe(false)
  })

  it('第一段里后面那条准备失败时，前面准备好的密码库凭据也确认连接状态', async () => {
    const first = await connect()
    const second = await connect('second@example.com')
    await router(first.id)
    const otherItem = vault.addItem({ name: '交换机', values: ROUTER_VALUES })
    await router(second.id, 'switch', otherItem)
    await ok(await asMember('POST', `/vault-connections/${first.id}/disconnect`))
    disconnectAfterLoad(second.id)

    expect(
      await errorOf(
        await resolve({
          refs: [
            { identifier: 'switch', field: 'password' },
            { identifier: 'router', field: 'password' },
          ],
        }),
        409,
      ),
    ).toBe('取不到 router 的值：连接已断开')
    expect(hasCachedSession(vault.client, second.id)).toBe(false)
  })

  it('测试台里不能用：回 400，不给值', async () => {
    await hosted()
    const created = await ws.createKey((await ws.createApp('bench')).id, FULL_SCOPES)
    const principal = (await principalForKeyId(database.db, created.id))!
    const service = credentialServiceForKey(deps, principal, defaultSession(principal), {
      bench: true,
    })
    const err = await service
      .resolve([{ identifier: 'file-server', field: 'password' }], 'run')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MemoryError)
    expect(err).toMatchObject({ status: 400, message: '测试台不支持 kioku run 的取值接口' })
  })

  it('refs 为空、超过 32 项或重复时回 400', async () => {
    await hosted()
    const refs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ identifier: 'file-server', field: `f${i}` }))
    expect(await errorOf(await resolve({ refs: [] }), 400)).toContain('至少需要一项')
    expect(await errorOf(await resolve({ refs: refs(33) }), 400)).toContain('一次最多 32 项')
    expect(
      await errorOf(
        await resolve({
          refs: [
            { identifier: 'file-server', field: 'password' },
            { identifier: 'file-server', field: 'password' },
          ],
        }),
        400,
      ),
    ).toContain('不能重复')
    expect((await resolve({ refs: [{ identifier: 'File', field: 'password' }] })).status).toBe(400)
    // 32 项本身不算超出：校验通过，按字段不存在报 404
    expect(await errorOf(await resolve({ refs: refs(32) }), 404)).toBe(
      'file-server#f0：凭据没有这个字段',
    )
  })
})
