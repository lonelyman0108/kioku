import {
  ENTRY_KINDS,
  SENSITIVITIES,
  type CircleEffectiveGrant,
  type EntryKind,
  type Sensitivity,
  type SubjectKind,
} from '@kioku/contracts'
import { and, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  canRead,
  consoleAccess,
  resolveAccess,
  type Access,
  type EntryFacts,
  type ReadOptions,
} from '../../access/access'
import { withCircle, withCircles, type Database } from '../../db/client'
import {
  accounts,
  circleMembers,
  circles,
  clients,
  conversations,
  entries,
  entryEvents,
  subjects,
} from '../../db/schema'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { readableConditions, snapshotColumns, snapshotFacts } from '../filter'

const SHORT_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz'

function encodeShortId(index: number): string {
  let n = index
  let body = ''
  for (let i = 0; i < 6; i++) {
    body = SHORT_ALPHABET[n % SHORT_ALPHABET.length]! + body
    n = Math.floor(n / SHORT_ALPHABET.length)
  }
  return `m-${body}`
}

const NOW = new Date('2026-06-01T00:00:00.000Z')
const PAST = new Date('2025-01-01T00:00:00.000Z')
const FUTURE = new Date('2028-01-01T00:00:00.000Z')
const EDGE = new Date('2030-01-01T00:00:00.000Z')

describe.skipIf(!testDatabaseUrl)(
  '可读过滤 条件一致性（JS canRead × SQL readableConditions）',
  () => {
    let database: Database

    beforeAll(async () => {
      database = await openTestDatabase()
    })

    afterAll(async () => {
      await database.close()
    })

    beforeEach(async () => {
      await resetDatabase(database)
    })

    async function seedFixture() {
      const [owner] = await database.db
        .insert(accounts)
        .values({ username: 'owner-filter', displayName: '主人', passwordHash: 'x' })
        .returning()
      const [other] = await database.db
        .insert(accounts)
        .values({ username: 'other-filter', displayName: '协作者', passwordHash: 'x' })
        .returning()

      const [workCircle] = await database.db
        .insert(circles)
        .values({
          slug: 'work-circle',
          name: '工作圈',
          kind: 'shared',
          ownerAccountId: null,
          defaultFacets: { realm: ['work'] },
        })
        .returning()
      const [meCircle] = await database.db
        .insert(circles)
        .values({
          slug: 'me-circle',
          name: '主人的个人圈',
          kind: 'personal',
          ownerAccountId: owner!.id,
          defaultFacets: {},
        })
        .returning()
      const [homeCircle] = await database.db
        .insert(circles)
        .values({
          slug: 'home-circle',
          name: '家庭圈',
          kind: 'shared',
          ownerAccountId: null,
          defaultFacets: { realm: ['home'] },
        })
        .returning()

      await database.db.insert(circleMembers).values([
        { circleId: workCircle!.id, accountId: owner!.id, role: 'owner' },
        { circleId: workCircle!.id, accountId: other!.id, role: 'editor' },
        { circleId: meCircle!.id, accountId: owner!.id, role: 'owner' },
        { circleId: homeCircle!.id, accountId: owner!.id, role: 'editor' },
      ])

      const workSetup = await withCircle(database.db, workCircle!.id, async (tx) => {
        const [c1, c2] = await tx
          .insert(clients)
          .values([
            {
              circleId: workCircle!.id,
              slug: 'bot-one',
              name: '一号机器人',
              runtimeFamily: 'astrbot',
              ownerAccountId: owner!.id,
            },
            {
              circleId: workCircle!.id,
              slug: 'bot-two',
              name: '二号机器人',
              runtimeFamily: 'astrbot',
              ownerAccountId: other!.id,
            },
          ])
          .returning()

        const [g1, g2, g3, s1, s2] = await tx
          .insert(subjects)
          .values([
            { circleId: workCircle!.id, kind: 'group', displayName: '一群' },
            { circleId: workCircle!.id, kind: 'group', displayName: '二群' },
            { circleId: workCircle!.id, kind: 'group', displayName: '锁定群' },
            { circleId: workCircle!.id, kind: 'person', displayName: '路人甲' },
            {
              circleId: workCircle!.id,
              kind: 'person',
              displayName: '主人分身',
              accountId: owner!.id,
            },
          ])
          .returning()

        const [convLocal, convOtherLocal, convGroup1, convGroup2, convGroup3, convDirect] = await tx
          .insert(conversations)
          .values([
            {
              circleId: workCircle!.id,
              clientId: c1!.id,
              kind: 'none',
              deviceKey: 'dev-1',
              projectSlug: 'proj-1',
              ownerAccountId: owner!.id,
            },
            {
              circleId: workCircle!.id,
              clientId: c1!.id,
              kind: 'none',
              deviceKey: 'dev-2',
              projectSlug: 'proj-1',
              ownerAccountId: other!.id,
            },
            {
              circleId: workCircle!.id,
              clientId: c1!.id,
              kind: 'group',
              subjectId: g1!.id,
            },
            {
              circleId: workCircle!.id,
              clientId: c1!.id,
              kind: 'group',
              subjectId: g2!.id,
            },
            {
              circleId: workCircle!.id,
              clientId: c1!.id,
              kind: 'group',
              subjectId: g3!.id,
            },
            {
              circleId: workCircle!.id,
              clientId: c1!.id,
              kind: 'direct',
              subjectId: s1!.id,
            },
          ])
          .returning()

        return {
          c1: c1!.id,
          c2: c2!.id,
          g1: g1!.id,
          g2: g2!.id,
          g3: g3!.id,
          s1: s1!.id,
          s2: s2!.id,
          convLocal: convLocal!.id,
          convOtherLocal: convOtherLocal!.id,
          convGroup1: convGroup1!.id,
          convGroup2: convGroup2!.id,
          convGroup3: convGroup3!.id,
          convDirect: convDirect!.id,
        }
      })

      const meSetup = await withCircle(database.db, meCircle!.id, async (tx) => {
        const [cMe] = await tx
          .insert(clients)
          .values({
            circleId: meCircle!.id,
            slug: 'me-bot',
            name: '个人端',
            runtimeFamily: 'mcp',
            ownerAccountId: owner!.id,
          })
          .returning()
        const [mePerson] = await tx
          .insert(subjects)
          .values({ circleId: meCircle!.id, kind: 'person', displayName: '自己' })
          .returning()
        const [convMeLocal] = await tx
          .insert(conversations)
          .values({
            circleId: meCircle!.id,
            clientId: cMe!.id,
            kind: 'none',
            deviceKey: 'me-dev',
            ownerAccountId: owner!.id,
          })
          .returning()
        return { cMe: cMe!.id, mePerson: mePerson!.id, convMeLocal: convMeLocal!.id }
      })

      const homeSetup = await withCircle(database.db, homeCircle!.id, async (tx) => {
        const [cHome] = await tx
          .insert(clients)
          .values({
            circleId: homeCircle!.id,
            slug: 'home-bot',
            name: '家庭端',
            runtimeFamily: 'mcp',
            ownerAccountId: owner!.id,
          })
          .returning()
        const [homePerson] = await tx
          .insert(subjects)
          .values({ circleId: homeCircle!.id, kind: 'person', displayName: '家人' })
          .returning()
        const [convHomeLocal] = await tx
          .insert(conversations)
          .values({
            circleId: homeCircle!.id,
            clientId: cHome!.id,
            kind: 'none',
            deviceKey: 'home-dev',
            ownerAccountId: owner!.id,
          })
          .returning()
        return { cHome: cHome!.id, homePerson: homePerson!.id, convHomeLocal: convHomeLocal!.id }
      })

      interface SeedRow {
        circleId: string
        circleKind: 'personal' | 'shared'
        shortId: string
        kind: EntryKind
        title: string
        sensitivity: Sensitivity
        provenance: 'owner' | 'agent' | 'untrusted'
        originScope: string
        clientId: string | null
        ownerAccountId: string | null
        subjectId: string | null
        subjectKind: SubjectKind | null
        conversationId: string | null
        realms: string[]
        validTo: Date | null
        expiresAt: Date | null
        deletedAt: Date | null
      }

      let seq = 1
      const nextShort = () => encodeShortId(seq++)

      const rows: SeedRow[] = []

      const workEntriesOriginScopes = [
        'global',
        `client:${workSetup.c1}`,
        `client:${workSetup.c2}`,
        `group:${workSetup.g1}`,
        `group:${workSetup.g2}`,
        `group:${workSetup.g3}`,
        `direct:${workSetup.s1}`,
      ]
      const realmVariants: string[][] = [[], ['work'], ['home']]

      for (const sensitivity of SENSITIVITIES) {
        for (const realms of realmVariants) {
          for (const originScope of workEntriesOriginScopes) {
            rows.push({
              circleId: workCircle!.id,
              circleKind: 'shared',
              shortId: nextShort(),
              kind: 'entry',
              title: `work-entry-${sensitivity}-${originScope}`,
              sensitivity,
              provenance: 'owner',
              originScope,
              clientId: originScope === `client:${workSetup.c2}` ? workSetup.c2 : workSetup.c1,
              ownerAccountId: null,
              subjectId: null,
              subjectKind: null,
              conversationId: null,
              realms,
              validTo: null,
              expiresAt: null,
              deletedAt: null,
            })
          }
        }
      }

      const workSubjectTargets: { id: string; subjectKind: SubjectKind }[] = [
        { id: workSetup.s1, subjectKind: 'person' },
        { id: workSetup.g1, subjectKind: 'group' },
      ]
      const workFactClients = [null, workSetup.c1, workSetup.c2]
      const workFactScopes = [
        'global',
        `client:${workSetup.c1}`,
        `group:${workSetup.g1}`,
        `group:${workSetup.g2}`,
        `group:${workSetup.g3}`,
        `direct:${workSetup.s1}`,
      ]
      for (const subj of workSubjectTargets) {
        for (const sensitivity of SENSITIVITIES) {
          for (const realms of realmVariants) {
            for (const originScope of workFactScopes) {
              for (const clientId of workFactClients) {
                rows.push({
                  circleId: workCircle!.id,
                  circleKind: 'shared',
                  shortId: nextShort(),
                  kind: 'fact',
                  title: `work-fact-${subj.subjectKind}-${sensitivity}-${originScope}`,
                  sensitivity,
                  provenance:
                    originScope.startsWith('group:') || originScope.startsWith('direct:')
                      ? 'untrusted'
                      : 'agent',
                  originScope,
                  clientId,
                  ownerAccountId: null,
                  subjectId: subj.id,
                  subjectKind: subj.subjectKind,
                  conversationId: null,
                  realms,
                  validTo: null,
                  expiresAt: null,
                  deletedAt: null,
                })
              }
            }
          }
        }
      }

      const workEpisodeSources = [
        {
          conversationId: workSetup.convLocal,
          originScope: 'global',
          ownerAccountId: owner!.id,
          clientId: workSetup.c1,
          provenance: 'agent' as const,
        },
        {
          conversationId: workSetup.convOtherLocal,
          originScope: 'global',
          ownerAccountId: other!.id,
          clientId: workSetup.c1,
          provenance: 'agent' as const,
        },
        {
          conversationId: workSetup.convGroup1,
          originScope: `group:${workSetup.g1}`,
          ownerAccountId: null,
          clientId: workSetup.c1,
          provenance: 'untrusted' as const,
        },
        {
          conversationId: workSetup.convGroup2,
          originScope: `group:${workSetup.g2}`,
          ownerAccountId: null,
          clientId: workSetup.c1,
          provenance: 'untrusted' as const,
        },
        {
          conversationId: workSetup.convGroup3,
          originScope: `group:${workSetup.g3}`,
          ownerAccountId: null,
          clientId: workSetup.c1,
          provenance: 'untrusted' as const,
        },
        {
          conversationId: workSetup.convDirect,
          originScope: `direct:${workSetup.s1}`,
          ownerAccountId: null,
          clientId: workSetup.c1,
          provenance: 'untrusted' as const,
        },
      ]
      for (const ep of workEpisodeSources) {
        for (const sensitivity of ['public', 'internal', 'private'] as const) {
          for (const realms of [[], ['work']]) {
            rows.push({
              circleId: workCircle!.id,
              circleKind: 'shared',
              shortId: nextShort(),
              kind: 'episode',
              title: `work-episode-${ep.originScope}-${sensitivity}`,
              sensitivity,
              provenance: ep.provenance,
              originScope: ep.originScope,
              clientId: ep.clientId,
              ownerAccountId: ep.ownerAccountId,
              subjectId: null,
              subjectKind: null,
              conversationId: ep.conversationId,
              realms,
              validTo: null,
              expiresAt: null,
              deletedAt: null,
            })
          }
        }
      }

      const lifecycleCases = [
        { name: 'expired', validTo: null, expiresAt: PAST, deletedAt: null },
        { name: 'lapsed', validTo: PAST, expiresAt: null, deletedAt: null },
        { name: 'future', validTo: FUTURE, expiresAt: FUTURE, deletedAt: null },
        { name: 'edgeValidTo', validTo: EDGE, expiresAt: null, deletedAt: null },
        { name: 'edgeExpiresAt', validTo: null, expiresAt: EDGE, deletedAt: null },
        { name: 'deleted', validTo: null, expiresAt: null, deletedAt: PAST },
      ]
      for (const lc of lifecycleCases) {
        for (const sensitivity of ['public', 'internal', 'secret'] as const) {
          rows.push({
            circleId: workCircle!.id,
            circleKind: 'shared',
            shortId: nextShort(),
            kind: 'entry',
            title: `work-lc-${lc.name}-${sensitivity}`,
            sensitivity,
            provenance: 'owner',
            originScope: 'global',
            clientId: null,
            ownerAccountId: null,
            subjectId: null,
            subjectKind: null,
            conversationId: null,
            realms: ['work'],
            validTo: lc.validTo,
            expiresAt: lc.expiresAt,
            deletedAt: lc.deletedAt,
          })
        }
      }

      for (const ownerId of [owner!.id, other!.id]) {
        for (const sensitivity of SENSITIVITIES) {
          for (const realms of realmVariants) {
            for (const originScope of [
              'global',
              `group:${workSetup.g1}`,
              `direct:${workSetup.s1}`,
            ]) {
              rows.push({
                circleId: meCircle!.id,
                circleKind: 'personal',
                shortId: nextShort(),
                kind: 'entry',
                title: `me-entry-${sensitivity}-${originScope}`,
                sensitivity,
                provenance: 'owner',
                originScope,
                clientId: null,
                ownerAccountId: ownerId,
                subjectId: null,
                subjectKind: null,
                conversationId: null,
                realms,
                validTo: null,
                expiresAt: null,
                deletedAt: null,
              })
            }
          }
        }
      }
      for (const sensitivity of SENSITIVITIES) {
        for (const realms of realmVariants) {
          rows.push({
            circleId: meCircle!.id,
            circleKind: 'personal',
            shortId: nextShort(),
            kind: 'fact',
            title: `me-fact-${sensitivity}`,
            sensitivity,
            provenance: 'agent',
            originScope: 'global',
            clientId: meSetup.cMe,
            ownerAccountId: null,
            subjectId: meSetup.mePerson,
            subjectKind: 'person',
            conversationId: null,
            realms,
            validTo: null,
            expiresAt: null,
            deletedAt: null,
          })
        }
      }
      for (const sensitivity of ['public', 'internal', 'private'] as const) {
        for (const ownerId of [null, owner!.id]) {
          rows.push({
            circleId: meCircle!.id,
            circleKind: 'personal',
            shortId: nextShort(),
            kind: 'episode',
            title: `me-episode-${sensitivity}`,
            sensitivity,
            provenance: 'agent',
            originScope: 'global',
            clientId: meSetup.cMe,
            ownerAccountId: ownerId,
            subjectId: null,
            subjectKind: null,
            conversationId: meSetup.convMeLocal,
            realms: [],
            validTo: null,
            expiresAt: null,
            deletedAt: null,
          })
        }
      }

      for (const sensitivity of SENSITIVITIES) {
        for (const realms of realmVariants) {
          for (const originScope of ['global', `client:${workSetup.c1}`, `group:${workSetup.g1}`]) {
            rows.push({
              circleId: homeCircle!.id,
              circleKind: 'shared',
              shortId: nextShort(),
              kind: 'entry',
              title: `home-entry-${sensitivity}-${originScope}`,
              sensitivity,
              provenance: 'owner',
              originScope,
              clientId: null,
              ownerAccountId: null,
              subjectId: null,
              subjectKind: null,
              conversationId: null,
              realms,
              validTo: null,
              expiresAt: null,
              deletedAt: null,
            })
          }
        }
      }
      for (const sensitivity of ['public', 'internal', 'private'] as const) {
        for (const realms of realmVariants) {
          rows.push({
            circleId: homeCircle!.id,
            circleKind: 'shared',
            shortId: nextShort(),
            kind: 'fact',
            title: `home-fact-${sensitivity}`,
            sensitivity,
            provenance: 'agent',
            originScope: 'global',
            clientId: homeSetup.cHome,
            ownerAccountId: null,
            subjectId: homeSetup.homePerson,
            subjectKind: 'person',
            conversationId: null,
            realms,
            validTo: null,
            expiresAt: null,
            deletedAt: null,
          })
        }
      }
      for (const sensitivity of ['public', 'internal', 'private'] as const) {
        for (const ownerId of [null, owner!.id]) {
          rows.push({
            circleId: homeCircle!.id,
            circleKind: 'shared',
            shortId: nextShort(),
            kind: 'episode',
            title: `home-episode-${sensitivity}`,
            sensitivity,
            provenance: 'agent',
            originScope: 'global',
            clientId: homeSetup.cHome,
            ownerAccountId: ownerId,
            subjectId: null,
            subjectKind: null,
            conversationId: homeSetup.convHomeLocal,
            realms: [],
            validTo: null,
            expiresAt: null,
            deletedAt: null,
          })
        }
      }

      expect(rows.length).toBeGreaterThanOrEqual(500)

      const insertedEntries: (typeof entries.$inferSelect)[] = []
      for (const circleId of [workCircle!.id, meCircle!.id, homeCircle!.id]) {
        const subset = rows.filter((r) => r.circleId === circleId)
        const created = await withCircle(database.db, circleId, async (tx) => {
          const inserted = await tx.insert(entries).values(subset).returning()
          await tx.insert(entryEvents).values(
            inserted.map((row) => ({
              circleId: row.circleId,
              entryId: row.id,
              shortId: row.shortId,
              eventType: 'create',
              provenance: row.provenance,
              after: {
                circleId: row.circleId,
                kind: row.kind,
                sensitivity: row.sensitivity,
                originScope: row.originScope,
                clientId: row.clientId,
                ownerAccountId: row.ownerAccountId,
                subjectKind: row.subjectKind,
                realms: row.realms,
                validTo: row.validTo?.toISOString() ?? null,
                expiresAt: row.expiresAt?.toISOString() ?? null,
                deletedAt: row.deletedAt?.toISOString() ?? null,
              },
            })),
          )
          return inserted
        })
        insertedEntries.push(...created)
      }

      const malformedPayloads: (Record<string, unknown> | null)[] = [
        null,
        {},
        { kind: 'entry', sensitivity: 'public' },
        { circleId: workCircle!.id, sensitivity: 'public' },
        { circleId: workCircle!.id, kind: 'entry' },
        { circleId: workCircle!.id, kind: 'bogus', sensitivity: 'public' },
        { circleId: workCircle!.id, kind: 'entry', sensitivity: 'bogus' },
        { circleId: workCircle!.id, kind: 'entry', sensitivity: 'public', originScope: 123 },
        { circleId: workCircle!.id, kind: 'entry', sensitivity: 'public', ownerAccountId: 42 },
        { circleId: workCircle!.id, kind: 'entry', sensitivity: 'secret', realms: 'work' },
        { circleId: workCircle!.id, kind: 'entry', sensitivity: 'secret', realms: 123 },
        {
          circleId: workCircle!.id,
          kind: 'entry',
          sensitivity: 'secret',
          realms: ['work', null, 123],
        },
        { circleId: workCircle!.id, kind: 'entry', sensitivity: 'secret', realms: [123, false] },
        {
          circleId: workCircle!.id,
          kind: 'entry',
          sensitivity: 'public',
          originScope: 'global',
          validTo: EDGE.toISOString(),
        },
        {
          circleId: workCircle!.id,
          kind: 'entry',
          sensitivity: 'public',
          originScope: 'global',
          expiresAt: EDGE.toISOString(),
        },
        {
          circleId: workCircle!.id,
          kind: 'entry',
          sensitivity: 'public',
          originScope: 'global',
          deletedAt: EDGE.toISOString(),
        },
      ]
      const extraEvents: (typeof entryEvents.$inferInsert)[] = []
      for (let i = 0; i < 40; i++) {
        const template = malformedPayloads[i % malformedPayloads.length]!
        extraEvents.push({
          circleId: workCircle!.id,
          entryId: null,
          shortId: nextShort(),
          eventType: 'update',
          provenance: 'owner',
          after: template,
        })
      }
      await withCircle(database.db, workCircle!.id, async (tx) => {
        await tx.insert(entryEvents).values(extraEvents)
      })

      const insertedEvents = await withCircles(
        database.db,
        { read: [workCircle!.id, meCircle!.id, homeCircle!.id] },
        async (tx) => tx.select().from(entryEvents),
      )

      return {
        ownerId: owner!.id,
        otherId: other!.id,
        workCircleId: workCircle!.id,
        meCircleId: meCircle!.id,
        homeCircleId: homeCircle!.id,
        workSetup,
        insertedEntries,
        insertedEvents,
      }
    }

    function toEntryFacts(row: typeof entries.$inferSelect): EntryFacts {
      return {
        circleId: row.circleId,
        kind: row.kind,
        sensitivity: row.sensitivity,
        originScope: row.originScope,
        clientId: row.clientId,
        ownerAccountId: row.ownerAccountId,
        subjectKind: row.subjectKind,
        realms: row.realms,
        validTo: row.validTo,
        expiresAt: row.expiresAt,
        deletedAt: row.deletedAt,
      }
    }

    function buildGrants(ids: {
      workCircleId: string
      meCircleId: string
      homeCircleId: string
    }): CircleEffectiveGrant[] {
      return [
        {
          circleId: ids.workCircleId,
          circleSlug: 'work-circle',
          circleName: '工作圈',
          circleKind: 'shared',
          isPrimary: true,
          mode: 'read_write',
          readKinds: [...ENTRY_KINDS],
          writeKinds: [...ENTRY_KINDS],
          maxSensitivity: 'secret',
          credentials: 'manage',
          active: true,
        },
        {
          circleId: ids.meCircleId,
          circleSlug: 'me-circle',
          circleName: '主人的个人圈',
          circleKind: 'personal',
          isPrimary: false,
          mode: 'read',
          readKinds: [...ENTRY_KINDS],
          writeKinds: [],
          maxSensitivity: 'private',
          credentials: 'none',
          active: true,
        },
        {
          circleId: ids.homeCircleId,
          circleSlug: 'home-circle',
          circleName: '家庭圈',
          circleKind: 'shared',
          isPrimary: false,
          mode: 'read_write',
          readKinds: [...ENTRY_KINDS],
          writeKinds: ['entry'],
          maxSensitivity: 'private',
          credentials: 'none',
          active: true,
        },
      ]
    }

    it('全矩阵（3 圈 × 多种访问配置 × 3 种读取模式）在头表与事件快照上 JS 与 SQL 一致', async () => {
      const fx = await seedFixture()
      const grants = buildGrants(fx)
      const openScopes = {
        readKinds: [...ENTRY_KINDS],
        writeKinds: [...ENTRY_KINDS],
        maxSensitivity: 'secret' as const,
        allowedRealms: null,
        admin: true,
        credentials: 'manage' as const,
      }
      const workOnlyScopes = { ...openScopes, allowedRealms: ['work'] }

      const profiles: { name: string; access: Access }[] = [
        {
          name: 'unscoped-allowed-work',
          access: resolveAccess({
            primaryCircleId: fx.workCircleId,
            primaryCircleRealms: ['work'],
            scopes: workOnlyScopes,
            grants,
            staticContextRealms: new Set(),
            client: { clientId: fx.workSetup.c1, ownerAccountId: fx.ownerId },
          }),
        },
        {
          name: 'unscoped-context-work',
          access: resolveAccess({
            primaryCircleId: fx.workCircleId,
            primaryCircleRealms: ['work'],
            scopes: openScopes,
            grants,
            staticContextRealms: new Set(['work']),
            client: { clientId: fx.workSetup.c1, ownerAccountId: fx.ownerId },
          }),
        },
        {
          name: 'unscoped-realm-conflict',
          access: resolveAccess({
            primaryCircleId: fx.workCircleId,
            primaryCircleRealms: ['work'],
            scopes: workOnlyScopes,
            grants,
            staticContextRealms: new Set(['home']),
            client: { clientId: fx.workSetup.c1, ownerAccountId: fx.ownerId },
          }),
        },
        {
          name: 'unscoped-open',
          access: resolveAccess({
            primaryCircleId: fx.workCircleId,
            primaryCircleRealms: ['work'],
            scopes: openScopes,
            grants,
            staticContextRealms: new Set(),
            client: { clientId: fx.workSetup.c1, ownerAccountId: fx.ownerId },
          }),
        },
        {
          name: 'strict-group-1',
          access: resolveAccess({
            primaryCircleId: fx.workCircleId,
            primaryCircleRealms: ['work'],
            scopes: openScopes,
            grants,
            client: {
              clientId: fx.workSetup.c1,
              ownerAccountId: fx.ownerId,
              personMemoryMode: 'strict',
            },
            context: {
              chatType: 'group',
              groupSubjectId: fx.workSetup.g1,
              sharedGroupScopes: [`group:${fx.workSetup.g1}`, `group:${fx.workSetup.g2}`],
              lockedGroupScopes: [`group:${fx.workSetup.g3}`],
            },
          }),
        },
        {
          name: 'persona-shared-group-1',
          access: resolveAccess({
            primaryCircleId: fx.workCircleId,
            primaryCircleRealms: ['work'],
            scopes: openScopes,
            grants,
            client: {
              clientId: fx.workSetup.c1,
              ownerAccountId: fx.ownerId,
              personMemoryMode: 'persona_shared',
            },
            context: {
              chatType: 'group',
              groupSubjectId: fx.workSetup.g1,
              currentGroupIsolated: false,
              sharedGroupScopes: [`group:${fx.workSetup.g1}`, `group:${fx.workSetup.g2}`],
              lockedGroupScopes: [`group:${fx.workSetup.g3}`],
            },
          }),
        },
        {
          name: 'isolated-group-3',
          access: resolveAccess({
            primaryCircleId: fx.workCircleId,
            primaryCircleRealms: ['work'],
            scopes: openScopes,
            grants,
            client: {
              clientId: fx.workSetup.c1,
              ownerAccountId: fx.ownerId,
              personMemoryMode: 'persona_shared',
            },
            context: {
              chatType: 'group',
              groupSubjectId: fx.workSetup.g3,
              currentGroupIsolated: true,
              sharedGroupScopes: [],
              lockedGroupScopes: [`group:${fx.workSetup.g3}`],
            },
          }),
        },
        {
          name: 'stranger-direct',
          access: resolveAccess({
            primaryCircleId: fx.workCircleId,
            primaryCircleRealms: ['work'],
            scopes: openScopes,
            grants,
            client: {
              clientId: fx.workSetup.c1,
              ownerAccountId: fx.ownerId,
              elevateOwnerDirect: 'internal',
              personMemoryMode: 'persona_shared',
            },
            context: {
              chatType: 'direct',
              senderSubjectId: fx.workSetup.s1,
              senderIsOwner: false,
              sharedGroupScopes: [`group:${fx.workSetup.g1}`, `group:${fx.workSetup.g2}`],
              lockedGroupScopes: [`group:${fx.workSetup.g3}`],
            },
          }),
        },
        {
          name: 'owner-direct-plain',
          access: resolveAccess({
            primaryCircleId: fx.workCircleId,
            primaryCircleRealms: ['work'],
            scopes: openScopes,
            grants,
            client: {
              clientId: fx.workSetup.c1,
              ownerAccountId: fx.ownerId,
              personMemoryMode: 'persona_shared',
            },
            context: {
              chatType: 'direct',
              senderSubjectId: fx.workSetup.s2,
              senderIsOwner: true,
              sharedGroupScopes: [`group:${fx.workSetup.g1}`, `group:${fx.workSetup.g2}`],
              lockedGroupScopes: [`group:${fx.workSetup.g3}`],
            },
          }),
        },
        {
          name: 'owner-direct-elevated',
          access: resolveAccess({
            primaryCircleId: fx.workCircleId,
            primaryCircleRealms: ['work'],
            scopes: openScopes,
            grants,
            client: {
              clientId: fx.workSetup.c1,
              ownerAccountId: fx.ownerId,
              elevateOwnerDirect: 'internal',
              personMemoryMode: 'persona_shared',
            },
            context: {
              chatType: 'direct',
              senderSubjectId: fx.workSetup.s2,
              senderIsOwner: true,
              sharedGroupScopes: [`group:${fx.workSetup.g1}`, `group:${fx.workSetup.g2}`],
              lockedGroupScopes: [`group:${fx.workSetup.g3}`],
            },
          }),
        },
        {
          name: 'cron-access',
          access: resolveAccess({
            primaryCircleId: fx.workCircleId,
            primaryCircleRealms: ['work'],
            scopes: openScopes,
            grants,
            client: { clientId: fx.workSetup.c1, ownerAccountId: fx.ownerId },
            context: { chatType: 'cron' },
          }),
        },
        {
          name: 'console-work-owner',
          access: consoleAccess(fx.workCircleId, 'shared', 'owner', fx.ownerId, ['work']),
        },
        {
          name: 'console-work-editor',
          access: consoleAccess(fx.workCircleId, 'shared', 'editor', fx.otherId, ['work']),
        },
        {
          name: 'console-work-viewer',
          access: consoleAccess(fx.workCircleId, 'shared', 'viewer', fx.otherId, ['work']),
        },
        {
          name: 'console-me-owner',
          access: consoleAccess(fx.meCircleId, 'personal', 'owner', fx.ownerId, []),
        },
      ]

      const modes: { name: string; options: ReadOptions }[] = [
        { name: 'recall', options: { now: NOW } },
        { name: 'explicit', options: { explicit: true, now: NOW } },
        { name: 'management', options: { management: true } },
      ]

      await withCircles(
        database.db,
        { read: [fx.workCircleId, fx.meCircleId, fx.homeCircleId] },
        async (tx) => {
          for (const profile of profiles) {
            for (const mode of modes) {
              const sqlEntries = await tx
                .select({ id: entries.id })
                .from(entries)
                .where(readableConditions(profile.access, mode.options))
              const sqlIds = sqlEntries.map((r) => r.id).sort()
              const jsIds = fx.insertedEntries
                .filter((row) => canRead(profile.access, toEntryFacts(row), mode.options))
                .map((r) => r.id)
                .sort()
              expect(sqlIds, `entries mismatch for ${profile.name} / ${mode.name}`).toEqual(jsIds)

              const snapCols = snapshotColumns(entryEvents.after)
              const sqlEvents = await tx
                .select({ id: entryEvents.id })
                .from(entryEvents)
                .where(readableConditions(profile.access, mode.options, snapCols))
              const sqlEventIds = sqlEvents.map((r) => r.id).sort()
              const jsEventIds = fx.insertedEvents
                .filter((ev) => {
                  const facts = snapshotFacts(ev.after as Record<string, unknown> | null)
                  return facts ? canRead(profile.access, facts, mode.options) : false
                })
                .map((ev) => ev.id)
                .sort()
              expect(sqlEventIds, `snapshots mismatch for ${profile.name} / ${mode.name}`).toEqual(
                jsEventIds,
              )
            }
          }
        },
      )
    })

    it('关键安全边界与毫秒级有效期边界（EDGE ± 1ms）在 SQL 与 JS 上严格成立', async () => {
      const fx = await seedFixture()
      const grants = buildGrants(fx)
      const openScopes = {
        readKinds: [...ENTRY_KINDS],
        writeKinds: [...ENTRY_KINDS],
        maxSensitivity: 'secret' as const,
        allowedRealms: null,
        admin: true,
        credentials: 'manage' as const,
      }

      const unscopedOpen = resolveAccess({
        primaryCircleId: fx.workCircleId,
        primaryCircleRealms: ['work'],
        scopes: openScopes,
        grants,
        staticContextRealms: new Set(),
        client: { clientId: fx.workSetup.c1, ownerAccountId: fx.ownerId },
      })

      const personaSharedG1 = resolveAccess({
        primaryCircleId: fx.workCircleId,
        primaryCircleRealms: ['work'],
        scopes: openScopes,
        grants,
        client: {
          clientId: fx.workSetup.c1,
          ownerAccountId: fx.ownerId,
          personMemoryMode: 'persona_shared',
        },
        context: {
          chatType: 'group',
          groupSubjectId: fx.workSetup.g1,
          currentGroupIsolated: false,
          sharedGroupScopes: [`group:${fx.workSetup.g1}`, `group:${fx.workSetup.g2}`],
          lockedGroupScopes: [`group:${fx.workSetup.g3}`],
        },
      })

      const isolatedG3 = resolveAccess({
        primaryCircleId: fx.workCircleId,
        primaryCircleRealms: ['work'],
        scopes: openScopes,
        grants,
        client: {
          clientId: fx.workSetup.c1,
          ownerAccountId: fx.ownerId,
          personMemoryMode: 'persona_shared',
        },
        context: {
          chatType: 'group',
          groupSubjectId: fx.workSetup.g3,
          currentGroupIsolated: true,
          sharedGroupScopes: [],
          lockedGroupScopes: [`group:${fx.workSetup.g3}`],
        },
      })

      const ownerDirectElevated = resolveAccess({
        primaryCircleId: fx.workCircleId,
        primaryCircleRealms: ['work'],
        scopes: openScopes,
        grants,
        client: {
          clientId: fx.workSetup.c1,
          ownerAccountId: fx.ownerId,
          elevateOwnerDirect: 'internal',
          personMemoryMode: 'persona_shared',
        },
        context: {
          chatType: 'direct',
          senderSubjectId: fx.workSetup.s2,
          senderIsOwner: true,
          sharedGroupScopes: [`group:${fx.workSetup.g1}`, `group:${fx.workSetup.g2}`],
          lockedGroupScopes: [`group:${fx.workSetup.g3}`],
        },
      })

      await withCircles(
        database.db,
        { read: [fx.workCircleId, fx.meCircleId, fx.homeCircleId] },
        async (tx) => {
          // 客场 secret 即使 explicit 也绝不放行
          const awaySecretRows = await tx
            .select({ circleId: entries.circleId, sensitivity: entries.sensitivity })
            .from(entries)
            .where(readableConditions(unscopedOpen, { explicit: true, now: NOW }))
          expect(
            awaySecretRows.some(
              (r) => r.circleId !== fx.workCircleId && r.sensitivity === 'secret',
            ),
          ).toBe(false)

          // 拟人跨群模式下，同一 client（c1 及 null）在未锁群 g2 的 person fact 可跨到 g1，
          // 但 c2 的同群 person fact、g2 的 group fact/episode 以及加锁群 g3 的 fact 一律隔离
          const g1Rows = await tx
            .select({
              id: entries.id,
              kind: entries.kind,
              subjectKind: entries.subjectKind,
              originScope: entries.originScope,
              clientId: entries.clientId,
            })
            .from(entries)
            .where(readableConditions(personaSharedG1, { now: NOW }))

          expect(
            g1Rows.some(
              (r) =>
                r.originScope === `group:${fx.workSetup.g2}` &&
                r.kind === 'fact' &&
                r.subjectKind === 'person' &&
                r.clientId === fx.workSetup.c1,
            ),
          ).toBe(true)
          expect(
            g1Rows.some(
              (r) =>
                r.originScope === `group:${fx.workSetup.g2}` &&
                r.kind === 'fact' &&
                r.subjectKind === 'person' &&
                r.clientId === null,
            ),
          ).toBe(true)
          expect(
            g1Rows.some(
              (r) => r.originScope === `group:${fx.workSetup.g2}` && r.clientId === fx.workSetup.c2,
            ),
          ).toBe(false)
          expect(
            g1Rows.some(
              (r) =>
                r.originScope === `group:${fx.workSetup.g2}` &&
                (r.subjectKind === 'group' || r.kind === 'episode'),
            ),
          ).toBe(false)
          expect(g1Rows.some((r) => r.originScope === `group:${fx.workSetup.g3}`)).toBe(false)

          // 单群强隔离锁启用后，本群不可读取任何他群记录
          const g3Rows = await tx
            .select({ originScope: entries.originScope })
            .from(entries)
            .where(readableConditions(isolatedG3, { now: NOW }))
          expect(
            g3Rows.some(
              (r) =>
                r.originScope === `group:${fx.workSetup.g1}` ||
                r.originScope === `group:${fx.workSetup.g2}`,
            ),
          ).toBe(false)

          // 本人私聊即使提权到 internal，也绝不读取本地（ownerAccountId 非空）的会话摘要
          const directRows = await tx
            .select({ kind: entries.kind, ownerAccountId: entries.ownerAccountId })
            .from(entries)
            .where(readableConditions(ownerDirectElevated, { now: NOW }))
          expect(directRows.some((r) => r.kind === 'episode' && r.ownerAccountId !== null)).toBe(
            false,
          )

          // EDGE 毫秒级边界测试：at < EDGE 仍有效，at === EDGE 与 at > EDGE 立即过期
          const edgeAccess = consoleAccess(fx.workCircleId, 'shared', 'owner', fx.ownerId, ['work'])
          const edgeEntry = fx.insertedEntries.find(
            (e) => e.title === 'work-lc-edgeValidTo-public',
          )!
          const edgeExpEntry = fx.insertedEntries.find(
            (e) => e.title === 'work-lc-edgeExpiresAt-public',
          )!
          for (const delta of [-1, 0, 1]) {
            const at = new Date(EDGE.getTime() + delta)
            const sqlMatched = await tx
              .select({ id: entries.id })
              .from(entries)
              .where(
                and(
                  inArray(entries.id, [edgeEntry.id, edgeExpEntry.id]),
                  readableConditions(edgeAccess, { now: at }),
                ),
              )
            const sqlSet = sqlMatched.map((r) => r.id).sort()
            const jsSet = [edgeEntry, edgeExpEntry]
              .filter((e) => canRead(edgeAccess, toEntryFacts(e), { now: at }))
              .map((e) => e.id)
              .sort()
            expect(sqlSet).toEqual(jsSet)
            if (delta < 0) {
              expect(sqlSet).toHaveLength(2)
            } else {
              expect(sqlSet).toHaveLength(0)
            }
          }
        },
      )
    })
  },
)
