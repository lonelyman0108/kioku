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
import { accounts, apps, memories, personas, spaces } from '../../db/schema'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { readableConditions } from '../filter'

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
      const scopes = ['global', `app:${appId}`, 'group:g1', 'group:g2', 'direct:s1']
      const rows: (typeof memories.$inferInsert)[] = []
      let n = 0
      for (const layer of LAYERS) {
        for (const sensitivity of SENSITIVITIES) {
          for (const originScope of scopes) {
            for (const variant of ['own', 'foreign', 'expired'] as const) {
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
                validTo: variant === 'expired' ? past : null,
              })
            }
          }
        }
      }
      // subject 层需要真实对象，这里改为不挂对象的 episode 来覆盖来源作用域
      await tx
        .insert(memories)
        .values(rows.map((r) => (r.layer === 'subject' ? { ...r, layer: 'episode' as const } : r)))
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

  for (const [name, makeAccess] of accesses) {
    for (const explicit of [false, true]) {
      it(`${name}${explicit ? ' · 显式读取' : ''}`, async () => {
        const access = makeAccess()
        const options = { personaIds: [personaId], explicit }
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
    }
  }
})
