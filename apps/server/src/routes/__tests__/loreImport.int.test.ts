import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  LoreImportPlan,
  LoreImportResult,
  type LoreImportSource,
  type LoreSyncItem,
} from '@kioku/contracts'
import { and, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { acquireTransferSlot, queuedTransfers, TRANSFER_BUSY } from '../../backup/transferGate'
import { withSpace, type Database } from '../../db/client'
import { apps, memories, memoryEvents, personas, settings, spaceMembers } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import {
  applyImport,
  applySync,
  existingImportApps,
  planImport,
  planSync,
  readLore,
} from '../../importer/lore'
import type { Jobs } from '../../jobs/queue'
import { BOOT_ELIGIBLE } from '../../memory/filter'
import { MemoryService } from '../../memory/service'
import { consoleAccess } from '../../access/access'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import {
  exportLore,
  LORE_SCHEMA,
  seedLoreNode,
  withoutDeprecatedContent,
  type LoreExport,
  type LoreSeed,
} from '../../testing/loreFixture'

const EARLIER = '2026-01-01T00:00:00.000Z'
const LATER = '2026-02-01T00:00:00.000Z'

describe.skipIf(!testDatabaseUrl)('从 Lore 导入的接口', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let noKeyApp: ReturnType<typeof createApp>
  let lore: postgres.Sql
  let ws: Workspace
  let backfills = 0
  const masterKey = randomBytes(32)
  const jobs: Jobs = {
    enqueueEmbed: () => {},
    enqueueExtraction: async () => {},
    enqueueBackfill: async () => {
      backfills++
      return true
    },
    enqueueSwitch: async () => true,
    enqueuePrune: async () => true,
    enqueueBackup: async () => null,
    backupRun: async () => null,
    enqueueCleanup: async () => true,
    enqueueDream: async () => null,
    dreamRun: async () => null,
  }

  beforeAll(async () => {
    database = await openTestDatabase()
    const appWith = (key: Buffer | null) =>
      createApp({
        db: database.db,
        cookieSecure: false,
        masterKey: key,
        embedder: staticEmbedderSource(null),
        jobs,
      })
    app = appWith(masterKey)
    noKeyApp = appWith(null)
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
    backfills = 0
    // 每个用例一份新的 Lore：连接的 search_path 指向它，schema 重建之后照常用
    const admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
    await admin.unsafe(LORE_SCHEMA)
    await admin.end()
    await seed('core://agent', '工作流约束的正文', { priority: 0 })
    await seed('core://soul', '人格设定的正文', { priority: 0 })
    await seed('core://agent/claudecode', '运行时约束的正文', { priority: 0 })
    await seed('preferences://user', '偏好的正文', { priority: 1, keywords: ['中文'] })
    await seed('infra://nas', '存储服务器的正文', {
      priority: 1,
      disclosure: '排查存储时',
      keywords: ['存储', '备份'],
      old: ['旧版本的正文'],
    })
    await seed('infra://router/credentials', '路由器密码 hunter2', { priority: 3 })
    ws = await bootstrap(app)
  })

  const seed = (uri: string, content: string, extra?: LoreSeed) =>
    seedLoreNode(lore, uri, content, extra)
  const editLore = async (uri: string, content: string) => {
    await lore`insert into memories (node_uuid, content, created_at)
      values (${`uuid-${uri}`}, ${content}, '2025-05-01T00:00:00Z')`
  }
  const renameLore = async (uri: string, toPath: string) => {
    const [domain, path] = uri.split('://') as [string, string]
    await lore`update paths set path = ${toPath} where domain = ${domain} and path = ${path}`
  }
  const dropLore = async (uri: string) => {
    const [domain, path] = uri.split('://') as [string, string]
    await lore`delete from paths where domain = ${domain} and path = ${path}`
  }

  // 浏览器裁剪之后上传的样子
  const fileSource = async (createdAt = EARLIER): Promise<LoreImportSource> => ({
    kind: 'file',
    backup: withoutDeprecatedContent(await exportLore(lore, createdAt)) as Extract<
      LoreImportSource,
      { kind: 'file' }
    >['backup'],
  })
  const post = (
    action: 'plan' | 'apply',
    body: unknown,
    options: { cookie?: string; on?: typeof app } = {},
  ) =>
    (options.on ?? app).request(
      `/v1/spaces/${ws.spaceId}/lore-import/${action}`,
      jsonRequest('POST', body, { cookie: options.cookie ?? ws.cookie }),
    )
  const planOf = async (source: LoreImportSource, extra: Record<string, unknown> = {}) => {
    const res = await post('plan', { source, ...extra })
    expect(res.status, await res.clone().text()).toBe(200)
    return LoreImportPlan.parse(await res.json())
  }
  const applyOf = async (
    source: LoreImportSource,
    plan: LoreImportPlan,
    extra: Record<string, unknown> = {},
  ) => {
    const res = await post('apply', { source, fingerprint: plan.fingerprint, ...extra })
    expect(res.status, await res.clone().text()).toBe(200)
    return LoreImportResult.parse(await res.json())
  }
  const importAll = async (source: LoreImportSource, extra: Record<string, unknown> = {}) =>
    applyOf(source, await planOf(source), extra)
  const nodeOf = (plan: LoreImportPlan, uri: string) => plan.nodes.find((n) => n.uri === uri)!
  const stateOf = (plan: LoreImportPlan, uri: string) => nodeOf(plan, uri).targets[0]!.state
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
  const counts = () =>
    withSpace(database.db, ws.spaceId, async (tx) => ({
      personas: (await tx.select().from(personas)).length,
      apps: (await tx.select().from(apps)).length,
      memories: (await tx.select().from(memories)).length,
      events: (await tx.select().from(memoryEvents)).length,
    }))
  // 和命令行相同的步骤：读库、算计划、写入
  const cli = async (persona = 'default') => {
    const target = { db: database.db, spaceId: ws.spaceId, accountId: ws.accountId, masterKey }
    const snapshot = await readLore(lore)
    const plan = planImport(snapshot, await existingImportApps(database.db, ws.spaceId), {
      accountId: ws.accountId,
      persona: { slug: persona, name: '默认人格' },
      secretUris: new Set(),
      quoteMalformed: true,
    })
    const sync = await planSync(target, plan, snapshot)
    return { target, snapshot, plan, sync }
  }
  const cliApply = async (persona?: string) => {
    const { target, plan, sync } = await cli(persona)
    const result = await applyImport(target, plan)
    expect(result.failed).toEqual([])
    expect((await applySync(target, sync)).failed).toEqual([])
  }
  const memoryWhere = (domain: string, path: string) =>
    and(eq(memories.domain, domain), eq(memories.path, path))

  // 一个假的 Lore：校验 Token，返回完整的导出（带接口 Key 这些不该进来的表）
  const servers: Server[] = []
  const fakeLore = async (token: string, exported: () => Promise<LoreExport>) => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end('{"detail":"Unauthorized"}')
        return
      }
      void exported().then((data) =>
        res.end(
          JSON.stringify({
            ...data,
            stats: {},
            tables: {
              ...data.tables,
              app_settings: [
                { key: 'embedding.api_key', value: { value: 'sk-should-not-matter' } },
              ],
              dream_diary: [{ id: '1', narrative: '日记' }],
            },
          }),
        ),
      )
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  const TOKEN = 'lore-token-not-for-the-database'

  describe('权限', () => {
    it('editor、viewer 与不是成员的账号不能看计划也不能执行', async () => {
      const source = await fileSource()
      const plan = await planOf(source)
      const editor = await addMember(database.db, ws.spaceId, 'editor', 'editor')
      const viewer = await addMember(database.db, ws.spaceId, 'viewer', 'viewer')
      // 只有账号，不是这个空间的成员
      const other = await addMember(database.db, ws.spaceId, 'other', 'owner')
      await database.db.delete(spaceMembers).where(eq(spaceMembers.accountId, other.accountId))
      const before = await counts()
      for (const { cookie } of [editor, viewer, other]) {
        for (const [action, body] of [
          ['plan', { source }],
          ['apply', { source, fingerprint: plan.fingerprint }],
        ] as const) {
          expect((await post(action, body, { cookie })).status).toBe(403)
        }
      }
      expect(await counts()).toEqual(before)
    })

    it('不是实例管理员的 owner 能上传，不能从地址拉取：服务端不会向那个地址发请求', async () => {
      const source = await fileSource()
      const owner = await addMember(database.db, ws.spaceId, 'second', 'owner')
      expect((await post('plan', { source }, { cookie: owner.cookie })).status).toBe(200)

      let hits = 0
      const server = createServer((_req, res) => {
        hits++
        res.end('{}')
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      try {
        const remote = { kind: 'url', url, token: 't' }
        for (const [action, body] of [
          ['plan', { source: remote }],
          ['apply', { source: remote, fingerprint: 'x' }],
        ] as const) {
          const res = await post(action, body, { cookie: owner.cookie })
          expect(res.status).toBe(403)
          expect(((await res.json()) as { error: string }).error).toContain('实例管理员')
        }
        expect(hits).toBe(0)
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
  })

  describe('请求的形状', () => {
    it('带别的表或别的顶层字段的上传拒绝：Lore 的接口 Key 不该发到这里', async () => {
      const source = (await fileSource()) as Extract<LoreImportSource, { kind: 'file' }>
      const extraTable = {
        ...source,
        backup: { ...source.backup, tables: { ...source.backup.tables, app_settings: [] } },
      }
      const extraField = { ...source, backup: { ...source.backup, stats: {} } }
      for (const bad of [extraTable, extraField]) {
        const res = await post('plan', { source: bad })
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toContain('五张表')
      }
    })

    it('超过上限的请求体返回 413，带中文说明', async () => {
      const res = await app.request(`/v1/spaces/${ws.spaceId}/lore-import/plan`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          cookie: ws.cookie,
        },
        body: JSON.stringify({ pad: 'x'.repeat(33 * 1024 * 1024) }),
      })
      expect(res.status).toBe(413)
      expect(((await res.json()) as { error: string }).error).toContain('32 MB')
    })

    it('文件的内容不对时返回 400，说清哪一行、不带内容；不写库', async () => {
      const source = (await fileSource()) as Extract<LoreImportSource, { kind: 'file' }>
      source.backup.tables.memories[0]!.content = '机密\u0000正文'
      source.backup.tables.memories[0]!.deprecated = false
      const before = await counts()
      const res = await post('plan', { source })
      expect(res.status).toBe(400)
      const { error } = (await res.json()) as { error: string }
      expect(error).toContain('memories 第 1 行')
      expect(error).not.toContain('机密')
      expect(await counts()).toEqual(before)
    })

    it('人格的标识不合法时拒绝；OpenAPI 文档生成得出来', async () => {
      const res = await post('plan', {
        source: await fileSource(),
        persona: { slug: 'Bad Slug', name: 'x' },
      })
      expect(res.status).toBe(400)
      const doc = await app.request('/v1/openapi.json')
      expect(doc.status).toBe(200)
      expect(JSON.stringify(await doc.json())).toContain('/spaces/{spaceId}/lore-import/plan')
    })
  })

  describe('计划', () => {
    it('不含正文，不写库；映射、状态、会进启动上下文的与像凭据的都给出来', async () => {
      await seed(
        'projects://kioku',
        '带引用的正文 {{cred:nas#password}} {{cred:nas}} {{cred:ap}}',
        {
          priority: 0,
        },
      )
      await seed('infra://broken', '说明 {{cred:nas 密码是 hunter3 不要外传')
      await seed('infra://big', `超长的正文 hunter4 ${'长'.repeat(20_000)}`)
      const before = await counts()
      const source = await fileSource()
      const plan = await planOf(source)
      expect(await counts()).toEqual(before)

      // 看原始的响应：解析时会丢掉契约里没有的字段
      const text = await (await post('plan', { source })).text()
      for (const body of [
        '工作流约束的正文',
        '存储服务器的正文',
        '旧版本的正文',
        'hunter2',
        // 坏占位符只说有，不引用那段正文；写入校验的报错也不带
        'hunter3',
        '{{cred:',
        'hunter4',
      ]) {
        expect(text).not.toContain(body)
      }
      expect(plan.skipped).toContainEqual({
        source: 'infra://broken',
        reason: '正文里有格式不对的凭据占位符：写到这种写法的说明文字要去掉花括号',
      })
      expect(plan.skipped.map((s) => s.source)).toContain('infra://big')
      expect(plan).toMatchObject({
        exportedAt: EARLIER,
        staleSince: null,
        nodeCount: 9,
        previousVersions: 1,
        secretAvailable: true,
        persona: { slug: 'default', name: '默认人格', exists: false, imported: [] },
        apps: [
          {
            runtime: 'claudecode',
            apps: [{ slug: 'claudecode', create: true, runtimeFamily: 'claudecode' }],
          },
        ],
      })
      expect(nodeOf(plan, 'core://soul').targets).toEqual([
        {
          uri: 'persona://default/soul',
          layer: 'persona',
          sensitivity: 'public',
          priority: 0,
          state: 'new',
          boot: true,
          current: [],
        },
      ])
      expect(nodeOf(plan, 'infra://nas').targets[0]).toMatchObject({
        layer: 'private',
        boot: false,
      })
      expect(nodeOf(plan, 'projects://kioku').credentialRefs).toEqual(['ap', 'nas'])
      expect(nodeOf(plan, 'projects://kioku').targets[0]!.boot).toBe(true)
      expect(nodeOf(plan, 'infra://router/credentials').credentialHints).toEqual({
        path: true,
        content: false,
        extras: false,
      })
      expect(plan.warnings).toContainEqual({
        uri: 'infra://router/credentials',
        kind: 'credentialPath',
      })
    })

    it('计划标出的启动上下文和写进去之后的 BOOT_ELIGIBLE 一致', async () => {
      await seed('core://low', '基础层 p1', { priority: 1 })
      await seed('core://soul/style', '人格层 p1', { priority: 1 })
      await seed('core://soul/more', '人格层 p2', { priority: 2 })
      await seed('core://agent/claudecode/tools', '应用层 p1', { priority: 1 })
      await seed('core://agent/claudecode/extra', '应用层 p2', { priority: 2 })
      await seed('preferences://top', '主人层 p0', { priority: 0 })
      await seed('projects://top', '私人层 p0', { priority: 0 })
      const source = await fileSource()
      const plan = await planOf(source)
      expect((await applyOf(source, plan)).failed).toEqual([])

      const eligible = await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .select({ domain: memories.domain, path: memories.path })
          .from(memories)
          .where(BOOT_ELIGIBLE),
      )
      const planned = plan.nodes.flatMap((n) => n.targets).filter((t) => t.boot)
      expect(planned.map((t) => t.uri).sort()).toEqual(
        eligible.map((r) => `${r.domain!}://${r.path!}`).sort(),
      )
      expect(planned.length).toBeGreaterThan(4)
    })

    it('打乱导出的行序，指纹不变', async () => {
      const source = (await fileSource()) as Extract<LoreImportSource, { kind: 'file' }>
      const tables = source.backup.tables
      const shuffled: LoreImportSource = {
        kind: 'file',
        backup: {
          ...source.backup,
          tables: {
            nodes: [...tables.nodes].reverse(),
            memories: [...tables.memories].reverse(),
            edges: [...tables.edges].reverse(),
            paths: [...tables.paths].reverse(),
            glossary_keywords: [...tables.glossary_keywords].reverse(),
          },
        },
      }
      const a = await planOf(source)
      const b = await planOf(shuffled)
      expect(b.fingerprint).toBe(a.fingerprint)
      // 导出时间不同也不影响：只有真要写的东西变了才算计划变了
      const later = await planOf(await fileSource(LATER))
      expect(later.fingerprint).toBe(a.fingerprint)
    })

    it('人格默认和命令行相同；命令行导入过的再走计划，soul 不会变成新建', async () => {
      await cliApply()
      const plan = await planOf(await fileSource())
      expect(plan.persona).toEqual({
        slug: 'default',
        name: '默认人格',
        exists: true,
        imported: ['default'],
      })
      expect(stateOf(plan, 'core://soul')).toBe('imported')
      expect(plan.sync.items.find((i) => i.uri === 'persona://default/soul')!.state).toBe('current')

      const other = await planOf(await fileSource(), { persona: { slug: 'work', name: '工作' } })
      expect(other.persona).toMatchObject({ slug: 'work', exists: false, imported: ['default'] })
      expect(nodeOf(other, 'core://soul').targets[0]).toMatchObject({
        uri: 'persona://work/soul',
        state: 'new',
      })
    })

    it('给出已导入与换了路径的状态，以及之前导入的记忆现在的样子', async () => {
      await cliApply()
      // 在 Kioku 里移动、删除、改成 secret；在 Lore 里换路径
      await service().move({ from: 'infra://nas', to: 'infra://storage' })
      await service().delete('preferences://user')
      await service().update({ uri: 'core://agent', sensitivity: 'secret' })
      await renameLore('core://agent/claudecode', 'claude_rules')
      const plan = await planOf(await fileSource())
      expect(nodeOf(plan, 'infra://nas').targets[0]).toMatchObject({
        state: 'imported',
        current: [{ uri: 'infra://storage', secret: false }],
      })
      expect(nodeOf(plan, 'preferences://user').targets[0]).toMatchObject({
        state: 'imported',
        current: [{ uri: null, secret: false }],
      })
      expect(nodeOf(plan, 'core://agent').targets[0]!.current).toEqual([
        { uri: 'core://agent', secret: true },
      ])
      expect(nodeOf(plan, 'core://claude_rules').targets[0]).toMatchObject({
        state: 'moved',
        current: [{ uri: 'app://claudecode/agent', secret: false }],
      })
    })

    it('标出会被设默认人格的应用与在用别的人格的应用，和执行的结果一致', async () => {
      const work = await ws.createPersona('work')
      await ws.createApp('claude-code', { runtimeFamily: 'claudecode' })
      await ws.createApp('claude-work', { runtimeFamily: 'claudecode', defaultPersonaId: work.id })
      const source = await fileSource()
      const plan = await planOf(source)
      expect(plan.appsGivenPersona).toEqual(['claude-code'])
      expect(plan.appsOtherPersona).toEqual(['claude-work'])
      const result = await applyOf(source, plan)
      expect(result.appsGivenPersona).toEqual(plan.appsGivenPersona)
      expect(result.appsOtherPersona).toEqual(plan.appsOtherPersona)
    })

    it('回归：命令行导入并同步过的数据，八种状态与命令行的 --sync 逐项相同', async () => {
      await seed('infra://edit_in_kioku', '会在 Kioku 里改的')
      await seed('infra://rename_in_lore', '会在 Lore 里换路径的')
      await seed('infra://delete_in_kioku', '会在 Kioku 里删的')
      await seed('infra://broken_in_lore', '之后会有坏占位符的')
      await seed('infra://gone_from_lore', '会在 Lore 里删掉的')
      await seed('infra://change_in_lore', '会在 Lore 里改的')
      await seed('infra://unreadable', '过期之后读不到的')
      await cliApply('old-persona')
      await cliApply()
      // 命令行又同步过一次：之后走界面的第一次计划不能把这些看成没人改过以外的状态
      await editLore('infra://change_in_lore', '同步过一次的正文')
      await cliApply()

      await service().update({ uri: 'infra://edit_in_kioku', content: 'Kioku 里改过' })
      await service().delete('infra://delete_in_kioku')
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(memories)
          .set({ expiresAt: new Date(Date.now() - 86_400_000) })
          .where(memoryWhere('infra', 'unreadable')),
      )
      await renameLore('infra://rename_in_lore', 'renamed_in_lore')
      await editLore('infra://broken_in_lore', '坏的占位符 {{cred:Bad Name}}')
      await dropLore('infra://gone_from_lore')
      await editLore('infra://change_in_lore', '再改一次的正文')

      const { sync } = await cli()
      const source = await fileSource()
      const plan = await planOf(source)
      // 命令行的原因引用那段坏占位符（打在主人自己的终端上），计划视图不含正文：只差这一处。看原始的响应
      const quoted = ' {{cred:Bad Name}}'
      expect(sync.items.find((i) => i.state === 'skipped')!.reason).toContain(quoted)
      expect(await (await post('plan', { source })).text()).not.toContain('Bad Name')
      const comparable = (items: LoreSyncItem[]) =>
        items
          .map(({ source, uri, state, target, reason, changes }) => ({
            source,
            uri,
            state,
            target,
            reason: reason?.replace(quoted, ''),
            changes,
          }))
          .sort((a, b) =>
            `${a.state} ${a.source} ${a.uri}`.localeCompare(`${b.state} ${b.source} ${b.uri}`),
          )
      expect(comparable(plan.sync.items)).toEqual(comparable(sync.items))
      expect([...plan.sync.goneFromLore].sort()).toEqual([...sync.goneFromLore].sort())
      // 每种状态确实都走到了
      const by = (state: string) =>
        plan.sync.items
          .filter((i) => i.state === state)
          .map((i) => i.uri)
          .sort()
      expect(by('update')).toEqual(['infra://change_in_lore'])
      expect(by('edited')).toEqual(['infra://edit_in_kioku'])
      expect(by('moved')).toEqual(['infra://rename_in_lore'])
      expect(by('deleted')).toEqual(['infra://delete_in_kioku'])
      expect(by('skipped')).toEqual(['infra://broken_in_lore'])
      expect(by('unmapped')).toEqual(['persona://old-persona/soul'])
      expect(by('unreadable')).toEqual(['infra://unreadable'])
      expect(plan.sync.goneFromLore).toEqual(['infra://gone_from_lore'])
      expect(by('current')).toContain('persona://default/soul')
      expect(by('current')).toContain('core://agent')
      expect(plan.nodes.flatMap((n) => n.targets).filter((t) => t.state === 'new')).toEqual([])
    })
  })

  describe('执行', () => {
    it('写入与命令行相同的记忆；事件 context 记下导出时间；排一次向量补齐', async () => {
      const source = await fileSource()
      const result = await importAll(source)
      expect(result.personaCreated).toBe(true)
      expect(result.appsCreated).toEqual(['claudecode'])
      expect(result.created.sort()).toEqual(
        [
          'app://claudecode/agent',
          'core://agent',
          'infra://nas',
          'infra://router/credentials',
          'persona://default/soul',
          'preferences://user',
        ].sort(),
      )
      expect(backfills).toBe(1)
      expect(await contentOf('infra://nas')).toBe('存储服务器的正文')
      const events = await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(memoryEvents),
      )
      expect(events.length).toBe(6)
      for (const event of events) {
        expect(event.eventType).toBe('import')
        expect(event.context).toMatchObject({ source: 'lore', loreExportedAt: EARLIER })
      }
      // 再执行一次：没有要写的，也排补齐（重试时不看这次新建了多少）
      const again = await importAll(source)
      expect(again.created).toEqual([])
      expect(again.previouslyImported).toHaveLength(6)
      expect(backfills).toBe(2)
    })

    it('标 secret 的加密存储；不导入的不写，导入过的就是这次不同步', async () => {
      const source = await fileSource()
      const plan = await planOf(source)
      const result = await applyOf(source, plan, {
        secretUris: ['infra://router/credentials', 'core://agent'],
        excludeUris: ['core://agent', 'preferences://user'],
      })
      expect(result.created).toContain('infra://router/credentials')
      expect(result.created).not.toContain('core://agent')
      expect(result.created).not.toContain('preferences://user')
      const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(memories).where(memoryWhere('infra', 'router/credentials')),
      )
      expect(row).toMatchObject({ sensitivity: 'secret', content: null })
      expect(await contentOf('infra://router/credentials')).toBe('路由器密码 hunter2')

      await editLore('infra://nas', 'Lore 里改过的正文')
      const newer = await fileSource(LATER)
      const next = await planOf(newer)
      expect(next.sync.items.find((i) => i.uri === 'infra://nas')!.state).toBe('update')
      // 这次不同步。不算 Lore 里没有了由 planSync 的用例保证：结果里不带同步状态，这里看不出来
      const synced = await applyOf(newer, next, { excludeUris: ['infra://nas', 'core://agent'] })
      expect(synced.sync.updated).toEqual([])
      expect(await contentOf('infra://nas')).toBe('存储服务器的正文')
      expect(synced.created).toEqual(['preferences://user'])
      // 勾选只管这一次：再看计划它还是要更新
      const after = await planOf(newer)
      expect(after.sync.items.find((i) => i.uri === 'infra://nas')!.state).toBe('update')
    })

    it('勾掉一个节点时，映射到同一个 URI、计划里不导入的节点不会写进去', async () => {
      // 按时间再按路径排，两个路径的先后不随时间精度变：先写的 open-claw 占着
      await seed('core://agent/open-claw', '第一个节点的正文')
      await seed('core://agent/open_claw', '第二个节点的正文')
      const source = await fileSource()
      const plan = await planOf(source)
      expect(nodeOf(plan, 'core://agent/open-claw').targets[0]!.uri).toBe('app://open-claw/agent')
      // 第二个节点没有写入目标，界面上勾不了
      expect(nodeOf(plan, 'core://agent/open_claw')).toBeUndefined()
      expect(plan.skipped).toContainEqual({
        source: 'core://agent/open_claw',
        reason: '和 core://agent/open-claw 映射到同一个 app://open-claw/agent',
      })

      const result = await applyOf(source, plan, { excludeUris: ['core://agent/open-claw'] })
      expect(result.created).not.toContain('app://open-claw/agent')
      expect(result.failed).toEqual([])
      const rows = await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(memories).where(memoryWhere('app', 'open-claw/agent')),
      )
      expect(rows).toEqual([])
    })

    it('disclosure 截断时切开代理对：存下来没有乱码，再看计划是最新的，不是每次都要更新', async () => {
      await seed('infra://emoji', '带表情的 disclosure', {
        disclosure: `${'长'.repeat(499)}😀后面的字`,
      })
      const source = await fileSource()
      const plan = await planOf(source)
      expect(plan.warnings).toContainEqual({ uri: 'infra://emoji', kind: 'disclosureTruncated' })
      const result = await applyOf(source, plan)
      expect(result.failed).toEqual([])
      expect(result.created).toContain('infra://emoji')
      expect((await service().get('infra://emoji')).disclosure).toBe('长'.repeat(499))
      const again = await planOf(source)
      expect(again.sync.items.find((i) => i.uri === 'infra://emoji')!.state).toBe('current')
    })

    it('同步写下 sync 事件，context 记下导出时间；secret 节点的 context 里没有正文', async () => {
      const source = await fileSource()
      await applyOf(source, await planOf(source), { secretUris: ['infra://router/credentials'] })
      await editLore('infra://nas', 'Lore 里改过的正文')
      await editLore('infra://router/credentials', '路由器密码 hunter3')
      const newer = await fileSource(LATER)
      const plan = await planOf(newer)
      expect(
        plan.sync.items
          .filter((i) => i.state === 'update')
          .map((i) => i.uri)
          .sort(),
      ).toEqual(['infra://nas', 'infra://router/credentials'])
      // 计划里只有要改什么，新正文不在里面。看原始的响应：解析时会丢掉契约里没有的字段
      const raw = await (await post('plan', { source: newer })).text()
      for (const body of ['Lore 里改过的正文', 'hunter3']) {
        expect(raw).not.toContain(body)
      }
      const result = await applyOf(newer, plan)
      expect(result.sync.updated.sort()).toEqual(['infra://nas', 'infra://router/credentials'])
      expect(await contentOf('infra://nas')).toBe('Lore 里改过的正文')
      expect(await contentOf('infra://router/credentials')).toBe('路由器密码 hunter3')
      const events = await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(memoryEvents).where(eq(memoryEvents.eventType, 'sync')),
      )
      expect(events).toHaveLength(2)
      for (const event of events) {
        expect(event.context).toMatchObject({ source: 'lore', loreExportedAt: LATER })
      }
      expect(JSON.stringify(events)).not.toContain('hunter')
    })

    it('要 secret 而没有主密钥时返回 400，人格、应用与记忆的行数都不变；计划里说明了', async () => {
      const source = await fileSource()
      const res = await post('plan', { source }, { on: noKeyApp })
      const plan = LoreImportPlan.parse(await res.json())
      expect(plan.secretAvailable).toBe(false)
      const before = await counts()
      const apply = await post(
        'apply',
        { source, fingerprint: plan.fingerprint, secretUris: ['infra://router/credentials'] },
        { on: noKeyApp },
      )
      expect(apply.status).toBe(400)
      expect(((await apply.json()) as { error: string }).error).toContain('主密钥')
      expect(await counts()).toEqual(before)
      expect(backfills).toBe(0)
      // 不标 secret 时不需要主密钥
      const plain = await post('apply', { source, fingerprint: plan.fingerprint }, { on: noKeyApp })
      expect(plain.status).toBe(200)
    })

    it('指定的 URI 对不上任何节点时返回 400，什么都不写：照常导入会把凭据写成明文', async () => {
      const source = await fileSource()
      const plan = await planOf(source)
      const before = await counts()
      for (const selection of [
        { secretUris: ['infra://router/credential'] },
        { excludeUris: ['infra://nope'] },
      ]) {
        const res = await post('apply', { source, fingerprint: plan.fingerprint, ...selection })
        expect(res.status).toBe(400)
        const { error } = (await res.json()) as { error: string }
        expect(error).toContain('在 Lore 里不存在')
        expect(error).not.toContain('--secret')
      }
      expect(await counts()).toEqual(before)
    })

    it('看过计划之后改了正文，返回 409，什么都不写', async () => {
      const source = await fileSource()
      const plan = await planOf(source)
      await editLore('infra://nas', '看过计划之后改的')
      const before = await counts()
      const res = await post('apply', { source: await fileSource(), fingerprint: plan.fingerprint })
      expect(res.status).toBe(409)
      expect(await counts()).toEqual(before)
      expect(backfills).toBe(0)
    })

    it('看过计划之后这边多了同类应用（写入目标变了）或记忆被改了（要更新的变了），都返回 409', async () => {
      await ws.createApp('claude-code', { runtimeFamily: 'claudecode' })
      const source = await fileSource()
      await importAll(source)
      await editLore('infra://nas', 'Lore 里改过的正文')
      const newer = await fileSource(LATER)
      const plan = await planOf(newer)
      await service().update({ uri: 'infra://nas', priority: 7 })
      const edited = await post('apply', { source: newer, fingerprint: plan.fingerprint })
      expect(edited.status).toBe(409)
      expect((await service().get('infra://nas')).priority).toBe(7)
      expect(await contentOf('infra://nas')).toBe('存储服务器的正文')

      const fresh = await planOf(newer)
      await ws.createApp('claude-two', { runtimeFamily: 'claudecode' })
      const added = await post('apply', { source: newer, fingerprint: fresh.fingerprint })
      expect(added.status).toBe(409)
    })

    it('换了人格的请求算不同的计划；指纹带回去也要同一个人格', async () => {
      const source = await fileSource()
      const plan = await planOf(source)
      const res = await post('apply', {
        source,
        fingerprint: plan.fingerprint,
        persona: { slug: 'work', name: '工作' },
      })
      expect(res.status).toBe(409)
    })

    describe('旧文件', () => {
      it('比已写入的数据旧、又有要写的：标出来，默认不写，确认后才写；同一份文件再执行不算旧', async () => {
        const old = await fileSource(EARLIER)
        await importAll(old)
        await editLore('infra://nas', '新的正文')
        const newer = await fileSource(LATER)
        expect((await planOf(newer)).staleSince).toBeNull()
        await importAll(newer)
        expect(await contentOf('infra://nas')).toBe('新的正文')

        // 同一份新文件再执行：不算旧，也没有要写的
        expect((await planOf(newer)).staleSince).toBeNull()

        const plan = await planOf(old)
        expect(plan.staleSince).toBe(LATER)
        expect(plan.sync.items.find((i) => i.uri === 'infra://nas')!.state).toBe('update')
        const before = await counts()
        const refused = await post('apply', { source: old, fingerprint: plan.fingerprint })
        expect(refused.status).toBe(409)
        expect(((await refused.json()) as { error: string }).error).toContain('旧')
        expect(await contentOf('infra://nas')).toBe('新的正文')
        expect(await counts()).toEqual(before)

        const confirmed = await applyOf(old, plan, { confirmStale: true })
        expect(confirmed.sync.updated).toEqual(['infra://nas'])
        expect(await contentOf('infra://nas')).toBe('存储服务器的正文')

        // 数据时间还是新文件的：确认过一次之后再传这份旧文件，要改回去的已经改完了，没有要写的就不提醒
        expect((await planOf(old)).staleSince).toBeNull()
        // 新文件再传一次就同步回来
        const back = await planOf(newer)
        expect(back.staleSince).toBeNull()
        await applyOf(newer, back)
        expect(await contentOf('infra://nas')).toBe('新的正文')
      })

      it('没有要写的就不算旧：不用确认，数据时间照样给出来', async () => {
        const old = await fileSource(EARLIER)
        await importAll(old)
        await seed('infra://later', '旧文件之后才有的节点')
        await importAll(await fileSource(LATER))
        const plan = await planOf(old)
        expect(plan.dataTime).toBe(LATER)
        expect(plan.staleSince).toBeNull()
        expect(plan.sync.goneFromLore).toEqual(['infra://later'])
        await applyOf(old, plan)
      })

      it('旧文件里多出已经不在 Lore 的节点，要新建的也算要写的', async () => {
        await seed('infra://will_go', '之后会删掉的节点')
        const old = await fileSource(EARLIER)
        await dropLore('infra://will_go')
        await importAll(await fileSource(LATER))
        const plan = await planOf(old)
        expect(stateOf(plan, 'infra://will_go')).toBe('new')
        expect(plan.staleSince).toBe(LATER)
        expect((await post('apply', { source: old, fingerprint: plan.fingerprint })).status).toBe(
          409,
        )
        // 勾掉要写的那一个就没有要写的了，不用确认
        await applyOf(old, plan, { excludeUris: ['infra://will_go'] })
      })

      it('命令行写下的事件没有导出时间，取事件时间：比它早的文件算旧，比它晚的不算', async () => {
        await cliApply()
        await editLore('infra://nas', 'Lore 里改过的正文')
        const stale = await planOf(await fileSource(EARLIER))
        expect(stale.staleSince).not.toBeNull()
        // 事件时间就是刚才
        expect(Date.now() - new Date(stale.staleSince!).getTime()).toBeLessThan(60_000)
        const soon = new Date(Date.now() + 3600_000).toISOString()
        expect((await planOf(await fileSource(soon))).staleSince).toBeNull()
      })

      it('拉取来源读的是现在的 Lore，不做这个判断', async () => {
        const url = await fakeLore(TOKEN, () => exportLore(lore, EARLIER))
        const remote = { kind: 'url', url, token: TOKEN } as const
        await importAll(await fileSource(LATER))
        await editLore('infra://nas', 'Lore 里改过的正文')
        const plan = await planOf(remote)
        expect(plan.staleSince).toBeNull()
        expect((await applyOf(remote, plan)).sync.updated).toEqual(['infra://nas'])
      })
    })

    describe('写到一半失败', () => {
      const reject = async (path: string, errcode: string) => {
        await database.db.execute(
          sql.raw(`create or replace function kioku_test_reject() returns trigger language plpgsql as $$
            begin
              if new.path = '${path}' then
                raise exception 'kioku test' using errcode = '${errcode}';
              end if;
              return new;
            end $$`),
        )
        await database.db.execute(
          sql.raw(`create trigger kioku_test_reject before insert or update on memories
            for each row execute function kioku_test_reject()`),
        )
      }
      const unreject = () =>
        database.db.execute(sql.raw('drop trigger if exists kioku_test_reject on memories'))
      afterEach(unreject)
      const eventsPerMemory = async () => {
        const rows = await withSpace(database.db, ws.spaceId, (tx) =>
          tx
            .select({ memoryId: memoryEvents.memoryId, n: sql<number>`count(*)`.mapWith(Number) })
            .from(memoryEvents)
            .groupBy(memoryEvents.memoryId),
        )
        return rows.map((r) => r.n)
      }

      it('22、23 类的数据错误只算这一条失败，别的照写；日志只记 SQLSTATE；同步也一样', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
          await reject('nas', '22023')
          const source = await fileSource()
          const plan = await planOf(source)
          const result = await applyOf(source, plan)
          expect(result.failed).toEqual([
            { uri: 'infra://nas', reason: expect.stringContaining('22023') as string },
          ])
          expect(result.created).toHaveLength(5)
          expect(backfills).toBe(1)
          expect(logged.mock.calls).toEqual([['写入 Lore 的节点时数据库报错', { code: '22023' }]])
          await unreject()

          // 重看计划：写进去的是已导入，失败的还是新建，同一份文件不用确认，确认后补上、不重复
          const again = await planOf(source)
          expect(again.staleSince).toBeNull()
          expect(stateOf(again, 'infra://nas')).toBe('new')
          expect(stateOf(again, 'core://agent')).toBe('imported')
          expect((await applyOf(source, again)).created).toEqual(['infra://nas'])
          expect(await eventsPerMemory()).toEqual(new Array(6).fill(1))

          // 同步写库时报错也只算这一条
          logged.mockClear()
          await editLore('infra://nas', 'Lore 里改过的正文')
          await editLore('core://agent', 'Lore 里改过的约束')
          await reject('nas', '23514')
          const newer = await fileSource(LATER)
          const synced = await applyOf(newer, await planOf(newer))
          expect(synced.sync.updated).toEqual(['core://agent'])
          expect(synced.sync.failed).toEqual([
            { uri: 'infra://nas', reason: expect.stringContaining('23514') as string },
          ])
          expect(logged.mock.calls).toEqual([['写入 Lore 的节点时数据库报错', { code: '23514' }]])
        } finally {
          logged.mockRestore()
        }
      })

      it('别的错误中止：返回 500、日志没有 SQL 与正文、照样排补齐；重看计划能接着做', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
          await reject('nas', 'P0001')
          const source = await fileSource()
          const plan = await planOf(source)
          const res = await post('apply', { source, fingerprint: plan.fingerprint })
          expect(res.status).toBe(500)
          expect(((await res.json()) as { error: string }).error).toContain('可能已写入一部分')
          expect(backfills).toBe(1)
          const text = JSON.stringify(logged.mock.calls)
          expect(logged).toHaveBeenCalledTimes(1)
          expect(logged.mock.calls[0]).toEqual(['从 Lore 导入时出错', { code: 'P0001' }])
          expect(text).not.toContain('存储服务器的正文')
          expect(text).not.toContain('insert')
          await unreject()

          // 写到 nas 之前的已导入，后面的还没写；指纹变了，旧指纹不能重试
          const again = await planOf(source)
          expect(again.staleSince).toBeNull()
          expect(again.fingerprint).not.toBe(plan.fingerprint)
          expect(stateOf(again, 'core://agent')).toBe('imported')
          expect(stateOf(again, 'infra://nas')).toBe('new')
          const stale = await post('apply', { source, fingerprint: plan.fingerprint })
          expect(stale.status).toBe(409)
          const result = await applyOf(source, again)
          expect(result.failed).toEqual([])
          expect(result.created).toContain('infra://nas')
          expect(await contentOf('infra://nas')).toBe('存储服务器的正文')
          expect(await eventsPerMemory()).toEqual(new Array(6).fill(1))
        } finally {
          logged.mockRestore()
        }
      })
    })

    it('/apply 占导出导入的名额，满了返回 429；/plan 与拉取不占', async () => {
      const url = await fakeLore(TOKEN, () => exportLore(lore, EARLIER))
      const source = await fileSource()
      const plan = await planOf(source)
      const release = await acquireTransferSlot(ws.accountId)
      try {
        const res = await post('apply', { source, fingerprint: plan.fingerprint })
        expect(res.status).toBe(429)
        expect(((await res.json()) as { error: string }).error).toBe(TRANSFER_BUSY)
        expect((await post('plan', { source })).status).toBe(200)
        expect((await post('plan', { source: { kind: 'url', url, token: TOKEN } })).status).toBe(
          200,
        )
      } finally {
        release()
      }
      expect(await counts()).toMatchObject({ memories: 0 })
    })

    it('两次执行不交错：第一次写入时第二次排队，轮到时看得到写下的，计划变了返回 409', async () => {
      const source = await fileSource()
      const plan = await planOf(source)
      const second = await addMember(database.db, ws.spaceId, 'second', 'owner')
      const secondPlan = LoreImportPlan.parse(
        await (await post('plan', { source }, { cookie: second.cookie })).json(),
      )
      // 另开连接挡住写人格：第一次执行占着名额停在写入阶段
      const blocker = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
      let unlock!: () => void
      const held = new Promise<void>((resolve) => (unlock = resolve))
      let locked!: () => void
      const lockTaken = new Promise<void>((resolve) => (locked = resolve))
      const holding = blocker.begin(async (tx) => {
        await tx`lock table personas in share mode`
        locked()
        await held
      })
      try {
        await lockTaken
        const first = post('apply', { source, fingerprint: plan.fingerprint })
        await vi.waitFor(
          async () => {
            const [row] = await blocker<{ n: number }[]>`
              select count(*)::int as n from pg_stat_activity
              where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`
            expect(row!.n).toBe(1)
          },
          { timeout: 3_000, interval: 20 },
        )
        const next = post(
          'apply',
          { source, fingerprint: secondPlan.fingerprint },
          { cookie: second.cookie },
        )
        await vi.waitFor(() => expect(queuedTransfers()).toBe(1), { timeout: 3_000, interval: 20 })
        // 同一个账号再来一次不排队，直接 429
        const again = await post('apply', { source, fingerprint: plan.fingerprint })
        expect(again.status).toBe(429)
        expect(await counts()).toMatchObject({ memories: 0 })
        unlock()
        expect((await first).status).toBe(200)
        expect((await next).status).toBe(409)
      } finally {
        unlock()
        await holding
        await blocker.end()
      }
      expect(await counts()).toMatchObject({ memories: 6, events: 6 })
    })
  })

  describe('从地址拉取', () => {
    it('读完整的导出，计划与执行都重新拉一次；结果和上传文件相同', async () => {
      let pulls = 0
      const url = await fakeLore(TOKEN, () => {
        pulls++
        return exportLore(lore, new Date().toISOString())
      })
      const remote = { kind: 'url', url, token: TOKEN } as const
      const plan = await planOf(remote)
      expect(pulls).toBe(1)
      expect(plan.fingerprint).toBe((await planOf(await fileSource())).fingerprint)
      const result = await applyOf(remote, plan)
      expect(pulls).toBe(2)
      expect(result.created).toHaveLength(6)
      expect(await contentOf('core://agent')).toBe('工作流约束的正文')
      const [event] = await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(memoryEvents).limit(1),
      )
      expect(event!.context).toHaveProperty('loreExportedAt')
    })

    it('拉取之间 Lore 变了就 409', async () => {
      const url = await fakeLore(TOKEN, () => exportLore(lore, new Date().toISOString()))
      const remote = { kind: 'url', url, token: TOKEN } as const
      const plan = await planOf(remote)
      await editLore('infra://nas', '看过计划之后改的')
      const res = await post('apply', { source: remote, fingerprint: plan.fingerprint })
      expect(res.status).toBe(409)
      expect(await counts()).toMatchObject({ memories: 0 })
    })

    it('Token 与地址不进库、不进日志；地址里带账号密码的直接拒绝；连不上时只记主机', async () => {
      const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => {}),
      )
      try {
        const url = await fakeLore(TOKEN, () => exportLore(lore, EARLIER))
        const remote = { kind: 'url', url, token: TOKEN } as const
        await applyOf(remote, await planOf(remote))

        const withUserInfo = url.replace('http://', `http://user:${TOKEN}@`)
        const rejected = await post('plan', {
          source: { kind: 'url', url: withUserInfo, token: '' },
        })
        expect(rejected.status).toBe(400)
        const { error } = (await rejected.json()) as { error: string }
        expect(error).toContain('账号密码')
        expect(error).not.toContain(TOKEN)

        const refused = await post('plan', {
          source: { kind: 'url', url: 'http://127.0.0.1:9/lore', token: TOKEN },
        })
        expect(refused.status).toBe(400)

        const denied = await post('plan', { source: { kind: 'url', url, token: 'wrong-token' } })
        expect(denied.status).toBe(400)
        expect(((await denied.json()) as { error: string }).error).toContain('Token')

        const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
        expect(logged).not.toContain(TOKEN)
        expect(logged).not.toContain('wrong-token')
        expect(logged).not.toContain('user:')
        expect(logged).toContain('127.0.0.1:9')

        const stored = await database.db.execute(
          sql`select (select coalesce(json_agg(e), '[]') from memory_events e)::text as events,
                     (select coalesce(json_agg(s), '[]') from settings s)::text as settings`,
        )
        const dump = JSON.stringify(stored)
        expect(dump).not.toContain(TOKEN)
        expect(dump).not.toContain(url)
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
    })
  })
})
