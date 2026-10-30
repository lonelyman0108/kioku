import { randomBytes } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { pruneBindingData } from '../../access/binding'
import { createApp } from '../../app'
import { pruneAttempts } from '../../auth/rateLimit'
import { withSpace, type Database } from '../../db/client'
import {
  loginAttempts,
  memories,
  memoryEmbeddings,
  sessions,
  settings,
  subjectBindAttempts,
  subjectBindCodes,
  subjects,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { dropIneligibleEmbeddings, embedMemories } from '../../embedding/worker'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { cleanupExpired } from '../cleanup'

describe.skipIf(!testDatabaseUrl)('定时清理', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
    ws = await bootstrap(app)
  })

  const past = () => new Date(Date.now() - 60_000)
  const future = () => new Date(Date.now() + 60_000)

  it('只清掉过期的会话与登录失败计数', async () => {
    await database.db.insert(sessions).values([
      { accountId: ws.accountId, tokenHash: 'old', expiresAt: past() },
      { accountId: ws.accountId, tokenHash: 'live', expiresAt: future() },
    ])
    await database.db.insert(loginAttempts).values([
      { username: '["old"]', count: 3, resetAt: past() },
      { username: '["live"]', count: 3, resetAt: future() },
    ])
    expect(await cleanupExpired(database.db)).toEqual({
      sessions: 1,
      attempts: 1,
      recallEvents: 0,
      turns: 0,
      bindCodes: 0,
      bindAttempts: 0,
      embeddings: 0,
    })
    // 初始化时登录的那个会话和 live 都还在
    const left = await database.db.select({ hash: sessions.tokenHash }).from(sessions)
    expect(left).toHaveLength(2)
    expect(left.some((s) => s.hash === 'old')).toBe(false)
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
    const { id: appId } = await ws.createApp('qq-bot', { runtimeFamily: 'astrbot' })
    await withSpace(database.db, ws.spaceId, async (tx) => {
      const [subject] = await tx
        .insert(subjects)
        .values({ spaceId: ws.spaceId, kind: 'person', displayName: '小明' })
        .returning()
      const code = (codeHash: string, expiresAt: Date, usedAt: Date | null = null) => ({
        spaceId: ws.spaceId,
        appId,
        keyId: appId,
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
        { spaceId: ws.spaceId, appId, key: '["old"]', count: 5, resetAt: past() },
        { spaceId: ws.spaceId, appId, key: '["live"]', count: 5, resetAt: future() },
      ])
    })
    expect(await cleanupExpired(database.db)).toMatchObject({ bindCodes: 2, bindAttempts: 1 })
    const left = await withSpace(database.db, ws.spaceId, async (tx) => ({
      codes: await tx.select({ hash: subjectBindCodes.codeHash }).from(subjectBindCodes),
      attempts: await tx.select({ key: subjectBindAttempts.key }).from(subjectBindAttempts),
    }))
    expect(left).toEqual({ codes: [{ hash: 'live' }], attempts: [{ key: '["live"]' }] })
    // 正被用码的请求锁着的计数这次跳过，不等锁
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.update(subjectBindAttempts).set({ resetAt: past() }),
    )
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.space_id', ${ws.spaceId}, true)`)
      await tx.execute(sql`select 1 from subject_bind_attempts for update`)
      expect(await pruneBindingData(database.db)).toEqual({ codes: 0, attempts: 0 })
    })
    expect(await pruneBindingData(database.db)).toEqual({ codes: 0, attempts: 1 })
  })

  it('记忆到期之后，它留下的向量由清理删掉；正被别的事务锁着的这次跳过，下一次再删', async () => {
    // 别的测试留下的嵌入设置会让向量任务不写这个模型的向量
    await database.db.delete(settings).where(eq(settings.key, 'embedding'))
    const embedder = fakeEmbedder()
    const create = async (uri: string) => {
      const res = await app.request(
        `/v1/spaces/${ws.spaceId}/memories`,
        jsonRequest('POST', { uri, content: uri, layer: 'base' }, { cookie: ws.cookie }),
      )
      expect(res.status).toBe(201)
      const { id } = (await res.json()) as { id: string }
      expect(await embedMemories(database.db, embedder, ws.spaceId, [id])).toBe(1)
      return id
    }
    const kept = await create('kb://kept')
    const lapsed = await create('kb://lapsed')
    // 到期是时间到了，没有写入，也就没有向量任务来删它的向量
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.update(memories).set({ validTo: past() }).where(eq(memories.id, lapsed)),
    )
    const vectors = async () =>
      (
        await withSpace(database.db, ws.spaceId, (tx) =>
          tx.select({ id: memoryEmbeddings.memoryId }).from(memoryEmbeddings),
        )
      ).map((r) => r.id)

    // 别的事务锁着这一行时清理跳过它，不等锁：等的话这几秒里做不完
    const whileLocked = async (lock: string) => {
      let locked!: () => void
      let release!: () => void
      const ready = new Promise<void>((resolve) => (locked = resolve))
      const held = new Promise<void>((resolve) => (release = resolve))
      const holder = database.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.space_id', ${ws.spaceId}, true)`)
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
    // 记忆正被别的事务改着（例如正在重新生效）：不删它刚生成的向量
    expect(await whileLocked(`select 1 from memories where id = '${lapsed}' for update`)).toBe(0)
    // 向量行正被别的事务锁着（例如换模型之后删旧向量）
    expect(
      await whileLocked(`select 1 from memory_embeddings where memory_id = '${lapsed}' for update`),
    ).toBe(0)
    expect(await vectors()).toHaveLength(2)
    expect(await cleanupExpired(database.db)).toMatchObject({ embeddings: 1 })
    expect(await vectors()).toEqual([kept])
    expect(await cleanupExpired(database.db)).toMatchObject({ embeddings: 0 })
  })
})
