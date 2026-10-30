import { randomBytes } from 'node:crypto'

import type { CredentialValues, MasterKeyStatus, MemoryView } from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { credentials, memories, settings } from '../../db/schema'
import { loadEmbeddingSetups } from '../../embedding/settings'
import { staticEmbedderSource } from '../../embedding/source'
import { loadExtractionConfig } from '../../extraction/settings'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { credentialAad } from '../../credential/service'
import { rewrapKey } from '../envelope'
import { keyIdOf, type MasterKey } from '../keyring'
import { checkMasterKey, masterKeyStatus, prepareMasterKey, rotateMasterKey } from '../rotation'

describe.skipIf(!testDatabaseUrl)('主密钥的准备与轮换', () => {
  let database: Database
  let ws: Workspace
  let key: string
  const oldKey = randomBytes(32)
  const newKey = randomBytes(32)
  const rotating = { current: newKey, previous: oldKey }
  const appWith = (masterKey: MasterKey) =>
    createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    ws = await bootstrap(appWith(oldKey))
    key = await ws.issueKey((await ws.createApp('agent')).id)
  })

  const send = (
    app: ReturnType<typeof createApp>,
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ) =>
    app.request(
      path,
      body === undefined
        ? { method, headers: { 'sec-fetch-site': 'same-origin', ...headers } }
        : jsonRequest(method, body, headers),
    )
  const secret = async (app: ReturnType<typeof createApp>, uri: string, content: string) => {
    const res = await send(
      app,
      'POST',
      '/v1/memories',
      { uri, content, layer: 'private', sensitivity: 'secret' },
      bearer(key),
    )
    expect(res.status).toBe(201)
    return ((await res.json()) as MemoryView).id
  }
  const read = async (app: ReturnType<typeof createApp>, uri: string) => {
    const res = await send(
      app,
      'GET',
      `/v1/memories?uri=${encodeURIComponent(uri)}`,
      undefined,
      bearer(key),
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as MemoryView).content
  }
  const keyIds = () =>
    withSpace(database.db, ws.spaceId, async (tx) => [
      ...(await tx
        .select({ keyId: memories.keyId })
        .from(memories)
        .where(sql`${memories.wrappedKey} is not null`)),
      ...(await tx.select({ keyId: credentials.keyId }).from(credentials)),
    ])

  // 每一处加密的数据都有：两条 secret 记忆（一条删掉了）、一条托管的凭据、嵌入渠道与抽取模型的 Key
  async function seed() {
    const app = appWith(oldKey)
    await secret(app, 'home://wifi', '无线密码 hunter2')
    await secret(app, 'home://old', '删掉的旧密码')
    expect(
      (await send(app, 'DELETE', '/v1/memories?uri=home%3A%2F%2Fold', undefined, bearer(key)))
        .status,
    ).toBe(204)
    const cred = await send(
      app,
      'POST',
      `/v1/spaces/${ws.spaceId}/credentials`,
      {
        identifier: 'nas',
        name: 'NAS',
        source: { kind: 'hosted', values: { password: 'nas-pass' } },
      },
      { cookie: ws.cookie },
    )
    expect(cred.status).toBe(201)
    const credentialId = ((await cred.json()) as { id: string }).id
    for (const [path, body] of [
      [
        '/v1/settings/embedding',
        {
          model: 'm',
          channels: [{ baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: 'sk-embed' }],
        },
      ],
      [
        '/v1/settings/extraction',
        { baseUrl: 'https://x.example.com/v1', model: 'x', apiKey: 'sk-extract' },
      ],
    ] as const) {
      expect((await send(app, 'PUT', path, body, { cookie: ws.cookie })).status).toBe(200)
    }
    return { credentialId }
  }

  it('轮换全过程：补标识、旧的那把没配时拒绝启动、换完之后只配新的也都解得开', async () => {
    const { credentialId } = await seed()
    expect(await keyIds()).toEqual([
      { keyId: keyIdOf(oldKey) },
      { keyId: keyIdOf(oldKey) },
      { keyId: keyIdOf(oldKey) },
    ])

    // 加上标识之前写下的记录：启动时按解得开的主密钥补上
    await withSpace(database.db, ws.spaceId, async (tx) => {
      await tx.update(memories).set({ keyId: null }).where(eq(memories.path, 'wifi'))
      await tx.update(credentials).set({ keyId: null })
    })
    await database.db.execute(
      sql`update settings set value = value #- '{apiKey,keyId}' where key = 'extraction'`,
    )
    await prepareMasterKey(database.db, oldKey)
    expect((await keyIds()).every((r) => r.keyId === keyIdOf(oldKey))).toBe(true)
    expect((await loadExtractionConfig(database.db, oldKey))?.apiKey).toBe('sk-extract')

    // 配错了主密钥、或者没配：拒绝启动
    await expect(prepareMasterKey(database.db, newKey)).rejects.toThrow(
      /主密钥对不上：secret 记忆 2 条、托管的凭据 1 条、实例设置里的接口 Key 2 条解不开/,
    )
    await expect(prepareMasterKey(database.db, null)).rejects.toThrow('没有配置 KIOKU_MASTER_KEY')

    // 新旧两把一起配：可以启动，后台把旧的换成新的
    await prepareMasterKey(database.db, rotating)
    const before = (await (
      await send(appWith(rotating), 'GET', '/v1/settings/master-key', undefined, {
        cookie: ws.cookie,
      })
    ).json()) as MasterKeyStatus
    expect(before).toEqual({
      configured: true,
      currentId: keyIdOf(newKey),
      previousId: keyIdOf(oldKey),
      remaining: { memories: 2, credentials: 1, settings: 2 },
      lastError: null,
    })
    // 轮换期间新写下的用新密钥
    expect(await read(appWith(rotating), 'home://wifi')).toBe('无线密码 hunter2')
    await secret(appWith(rotating), 'home://new', '轮换时写下的')

    expect(await rotateMasterKey(database.db, rotating)).toEqual({ rewrapped: 5, remaining: 0 })
    expect((await masterKeyStatus(database.db, rotating)).remaining).toEqual({
      memories: 0,
      credentials: 0,
      settings: 0,
    })

    // 换完之后只配新的那把：都解得开，删掉的恢复之后也解得开
    await prepareMasterKey(database.db, newKey)
    const app = appWith(newKey)
    expect(await read(app, 'home://wifi')).toBe('无线密码 hunter2')
    expect(await read(app, 'home://new')).toBe('轮换时写下的')
    const revealed = await send(
      app,
      'POST',
      `/v1/spaces/${ws.spaceId}/credentials/${credentialId}/reveal`,
      undefined,
      { cookie: ws.cookie },
    )
    expect(((await revealed.json()) as CredentialValues).values).toEqual({ password: 'nas-pass' })
    expect((await loadEmbeddingSetups(database.db, newKey)).active?.channels[0]?.apiKey).toBe(
      'sk-embed',
    )
    expect((await loadExtractionConfig(database.db, newKey))?.apiKey).toBe('sk-extract')
    const deleted = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memories).where(eq(memories.path, 'old')),
    )
    expect(deleted[0]?.keyId).toBe(keyIdOf(newKey))
  })

  it('别的事务只是往这一行上挂记录（外键检查加的 KEY SHARE）时照常换；锁着要改的行这次跳过，之后再换', async () => {
    const app = appWith(oldKey)
    await secret(app, 'home://wifi', '无线密码')
    await secret(app, 'home://door', '门锁密码')
    const hosted = async (identifier: string) => {
      const res = await send(
        app,
        'POST',
        `/v1/spaces/${ws.spaceId}/credentials`,
        { identifier, name: identifier, source: { kind: 'hosted', values: { password: 'p' } } },
        { cookie: ws.cookie },
      )
      expect(res.status).toBe(201)
      return ((await res.json()) as { id: string }).id
    }
    const nas = await hosted('nas')
    const router = await hosted('router')

    const side = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
    try {
      await side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        // 插入事件、关键词与向量时，外键检查在记忆行上加的就是这把锁
        await tx`select id from memories where path = 'wifi' for key share`
        // 取用凭据时写下一条事件，还没提交：外键检查在凭据行上加 KEY SHARE
        await tx`insert into credential_events (space_id, credential_id, event_type)
          values (${ws.spaceId}, ${nas}, 'access')`
        // 正要改的行
        await tx`select id from memories where path = 'door' for update`
        await tx`select id from credentials where id = ${router} for update`
        expect(await rotateMasterKey(database.db, rotating)).toEqual({ rewrapped: 2, remaining: 2 })
        const rows = (await tx`
          select path as name, key_id from memories where path in ('wifi', 'door')
          union all
          select identifier, key_id from credentials where id in (${nas}, ${router})
          order by name`) as unknown as { name: string; key_id: string }[]
        expect(rows.map((r) => [r.name, r.key_id])).toEqual([
          ['door', keyIdOf(oldKey)],
          ['nas', keyIdOf(newKey)],
          ['router', keyIdOf(oldKey)],
          ['wifi', keyIdOf(newKey)],
        ])
      })
    } finally {
      await side.end()
    }
    expect(await rotateMasterKey(database.db, rotating)).toEqual({ rewrapped: 2, remaining: 0 })
    const after = appWith(newKey)
    expect(await read(after, 'home://wifi')).toBe('无线密码')
    expect(await read(after, 'home://door')).toBe('门锁密码')
    for (const id of [nas, router]) {
      const revealed = await send(
        after,
        'POST',
        `/v1/spaces/${ws.spaceId}/credentials/${id}/reveal`,
        undefined,
        { cookie: ws.cookie },
      )
      expect(((await revealed.json()) as CredentialValues).values).toEqual({ password: 'p' })
    }
  })

  it('有一行用旧主密钥也解不开：跳过它、记下原因，不拦住别的', async () => {
    await secret(appWith(oldKey), 'home://wifi', '无线密码')
    await secret(appWith(oldKey), 'home://broken', '坏掉的那条')
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ wrappedKey: randomBytes(60) })
        .where(eq(memories.path, 'broken')),
    )
    expect(await rotateMasterKey(database.db, rotating)).toEqual({ rewrapped: 1, remaining: 1 })
    expect(await read(appWith(newKey), 'home://wifi')).toBe('无线密码')
    expect((await masterKeyStatus(database.db, rotating)).lastError).toMatchObject({
      message: expect.stringContaining('1 条用旧主密钥也解不开'),
    })
  })

  it('只核对不写库：没记标识的认得出就通过但不补，认不出的和启动检查一样报错', async () => {
    await seed()
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.update(memories).set({ keyId: null }).where(eq(memories.path, 'wifi')),
    )
    await database.db.execute(
      sql`update settings set value = value #- '{apiKey,keyId}' where key = 'extraction'`,
    )
    await checkMasterKey(database.db, oldKey)
    const [wifi] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select({ keyId: memories.keyId }).from(memories).where(eq(memories.path, 'wifi')),
    )
    expect(wifi?.keyId).toBeNull()
    const [extraction] = await database.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'extraction'))
    expect(JSON.stringify(extraction?.value)).not.toContain('keyId')
    await expect(checkMasterKey(database.db, newKey)).rejects.toThrow(
      /主密钥对不上：secret 记忆 2 条、托管的凭据 1 条、实例设置里的接口 Key 2 条解不开/,
    )
  })

  it('还没换完就去掉了旧的那把：拒绝启动，并说清要配回去', async () => {
    await secret(appWith(oldKey), 'home://wifi', '无线密码')
    await expect(prepareMasterKey(database.db, newKey)).rejects.toThrow('KIOKU_MASTER_KEY_PREVIOUS')
  })

  // 另开一条连接锁住一行，发出请求、等它被这一行挡住，在锁里模拟轮换换好包装再放开
  async function rotatedWhileBlocked(
    lock: (tx: postgres.TransactionSql) => Promise<unknown>,
    request: () => Response | Promise<Response>,
    rewrap: (tx: postgres.TransactionSql) => Promise<unknown>,
  ) {
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    let pending: Promise<Response> | undefined
    try {
      await side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        await lock(tx)
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }]
        pending = Promise.resolve(request())
        for (let i = 0; ; i++) {
          const [row] = await side<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where ${pid}::int = any(pg_blocking_pids(pid))`
          if (row!.n > 0) break
          if (i >= 80) throw new Error('请求没有等在这一行上')
          await new Promise((r) => setTimeout(r, 25))
        }
        await rewrap(tx)
      })
      expect((await pending!).status).toBe(200)
    } finally {
      await pending?.catch(() => {})
      await side.end()
    }
  }

  it('轮换时改了托管凭据（值没变）：不把读到的旧包装写回去', async () => {
    const { credentialId } = await seed()
    await rotatedWhileBlocked(
      (tx) => tx`select id from credentials where id = ${credentialId} for update`,
      () =>
        send(
          appWith(rotating),
          'PATCH',
          `/v1/spaces/${ws.spaceId}/credentials/${credentialId}`,
          { expectedVersion: 1, name: 'NAS 2', source: { kind: 'hosted', values: {} } },
          { cookie: ws.cookie },
        ),
      async (tx) => {
        const [row] =
          (await tx`select wrapped_key from credentials where id = ${credentialId}`) as unknown as [
            { wrapped_key: Buffer },
          ]
        const wrapped = rewrapKey(oldKey, newKey, row.wrapped_key, credentialAad(credentialId))
        await tx`update credentials set wrapped_key = ${wrapped}, key_id = ${keyIdOf(newKey)} where id = ${credentialId}`
      },
    )
    const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(credentials).where(eq(credentials.id, credentialId)),
    )
    expect(row).toMatchObject({ name: 'NAS 2', keyId: keyIdOf(newKey) })
  })

  it('轮换时改了抽取模型的设置（沿用 Key）：不把读到的旧包装写回去', async () => {
    await seed()
    await rotatedWhileBlocked(
      (tx) => tx`select key from settings where key = 'extraction' for update`,
      () =>
        send(
          appWith(rotating),
          'PUT',
          '/v1/settings/extraction',
          { baseUrl: 'https://x.example.com/v1', model: 'x2' },
          { cookie: ws.cookie },
        ),
      async (tx) => {
        const [row] =
          (await tx`select value from settings where key = 'extraction'`) as unknown as [
            { value: { apiKey: { wrappedKey: string; keyId: string } } },
          ]
        const apiKey = row.value.apiKey
        const wrapped = rewrapKey(
          oldKey,
          newKey,
          Buffer.from(apiKey.wrappedKey, 'base64'),
          'settings:extraction',
        )
        const value = {
          ...row.value,
          apiKey: { ...apiKey, wrappedKey: wrapped.toString('base64'), keyId: keyIdOf(newKey) },
        }
        await tx`update settings set value = ${tx.json(value)} where key = 'extraction'`
      },
    )
    expect((await loadExtractionConfig(database.db, newKey))?.apiKey).toBe('sk-extract')
  })

  it('主密钥状态只给实例管理员', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const app = appWith(oldKey)
    expect(
      (await send(app, 'GET', '/v1/settings/master-key', undefined, { cookie: editor.cookie }))
        .status,
    ).toBe(403)
    expect(
      await (
        await send(app, 'GET', '/v1/settings/master-key', undefined, { cookie: ws.cookie })
      ).json(),
    ).toEqual({
      configured: true,
      currentId: keyIdOf(oldKey),
      previousId: null,
      remaining: { memories: 0, credentials: 0, settings: 0 },
      lastError: null,
    })
  })
})
