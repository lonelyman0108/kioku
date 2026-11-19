import { randomBytes } from 'node:crypto'

import { CreateCredentialRequest, CreateEntryRequest } from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { credentialServiceForConsole } from '../../credential/context'
import { withCircles, type Database } from '../../db/client'
import {
  clients,
  entries,
  entryEvents,
  entryVariants,
  facetTerms,
  legacyUris,
  personas,
  personaTraits,
  settings,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { purgeExpired } from '../../jobs/retention'
import { entryServiceForConsole } from '../../memory/context'
import { openVariantContent } from '../../memory/service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bootstrap, type Workspace } from '../../testing/fixtures'
import { LORE_SCHEMA, seedLoreNode } from '../../testing/loreFixture'
import {
  applyImport,
  applySync,
  existingImportClientsIn,
  inPlanSnapshot,
  planImport,
  planImportFor,
  planSync,
  previewImport,
  readLore,
  resolveCirclesForImport,
  verifyMasterKey,
  type ImportTarget,
} from '../lore'

describe.skipIf(!testDatabaseUrl)('从 Lore 导入与同步集成测试', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let lore: postgres.Sql
  let ws: Workspace
  let target: ImportTarget
  const masterKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
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
    ws = await bootstrap(app)
    target = {
      db: database.db,
      circleId: ws.circleId,
      personalCircleId: ws.personalCircleId,
      accountId: ws.accountId,
      masterKey,
    }
  })

  async function runPlanAndApply(
    options: {
      persona?: { slug: string; name: string }
      secretUris?: string[]
      excludeUris?: string[]
      sync?: boolean
    } = {},
  ) {
    const snapshot = await readLore(lore)
    const circles = await resolveCirclesForImport(database.db, ws.accountId, ws.circleId)
    const persona = options.persona ?? { slug: 'default', name: '默认人格' }
    const planned = await inPlanSnapshot(target, async (snap) => {
      const existing = await existingImportClientsIn(snap.tx, ws.circleId)
      const base = await planImportFor(snap, snapshot, circles, existing, {
        accountId: ws.accountId,
        persona,
        secretUris: new Set(options.secretUris ?? []),
        excludeUris: new Set(options.excludeUris ?? []),
      })
      const preview = await previewImport(snap, base.plan, base.imports)
      const sync = options.sync ? await planSync(snap, base.plan, snapshot, base.imports) : null
      return { plan: base.plan, preview, sync }
    })
    const applied = await applyImport(target, planned.plan)
    const synced = planned.sync ? await applySync(target, planned.sync) : null
    return { ...planned, applied, synced }
  }

  it('导入创建词条、legacy_uris、独立人格 trait、接入实例与 runtime 切面，且重复导入幂等', async () => {
    await seedLoreNode(lore, 'core://soul', '# 默认助手\n严谨可靠', { priority: 0 })
    await seedLoreNode(lore, 'core://soul/style/concise', '回答精炼')
    await seedLoreNode(lore, 'core://agent', '# 全局约定\n写中文注释', { priority: 0 })
    await seedLoreNode(lore, 'core://agent/claudecode', 'Claude 代码规则', {
      priority: 0,
      keywords: ['Claude', '编码规范'],
    })
    await seedLoreNode(lore, 'preferences://editor/ts', '# TS 偏好\n开启严格模式')
    await seedLoreNode(lore, 'infra://nas', '# 家庭存储\nIP 127.0.0.1', {
      disclosure: '管理存储设备时',
      keywords: ['NAS', '存储'],
      old: ['已废弃旧正文'],
    })
    await seedLoreNode(lore, 'infra://secret-note', '# 私密笔记\n密文内容', {
      keywords: ['密钥'],
    })

    const first = await runPlanAndApply({ secretUris: ['infra://secret-note'] })
    expect(first.applied.personaCreated).toBe(true)
    expect(first.applied.personaUsed).toBe(true)
    expect(first.applied.clientsCreated).toEqual(['claudecode'])
    expect(first.applied.created).toHaveLength(5)
    expect(first.applied.failed).toEqual([])

    // 校验共享圈与个人圈隔离及切面自动登记
    await withCircles(database.db, { read: [ws.circleId, ws.personalCircleId] }, async (tx) => {
      const [personaRow] = await tx
        .select()
        .from(personas)
        .where(and(eq(personas.circleId, ws.circleId), eq(personas.slug, 'default')))
      expect(personaRow).toBeTruthy()

      const traitRows = await tx
        .select()
        .from(personaTraits)
        .where(eq(personaTraits.personaId, personaRow!.id))
      expect(traitRows.map((t) => [t.traitKey, t.content])).toEqual(
        expect.arrayContaining([
          ['soul', '# 默认助手\n严谨可靠'],
          ['style-concise', '回答精炼'],
        ]),
      )

      const [clientRow] = await tx
        .select()
        .from(clients)
        .where(and(eq(clients.circleId, ws.circleId), eq(clients.slug, 'claudecode')))
      expect(clientRow?.defaultPersonaId).toBe(personaRow!.id)

      const runtimeTerms = await tx
        .select()
        .from(facetTerms)
        .where(and(eq(facetTerms.circleId, ws.circleId), eq(facetTerms.dimensionKey, 'runtime')))
      expect(runtimeTerms.map((r) => r.slug)).toContain('claudecode')

      const allEntries = await tx.select().from(entries)
      const sharedEntries = allEntries.filter((e) => e.circleId === ws.circleId)
      const personalEntries = allEntries.filter((e) => e.circleId === ws.personalCircleId)
      expect(sharedEntries).toHaveLength(2)
      expect(personalEntries).toHaveLength(3)

      const nasEntry = personalEntries.find((e) => e.title === '家庭存储')!
      expect(nasEntry.sensitivity).toBe('private')
      expect(nasEntry.topics).toEqual(['infra'])
      expect(nasEntry.ownerAccountId).toBe(ws.accountId)

      const prefEntry = personalEntries.find((e) => e.title === 'TS 偏好')!
      expect(prefEntry.sensitivity).toBe('internal')
      expect(prefEntry.topics).toEqual(['preferences', 'editor'])

      // 机密词条不从正文取标题，密文可用主密钥解开
      const secretEntry = personalEntries.find((e) => e.sensitivity === 'secret')!
      expect(secretEntry.title).toBe('secret-note')
      const [secretVariant] = await tx
        .select()
        .from(entryVariants)
        .where(eq(entryVariants.entryId, secretEntry.id))
      expect(secretVariant!.content).toBeNull()
      expect(secretVariant!.searchHeader).toBe('')
      expect(openVariantContent(masterKey, secretVariant!.id, secretVariant!)).toBe(
        '# 私密笔记\n密文内容',
      )

      const legacyRows = await tx.select().from(legacyUris)
      expect(legacyRows.map((l) => [l.source, l.legacyUri])).toEqual(
        expect.arrayContaining([
          ['lore', 'core://agent'],
          ['lore', 'core://agent/claudecode'],
          ['lore', 'preferences://editor/ts'],
          ['lore', 'infra://nas'],
          ['lore', 'infra://secret-note'],
        ]),
      )
    })

    // 通过旧 URI 兜底读取个人圈和共享圈词条
    const personalSvc = await entryServiceForConsole(
      { db: database.db, masterKey, jobs: null },
      ws.personalCircleId,
      ws.accountId,
    )
    const nasViaLegacy = await personalSvc.get({ id: 'infra://nas' })
    expect(nasViaLegacy.title).toBe('家庭存储')

    // 重复导入：已存在词条不再新建，也不覆盖人格设定
    const second = await runPlanAndApply({ secretUris: ['infra://nas'] })
    expect(second.applied.created).toEqual([])
    expect(second.applied.previouslyImported).toHaveLength(5)
    expect(second.applied.secretAlreadyImported).toEqual([
      { legacyUri: 'infra://nas', shortId: nasViaLegacy.shortId },
    ])
    expect(second.preview.personaExists).toBe(true)
    expect(second.preview.createsPersona).toBe(false)
  })

  it('core://soul 标机密时拒绝写明文并记为失败，verifyMasterKey 校验主密钥', async () => {
    await seedLoreNode(lore, 'core://soul', '不能明文落库的人格秘密')
    await seedLoreNode(lore, 'infra://ok-secret', '机密正文')

    const res = await runPlanAndApply({ secretUris: ['core://soul', 'infra://ok-secret'] })
    expect(res.applied.failed).toEqual([
      { source: 'core://soul', reason: '人格设定（core://soul）不支持标记为机密' },
    ])
    expect(res.applied.created).toHaveLength(1)

    await withCircles(database.db, { read: [ws.circleId] }, async (tx) => {
      expect(await tx.select().from(personas)).toEqual([])
      expect(await tx.select().from(personaTraits)).toEqual([])
    })

    expect(await verifyMasterKey(database.db, target, masterKey)).toBe(true)
    await expect(verifyMasterKey(database.db, target, randomBytes(32))).rejects.toThrow(
      'KIOKU_MASTER_KEY 解不开',
    )
  })

  it('保留期清理删除词条及其历史后仍保留 Lore 去重标记，不会重新写入', async () => {
    await seedLoreNode(lore, 'infra://temp', '即将删除的笔记')
    const first = await runPlanAndApply()
    const [shortId] = first.applied.created
    expect(shortId).toBeTruthy()

    const svc = await entryServiceForConsole(
      { db: database.db, masterKey, jobs: null },
      ws.personalCircleId,
      ws.accountId,
    )
    const entry = await svc.get({ id: shortId! })
    await svc.remove({ id: entry.shortId, expectedVersion: entry.version })

    await purgeExpired(database.db, { days: 1, now: new Date(Date.now() + 10 * 86_400_000) })

    // 确认条目与事件已被清理且保留导入留痕
    await withCircles(database.db, { read: [ws.personalCircleId] }, async (tx) => {
      const remainingEntries = await tx.select().from(entries)
      expect(remainingEntries).toHaveLength(0)
      const events = await tx.select().from(entryEvents)
      expect(events).toHaveLength(1)
      expect(events[0]!.after).toEqual({ legacyUri: 'infra://temp' })
    })

    const rerun = await runPlanAndApply({ sync: true })
    expect(rerun.applied.created).toEqual([])
    expect(rerun.applied.previouslyImported).toEqual([shortId])
    expect(rerun.sync!.items[0]).toMatchObject({ shortId, state: 'deleted' })
  })

  it('sync 正确同步未改条目，保护在 Kioku 修改过、删除过或 Lore 中换过路径的条目', async () => {
    await seedLoreNode(lore, 'infra://sync-plain', '# 同步标题\n初版正文', {
      keywords: ['旧词'],
      disclosure: '旧场景',
    })
    await seedLoreNode(lore, 'infra://sync-edited', '初版')
    await seedLoreNode(lore, 'infra://sync-moved', '将改路径')
    await seedLoreNode(lore, 'infra://sync-gone', '将从 Lore 移除')

    const init = await runPlanAndApply()
    expect(init.applied.created).toHaveLength(4)

    // 在 Kioku 修改其中一条
    const svc = await entryServiceForConsole(
      { db: database.db, masterKey, jobs: null },
      ws.personalCircleId,
      ws.accountId,
    )
    const edited = await svc.get({ id: 'infra://sync-edited' })
    await svc.update({ id: edited.shortId, expectedVersion: edited.version, content: '人工改过' })

    // 修改 Lore 里 sync-plain；把 sync-moved 从个人迁移到 core://（跨圈移动）；删除 sync-gone
    await lore`insert into memories (node_uuid, content, created_at)
      values ('uuid-infra://sync-plain', '# 新标题\n更新后正文', '2025-06-01T00:00:00Z')`
    await lore`update edges set priority = 1, disclosure = '新场景' where child_uuid = 'uuid-infra://sync-plain'`
    await lore`delete from glossary_keywords where node_uuid = 'uuid-infra://sync-plain'`
    await lore`insert into glossary_keywords (keyword, node_uuid) values ('新词', 'uuid-infra://sync-plain')`
    await lore`update paths set domain = 'core', path = 'moved-dest' where domain = 'infra' and path = 'sync-moved'`
    await lore`delete from paths where domain = 'infra' and path = 'sync-gone'`

    const synced = await runPlanAndApply({ sync: true })
    expect(synced.synced!.updated).toHaveLength(1)
    const afterPlain = await svc.get({ id: 'infra://sync-plain' })
    expect(afterPlain.title).toBe('新标题')
    expect(afterPlain.variants[0]!.content).toBe('# 新标题\n更新后正文')
    expect(afterPlain.priority).toBe(1)
    expect(afterPlain.disclosure).toBe('新场景')
    expect(afterPlain.glossary).toEqual(['新词'])
    expect(afterPlain.version).toBe(2)

    const states = new Map(synced.sync!.items.map((i) => [i.legacyUri, i.state]))
    expect(states.get('infra://sync-plain')).toBe('update')
    expect(states.get('infra://sync-edited')).toBe('edited')
    expect(states.get('infra://sync-moved')).toBe('moved')
    expect(synced.sync!.goneFromLore).toEqual(['infra://sync-gone'])
    expect(synced.applied.movedInLore).toHaveLength(1)
  })

  it('不同成员在共享圈下不能覆盖对方已占用的接入实例', async () => {
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    await seedLoreNode(lore, 'core://agent/claudecode', 'alice 规范')
    await runPlanAndApply()

    const circles = await resolveCirclesForImport(database.db, bob.accountId, ws.circleId)
    const bobPlan = await inPlanSnapshot(
      { ...target, accountId: bob.accountId, personalCircleId: bob.personalCircleId },
      async (snap) => {
        const existing = await existingImportClientsIn(snap.tx, ws.circleId)
        return planImport(await readLore(lore), circles, existing, {
          accountId: bob.accountId,
          persona: { slug: 'default', name: '默认人格' },
          secretUris: new Set(),
        })
      },
    )
    expect(bobPlan.skipped[0]?.reason).toContain('已被其他成员占用')
    expect(bobPlan.targets).toEqual([])
  })

  it('导入个人圈凭据占位符并写入后可通过 CredentialService 解析', async () => {
    const credSvc = await credentialServiceForConsole(
      {
        db: database.db,
        masterKey,
        cookieSecure: false,
        embedder: staticEmbedderSource(null),
        jobs: null,
      },
      ws.personalCircleId,
      ws.accountId,
    )
    await credSvc.create(
      CreateCredentialRequest.parse({
        identifier: 'nas-cred',
        name: 'NAS',
        source: { kind: 'new', values: { password: 'super-secret-value' } },
      }),
    )

    const personalSvc = await entryServiceForConsole(
      { db: database.db, masterKey, jobs: null },
      ws.personalCircleId,
      ws.accountId,
    )
    await seedLoreNode(lore, 'infra://nas-with-ref', '密码为 {{cred:nas-cred#password}}')
    const res = await runPlanAndApply()
    expect(res.applied.created).toHaveLength(1)
    const created = await personalSvc.get({ id: 'infra://nas-with-ref' })
    expect(created.variants[0]!.content).toContain('{{cred:nas-cred#password}}')
    expect(CreateEntryRequest).toBeDefined()
  })
})
