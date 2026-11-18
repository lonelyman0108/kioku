import { randomBytes, randomUUID } from 'node:crypto'

import {
  DEFAULT_RETENTION_DAYS,
  DEPARTURE_RETENTION_DAYS,
  RETENTION_DAILY_TRIES,
  type RetentionCounts,
} from '@kioku/contracts'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addMember,
  createPersonalCircle,
  createSharedCircle,
  removeMember,
} from '../../access/circles'
import { createClient } from '../../access/clients'
import { issueClientKey } from '../../access/issue'
import { credentialServiceForConsole } from '../../credential/context'
import { withCircle, type Database, type Db, type Tx } from '../../db/client'
import {
  accounts,
  circleDepartures,
  conversations,
  conversationTurns,
  credentialEvents,
  credentials,
  dreamRuns,
  dreamSuggestions,
  entries,
  entryCredentialRefs,
  entryEmbeddings,
  entryEvents,
  entryGlossary,
  entryRecallStats,
  entryVariants,
  extractionRuns,
  recallEventHits,
  recallEvents,
  settings,
  subjectBindings,
  subjects,
  vaultConnections,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps } from '../../http/env'
import { consoleMemberFor } from '../../memory/context'
import { subjectScope } from '../../memory/scopes'
import { ACCESS_EVENT } from '../../memory/service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  activePause,
  deletionRetention,
  endPause,
  loadRetention,
  markRestored,
  purgeExpired,
  RETENTION_BATCH,
  retentionJob,
  retentionView,
  saveRetentionDays,
  withDeletionRetention,
} from '../retention'

const DAY = 86_400_000
const ago = (days: number, from = Date.now()) => new Date(from - days * DAY)
const KEYS = ['retention', 'retention-status']

const ZERO: RetentionCounts = {
  deletedEntries: 0,
  supersededFacts: 0,
  expiredEpisodes: 0,
  orphanEvents: 0,
  scrubbedSnapshots: 0,
  extractionRuns: 0,
  dreamRuns: 0,
  dreamSuggestions: 0,
  credentialEvents: 0,
  accessEvents: 0,
  deletedCredentials: 0,
  subjectBindings: 0,
  vaultConnections: 0,
  departedMembers: 0,
}

let shortSeq = 0
function nextTestShortId(): string {
  const alphabet = '23456789abcdefghjkmnpqrstvwxyz'
  let n = ++shortSeq + 2_000_000
  let suffix = ''
  for (let i = 0; i < 6; i++) {
    suffix = alphabet[n % alphabet.length]! + suffix
    n = Math.floor(n / alphabet.length)
  }
  return `m-${suffix}`
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

describe.skipIf(!testDatabaseUrl)('保留期', () => {
  let database: Database
  let deps: Deps
  const masterKey = randomBytes(32)
  let aliceId: string
  let alicePersonalId: string
  let personalClientId: string
  let sharedId: string
  let clientId: string
  let keyId: string

  const clearSettings = () => database.db.delete(settings).where(inArray(settings.key, KEYS))

  beforeAll(async () => {
    database = await openTestDatabase()
    deps = {
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    }
  })

  afterAll(async () => {
    if (!database) return
    await clearSettings()
    await database.close()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    await clearSettings()
    const alice = await seedAccount(database.db, 'alice')
    aliceId = alice.account.id
    alicePersonalId = alice.personal.id
    const shared = await createSharedCircle(database.db, {
      name: '研发共享圈',
      ownerAccountId: aliceId,
    })
    if (!shared.ok) throw new Error('建共享圈失败')
    sharedId = shared.value.id
    await withCircle(database.db, sharedId, async (tx) => {
      const c = await createClient(tx, {
        circleId: sharedId,
        ownerAccountId: aliceId,
        slug: 'cli',
        name: 'CLI',
        runtimeFamily: 'claudecode',
      })
      if (!c.ok) throw new Error('建实例失败')
      clientId = c.client.id
      const pc = await withCircle(database.db, alicePersonalId, (tx) =>
        createClient(tx, {
          circleId: alicePersonalId,
          ownerAccountId: aliceId,
          slug: 'p-cli',
          name: 'Personal CLI',
          runtimeFamily: 'claudecode',
        }),
      )
      if (!pc.ok) throw new Error('建个人实例失败')
      personalClientId = pc.client.id
      const issued = await issueClientKey(tx, {
        circleId: sharedId,
        clientId,
        accountId: aliceId,
        name: '保留测试密钥',
        scopes: {
          readKinds: ['entry', 'fact', 'episode'],
          writeKinds: ['entry', 'fact', 'episode'],
          maxSensitivity: 'internal',
          allowedRealms: null,
          admin: false,
          credentials: 'none',
        },
      })
      if (!issued.ok) throw new Error('签发密钥失败')
      keyId = issued.row.id
    })
  })

  const inCircle = <T>(fn: (tx: Tx) => Promise<T>, circleId = alicePersonalId) =>
    withCircle(database.db, circleId, fn)

  const memberSvc = (accountId = aliceId, circleId = alicePersonalId) =>
    consoleMemberFor(deps, circleId, accountId).then((m) => m.service)

  const credSvc = (accountId = aliceId, circleId = alicePersonalId) =>
    credentialServiceForConsole(deps, circleId, accountId)

  const deletedDaysAgo = (id: string, days: number, circleId = alicePersonalId) =>
    inCircle(
      (tx) =>
        tx
          .update(entries)
          .set({ deletedAt: ago(days) })
          .where(eq(entries.id, id)),
      circleId,
    )

  const purge = (days = 30, now = new Date()) => purgeExpired(database.db, { days, now })

  const entryIds = async (circleId = alicePersonalId) =>
    (await inCircle((tx) => tx.select({ id: entries.id }).from(entries), circleId)).map((r) => r.id)

  const eventsAbout = (id: string, circleId = alicePersonalId) =>
    inCircle(
      (tx) =>
        tx
          .select()
          .from(entryEvents)
          .where(
            sql`${entryEvents.entryId} = ${id} or ${entryEvents.before} ->> 'id' = ${id} or ${entryEvents.after} ->> 'id' = ${id}`,
          )
          .orderBy(asc(entryEvents.id)),
      circleId,
    )

  it('已删除的词条过了保留期连同变体、向量、关键词、凭据引用、本圈召回明细与累计统计一起删掉；没到期的留着', async () => {
    const creds = await credSvc()
    await creds.create({
      identifier: 'nas',
      name: 'NAS',
      source: { kind: 'new', values: { password: 'nas-pass' } },
    })
    const svc = await memberSvc()
    const old = await svc.create({
      title: '旧笔记',
      content: 'NAS 的密码见 {{cred:nas#password}}',
      glossary: ['旧笔记'],
    })
    await svc.update({
      id: old.shortId,
      content: 'NAS 在书房，密码见 {{cred:nas#password}}',
    })
    const recent = await svc.create({
      title: '新笔记',
      content: '最近才删的，密码见 {{cred:nas#password}}',
      glossary: ['新笔记'],
    })
    const live = await svc.create({ title: '在线笔记', content: '还在用的' })

    await svc.remove({ id: old.shortId })
    await svc.remove({ id: recent.shortId })
    await deletedDaysAgo(old.id, 31)
    await deletedDaysAgo(recent.id, 29)

    await inCircle(async (tx) => {
      const [event] = await tx
        .insert(recallEvents)
        .values({
          circleId: alicePersonalId,
          clientId: randomUUID(),
          ownerAccountId: aliceId,
          source: 'rest.recall',
        })
        .returning()
      for (const [rank, entry] of [old, recent, live].entries()) {
        await tx.insert(entryEmbeddings).values({
          circleId: alicePersonalId,
          variantId: entry.variants[0]!.id,
          entryId: entry.id,
          model: 'm',
          contentHash: 'h',
          embedding: Array.from({ length: 1024 }, () => 0.1),
        })
        await tx.insert(entryRecallStats).values({
          circleId: alicePersonalId,
          entryId: entry.id,
          count: 3,
          lastRecalledAt: ago(40),
        })
        await tx.insert(recallEventHits).values({
          eventId: event!.id,
          circleId: alicePersonalId,
          targetCircleId: alicePersonalId,
          entryId: entry.id,
          shortId: entry.shortId,
          rank: rank + 1,
          score: 1,
          via: ['fts'],
        })
      }
    })
    expect(await eventsAbout(old.id)).toHaveLength(3)

    const { counts, errors } = await purge()
    expect(errors).toEqual([])
    expect(counts).toEqual({ ...ZERO, deletedEntries: 1 })
    expect((await entryIds()).sort()).toEqual([recent.id, live.id].sort())
    expect(await eventsAbout(old.id)).toEqual([])
    expect((await eventsAbout(recent.id)).map((e) => e.eventType)).toEqual(['create', 'delete'])

    const left = await inCircle(async (tx) => ({
      variants: await tx.select({ id: entryVariants.entryId }).from(entryVariants),
      embeddings: await tx.select({ id: entryEmbeddings.entryId }).from(entryEmbeddings),
      glossary: await tx.select({ id: entryGlossary.entryId }).from(entryGlossary),
      refs: await tx.select({ id: entryCredentialRefs.entryId }).from(entryCredentialRefs),
      hits: await tx.select({ id: recallEventHits.entryId }).from(recallEventHits),
      stats: await tx.select({ id: entryRecallStats.entryId }).from(entryRecallStats),
      events: await tx.select().from(recallEvents),
    }))
    const sortIds = (rows: { id: string }[]) => rows.map((r) => r.id).sort()
    expect(sortIds(left.variants)).toEqual([recent.id, live.id].sort())
    expect(sortIds(left.embeddings)).toEqual([recent.id, live.id].sort())
    expect(sortIds(left.glossary)).toEqual([recent.id])
    expect(sortIds(left.refs)).toEqual([recent.id])
    expect(sortIds(left.hits)).toEqual([recent.id, live.id].sort())
    expect(sortIds(left.stats)).toEqual([recent.id, live.id].sort())
    expect(left.events).toHaveLength(1)
  })

  it('被取代的抽取事实与过期的会话摘要过了保留期删掉；到期的正式词条没删除就留着', async () => {
    const svc = await memberSvc(aliceId, sharedId)
    const lapsedCurated = await svc.create({
      title: '限时活动',
      content: '已经过期的正式词条',
    })
    await inCircle(
      (tx) =>
        tx
          .update(entries)
          .set({ validTo: ago(35) })
          .where(eq(entries.id, lapsedCurated.id)),
      sharedId,
    )

    const seeded = await inCircle(async (tx) => {
      const [sub] = await tx
        .insert(subjects)
        .values({ circleId: sharedId, kind: 'person', displayName: '小明' })
        .returning()
      const [conv] = await tx
        .insert(conversations)
        .values({ circleId: sharedId, clientId, kind: 'direct', subjectId: sub!.id })
        .returning()

      const makeFact = async (content: string, validTo: Date | null) => {
        const [e] = await tx
          .insert(entries)
          .values({
            circleId: sharedId,
            circleKind: 'shared',
            shortId: nextTestShortId(),
            kind: 'fact',
            title: content,
            sensitivity: 'public',
            provenance: 'agent',
            originScope: subjectScope('person', sub!.id),
            subjectId: sub!.id,
            subjectKind: 'person',
            validTo,
          })
          .returning()
        await tx.insert(entryVariants).values({
          circleId: sharedId,
          entryId: e!.id,
          kind: 'fact',
          sensitivity: 'public',
          when: {},
          whenSignature: '{}',
          sortOrder: 0,
          content,
        })
        return e!.id
      }

      const makeEpisode = async (content: string, expiresAt: Date) => {
        const [e] = await tx
          .insert(entries)
          .values({
            circleId: sharedId,
            circleKind: 'shared',
            shortId: nextTestShortId(),
            kind: 'episode',
            title: content,
            sensitivity: 'public',
            provenance: 'agent',
            originScope: subjectScope('person', sub!.id),
            conversationId: conv!.id,
            priority: 2,
            expiresAt,
          })
          .returning()
        await tx.insert(entryVariants).values({
          circleId: sharedId,
          entryId: e!.id,
          kind: 'episode',
          sensitivity: 'public',
          when: {},
          whenSignature: '{}',
          sortOrder: 0,
          content,
        })
        return e!.id
      }

      return {
        oldFact: await makeFact('旧地址', ago(31)),
        recentFact: await makeFact('新搬之前的地址', ago(29)),
        liveFact: await makeFact('现在住在南京', null),
        oldEp: await makeEpisode('旧会话摘要', ago(31)),
        recentEp: await makeEpisode('刚过期摘要', ago(29)),
      }
    }, sharedId)

    const { counts, errors } = await purge()
    expect(errors).toEqual([])
    expect(counts).toEqual({ ...ZERO, supersededFacts: 1, expiredEpisodes: 1 })
    const left = await entryIds(sharedId)
    expect(left.sort()).toEqual(
      [lapsedCurated.id, seeded.recentFact, seeded.liveFact, seeded.recentEp].sort(),
    )
  })

  it('词条硬删除时仅保留 Lore 导入去重标记：after 削成 { legacyUri }，按圈导入事件直接删除', async () => {
    const svc = await memberSvc()
    const imported = await svc.create({ content: '老知识正文' })
    await deletedDaysAgo(imported.id, 31)

    await inCircle(async (tx) => {
      await tx.insert(entryEvents).values([
        {
          circleId: alicePersonalId,
          entryId: imported.id,
          shortId: imported.shortId,
          eventType: 'import',
          provenance: 'system',
          before: null,
          after: {
            id: imported.id,
            shortId: imported.shortId,
            title: imported.title,
            legacyUri: 'user://legacy/path',
            variants: [{ when: {}, content: '老知识正文' }],
          },
          context: { source: 'lore' },
        },
        {
          circleId: alicePersonalId,
          entryId: imported.id,
          shortId: imported.shortId,
          eventType: 'import',
          provenance: 'owner',
          before: null,
          after: {
            id: imported.id,
            shortId: imported.shortId,
            title: 'circle-import',
            variants: [{ when: {}, content: '圈内导入' }],
          },
          context: { source: 'circle-import' },
        },
        {
          circleId: alicePersonalId,
          entryId: null,
          shortId: 'm-999999',
          eventType: 'import',
          provenance: 'owner',
          before: null,
          after: { legacyUri: 'user://already-trimmed' },
          context: { source: 'circle-import' },
        },
      ])
    })

    const { counts, errors } = await purge()
    expect(errors).toEqual([])
    expect(counts).toEqual({
      ...ZERO,
      deletedEntries: 1,
      orphanEvents: 1,
    })

    const remaining = await inCircle((tx) => tx.select().from(entryEvents))
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.entryId).toBeNull()
    expect(remaining[0]!.before).toBeNull()
    expect(remaining[0]!.after).toEqual({ legacyUri: 'user://legacy/path' })
  })

  it('删账号留下的历史快照抹掉已删账号的正文与敏感字段，幸存成员的历史不变；孤立事件按规则清理', async () => {
    const bob = await seedAccount(database.db, 'bob')
    const added = await addMember(database.db, {
      circleId: sharedId,
      actor: aliceId,
      username: 'bob',
      role: 'editor',
    })
    if (!added.ok) throw new Error('拉入 Bob 失败')

    const aliceSvc = await memberSvc(aliceId, sharedId)
    const bobSvc = await memberSvc(bob.account.id, sharedId)
    const sharedDoc = await aliceSvc.create({
      title: '共同文档',
      content: 'Alice 写的初始版本',
    })
    await bobSvc.update({
      id: sharedDoc.shortId,
      title: 'Bob 修改的标题',
      content: 'Bob 改写的内容',
    })

    const goneOwnerId = randomUUID()
    await inCircle(async (tx) => {
      await tx.insert(entryEvents).values([
        {
          circleId: sharedId,
          entryId: sharedDoc.id,
          shortId: sharedDoc.shortId,
          eventType: 'update',
          provenance: 'owner',
          before: {
            id: sharedDoc.id,
            shortId: sharedDoc.shortId,
            title: '涉敏标题',
            disclosure: '敏感触发',
            glossary: ['绝密'],
            topics: ['secret'],
            ownerAccountId: goneOwnerId,
            variants: [{ when: {}, content: '已删账号的正文' }],
          },
          after: {
            id: sharedDoc.id,
            shortId: sharedDoc.shortId,
            title: '保留标题',
            ownerAccountId: aliceId,
            variants: [{ when: {}, content: '幸存成员的正文' }],
          },
          context: {},
        },
        {
          circleId: sharedId,
          entryId: null,
          shortId: 'm-orphan2',
          eventType: 'update',
          provenance: 'owner',
          before: { id: randomUUID(), ownerAccountId: goneOwnerId, content: '孤立正文' },
          after: null,
          context: {},
        },
      ])
    }, sharedId)

    const { counts, errors } = await purge()
    expect(errors).toEqual([])
    expect(counts).toEqual({
      ...ZERO,
      orphanEvents: 1,
      scrubbedSnapshots: 1,
    })

    const evs = await eventsAbout(sharedDoc.id, sharedId)
    const scrubbedRow = evs.find(
      (e) => (e.before as Record<string, unknown> | null)?.ownerAccountId === goneOwnerId,
    )!
    expect(scrubbedRow.before).toEqual({
      id: sharedDoc.id,
      shortId: sharedDoc.shortId,
      ownerAccountId: goneOwnerId,
    })
    expect((scrubbedRow.after as Record<string, unknown>).variants).toEqual([
      { when: {}, content: '幸存成员的正文' },
    ])
  })

  it('抽取记录与 Dream 运行记录保留本月；Dream 建议仅作废且超期才删；凭据、访问事件、连接与绑定按期清', async () => {
    const now = new Date('2026-11-19T12:00:00Z')
    const creds = await credSvc()
    const deletedCred = await creds.create({
      identifier: 'old-key',
      name: '旧密钥',
      source: { kind: 'new', values: { token: 'secret-val' } },
    })
    await creds.delete(deletedCred.id)

    const svc = await memberSvc()
    const currentEntry = await svc.create({ content: '仍在生效的词条' })
    const oldEntry = await svc.create({ content: '旧版本词条' })
    await svc.update({ id: oldEntry.shortId, content: '新版本词条' })

    const liveConnId = randomUUID()
    const deadConnId = randomUUID()

    await inCircle(async (tx) => {
      await tx
        .update(credentials)
        .set({ deletedAt: ago(31, now.getTime()) })
        .where(eq(credentials.id, deletedCred.id))

      await tx.insert(credentialEvents).values([
        {
          circleId: alicePersonalId,
          credentialId: deletedCred.id,
          eventType: 'resolve',
          createdAt: ago(35, now.getTime()),
        },
        {
          circleId: alicePersonalId,
          credentialId: deletedCred.id,
          eventType: 'resolve',
          createdAt: ago(10, now.getTime()),
        },
      ])

      await tx.insert(entryEvents).values([
        {
          circleId: alicePersonalId,
          entryId: currentEntry.id,
          shortId: currentEntry.shortId,
          eventType: ACCESS_EVENT,
          provenance: 'agent',
          before: null,
          after: null,
          context: {},
          createdAt: ago(35, now.getTime()),
        },
        {
          circleId: alicePersonalId,
          entryId: currentEntry.id,
          shortId: currentEntry.shortId,
          eventType: ACCESS_EVENT,
          provenance: 'agent',
          before: null,
          after: null,
          context: {},
          createdAt: ago(5, now.getTime()),
        },
      ])

      await tx.insert(extractionRuns).values([
        {
          circleId: alicePersonalId,
          clientId: personalClientId,
          scope: 'global',
          subjectIds: [],
          turns: 1,
          createdAt: ago(45, now.getTime()),
        },
        {
          circleId: alicePersonalId,
          clientId: personalClientId,
          scope: 'global',
          subjectIds: [],
          turns: 1,
          createdAt: new Date('2026-11-05T00:00:00Z'),
        },
      ])

      await tx.insert(dreamRuns).values([
        {
          circleId: alicePersonalId,
          runId: randomUUID(),
          trigger: 'manual',
          createdAt: ago(45, now.getTime()),
        },
        {
          circleId: alicePersonalId,
          runId: randomUUID(),
          trigger: 'manual',
          createdAt: new Date('2026-11-05T00:00:00Z'),
        },
      ])

      await tx.insert(dreamSuggestions).values([
        {
          circleId: alicePersonalId,
          scope: `personal:${aliceId}`,
          ownerAccountId: aliceId,
          kind: 'stale',
          entryIds: [currentEntry.id],
          versions: [currentEntry.version],
          reason: '依然作数',
          fingerprint: 'fp-current',
          status: 'pending',
          createdAt: ago(40, now.getTime()),
        },
        {
          circleId: alicePersonalId,
          scope: `personal:${aliceId}`,
          ownerAccountId: aliceId,
          kind: 'stale',
          entryIds: [oldEntry.id],
          versions: [1],
          reason: '已升级版本而作废',
          fingerprint: 'fp-obsolete',
          status: 'pending',
          createdAt: ago(40, now.getTime()),
        },
      ])

      await tx.insert(vaultConnections).values([
        {
          id: deadConnId,
          circleId: alicePersonalId,
          ownerAccountId: aliceId,
          serverUrl: 'https://vault.example.com',
          email: 'a@example.com',
          vaultUserId: 'v-dead',
          deviceId: randomUUID(),
          status: 'disconnected',
          disconnectedAt: ago(35, now.getTime()),
        },
        {
          id: liveConnId,
          circleId: alicePersonalId,
          ownerAccountId: aliceId,
          serverUrl: 'https://vault2.example.com',
          email: 'b@example.com',
          vaultUserId: 'v-live',
          deviceId: randomUUID(),
          status: 'disconnected',
          disconnectedAt: ago(35, now.getTime()),
        },
      ])
      await tx.insert(credentials).values({
        circleId: alicePersonalId,
        ownerAccountId: aliceId,
        identifier: 'vault-ref',
        name: 'Vault',
        source: 'vault',
        vaultConnectionId: liveConnId,
        vaultItemId: 'item-1',
      })

      const [bindSub] = await tx
        .insert(subjects)
        .values({ circleId: alicePersonalId, kind: 'person', displayName: '绑定联系人' })
        .returning()

      await tx.insert(subjectBindings).values([
        {
          circleId: alicePersonalId,
          clientId: personalClientId,
          keyId: personalClientId,
          subjectId: bindSub!.id,
          fromSubjectId: bindSub!.id,
          platform: 'qq',
          externalId: '1',
          issuedPlatform: 'qq',
          issuedExternalId: '1',
          issuedAt: ago(40, now.getTime()),
          status: 'confirmed',
          decidedAt: ago(35, now.getTime()),
        },
        {
          circleId: alicePersonalId,
          clientId: personalClientId,
          keyId: personalClientId,
          subjectId: bindSub!.id,
          fromSubjectId: bindSub!.id,
          platform: 'qq',
          externalId: '2',
          issuedPlatform: 'qq',
          issuedExternalId: '2',
          issuedAt: ago(40, now.getTime()),
          status: 'pending',
          expiresAt: new Date(now.getTime() + DAY),
        },
      ])
    })

    const { counts, errors } = await purge(30, now)
    expect(errors).toEqual([])
    expect(counts).toEqual({
      ...ZERO,
      extractionRuns: 1,
      dreamRuns: 1,
      dreamSuggestions: 1,
      credentialEvents: 1,
      accessEvents: 1,
      deletedCredentials: 1,
      vaultConnections: 1,
      subjectBindings: 1,
    })

    const left = await inCircle(async (tx) => ({
      sugs: await tx.select({ fp: dreamSuggestions.fingerprint }).from(dreamSuggestions),
      conns: await tx.select({ id: vaultConnections.id }).from(vaultConnections),
      binds: await tx.select({ status: subjectBindings.status }).from(subjectBindings),
    }))
    expect(left.sugs.map((s) => s.fp)).toEqual(['fp-current'])
    expect(left.conns.map((c) => c.id)).toEqual([liveConnId])
    expect(left.binds.map((b) => b.status)).toEqual(['pending'])
  })

  it('跳过正被锁定的词条、分批清理大批量、按时间预算中断并支持每日重试上限与异常设置恢复', async () => {
    const svc = await memberSvc()
    const locked = await svc.create({ content: '正准备恢复的词条' })
    await svc.remove({ id: locked.shortId })
    await deletedDaysAgo(locked.id, 35)

    // 锁住该行时跳过、不阻塞
    await withCircle(database.db, alicePersonalId, async (tx) => {
      await tx.execute(sql`select 1 from entries where id = ${locked.id} for update`)
      const skipped = await purge()
      expect(skipped.counts.deletedEntries).toBe(0)
    })

    // 分批删除 > RETENTION_BATCH 条软删除记录
    await inCircle(async (tx) => {
      const batchRows = Array.from({ length: RETENTION_BATCH + 10 }, () => ({
        circleId: alicePersonalId,
        circleKind: 'personal' as const,
        shortId: nextTestShortId(),
        kind: 'entry' as const,
        title: '批量过期',
        sensitivity: 'private' as const,
        provenance: 'owner' as const,
        ownerAccountId: aliceId,
        deletedAt: ago(35),
      }))
      await tx.insert(entries).values(batchRows)
    })

    // 先验证 deadline 到期时只完成一部分且 complete = false
    const partial = await purgeExpired(database.db, {
      days: 30,
      now: new Date(),
      deadline: Date.now() - 1,
    })
    expect(partial.complete).toBe(false)

    // 再全部清空
    const full = await purge()
    expect(full.complete).toBe(true)
    expect(await entryIds()).toEqual([])

    // 测试每日重试上限与损坏设置自愈
    await database.db.insert(settings).values({ key: 'retention', value: { days: 'bad' } })
    await database.db.insert(settings).values({
      key: 'retention-status',
      value: {
        lastRun: {
          at: '2026-11-18T00:00:00Z',
          days: 30,
          paused: false,
          counts: { deletedEntries: 2 },
        },
        lastAttempt: null,
        lastError: null,
      },
    })
    const loaded = await loadRetention(database.db)
    expect(loaded.days).toBe(DEFAULT_RETENTION_DAYS)

    await clearSettings()
    await saveRetentionDays(database.db, { days: 45 }, new Date('2026-11-19T00:00:00Z'))
    const pausedView = await retentionView(database.db, new Date('2026-11-20T00:00:00Z'))
    expect(deletionRetention(pausedView, true).pausedUntil).not.toBeNull()
    expect(deletionRetention(pausedView, false).pausedUntil).toBeNull()

    const wrapped = await withDeletionRetention(
      database.db,
      Promise.resolve({ items: [] }),
      Promise.resolve(false),
    )
    expect(wrapped.retention).toEqual({ days: 45, paused: true, pausedUntil: null })

    // 从备份恢复后的暂停与提前结束
    await database.db.transaction((tx) => markRestored(tx, new Date('2026-11-21T00:00:00Z')))
    const afterRestore = await retentionView(database.db, new Date('2026-11-22T00:00:00Z'))
    expect(afterRestore.pause?.reason).toBe('restored')

    await endPause(database.db)
    expect(
      activePause(await loadRetention(database.db), new Date('2026-11-22T00:00:00Z')),
    ).toBeNull()

    // retentionJob 在当天已完成时幂等跳过，出错计数达 RETENTION_DAILY_TRIES 后当天停止
    const day = new Date('2026-11-25T10:00:00Z')
    const firstJob = await retentionJob(database.db, day)
    expect(firstJob?.complete).toBe(true)
    expect(await retentionJob(database.db, day)).toBeNull()

    await clearSettings()
    for (let i = 0; i < RETENTION_DAILY_TRIES; i++) {
      await database.db
        .insert(settings)
        .values({
          key: 'retention-status',
          value: {
            lastRun: null,
            lastAttempt: {
              at: day.toISOString(),
              paused: false,
              complete: false,
              counts: ZERO,
              tries: RETENTION_DAILY_TRIES,
            },
            lastError: null,
          },
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: {
            value: {
              lastRun: null,
              lastAttempt: {
                at: day.toISOString(),
                paused: false,
                complete: false,
                counts: ZERO,
                tries: RETENTION_DAILY_TRIES,
              },
              lastError: null,
            },
          },
        })
    }
    expect(await retentionJob(database.db, day)).toBeNull()
  })

  it('离开满 30 天的成员清掉该圈属他的数据；重新加入时不删', async () => {
    const bob = await seedAccount(database.db, 'bob')
    const charlie = await seedAccount(database.db, 'charlie')
    for (const u of ['bob', 'charlie']) {
      const added = await addMember(database.db, {
        circleId: sharedId,
        actor: aliceId,
        username: u,
        role: 'editor',
      })
      if (!added.ok) throw new Error(`拉入 ${u} 失败`)
    }

    const convBob = await inCircle(async (tx) => {
      const [conv] = await tx
        .insert(conversations)
        .values({
          circleId: sharedId,
          clientId,
          kind: 'none',
          ownerAccountId: bob.account.id,
          deviceKey: 'mac',
          projectSlug: 'proj',
        })
        .returning()
      const [ep] = await tx
        .insert(entries)
        .values({
          circleId: sharedId,
          circleKind: 'shared',
          shortId: nextTestShortId(),
          kind: 'episode',
          title: 'Bob 本机摘要',
          sensitivity: 'private',
          provenance: 'agent',
          ownerAccountId: bob.account.id,
          conversationId: conv!.id,
          priority: 2,
          expiresAt: new Date(Date.now() + 7 * DAY),
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId: sharedId,
        entryId: ep!.id,
        kind: 'episode',
        sensitivity: 'private',
        when: {},
        whenSignature: '{}',
        sortOrder: 0,
        content: 'Bob 的会话细节',
      })
      await tx.insert(conversationTurns).values({
        circleId: sharedId,
        clientId,
        keyId,
        scope: 'client',
        sessionId: 'sess-1',
        chatType: 'none',
        ownerAccountId: bob.account.id,
        senderName: 'Bob',
        userText: 'Bob 对话提问',
        replyText: 'Bob 对话回答',
      })
      await tx.insert(vaultConnections).values({
        circleId: sharedId,
        ownerAccountId: bob.account.id,
        serverUrl: 'https://vault.example.com',
        email: 'bob@example.com',
        vaultUserId: 'bob-v',
        deviceId: randomUUID(),
        status: 'disconnected',
        disconnectedAt: new Date(),
      })
      return conv!.id
    }, sharedId)

    const aliceShared = await (
      await memberSvc(aliceId, sharedId)
    ).create({ content: '共享规范不变' })

    await removeMember(database.db, { circleId: sharedId, actor: aliceId, target: bob.account.id })
    await removeMember(database.db, {
      circleId: sharedId,
      actor: aliceId,
      target: charlie.account.id,
    })

    // charlie 重新加入后，即使圈里仍残留过期的离开记录（或重新写入测试守卫），也不删他的数据
    const rejoined = await addMember(database.db, {
      circleId: sharedId,
      actor: aliceId,
      username: 'charlie',
      role: 'editor',
    })
    if (!rejoined.ok) throw new Error('charlie 重加失败')

    await inCircle(async (tx) => {
      await tx
        .insert(circleDepartures)
        .values({
          circleId: sharedId,
          accountId: charlie.account.id,
          dreamPrivate: true,
          leftAt: ago(DEPARTURE_RETENTION_DAYS + 1),
        })
        .onConflictDoNothing()
      await tx
        .update(circleDepartures)
        .set({ leftAt: ago(DEPARTURE_RETENTION_DAYS + 1) })
        .where(eq(circleDepartures.circleId, sharedId))
    }, sharedId)

    const { counts, errors } = await purge()
    expect(errors).toEqual([])
    expect(counts.departedMembers).toBe(1)
    expect(counts.deletedEntries).toBe(1)

    const after = await inCircle(
      async (tx) => ({
        entries: await tx.select({ id: entries.id }).from(entries),
        turns: await tx.select().from(conversationTurns),
        convs: await tx.select({ id: conversations.id }).from(conversations),
        vaults: await tx.select().from(vaultConnections),
        departures: await tx.select().from(circleDepartures),
      }),
      sharedId,
    )
    expect(after.entries.map((e) => e.id)).toEqual([aliceShared.id])
    expect(after.turns).toEqual([])
    expect(after.convs.map((c) => c.id)).not.toContain(convBob)
    expect(after.vaults).toEqual([])
    expect(after.departures.map((d) => d.accountId)).toEqual([charlie.account.id])
  })
})
