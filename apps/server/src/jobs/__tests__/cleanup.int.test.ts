import { randomBytes } from 'node:crypto'

import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { pruneBindingData } from '../../access/binding'
import { createPersonalCircle } from '../../access/circles'
import { createClient } from '../../access/clients'
import { pruneAttempts } from '../../auth/rateLimit'
import { withCircle, type Database } from '../../db/client'
import {
  accounts,
  entries,
  entryEmbeddings,
  loginAttempts,
  sessions,
  settings,
  subjectBindAttempts,
  subjectBindCodes,
  subjects,
} from '../../db/schema'
import { saveActiveEmbedding } from '../../embedding/settings'
import { dropIneligibleEmbeddings, embedEntries } from '../../embedding/worker'
import { consoleMemberFor } from '../../memory/context'
import { createModelProvider } from '../../models/store'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { cleanupExpired } from '../cleanup'

describe.skipIf(!testDatabaseUrl)('定时清理', () => {
  let database: Database
  const masterKey = randomBytes(32)
  let accountId: string
  let circleId: string

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(async () => {
    if (!database) return
    await database.db
      .delete(settings)
      .where(inArray(settings.key, ['embedding', 'model-providers', 'model-bindings']))
    await database.close()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    await database.db
      .delete(settings)
      .where(inArray(settings.key, ['embedding', 'model-providers', 'model-bindings']))
    const seeded = await database.db.transaction(async (tx) => {
      const [account] = await tx
        .insert(accounts)
        .values({ username: 'alice', displayName: 'Alice', passwordHash: 'hash' })
        .returning()
      const personal = await createPersonalCircle(tx, account!)
      return { accountId: account!.id, circleId: personal.id }
    })
    accountId = seeded.accountId
    circleId = seeded.circleId
  })

  const past = () => new Date(Date.now() - 60_000)
  const future = () => new Date(Date.now() + 60_000)

  it('只清掉过期的会话与登录失败计数', async () => {
    await database.db.insert(sessions).values([
      { accountId, tokenHash: 'old', expiresAt: past() },
      { accountId, tokenHash: 'live', expiresAt: future() },
    ])
    await database.db.insert(loginAttempts).values([
      { username: '["old"]', count: 3, resetAt: past() },
      { username: '["live"]', count: 3, resetAt: future() },
    ])

    expect(await cleanupExpired(database.db)).toEqual({
      sessions: 1,
      links: 0,
      deviceGrants: 0,
      attempts: 1,
      recallEvents: 0,
      turns: 0,
      bindCodes: 0,
      bindAttempts: 0,
      embeddings: 0,
    })

    const left = await database.db.select({ hash: sessions.tokenHash }).from(sessions)
    expect(left.map((s) => s.hash)).toEqual(['live'])
    const attempts = await database.db.select().from(loginAttempts)
    expect(attempts.map((a) => a.username)).toEqual(['["live"]'])
  })

  it('清理登录计数时跳过正被登录请求锁住的行，不等锁', async () => {
    await database.db.insert(loginAttempts).values([
      { username: '["busy"]', count: 3, resetAt: past() },
      { username: '["idle"]', count: 3, resetAt: past() },
    ])
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from login_attempts where username = '["busy"]' for update`)
      expect(await pruneAttempts(database.db)).toBe(1)
    })
    const [busy] = await database.db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.username, '["busy"]'))
    expect(busy?.count).toBe(3)
    expect(await pruneAttempts(database.db)).toBe(1)
  })

  it('只清掉过期的绑定码（用过的到期也删）与过了窗口的输错绑定码计数', async () => {
    await withCircle(database.db, circleId, async (tx) => {
      const created = await createClient(tx, {
        circleId,
        ownerAccountId: accountId,
        slug: 'qq-bot',
        name: 'QQ Bot',
        runtimeFamily: 'astrbot',
      })
      if (!created.ok) throw new Error('建接入实例失败')
      const clientId = created.client.id
      const [subject] = await tx
        .insert(subjects)
        .values({ circleId, kind: 'person', displayName: '小明' })
        .returning()
      const code = (codeHash: string, expiresAt: Date, usedAt: Date | null = null) => ({
        circleId,
        clientId,
        keyId: clientId,
        subjectId: subject!.id,
        platform: 'qq',
        externalId: '1001',
        codeHash,
        expiresAt,
        usedAt,
      })
      await tx
        .insert(subjectBindCodes)
        .values([code('old', past()), code('used', past(), past()), code('live', future())])
      await tx.insert(subjectBindAttempts).values([
        { circleId, clientId, key: '["old"]', count: 5, resetAt: past() },
        { circleId, clientId, key: '["live"]', count: 5, resetAt: future() },
      ])
    })

    expect(await cleanupExpired(database.db)).toMatchObject({ bindCodes: 2, bindAttempts: 1 })
    const left = await withCircle(database.db, circleId, async (tx) => ({
      codes: await tx.select({ hash: subjectBindCodes.codeHash }).from(subjectBindCodes),
      attempts: await tx.select({ key: subjectBindAttempts.key }).from(subjectBindAttempts),
    }))
    expect(left).toEqual({ codes: [{ hash: 'live' }], attempts: [{ key: '["live"]' }] })

    await withCircle(database.db, circleId, (tx) =>
      tx.update(subjectBindAttempts).set({ resetAt: past() }),
    )
    await withCircle(database.db, circleId, async (tx) => {
      await tx.execute(sql`select 1 from subject_bind_attempts for update`)
      expect(await pruneBindingData(database.db)).toEqual({ codes: 0, attempts: 0 })
    })
    expect(await pruneBindingData(database.db)).toEqual({ codes: 0, attempts: 1 })
  })

  it('词条到期之后，它留下的向量由清理删掉；正被别的事务锁着的这次跳过，下一次再删', async () => {
    const { provider } = await createModelProvider(database.db, masterKey, {
      format: 'openai-chat',
      name: 'test-embed',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test-1234',
      profiles: [{ kind: 'embedding', label: null, model: 'fake-embedding' }],
    })
    await saveActiveEmbedding(database.db, {
      model: 'fake-embedding',
      profileIds: [provider.profiles[0]!.id],
    })
    const embedder = fakeEmbedder('fake-embedding')
    const { service } = await consoleMemberFor(
      { db: database.db, masterKey, jobs: null },
      circleId,
      accountId,
    )

    const create = async (content: string) => {
      const entry = await service.create({ content })
      expect(await embedEntries(database.db, embedder, circleId, [entry.id])).toBe(1)
      return entry.id
    }
    const kept = await create('仍在有效期内的长期笔记')
    const lapsed = await create('已经过期的长期笔记')

    await withCircle(database.db, circleId, (tx) =>
      tx.update(entries).set({ validTo: past() }).where(eq(entries.id, lapsed)),
    )
    const vectors = async () =>
      (
        await withCircle(database.db, circleId, (tx) =>
          tx.select({ id: entryEmbeddings.entryId }).from(entryEmbeddings),
        )
      ).map((r) => r.id)

    const whileLocked = async (lock: string) => {
      let locked!: () => void
      let release!: () => void
      const ready = new Promise<void>((resolve) => (locked = resolve))
      const held = new Promise<void>((resolve) => (release = resolve))
      const holder = withCircle(database.db, circleId, async (tx) => {
        await tx.execute(sql.raw(lock))
        locked()
        await held
      })
      await ready
      const run = dropIneligibleEmbeddings(database.db)
      try {
        return await Promise.race([
          run,
          new Promise((resolve) => setTimeout(() => resolve('等锁'), 3_000)),
        ])
      } finally {
        release()
        await holder
        await Promise.allSettled([run])
      }
    }

    expect(await whileLocked(`select 1 from entries where id = '${lapsed}' for update`)).toBe(0)
    expect(
      await whileLocked(`select 1 from entries where id = '${lapsed}' for no key update`),
    ).toBe(0)
    expect(
      await whileLocked(`select 1 from entry_embeddings where entry_id = '${lapsed}' for update`),
    ).toBe(0)
    expect(await vectors()).toHaveLength(2)

    expect(await cleanupExpired(database.db)).toMatchObject({ embeddings: 1 })
    expect(await vectors()).toEqual([kept])
    expect(await cleanupExpired(database.db)).toMatchObject({ embeddings: 0 })
  })
})
