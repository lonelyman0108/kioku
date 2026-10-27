import { randomBytes } from 'node:crypto'

import type {
  ConsoleCredential,
  ConsoleCredentialList,
  CredentialAccess,
  CredentialEventList,
  CredentialProvider,
  CredentialSummary,
  CredentialValues,
  KeyCredentialList,
  KeyScopes,
} from '@kioku/contracts'
import { LAYERS } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { createSession } from '../../auth/session'
import { accounts, credentialEvents, credentials, spaceMembers } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  addMember,
  bearer,
  bootstrap,
  FULL_SCOPES,
  jsonRequest,
  type Workspace,
} from '../../testing/fixtures'

const PASSWORD = 'pw-correct-horse-staple'
const withoutPrivate = LAYERS.filter((l) => l !== 'private')
const PRIVATE_LEVEL: KeyScopes = { ...FULL_SCOPES, maxSensitivity: 'private' }

describe.skipIf(!testDatabaseUrl)('凭据', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
  })

  const space = () => `/v1/spaces/${ws.spaceId}`
  const send = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    app.request(
      path,
      body === undefined
        ? { method, headers: { 'sec-fetch-site': 'same-origin', ...(headers ?? {}) } }
        : jsonRequest(method, body, headers ?? {}),
    )
  // 管理界面的请求，默认是空间 owner（alice）
  const asMember = (method: string, path: string, body?: unknown, cookie: string = ws.cookie) =>
    send(method, `${space()}${path}`, body, { cookie })
  const asKey = (method: string, path: string, key: string, body?: unknown) =>
    send(method, `/v1${path}`, body, bearer(key))
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (status === 204 ? undefined : await res.json()) as T
  }
  const errorOf = async (res: Response, status: number) => {
    expect(res.status).toBe(status)
    return ((await res.json()) as { error: string }).error
  }

  const hosted = (identifier = 'file-server', values: Record<string, string> = {}) => ({
    identifier,
    name: '文件服务器',
    description: '管理后台的登录账号',
    source: { kind: 'hosted', values: { username: 'alice', password: PASSWORD, ...values } },
  })
  const createCredential = async (body: unknown, cookie = ws.cookie) =>
    ok<ConsoleCredential>(await asMember('POST', '/credentials', body, cookie), 201)
  const createProvider = async (cookie = ws.cookie) =>
    ok<CredentialProvider>(
      await asMember(
        'POST',
        '/credential-providers',
        { kind: 'bitwarden', name: '密码库', instructions: '在工作站上用 bw，先 bw unlock' },
        cookie,
      ),
      201,
    )
  const external = (providerId: string, identifier = 'router') => ({
    identifier,
    name: '路由器',
    source: {
      kind: 'external',
      providerId,
      location: 'router admin',
      fields: [{ name: 'password', sourceField: 'password' }],
    },
  })
  const keyFor = async (scopes: KeyScopes = FULL_SCOPES, slug = 'agent') =>
    ws.issueKey((await ws.createApp(slug)).id, scopes)

  it('管理界面新建托管的凭据：列表与详情不含值，查看要单独请求并记一条访问事件', async () => {
    const created = await createCredential(hosted())
    expect(created.fields).toEqual([
      { name: 'password', sourceField: null },
      { name: 'username', sourceField: null },
    ])
    expect(created.appIds).toBeNull()
    expect(JSON.stringify(created)).not.toContain(PASSWORD)
    const list = await ok<ConsoleCredentialList>(await asMember('GET', '/credentials'))
    expect(list.items.map((c) => c.identifier)).toEqual(['file-server'])
    expect(JSON.stringify(list)).not.toContain(PASSWORD)

    const revealed = await asMember('POST', `/credentials/${created.id}/reveal`)
    expect(revealed.headers.get('cache-control')).toBe('no-store')
    expect((await ok<CredentialValues>(revealed)).values).toEqual({
      username: 'alice',
      password: PASSWORD,
    })

    const events = await ok<CredentialEventList>(
      await asMember('GET', `/credentials/${created.id}/events`),
    )
    expect(events.items.map((e) => [e.type, e.via, e.fields])).toEqual([
      ['access', 'console', ['password', 'username']],
      ['create', null, []],
    ])
    expect(events.items[0]!.actor.accountName).toBe('alice')

    // 库里只有密文，事件里也没有值
    const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(credentials).where(eq(credentials.id, created.id)),
    )
    expect(row!.ciphertext!.includes(Buffer.from(PASSWORD))).toBe(false)
    const stored = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(credentialEvents),
    )
    expect(JSON.stringify(stored)).not.toContain(PASSWORD)
  })

  it('修改托管的值：只给要改的字段，null 删掉字段；版本不对返回 409', async () => {
    const created = await createCredential(hosted())
    const updated = await ok<ConsoleCredential>(
      await asMember('PATCH', `/credentials/${created.id}`, {
        expectedVersion: created.version,
        source: {
          kind: 'hosted',
          values: { password: 'changed-pw', token: 'tok', username: null },
        },
      }),
    )
    expect(updated.fields.map((f) => f.name)).toEqual(['password', 'token'])
    expect(
      (await ok<CredentialValues>(await asMember('POST', `/credentials/${created.id}/reveal`)))
        .values,
    ).toEqual({ password: 'changed-pw', token: 'tok' })
    const events = await ok<CredentialEventList>(
      await asMember('GET', `/credentials/${created.id}/events`),
    )
    const update = events.items.find((e) => e.type === 'update')!
    expect(update.changes).toEqual(['fields', 'values'])
    expect(update.fields).toEqual(['password', 'token', 'username'])

    // 拿旧版本号再改
    expect(
      await errorOf(
        await asMember('PATCH', `/credentials/${created.id}`, {
          expectedVersion: created.version,
          name: '别的名字',
        }),
        409,
      ),
    ).toContain('版本已变化')
    // 字段全删掉
    expect(
      await errorOf(
        await asMember('PATCH', `/credentials/${created.id}`, {
          expectedVersion: updated.version,
          source: { kind: 'hosted', values: { password: null, token: null } },
        }),
        400,
      ),
    ).toContain('至少要有一个字段')
  })

  it('外部来源只存条目位置；凭据源还被有效的凭据绑定时不能删，删掉之后恢复的凭据显示凭据源已删除', async () => {
    const provider = await createProvider()
    const credential = await createCredential(external(provider.id))
    expect(credential.source).toBe('external')
    expect(credential.location).toBe('router admin')
    expect(credential.provider).toEqual({
      id: provider.id,
      kind: 'bitwarden',
      name: '密码库',
      deleted: false,
    })
    const [listed] = await ok<CredentialProvider[]>(await asMember('GET', '/credential-providers'))
    expect(listed!.credentialCount).toBe(1)
    expect(
      await errorOf(await asMember('DELETE', `/credential-providers/${provider.id}`), 409),
    ).toContain('还有 1 条凭据')
    // 外部来源的值不在 Kioku 里
    expect(
      await errorOf(await asMember('POST', `/credentials/${credential.id}/reveal`), 400),
    ).toContain('外部凭据源')

    await ok(await asMember('DELETE', `/credentials/${credential.id}`), 204)
    await ok(await asMember('DELETE', `/credential-providers/${provider.id}`), 204)
    expect(await ok<CredentialProvider[]>(await asMember('GET', '/credential-providers'))).toEqual(
      [],
    )
    const restored = await ok<ConsoleCredential>(
      await asMember('POST', `/credentials/${credential.id}/undelete`),
    )
    expect(restored.provider?.deleted).toBe(true)
    const key = await keyFor()
    const used = await ok<CredentialAccess>(
      await asKey('GET', '/credentials?identifier=router', key),
    )
    expect(used.provider).toBeNull()
    expect(used.method).toContain('凭据源已被删除')
    // 不能再绑定到已删除的凭据源
    expect(
      await errorOf(await asMember('POST', '/credentials', external(provider.id, 'other')), 404),
    ).toBe('凭据源不存在')
  })

  it('每个成员只看得到自己的凭据与凭据源，空间 owner 也看不到别人的', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
    const mine = await createCredential(hosted())
    // 标识按成员各占一份
    const his = await createCredential(hosted(), bob.cookie)
    const hisProvider = await createProvider(bob.cookie)

    expect(
      (await ok<ConsoleCredentialList>(await asMember('GET', '/credentials'))).items.map(
        (c) => c.id,
      ),
    ).toEqual([mine.id])
    for (const [method, path] of [
      ['GET', `/credentials/${his.id}`],
      ['POST', `/credentials/${his.id}/reveal`],
      ['GET', `/credentials/${his.id}/events`],
      ['DELETE', `/credentials/${his.id}`],
    ] as const) {
      expect((await asMember(method, path)).status).toBe(404)
    }
    expect(
      (await asMember('PATCH', `/credentials/${his.id}`, { expectedVersion: 1, name: 'x' })).status,
    ).toBe(404)
    expect(await ok<CredentialProvider[]>(await asMember('GET', '/credential-providers'))).toEqual(
      [],
    )
    expect(
      (await asMember('POST', '/credentials', external(hisProvider.id, 'borrowed'))).status,
    ).toBe(404)
    expect(
      (await asMember('PATCH', `/credential-providers/${hisProvider.id}`, { name: '改名' })).status,
    ).toBe(404)
    // 不是空间成员
    const [stranger] = await database.db
      .insert(accounts)
      .values({ username: 'mallory', displayName: 'mallory', passwordHash: 'x' })
      .returning()
    const cookie = `kioku_session=${await createSession(database.db, stranger!.id)}`
    expect((await asMember('GET', '/credentials', undefined, cookie)).status).toBe(403)
  })

  it('editor 与 viewer 不能管理凭据，也看不到托管的值，只看得到自己凭据的说明', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
    const his = await createCredential(hosted(), bob.cookie)
    await database.db
      .update(spaceMembers)
      .set({ role: 'editor' })
      .where(eq(spaceMembers.accountId, bob.accountId))
    expect(
      (
        await ok<ConsoleCredentialList>(
          await asMember('GET', '/credentials', undefined, bob.cookie),
        )
      ).items,
    ).toHaveLength(1)
    expect(
      await errorOf(
        await asMember('POST', `/credentials/${his.id}/reveal`, undefined, bob.cookie),
        403,
      ),
    ).toContain('空间 owner')
    expect(
      (
        await asMember(
          'PATCH',
          `/credentials/${his.id}`,
          { expectedVersion: his.version, name: '改名' },
          bob.cookie,
        )
      ).status,
    ).toBe(403)
    expect((await asMember('DELETE', `/credentials/${his.id}`, undefined, bob.cookie)).status).toBe(
      403,
    )
    const viewer = await addMember(database.db, ws.spaceId, 'carol', 'viewer')
    expect((await asMember('POST', '/credentials', hosted(), viewer.cookie)).status).toBe(403)
    expect(
      (
        await asMember(
          'POST',
          '/credential-providers',
          {
            kind: 'env',
            name: '环境变量',
          },
          viewer.cookie,
        )
      ).status,
    ).toBe(403)
  })

  it('Key：secret 级取得到托管的值，private 级只给说明与外部绑定；读不到私人层的 Key 看不到凭据', async () => {
    await createCredential(hosted())
    const provider = await createProvider()
    await createCredential(external(provider.id))

    const full = await keyFor()
    const all = await ok<CredentialAccess>(
      await asKey('GET', '/credentials?identifier=file-server', full),
    )
    expect(all.values).toEqual({ username: 'alice', password: PASSWORD })
    expect(all.notice).toContain('不要把值写进记忆')
    const one = await ok<CredentialAccess>(
      await asKey('GET', '/credentials?identifier=file-server&field=password', full),
    )
    expect(one.values).toEqual({ password: PASSWORD })
    expect(
      await errorOf(await asKey('GET', '/credentials?identifier=file-server&field=pin', full), 404),
    ).toContain('没有字段 pin')

    // 列表只有说明，不含外部条目的位置
    const list = await ok<KeyCredentialList>(await asKey('GET', '/credentials/list', full))
    expect(list.items.map((c) => [c.identifier, c.fields])).toEqual([
      ['file-server', ['password', 'username']],
      ['router', ['password']],
    ])
    expect(JSON.stringify(list)).not.toContain('router admin')
    expect(list.providers.map((p) => p.id)).toEqual([provider.id])

    const privateKey = await keyFor(PRIVATE_LEVEL, 'reader')
    const hostedOnly = await ok<CredentialAccess>(
      await asKey('GET', '/credentials?identifier=file-server', privateKey),
    )
    expect(hostedOnly.values).toBeNull()
    expect(hostedOnly.method).toContain('secret 级')
    const bound = await ok<CredentialAccess>(
      await asKey('GET', '/credentials?identifier=router', privateKey),
    )
    expect(bound.credential.location).toBe('router admin')
    expect(bound.provider).toEqual({
      kind: 'bitwarden',
      name: '密码库',
      instructions: '在工作站上用 bw，先 bw unlock',
    })
    expect(bound.method).toContain('bw get item "router admin"')
    expect((await asKey('POST', '/credentials', privateKey, hosted('new-one'))).status).toBe(403)

    const blind = await keyFor({ ...FULL_SCOPES, readLayers: withoutPrivate }, 'blind')
    expect((await asKey('GET', '/credentials?identifier=file-server', blind)).status).toBe(404)
    expect((await asKey('GET', '/credentials/list', blind)).status).toBe(403)
    expect((await asKey('POST', '/credentials', blind, hosted('new-one'))).status).toBe(403)

    // 只读不写私人层的 secret 级 Key 能取值，不能管理凭据（只写不读的就是上面的 blind）
    const readOnly = await keyFor({ ...FULL_SCOPES, writeLayers: withoutPrivate }, 'read-only')
    expect((await asKey('POST', '/credentials', readOnly, hosted('new-one'))).status).toBe(403)
    expect(
      (
        await ok<CredentialAccess>(
          await asKey('GET', '/credentials?identifier=file-server', readOnly),
        )
      ).values,
    ).not.toBeNull()

    // 取到值或绑定时才记访问事件：private 级的 Key 取托管的凭据没有记
    const [fileServer] = (await ok<ConsoleCredentialList>(await asMember('GET', '/credentials')))
      .items
    const events = await ok<CredentialEventList>(
      await asMember('GET', `/credentials/${fileServer!.id}/events`),
    )
    expect(
      events.items.filter((e) => e.type === 'access').map((e) => [e.via, e.actor.appName]),
    ).toEqual([
      ['rest', 'read-only'],
      ['rest', 'agent'],
      ['rest', 'agent'],
    ])
  })

  it('Key 新建的凭据只给这个应用用；限定给别的应用的，读、改、删一律 404，撞名返回同一个错误', async () => {
    const appA = await ws.createApp('app-a')
    const appB = await ws.createApp('app-b')
    const keyA = await ws.issueKey(appA.id, FULL_SCOPES)
    const keyB = await ws.issueKey(appB.id, { ...FULL_SCOPES, admin: true })

    const created = await ok<CredentialSummary>(
      await asKey('POST', '/credentials', keyA, hosted('api-token')),
      201,
    )
    expect(created.fields).toEqual(['password', 'username'])
    const [inConsole] = (await ok<ConsoleCredentialList>(await asMember('GET', '/credentials')))
      .items
    expect(inConsole!.appIds).toEqual([appA.id])

    // 跨人格 / 应用写入的 Key 也不放宽
    expect((await asKey('GET', '/credentials?identifier=api-token', keyB)).status).toBe(404)
    expect(
      (await asKey('PATCH', '/credentials', keyB, { identifier: 'api-token', expectedVersion: 1 }))
        .status,
    ).toBe(404)
    expect((await asKey('DELETE', '/credentials?identifier=api-token', keyB)).status).toBe(404)
    expect(
      (await ok<KeyCredentialList>(await asKey('GET', '/credentials/list', keyB))).items,
    ).toEqual([])
    // 撞名：看得到的与看不到的同一个错误
    const hidden = await errorOf(
      await asKey('POST', '/credentials', keyB, hosted('api-token')),
      409,
    )
    const visible = await errorOf(
      await asKey('POST', '/credentials', keyA, hosted('api-token')),
      409,
    )
    expect(hidden).toBe('标识已被占用或不可用：api-token')
    expect(visible).toBe(hidden)

    // Key 改不了限定的应用：请求里带上也不生效
    await ok(
      await asKey('PATCH', '/credentials', keyA, {
        identifier: 'api-token',
        expectedVersion: created.version,
        appIds: null,
      }),
    )
    const after = await ok<ConsoleCredential>(await asMember('GET', `/credentials/${created.id}`))
    expect(after.appIds).toEqual([appA.id])
    // 在管理界面放宽之后，别的应用就能用了
    await ok(
      await asMember('PATCH', `/credentials/${created.id}`, {
        expectedVersion: after.version,
        appIds: [appA.id, appB.id],
      }),
    )
    expect((await asKey('GET', '/credentials?identifier=api-token', keyB)).status).toBe(200)
  })

  it('删除后用同一个标识新建，有有效的同名凭据时旧的不能恢复', async () => {
    const first = await createCredential(hosted())
    await ok(await asMember('DELETE', `/credentials/${first.id}`), 204)
    const deleted = await ok<ConsoleCredentialList>(await asMember('GET', '/credentials/deleted'))
    expect(deleted.items.map((c) => c.id)).toEqual([first.id])
    const second = await createCredential(hosted('file-server', { password: 'second-pw' }))
    // 引用按标识解析，取到的是新的那条
    const key = await keyFor()
    const used = await ok<CredentialAccess>(
      await asKey('GET', '/credentials?identifier=file-server', key),
    )
    expect(used.credential.id).toBe(second.id)
    expect(
      await errorOf(await asMember('POST', `/credentials/${first.id}/undelete`), 409),
    ).toContain('同一个标识已经有一条有效的凭据')
    await ok(await asMember('DELETE', `/credentials/${second.id}`), 204)
    const restored = await ok<ConsoleCredential>(
      await asMember('POST', `/credentials/${first.id}/undelete`),
    )
    expect(restored.deletedAt).toBeNull()
    expect(await errorOf(await asMember('POST', `/credentials/${first.id}/undelete`), 409)).toBe(
      '这条凭据没有被删除',
    )
  })

  it('没有配置主密钥时，托管的凭据报清楚的错误，外部的照常', async () => {
    const plain = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: null,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
    const res = await plain.request(
      `${space()}/credentials`,
      jsonRequest('POST', hosted(), { cookie: ws.cookie }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('KIOKU_MASTER_KEY')
    const provider = await createProvider()
    const ext = await plain.request(
      `${space()}/credentials`,
      jsonRequest('POST', external(provider.id), { cookie: ws.cookie }),
    )
    expect(ext.status).toBe(201)
  })

  describe('MCP 工具', () => {
    let id = 0
    async function callTool(key: string, name: string, args: Record<string, unknown>) {
      const res = await app.request('/v1/mcp', {
        method: 'POST',
        headers: {
          ...bearer(key),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      })
      const body = (await res.json()) as {
        result: { content: { text: string }[]; isError?: boolean }
      }
      return { text: body.result.content[0]!.text, isError: body.result.isError === true }
    }

    it('新建、取用、列出、修改与删除', async () => {
      const key = await keyFor()
      const created = await callTool(key, 'kioku_credential_save', {
        identifier: 'mail',
        name: '邮箱',
        values: { password: PASSWORD },
      })
      expect(created).toEqual({
        text: '已新建凭据 mail（邮箱）：Kioku 托管，字段 password，版本 1',
        isError: false,
      })
      // 不给版本号就是新建，已有的不会被覆盖
      const again = await callTool(key, 'kioku_credential_save', {
        identifier: 'mail',
        name: '邮箱',
        values: { password: 'other' },
      })
      expect(again).toEqual({ text: '标识已被占用或不可用：mail', isError: true })

      const used = await callTool(key, 'kioku_credential', { identifier: 'mail' })
      expect(used.text).toContain(`值：{"password":"${PASSWORD}"}`)
      expect(used.text).toContain('不要把值写进记忆')
      const listed = await callTool(key, 'kioku_credential', {})
      expect(listed.text).toContain('- mail（邮箱）：Kioku 托管，字段 password，版本 1')
      expect(listed.text).not.toContain(PASSWORD)

      const missingName = await callTool(key, 'kioku_credential_save', {
        identifier: 'other',
        values: { password: 'x' },
      })
      expect(missingName.isError).toBe(true)
      const both = await callTool(key, 'kioku_credential_save', {
        identifier: 'other',
        name: '别的',
        values: { password: 'x' },
        location: 'somewhere',
      })
      expect(both.text).toContain('只能给一种')

      const updated = await callTool(key, 'kioku_credential_save', {
        identifier: 'mail',
        expected_version: 1,
        values: { password: null, token: 'tok' },
      })
      expect(updated.text).toBe('已修改凭据 mail（邮箱）：Kioku 托管，字段 token，版本 2')
      expect((await callTool(key, 'kioku_credential_delete', { identifier: 'mail' })).text).toBe(
        '已删除凭据 mail',
      )
      expect((await callTool(key, 'kioku_credential', { identifier: 'mail' })).text).toBe(
        '凭据不存在：mail',
      )

      const [mail] = (
        await ok<ConsoleCredentialList>(await asMember('GET', '/credentials/deleted'))
      ).items
      const events = await ok<CredentialEventList>(
        await asMember('GET', `/credentials/${mail!.id}/events`),
      )
      expect(events.items.map((e) => [e.type, e.via])).toEqual([
        ['delete', null],
        ['update', null],
        ['access', 'kioku_credential'],
        ['create', null],
      ])
      expect(events.items[0]!.actor.keyName).toBe('test')
    })
  })

  // 用另一条连接在凭据源这一行上拿锁，让请求等在锁上，在锁里做完另一边的操作再提交，
  // 稳定地复现「删凭据源」与「新建绑定到它的凭据」交错
  async function raceOnProvider(
    providerId: string,
    lock: 'update' | 'share',
    request: () => Response | Promise<Response>,
    change: (tx: postgres.TransactionSql) => Promise<unknown>,
  ): Promise<Response> {
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    try {
      let pending!: Promise<Response>
      await side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        const locked =
          lock === 'update'
            ? await tx`select id from credential_providers where id = ${providerId} for update`
            : await tx`select id from credential_providers where id = ${providerId} for share`
        expect(locked).toHaveLength(1)
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }]
        pending = Promise.resolve(request())
        for (let i = 0; ; i++) {
          const [row] = await side<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where ${pid}::int = any(pg_blocking_pids(pid))`
          if (row!.n > 0) break
          if (i >= 80) throw new Error('请求没有等在凭据源的行锁上')
          await new Promise((r) => setTimeout(r, 25))
        }
        await change(tx)
      })
      return await pending
    } finally {
      await side.end()
    }
  }

  it('删凭据源期间新建的绑定会等它结束，读到已删除就是 404', async () => {
    const provider = await createProvider()
    const created = await raceOnProvider(
      provider.id,
      'update',
      () => asMember('POST', '/credentials', external(provider.id)),
      (tx) => tx`update credential_providers set deleted_at = now() where id = ${provider.id}`,
    )
    expect(await errorOf(created, 404)).toBe('凭据源不存在')
    expect((await ok<ConsoleCredentialList>(await asMember('GET', '/credentials'))).items).toEqual(
      [],
    )
  })

  it('新建绑定期间删凭据源会等它提交，数到这条凭据就不删', async () => {
    const provider = await createProvider()
    const removed = await raceOnProvider(
      provider.id,
      'share',
      () => asMember('DELETE', `/credential-providers/${provider.id}`),
      (tx) =>
        tx`insert into credentials (space_id, owner_account_id, identifier, name, source, provider_id, location, fields)
           values (${ws.spaceId}, ${ws.accountId}, 'router', '路由器', 'external', ${provider.id}, 'router admin', '[]'::jsonb)`,
    )
    expect(await errorOf(removed, 409)).toContain('还有 1 条凭据')
  })

  it('凭据的事件不进空间的活动记录', async () => {
    const created = await createCredential(hosted())
    await ok(await asMember('POST', `/credentials/${created.id}/reveal`))
    const activity = await ok<{ items: unknown[] }>(await asMember('GET', '/activity'))
    expect(activity.items).toEqual([])
  })
})
