import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPersonalCircle, createSharedCircle } from '../../access/circles'
import { createClient } from '../../access/clients'
import { saveCirclePrivacy } from '../../credential/privacy'
import { withCircle, type Database, type Db } from '../../db/client'
import {
  EMBEDDING_DIMENSIONS,
  accounts,
  conversations,
  entries,
  entryEmbeddings,
  entryVariants,
  settings,
  subjects,
} from '../../db/schema'
import { backfillJob, embedJobs, pruneJob, switchJob } from '../../embedding/jobs'
import type { Embedder } from '../../embedding/provider'
import { saveActiveEmbedding, saveNextEmbedding } from '../../embedding/settings'
import { staticEmbedderSource } from '../../embedding/source'
import { dropIneligibleEmbeddings, embedEntries } from '../../embedding/worker'
import type { Deps } from '../../http/env'
import { entryServiceForConsole } from '../../memory/entryContext'
import { createModelProvider } from '../../models/store'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'

function unitVector(seedText: string): number[] {
  const digest = createHash('sha256').update(seedText).digest()
  const vec = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => {
    const byte = digest[i % digest.length]!
    return (byte - 128) / 128
  })
  const norm = Math.hypot(...vec) || 1
  return vec.map((v) => v / norm)
}

function mockEmbedder(model: string, calls?: string[]): Embedder {
  return {
    model,
    async embed(texts) {
      if (calls) calls.push(...texts)
      return texts.map((t) => unitVector(`${model}\0${t}`))
    },
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

function makeDeps(db: Db): Deps {
  return {
    db,
    cookieSecure: false,
    masterKey: Buffer.alloc(32, 7),
    embedder: staticEmbedderSource(null),
    jobs: null,
  }
}

describe.skipIf(!testDatabaseUrl)('切片级向量化、出站打码、xmin 防覆写与换模清理', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
  })

  afterAll(async () => {
    await database.close()
  })

  it('为多变体 entry 与 fact 分别建向量，排除 episode 与 secret，执行出站脱敏，并清理失效向量', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    const sharedRes = await createSharedCircle(database.db, {
      name: '研发圈',
      defaultFacets: { realm: ['work'] },
      ownerAccountId: alice.id,
    })
    if (!sharedRes.ok) throw new Error('建圈失败')
    const circleId = sharedRes.value.id

    await saveCirclePrivacy(database.db, circleId, {
      customRules: [{ kind: 'project_code', regex: 'SECRET_PROJECT_[A-Z0-9]+' }],
    })

    const deps = makeDeps(database.db)
    const consoleSvc = await entryServiceForConsole(deps, circleId, alice.id)

    const multi = await consoleSvc.create({
      title: '发布命令 SECRET_PROJECT_X',
      variants: [
        { when: { env: ['mac'] }, content: 'mac 上部署 SECRET_PROJECT_X', sortOrder: 0 },
        { when: { env: ['win'] }, content: 'win 上部署规则', sortOrder: 1 },
      ],
      glossary: ['部署命令'],
      allowPlaintext: true,
    })
    const secretEntry = await consoleSvc.create({
      title: '机密配置',
      content: 'top secret value',
      sensitivity: 'secret',
    })

    // 写入一条 fact 和一条 episode（episode 绝不参与向量化）
    const { factId, epId } = await withCircle(database.db, circleId, async (tx) => {
      const [sub] = await tx
        .insert(subjects)
        .values({ circleId, kind: 'person', displayName: '张三' })
        .returning()
      const cRes = await createClient(tx, {
        circleId,
        ownerAccountId: alice.id,
        slug: 'bot',
        name: '机器人',
        runtimeFamily: 'astrbot',
      })
      if (!cRes.ok) throw new Error('建实例失败')
      const [conv] = await tx
        .insert(conversations)
        .values({ circleId, clientId: cRes.client.id, kind: 'direct', subjectId: sub!.id })
        .returning()
      const [f] = await tx
        .insert(entries)
        .values({
          circleId,
          shortId: 'm-222222',
          circleKind: 'shared',
          kind: 'fact',
          clientId: cRes.client.id,
          subjectId: sub!.id,
          subjectKind: 'person',
          conversationId: conv!.id,
          provenance: 'untrusted',
          originScope: `direct:${sub!.id}`,
          title: '张三喜欢喝美式',
          sensitivity: 'public',
          priority: 2,
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId,
        entryId: f!.id,
        kind: 'fact',
        sensitivity: 'public',
        when: {},
        whenSignature: '{}',
        sortOrder: 0,
        content: '张三每天喝一杯美式咖啡',
        searchHeader: '张三喜欢喝美式',
      })
      const [ep] = await tx
        .insert(entries)
        .values({
          circleId,
          shortId: 'm-222223',
          circleKind: 'shared',
          kind: 'episode',
          clientId: cRes.client.id,
          conversationId: conv!.id,
          provenance: 'untrusted',
          originScope: `direct:${sub!.id}`,
          title: '咖啡对话摘要',
          sensitivity: 'public',
          priority: 2,
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId,
        entryId: ep!.id,
        kind: 'episode',
        sensitivity: 'public',
        when: {},
        whenSignature: '{}',
        sortOrder: 0,
        content: '今天聊到了美式咖啡。',
        searchHeader: '咖啡对话摘要',
      })
      return { factId: f!.id, epId: ep!.id }
    })

    const sentTexts: string[] = []
    const embedder = mockEmbedder('embed-alpha', sentTexts)
    const written = await embedEntries(database.db, embedder, circleId, [
      multi.id,
      secretEntry.id,
      factId,
      epId,
    ])
    expect(written).toBe(3)
    expect(sentTexts.every((t) => !t.includes('SECRET_PROJECT_X'))).toBe(true)
    expect(sentTexts.some((t) => t.includes('[REDACTED:'))).toBe(true)

    const rows = await withCircle(database.db, circleId, (tx) => tx.select().from(entryEmbeddings))
    expect(rows).toHaveLength(3)
    expect(rows.some((r) => r.entryId === epId)).toBe(false)
    expect(rows.some((r) => r.entryId === secretEntry.id)).toBe(false)
    expect(rows.filter((r) => r.entryId === multi.id)).toHaveLength(2)

    // 幂等重跑不重复调用模型
    sentTexts.length = 0
    expect(await embedEntries(database.db, embedder, circleId, [multi.id, factId])).toBe(0)
    expect(sentTexts).toHaveLength(0)

    // 降级或过期后，dropIneligibleEmbeddings 清掉不再符合条件的向量
    const past = new Date(Date.now() - 86_400_000)
    await withCircle(database.db, circleId, (tx) =>
      tx.update(entries).set({ validTo: past }).where(eq(entries.id, factId)),
    )
    expect(await dropIneligibleEmbeddings(database.db)).toBe(1)
    const afterDrop = await withCircle(database.db, circleId, (tx) =>
      tx.select().from(entryEmbeddings),
    )
    expect(afterDrop.some((r) => r.entryId === factId)).toBe(false)

    // 删除个人圈未用到的冗余检查
    expect(personal.id).toBeTruthy()
  })

  it('在模型请求期间遇到词条或切片 xmin 并发修改时放弃写回旧向量，并完整走通 backfill/switch/prune 流程', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    const deps = makeDeps(database.db)
    const consoleSvc = await entryServiceForConsole(deps, personal.id, alice.id)

    const entry = await consoleSvc.create({ title: '并发更新词条', content: '初始正文' })
    let mutated = false
    const racingEmbedder: Embedder = {
      model: 'race-model',
      async embed(texts) {
        if (!mutated) {
          mutated = true
          await consoleSvc.update({
            id: entry.id,
            content: '期间已被改为更新后的正文',
            expectedVersion: entry.version,
          })
        }
        return texts.map((t) => unitVector(t))
      },
    }
    expect(await embedEntries(database.db, racingEmbedder, personal.id, [entry.id])).toBe(0)
    expect(
      await withCircle(database.db, personal.id, (tx) => tx.select().from(entryEmbeddings)),
    ).toHaveLength(0)

    // 配置真实模型注册表，验证 backfill -> switchJob -> pruneJob 全流程
    const { provider } = await createModelProvider(database.db, deps.masterKey, {
      name: '测试嵌入商',
      format: 'openai-chat',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test-1234',
      profiles: [
        { kind: 'embedding', label: null, model: 'model-old' },
        { kind: 'embedding', label: null, model: 'model-new' },
      ],
    })
    const [pOld, pNew] = provider.profiles
    await saveActiveEmbedding(database.db, { model: 'model-old', profileIds: [pOld!.id] })

    const mOld = mockEmbedder('model-old')
    const mNew = mockEmbedder('model-new')
    const source = {
      async get() {
        return currentActive === 'model-old' ? mOld : mNew
      },
      async next() {
        return currentNext
      },
      invalidate() {
        currentActive = 'model-new'
        currentNext = null
      },
    }
    let currentActive: 'model-old' | 'model-new' = 'model-old'
    let currentNext: Embedder | null = null

    await backfillJob(database.db, source, async () => [])
    await saveNextEmbedding(database.db, { model: 'model-new', profileIds: [pNew!.id] })
    currentNext = mNew

    const switched = await switchJob(database.db, source, async () => [])
    expect(switched).toBe('switched')

    const pruned = await pruneJob(database.db)
    expect(pruned).toBe(1)

    const remainingModels = await withCircle(database.db, personal.id, (tx) =>
      tx.select({ model: entryEmbeddings.model }).from(entryEmbeddings),
    )
    expect(remainingModels.map((r) => r.model)).toEqual(['model-new'])
    void embedJobs
  })
})
