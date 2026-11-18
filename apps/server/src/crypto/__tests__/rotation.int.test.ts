import { randomBytes } from 'node:crypto'

import type { CredentialValues, EntryView, MasterKeyStatus } from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database, type Tx } from '../../db/client'
import { credentials, entries, entryVariants, settings, vaultConnections } from '../../db/schema'
import { loadEmbeddingSetups } from '../../embedding/settings'
import { staticEmbedderSource } from '../../embedding/source'
import { loadExtractionConfig } from '../../extraction/settings'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { credentialAad } from '../../credential/service'
import { openVaultSecrets, sealVaultSecrets } from '../../credential/vault'
import { rewrapKey } from '../envelope'
import { keyIdOf, type MasterKey } from '../keyring'
import {
  checkMasterKey,
  masterKeyStatus,
  prepareMasterKey,
  rotateMasterKey,
  rotationPass,
} from '../rotation'

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
    key = await ws.issueKey((await ws.createClient('agent')).id)
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
  const secret = async (app: ReturnType<typeof createApp>, title: string, content: string) => {
    const res = await send(
      app,
      'POST',
      '/v1/entries',
      { title, content, sensitivity: 'secret' },
      bearer(key),
    )
    expect(res.status).toBe(201)
    return ((await res.json()) as EntryView).id
  }
  const read = async (app: ReturnType<typeof createApp>, title: string) => {
    const res = await send(
      app,
      'GET',
      `/v1/entries?id=${encodeURIComponent(title)}`,
      undefined,
      bearer(key),
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as EntryView).variants[0]!.content
  }
  const entryIdByTitle = async (tx: Tx, title: string) => {
    const [row] = await tx.select({ id: entries.id }).from(entries).where(eq(entries.title, title))
    return row!.id
  }
  const keyIds = () =>
    withCircle(database.db, ws.circleId, async (tx) => [
      ...(await tx
        .select({ keyId: entryVariants.keyId })
        .from(entryVariants)
        .where(sql`${entryVariants.wrappedKey} is not null`)),
      ...(await tx.select({ keyId: credentials.keyId }).from(credentials)),
    ])

  // 每一处加密的数据都有：两条 secret 记忆（一条删掉了）、一条托管的凭据、嵌入渠道与抽取模型的 Key
  async function seed() {
    const app = appWith(oldKey)
    await secret(app, 'home/wifi', '无线密码 hunter2')
    await secret(app, 'home/old', '删掉的旧密码')
    expect(
      (await send(app, 'DELETE', '/v1/entries?id=home%2Fold', undefined, bearer(key))).status,
    ).toBe(204)
    const cred = await send(
      app,
      'POST',
      `/v1/circles/${ws.circleId}/credentials`,
      {
        identifier: 'nas',
        name: 'NAS',
        source: { kind: 'new', values: { password: 'nas-pass' } },
      },
      { cookie: ws.cookie },
    )
    expect(cred.status).toBe(201)
    const credentialId = ((await cred.json()) as { id: string }).id
    const embedProv = await send(
      app,
      'POST',
      '/v1/settings/models/providers',
      {
        name: '嵌入服务商',
        format: 'openai-chat',
        baseUrl: 'https://e.example.com/v1',
        apiKey: 'sk-embed',
        profiles: [{ kind: 'embedding', model: 'm' }],
      },
      { cookie: ws.cookie },
    )
    expect(embedProv.status).toBe(201)
    const embedId = ((await embedProv.json()) as { profiles: { id: string }[] }).profiles[0]!.id
    const extractProv = await send(
      app,
      'POST',
      '/v1/settings/models/providers',
      {
        name: '抽取服务商',
        format: 'openai-chat',
        baseUrl: 'https://x.example.com/v1',
        apiKey: 'sk-extract',
        profiles: [{ kind: 'chat', model: 'x' }],
      },
      { cookie: ws.cookie },
    )
    expect(extractProv.status).toBe(201)
    const extractProvJson = (await extractProv.json()) as {
      id: string
      profiles: { id: string }[]
    }
    const extractId = extractProvJson.profiles[0]!.id
    for (const [path, body] of [
      ['/v1/settings/embedding', { model: 'm', profileIds: [embedId] }],
      ['/v1/settings/models/bindings/extraction', { profileIds: [extractId] }],
    ] as const) {
      expect((await send(app, 'PUT', path, body, { cookie: ws.cookie })).status).toBe(200)
    }
    // 密码库连接保存的令牌与账户密钥，和托管的值一样要换包装
    const connectionId = crypto.randomUUID()
    await withCircle(database.db, ws.circleId, (tx) =>
      tx.insert(vaultConnections).values({
        id: connectionId,
        circleId: ws.circleId,
        ownerAccountId: ws.accountId,
        serverUrl: 'https://vault.example.com',
        email: 'agent@example.com',
        vaultUserId: 'user-1',
        deviceId: crypto.randomUUID(),
        ...sealVaultSecrets(oldKey, connectionId, {
          refreshToken: 'refresh-token',
          userKey: Buffer.alloc(64, 7),
        }),
      }),
    )
    return { credentialId, connectionId, extractProviderId: extractProvJson.id, extractId }
  }

  it('轮换全过程：补标识、旧的那把没配时拒绝启动、换完之后只配新的也都解得开', async () => {
    const { credentialId, connectionId } = await seed()
    expect(await keyIds()).toEqual([
      { keyId: keyIdOf(oldKey) },
      { keyId: keyIdOf(oldKey) },
      { keyId: keyIdOf(oldKey) },
    ])

    // 加上标识之前写下的记录：启动时按解得开的主密钥补上
    await withCircle(database.db, ws.circleId, async (tx) => {
      const wifiId = await entryIdByTitle(tx, 'home/wifi')
      await tx.update(entryVariants).set({ keyId: null }).where(eq(entryVariants.entryId, wifiId))
      await tx.update(credentials).set({ keyId: null })
    })
    await database.db.execute(
      sql`update settings set value = jsonb_set(value, '{providers,1,apiKey}', (value#>'{providers,1,apiKey}') - 'keyId') where key = 'model-providers'`,
    )
    await prepareMasterKey(database.db, oldKey)
    expect((await keyIds()).every((r) => r.keyId === keyIdOf(oldKey))).toBe(true)
    expect((await loadExtractionConfig(database.db, oldKey))?.[0]?.apiKey).toBe('sk-extract')

    // 配错了主密钥、或者没配：拒绝启动
    await expect(prepareMasterKey(database.db, newKey)).rejects.toThrow(
      /主密钥对不上：机密记忆 2 条、托管的凭据 1 条、密码库连接 1 条、实例设置中加密保存的密钥 2 条解不开/,
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
      remaining: { entries: 2, credentials: 1, vaultConnections: 1, settings: 2 },
      lastError: null,
    })
    // 轮换期间新写下的用新密钥
    expect(await read(appWith(rotating), 'home/wifi')).toBe('无线密码 hunter2')
    await secret(appWith(rotating), 'home/new', '轮换时写下的')

    expect(await rotateMasterKey(database.db, rotating)).toEqual({ rewrapped: 6, remaining: 0 })
    expect((await masterKeyStatus(database.db, rotating)).remaining).toEqual({
      entries: 0,
      credentials: 0,
      vaultConnections: 0,
      settings: 0,
    })

    // 换完之后只配新的那把：都解得开，删掉的恢复之后也解得开
    await prepareMasterKey(database.db, newKey)
    const app = appWith(newKey)
    expect(await read(app, 'home/wifi')).toBe('无线密码 hunter2')
    expect(await read(app, 'home/new')).toBe('轮换时写下的')
    const revealed = await send(
      app,
      'POST',
      `/v1/circles/${ws.circleId}/credentials/${credentialId}/reveal`,
      undefined,
      { cookie: ws.cookie },
    )
    expect(((await revealed.json()) as CredentialValues).values).toEqual({ password: 'nas-pass' })
    expect((await loadEmbeddingSetups(database.db, newKey)).active?.channels[0]?.apiKey).toBe(
      'sk-embed',
    )
    expect((await loadExtractionConfig(database.db, newKey))?.[0]?.apiKey).toBe('sk-extract')
    const deleted = await withCircle(database.db, ws.circleId, async (tx) =>
      tx
        .select()
        .from(entryVariants)
        .where(eq(entryVariants.entryId, await entryIdByTitle(tx, 'home/old'))),
    )
    expect(deleted[0]?.keyId).toBe(keyIdOf(newKey))
    const [connection] = await withCircle(database.db, ws.circleId, (tx) =>
      tx.select().from(vaultConnections).where(eq(vaultConnections.id, connectionId)),
    )
    expect(connection!.keyId).toBe(keyIdOf(newKey))
    expect(
      openVaultSecrets(newKey, {
        id: connectionId,
        ciphertext: connection!.ciphertext!,
        wrappedKey: connection!.wrappedKey!,
        keyId: connection!.keyId,
      }).refreshToken,
    ).toBe('refresh-token')
  })

  it('别的事务只是往这一行上挂记录（外键检查加的 KEY SHARE）时照常换；锁着要改的行这次跳过，之后再换', async () => {
    const app = appWith(oldKey)
    await secret(app, 'home/wifi', '无线密码')
    await secret(app, 'home/door', '门锁密码')
    const hosted = async (identifier: string) => {
      const res = await send(
        app,
        'POST',
        `/v1/circles/${ws.circleId}/credentials`,
        { identifier, name: identifier, source: { kind: 'new', values: { password: 'p' } } },
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
        await tx`select set_config('app.read_circles', ${ws.circleId}, true)`
        await tx`select set_config('app.write_circles', ${ws.circleId}, true)`
        // 插入事件、关键词与向量时，外键检查在变体切片行上加的就是这把锁
        await tx`select v.id from entry_variants v join entries e on e.id = v.entry_id where e.title = 'home/wifi' for key share of v`
        // 取用凭据时写下一条事件，还没提交：外键检查在凭据行上加 KEY SHARE
        await tx`insert into credential_events (circle_id, credential_id, event_type)
          values (${ws.circleId}, ${nas}, 'access')`
        // 正要改的行
        await tx`select v.id from entry_variants v join entries e on e.id = v.entry_id where e.title = 'home/door' for update of v`
        await tx`select id from credentials where id = ${router} for update`
        expect(await rotateMasterKey(database.db, rotating)).toEqual({ rewrapped: 2, remaining: 2 })
        const rows = (await tx`
          select substring(e.title from '[^/]+$') as name, v.key_id
          from entry_variants v
          join entries e on e.id = v.entry_id
          where e.title in ('home/wifi', 'home/door')
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
    expect(await read(after, 'home/wifi')).toBe('无线密码')
    expect(await read(after, 'home/door')).toBe('门锁密码')
    for (const id of [nas, router]) {
      const revealed = await send(
        after,
        'POST',
        `/v1/circles/${ws.circleId}/credentials/${id}/reveal`,
        undefined,
        { cookie: ws.cookie },
      )
      expect(((await revealed.json()) as CredentialValues).values).toEqual({ password: 'p' })
    }
  })

  it('有一行用旧主密钥也解不开：跳过它、记下原因，不拦住别的', async () => {
    await secret(appWith(oldKey), 'home/wifi', '无线密码')
    await secret(appWith(oldKey), 'home/broken', '坏掉的那条')
    await withCircle(database.db, ws.circleId, async (tx) =>
      tx
        .update(entryVariants)
        .set({ wrappedKey: randomBytes(60) })
        .where(eq(entryVariants.entryId, await entryIdByTitle(tx, 'home/broken'))),
    )
    expect(await rotateMasterKey(database.db, rotating)).toEqual({ rewrapped: 1, remaining: 1 })
    expect(await read(appWith(newKey), 'home/wifi')).toBe('无线密码')
    expect((await masterKeyStatus(database.db, rotating)).lastError).toMatchObject({
      message: expect.stringContaining('1 条用旧主密钥也无法解密'),
    })
  })

  it('只核对不写库：没记标识的认得出就通过但不补，认不出的和启动检查一样报错', async () => {
    await seed()
    await withCircle(database.db, ws.circleId, async (tx) =>
      tx
        .update(entryVariants)
        .set({ keyId: null })
        .where(eq(entryVariants.entryId, await entryIdByTitle(tx, 'home/wifi'))),
    )
    await database.db.execute(
      sql`update settings set value = jsonb_set(value, '{providers,1,apiKey}', (value#>'{providers,1,apiKey}') - 'keyId') where key = 'model-providers'`,
    )
    await checkMasterKey(database.db, oldKey)
    const [wifi] = await withCircle(database.db, ws.circleId, async (tx) =>
      tx
        .select({ keyId: entryVariants.keyId })
        .from(entryVariants)
        .where(eq(entryVariants.entryId, await entryIdByTitle(tx, 'home/wifi'))),
    )
    expect(wifi?.keyId).toBeNull()
    const [providersRow] = await database.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'model-providers'))
    expect(JSON.stringify(providersRow?.value)).toContain('"keyId"')
    expect(
      (providersRow?.value as { providers: { apiKey?: { keyId?: string } }[] }).providers[1]?.apiKey
        ?.keyId,
    ).toBeUndefined()
    await expect(checkMasterKey(database.db, newKey)).rejects.toThrow(
      /主密钥对不上：机密记忆 2 条、托管的凭据 1 条、密码库连接 1 条、实例设置中加密保存的密钥 2 条解不开/,
    )
  })

  it('还没换完就去掉了旧的那把：拒绝启动，并说清要配回去', async () => {
    await secret(appWith(oldKey), 'home/wifi', '无线密码')
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
        await tx`select set_config('app.read_circles', ${ws.circleId}, true)`
        await tx`select set_config('app.write_circles', ${ws.circleId}, true)`
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
          `/v1/circles/${ws.circleId}/credentials/${credentialId}`,
          { expectedVersion: 1, name: 'NAS 2', source: { kind: 'new', values: {} } },
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
    const [row] = await withCircle(database.db, ws.circleId, (tx) =>
      tx.select().from(credentials).where(eq(credentials.id, credentialId)),
    )
    expect(row).toMatchObject({ name: 'NAS 2', keyId: keyIdOf(newKey) })
  })

  it('轮换时改了模型服务商的设置（沿用 Key）：不把读到的旧包装写回去', async () => {
    const { extractProviderId, extractId } = await seed()
    await rotatedWhileBlocked(
      (tx) => tx`select key from settings where key = 'model-providers' for update`,
      () =>
        send(
          appWith(rotating),
          'PUT',
          `/v1/settings/models/providers/${extractProviderId}`,
          {
            name: '抽取服务商',
            format: 'openai-chat',
            baseUrl: 'https://x.example.com/v1',
            profiles: [{ id: extractId, kind: 'chat', model: 'x2' }],
          },
          { cookie: ws.cookie },
        ),
      async (tx) => {
        const [row] =
          (await tx`select value from settings where key = 'model-providers'`) as unknown as [
            {
              value: {
                providers: { id: string; apiKey?: { wrappedKey: string; keyId: string } }[]
              }
            },
          ]
        const nextProviders = row.value.providers.map((p) => {
          if (!p.apiKey) return p
          const wrapped = rewrapKey(
            oldKey,
            newKey,
            Buffer.from(p.apiKey.wrappedKey, 'base64'),
            'settings:model-providers',
          )
          return {
            ...p,
            apiKey: { ...p.apiKey, wrappedKey: wrapped.toString('base64'), keyId: keyIdOf(newKey) },
          }
        })
        await tx`update settings set value = ${tx.json({ providers: nextProviders })} where key = 'model-providers'`
      },
    )
    expect((await loadExtractionConfig(database.db, newKey))?.[0]?.apiKey).toBe('sk-extract')
  })

  it('轮换任务：只剩密码库连接还用旧主密钥时也接着换，换完再来一次什么都不做', async () => {
    const connectionId = crypto.randomUUID()
    await withCircle(database.db, ws.circleId, (tx) =>
      tx.insert(vaultConnections).values({
        id: connectionId,
        circleId: ws.circleId,
        ownerAccountId: ws.accountId,
        serverUrl: 'https://vault.example.com',
        email: 'agent@example.com',
        vaultUserId: 'user-1',
        deviceId: crypto.randomUUID(),
        ...sealVaultSecrets(oldKey, connectionId, {
          refreshToken: 'refresh-token',
          userKey: Buffer.alloc(64, 7),
        }),
      }),
    )
    expect((await masterKeyStatus(database.db, rotating)).remaining).toEqual({
      entries: 0,
      credentials: 0,
      vaultConnections: 1,
      settings: 0,
    })
    expect(await rotationPass(database.db, rotating)).toEqual({ rewrapped: 1, remaining: 0 })
    expect((await masterKeyStatus(database.db, rotating)).remaining.vaultConnections).toBe(0)
    expect(await rotationPass(database.db, rotating)).toBeNull()
  })

  it('主密钥状态只给实例管理员', async () => {
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
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
      remaining: { entries: 0, credentials: 0, vaultConnections: 0, settings: 0 },
      lastError: null,
    })
  })
})
