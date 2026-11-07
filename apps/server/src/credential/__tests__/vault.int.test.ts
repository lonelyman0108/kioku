import { randomBytes } from 'node:crypto'

import type {
  ConsoleCredential,
  CredentialAccess,
  CredentialEventList,
  CredentialValues,
  VaultCheckResult,
  VaultConnection,
  VaultConnectionList,
  VaultConnectResult,
  VaultItemList,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { principalForKeyId } from '../../auth/middleware'
import { withSpace, type Database } from '../../db/client'
import { vaultConnections } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeVault, type FakeVault } from '../../testing/fakeVault'
import { hasCachedSession } from '../../testing/vaultCache'
import { bearer, bootstrap, FULL_SCOPES, jsonRequest, type Workspace } from '../../testing/fixtures'
import { credentialServiceForKey } from '../context'
import { CredentialService } from '../service'
import { sealVaultSecrets, VaultConnections } from '../vault'
import { PLAIN_HTTP_RULE } from '../bitwarden/http'
import { totpCode } from '../bitwarden/totp'

const EMAIL = 'agent@example.com'
const MASTER = 'correct-master-password'
const SERVER = 'https://vault.example.com'
// RFC 6238 附录 B 的测试密钥（ASCII 12345678901234567890 的 base32）
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' // gitleaks:allow
const masterKey = randomBytes(32)

describe.skipIf(!testDatabaseUrl)('密码库连接与密码库的凭据', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let vault: FakeVault
  let key: string
  let keyId: string

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    // 每个用例一个新的客户端：会话缓存按客户端分开，不会带到下一个用例
    vault = fakeVault()
    vault.addAccount(EMAIL, MASTER)
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
      vault: vault.client,
    })
    ws = await bootstrap(app)
    const created = await ws.createKey((await ws.createApp('agent')).id, FULL_SCOPES)
    key = created.key
    keyId = created.id
  })

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
  const asMember = (method: string, path: string, body?: unknown) =>
    send(method, `/v1/spaces/${ws.spaceId}${path}`, body, { cookie: ws.cookie })
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const errorOf = async (res: Response, status: number) => {
    expect(res.status, await res.clone().text()).toBe(status)
    return ((await res.json()) as { error: string }).error
  }
  const connect = async (body: Record<string, unknown> = {}) =>
    ok<VaultConnectResult>(
      await asMember('POST', '/vault-connections', {
        serverUrl: `${SERVER}/`,
        email: EMAIL,
        masterPassword: MASTER,
        ...body,
      }),
    )
  const connected = async () => {
    const result = await connect()
    if (result.kind !== 'connected') throw new Error('没有连上')
    return result.connection
  }
  const identify = async (connectionId: string, itemId: string, extra: object = {}) =>
    ok<ConsoleCredential>(
      await asMember('POST', '/credentials', {
        identifier: 'router',
        name: '路由器',
        source: { kind: 'vault', connectionId, itemId, ...extra },
      }),
      201,
    )
  const use = (query: string) => send('GET', `/v1/credentials?${query}`, undefined, bearer(key))
  const connectionRow = async (id: string) =>
    (
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(vaultConnections).where(eq(vaultConnections.id, id)),
      )
    )[0]!
  const accessEvents = async (credentialId: string) =>
    (
      await ok<CredentialEventList>(await asMember('GET', `/credentials/${credentialId}/events`))
    ).items.filter((e) => e.type === 'access')
  const routerValues = {
    'login.username': 'admin',
    'login.password': 'router-pw',
    'login.totp': TOTP_SECRET,
    'field:Admin PIN': '2468',
  }

  it('连接：开了两步验证时先给出方式，带上验证码再连；只保存加密的令牌与密钥', async () => {
    vault.addAccount('2fa@example.com', MASTER, { provider: 'authenticator', code: '123456' })
    expect(await connect({ email: '2fa@example.com' })).toEqual({
      kind: 'two_factor_required',
      providers: ['authenticator'],
    })
    expect(
      await errorOf(
        await asMember('POST', '/vault-connections', {
          serverUrl: SERVER,
          email: '2fa@example.com',
          masterPassword: MASTER,
          twoFactor: { provider: 'authenticator', code: '000000' },
        }),
        400,
      ),
    ).toContain('两步验证码不正确')
    const result = await connect({
      email: '2fa@example.com',
      twoFactor: { provider: 'authenticator', code: '123456' },
    })
    expect(result.kind).toBe('connected')
    const connection = (result as { connection: VaultConnection }).connection
    expect(connection).toMatchObject({
      serverUrl: SERVER,
      email: '2fa@example.com',
      status: 'ok',
      disabledReason: null,
      lastError: null,
      credentialCount: 0,
    })
    const row = await connectionRow(connection.id)
    expect(row.ciphertext).not.toBeNull()
    expect(row.ciphertext!.includes(Buffer.from(vault.refreshTokens[0]!))).toBe(false)
    expect(JSON.stringify(connection)).not.toContain(MASTER)
    expect(
      await errorOf(
        await asMember('POST', '/vault-connections', {
          serverUrl: SERVER,
          email: EMAIL,
          masterPassword: 'wrong',
        }),
        400,
      ),
    ).toBe('邮箱或主密码不正确')
    vault.state.loginFailure = 'unreachable'
    expect(
      await errorOf(
        await asMember('POST', '/vault-connections', {
          serverUrl: SERVER,
          email: EMAIL,
          masterPassword: MASTER,
        }),
        502,
      ),
    ).toContain('无法连接')
  })

  it('地址不合客户端的规则时回 400 并说明规则，不说成连不上，也不向密码库请求', async () => {
    // 契约与客户端是同一条规则，经接口进不来：直接调服务，以及库里留着按旧规则存下的地址
    await expect(
      connectionsOf().connect({
        serverUrl: 'http://3232235777',
        email: EMAIL,
        masterPassword: MASTER,
      }),
    ).rejects.toMatchObject({ status: 400, message: PLAIN_HTTP_RULE })
    const connection = await connected()
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(vaultConnections)
        .set({ serverUrl: 'http://0xc0a80101' })
        .where(eq(vaultConnections.id, connection.id)),
    )
    const logins = vault.calls.login
    expect(
      await errorOf(
        await asMember('POST', `/vault-connections/${connection.id}/reconnect`, {
          masterPassword: MASTER,
        }),
        400,
      ),
    ).toBe(PLAIN_HTTP_RULE)
    expect(vault.calls.login).toBe(logins)
  })

  it('同一个成员同时只收一个连接或重新登录的请求，结束之后释放', async () => {
    let release!: () => void
    vault.state.beforeLogin = new Promise<void>((r) => (release = r))
    const first = asMember('POST', '/vault-connections', {
      serverUrl: SERVER,
      email: EMAIL,
      masterPassword: MASTER,
    })
    while (vault.calls.login === 0) await new Promise((r) => setTimeout(r, 5))
    expect(
      await errorOf(
        await asMember('POST', '/vault-connections', {
          serverUrl: SERVER,
          email: EMAIL,
          masterPassword: MASTER,
        }),
        409,
      ),
    ).toContain('正在处理上一次的连接请求')
    release()
    const done = await ok<VaultConnectResult>(await first)
    expect(done.kind).toBe('connected')
    // 失败的也会释放
    expect(
      (
        await asMember('POST', '/vault-connections', {
          serverUrl: SERVER,
          email: EMAIL,
          masterPassword: 'wrong',
        })
      ).status,
    ).toBe(400)
    expect((await connect()).kind).toBe('connected')
  })

  it('只接专用账号：有个人条目、组织角色是所有者或管理员时拒绝连接', async () => {
    vault.state.personalItemCount = 2
    expect(
      await errorOf(
        await asMember('POST', '/vault-connections', {
          serverUrl: SERVER,
          email: EMAIL,
          masterPassword: MASTER,
        }),
        400,
      ),
    ).toContain('个人条目')
    vault.state.personalItemCount = 0
    // 普通成员开了「访问全部集合」也算：看 allCollections，不只看角色
    vault.state.organizations = [{ id: 'org-1', name: 'Kioku', role: 'user', allCollections: true }]
    expect(
      await errorOf(
        await asMember('POST', '/vault-connections', {
          serverUrl: SERVER,
          email: EMAIL,
          masterPassword: MASTER,
        }),
        400,
      ),
    ).toContain('可访问全部集合')
    expect(
      (await ok<VaultConnectionList>(await asMember('GET', '/vault-connections'))).items,
    ).toEqual([])
  })

  it('列出条目并起标识：字段按条目推出，自定义字段的名字不合规时另起；一个条目只起一个标识', async () => {
    const connection = await connected()
    const itemId = vault.addItem({ name: '路由器', values: routerValues })
    const items = await ok<VaultItemList>(
      await asMember('GET', `/vault-connections/${connection.id}/items`),
    )
    expect(items.items).toEqual([
      expect.objectContaining({
        id: itemId,
        name: '路由器',
        fields: ['login.username', 'login.password', 'login.totp', 'field:Admin PIN'],
        credential: null,
      }),
    ])
    expect(items.collections).toEqual([
      { id: 'col-1', organizationId: 'org-1', name: 'Agent', readOnly: false },
    ])
    expect(items.unreadableCount).toBe(0)
    vault.state.unreadableItemCount = 2
    expect(
      (await ok<VaultItemList>(await asMember('GET', `/vault-connections/${connection.id}/items`)))
        .unreadableCount,
    ).toBe(2)
    expect(JSON.stringify(items)).not.toContain('router-pw')

    const created = await identify(connection.id, itemId)
    expect(created).toMatchObject({
      source: 'vault',
      vault: { connectionId: connection.id, itemId },
      fields: [
        { name: 'username', itemField: 'login.username' },
        { name: 'password', itemField: 'login.password' },
        { name: 'totp', itemField: 'login.totp' },
        { name: 'admin-pin', itemField: 'field:Admin PIN' },
      ],
    })
    const after = await ok<VaultItemList>(
      await asMember('GET', `/vault-connections/${connection.id}/items`),
    )
    expect(after.items[0]!.credential).toEqual({ id: created.id, identifier: 'router' })
    expect(
      (await ok<VaultConnectionList>(await asMember('GET', '/vault-connections'))).items[0]!
        .credentialCount,
    ).toBe(1)

    expect(
      await errorOf(
        await asMember('POST', '/credentials', {
          identifier: 'router-2',
          name: '又一个',
          source: { kind: 'vault', connectionId: connection.id, itemId },
        }),
        409,
      ),
    ).toContain('一个条目只对应一条有效凭据')
    expect(
      await errorOf(
        await asMember('POST', '/credentials', {
          identifier: 'wrong-field',
          name: '字段不对',
          source: {
            kind: 'vault',
            connectionId: connection.id,
            itemId: vault.addItem({ name: '别的', values: { notes: 'x' } }),
            fields: [{ name: 'password', itemField: 'login.password' }],
          },
        }),
        400,
      ),
    ).toContain('条目里没有字段 login.password')
    expect(
      await errorOf(
        await asMember('POST', '/credentials', {
          identifier: 'gone',
          name: '不存在',
          source: { kind: 'vault', connectionId: connection.id, itemId: 'no-such-item' },
        }),
        409,
      ),
    ).toContain('条目不可用')
    // 密码库的凭据改值时写回条目，不能删字段（写回见 credentialWriteback.int.test.ts）
    expect(
      await errorOf(
        await asMember('PATCH', `/credentials/${created.id}`, {
          expectedVersion: created.version,
          values: { password: null },
        }),
        400,
      ),
    ).toContain('不能删字段')
    const narrowed = await ok<ConsoleCredential>(
      await asMember('PATCH', `/credentials/${created.id}`, {
        expectedVersion: created.version,
        fields: [{ name: 'password', itemField: 'login.password' }],
      }),
    )
    expect(narrowed.fields).toEqual([{ name: 'password', itemField: 'login.password' }])
  })

  it('取用：每次向密码库取这个条目，totp 给现算的验证码；访问事件记用途与结果', async () => {
    const connection = await connected()
    const itemId = vault.addItem({ name: '路由器', values: routerValues })
    const created = await identify(connection.id, itemId)

    const before = Date.now()
    const got = await ok<CredentialAccess>(
      await use('identifier=router&purpose=%E7%99%BB%E5%BD%95%E8%B7%AF%E7%94%B1%E5%99%A8'),
    )
    expect(got.credential).toMatchObject({ identifier: 'router', source: 'vault' })
    expect(JSON.stringify(got.credential)).not.toContain(itemId)
    expect(got.values).toMatchObject({
      username: 'admin',
      password: 'router-pw',
      'admin-pin': '2468',
    })
    // 验证码按取用那一刻算（跨过 30 秒的边界时取前后两个都算对）
    expect([totpCode(TOTP_SECRET, before), totpCode(TOTP_SECRET, Date.now())]).toContain(
      got.values!.totp,
    )
    expect(JSON.stringify(got)).not.toContain(TOTP_SECRET)

    // 浏览器里改了密码，下一次取到的就是新的
    vault.setItemValues(itemId, { ...routerValues, 'login.password': 'changed-pw' })
    expect(
      (await ok<CredentialAccess>(await use('identifier=router&field=password'))).values,
    ).toEqual({ password: 'changed-pw' })
    // 起标识用的是同步（要写明条目所在的集合），之后每次取用各取一次条目
    expect(vault.calls.item).toBe(2)

    const revealed = await ok<CredentialValues>(
      await asMember('POST', `/credentials/${created.id}/reveal`),
    )
    expect(revealed.values.password).toBe('changed-pw')

    expect(
      (await accessEvents(created.id)).map((e) => [e.via, e.fields, e.purpose, e.result, e.reason]),
    ).toEqual([
      ['console', ['username', 'password', 'totp', 'admin-pin'], null, 'ok', null],
      ['rest', ['password'], null, 'ok', null],
      ['rest', ['username', 'password', 'totp', 'admin-pin'], '登录路由器', 'ok', null],
    ])
  })

  it('取不到值时说明原因，记一条失败；连不上记进连接的最近错误，成功一次就清掉', async () => {
    const connection = await connected()
    const itemId = vault.addItem({ name: '路由器', values: routerValues })
    const created = await identify(connection.id, itemId)

    vault.failNext('unreachable')
    expect(await errorOf(await use('identifier=router'), 502)).toContain('密码库无法连接')
    expect((await connectionRow(connection.id)).lastErrorKind).toBe('unreachable')
    const listed = await ok<VaultConnectionList>(await asMember('GET', '/vault-connections'))
    expect(listed.items[0]).toMatchObject({ status: 'ok', lastError: { kind: 'unreachable' } })

    await ok(await use('identifier=router'))
    expect((await connectionRow(connection.id)).lastErrorKind).toBeNull()

    vault.removeItem(itemId)
    expect(await errorOf(await use('identifier=router'), 409)).toContain('条目不可用')
    // 条目不可用说明通信是好的，连接照常
    expect((await connectionRow(connection.id)).status).toBe('ok')

    vault.addItem({ id: itemId, name: '路由器', values: { 'login.username': 'admin' } })
    expect(await errorOf(await use('identifier=router&field=password'), 409)).toContain(
      '条目里没有这个字段',
    )

    expect((await accessEvents(created.id)).map((e) => [e.result, e.reason])).toEqual([
      ['failed', 'field_missing'],
      ['failed', 'item_unavailable'],
      ['ok', null],
      ['failed', 'unreachable'],
    ])
  })

  it('重新检查这次同步失败时记下最近的错误，回 502，说明和列出条目时只有开头不同', async () => {
    const connection = await connected()
    const check = () => asMember('POST', `/vault-connections/${connection.id}/check`)
    const items = () => asMember('GET', `/vault-connections/${connection.id}/items`)

    for (const kind of [
      'unreachable',
      'server_error',
      'unsupported_format',
      'integrity',
    ] as const) {
      vault.failNext(kind)
      const checkText = await errorOf(await check(), 502)
      expect(checkText.startsWith('重新检查失败：'), checkText).toBe(true)
      expect((await connectionRow(connection.id)).lastErrorKind).toBe(kind)
      vault.failNext(kind)
      expect(await errorOf(await items(), 502)).toBe(
        checkText.replace('重新检查失败：', '无法列出条目：'),
      )
    }
    vault.failNext('unreachable')
    expect(await errorOf(await check(), 502)).toBe('重新检查失败：密码库无法连接')

    // 状态没变，成功一次就清掉最近的错误
    expect((await ok<VaultCheckResult>(await check())).connection).toMatchObject({
      status: 'ok',
      lastError: null,
    })
  })

  it('重新检查时条目不可用、别的请求刚换过令牌都不算同步失败，照常返回连接', async () => {
    const connection = await connected()
    const check = () => asMember('POST', `/vault-connections/${connection.id}/check`)

    vault.failNext('item_unavailable')
    expect((await ok<VaultCheckResult>(await check())).connection).toMatchObject({
      status: 'ok',
      lastError: null,
    })

    // 同步之前另一个请求换了令牌：这次用的旧令牌失效，库里的密文已经不同，状态不改
    await ok(await check())
    const old = vault.refreshTokens.at(-1)!
    vault.state.beforeSnapshot = async () => {
      vault.revokeToken(old)
      const sealed = sealVaultSecrets(masterKey, connection.id, vault.issueSecrets(EMAIL))
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx.update(vaultConnections).set(sealed).where(eq(vaultConnections.id, connection.id)),
      )
    }
    expect((await ok<VaultCheckResult>(await check())).connection).toMatchObject({
      status: 'ok',
      lastError: null,
    })
    expect((await connectionRow(connection.id)).status).toBe('ok')
  })

  it('停用的连接重新检查时同步失败同样回 502；同步成功但仍然违规时照旧返回连接', async () => {
    const connection = await connected()
    const check = () => asMember('POST', `/vault-connections/${connection.id}/check`)
    vault.state.personalItemCount = 1
    expect((await ok<VaultCheckResult>(await check())).connection).toMatchObject({
      status: 'disabled',
      disabledReason: 'personal_items',
    })

    vault.failNext('unreachable')
    expect(await errorOf(await check(), 502)).toBe('重新检查失败：密码库无法连接')
    expect(await connectionRow(connection.id)).toMatchObject({
      status: 'disabled',
      lastErrorKind: 'unreachable',
    })

    expect((await ok<VaultCheckResult>(await check())).connection).toMatchObject({
      status: 'disabled',
      disabledReason: 'personal_items',
      lastError: null,
    })
  })

  it('刷新令牌失效时先重读库里的密文：别的进程刚换过令牌就用新的再试一次', async () => {
    const connection = await connected()
    const itemId = vault.addItem({ name: '路由器', values: routerValues })
    await identify(connection.id, itemId)
    await ok(await use('identifier=router'))

    // 第一段读完连接之后，另一个进程换了令牌：旧的失效，库里存的是新的
    const fresh = vault.issueSecrets(EMAIL)
    const old = vault.refreshTokens.at(-1)!
    vault.state.beforeItem = async () => {
      vault.revokeToken(old)
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(vaultConnections)
          .set(sealVaultSecrets(masterKey, connection.id, fresh))
          .where(eq(vaultConnections.id, connection.id)),
      )
    }
    const sessions = vault.calls.sessions
    // 缓存里的旧会话先报失效，重读之后用新的成功
    expect(
      (await ok<CredentialAccess>(await use('identifier=router&field=password'))).values,
    ).toEqual({ password: 'router-pw' })
    expect((await connectionRow(connection.id)).status).toBe('ok')
    expect(vault.calls.sessions).toBe(sessions + 1)

    // 库里的也失效了：这才改成需要重新登录；列条目直接说要重新登录，不再请求密码库
    vault.revokeToken(fresh.refreshToken)
    expect(await errorOf(await use('identifier=router'), 409)).toContain('需要重新登录')
    expect((await connectionRow(connection.id)).status).toBe('reauth_required')
    const snapshots = vault.calls.snapshot
    expect(
      await errorOf(await asMember('GET', `/vault-connections/${connection.id}/items`), 409),
    ).toContain('请重新登录')
    expect(vault.calls.snapshot).toBe(snapshots)
  })

  it('刷新令牌失效改成需要重新登录，之后取用不再请求密码库；重新登录同一个账号复用这一行', async () => {
    const connection = await connected()
    const itemId = vault.addItem({ name: '路由器', values: routerValues })
    await identify(connection.id, itemId)

    vault.failNext('reauth_required')
    expect(await errorOf(await use('identifier=router'), 409)).toContain('需要重新登录')
    expect((await connectionRow(connection.id)).status).toBe('reauth_required')
    const calls = vault.calls.item
    expect(await errorOf(await use('identifier=router'), 409)).toContain('需要重新登录')
    expect(vault.calls.item).toBe(calls)

    vault.addAccount('other@example.com', MASTER)
    expect(
      await errorOf(
        await asMember('POST', `/vault-connections/${connection.id}/reconnect`, {
          email: 'other@example.com',
          masterPassword: MASTER,
        }),
        409,
      ),
    ).toContain('账号与这个连接不同')
    const again = await ok<VaultConnectResult>(
      await asMember('POST', `/vault-connections/${connection.id}/reconnect`, {
        masterPassword: MASTER,
      }),
    )
    expect(again).toMatchObject({
      kind: 'connected',
      connection: { id: connection.id, status: 'ok' },
    })
    await ok(await use('identifier=router'))

    // 再走一次连接也是同一行
    expect(await connected()).toMatchObject({ id: connection.id })
    expect(
      (await ok<VaultConnectionList>(await asMember('GET', '/vault-connections'))).items,
    ).toHaveLength(1)
  })

  it('同步时出现个人条目就停用连接，取用不再请求密码库；清掉之后重新检查恢复', async () => {
    const connection = await connected()
    const itemId = vault.addItem({ name: '路由器', values: routerValues })
    const created = await identify(connection.id, itemId)

    vault.state.personalItemCount = 1
    vault.resync()
    expect(await errorOf(await use('identifier=router'), 409)).toContain('连接已停用')
    expect(await connectionRow(connection.id)).toMatchObject({
      status: 'disabled',
      disabledReason: 'personal_items',
    })
    const calls = vault.calls.item
    expect(await errorOf(await use('identifier=router'), 409)).toContain('有个人条目')
    expect(vault.calls.item).toBe(calls)
    expect(
      await errorOf(await asMember('GET', `/vault-connections/${connection.id}/items`), 409),
    ).toContain('连接已停用')

    // 没清掉时重新检查照旧停用
    const still = (
      await ok<VaultCheckResult>(
        await asMember('POST', `/vault-connections/${connection.id}/check`),
      )
    ).connection
    expect(still).toMatchObject({ status: 'disabled', disabledReason: 'personal_items' })
    vault.state.personalItemCount = 0
    const checked = (
      await ok<VaultCheckResult>(
        await asMember('POST', `/vault-connections/${connection.id}/check`),
      )
    ).connection
    expect(checked).toMatchObject({ status: 'ok', disabledReason: null })
    await ok(await use('identifier=router'))
    expect((await accessEvents(created.id)).map((e) => [e.result, e.reason])).toEqual([
      ['ok', null],
      ['failed', 'disabled'],
      ['failed', 'disabled'],
    ])
  })

  it('会话换了刷新令牌时保存新的；断开立即清掉密文，凭据留着，重新登录后照常', async () => {
    const connection = await connected()
    const itemId = vault.addItem({ name: '路由器', values: routerValues })
    const created = await identify(connection.id, itemId)
    const before = (await connectionRow(connection.id)).ciphertext!

    vault.rotateSecrets()
    await ok(await use('identifier=router'))
    const rotated = (await connectionRow(connection.id)).ciphertext!
    expect(rotated.equals(before)).toBe(false)
    // 缓存的会话跟着新的密文走，不新建
    const sessions = vault.calls.sessions
    await ok(await use('identifier=router'))
    expect(vault.calls.sessions).toBe(sessions)

    const disconnected = await ok<VaultConnection>(
      await asMember('POST', `/vault-connections/${connection.id}/disconnect`),
    )
    expect(disconnected).toMatchObject({ status: 'disconnected', credentialCount: 1 })
    expect(await connectionRow(connection.id)).toMatchObject({
      ciphertext: null,
      wrappedKey: null,
      keyId: null,
    })
    expect(await errorOf(await use('identifier=router'), 409)).toContain('连接已断开')
    expect(
      (await ok<ConsoleCredential>(await asMember('GET', `/credentials/${created.id}`))).deletedAt,
    ).toBeNull()

    await ok(
      await asMember('POST', `/vault-connections/${connection.id}/reconnect`, {
        masterPassword: MASTER,
      }),
    )
    await ok(await use('identifier=router'))
  })

  it('测试台里取用不给值、不记访问，也不向密码库请求', async () => {
    const connection = await connected()
    const itemId = vault.addItem({ name: '路由器', values: routerValues })
    const created = await identify(connection.id, itemId)
    const principal = await principalForKeyId(database.db, keyId)
    const service = credentialServiceForKey(
      {
        db: database.db,
        cookieSecure: false,
        masterKey: null,
        embedder: staticEmbedderSource(null),
        jobs: null,
        vault: vault.client,
      },
      principal!,
      undefined,
      { bench: true },
    )
    const calls = vault.calls.item
    const got = await service.use('router', undefined, 'kioku_credential')
    expect(got.values).toBeNull()
    expect(vault.calls.item).toBe(calls)
    expect(await accessEvents(created.id)).toEqual([])
  })

  // 直接操作连接（不经过路由）：用来复现几个交错的顺序
  const connectionsOf = () =>
    new VaultConnections({
      db: database.db,
      spaceId: ws.spaceId,
      ownerAccountId: ws.accountId,
      masterKey,
      client: vault.client,
    })
  const keyService = async () =>
    credentialServiceForKey(
      {
        db: database.db,
        cookieSecure: false,
        masterKey,
        embedder: staticEmbedderSource(null),
        jobs: null,
        vault: vault.client,
      },
      (await principalForKeyId(database.db, keyId))!,
    )

  it('并发的取用在断开之前读到可用、断开提交之后才建会话：下一次取用发现已断开，把会话从缓存里删掉', async () => {
    const connection = await connected()
    await identify(connection.id, vault.addItem({ name: '路由器', values: routerValues }))
    await ok(await use('identifier=router'))
    const stale = await connectionRow(connection.id)
    await ok(await asMember('POST', `/vault-connections/${connection.id}/disconnect`))
    expect(hasCachedSession(vault.client, connection.id)).toBe(false)
    // 那次取用读到的还是带着密文的那一行，这时才建会话、放回缓存
    connectionsOf().session(stale)
    expect(hasCachedSession(vault.client, connection.id)).toBe(true)
    expect(await errorOf(await use('identifier=router'), 409)).toContain('连接已断开')
    expect(hasCachedSession(vault.client, connection.id)).toBe(false)
  })

  it('断开的事务提交之前放回缓存的会话，提交之后再清一次', async () => {
    const connection = await connected()
    await identify(connection.id, vault.addItem({ name: '路由器', values: routerValues }))
    await ok(await use('identifier=router'))
    const stale = await connectionRow(connection.id)
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    try {
      let pending!: Promise<Response>
      await side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        await tx`select id from vault_connections where id = ${connection.id} for update`
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }]
        pending = Promise.resolve(
          asMember('POST', `/vault-connections/${connection.id}/disconnect`),
        )
        for (let i = 0; ; i++) {
          const [row] = await side<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where ${pid}::int = any(pg_blocking_pids(pid))`
          if (row!.n > 0) break
          if (i >= 80) throw new Error('断开没有等在连接的行锁上')
          await new Promise((r) => setTimeout(r, 25))
        }
        // 断开已经清过一次缓存、正等着提交：这时并发的取用把会话放回去
        connectionsOf().session(stale)
        expect(hasCachedSession(vault.client, connection.id)).toBe(true)
      })
      await ok(await pending)
    } finally {
      await side.end()
    }
    expect(hasCachedSession(vault.client, connection.id)).toBe(false)
  })

  it('刷新令牌失效时只删用这份密文建的会话：所有者刚重新登录过的，新会话留着', async () => {
    const connection = await connected()
    const old = await connectionRow(connection.id)
    await ok(
      await asMember('POST', `/vault-connections/${connection.id}/reconnect`, {
        masterPassword: MASTER,
      }),
    )
    expect(hasCachedSession(vault.client, connection.id)).toBe(true)
    await withSpace(database.db, ws.spaceId, (tx) =>
      connectionsOf().record(tx, old, { kind: 'error', error: 'reauth_required' }),
    )
    expect(hasCachedSession(vault.client, connection.id)).toBe(true)
    // 密文没变，状态也不改
    expect((await connectionRow(connection.id)).status).toBe('ok')
    await withSpace(database.db, ws.spaceId, async (tx) =>
      connectionsOf().record(tx, (await connectionsOf().load(tx, connection.id))!, {
        kind: 'error',
        error: 'reauth_required',
      }),
    )
    expect(hasCachedSession(vault.client, connection.id)).toBe(false)
    expect((await connectionRow(connection.id)).status).toBe('reauth_required')
  })

  it('不是密码库报的错也记一条失败：意外的错误记成密码库出错，重读的令牌解不开记成主密钥', async () => {
    const connection = await connected()
    const created = await identify(
      connection.id,
      vault.addItem({ name: '路由器', values: routerValues }),
    )
    vault.state.beforeItem = () => Promise.reject(new Error('模拟的意外错误'))
    expect((await use('identifier=router')).status).toBe(500)

    // 第一段读完之后令牌失效、库里换成解不开的密文：重试时解密失败
    await ok(await use('identifier=router'))
    const old = vault.refreshTokens.at(-1)!
    vault.state.beforeItem = async () => {
      vault.revokeToken(old)
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(vaultConnections)
          .set({ ciphertext: randomBytes(80) })
          .where(eq(vaultConnections.id, connection.id)),
      )
    }
    expect(await errorOf(await use('identifier=router'), 400)).toContain('主密钥不可用')
    expect((await accessEvents(created.id)).map((e) => [e.result, e.reason])).toEqual([
      ['failed', 'master_key'],
      ['ok', null],
      ['failed', 'internal_error'],
    ])
  })

  it('kioku_get 末尾按连接的状态说明：断开、需要重新登录、停用的不写可以取用，也不请求密码库', async () => {
    const connection = await connected()
    await identify(connection.id, vault.addItem({ name: '路由器', values: routerValues }))
    const service = await keyService()
    const calls = { ...vault.calls }
    expect(await service.forPlaceholders(['router'])).toEqual([
      { identifier: 'router', state: 'usable', name: '路由器' },
    ])
    for (const status of ['reauth_required', 'disabled'] as const) {
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(vaultConnections)
          .set({
            status,
            disabledReason: status === 'disabled' ? 'personal_items' : null,
          })
          .where(eq(vaultConnections.id, connection.id)),
      )
      expect((await service.forPlaceholders(['router']))[0]!.state).toBe(status)
    }
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(vaultConnections)
        .set({ status: 'ok', disabledReason: null })
        .where(eq(vaultConnections.id, connection.id)),
    )
    await ok(await asMember('POST', `/vault-connections/${connection.id}/disconnect`))
    expect((await service.forPlaceholders(['router']))[0]!.state).toBe('disconnected')
    expect(vault.calls).toEqual(calls)
  })

  it('取用成功时不必每次都写连接那一行：有最近的错误要清，或者上次检查过了一分钟才写', async () => {
    const connection = await connected()
    await identify(connection.id, vault.addItem({ name: '路由器', values: routerValues }))
    const stamp = async () => (await connectionRow(connection.id)).lastCheckedAt!.getTime()
    const first = await stamp()
    await ok(await use('identifier=router'))
    expect(await stamp()).toBe(first)

    const back = (minutes: number) =>
      withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(vaultConnections)
          .set({ lastCheckedAt: sql`now() - make_interval(mins => ${minutes})` })
          .where(eq(vaultConnections.id, connection.id)),
      )
    await back(2)
    const old = await stamp()
    await ok(await use('identifier=router'))
    expect(await stamp()).toBeGreaterThan(old)

    // 一分钟以内，但有最近的错误：照样写，把错误清掉
    vault.failNext('unreachable')
    expect((await use('identifier=router')).status).toBe(502)
    await ok(await use('identifier=router'))
    expect((await connectionRow(connection.id)).lastErrorKind).toBeNull()
  })

  it('第三段确认连接现在的状态：读到可用、断开提交、建会话放回缓存之后，记录时把它删掉', async () => {
    const connection = await connected()
    await identify(connection.id, vault.addItem({ name: '路由器', values: routerValues }))
    await ok(await use('identifier=router'))
    const stale = await connectionRow(connection.id)
    await ok(await asMember('POST', `/vault-connections/${connection.id}/disconnect`))
    const session = connectionsOf().session(stale)
    expect(hasCachedSession(vault.client, connection.id)).toBe(true)
    await withSpace(database.db, ws.spaceId, (tx) =>
      connectionsOf().record(tx, stale, { kind: 'ok' }, session),
    )
    expect(hasCachedSession(vault.client, connection.id)).toBe(false)
  })

  it('没配主密钥时 kioku_get 末尾不写可以取用：托管的与密码库的都说主密钥不可用', async () => {
    const connection = await connected()
    await identify(connection.id, vault.addItem({ name: '路由器', values: routerValues }))
    await ok(
      await asMember('POST', '/credentials', {
        identifier: 'nas',
        name: 'NAS',
        source: { kind: 'new', values: { password: 'pw' } },
      }),
      201,
    )
    const service = credentialServiceForKey(
      {
        db: database.db,
        cookieSecure: false,
        masterKey: null,
        embedder: staticEmbedderSource(null),
        jobs: null,
        vault: vault.client,
      },
      (await principalForKeyId(database.db, keyId))!,
    )
    expect((await service.forPlaceholders(['router', 'nas'])).map((c) => c.state)).toEqual([
      'master_key',
      'master_key',
    ])
  })

  it('同步之后自己再查一遍违规：客户端没在 onSynced 里抛错，违规的连接也会停用、不会恢复', async () => {
    const connection = await connected()
    vault.state.skipOnSynced = true
    vault.state.personalItemCount = 1
    expect(
      (
        await ok<VaultCheckResult>(
          await asMember('POST', `/vault-connections/${connection.id}/check`),
        )
      ).connection,
    ).toMatchObject({ status: 'disabled', disabledReason: 'personal_items' })
    expect(
      await errorOf(await asMember('GET', `/vault-connections/${connection.id}/items`), 409),
    ).toContain('连接已停用')
    vault.state.personalItemCount = 0
    expect(
      (
        await ok<VaultCheckResult>(
          await asMember('POST', `/vault-connections/${connection.id}/check`),
        )
      ).connection,
    ).toMatchObject({ status: 'ok' })
  })

  it('记失败本身出错时记进日志，不悄悄吞掉，照样抛出原来的错误', async () => {
    const connection = await connected()
    await identify(connection.id, vault.addItem({ name: '路由器', values: routerValues }))
    vault.state.beforeItem = () => Promise.reject(new Error('模拟的意外错误'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events = vi
      .spyOn(
        CredentialService.prototype as unknown as { accessEvent: () => Promise<void> },
        'accessEvent',
      )
      .mockRejectedValue(new Error('记不进去'))
    try {
      expect((await use('identifier=router')).status).toBe(500)
      expect(logged.mock.calls.map((c) => c[0])).toContain('凭据取用失败之后记访问事件出错')
    } finally {
      events.mockRestore()
      logged.mockRestore()
    }
  })

  it('最近检查时间按数据库的时钟写：应用的时钟快了，节流照样按数据库的时间算', async () => {
    const connection = await connected()
    await identify(connection.id, vault.addItem({ name: '路由器', values: routerValues }))
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(vaultConnections)
        .set({ lastCheckedAt: sql`now() - interval '2 minutes'` })
        .where(eq(vaultConnections.id, connection.id)),
    )
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60_000 })
    try {
      await ok(await use('identifier=router'))
    } finally {
      vi.useRealTimers()
    }
    const [{ lag }] = (await withSpace(database.db, ws.spaceId, (tx) =>
      tx.execute(
        sql`select extract(epoch from now() - last_checked_at)::float8 as lag from vault_connections where id = ${connection.id}`,
      ),
    )) as unknown as [{ lag: number }]
    // 用应用的时间写的话会在十分钟之后，下一分钟里都不会再写
    expect(Math.abs(lag)).toBeLessThan(30)
  })

  it('同一次调用里先换令牌、后报刷新令牌失效：按这次用的会话删缓存，状态改成需要重新登录', async () => {
    const connection = await connected()
    vault.rotateSecrets()
    vault.state.revokeAfterRotate = true
    const checked = (
      await ok<VaultCheckResult>(
        await asMember('POST', `/vault-connections/${connection.id}/check`),
      )
    ).connection
    expect(checked.status).toBe('reauth_required')
    expect(hasCachedSession(vault.client, connection.id)).toBe(false)
  })
})
