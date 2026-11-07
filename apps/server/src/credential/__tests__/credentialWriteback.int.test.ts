import { randomBytes } from 'node:crypto'

import type {
  ConsoleCredential,
  ConsoleCredentialList,
  CreatedCredential,
  CredentialAccess,
  CredentialEventList,
  CredentialSummary,
  CredentialWriteError,
  KeyCreatedCredential,
  KeyCredentialList,
  MemoryView,
  VaultCheckResult,
  VaultConnection,
  VaultConnectionList,
  VaultConnectResult,
  VaultItemList,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { principalForKeyId } from '../../auth/middleware'
import { isUniqueViolation, withSpace, type Database } from '../../db/client'
import { credentials, vaultConnections } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { FAKE_COLLECTION, FAKE_ORG, fakeVault, type FakeVault } from '../../testing/fakeVault'
import { bearer, bootstrap, FULL_SCOPES, jsonRequest, type Workspace } from '../../testing/fixtures'
import { credentialServiceForKey } from '../context'
import { BENCH_VAULT_WRITE, credentialExpiry, CREDENTIAL_ATTENTION } from '../service'
import { VaultConnections } from '../vault'
import { MemoryService } from '../../memory/service'

const EMAIL = 'agent@example.com'
const MASTER = 'correct-master-password'
const SERVER = 'https://vault.example.com'
const masterKey = randomBytes(32)
const DAY = 86_400_000

describe.skipIf(!testDatabaseUrl)('写回密码库、到期与轮换', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let vault: FakeVault
  let key: string
  let keyId: string
  let appId: string

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    vault = fakeVault()
    vault.addAccount(EMAIL, MASTER)
    vault.addAccount('second@example.com', MASTER)
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
      vault: vault.client,
    })
    ws = await bootstrap(app)
    appId = (await ws.createApp('agent')).id
    const created = await ws.createKey(appId, FULL_SCOPES)
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
  const asKey = (method: string, path: string, body?: unknown) =>
    send(method, `/v1${path}`, body, bearer(key))
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const failure = async (res: Response, status: number) => {
    expect(res.status, await res.clone().text()).toBe(status)
    return (await res.json()) as CredentialWriteError
  }
  const connect = async (email = EMAIL) => {
    const result = await ok<VaultConnectResult>(
      await asMember('POST', '/vault-connections', {
        serverUrl: SERVER,
        email,
        masterPassword: MASTER,
      }),
    )
    if (result.kind !== 'connected') throw new Error('没有连上')
    return result.connection
  }
  const setDestination = (connectionId: string, collectionId = FAKE_COLLECTION) =>
    asMember('PUT', `/vault-connections/${connectionId}/destination`, { collectionId })
  const withDestination = async () => {
    const connection = await connect()
    await ok<VaultConnectionList>(await setDestination(connection.id))
    return connection
  }
  const keyCreate = (body: Record<string, unknown>) => asKey('POST', '/credentials', body)
  const keyUpdate = (body: Record<string, unknown>) => asKey('PATCH', '/credentials', body)
  const keyList = async () =>
    (await ok<KeyCredentialList>(await asKey('GET', '/credentials/list'))).items
  const consoleList = async (query = '') =>
    (await ok<ConsoleCredentialList>(await asMember('GET', `/credentials${query}`))).items
  const row = async (id: string) =>
    (
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(credentials).where(eq(credentials.id, id)),
      )
    )[0]!
  const connectionRow = async (id: string) =>
    (
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(vaultConnections).where(eq(vaultConnections.id, id)),
      )
    )[0]!
  const events = async (id: string, query = '') =>
    (await ok<CredentialEventList>(await asMember('GET', `/credentials/${id}/events${query}`)))
      .items
  const vaultCount = () =>
    withSpace(database.db, ws.spaceId, (tx) => tx.select().from(credentials)).then(
      (rows) => rows.length,
    )
  const benchService = async () =>
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
      undefined,
      { bench: true },
    )

  describe('去处', () => {
    it('重新检查与列条目带上集合与是否只读；只读、不存在的集合设不了', async () => {
      vault.state.collections.push({ id: 'col-ro', name: '只看', readOnly: true })
      const connection = await connect()
      const checked = await ok<VaultCheckResult>(
        await asMember('POST', `/vault-connections/${connection.id}/check`),
      )
      // 按名称排序（顺序随 localeCompare）：这里只核对内容
      expect([...checked.collections].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: FAKE_COLLECTION, organizationId: FAKE_ORG, name: 'Agent', readOnly: false },
        { id: 'col-ro', organizationId: FAKE_ORG, name: '只看', readOnly: true },
      ])
      const items = await ok<VaultItemList>(
        await asMember('GET', `/vault-connections/${connection.id}/items`),
      )
      expect(items.collections).toEqual(checked.collections)
      expect((await failure(await setDestination(connection.id, 'col-ro'), 400)).error).toContain(
        '集合只读',
      )
      expect((await failure(await setDestination(connection.id, 'col-none'), 400)).error).toContain(
        '集合不存在或不可用',
      )
      expect(checked.connection.destination).toBeNull()
    })

    it('每个成员最多一个：设在另一个连接上时原来的清掉；清除不请求密码库，断开的连接也能清', async () => {
      const first = await connect()
      const second = await connect('second@example.com')
      await ok(await setDestination(first.id))
      const list = await ok<VaultConnectionList>(await setDestination(second.id))
      const byId = new Map(list.items.map((c) => [c.id, c]))
      expect(byId.get(first.id)!.destination).toBeNull()
      expect(byId.get(second.id)!.destination).toEqual({
        collectionId: FAKE_COLLECTION,
        organizationId: FAKE_ORG,
        collectionName: 'Agent',
      })
      // 数据库也挡着第二个去处
      const err = await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(vaultConnections)
          .set({
            defaultCollectionId: FAKE_COLLECTION,
            defaultOrganizationId: FAKE_ORG,
            defaultCollectionName: 'Agent',
          })
          .where(eq(vaultConnections.id, first.id)),
      ).catch((e: unknown) => e)
      expect(isUniqueViolation(err, 'vault_connections_destination_idx')).toBe(true)

      // 断开时去处留着；断开的连接设不了，但清得掉，清除不向密码库请求
      const disconnected = await ok<VaultConnection>(
        await asMember('POST', `/vault-connections/${second.id}/disconnect`),
      )
      expect(disconnected.destination).not.toBeNull()
      expect((await failure(await setDestination(second.id), 409)).error).toContain('不可用')
      const calls = vault.calls.snapshot
      const cleared = await ok<VaultConnectionList>(
        await asMember('DELETE', `/vault-connections/${second.id}/destination`),
      )
      expect(cleared.items.every((c) => c.destination === null)).toBe(true)
      expect(vault.calls.snapshot).toBe(calls)
    })

    it('同步时集合改了名，去处跟着记新的名称', async () => {
      const connection = await withDestination()
      vault.state.collections[0]!.name = 'Agent 2'
      await ok(await asMember('POST', `/vault-connections/${connection.id}/check`))
      expect((await connectionRow(connection.id)).defaultCollectionName).toBe('Agent 2')
    })
  })

  describe('新建写到去处', () => {
    it('没有去处时托管；有去处时写成集合里的新条目，登录类按主机加端口匹配、令牌类写成隐藏字段', async () => {
      const hosted = await ok<KeyCreatedCredential>(
        await keyCreate({ identifier: 'plain', name: '托管', values: { token: 't-1' } }),
        201,
      )
      expect(hosted).toMatchObject({ source: 'hosted', storedIn: { kind: 'hosted', bench: false } })
      expect(vault.calls.createItem).toBe(0)

      await withDestination()
      const login = await ok<KeyCreatedCredential>(
        await keyCreate({
          identifier: 'nas',
          name: 'NAS',
          values: { username: 'admin', password: 'nas-pass', pin: '1357' },
          url: 'https://nas.example.com:5001',
        }),
        201,
      )
      expect(login).toMatchObject({
        source: 'vault',
        fields: ['password', 'pin', 'username'],
        storedIn: { kind: 'vault', collectionName: 'Agent' },
      })
      const loginRow = await row(login.id)
      const loginItem = vault.stored(loginRow.vaultItemId!)!
      expect(loginItem).toMatchObject({
        type: 'login',
        name: 'NAS',
        collectionId: FAKE_COLLECTION,
        values: { 'login.username': 'admin', 'login.password': 'nas-pass', 'field:pin': '1357' },
        uris: [{ uri: 'https://nas.example.com:5001', autofill: true }],
      })
      expect(loginRow).toMatchObject({
        appIds: [appId],
        vaultRevision: loginItem.revisionDate,
        fields: [
          { name: 'password', itemField: 'login.password' },
          { name: 'pin', itemField: 'field:pin' },
          { name: 'username', itemField: 'login.username' },
        ],
      })
      // 取得到刚写的值
      const used = await ok<CredentialAccess>(await asKey('GET', '/credentials?identifier=nas'))
      expect(used.values).toEqual({ username: 'admin', password: 'nas-pass', pin: '1357' })

      const token = await ok<KeyCreatedCredential>(
        await keyCreate({
          identifier: 'api',
          name: 'API',
          values: { token: 'tok-1' },
          url: 'https://api.example.com',
        }),
        201,
      )
      expect(vault.stored((await row(token.id)).vaultItemId!)).toMatchObject({
        type: 'login',
        values: { 'field:token': 'tok-1' },
        uris: [{ uri: 'https://api.example.com', autofill: false }],
      })
      const note = await ok<KeyCreatedCredential>(
        await keyCreate({ identifier: 'key2', name: '没网址', values: { token: 'tok-2' } }),
        201,
      )
      expect(vault.stored((await row(note.id)).vaultItemId!)).toMatchObject({
        type: 'note',
        uris: [],
      })
    })

    it('管理界面的 new 与 MCP 一样写到去处；起标识也写明条目所在的集合', async () => {
      const connection = await withDestination()
      const created = await ok<CreatedCredential>(
        await asMember('POST', '/credentials', {
          identifier: 'wifi',
          name: '无线网络',
          source: { kind: 'new', values: { password: 'wifi-pass' } },
          expiresAt: '2030-01-01T00:00:00.000Z',
        }),
        201,
      )
      expect(created).toMatchObject({
        source: 'vault',
        storedIn: { kind: 'vault', collectionName: 'Agent' },
        expiresAt: '2030-01-01T00:00:00.000Z',
        valueChangedAt: expect.any(String),
      })
      const itemId = vault.addItem({ name: '路由器', values: { 'login.password': 'r' } })
      const bound = await ok<CreatedCredential>(
        await asMember('POST', '/credentials', {
          identifier: 'router',
          name: '路由器',
          source: { kind: 'vault', connectionId: connection.id, itemId },
        }),
        201,
      )
      expect(bound.storedIn).toEqual({ kind: 'vault', collectionName: 'Agent' })
    })

    it('标识已被占用时先拦下，不往集合里留没人用的条目', async () => {
      await withDestination()
      await ok(await keyCreate({ identifier: 'nas', name: 'NAS', values: { a: 'b' } }), 201)
      const calls = vault.calls.createItem
      const err = await failure(
        await keyCreate({ identifier: 'nas', name: 'NAS', values: { a: 'c' } }),
        409,
      )
      expect(err).toEqual({ error: '标识已被占用或不可用：nas' })
      expect(vault.calls.createItem).toBe(calls)
    })

    it('去处不可用时整次失败，不退回托管，也不留下凭据', async () => {
      const connection = await withDestination()
      await ok(await asMember('POST', `/vault-connections/${connection.id}/disconnect`))
      const before = await vaultCount()
      expect(
        (await failure(await keyCreate({ identifier: 'x', name: 'x', values: { a: 'b' } }), 409))
          .error,
      ).toBe('新凭据的去处不可用：连接已断开。请重新登录，或清除去处。')
      expect(await vaultCount()).toBe(before)
      expect(vault.calls.createItem).toBe(0)
    })

    it('集合只读与值太长：说明原因，不改连接的状态，也不记进最近的错误', async () => {
      const connection = await withDestination()
      vault.state.collections[0]!.readOnly = true
      const readOnly = await failure(
        await keyCreate({ identifier: 'x', name: 'x', values: { a: 'b' } }),
        409,
      )
      expect(readOnly).toEqual({
        error: '无法写进新凭据的去处：集合只读或不可用：专用账号要有这个集合的编辑权限',
        reason: 'read_only',
      })
      vault.state.collections[0]!.readOnly = false
      vault.state.maxValueLength = 4
      const tooLong = await failure(
        await keyCreate({ identifier: 'x', name: 'x', values: { a: 'too-long' } }),
        400,
      )
      expect(tooLong.reason).toBe('value_too_long')
      expect(tooLong.error).toContain('值超出密码库的长度上限')
      expect(tooLong.error).not.toContain('too-long')
      expect(await connectionRow(connection.id)).toMatchObject({
        status: 'ok',
        lastErrorKind: null,
      })
      expect(await vaultCount()).toBe(0)
    })

    it('写进密码库之后标识被占用：条目留在集合里，管理界面的错误体带上它，Key 只在文字里写明', async () => {
      await withDestination()
      const occupy = (identifier: string) => async () => {
        await ok(
          await asMember('POST', '/credentials', {
            identifier,
            name: '抢先',
            source: { kind: 'new', values: { a: 'b' } },
          }),
          201,
        )
      }
      // 抢先建的那条也会写进密码库：先清掉去处再抢，抢完再设回去
      const race = (identifier: string) => async () => {
        const [conn] = (await ok<VaultConnectionList>(await asMember('GET', '/vault-connections')))
          .items
        await ok(await asMember('DELETE', `/vault-connections/${conn!.id}/destination`))
        await occupy(identifier)()
        await withSpace(database.db, ws.spaceId, (tx) =>
          tx
            .update(vaultConnections)
            .set({
              defaultCollectionId: FAKE_COLLECTION,
              defaultOrganizationId: FAKE_ORG,
              defaultCollectionName: 'Agent',
            })
            .where(eq(vaultConnections.id, conn!.id)),
        )
      }
      vault.state.beforeWrite = race('wifi')
      const consoleError = await failure(
        await asMember('POST', '/credentials', {
          identifier: 'wifi',
          name: '无线网络',
          source: { kind: 'new', values: { password: 'wifi-pass' } },
        }),
        409,
      )
      expect(consoleError.vaultItem).toMatchObject({
        itemName: '无线网络',
        collectionName: 'Agent',
      })
      expect(vault.stored(consoleError.vaultItem!.itemId)).toBeDefined()
      expect(consoleError.error).toContain('未建成凭据')

      vault.state.beforeWrite = race('mail')
      const keyError = await failure(
        await keyCreate({ identifier: 'mail', name: '邮箱', values: { password: 'p' } }),
        409,
      )
      expect(keyError.vaultItem).toBeUndefined()
      expect(keyError.error).toContain('条目「邮箱」已写进集合「Agent」，未建成凭据')
    })
  })

  describe('写回', () => {
    const seedVaultCredential = async () => {
      await withDestination()
      return ok<KeyCreatedCredential>(
        await keyCreate({
          identifier: 'nas',
          name: 'NAS',
          values: { username: 'admin', password: 'old-pass', pin: '1357' },
        }),
        201,
      )
    }

    it('只改给了的字段，旧密码与隐藏字段的旧值进密码历史；版本号加一、清掉需要轮换', async () => {
      const created = await seedVaultCredential()
      await ok(
        await asMember('PATCH', `/credentials/${created.id}`, {
          expectedVersion: 1,
          needsRotation: true,
        }),
      )
      const updated = await ok<CredentialSummary>(
        await keyUpdate({
          identifier: 'nas',
          expectedVersion: 2,
          values: { password: 'new-pass', pin: '2468' },
        }),
      )
      expect(updated.version).toBe(3)
      const item = vault.stored((await row(created.id)).vaultItemId!)!
      expect(item.values).toEqual({
        'login.username': 'admin',
        'login.password': 'new-pass',
        'field:pin': '2468',
      })
      expect(item.history).toEqual([
        { field: 'login.password', value: 'old-pass' },
        { field: 'field:pin', value: '1357' },
      ])
      const after = await row(created.id)
      expect(after).toMatchObject({ rotationRequestedAt: null, vaultRevision: item.revisionDate })
      expect((await events(created.id))[0]).toMatchObject({
        type: 'update',
        changes: ['values'],
        fields: ['password', 'pin'],
      })
    })

    it('浏览器里改过条目：带旧版本号改得到 409，重新读取后带新版本号能改，浏览器改的字段不被盖掉', async () => {
      const created = await seedVaultCredential()
      const itemId = (await row(created.id)).vaultItemId!
      // 浏览器里改了用户名
      vault.setItemValues(itemId, {
        ...vault.stored(itemId)!.values,
        'login.username': 'root',
      })
      const conflict = await failure(
        await keyUpdate({ identifier: 'nas', expectedVersion: 1, values: { password: 'p2' } }),
        409,
      )
      expect(conflict.reason).toBe('item_conflict')
      expect(conflict.error).toContain('请先重新读取凭据')
      expect(vault.stored(itemId)!.values['login.password']).toBe('old-pass')
      // 重新读取：版本号已经加一
      const listed = (await keyList()).find((c) => c.identifier === 'nas')!
      expect(listed.version).toBe(2)
      // 带旧版本号再试是 Kioku 自己的版本冲突
      expect(
        (
          await failure(
            await keyUpdate({ identifier: 'nas', expectedVersion: 1, values: { password: 'p2' } }),
            409,
          )
        ).reason,
      ).toBe('version')
      await ok(
        await keyUpdate({
          identifier: 'nas',
          expectedVersion: listed.version,
          values: { password: 'p2' },
        }),
      )
      expect(vault.stored(itemId)!.values).toMatchObject({
        'login.username': 'root',
        'login.password': 'p2',
      })
    })

    it('不能删字段、不能改字段对应以外的字段与 TOTP，字段对应与值不能一起改：都不请求密码库', async () => {
      const connection = await withDestination()
      const itemId = vault.addItem({
        name: '路由器',
        values: { 'login.password': 'r', 'login.totp': 'GEZDGNBVGY3TQOJQ' }, // gitleaks:allow
      })
      const bound = await ok<ConsoleCredential>(
        await asMember('POST', '/credentials', {
          identifier: 'router',
          name: '路由器',
          source: { kind: 'vault', connectionId: connection.id, itemId },
        }),
        201,
      )
      const calls = vault.calls.updateItem
      for (const [values, text] of [
        [{ password: null }, '不能删字段'],
        [{ other: 'x' }, '只能改字段对应里已有的字段'],
        [{ totp: 'NEWSECRET' }, 'TOTP 的密钥不由 Kioku 写入'],
      ] as const) {
        expect(
          (
            await failure(
              await keyUpdate({ identifier: 'router', expectedVersion: 1, values }),
              400,
            )
          ).error,
        ).toContain(text)
      }
      expect(
        (
          await failure(
            await asMember('PATCH', `/credentials/${bound.id}`, {
              expectedVersion: 1,
              values: { password: 'x' },
              fields: [{ name: 'password', itemField: 'login.password' }],
            }),
            400,
          )
        ).error,
      ).toBe('字段对应与值请分两次修改')
      expect(vault.calls.updateItem).toBe(calls)
    })

    it('集合只读回 409、值太长回 400，都带原因，不改连接', async () => {
      const created = await seedVaultCredential()
      const connectionId = (await row(created.id)).vaultConnectionId!
      vault.state.collections[0]!.readOnly = true
      expect(
        (
          await failure(
            await keyUpdate({ identifier: 'nas', expectedVersion: 1, values: { password: 'x' } }),
            409,
          )
        ).reason,
      ).toBe('read_only')
      vault.state.collections[0]!.readOnly = false
      vault.state.maxValueLength = 3
      const tooLong = await failure(
        await keyUpdate({ identifier: 'nas', expectedVersion: 1, values: { password: 'long' } }),
        400,
      )
      expect(tooLong).toEqual({
        error: '无法写回密码库：值超出密码库的长度上限，请缩短值',
        reason: 'value_too_long',
      })
      expect(await connectionRow(connectionId)).toMatchObject({
        status: 'ok',
        lastErrorKind: null,
      })
      expect((await row(created.id)).version).toBe(1)
    })
  })

  describe('测试台', () => {
    it('新建按托管写，即使设了去处；改密码库凭据的值被拒；都不请求密码库', async () => {
      await withDestination()
      const created = await ok<KeyCreatedCredential>(
        await keyCreate({ identifier: 'nas', name: 'NAS', values: { password: 'p' } }),
        201,
      )
      const service = await benchService()
      const before = { ...vault.calls }
      const benchCreated = await service.keyCreate({
        identifier: 'bench',
        name: '测试台',
        values: { password: 'b' },
      })
      expect(benchCreated).toMatchObject({
        source: 'hosted',
        storedIn: { kind: 'hosted', bench: true },
      })
      await expect(
        service.keyUpdate('nas', { expectedVersion: created.version, values: { password: 'x' } }),
      ).rejects.toThrow(BENCH_VAULT_WRITE)
      // 只改名称照常
      expect(
        (await service.keyUpdate('nas', { expectedVersion: created.version, name: 'NAS 2' }))
          .version,
      ).toBe(created.version + 1)
      expect(vault.calls).toEqual(before)
    })
  })

  describe('到期与轮换', () => {
    it('到期的状态：已到期、快到期（含正好 7 天）与远的；已到期照常能取，结果里注明', async () => {
      const now = Date.now()
      expect(credentialExpiry(null, now)).toBeNull()
      expect(credentialExpiry(new Date(now), now)).toBe('expired')
      expect(credentialExpiry(new Date(now + 1), now)).toBe('expiring')
      expect(credentialExpiry(new Date(now + 7 * DAY), now)).toBe('expiring')
      expect(credentialExpiry(new Date(now + 7 * DAY + 1), now)).toBeNull()

      await ok(
        await keyCreate({
          identifier: 'old',
          name: '过期的',
          values: { token: 't' },
          expiresAt: new Date(now - DAY).toISOString(),
        }),
        201,
      )
      const used = await ok<CredentialAccess>(await asKey('GET', '/credentials?identifier=old'))
      expect(used.values).toEqual({ token: 't' })
      expect(used.credential.expiry).toBe('expired')
      expect(used.notice).toContain('已于')
    })

    it('SQL 的待处理条件和 JS 的到期判断逐条一致', async () => {
      const now = Date.now()
      const offsets = [-DAY, -1000, 60_000, 3 * DAY, 7 * DAY - 60_000, 7 * DAY + 60_000, 30 * DAY]
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx.insert(credentials).values(
          offsets.map((offset, i) => ({
            spaceId: ws.spaceId,
            ownerAccountId: ws.accountId,
            identifier: `c${i}`,
            name: `c${i}`,
            source: 'hosted' as const,
            ciphertext: Buffer.from('c'),
            wrappedKey: Buffer.from('k'),
            expiresAt: new Date(now + offset),
          })),
        ),
      )
      const flagged = await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .select({ identifier: credentials.identifier })
          .from(credentials)
          .where(CREDENTIAL_ATTENTION),
      )
      const rows = await consoleList()
      expect(new Set(flagged.map((r) => r.identifier))).toEqual(
        new Set(rows.filter((c) => c.expiry !== null).map((c) => c.identifier)),
      )
      expect(rows.filter((c) => c.expiry !== null)).toHaveLength(5)
    })

    it('Key 的服务层也不收需要轮换：路由剥掉之外再挡一层', async () => {
      await ok(await keyCreate({ identifier: 'nas', name: 'NAS', values: { password: 'p' } }), 201)
      const service = credentialServiceForKey(
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
      const input = { expectedVersion: 1, needsRotation: true } as Parameters<
        typeof service.keyUpdate
      >[1]
      await expect(service.keyUpdate('nas', input)).rejects.toThrow(
        '「需要轮换」只能在管理界面修改',
      )
    })

    it('需要轮换只在管理界面标与清除；托管的改了值自动清掉', async () => {
      const created = await ok<KeyCreatedCredential>(
        await keyCreate({ identifier: 'nas', name: 'NAS', values: { password: 'p' } }),
        201,
      )
      const marked = await ok<ConsoleCredential>(
        await asMember('PATCH', `/credentials/${created.id}`, {
          expectedVersion: 1,
          needsRotation: true,
        }),
      )
      expect(marked.rotationRequestedAt).not.toBeNull()
      expect((await consoleList('?attention=true')).map((c) => c.identifier)).toEqual(['nas'])
      // Key 的请求里没有它：带上了也不改
      await ok(
        await keyUpdate({ identifier: 'nas', expectedVersion: 2, needsRotation: false, name: 'N' }),
      )
      expect((await row(created.id)).rotationRequestedAt).not.toBeNull()
      // 只改名称不清；改了值才清
      await ok(
        await keyUpdate({ identifier: 'nas', expectedVersion: 3, values: { password: 'q' } }),
      )
      expect((await row(created.id)).rotationRequestedAt).toBeNull()
      expect(await consoleList('?attention=true')).toEqual([])
    })

    it('密码库的条目在别处改过：Kioku 看到时版本号加一、清掉需要轮换、记下上次改值的时间', async () => {
      const connection = await connect()
      const itemId = vault.addItem({ name: '路由器', values: { 'login.password': 'r1' } })
      const bound = await ok<CreatedCredential>(
        await asMember('POST', '/credentials', {
          identifier: 'router',
          name: '路由器',
          source: { kind: 'vault', connectionId: connection.id, itemId },
        }),
        201,
      )
      expect(bound.valueChangedAt).toBe(vault.stored(itemId)!.revisionDate)
      await ok(
        await asMember('PATCH', `/credentials/${bound.id}`, {
          expectedVersion: 1,
          needsRotation: true,
        }),
      )
      // 没变时列条目不动它
      await ok(await asMember('GET', `/vault-connections/${connection.id}/items`))
      expect((await row(bound.id)).version).toBe(2)
      vault.setItemValues(itemId, { 'login.password': 'r2' })
      await ok(await asMember('GET', `/vault-connections/${connection.id}/items`))
      const after = await row(bound.id)
      expect(after).toMatchObject({ version: 3, rotationRequestedAt: null })
      expect(after.valueChangedAt?.toISOString()).toBe(vault.stored(itemId)!.revisionDate)
    })
  })

  describe('上次改值以来的取用', () => {
    it('托管的按值版本、密码库的按条目修改时间：筛选只列交出现在的值的访问', async () => {
      const created = await ok<KeyCreatedCredential>(
        await keyCreate({ identifier: 'nas', name: 'NAS', values: { password: 'p1' } }),
        201,
      )
      await ok(await asKey('GET', '/credentials?identifier=nas'))
      await ok(
        await keyUpdate({ identifier: 'nas', expectedVersion: 1, values: { password: 'p2' } }),
      )
      await ok(await asKey('GET', '/credentials?identifier=nas'))
      // 只改名称不算改值
      await ok(await keyUpdate({ identifier: 'nas', expectedVersion: 2, name: 'NAS 2' }))
      await ok(await asKey('GET', '/credentials?identifier=nas'))
      const all = await events(created.id)
      expect(all.map((e) => [e.type, e.sinceValueChange])).toEqual([
        ['access', true],
        ['update', null],
        ['access', true],
        ['update', null],
        ['access', false],
        ['create', null],
      ])
      const since = await events(created.id, '?sinceValueChange=true')
      expect(since.map((e) => e.id)).toEqual(all.filter((e) => e.sinceValueChange).map((e) => e.id))

      // 密码库的：别处改过之后，之前的取用不算
      const connection = await connect()
      const itemId = vault.addItem({ name: '路由器', values: { 'login.password': 'r1' } })
      const bound = await ok<CreatedCredential>(
        await asMember('POST', '/credentials', {
          identifier: 'router',
          name: '路由器',
          source: { kind: 'vault', connectionId: connection.id, itemId },
        }),
        201,
      )
      await ok(await asKey('GET', '/credentials?identifier=router'))
      vault.setItemValues(itemId, { 'login.password': 'r2' })
      await ok(await asKey('GET', '/credentials?identifier=router'))
      const vaultEvents = (await events(bound.id)).filter((e) => e.type === 'access')
      expect(vaultEvents.map((e) => e.sinceValueChange)).toEqual([true, false])
      expect(await events(bound.id, '?sinceValueChange=true')).toHaveLength(1)
    })
  })

  describe('转存的新建', () => {
    const BODY = '路由器的密码：hunter2-router'
    const remember = async () =>
      ok<MemoryView>(
        await asMember('POST', '/memories', {
          uri: 'user://notes/router',
          content: BODY,
          sensitivity: 'private',
          allowPlaintext: true,
        }),
        201,
      )

    it('设了去处时写进密码库；转存的事务失败时错误带上留下的条目与原因', async () => {
      await withDestination()
      const m = await remember()
      const converted = await ok<{ storedIn: unknown; credential: ConsoleCredential }>(
        await asMember('POST', '/memories/convert-to-credential', {
          memoryId: m.id,
          expectedVersion: m.version,
          value: 'hunter2-router',
          target: { kind: 'new', identifier: 'router', name: '路由器', field: 'password' },
        }),
      )
      expect(converted.storedIn).toEqual({ kind: 'vault', collectionName: 'Agent' })
      expect(converted.credential.source).toBe('vault')

      const other = await ok<MemoryView>(
        await asMember('POST', '/memories', {
          uri: 'user://notes/mail',
          content: '邮箱密码：mail-secret-1',
          sensitivity: 'private',
          allowPlaintext: true,
        }),
        201,
      )
      // 能在写条目之前查的先查：版本不对、正文里没有这段值都不往集合里写
      const created = vault.calls.createItem
      const stale = await failure(
        await asMember('POST', '/memories/convert-to-credential', {
          memoryId: other.id,
          expectedVersion: other.version + 1,
          value: 'mail-secret-1',
          target: { kind: 'new', identifier: 'mail', name: '邮箱', field: 'password' },
        }),
        409,
      )
      expect(stale.reason).toBe('version')
      expect(stale.vaultItem).toBeUndefined()
      const missing = await failure(
        await asMember('POST', '/memories/convert-to-credential', {
          memoryId: other.id,
          expectedVersion: other.version,
          value: 'not-in-the-body',
          target: { kind: 'new', identifier: 'mail', name: '邮箱', field: 'password' },
        }),
        400,
      )
      expect(missing.vaultItem).toBeUndefined()
      expect(vault.calls.createItem).toBe(created)

      // 写条目之后、转存的事务之前记忆被改了：按留下的条目报
      vault.state.beforeWrite = async () => {
        await ok(
          await asMember('PATCH', '/memories', {
            uri: 'user://notes/mail',
            expectedVersion: other.version,
            content: '邮箱密码：mail-secret-1（改过）',
            allowPlaintext: true,
          }),
        )
      }
      const failed = await failure(
        await asMember('POST', '/memories/convert-to-credential', {
          memoryId: other.id,
          expectedVersion: other.version,
          value: 'mail-secret-1',
          target: { kind: 'new', identifier: 'mail', name: '邮箱', field: 'password' },
        }),
        409,
      )
      expect(failed.reason).toBe('version')
      expect(failed.vaultItem).toMatchObject({ itemName: '邮箱', collectionName: 'Agent' })
      expect(vault.stored(failed.vaultItem!.itemId)!.values).toEqual({
        'login.password': 'mail-secret-1',
      })
      expect(JSON.stringify(failed)).not.toContain('mail-secret-1')
    })
  })
  describe('审查之后补的', () => {
    const seed = async () => {
      await withDestination()
      return ok<KeyCreatedCredential>(
        await keyCreate({
          identifier: 'nas',
          name: 'NAS',
          values: { username: 'admin', password: 'old-pass' },
        }),
        201,
      )
    }

    it('两段之间版本变了（改名、标需要轮换）：值照样记下，别的改动不保存，返回 409', async () => {
      const created = await seed()
      vault.state.beforeWrite = async () => {
        await ok(
          await asMember('PATCH', `/credentials/${created.id}`, {
            expectedVersion: 1,
            name: 'NAS 改名',
            needsRotation: true,
          }),
        )
      }
      const err = await failure(
        await keyUpdate({
          identifier: 'nas',
          expectedVersion: 1,
          name: '这次请求的名称',
          values: { password: 'new-pass' },
        }),
        409,
      )
      expect(err).toEqual({
        error: '值已写进密码库，其余改动因凭据已在别处修改而没有保存，请重新读取后再改',
        reason: 'version',
      })
      const after = await row(created.id)
      const item = vault.stored(after.vaultItemId!)!
      expect(item.values['login.password']).toBe('new-pass')
      expect(after).toMatchObject({
        version: 3,
        name: 'NAS 改名',
        vaultRevision: item.revisionDate,
        rotationRequestedAt: null,
      })
      expect((await events(created.id))[0]).toMatchObject({
        type: 'update',
        changes: ['values'],
        fields: ['password'],
      })
      // 下次读到时不把 Kioku 自己写的这一次当成别处的改动
      await ok(await asKey('GET', '/credentials?identifier=nas'))
      expect((await row(created.id)).version).toBe(3)
    })

    it('两段之间别人收窄了限定的应用：限定还在，值记下了，返回 409', async () => {
      await withDestination()
      const created = await ok<CreatedCredential>(
        await asMember('POST', '/credentials', {
          identifier: 'nas',
          name: 'NAS',
          source: { kind: 'new', values: { password: 'old-pass' } },
        }),
        201,
      )
      expect(created.appIds).toBeNull()
      vault.state.beforeWrite = async () => {
        await ok(
          await asMember('PATCH', `/credentials/${created.id}`, {
            expectedVersion: 1,
            appIds: [appId],
          }),
        )
      }
      const err = await failure(
        await asMember('PATCH', `/credentials/${created.id}`, {
          expectedVersion: 1,
          appIds: null,
          values: { password: 'new-pass' },
        }),
        409,
      )
      expect(err.reason).toBe('version')
      const after = await row(created.id)
      expect(after.appIds).toEqual([appId])
      expect(vault.stored(after.vaultItemId!)!.values['login.password']).toBe('new-pass')
      expect(after.vaultRevision).toBe(vault.stored(after.vaultItemId!)!.revisionDate)
      expect((await events(created.id))[0]).toMatchObject({ type: 'update', changes: ['values'] })
    })

    it('两段之间凭据被删了：照样在那一行记下写入，返回 409 说明值已写进密码库', async () => {
      const created = await seed()
      vault.state.beforeWrite = async () => {
        await expect(
          asMember('DELETE', `/credentials/${created.id}?expectedVersion=1`),
        ).resolves.toMatchObject({ status: 204 })
      }
      const err = await failure(
        await keyUpdate({
          identifier: 'nas',
          expectedVersion: 1,
          values: { password: 'new-pass' },
        }),
        409,
      )
      expect(err).toEqual({ error: '值已写进密码库，但凭据在此期间被删除', reason: 'deleted' })
      const after = await row(created.id)
      expect(after.deletedAt).not.toBeNull()
      expect(after.vaultRevision).toBe(vault.stored(after.vaultItemId!)!.revisionDate)
      expect((await events(created.id))[0]).toMatchObject({ type: 'update', changes: ['values'] })
    })

    it('写回不把修改时间往回改：库里已经记下了更新的，就不动', async () => {
      const created = await seed()
      const later = '2099-01-01T00:00:00.000Z'
      // 记写回结果之前，并发的取用已经记下了别处又一次修改的时间
      const original = VaultConnections.prototype.record
      const spy = vi
        .spyOn(VaultConnections.prototype, 'record')
        .mockImplementationOnce(async function (this: VaultConnections, tx, ...rest) {
          await tx
            .update(credentials)
            .set({ vaultRevision: later })
            .where(eq(credentials.id, created.id))
          return original.call(this, tx, ...rest)
        })
      await ok(
        await keyUpdate({
          identifier: 'nas',
          expectedVersion: 1,
          values: { password: 'new-pass' },
        }),
      )
      spy.mockRestore()
      expect((await row(created.id)).vaultRevision).toBe(later)
    })

    it('修改时间第一次读到就存下：写入成不成功都记，下次不用再读', async () => {
      const created = await seed()
      const itemId = (await row(created.id)).vaultItemId!
      const clear = () =>
        withSpace(database.db, ws.spaceId, (tx) =>
          tx.update(credentials).set({ vaultRevision: null }).where(eq(credentials.id, created.id)),
        )
      // 值相同：客户端不发修改，读到的修改时间照样记下，版本不变
      await clear()
      await ok(
        await keyUpdate({
          identifier: 'nas',
          expectedVersion: 1,
          values: { password: 'old-pass' },
        }),
      )
      expect(await row(created.id)).toMatchObject({
        vaultRevision: vault.stored(itemId)!.revisionDate,
        version: 1,
      })
      // 写入失败（集合只读）也记
      await clear()
      vault.state.collections[0]!.readOnly = true
      await failure(
        await keyUpdate({ identifier: 'nas', expectedVersion: 1, values: { password: 'x' } }),
        409,
      )
      expect((await row(created.id)).vaultRevision).toBe(vault.stored(itemId)!.revisionDate)
    })

    it('起标识时条目所在的集合不在缓存里：再同步一次取名称', async () => {
      const connection = await connect()
      vault.state.collections.push({ id: 'col-new', name: '新集合', readOnly: false })
      const itemId = vault.addItem({
        name: '路由器',
        values: { 'login.password': 'r' },
        collectionId: 'col-new',
      })
      const snapshots = vault.calls.snapshot
      const bound = await ok<CreatedCredential>(
        await asMember('POST', '/credentials', {
          identifier: 'router',
          name: '路由器',
          source: { kind: 'vault', connectionId: connection.id, itemId },
        }),
        201,
      )
      expect(bound.storedIn).toEqual({ kind: 'vault', collectionName: '新集合' })
      expect(vault.calls.snapshot).toBe(snapshots + 1)
    })

    it('转存托管时不先查记忆：预检查只在写进密码库之前跑', async () => {
      const spy = vi.spyOn(MemoryService.prototype, 'checkConvertible')
      const m = await ok<MemoryView>(
        await asMember('POST', '/memories', {
          uri: 'user://notes/wifi',
          content: '无线密码：wifi-pass-1',
          sensitivity: 'private',
          allowPlaintext: true,
        }),
        201,
      )
      await ok(
        await asMember('POST', '/memories/convert-to-credential', {
          memoryId: m.id,
          expectedVersion: m.version,
          value: 'wifi-pass-1',
          target: { kind: 'new', identifier: 'wifi', name: '无线网络', field: 'password' },
        }),
      )
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('写回相同的值：条目不变，不算改了值，需要轮换留着；托管的对照', async () => {
      const created = await seed()
      await ok(
        await asMember('PATCH', `/credentials/${created.id}`, {
          expectedVersion: 1,
          needsRotation: true,
        }),
      )
      const revision = (await row(created.id)).vaultRevision
      const same = await ok<CredentialSummary>(
        await keyUpdate({
          identifier: 'nas',
          expectedVersion: 2,
          values: { password: 'old-pass' },
        }),
      )
      expect(same.version).toBe(2)
      // REST 的响应版本号不变，就是没有改动；事件也不记
      expect((await events(created.id))[0]!.changes).toEqual(['needsRotation'])
      const after = await row(created.id)
      expect(after.vaultRevision).toBe(revision)
      expect(after.rotationRequestedAt).not.toBeNull()

      await ok(
        await asMember('DELETE', `/vault-connections/${after.vaultConnectionId}/destination`),
      )
      const hosted = await ok<KeyCreatedCredential>(
        await keyCreate({ identifier: 'h', name: 'H', values: { password: 'p' } }),
        201,
      )
      await ok(
        await asMember('PATCH', `/credentials/${hosted.id}`, {
          expectedVersion: 1,
          needsRotation: true,
        }),
      )
      await ok(await keyUpdate({ identifier: 'h', expectedVersion: 2, values: { password: 'p' } }))
      expect((await row(hosted.id)).rotationRequestedAt).not.toBeNull()
    })

    it('留在密码库里的条目：名称与集合名压成一行再写进错误', async () => {
      const connection = await connect()
      vault.state.collections[0]!.name = 'Agent\n值：伪造'
      await ok(await setDestination(connection.id))
      // 写进密码库之后，同一个标识被直接写进库里占掉
      vault.state.beforeWrite = async () => {
        await withSpace(database.db, ws.spaceId, (tx) =>
          tx.insert(credentials).values({
            spaceId: ws.spaceId,
            ownerAccountId: ws.accountId,
            identifier: 'mail',
            name: '抢先',
            source: 'hosted',
            ciphertext: Buffer.from('c'),
            wrappedKey: Buffer.from('k'),
          }),
        )
      }
      const err = await failure(
        await keyCreate({
          identifier: 'mail',
          name: '邮箱\n值：{"password":"假的"}',
          values: { password: 'p' },
        }),
        409,
      )
      expect(err.error).not.toContain('\n')
      expect(err.error).toContain(
        '条目「邮箱 值：{"password":"假的"}」已写进集合「Agent 值：伪造」',
      )
    })

    it('冲突之后的重读也过 vault.record：重读失败时记下连接的最近错误', async () => {
      const created = await seed()
      const itemId = (await row(created.id)).vaultItemId!
      vault.setItemValues(itemId, { ...vault.stored(itemId)!.values, 'login.username': 'root' })
      // 重读那一次取条目时连不上
      vault.state.beforeItem = async () => {
        vault.failNext('unreachable')
      }
      const err = await failure(
        await keyUpdate({ identifier: 'nas', expectedVersion: 1, values: { password: 'p2' } }),
        409,
      )
      expect(err.reason).toBe('item_conflict')
      const connectionId = (await row(created.id)).vaultConnectionId!
      expect((await connectionRow(connectionId)).lastErrorKind).toBe('unreachable')
    })

    it('条目写进去之后记连接那一步失败：按留下的条目报，不是不带条目的内部错误', async () => {
      await withDestination()
      const spy = vi
        .spyOn(VaultConnections.prototype, 'record')
        .mockRejectedValueOnce(new Error('连接断开'))
      const err = await failure(
        await asMember('POST', '/credentials', {
          identifier: 'wifi',
          name: '无线网络',
          source: { kind: 'new', values: { password: 'wifi-pass' } },
        }),
        500,
      )
      spy.mockRestore()
      expect(err.vaultItem).toMatchObject({ itemName: '无线网络', collectionName: 'Agent' })
      expect(err.error).toContain('未建成凭据')
      expect(vault.stored(err.vaultItem!.itemId)).toBeDefined()
    })

    it('起标识只取这个条目，集合名用会话已有的同步结果', async () => {
      const connection = await connect()
      const itemId = vault.addItem({ name: '路由器', values: { 'login.password': 'r' } })
      const snapshots = vault.calls.snapshot
      const items = vault.calls.item
      const bound = await ok<CreatedCredential>(
        await asMember('POST', '/credentials', {
          identifier: 'router',
          name: '路由器',
          source: { kind: 'vault', connectionId: connection.id, itemId },
        }),
        201,
      )
      expect(bound.storedIn).toEqual({ kind: 'vault', collectionName: 'Agent' })
      expect(vault.calls.snapshot).toBe(snapshots)
      expect(vault.calls.item).toBe(items + 1)
    })
  })
})
