import { randomBytes } from 'node:crypto'

import type { BootResponse } from '@kioku/contracts'
import { and, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { apps, memories, memoryEvents, personas } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { consoleAccess } from '../../access/access'
import { MemoryService } from '../../memory/service'
import { applyImport, planImport, readLore, verifyMasterKey, type ImportPlan } from '../lore'

// 在测试库里建一个只含导入用到的几张表的 Lore，结构取自 Lore 的 000_initial_schema.sql
const LORE_SCHEMA = `
  drop schema if exists lore_fixture cascade;
  create schema lore_fixture;
  set search_path = lore_fixture;
  create table nodes (uuid text primary key, created_at timestamptz not null default now());
  create table memories (id bigserial primary key, node_uuid text not null, content text,
    deprecated boolean not null default false, migrated_to text, created_at timestamptz not null default now());
  create table edges (id bigserial primary key, parent_uuid text not null, child_uuid text not null,
    priority integer not null default 0, disclosure text, created_at timestamptz not null default now());
  create table paths (domain text not null, path text not null, edge_id integer not null,
    created_at timestamptz not null default now(), primary key (domain, path));
  create table glossary_keywords (id bigserial primary key, keyword text not null, node_uuid text not null,
    created_at timestamptz not null default now());
  create table recall_events (id bigserial primary key, query_text text not null, node_uri text not null);
`

describe.skipIf(!testDatabaseUrl)('从 Lore 导入', () => {
  let database: Database
  let lore: postgres.Sql
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  const masterKey = randomBytes(32)

  // 一个节点：正文的旧版本、当前版本、路径与关键词
  const seedNode = async (
    uri: string,
    content: string,
    extra: { priority?: number; disclosure?: string; keywords?: string[]; old?: string[] } = {},
  ) => {
    const [domain, path] = uri.split('://') as [string, string]
    const uuid = `uuid-${uri}`
    await lore`insert into nodes (uuid, created_at) values (${uuid}, '2025-03-01T00:00:00Z')`
    for (const old of extra.old ?? []) {
      await lore`insert into memories (node_uuid, content, deprecated, created_at)
        values (${uuid}, ${old}, true, '2025-03-02T00:00:00Z')`
    }
    await lore`insert into memories (node_uuid, content, created_at)
      values (${uuid}, ${content}, '2025-04-01T00:00:00Z')`
    const [edge] = await lore<{ id: number }[]>`
      insert into edges (parent_uuid, child_uuid, priority, disclosure)
      values ('root', ${uuid}, ${extra.priority ?? 2}, ${extra.disclosure ?? null}) returning id`
    await lore`insert into paths (domain, path, edge_id) values (${domain}, ${path}, ${edge!.id})`
    for (const keyword of extra.keywords ?? []) {
      await lore`insert into glossary_keywords (keyword, node_uuid) values (${keyword}, ${uuid})`
    }
  }

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
    const admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
    await admin.unsafe(LORE_SCHEMA)
    await admin.end()
    lore = postgres(testDatabaseUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: 'lore_fixture' },
    })
    await seedNode('core://agent', '工作流约束', { priority: 0 })
    await seedNode('core://soul', '直接、简洁', { priority: 0 })
    await seedNode('core://agent/claudecode', 'Claude Code 运行时约束', { priority: 0 })
    await seedNode('core://agent/zcode', 'zcode 运行时约束', { priority: 0 })
    await seedNode('preferences://user', '中文回复', { priority: 0, keywords: ['段', '中文'] })
    await seedNode('infra://home_network', '家里的网络', {
      priority: 1,
      disclosure: '排查网络时',
      keywords: ['软路由', 'VLAN'],
      old: ['旧的网络描述', '更旧的'],
    })
    await seedNode('infra://home_network/credentials', '路由器密码 hunter2', { priority: 2 })
    await lore`insert into recall_events (query_text, node_uri) values ('q', 'core://agent')`
  })
  afterAll(async () => {
    await lore?.unsafe('drop schema if exists lore_fixture cascade')
    await lore?.end()
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
  })

  const plan = async (
    persona = 'default',
    secretUris = ['infra://home_network/credentials'],
  ): Promise<ImportPlan> => {
    const existing = await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .select({
          slug: apps.slug,
          runtimeFamily: apps.runtimeFamily,
          ownerAccountId: apps.ownerAccountId,
        })
        .from(apps),
    )
    return planImport(await readLore(lore), existing, {
      accountId: ws.accountId,
      persona: { slug: persona, name: persona },
      secretUris: new Set(secretUris),
    })
  }
  const run = async (persona?: string, secretUris?: string[]) =>
    applyImport(
      { db: database.db, spaceId: ws.spaceId, accountId: ws.accountId, masterKey },
      await plan(persona, secretUris),
    )

  it('读出节点、当前正文、旧版本数、关键词与召回事件数', async () => {
    const snapshot = await readLore(lore)
    expect(snapshot.recallEvents).toBe(1)
    const network = snapshot.nodes.find((n) => n.uri === 'infra://home_network')!
    expect(network).toMatchObject({
      content: '家里的网络',
      priority: 1,
      disclosure: '排查网络时',
      previousVersions: 2,
    })
    expect(network.keywords.sort()).toEqual(['VLAN', '软路由'])
  })

  it('按映射写入；应用与人格自动建好；secret 加密存储；事件记成 import', async () => {
    await ws.createApp('claude-code', { runtimeFamily: 'claudecode' })
    const result = await run()
    expect(result.failed).toEqual([])
    expect(result.personaCreated).toBe(true)
    expect(result.appsCreated).toEqual(['zcode'])
    expect(result.appsGivenPersona).toEqual(['claude-code'])
    expect(result.created.sort()).toEqual(
      [
        'app://claude-code/agent',
        'app://zcode/agent',
        'core://agent',
        'infra://home_network',
        'infra://home_network/credentials',
        'persona://default/soul',
        'preferences://user',
      ].sort(),
    )

    const rows = await withSpace(database.db, ws.spaceId, (tx) => tx.select().from(memories))
    const byUri = new Map(rows.map((r) => [`${r.domain}://${r.path}`, r]))
    expect(byUri.get('core://agent')).toMatchObject({ layer: 'base', provenance: 'system' })
    expect(byUri.get('preferences://user')).toMatchObject({
      layer: 'owner',
      ownerAccountId: ws.accountId,
    })
    expect(byUri.get('infra://home_network')).toMatchObject({
      layer: 'private',
      priority: 1,
      disclosure: '排查网络时',
    })
    expect(byUri.get('infra://home_network')!.createdAt.toISOString()).toBe(
      '2025-03-01T00:00:00.000Z',
    )
    const secret = byUri.get('infra://home_network/credentials')!
    expect(secret).toMatchObject({ sensitivity: 'secret', content: null })
    expect(secret.ciphertext).not.toBeNull()

    const events = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memoryEvents).where(eq(memoryEvents.memoryId, secret.id)),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      eventType: 'import',
      context: { source: 'lore', loreUri: 'infra://home_network/credentials' },
    })
    expect(JSON.stringify(events)).not.toContain('hunter2')

    const [zcode] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(apps).where(eq(apps.slug, 'zcode')),
    )
    const [persona] = await withSpace(database.db, ws.spaceId, (tx) => tx.select().from(personas))
    expect(zcode).toMatchObject({ runtimeFamily: 'other', defaultPersonaId: persona!.id })
  })

  it('重复执行只跳过，不重复写入；导入后删除或移动了的也不会被写回来', async () => {
    await run()
    const viaConsole = (method: string, body: unknown) =>
      app.request(
        `/v1/spaces/${ws.spaceId}/memories${method === 'POST' ? '/move' : ''}`,
        jsonRequest(method, body, { cookie: ws.cookie }),
      )
    await app.request(
      `/v1/spaces/${ws.spaceId}/memories?uri=${encodeURIComponent('infra://home_network/credentials')}`,
      { method: 'DELETE', headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' } },
    )
    expect(
      (await viaConsole('POST', { from: 'infra://home_network', to: 'infra://network' })).status,
    ).toBe(200)

    const again = await run()
    expect(again.created).toEqual([])
    expect(again.previouslyImported).toHaveLength(7)
    expect(again.personaCreated).toBe(false)
    expect(again.appsCreated).toEqual([])
    const live = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select({ path: memories.path, deletedAt: memories.deletedAt }).from(memories),
    )
    expect(live.filter((m) => !m.deletedAt).map((m) => m.path)).not.toContain('home_network')
    expect(live.filter((m) => !m.deletedAt).map((m) => m.path)).not.toContain(
      'home_network/credentials',
    )
  })

  it('别的成员的同类应用不会被写入，导入者另建自己的应用', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bobApp = await app.request(
      `/v1/spaces/${ws.spaceId}/apps`,
      jsonRequest(
        'POST',
        { slug: 'bob-cc', name: 'bob-cc', runtimeFamily: 'claudecode' },
        { cookie: bob.cookie },
      ),
    )
    expect(bobApp.status).toBe(201)
    const result = await run()
    expect(result.created).toContain('app://claudecode/agent')
    const appRows = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select({ path: memories.path }).from(memories).where(eq(memories.domain, 'app')),
    )
    expect(appRows.some((r) => r.path?.startsWith('bob-cc'))).toBe(false)
  })

  it('换一个人格再导入时，core://soul 也写进新的人格', async () => {
    await run()
    const again = await run('work')
    expect(again.created).toEqual(['persona://work/soul'])
  })

  it('之前按明文导入过的节点，这次加 --secret 不会悄悄跳过', async () => {
    await run('default', [])
    const again = await run('default', ['infra://home_network/credentials'])
    expect(again.secretAlreadyImported).toEqual([
      { uri: 'infra://home_network/credentials', current: 'infra://home_network/credentials' },
    ])
  })

  it('按明文导入后移动过的节点，提醒里给出它现在的 URI', async () => {
    await run('default', [])
    const moved = await app.request(
      `/v1/spaces/${ws.spaceId}/memories/move`,
      jsonRequest(
        'POST',
        { from: 'infra://home_network/credentials', to: 'infra://creds' },
        { cookie: ws.cookie },
      ),
    )
    expect(moved.status).toBe(200)
    const again = await run('default', ['infra://home_network/credentials'])
    expect(again.secretAlreadyImported).toEqual([
      { uri: 'infra://home_network/credentials', current: 'infra://creds' },
    ])
  })

  it('已经按 secret 导入过的节点，再带 --secret 执行时不误报', async () => {
    await run()
    const again = await run()
    expect(again.secretAlreadyImported).toEqual([])
  })

  it('按明文导入后在管理界面改成了 secret，再带 --secret 执行时也不再提醒', async () => {
    await run('default', [])
    await app.request(
      `/v1/spaces/${ws.spaceId}/memories`,
      jsonRequest(
        'PATCH',
        { uri: 'infra://home_network/credentials', sensitivity: 'secret' },
        { cookie: ws.cookie },
      ),
    )
    const again = await run('default', ['infra://home_network/credentials'])
    expect(again.secretAlreadyImported).toEqual([])
  })

  it('按明文导入后删掉了的节点，再带 --secret 执行时不提醒', async () => {
    await run('default', [])
    await app.request(
      `/v1/spaces/${ws.spaceId}/memories?uri=${encodeURIComponent('infra://home_network/credentials')}`,
      { method: 'DELETE', headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' } },
    )
    const again = await run('default', ['infra://home_network/credentials'])
    expect(again.secretAlreadyImported).toEqual([])
    expect(again.previouslyImported).toContain('infra://home_network/credentials')
  })

  it('按明文导入后整行都不在了的节点，再带 --secret 执行时也不提醒', async () => {
    await run('default', [])
    // 直接删掉这一行，导入事件的 memory_id 被置空
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .delete(memories)
        .where(and(eq(memories.domain, 'infra'), eq(memories.path, 'home_network/credentials'))),
    )
    const again = await run('default', ['infra://home_network/credentials'])
    expect(again.secretAlreadyImported).toEqual([])
    expect(again.previouslyImported).toContain('infra://home_network/credentials')
  })

  it('早期没有记人格的导入事件也能去重：删掉的人格设定不会被写回', async () => {
    await run()
    // 模拟早期版本写下的导入事件：context 里没有 targetPersona
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memoryEvents)
        .set({ context: sql`${memoryEvents.context} - 'targetPersona'` })
        .where(eq(memoryEvents.eventType, 'import')),
    )
    await app.request(
      `/v1/spaces/${ws.spaceId}/memories?uri=${encodeURIComponent('persona://default/soul')}`,
      { method: 'DELETE', headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' } },
    )
    const again = await run()
    expect(again.created).toEqual([])
    expect(again.previouslyImported).toContain('persona://default/soul')
  })

  it('早期没有记人格的导入事件，对应的记忆整行不在了也能去重', async () => {
    await run()
    await withSpace(database.db, ws.spaceId, async (tx) => {
      await tx
        .update(memoryEvents)
        .set({ context: sql`${memoryEvents.context} - 'targetPersona'` })
        .where(eq(memoryEvents.eventType, 'import'))
      await tx
        .delete(memories)
        .where(and(eq(memories.domain, 'persona'), eq(memories.path, 'default/soul')))
    })
    const again = await run()
    expect(again.created).toEqual([])
    expect(again.previouslyImported).toContain('persona://default/soul')
  })

  it('写入时应用已经不属于导入者，就不写进去', async () => {
    const claude = await ws.createApp('claude-code', { runtimeFamily: 'claudecode' })
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const service = new MemoryService({
      db: database.db,
      spaceId: ws.spaceId,
      access: { ...consoleAccess('owner', ws.accountId), writeProvenance: 'system' },
      personaId: 'all',
      masterKey,
      actor: { accountId: ws.accountId },
    })
    // 计划时应用还是自己的，写入前被转给了 bob
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.update(apps).set({ ownerAccountId: bob.accountId }).where(eq(apps.id, claude.id)),
    )
    await expect(
      service.create(
        { uri: 'app://claude-code/agent', content: '规则', priority: 0, glossary: [] },
        { requireAppOwner: ws.accountId },
      ),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('主密钥和导入时用的不一致时拒绝', async () => {
    await run()
    expect(await verifyMasterKey(database.db, ws.spaceId, masterKey)).toBe(true)
    await expect(verifyMasterKey(database.db, ws.spaceId, randomBytes(32))).rejects.toThrow(
      '不一致',
    )
  })

  it('导入后 Claude Code 的启动上下文与 Lore 一致：基础、人格、本应用与主人画像', async () => {
    const claude = await ws.createApp('claude-code', { runtimeFamily: 'claudecode' })
    await run()
    const key = await ws.issueKey(claude.id)
    const result = (await (
      await app.request('/v1/boot', { headers: bearer(key) })
    ).json()) as BootResponse
    expect(result.entries.map((e) => e.uri)).toEqual([
      'core://agent',
      'persona://default/soul',
      'app://claude-code/agent',
      'preferences://user',
    ])
  })
})
