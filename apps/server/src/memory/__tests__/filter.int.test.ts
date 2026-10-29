import { LAYERS, SENSITIVITIES, type KeyScopes } from '@kioku/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  canRead,
  consoleAccess,
  resolveAccess,
  type Access,
  type SessionContext,
} from '../../access/access'
import { withSpace, type Database } from '../../db/client'
import { accounts, apps, memories, memoryEvents, personas, spaces } from '../../db/schema'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { readableConditions, snapshotColumns, snapshotFacts } from '../filter'

// edge 那几条的有效到：按时间点判断时，正好在这一刻前后比对
const EDGE = new Date('2030-01-01T00:00:00.000Z')

// 用同一批覆盖各种组合的记忆，逐条比对 SQL 过滤与 canRead 的结论
describe.skipIf(!testDatabaseUrl)('SQL 过滤与 canRead 一致', () => {
  let database: Database
  let spaceId: string
  let owner: string
  let other: string
  let appId: string
  let personaId: string
  let foreignPersona: string

  beforeAll(async () => {
    database = await openTestDatabase()
    await resetDatabase(database)
    const { db } = database
    const [space] = await db.insert(spaces).values({ name: 'S' }).returning()
    spaceId = space!.id
    const accs = await db
      .insert(accounts)
      .values([
        { username: 'o', displayName: 'o', passwordHash: 'x' },
        { username: 'p', displayName: 'p', passwordHash: 'x' },
      ])
      .returning()
    owner = accs[0]!.id
    other = accs[1]!.id

    await withSpace(db, spaceId, async (tx) => {
      const ps = await tx
        .insert(personas)
        .values([
          { spaceId, slug: 'a', name: 'a' },
          { spaceId, slug: 'b', name: 'b' },
        ])
        .returning()
      personaId = ps[0]!.id
      foreignPersona = ps[1]!.id
      const as = await tx
        .insert(apps)
        .values([
          { spaceId, slug: 'x', name: 'x', runtimeFamily: 'mcp', ownerAccountId: owner },
          { spaceId, slug: 'y', name: 'y', runtimeFamily: 'mcp', ownerAccountId: owner },
        ])
        .returning()
      appId = as[0]!.id
      const otherApp = as[1]!.id

      const past = new Date(Date.now() - 86_400_000)
      const future = new Date(Date.now() + 86_400_000)
      const scopes = ['global', `app:${appId}`, 'group:g1', 'group:g2', 'direct:s1']
      const rows: (typeof memories.$inferInsert)[] = []
      let n = 0
      // expired 是有效到已过，lapsed 是到期时间已过，future 是有效到还没到，edge 的有效到正好是 EDGE
      const variants = ['own', 'foreign', 'expired', 'lapsed', 'future', 'edge', 'deleted'] as const
      for (const layer of LAYERS) {
        for (const sensitivity of SENSITIVITIES) {
          for (const originScope of scopes) {
            for (const variant of variants) {
              n++
              const secret = sensitivity === 'secret'
              rows.push({
                spaceId,
                form: 'curated',
                layer,
                sensitivity,
                provenance: layer === 'subject' || layer === 'episode' ? 'untrusted' : 'agent',
                originScope,
                domain: 'd',
                path: `m${n}`,
                content: secret ? null : 'c',
                ciphertext: secret ? Buffer.from('x') : null,
                wrappedKey: secret ? Buffer.from('x') : null,
                ownerAccountId:
                  layer === 'owner' || layer === 'private'
                    ? variant === 'foreign'
                      ? other
                      : owner
                    : null,
                personaId:
                  layer === 'persona' ? (variant === 'foreign' ? foreignPersona : personaId) : null,
                appId: layer === 'app' ? (variant === 'foreign' ? otherApp : appId) : null,
                subjectId: null,
                validTo:
                  variant === 'expired'
                    ? past
                    : variant === 'future'
                      ? future
                      : variant === 'edge'
                        ? EDGE
                        : null,
                expiresAt: variant === 'lapsed' ? past : null,
                deletedAt: variant === 'deleted' ? past : null,
              })
            }
          }
        }
      }
      // subject 层需要真实对象，这里改为不挂对象的 episode 来覆盖来源作用域
      const inserted = await tx
        .insert(memories)
        .values(rows.map((r) => (r.layer === 'subject' ? { ...r, layer: 'episode' as const } : r)))
        .returning()
      // 每条记忆再记一个事件，「改后」快照就是这一行，用来比对快照上的 SQL 条件；
      // 另外几十条缺字段的旧快照，两边的处理也要一致
      const snap = (m: (typeof inserted)[number]) =>
        JSON.parse(
          JSON.stringify({ ...m, ciphertext: null, wrappedKey: null, fts: null }),
        ) as Record<string, unknown>
      const without = (m: (typeof inserted)[number], key: string) => {
        const s = snap(m)
        delete s[key]
        return s
      }
      await tx.insert(memoryEvents).values([
        ...inserted.map((m) => ({
          spaceId,
          memoryId: m.id,
          eventType: 'create',
          provenance: m.provenance,
          after: snap(m),
        })),
        ...inserted.slice(0, 40).flatMap((m) =>
          ['layer', 'sensitivity', 'originScope', 'ownerAccountId'].map((key) => ({
            spaceId,
            memoryId: m.id,
            eventType: 'update',
            provenance: m.provenance,
            after: without(m, key),
          })),
        ),
      ])
    })
  })

  afterAll(async () => {
    await database?.close()
  })

  const full: KeyScopes = {
    readLayers: [...LAYERS],
    writeLayers: [...LAYERS],
    maxSensitivity: 'secret',
    admin: false,
  }
  const cases: [string, KeyScopes, SessionContext][] = [
    ['无上下文 · 全权限', full, {}],
    ['无上下文 · 只读 base 与 persona', { ...full, readLayers: ['base', 'persona'] }, {}],
    ['无上下文 · public 上限', { ...full, maxSensitivity: 'public' }, {}],
    ['群聊 g1', full, { chatType: 'group', groupSubjectId: 'g1' }],
    ['陌生人私聊 s1', full, { chatType: 'direct', senderSubjectId: 's1' }],
    ['定时任务', full, { chatType: 'cron' }],
  ]

  const accesses: [string, () => Access][] = [
    ...cases.map(
      ([name, scopes, context]) =>
        [name, () => resolveAccess(scopes, { appId, ownerAccountId: owner }, context)] as [
          string,
          () => Access,
        ],
    ),
    // 管理界面：不代表某个应用（appId 为 null），三种角色
    ['管理界面 · owner', () => consoleAccess('owner', owner)],
    ['管理界面 · editor', () => consoleAccess('editor', owner)],
    ['管理界面 · viewer', () => consoleAccess('viewer', owner)],
  ]

  const modes = [
    ['', { explicit: false }],
    [' · 显式读取', { explicit: true }],
    [' · 管理读取', { management: true }],
  ] as const

  for (const [name, makeAccess] of accesses) {
    for (const [suffix, mode] of modes) {
      it(`${name}${suffix}`, async () => {
        const access = makeAccess()
        const options = { personaIds: [personaId], ...mode }
        const all = await withSpace(database.db, spaceId, (tx) => tx.select().from(memories))
        const expected = all
          .filter((m) => canRead(access, m, options))
          .map((m) => m.id)
          .sort()
        const actual = (
          await withSpace(database.db, spaceId, (tx) =>
            tx
              .select({ id: memories.id })
              .from(memories)
              .where(readableConditions(access, options)),
          )
        )
          .map((r) => r.id)
          .sort()
        expect(all.length).toBeGreaterThan(400)
        expect(actual).toEqual(expected)
      })

      it(`${name}${suffix} · 事件快照`, async () => {
        const access = makeAccess()
        const options = { personaIds: [personaId], ...mode }
        const events = await withSpace(database.db, spaceId, (tx) => tx.select().from(memoryEvents))
        const expected = events
          .filter((e) => {
            const facts = snapshotFacts(e.after as Record<string, unknown>)
            return facts !== null && canRead(access, facts, options)
          })
          .map((e) => e.id)
          .sort((a, b) => a - b)
        const actual = (
          await withSpace(database.db, spaceId, (tx) =>
            tx
              .select({ id: memoryEvents.id })
              .from(memoryEvents)
              .where(readableConditions(access, options, snapshotColumns(memoryEvents.after))),
          )
        )
          .map((r) => r.id)
          .sort((a, b) => a - b)
        expect(events.length).toBeGreaterThan(400)
        expect(actual).toEqual(expected)
      })
    }
  }

  it('有效期的边界：到了有效到的那一刻就算过期，记忆表与快照两边都和 canRead 一致', async () => {
    const access = consoleAccess('owner', owner)
    const all = await withSpace(database.db, spaceId, (tx) => tx.select().from(memories))
    const events = await withSpace(database.db, spaceId, (tx) => tx.select().from(memoryEvents))
    const edge = all.filter((m) => m.validTo?.getTime() === EDGE.getTime()).map((m) => m.id)
    expect(edge.length).toBeGreaterThan(0)
    for (const [offset, readable] of [
      [-1, true],
      [0, false],
      [1, false],
    ] as const) {
      const options = { personaIds: [personaId], now: new Date(EDGE.getTime() + offset) }
      const expected = all
        .filter((m) => canRead(access, m, options))
        .map((m) => m.id)
        .sort()
      const actual = (
        await withSpace(database.db, spaceId, (tx) =>
          tx.select({ id: memories.id }).from(memories).where(readableConditions(access, options)),
        )
      )
        .map((r) => r.id)
        .sort()
      expect(actual).toEqual(expected)
      expect(edge.some((id) => expected.includes(id))).toBe(readable)

      const expectedEvents = events
        .filter((e) => {
          const facts = snapshotFacts(e.after as Record<string, unknown>)
          return facts !== null && canRead(access, facts, options)
        })
        .map((e) => e.id)
        .sort((a, b) => a - b)
      const actualEvents = (
        await withSpace(database.db, spaceId, (tx) =>
          tx
            .select({ id: memoryEvents.id })
            .from(memoryEvents)
            .where(readableConditions(access, options, snapshotColumns(memoryEvents.after))),
        )
      )
        .map((r) => r.id)
        .sort((a, b) => a - b)
      expect(actualEvents).toEqual(expectedEvents)
    }
  })

  it('管理读取不看有效期、删除状态与人格，按显式读取算', () => {
    const facts = {
      layer: 'persona' as const,
      sensitivity: 'secret' as const,
      originScope: 'global',
      ownerAccountId: null,
      personaId: foreignPersona,
      appId: null,
      validTo: new Date(0),
      expiresAt: null,
      deletedAt: new Date(0),
    }
    const owner = consoleAccess('owner', 'someone')
    expect(canRead(owner, facts, { personaIds: [], management: true })).toBe(true)
    expect(canRead(owner, facts, { personaIds: [personaId], explicit: true })).toBe(false)
    // secret 仍然只给读得到 secret 的成员
    expect(
      canRead(consoleAccess('editor', 'someone'), facts, { personaIds: [], management: true }),
    ).toBe(false)
  })
})
