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
import {
  applyImport,
  applySync,
  planImport,
  planSync,
  readLore,
  verifyMasterKey,
  type ImportPlan,
} from '../lore'

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
    await seedNode('infra://office_network', '办公室的网络', {
      priority: 1,
      disclosure: '排查网络时',
      keywords: ['交换机', 'VLAN'],
      old: ['旧的网络描述', '更旧的'],
    })
    await seedNode('infra://office_network/credentials', '路由器密码 hunter2', { priority: 2 })
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
    secretUris = ['infra://office_network/credentials'],
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
  // 与 applyImport 相同的写入身份，用来模拟旧版本写下的导入事件
  const importService = () =>
    new MemoryService({
      db: database.db,
      spaceId: ws.spaceId,
      access: { ...consoleAccess('owner', ws.accountId), writeProvenance: 'system' },
      personaId: 'all',
      masterKey,
      actor: { accountId: ws.accountId },
    })
  // 去掉导入事件里的 targetPersona，模拟早期版本写下的事件
  const dropTargetPersona = () =>
    withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memoryEvents)
        .set({ context: sql`${memoryEvents.context} - 'targetPersona'` })
        .where(eq(memoryEvents.eventType, 'import')),
    )
  // 旧版本去重不上时，把人格设定按现在的格式再导入一条
  const reimportSoul = async () => {
    const soul = (await plan('default', [])).memories.find((m) => m.source === 'core://soul')!
    await importService().create(soul.request, { eventType: 'import', eventContext: soul.context })
  }
  const remove = (uri: string) =>
    app.request(`/v1/spaces/${ws.spaceId}/memories?uri=${encodeURIComponent(uri)}`, {
      method: 'DELETE',
      headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' },
    })
  const move = (from: string, to: string) =>
    app.request(
      `/v1/spaces/${ws.spaceId}/memories/move`,
      jsonRequest('POST', { from, to }, { cookie: ws.cookie }),
    )

  it('读出节点、当前正文、旧版本数、关键词与召回事件数', async () => {
    const snapshot = await readLore(lore)
    expect(snapshot.recallEvents).toBe(1)
    const network = snapshot.nodes.find((n) => n.uri === 'infra://office_network')!
    expect(network).toMatchObject({
      content: '办公室的网络',
      priority: 1,
      disclosure: '排查网络时',
      previousVersions: 2,
    })
    expect(network.keywords.sort()).toEqual(['VLAN', '交换机'])
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
        'infra://office_network',
        'infra://office_network/credentials',
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
    expect(byUri.get('infra://office_network')).toMatchObject({
      layer: 'private',
      priority: 1,
      disclosure: '排查网络时',
    })
    expect(byUri.get('infra://office_network')!.createdAt.toISOString()).toBe(
      '2025-03-01T00:00:00.000Z',
    )
    const secret = byUri.get('infra://office_network/credentials')!
    expect(secret).toMatchObject({ sensitivity: 'secret', content: null })
    expect(secret.ciphertext).not.toBeNull()

    const events = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memoryEvents).where(eq(memoryEvents.memoryId, secret.id)),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      eventType: 'import',
      context: { source: 'lore', loreUri: 'infra://office_network/credentials' },
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
      `/v1/spaces/${ws.spaceId}/memories?uri=${encodeURIComponent('infra://office_network/credentials')}`,
      { method: 'DELETE', headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' } },
    )
    expect(
      (await viaConsole('POST', { from: 'infra://office_network', to: 'infra://network' })).status,
    ).toBe(200)

    const again = await run()
    expect(again.created).toEqual([])
    expect(again.previouslyImported).toHaveLength(7)
    expect(again.personaCreated).toBe(false)
    expect(again.appsCreated).toEqual([])
    const live = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select({ path: memories.path, deletedAt: memories.deletedAt }).from(memories),
    )
    expect(live.filter((m) => !m.deletedAt).map((m) => m.path)).not.toContain('office_network')
    expect(live.filter((m) => !m.deletedAt).map((m) => m.path)).not.toContain(
      'office_network/credentials',
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
    const again = await run('default', ['infra://office_network/credentials'])
    expect(again.secretAlreadyImported).toEqual([
      { uri: 'infra://office_network/credentials', current: 'infra://office_network/credentials' },
    ])
  })

  it('按明文导入后移动过的节点，提醒里给出它现在的 URI', async () => {
    await run('default', [])
    expect((await move('infra://office_network/credentials', 'infra://creds')).status).toBe(200)
    const again = await run('default', ['infra://office_network/credentials'])
    expect(again.secretAlreadyImported).toEqual([
      { uri: 'infra://office_network/credentials', current: 'infra://creds' },
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
        { uri: 'infra://office_network/credentials', sensitivity: 'secret' },
        { cookie: ws.cookie },
      ),
    )
    const again = await run('default', ['infra://office_network/credentials'])
    expect(again.secretAlreadyImported).toEqual([])
  })

  it('按明文导入后删掉了的节点，再带 --secret 执行时不提醒', async () => {
    await run('default', [])
    expect((await remove('infra://office_network/credentials')).status).toBe(204)
    const again = await run('default', ['infra://office_network/credentials'])
    expect(again.secretAlreadyImported).toEqual([])
    expect(again.previouslyImported).toContain('infra://office_network/credentials')
  })

  it('按明文导入后整行都不在了的节点，再带 --secret 执行时也不提醒', async () => {
    await run('default', [])
    // 直接删掉这一行，导入事件的 memory_id 被置空
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .delete(memories)
        .where(and(eq(memories.domain, 'infra'), eq(memories.path, 'office_network/credentials'))),
    )
    const again = await run('default', ['infra://office_network/credentials'])
    expect(again.secretAlreadyImported).toEqual([])
    expect(again.previouslyImported).toContain('infra://office_network/credentials')
  })

  it('早期没有记人格的导入事件也能去重：删掉的人格设定不会被写回', async () => {
    await run()
    await dropTargetPersona()
    expect((await remove('persona://default/soul')).status).toBe(204)
    const again = await run()
    expect(again.created).toEqual([])
    expect(again.previouslyImported).toContain('persona://default/soul')
  })

  it('早期没有记人格的导入事件，对应的记忆整行不在了也能去重', async () => {
    await run()
    await dropTargetPersona()
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .delete(memories)
        .where(and(eq(memories.domain, 'persona'), eq(memories.path, 'default/soul'))),
    )
    const again = await run()
    expect(again.created).toEqual([])
    expect(again.previouslyImported).toContain('persona://default/soul')
  })

  it('同一个节点导入过多条时，较早的一条还是明文就提醒，不被后一条的删除盖住', async () => {
    await run('default', [])
    await dropTargetPersona()
    expect((await move('persona://default/soul', 'persona://default/soul_old')).status).toBe(200)
    await reimportSoul()
    expect((await remove('persona://default/soul')).status).toBe(204)
    const again = await run('default', ['core://soul'])
    expect(again.created).toEqual([])
    expect(again.secretAlreadyImported).toEqual([
      { uri: 'persona://default/soul', current: 'persona://default/soul_old' },
    ])
  })

  it('同一个节点导入过多条时，较晚的一条还是明文就提醒，不被前一条的删除盖住', async () => {
    await run('default', [])
    await dropTargetPersona()
    expect((await remove('persona://default/soul')).status).toBe(204)
    await reimportSoul()
    const again = await run('default', ['core://soul'])
    expect(again.created).toEqual([])
    expect(again.secretAlreadyImported).toEqual([
      { uri: 'persona://default/soul', current: 'persona://default/soul' },
    ])
  })

  it('同一个节点导入过多条、都还是明文时，每条都提醒，跳过只记一次', async () => {
    await run('default', [])
    await dropTargetPersona()
    expect((await move('persona://default/soul', 'persona://default/soul_old')).status).toBe(200)
    await reimportSoul()
    const again = await run('default', ['core://soul'])
    expect(again.created).toEqual([])
    expect(again.secretAlreadyImported).toEqual([
      { uri: 'persona://default/soul', current: 'persona://default/soul_old' },
      { uri: 'persona://default/soul', current: 'persona://default/soul' },
    ])
    expect(again.previouslyImported.filter((u) => u === 'persona://default/soul')).toHaveLength(1)
  })

  it('写入时应用已经不属于导入者，就不写进去', async () => {
    const claude = await ws.createApp('claude-code', { runtimeFamily: 'claudecode' })
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const service = importService()
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

  describe('同步导入过的节点', () => {
    const target = () => ({
      db: database.db,
      spaceId: ws.spaceId,
      accountId: ws.accountId,
      masterKey,
    })
    const syncPlan = async () => planSync(target(), await plan(), await readLore(lore))
    const consoleUpdate = (body: Record<string, unknown>) =>
      app.request(
        `/v1/spaces/${ws.spaceId}/memories`,
        jsonRequest('PATCH', body, { cookie: ws.cookie }),
      )
    const memoryEventsOf = (memoryId: string) =>
      withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .select()
          .from(memoryEvents)
          .where(eq(memoryEvents.memoryId, memoryId))
          .orderBy(memoryEvents.id),
      )

    // 下面几个函数改动 Lore 的数据，返回还原用的函数：Lore 的数据所有用例共用，每个用例结束时都要还原
    const loreNode = async (uri: string) => {
      const [domain, path] = uri.split('://') as [string, string]
      const [row] = await lore<{ edgeId: number; uuid: string; priority: number }[]>`
        select e.id as "edgeId", e.child_uuid as uuid, e.priority
        from paths p join edges e on e.id = p.edge_id
        where p.domain = ${domain} and p.path = ${path}`
      return row!
    }
    const editLore = async (
      uri: string,
      change: { content?: string; priority?: number; keywords?: string[] },
    ) => {
      const node = await loreNode(uri)
      const undo: (() => Promise<unknown>)[] = []
      if (change.content !== undefined) {
        const [row] = await lore<{ id: number }[]>`
          insert into memories (node_uuid, content, created_at)
          values (${node.uuid}, ${change.content}, '2025-05-01T00:00:00Z') returning id`
        undo.push(() => lore`delete from memories where id = ${row!.id}`)
      }
      if (change.priority !== undefined) {
        await lore`update edges set priority = ${change.priority} where id = ${node.edgeId}`
        undo.push(
          () => lore`update edges set priority = ${node.priority} where id = ${node.edgeId}`,
        )
      }
      for (const keyword of change.keywords ?? []) {
        const [row] = await lore<{ id: number }[]>`
          insert into glossary_keywords (keyword, node_uuid) values (${keyword}, ${node.uuid}) returning id`
        undo.push(() => lore`delete from glossary_keywords where id = ${row!.id}`)
      }
      return async () => {
        for (const u of undo.reverse()) await u()
      }
    }
    const renameLore = async (uri: string, toPath: string) => {
      const [domain, path] = uri.split('://') as [string, string]
      await lore`update paths set path = ${toPath} where domain = ${domain} and path = ${path}`
      return async () => {
        await lore`update paths set path = ${path} where domain = ${domain} and path = ${toPath}`
      }
    }
    const dropLore = async (uri: string) => {
      const [domain, path] = uri.split('://') as [string, string]
      const [row] = await lore<{ edgeId: number; createdAt: Date }[]>`
        delete from paths where domain = ${domain} and path = ${path}
        returning edge_id as "edgeId", created_at as "createdAt"`
      return async () => {
        await lore`insert into paths (domain, path, edge_id, created_at)
          values (${domain}, ${path}, ${row!.edgeId}, ${row!.createdAt})`
      }
    }

    it('Lore 里改过、Kioku 里没人改过的按 Lore 更新，记一条 sync 事件；再算一次就是最新', async () => {
      await run()
      const undo = await editLore('infra://office_network', {
        content: '办公室的网络，换了新交换机',
        priority: 0,
        keywords: ['新交换机'],
      })
      try {
        const sync = await syncPlan()
        expect(sync.items.filter((i) => i.state !== 'current')).toEqual([
          expect.objectContaining({
            uri: 'infra://office_network',
            state: 'update',
            changes: ['content', 'priority', 'glossary'],
          }),
        ])
        expect(sync.goneFromLore).toEqual([])
        expect(await applySync(target(), sync)).toEqual({
          updated: ['infra://office_network'],
          failed: [],
        })
        const view = await importService().get('infra://office_network')
        expect(view).toMatchObject({
          content: '办公室的网络，换了新交换机',
          priority: 0,
          disclosure: '排查网络时',
        })
        expect([...view.glossary].sort()).toEqual(['VLAN', '交换机', '新交换机'].sort())
        const events = await memoryEventsOf(view.id)
        expect(events.map((e) => e.eventType)).toEqual(['import', 'sync'])
        expect(events[1]!.context).toMatchObject({
          source: 'lore',
          loreUri: 'infra://office_network',
          changes: ['content', 'priority', 'glossary'],
        })
        const again = await syncPlan()
        expect(again.items.every((i) => i.state === 'current')).toBe(true)
      } finally {
        await undo()
      }
    })

    it('在 Kioku 里改过、移动过、删除了的不同步，只列出来', async () => {
      await run()
      expect(
        (await consoleUpdate({ uri: 'infra://office_network', content: '在 Kioku 里改过' })).status,
      ).toBe(200)
      expect((await move('preferences://user', 'preferences://me')).status).toBe(200)
      expect((await remove('core://agent')).status).toBe(204)
      const undoNetwork = await editLore('infra://office_network', { content: 'Lore 里也改了' })
      const undoPrefs = await editLore('preferences://user', { content: 'Lore 里改了偏好' })
      try {
        const sync = await syncPlan()
        const bySource = new Map(sync.items.map((i) => [i.source, i]))
        expect(bySource.get('infra://office_network')).toMatchObject({
          state: 'edited',
          uri: 'infra://office_network',
        })
        expect(bySource.get('preferences://user')).toMatchObject({
          state: 'edited',
          uri: 'preferences://me',
        })
        expect(bySource.get('core://agent')).toMatchObject({
          state: 'deleted',
          uri: 'core://agent',
        })
        expect((await applySync(target(), sync)).updated).toEqual([])
        expect((await importService().get('infra://office_network')).content).toBe(
          '在 Kioku 里改过',
        )
      } finally {
        await undoPrefs()
        await undoNetwork()
      }
    })

    it('Lore 里换了路径的不动只列出来；Lore 里删掉的节点列出来，Kioku 里保留', async () => {
      await run()
      const undoRename = await renameLore('infra://office_network', 'office_lan')
      const undoDrop = await dropLore('core://agent/zcode')
      try {
        const sync = await syncPlan()
        expect(sync.items.filter((i) => i.state !== 'current')).toEqual([
          expect.objectContaining({
            source: 'infra://office_lan',
            state: 'moved',
            uri: 'infra://office_network',
            target: 'infra://office_lan',
          }),
        ])
        expect(sync.goneFromLore).toEqual(['app://zcode/agent'])
        expect((await applySync(target(), sync)).updated).toEqual([])
        expect((await importService().get('app://zcode/agent')).content).toBe('zcode 运行时约束')
      } finally {
        await undoDrop()
        await undoRename()
      }
    })

    it('secret 节点按解密后的正文比对，改了就加密写回，事件里没有明文', async () => {
      await run()
      const undo = await editLore('infra://office_network/credentials', {
        content: '路由器密码 hunter3',
      })
      try {
        const sync = await syncPlan()
        expect(sync.items.filter((i) => i.state !== 'current')).toEqual([
          expect.objectContaining({
            uri: 'infra://office_network/credentials',
            state: 'update',
            changes: ['content'],
          }),
        ])
        expect((await applySync(target(), sync)).updated).toEqual([
          'infra://office_network/credentials',
        ])
        const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
          tx
            .select()
            .from(memories)
            .where(
              and(eq(memories.domain, 'infra'), eq(memories.path, 'office_network/credentials')),
            ),
        )
        expect(row).toMatchObject({ sensitivity: 'secret', content: null })
        expect((await importService().get('infra://office_network/credentials')).content).toBe(
          '路由器密码 hunter3',
        )
        expect(JSON.stringify(await memoryEventsOf(row!.id))).not.toContain('hunter')
      } finally {
        await undo()
      }
    })

    it('计划之后有人改了，执行时按版本号拒绝这一条', async () => {
      await run()
      const undo = await editLore('infra://office_network', { content: 'Lore 里的新正文' })
      try {
        const sync = await syncPlan()
        expect(
          (await consoleUpdate({ uri: 'infra://office_network', content: '计划之后改的' })).status,
        ).toBe(200)
        expect(await applySync(target(), sync)).toEqual({
          updated: [],
          failed: [
            { uri: 'infra://office_network', reason: expect.stringContaining('版本已变化') },
          ],
        })
        expect((await importService().get('infra://office_network')).content).toBe('计划之后改的')
      } finally {
        await undo()
      }
    })

    it('应用在计划之后转给了别人，同步不写进去', async () => {
      const claude = await ws.createApp('claude-code', { runtimeFamily: 'claudecode' })
      await run()
      const undo = await editLore('core://agent/claudecode', { content: '新的运行时约束' })
      try {
        const sync = await syncPlan()
        expect(sync.items.filter((i) => i.state === 'update').map((i) => i.uri)).toEqual([
          'app://claude-code/agent',
        ])
        const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
        await withSpace(database.db, ws.spaceId, (tx) =>
          tx.update(apps).set({ ownerAccountId: bob.accountId }).where(eq(apps.id, claude.id)),
        )
        expect(await applySync(target(), sync)).toEqual({
          updated: [],
          failed: [{ uri: 'app://claude-code/agent', reason: '这个应用已经不属于导入者' }],
        })
      } finally {
        await undo()
      }
    })

    it('要比对的 secret 没有主密钥就不能同步；secret 在 Kioku 里改过之后就不再需要', async () => {
      await run()
      await expect(
        planSync({ ...target(), masterKey: null }, await plan(), await readLore(lore)),
      ).rejects.toThrow('KIOKU_MASTER_KEY')
      expect(
        (await consoleUpdate({ uri: 'infra://office_network/credentials', priority: 1 })).status,
      ).toBe(200)
      const sync = await planSync(
        { ...target(), masterKey: null },
        await plan(),
        await readLore(lore),
      )
      expect(sync.items.find((i) => i.uri === 'infra://office_network/credentials')).toMatchObject({
        state: 'edited',
      })
    })

    it('按版本号判断有没有人改过：最近一条事件仍是导入，版本号变了也算改过', async () => {
      await run()
      const undo = await editLore('infra://office_network', { content: 'Lore 里的新正文' })
      try {
        // 不经过服务、不记事件地改一次，相当于查事件与读记忆之间有人写入
        await withSpace(database.db, ws.spaceId, (tx) =>
          tx
            .update(memories)
            .set({ content: '有人刚改的', version: sql`${memories.version} + 1` })
            .where(and(eq(memories.domain, 'infra'), eq(memories.path, 'office_network'))),
        )
        const sync = await syncPlan()
        expect(sync.items.find((i) => i.uri === 'infra://office_network')).toMatchObject({
          state: 'edited',
        })
        expect((await applySync(target(), sync)).updated).toEqual([])
        expect((await importService().get('infra://office_network')).content).toBe('有人刚改的')
      } finally {
        await undo()
      }
    })

    it('Lore 里换了路径、映射到别的层的节点只列出来，导入时也不在新位置再建一条', async () => {
      await ws.createApp('claude-code', { runtimeFamily: 'claudecode' })
      await run()
      const undoRename = await renameLore('core://agent/claudecode', 'claude_rules')
      try {
        const sync = await syncPlan()
        expect(sync.items.filter((i) => i.state === 'moved')).toEqual([
          expect.objectContaining({
            source: 'core://claude_rules',
            uri: 'app://claude-code/agent',
            target: 'core://claude_rules',
          }),
        ])
        const result = await applyImport(target(), await plan(), { skip: sync.skipCreate })
        expect(result.created).toEqual([])
        expect(result.previouslyImported).toContain('core://claude_rules')
        const core = await withSpace(database.db, ws.spaceId, (tx) =>
          tx.select({ path: memories.path }).from(memories).where(eq(memories.domain, 'core')),
        )
        expect(core.map((r) => r.path)).not.toContain('claude_rules')
      } finally {
        await undoRename()
      }
    })

    it('这次的导入计划不导入的节点，同步时列出原因', async () => {
      await run()
      const undo = await editLore('infra://office_network', { content: '改坏了 {{cred:Bad Name}}' })
      try {
        const sync = await syncPlan()
        expect(sync.items.filter((i) => i.state === 'skipped')).toEqual([
          expect.objectContaining({
            source: 'infra://office_network',
            uri: 'infra://office_network',
            reason: expect.stringContaining('格式不对的凭据占位符'),
          }),
        ])
      } finally {
        await undo()
      }
    })

    it('单条读不出来时只记下这一条，不中止整次同步', async () => {
      await run()
      // 版本号不变、过期之后按 URI 读不到
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(memories)
          .set({ expiresAt: new Date(Date.now() - 86_400_000) })
          .where(and(eq(memories.domain, 'infra'), eq(memories.path, 'office_network'))),
      )
      const sync = await syncPlan()
      expect(sync.items.find((i) => i.uri === 'infra://office_network')).toMatchObject({
        state: 'unreadable',
        reason: expect.stringContaining('记忆不存在'),
      })
      expect(sync.items.filter((i) => i.state === 'current').length).toBeGreaterThan(0)
    })
  })
})
