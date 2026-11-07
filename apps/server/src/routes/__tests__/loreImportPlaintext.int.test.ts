import { randomBytes } from 'node:crypto'

import {
  LoreImportPlan,
  LoreImportResult,
  type ConsoleCredential,
  type LoreImportSource,
  type VaultConnection,
} from '@kioku/contracts'
import { and, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { consoleAccess } from '../../access/access'
import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { credentialEvents, memoryEvents, settings, vaultConnections } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import {
  existingImportApps,
  inPlanSnapshot,
  planImportFor,
  planSync,
  readLore,
} from '../../importer/lore'
import { MemoryService } from '../../memory/service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeVault } from '../../testing/fakeVault'
import { bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import {
  exportLore,
  LORE_SCHEMA,
  seedLoreNode,
  withoutDeprecatedContent,
} from '../../testing/loreFixture'

const EXPORTED = '2026-01-01T00:00:00.000Z'
const WIFI = 'hunter2-Very-Secret'
const ROUTER = 'router-pw-9fK2-long'
const NAS = 'nas-token-551-xyz'
const wifiBody = (value: string, extra = '') =>
  `# 无线网络\n访客网络的密码：${value}\n备用写法 ${value}${extra}`

describe.skipIf(!testDatabaseUrl)('Lore 导入里的疑似明文', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let lore: postgres.Sql
  let ws: Workspace
  const masterKey = randomBytes(32)
  const vault = fakeVault()
  vault.addAccount('agent@example.com', 'master-pw')
  const routerItem = vault.addItem({
    name: '路由器',
    values: { 'login.username': 'admin', 'login.password': ROUTER },
  })

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
      vault: vault.client,
    })
    lore = postgres(testDatabaseUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: 'lore_fixture' },
    })
  })
  afterAll(async () => {
    await lore?.unsafe('drop schema if exists lore_fixture cascade')
    await lore?.end()
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    const admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
    await admin.unsafe(LORE_SCHEMA)
    await admin.end()
    vault.setItemValues(routerItem, { 'login.username': 'admin', 'login.password': ROUTER })
    // 本人、私密：放得进占位符
    await seed('infra://wifi', wifiBody(WIFI))
    // 通用：放不进
    await seed('core://kb/router', `路由器 password: ${ROUTER}`)
    // 对不上任何凭据
    await seed('infra://nas', `token = ${NAS}`)
    ws = await bootstrap(app)
  })

  const seed = (uri: string, content: string) => seedLoreNode(lore, uri, content)
  const editLore = async (uri: string, content: string) => {
    await lore`insert into memories (node_uuid, content, created_at)
      values (${`uuid-${uri}`}, ${content}, '2025-05-01T00:00:00Z')`
  }
  const fileSource = async (): Promise<LoreImportSource> => ({
    kind: 'file',
    backup: withoutDeprecatedContent(await exportLore(lore, EXPORTED)) as Extract<
      LoreImportSource,
      { kind: 'file' }
    >['backup'],
  })
  const send = (method: string, path: string, body?: unknown) =>
    app.request(
      `/v1/spaces/${ws.spaceId}${path}`,
      body === undefined
        ? { method, headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie: ws.cookie }),
    )
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
  const planRaw = async (source: LoreImportSource) => {
    const res = await send('POST', '/lore-import/plan', { source })
    expect(res.status, await res.clone().text()).toBe(200)
    return res.text()
  }
  const planOf = async (source: LoreImportSource) =>
    LoreImportPlan.parse(JSON.parse(await planRaw(source)))
  const applyRaw = (source: LoreImportSource, plan: LoreImportPlan, extra = {}) =>
    send('POST', '/lore-import/apply', { source, fingerprint: plan.fingerprint, ...extra })
  const applyOf = async (source: LoreImportSource, plan: LoreImportPlan, extra = {}) =>
    LoreImportResult.parse(await ok(await applyRaw(source, plan, extra)))
  const nodeOf = (plan: LoreImportPlan, uri: string) => plan.nodes.find((n) => n.uri === uri)!
  const syncOf = (plan: LoreImportPlan, uri: string) => plan.sync.items.find((i) => i.uri === uri)!
  const service = () =>
    new MemoryService({
      db: database.db,
      spaceId: ws.spaceId,
      access: consoleAccess('owner', ws.accountId),
      personaId: 'all',
      masterKey,
      actor: { accountId: ws.accountId },
    })
  const contentOf = async (uri: string) => (await service().get(uri)).content

  const hostedWifi = async (value = WIFI) =>
    ok<ConsoleCredential>(
      await send('POST', '/credentials', {
        identifier: 'wifi',
        name: '无线网络',
        source: { kind: 'hosted', values: { password: value } },
      }),
      201,
    )
  const connectRouter = async () => {
    const { connection } = await ok<{ connection: VaultConnection }>(
      await send('POST', '/vault-connections', {
        serverUrl: 'https://vault.example.com',
        email: 'agent@example.com',
        masterPassword: 'master-pw',
      }),
    )
    await ok(
      await send('POST', '/credentials', {
        identifier: 'router',
        name: '路由器',
        source: { kind: 'vault', connectionId: connection.id, itemId: routerItem },
      }),
      201,
    )
    return connection
  }
  const setWifi = async (cred: ConsoleCredential, value: string) =>
    ok(
      await send('PATCH', `/credentials/${cred.id}`, {
        expectedVersion: cred.version,
        values: { password: value },
      }),
    )
  const allSpots = [
    { source: 'infra://wifi', index: 0 },
    { source: 'core://kb/router', index: 0 },
    { source: 'infra://nas', index: 0 },
  ]

  it('计划给每个节点列出疑似明文，和已有的凭据比；原始响应里没有值', async () => {
    await hostedWifi()
    await connectRouter()
    const accessBefore = await accessEvents()
    const raw = await planRaw(await fileSource())
    for (const value of [WIFI, ROUTER, NAS]) expect(raw).not.toContain(value)
    const plan = LoreImportPlan.parse(JSON.parse(raw))
    expect(nodeOf(plan, 'infra://wifi').plaintext).toEqual([
      {
        index: 0,
        line: 2,
        kind: 'label',
        credential: expect.objectContaining({ identifier: 'wifi', field: 'password' }),
      },
    ])
    // 密码库里已经对应到凭据字段的也算
    expect(nodeOf(plan, 'core://kb/router').plaintext).toEqual([
      {
        index: 0,
        line: 1,
        kind: 'label',
        credential: expect.objectContaining({ identifier: 'router', field: 'password' }),
      },
    ])
    expect(nodeOf(plan, 'infra://nas').plaintext).toEqual([
      { index: 0, line: 1, kind: 'label', credential: null },
    ])
    // 比值不算取用，不记访问事件
    expect(await accessEvents()).toBe(accessBefore)
  })

  it('没有疑似明文、也没有换过占位符的导入时不碰密码库', async () => {
    await connectRouter()
    await lore`delete from paths where domain <> 'core' or path <> 'kb/router'`
    await editLore('core://kb/router', '路由器在机房')
    const before = { ...vault.calls }
    const plan = await planOf(await fileSource())
    expect(nodeOf(plan, 'core://kb/router').plaintext).toEqual([])
    expect(vault.calls).toEqual(before)
  })

  it('写入时把这个值的每一处换成占位符；放不进的与对不上的照原样写，原因进结果', async () => {
    await hostedWifi()
    await connectRouter()
    const source = await fileSource()
    const plan = await planOf(source)
    const res = await applyRaw(source, plan, { convertPlaintext: allSpots })
    const text = await res.clone().text()
    for (const value of [WIFI, ROUTER, NAS]) expect(text).not.toContain(value)
    const result = LoreImportResult.parse(await res.json())
    expect(result.created.sort()).toEqual([
      'core://kb/router',
      'user://infra/nas',
      'user://infra/wifi',
    ])
    expect(result.plaintextConverted).toEqual(['user://infra/wifi'])
    expect(result.plaintextKept).toEqual([
      { uri: 'core://kb/router', reason: expect.stringContaining('凭据占位符只能放在本人') },
      { uri: 'user://infra/nas', reason: expect.stringContaining('已对不上') },
    ])
    expect(await contentOf('user://infra/wifi')).toBe(wifiBody('{{cred:wifi#password}}'))
    expect(await contentOf('core://kb/router')).toBe(`路由器 password: ${ROUTER}`)
    expect(await contentOf('user://infra/nas')).toBe(`token = ${NAS}`)
    // 导入事件记下换成了哪条凭据的哪个字段，不记值
    const [event] = await importEvents('user://infra/wifi')
    expect(event!.context.plaintextCredentials).toEqual([{ identifier: 'wifi', field: 'password' }])
    expect(JSON.stringify(event!.context)).not.toContain(WIFI)
  })

  it('不勾选时照原样写；勾选不改变计划的指纹', async () => {
    await hostedWifi()
    const source = await fileSource()
    const plan = await planOf(source)
    const result = await applyOf(source, plan)
    expect(result.plaintextConverted).toEqual([])
    expect(await contentOf('user://infra/wifi')).toBe(wifiBody(WIFI))
  })

  it('写入之前凭据改了值：这一处照原样写，说明原因', async () => {
    const cred = await hostedWifi()
    const source = await fileSource()
    const plan = await planOf(source)
    await setWifi(cred, 'changed-value-000')
    const result = await applyOf(source, plan, { convertPlaintext: [allSpots[0]] })
    expect(result.plaintextConverted).toEqual([])
    expect(result.plaintextKept).toEqual([
      { uri: 'user://infra/wifi', reason: expect.stringContaining('已对不上') },
    ])
    expect(await contentOf('user://infra/wifi')).toBe(wifiBody(WIFI))
  })

  it('对不上节点或那一处时 400，什么都不写', async () => {
    const source = await fileSource()
    const plan = await planOf(source)
    for (const spot of [
      { source: 'infra://missing', index: 0 },
      { source: 'infra://wifi', index: 5 },
    ]) {
      const res = await applyRaw(source, plan, { convertPlaintext: [spot] })
      expect(res.status).toBe(400)
    }
    expect(await importEvents('user://infra/wifi')).toHaveLength(0)
  })

  it('同步不把明文写回去：比较之前把 Lore 正文里的值换成同样的占位符', async () => {
    await hostedWifi()
    const first = await fileSource()
    await applyOf(first, await planOf(first), { convertPlaintext: [allSpots[0]] })
    // Lore 没变：现在的就是最新的
    const same = await planOf(await fileSource())
    expect(syncOf(same, 'user://infra/wifi').state).toBe('current')

    // Lore 改了别的地方：按 Lore 更新，明文仍换成占位符
    await editLore('infra://wifi', wifiBody(WIFI, '\n只给访客用'))
    const edited = await fileSource()
    const plan = await planOf(edited)
    expect(syncOf(plan, 'user://infra/wifi')).toMatchObject({
      state: 'update',
      changes: ['content'],
    })
    const result = await applyOf(edited, plan)
    expect(result.sync.updated).toEqual(['user://infra/wifi'])
    expect(await contentOf('user://infra/wifi')).toBe(
      wifiBody('{{cred:wifi#password}}', '\n只给访客用'),
    )
    // 同步事件也记下换过的占位符
    const events = await importEvents('user://infra/wifi', 'sync')
    expect(events.at(-1)!.context.plaintextCredentials).toEqual([
      { identifier: 'wifi', field: 'password' },
    ])
    // 再看一次又是最新的
    expect(syncOf(await planOf(await fileSource()), 'user://infra/wifi').state).toBe('current')
  })

  it('凭据改了值、Lore 里还是旧的明文：不同步，说明 Lore 里还有明文', async () => {
    const cred = await hostedWifi()
    const first = await fileSource()
    await applyOf(first, await planOf(first), { convertPlaintext: [allSpots[0]] })
    await setWifi(cred, 'rotated-value-000')
    await editLore('infra://wifi', wifiBody(WIFI, '\n只给访客用'))
    const source = await fileSource()
    const raw = await planRaw(source)
    expect(raw).not.toContain(WIFI)
    expect(raw).not.toContain('rotated-value-000')
    const plan = LoreImportPlan.parse(JSON.parse(raw))
    const item = syncOf(plan, 'user://infra/wifi')
    expect(item.state).toBe('skipped')
    expect(item.reason).toContain('wifi#password')
    expect(item.reason).toContain('Lore 的正文里还有')
    await applyOf(source, plan)
    expect(await contentOf('user://infra/wifi')).toBe(wifiBody('{{cred:wifi#password}}'))

    // Lore 里换成新值之后照常同步
    await editLore('infra://wifi', wifiBody('rotated-value-000', '\n只给访客用'))
    const fixed = await planOf(await fileSource())
    expect(syncOf(fixed, 'user://infra/wifi').state).toBe('update')
  })

  it('读不到凭据现在的值（密码库不可用）时不同步', async () => {
    const connection = await connectRouter()
    await seed('infra://vpn', `vpn password: ${ROUTER}`)
    const first = await fileSource()
    const plan = await planOf(first)
    expect(nodeOf(plan, 'infra://vpn').plaintext[0]!.credential?.identifier).toBe('router')
    await applyOf(first, plan, { convertPlaintext: [{ source: 'infra://vpn', index: 0 }] })
    expect(await contentOf('user://infra/vpn')).toBe('vpn password: {{cred:router#password}}')

    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(vaultConnections)
        .set({ status: 'reauth_required' })
        .where(eq(vaultConnections.id, connection.id)),
    )
    await editLore('infra://vpn', `vpn password: ${ROUTER}\n改过`)
    const source = await fileSource()
    const later = await planOf(source)
    expect(syncOf(later, 'user://infra/vpn')).toMatchObject({
      state: 'unreadable',
      reason: expect.stringContaining('router#password'),
    })
    await applyOf(source, later)
    expect(await contentOf('user://infra/vpn')).toBe('vpn password: {{cred:router#password}}')
  })

  it('命令行同步（不给凭据的值）不动换过占位符的记忆', async () => {
    await hostedWifi()
    const first = await fileSource()
    await applyOf(first, await planOf(first), { convertPlaintext: [allSpots[0]] })
    await editLore('infra://wifi', wifiBody(WIFI, '\n只给访客用'))
    const snapshot = await readLore(lore)
    const target = { db: database.db, spaceId: ws.spaceId, accountId: ws.accountId, masterKey }
    const sync = await inPlanSnapshot(target, async (snap) => {
      const base = await planImportFor(
        snap,
        snapshot,
        await existingImportApps(snap.db, ws.spaceId),
        {
          accountId: ws.accountId,
          persona: { slug: 'default', name: '默认人格' },
          secretUris: new Set(),
        },
      )
      return planSync(snap, base.plan, snapshot, base.imports)
    })
    expect(sync.items.find((i) => i.uri === 'user://infra/wifi')).toMatchObject({
      state: 'unreadable',
      reason: expect.stringContaining('命令行'),
    })
  })

  const accessEvents = async () =>
    (
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(credentialEvents).where(eq(credentialEvents.eventType, 'access')),
      )
    ).length
  const importEvents = async (uri: string, type: 'import' | 'sync' = 'import') => {
    const [domain, path] = uri.split('://') as [string, string]
    return withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .select({ context: memoryEvents.context })
        .from(memoryEvents)
        .where(
          and(
            eq(memoryEvents.eventType, type),
            sql`${memoryEvents.after}->>'domain' = ${domain}::text`,
            sql`${memoryEvents.after}->>'path' = ${path}::text`,
          ),
        )
        .orderBy(memoryEvents.id),
    ) as Promise<{ context: Record<string, unknown> }[]>
  }
})
