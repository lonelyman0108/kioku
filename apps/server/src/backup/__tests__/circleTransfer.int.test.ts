import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addMember,
  createPersonalCircle,
  createSharedCircle,
  removeMember,
} from '../../access/circles'
import { createClient } from '../../access/clients'
import { credentialServiceForConsole } from '../../credential/context'
import { openCredentialValues } from '../../credential/service'
import { databaseNow, withCircle, type Database, type Db } from '../../db/client'
import {
  accounts,
  circleDepartures,
  clientGroupRules,
  conversations,
  credentials,
  entries,
  entryEvents,
  entryVariants,
  facetDimensions,
  facetTerms,
  legacyUris,
  personas,
  personaTraits,
  settings,
  subjects,
  subjectIdentities,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps } from '../../http/env'
import { endPause, retentionJob, saveRetentionDays } from '../../jobs/retention'
import { entryServiceForConsole } from '../../memory/entryContext'
import { openVariantContent } from '../../memory/service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { exportCircle } from '../circleExport'
import { importCircle, inspectCircleImport } from '../circleImport'
import { createBackup } from '../export'
import { restoreBackup } from '../restore'

const FAST_KDF = { logN: 14, r: 8, p: 1 }
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../migrations', import.meta.url))

function makeDeps(db: Db, masterKey: Buffer): Deps {
  return {
    db,
    cookieSecure: false,
    masterKey,
    embedder: staticEmbedderSource(null),
    jobs: null,
  }
}

async function seedAccount(db: Db, username: string) {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({ username, displayName: username, passwordHash: 'hash' })
      .returning()
    const personal = await createPersonalCircle(tx, account!)
    return { account: account!, personal }
  })
}

async function bufferFromBackup(db: Db, masterKey: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = []
  const out = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  })
  await createBackup(db, masterKey, out)
  return Buffer.concat(chunks)
}

describe.skipIf(!testDatabaseUrl)('按圈导出导入（KIOKUCX2）、全实例备份恢复与保留期清理', () => {
  let database: Database
  const sourceKey = randomBytes(32)
  const targetKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await database.close()
  })

  it('按圈导出再导入到不同主密钥实例：处理 shortId 碰撞重写双链、重封机密与凭据，并支持个人圈合并导入', async () => {
    const { account: alice, personal: alicePersonal } = await seedAccount(database.db, 'alice')
    const { account: bob, personal: bobPersonal } = await seedAccount(database.db, 'bob')

    const teamRes = await createSharedCircle(database.db, {
      name: '研发共享圈',
      defaultFacets: { realm: ['work'] },
      ownerAccountId: alice.id,
    })
    if (!teamRes.ok) throw new Error('建共享圈失败')
    const teamId = teamRes.value.id

    const srcDeps = makeDeps(database.db, sourceKey)
    const consoleTeam = await entryServiceForConsole(srcDeps, teamId, alice.id)

    const targetEntry = await consoleTeam.create({
      title: '架构总览',
      variants: [
        { when: { env: ['mac'] }, content: 'Mac 部署流程。', sortOrder: 0 },
        { when: { env: ['linux'] }, content: 'Linux 部署流程。', sortOrder: 1 },
      ],
      topics: ['arch'],
      glossary: ['部署流程'],
    })

    const sourceEntry = await consoleTeam.create({
      title: '服务清单',
      content: `主服务架构见 [[${targetEntry.shortId}|架构图]]。`,
    })

    const secretEntry = await consoleTeam.create({
      title: '生产机密',
      content: 'secret vault root key',
      when: { realm: ['work'] },
      sensitivity: 'secret',
    })

    await withCircle(database.db, teamId, async (tx) => {
      const [p] = await tx
        .insert(personas)
        .values({ circleId: teamId, slug: 'dev-bot', name: '研发助手' })
        .returning()
      await tx.insert(personaTraits).values({
        circleId: teamId,
        personaId: p!.id,
        traitKey: 'tone',
        title: '语气',
        content: '严谨直接。',
        sortOrder: 0,
      })
      const [grp] = await tx
        .insert(subjects)
        .values({ circleId: teamId, kind: 'group', displayName: '研发群' })
        .returning()
      await tx.insert(subjectIdentities).values({
        circleId: teamId,
        subjectId: grp!.id,
        kind: 'group',
        platform: 'slack',
        externalId: 'C123',
        displayName: '研发群',
      })
      const cRes = await createClient(tx, {
        circleId: teamId,
        ownerAccountId: alice.id,
        slug: 'ci-bot',
        name: 'CI 助手',
        runtimeFamily: 'claudecode',
        defaultPersonaId: p!.id,
      })
      if (!cRes.ok) throw new Error('建实例失败')
      await tx.insert(clientGroupRules).values({
        circleId: teamId,
        clientId: cRes.client.id,
        groupSubjectId: grp!.id,
        personaId: p!.id,
        isolateGroupMemory: true,
      })
      await tx.insert(facetDimensions).values({
        circleId: teamId,
        key: 'stack',
        name: '技术栈',
        matchMode: 'additive',
      })
      await tx.insert(facetTerms).values({
        circleId: teamId,
        dimensionKey: 'stack',
        slug: 'ts',
        label: 'TypeScript',
      })
      await tx.insert(legacyUris).values({
        circleId: teamId,
        entryId: targetEntry.id,
        legacyUri: 'core://arch/overview',
        source: 'kioku-legacy',
      })
    })

    const aliceCreds = await credentialServiceForConsole(srcDeps, teamId, alice.id)
    await aliceCreds.create({
      identifier: 'deploy-secret',
      name: '部署凭据',
      source: { kind: 'new', values: { token: 'deploy-tok-xyz' } },
      allowedRealms: ['work'],
    })

    // 导出共享圈
    const exported = await exportCircle(srcDeps, teamId, alice.id, 'export-pass-9999', FAST_KDF)
    expect(exported.counts.entries).toBe(3)
    expect(exported.counts.variants).toBe(4)
    expect(exported.counts.secrets).toBe(1)
    expect(exported.counts.credentials).toBe(1)

    const preview = await inspectCircleImport(exported.buffer, 'export-pass-9999')
    expect(preview.circleKind).toBe('shared')
    expect(preview.counts.entries).toBe(3)

    // 模拟仅 targetEntry.shortId 在本实例被另一条已软删除记录占用，测试碰撞重分配与双链重写
    await withCircle(database.db, teamId, (tx) =>
      tx.delete(entries).where(eq(entries.circleId, teamId)),
    )
    const [collisionDummy] = await withCircle(database.db, bobPersonal.id, (tx) =>
      tx
        .insert(entries)
        .values({
          circleId: bobPersonal.id,
          shortId: targetEntry.shortId,
          circleKind: 'personal',
          kind: 'entry',
          ownerAccountId: bob.id,
          provenance: 'owner',
          originScope: 'global',
          title: '占位已软删除条目',
          sensitivity: 'private',
          priority: 2,
          deletedAt: new Date(),
        })
        .returning(),
    )
    expect(collisionDummy!.shortId).toBe(targetEntry.shortId)

    // 导入到 Bob 名下并换用另一把主密钥
    const dstDeps = makeDeps(database.db, targetKey)
    const imported = await importCircle(dstDeps, bob.id, {
      file: exported.buffer,
      passphrase: 'export-pass-9999',
      name: '迁移后的研发圈',
    })
    expect(imported.circleKind).toBe('shared')
    expect(imported.remappedShortIds).toHaveLength(1)
    expect(imported.remappedShortIds[0]?.from).toBe(targetEntry.shortId)
    const remappedTarget = imported.remappedShortIds[0]!.to
    expect(remappedTarget).not.toBe(targetEntry.shortId)

    // 校验导入后内容：双链与正文同步重写，非碰撞 ID 保持原值，新主密钥能解开机密变体与托管凭据
    const consoleImported = await entryServiceForConsole(dstDeps, imported.circleId, bob.id)
    const importedSource = await consoleImported.get({ id: sourceEntry.shortId })
    expect(importedSource.shortId).toBe(sourceEntry.shortId)
    expect(importedSource.variants[0]?.content).toContain(`[[${remappedTarget}|架构图]]`)
    expect(importedSource.links[0]?.shortId).toBe(remappedTarget)

    const revealedSecret = await consoleImported.reveal(
      (await consoleImported.get({ id: secretEntry.shortId })).id,
    )
    expect(revealedSecret.variants[0]?.content).toBe('secret vault root key')

    const vSec = await withCircle(database.db, imported.circleId, (tx) =>
      tx.select().from(entryVariants).where(eq(entryVariants.entryId, revealedSecret.id)).limit(1),
    )
    expect(openVariantContent(targetKey, vSec[0]!.id, vSec[0]!)).toBe('secret vault root key')

    const bobCredRow = await withCircle(database.db, imported.circleId, (tx) =>
      tx.select().from(credentials).where(eq(credentials.identifier, 'deploy-secret')).limit(1),
    )
    expect(
      openCredentialValues(targetKey, {
        id: bobCredRow[0]!.id,
        ciphertext: bobCredRow[0]!.ciphertext!,
        wrappedKey: bobCredRow[0]!.wrappedKey!,
        keyId: bobCredRow[0]!.keyId,
      }),
    ).toEqual({ token: 'deploy-tok-xyz' })

    // 个人圈导出再合并导入进目标账号已有个人圈
    const alicePersonalSvc = await entryServiceForConsole(srcDeps, alicePersonal.id, alice.id)
    const personalNote = await alicePersonalSvc.create({
      title: '个人备份项',
      content: 'personal content line',
    })
    const exportedPersonal = await exportCircle(
      srcDeps,
      alicePersonal.id,
      alice.id,
      'personal-pass-1234',
      FAST_KDF,
    )
    const mergedResult = await importCircle(dstDeps, bob.id, {
      file: exportedPersonal.buffer,
      passphrase: 'personal-pass-1234',
      intoPersonalCircle: true,
    })
    expect(mergedResult.circleId).toBe(bobPersonal.id)
    const bobPersonalSvc = await entryServiceForConsole(dstDeps, bobPersonal.id, bob.id)
    expect((await bobPersonalSvc.get({ id: personalNote.title })).variants[0]?.content).toBe(
      'personal content line',
    )
  })

  it('支持全实例备份恢复往返与保留期硬清理（deletedEntries、supersededFacts、expiredEpisodes、departedMembers）', async () => {
    const { account: alice } = await seedAccount(database.db, 'alice')
    const { account: bob } = await seedAccount(database.db, 'bob')

    const teamRes = await createSharedCircle(database.db, {
      name: '工作圈',
      defaultFacets: { realm: ['work'] },
      ownerAccountId: alice.id,
    })
    if (!teamRes.ok) throw new Error('建圈失败')
    const teamId = teamRes.value.id
    await addMember(database.db, {
      circleId: teamId,
      actor: alice.id,
      username: 'bob',
      role: 'editor',
    })

    const deps = makeDeps(database.db, sourceKey)
    const consoleTeam = await entryServiceForConsole(deps, teamId, alice.id)
    const keepEntry = await consoleTeam.create({
      title: '持久词条',
      variants: [
        { when: { env: ['mac'] }, content: 'mac rule', sortOrder: 0 },
        { when: { env: ['win'] }, content: 'win rule', sortOrder: 1 },
      ],
    })
    const softDelEntry = await consoleTeam.create({ title: '已过期删除项', content: 'to purge' })
    await consoleTeam.remove({ id: softDelEntry.shortId })

    // 1. 构造保留期待清理数据：超龄软删除、被取代事实、过期摘要、以及满 30 天离圈成员快照
    const now = await databaseNow(database.db)
    const oldTime = new Date(now.getTime() - 45 * 86_400_000)

    await withCircle(database.db, teamId, async (tx) => {
      await tx.update(entries).set({ deletedAt: oldTime }).where(eq(entries.id, softDelEntry.id))
      const [sub] = await tx
        .insert(subjects)
        .values({ circleId: teamId, kind: 'person', displayName: '王五' })
        .returning()
      const [oldFact] = await tx
        .insert(entries)
        .values({
          circleId: teamId,
          shortId: 'm-334455',
          circleKind: 'shared',
          kind: 'fact',
          subjectId: sub!.id,
          subjectKind: 'person',
          provenance: 'agent',
          originScope: `group:${sub!.id}`,
          title: '旧事实',
          sensitivity: 'internal',
          priority: 2,
          validTo: oldTime,
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId: teamId,
        entryId: oldFact!.id,
        kind: 'fact',
        sensitivity: 'internal',
        when: {},
        whenSignature: '{}',
        sortOrder: 0,
        content: 'superseded fact',
        searchHeader: '旧事实',
      })
      const cRes = await createClient(tx, {
        circleId: teamId,
        ownerAccountId: alice.id,
        slug: 'ep-bot',
        name: '摘要助手',
        runtimeFamily: 'claudecode',
      })
      if (!cRes.ok) throw new Error('建实例失败')
      const [conv] = await tx
        .insert(conversations)
        .values({ circleId: teamId, clientId: cRes.client.id, kind: 'direct', subjectId: sub!.id })
        .returning()
      const [oldEp] = await tx
        .insert(entries)
        .values({
          circleId: teamId,
          shortId: 'm-334456',
          circleKind: 'shared',
          kind: 'episode',
          conversationId: conv!.id,
          provenance: 'agent',
          originScope: `direct:${sub!.id}`,
          title: '旧摘要',
          sensitivity: 'internal',
          priority: 2,
          expiresAt: oldTime,
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId: teamId,
        entryId: oldEp!.id,
        kind: 'episode',
        sensitivity: 'internal',
        when: {},
        whenSignature: '{}',
        sortOrder: 0,
        content: 'expired episode',
        searchHeader: '旧摘要',
      })
      await tx.insert(entryEvents).values({
        circleId: teamId,
        entryId: keepEntry.id,
        shortId: keepEntry.shortId,
        eventType: 'update',
        provenance: 'owner',
        actorAccountId: bob.id,
        before: {
          shortId: keepEntry.shortId,
          title: '私密旧快照',
          variants: [{ when: {}, content: 'private leak' }],
          ownerAccountId: bob.id,
        },
        after: null,
        context: {},
      })
    })

    // Bob 离圈并把离圈时间调回 45 天前
    await removeMember(database.db, { circleId: teamId, actor: alice.id, target: bob.id })
    await database.db
      .update(circleDepartures)
      .set({ leftAt: oldTime })
      .where(and(eq(circleDepartures.circleId, teamId), eq(circleDepartures.accountId, bob.id)))

    // 全实例备份并在清空库后恢复
    const backupFile = await bufferFromBackup(database.db, sourceKey)
    await resetDatabase(database)
    await database.db.delete(settings)
    const restored = await restoreBackup(database, {
      migrationsFolder: MIGRATIONS_FOLDER,
      masterKey: sourceKey,
      file: backupFile,
    })
    expect(restored.rows.entries).toBeGreaterThanOrEqual(4)

    // 先保存设置并提前解除首次暂停，再执行 retentionJob 清理到期项
    await saveRetentionDays(database.db, { days: 30 }, oldTime)
    await endPause(database.db)
    const run = await retentionJob(database.db, now)
    expect(run).not.toBeNull()
    expect(run!.complete).toBe(true)
    expect(run!.counts.deletedEntries).toBeGreaterThanOrEqual(1)
    expect(run!.counts.supersededFacts).toBeGreaterThanOrEqual(1)
    expect(run!.counts.expiredEpisodes).toBeGreaterThanOrEqual(1)
    expect(run!.counts.departedMembers).toBe(1)
    expect(run!.counts.scrubbedSnapshots).toBeGreaterThanOrEqual(1)

    const remainingEntries = await withCircle(database.db, teamId, (tx) =>
      tx.select().from(entries),
    )
    expect(remainingEntries.map((e) => e.id)).toEqual([keepEntry.id])
    const [scrubbedEv] = await withCircle(database.db, teamId, (tx) =>
      tx
        .select()
        .from(entryEvents)
        .where(and(eq(entryEvents.entryId, keepEntry.id), eq(entryEvents.actorAccountId, bob.id))),
    )
    expect((scrubbedEv!.before as Record<string, unknown>).variants).toBeUndefined()
  })
})
