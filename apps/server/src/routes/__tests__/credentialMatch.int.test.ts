import { randomBytes } from 'node:crypto'

import {
  ConvertedToCredential,
  CredentialValueMatches,
  type ConsoleCredential,
  type MemoryView,
  type VaultConnection,
} from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database, type Tx } from '../../db/client'
import {
  credentialEvents,
  credentials,
  memories,
  memoryEvents,
  vaultConnections,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeVault } from '../../testing/fakeVault'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const ROUTER_PW = 'router-pw-9fK2-long'
const NAS_PW = 'nas-secret-77Qx'
const API_TOKEN = 'api-value-123-abc'
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'
const NAS_TOTP = 'KRSXG5CTMVRXEZLU'
const HOSTED_PW = 'hosted-pw-correct-horse'

describe.skipIf(!testDatabaseUrl)('按值查找与转存的去处', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  const vault = fakeVault()
  vault.addAccount('agent@example.com', 'master-pw')
  const routerItem = vault.addItem({
    name: '路由器',
    values: {
      'login.username': 'admin',
      'login.password': ROUTER_PW,
      'login.totp': TOTP_SECRET,
      'field:api': API_TOKEN,
    },
  })
  const nasItem = vault.addItem({
    name: 'NAS',
    values: { 'login.username': 'nas-admin', 'login.password': NAS_PW, 'login.totp': NAS_TOTP },
  })

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
      vault: vault.client,
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    vault.setItemValues(routerItem, {
      'login.username': 'admin',
      'login.password': ROUTER_PW,
      'login.totp': TOTP_SECRET,
      'field:api': API_TOKEN,
    })
  })

  const inSpace = <T>(fn: (tx: Tx) => Promise<T>) => withSpace(database.db, ws.spaceId, fn)
  const send = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(
      `/v1/spaces/${ws.spaceId}${path}`,
      body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const errorOf = async (res: Response, status: number) => {
    expect(res.status).toBe(status)
    return ((await res.json()) as { error: string }).error
  }
  const connect = async () =>
    (
      await ok<{ connection: VaultConnection }>(
        await send('POST', '/vault-connections', {
          serverUrl: 'https://vault.example.com',
          email: 'agent@example.com',
          masterPassword: 'master-pw',
        }),
      )
    ).connection
  const hosted = async (identifier: string, values: Record<string, string>) =>
    ok<ConsoleCredential>(
      await send('POST', '/credentials', {
        identifier,
        name: `托管 ${identifier}`,
        source: { kind: 'hosted', values },
      }),
      201,
    )
  // 路由器条目起标识，只对应用户名、密码与验证码：field:api 不对应
  const bindRouter = async (connectionId: string) =>
    ok<ConsoleCredential>(
      await send('POST', '/credentials', {
        identifier: 'router',
        name: '路由器',
        source: {
          kind: 'vault',
          connectionId,
          itemId: routerItem,
          fields: [
            { name: 'username', itemField: 'login.username' },
            { name: 'password', itemField: 'login.password' },
            { name: 'totp', itemField: 'login.totp' },
          ],
        },
      }),
      201,
    )
  const match = (values: string[], cookie = ws.cookie) =>
    send('POST', '/credentials/match', { values }, cookie)
  const matched = async (values: string[]) =>
    CredentialValueMatches.parse(await ok(await match(values)))
  const accessEvents = async () =>
    (
      await inSpace((tx) =>
        tx.select().from(credentialEvents).where(eq(credentialEvents.eventType, 'access')),
      )
    ).length

  describe('按值查找', () => {
    it('托管的解开比，按字面比较；对不上的是空的', async () => {
      const cred = await hosted('file-server', { username: 'alice', password: HOSTED_PW })
      const before = { ...vault.calls }
      const res = await matched([HOSTED_PW, 'hosted-pw-correct-HORSE', 'alice-not'])
      expect(res.items[0]).toEqual({
        credentials: [
          { id: cred.id, identifier: 'file-server', name: '托管 file-server', field: 'password' },
        ],
        vaultItems: [],
      })
      expect(res.items[1]).toEqual({ credentials: [], vaultItems: [] })
      expect(res.items[2]).toEqual({ credentials: [], vaultItems: [] })
      expect(res.unavailableConnections).toBe(0)
      // 没有连接：不建会话、不请求密码库
      expect(vault.calls).toEqual(before)
      expect(await accessEvents()).toBe(0)
    })

    it('密码库：已对应的列在 credentials，没起标识与起了标识却没对应的列在 vaultItems；TOTP 的密钥不比', async () => {
      const connection = await connect()
      const router = await bindRouter(connection.id)
      const before = vault.calls.items
      const res = await matched([ROUTER_PW, NAS_PW, API_TOKEN, TOTP_SECRET, NAS_TOTP])
      // 一个连接一次同步取全部条目，不逐个取
      expect(vault.calls.items).toBe(before + 1)
      expect(res.items[0]).toEqual({
        credentials: [{ id: router.id, identifier: 'router', name: '路由器', field: 'password' }],
        vaultItems: [],
      })
      expect(res.items[1]).toEqual({
        credentials: [],
        vaultItems: [
          {
            connectionId: connection.id,
            itemId: nasItem,
            itemName: 'NAS',
            itemField: 'login.password',
            credential: null,
          },
        ],
      })
      expect(res.items[2]).toEqual({
        credentials: [],
        vaultItems: [
          {
            connectionId: connection.id,
            itemId: routerItem,
            itemName: '路由器',
            itemField: 'field:api',
            credential: { id: router.id, identifier: 'router' },
          },
        ],
      })
      // TOTP 的密钥：已对应的（路由器）与没起标识的（NAS）都不比
      expect(res.items[3]).toEqual({ credentials: [], vaultItems: [] })
      expect(res.items[4]).toEqual({ credentials: [], vaultItems: [] })
      expect(res.unavailableConnections).toBe(0)
      expect(await accessEvents()).toBe(0)
    })

    it('响应不带值，不记访问事件', async () => {
      const connection = await connect()
      await bindRouter(connection.id)
      const res = await match([ROUTER_PW, NAS_PW])
      const text = await res.text()
      for (const value of [ROUTER_PW, NAS_PW, TOTP_SECRET, API_TOKEN, 'admin']) {
        expect(text).not.toContain(value)
      }
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await accessEvents()).toBe(0)
    })

    it('不可用的连接计进 unavailableConnections，不向它请求；指着它的凭据不比', async () => {
      const connection = await connect()
      await bindRouter(connection.id)
      await inSpace((tx) =>
        tx
          .update(vaultConnections)
          .set({ status: 'reauth_required' })
          .where(eq(vaultConnections.id, connection.id)),
      )
      const before = { ...vault.calls }
      const res = await matched([ROUTER_PW])
      expect(res.items[0]).toEqual({ credentials: [], vaultItems: [] })
      expect(res.unavailableConnections).toBe(1)
      expect(vault.calls.items).toBe(before.items)
      expect(vault.calls.sessions).toBe(before.sessions)
    })

    it('密码库连不上时计进 unavailableConnections，并记下连接最近的错误', async () => {
      const connection = await connect()
      vault.failNext('unreachable')
      const res = await matched([NAS_PW])
      expect(res.items[0]).toEqual({ credentials: [], vaultItems: [] })
      expect(res.unavailableConnections).toBe(1)
      const [row] = await inSpace((tx) =>
        tx.select().from(vaultConnections).where(eq(vaultConnections.id, connection.id)),
      )
      expect(row!.lastErrorKind).toBe('unreachable')
      expect(row!.status).toBe('ok')
    })

    it('断开、又没有凭据指着的连接不算读不了', async () => {
      const connection = await connect()
      await ok(await send('POST', `/vault-connections/${connection.id}/disconnect`))
      expect((await matched([NAS_PW])).unavailableConnections).toBe(0)
    })

    it('只给空间所有者，别的成员 403', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      expect(await errorOf(await match([HOSTED_PW], editor.cookie), 403)).toContain('空间所有者')
    })

    it('值的校验：太短、带空白、含占位符的 400', async () => {
      expect((await match(['abc'])).status).toBe(400)
      expect((await match([' padded-value'])).status).toBe(400)
      expect((await match(['{{cred:x}}abcd'])).status).toBe(400)
      expect((await match([])).status).toBe(400)
    })
  })

  describe('转存的去处', () => {
    const NOTE = (value: string) => `路由器的管理密码：${value}，备用写法 ${value}`
    const remember = async (content: string, uri = 'user://notes/router') =>
      ok<MemoryView>(await send('POST', '/memories', { uri, content }), 201)
    const convert = (m: MemoryView, value: string, target: Record<string, unknown>) =>
      send('POST', '/memories/convert-to-credential', {
        memoryId: m.id,
        expectedVersion: m.version,
        value,
        target,
      })
    const rowOf = async (id: string) =>
      (await inSpace((tx) => tx.select().from(memories).where(eq(memories.id, id))))[0]!
    const eventCount = async (id: string) =>
      (await inSpace((tx) => tx.select().from(memoryEvents).where(eq(memoryEvents.memoryId, id))))
        .length
    const credentialRows = () => inSpace((tx) => tx.select().from(credentials))
    // 失败时什么都没改：正文、版本、事件与凭据都和之前一样
    const untouched = async (m: MemoryView, content: string, credentialCount: number) => {
      const row = await rowOf(m.id)
      expect(row.content).toBe(content)
      expect(row.version).toBe(m.version)
      expect(await eventCount(m.id)).toBe(1)
      expect(await credentialRows()).toHaveLength(credentialCount)
    }

    it('credential：换成已有托管凭据的字段，不新建', async () => {
      const cred = await hosted('router-admin', { password: ROUTER_PW })
      const m = await remember(NOTE(ROUTER_PW))
      const res = ConvertedToCredential.parse(
        await ok(
          await convert(m, ROUTER_PW, {
            kind: 'credential',
            credentialId: cred.id,
            field: 'password',
          }),
        ),
      )
      expect(res.created).toBe(false)
      expect(res.field).toBe('password')
      expect(res.credential.id).toBe(cred.id)
      expect(res.credential.referenceCount).toBe(1)
      expect(res.replaced).toBe(2)
      expect((await rowOf(m.id)).content).toBe(NOTE('{{cred:router-admin#password}}'))
      expect(await credentialRows()).toHaveLength(1)
    })

    it('credential：密码库来源的，向条目核对值', async () => {
      const connection = await connect()
      const router = await bindRouter(connection.id)
      const m = await remember(NOTE(ROUTER_PW))
      const before = vault.calls.item
      const res = ConvertedToCredential.parse(
        await ok(
          await convert(m, ROUTER_PW, {
            kind: 'credential',
            credentialId: router.id,
            field: 'password',
          }),
        ),
      )
      expect(vault.calls.item).toBe(before + 1)
      expect(res.created).toBe(false)
      expect((await rowOf(m.id)).content).toBe(NOTE('{{cred:router#password}}'))
    })

    it('credential：字段现在的值不同时 400，文字不带值，什么都不改', async () => {
      const cred = await hosted('router-admin', { password: 'another-value-1' })
      const m = await remember(NOTE(ROUTER_PW))
      const res = await convert(m, ROUTER_PW, {
        kind: 'credential',
        credentialId: cred.id,
        field: 'password',
      })
      const error = await errorOf(res, 400)
      expect(error).toContain('值不同')
      expect(error).not.toContain(ROUTER_PW)
      expect(error).not.toContain('another-value-1')
      await untouched(m, NOTE(ROUTER_PW), 1)

      // 密码库来源的，条目里的值改过了
      const connection = await connect()
      const router = await bindRouter(connection.id)
      vault.setItemValues(routerItem, { 'login.password': 'rotated-pw-000' })
      const vaultRes = await convert(m, ROUTER_PW, {
        kind: 'credential',
        credentialId: router.id,
        field: 'password',
      })
      expect(await errorOf(vaultRes, 400)).not.toContain('rotated-pw-000')
      await untouched(m, NOTE(ROUTER_PW), 2)
    })

    it('credential：验证码字段不能用，不存在的字段与已删除的凭据也不行', async () => {
      const connection = await connect()
      const router = await bindRouter(connection.id)
      const m = await remember(NOTE(TOTP_SECRET))
      expect(
        (
          await convert(m, TOTP_SECRET, {
            kind: 'credential',
            credentialId: router.id,
            field: 'totp',
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await convert(m, TOTP_SECRET, {
            kind: 'credential',
            credentialId: router.id,
            field: 'pin',
          })
        ).status,
      ).toBe(400)
      const other = await hosted('gone', { password: TOTP_SECRET })
      expect((await send('DELETE', `/credentials/${other.id}`)).status).toBe(204)
      expect(
        (
          await convert(m, TOTP_SECRET, {
            kind: 'credential',
            credentialId: other.id,
            field: 'password',
          })
        ).status,
      ).toBe(409)
      await untouched(m, NOTE(TOTP_SECRET), 2)
    })

    it('vault：给还没起标识的条目起标识、建凭据，再换；名称默认用条目的', async () => {
      const connection = await connect()
      const m = await remember(NOTE(NAS_PW))
      const res = ConvertedToCredential.parse(
        await ok(
          await convert(m, NAS_PW, {
            kind: 'vault',
            connectionId: connection.id,
            itemId: nasItem,
            itemField: 'login.password',
            identifier: 'nas',
          }),
        ),
      )
      expect(res.created).toBe(true)
      expect(res.field).toBe('password')
      expect(res.credential).toMatchObject({
        identifier: 'nas',
        name: 'NAS',
        source: 'vault',
        vault: { connectionId: connection.id, itemId: nasItem },
        referenceCount: 1,
      })
      expect(res.credential.fields).toEqual([
        { name: 'username', itemField: 'login.username' },
        { name: 'password', itemField: 'login.password' },
        { name: 'totp', itemField: 'login.totp' },
      ])
      expect((await rowOf(m.id)).content).toBe(NOTE('{{cred:nas#password}}'))
      expect(JSON.stringify(res)).not.toContain(NAS_PW)
    })

    it('vault：值不同时 400，不建凭据、不改记忆', async () => {
      const connection = await connect()
      const m = await remember(NOTE('nas-secret-WRONG'))
      const res = await convert(m, 'nas-secret-WRONG', {
        kind: 'vault',
        connectionId: connection.id,
        itemId: nasItem,
        itemField: 'login.password',
        identifier: 'nas',
      })
      const error = await errorOf(res, 400)
      expect(error).not.toContain('nas-secret-WRONG')
      expect(error).not.toContain(NAS_PW)
      await untouched(m, NOTE('nas-secret-WRONG'), 0)
    })

    it('vault：条目已经有凭据时 409，提示改用已有的凭据', async () => {
      const connection = await connect()
      await bindRouter(connection.id)
      const m = await remember(NOTE(ROUTER_PW))
      const before = vault.calls.item
      const res = await convert(m, ROUTER_PW, {
        kind: 'vault',
        connectionId: connection.id,
        itemId: routerItem,
        itemField: 'login.password',
        identifier: 'router-2',
      })
      expect(await errorOf(res, 409)).toContain('改用')
      // 不用向密码库请求就知道
      expect(vault.calls.item).toBe(before)
      await untouched(m, NOTE(ROUTER_PW), 1)
    })

    it('vault：标识冲突 409，凭据与记忆都不留下', async () => {
      const connection = await connect()
      await hosted('nas', { password: 'whatever-1' })
      const m = await remember(NOTE(NAS_PW))
      const res = await convert(m, NAS_PW, {
        kind: 'vault',
        connectionId: connection.id,
        itemId: nasItem,
        itemField: 'login.password',
        identifier: 'nas',
      })
      expect(await errorOf(res, 409)).toContain('nas')
      await untouched(m, NOTE(NAS_PW), 1)
      const live = await inSpace((tx) =>
        tx
          .select()
          .from(credentials)
          .where(and(eq(credentials.vaultItemId, nasItem))),
      )
      expect(live).toHaveLength(0)
    })

    it('vault：验证码字段不能用；连接不可用时 409', async () => {
      const connection = await connect()
      const m = await remember(NOTE(TOTP_SECRET))
      const base = {
        kind: 'vault',
        connectionId: connection.id,
        itemId: routerItem,
        identifier: 'router',
      }
      expect((await convert(m, TOTP_SECRET, { ...base, itemField: 'login.totp' })).status).toBe(400)
      await inSpace((tx) =>
        tx
          .update(vaultConnections)
          .set({ status: 'reauth_required' })
          .where(eq(vaultConnections.id, connection.id)),
      )
      const n = await remember(NOTE(ROUTER_PW), 'user://notes/router-2')
      expect((await convert(n, ROUTER_PW, { ...base, itemField: 'login.password' })).status).toBe(
        409,
      )
    })

    it('不是空间所有者 403', async () => {
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      const cred = await hosted('router-admin', { password: ROUTER_PW })
      const res = await app.request(
        `/v1/spaces/${ws.spaceId}/memories/convert-to-credential`,
        jsonRequest(
          'POST',
          {
            memoryId: '00000000-0000-4000-8000-000000000000',
            expectedVersion: 1,
            value: ROUTER_PW,
            target: { kind: 'credential', credentialId: cred.id, field: 'password' },
          },
          { cookie: editor.cookie },
        ),
      )
      expect(res.status).toBe(403)
    })
  })
})
