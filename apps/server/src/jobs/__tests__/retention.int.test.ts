import { randomBytes, randomUUID } from 'node:crypto'

import type {
  ConsoleCredential,
  CredentialProvider,
  DeletedMemoryList,
  MemoryHistory,
  MemoryView,
  RetentionCounts,
  RetentionResumed,
  RetentionView,
} from '@kioku/contracts'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database, type Tx } from '../../db/client'
import {
  accounts,
  credentialEvents,
  credentialProviders,
  credentials,
  dreamRuns,
  dreamSuggestions,
  extractionRuns,
  memories,
  memoryCredentialRefs,
  memoryEmbeddings,
  memoryEvents,
  memoryGlossary,
  memoryRecallStats,
  recallEventHits,
  recallEvents,
  settings,
  spaces,
  subjectBindings,
  subjects,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { endPause, markRestored, purgeExpired, RETENTION_BATCH, retentionJob } from '../retention'

const DAY = 86_400_000
const ago = (days: number, from = Date.now()) => new Date(from - days * DAY)
const KEYS = ['retention', 'retention-status']

const ZERO: RetentionCounts = {
  deletedMemories: 0,
  supersededFacts: 0,
  expiredSummaries: 0,
  orphanEvents: 0,
  scrubbedSnapshots: 0,
  extractionRuns: 0,
  dreamRuns: 0,
  dreamSuggestions: 0,
  credentialEvents: 0,
  deletedCredentials: 0,
  deletedProviders: 0,
  subjectBindings: 0,
}

describe.skipIf(!testDatabaseUrl)('保留期', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace

  // 实例设置不挂在空间下，resetDatabase 清不到：只清保留期的两项，结束时也清掉
  const clearSettings = () => database.db.delete(settings).where(inArray(settings.key, KEYS))

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })
  afterAll(async () => {
    if (!database) return
    await clearSettings()
    await database.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await clearSettings()
    ws = await bootstrap(app)
  })

  const inSpace = <T>(fn: (tx: Tx) => Promise<T>, spaceId = ws.spaceId) =>
    withSpace(database.db, spaceId, fn)
  // 管理界面的请求，默认是空间 owner（alice）
  const send = (
    method: string,
    path: string,
    body?: unknown,
    cookie = ws.cookie,
    spaceId = ws.spaceId,
  ) =>
    app.request(
      `/v1/spaces/${spaceId}${path}`,
      body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (status === 204 ? undefined : await res.json()) as T
  }
  const createMemory = async (body: object, cookie = ws.cookie, spaceId = ws.spaceId) =>
    ok<MemoryView>(await send('POST', '/memories', body, cookie, spaceId), 201)
  const updateMemory = async (body: object, cookie = ws.cookie) =>
    ok<MemoryView>(await send('PATCH', '/memories', body, cookie))
  const deleteMemory = async (uri: string, cookie = ws.cookie, spaceId = ws.spaceId) =>
    ok(
      await send('DELETE', `/memories?uri=${encodeURIComponent(uri)}`, undefined, cookie, spaceId),
      204,
    )
  const history = async (id: string) =>
    ok<MemoryHistory>(await send('GET', `/memories/history?id=${id}`))
  // 把删除的时间挪到 days 天前
  const deletedDaysAgo = (id: string, days: number, spaceId = ws.spaceId) =>
    inSpace(
      (tx) =>
        tx
          .update(memories)
          .set({ deletedAt: ago(days) })
          .where(eq(memories.id, id)),
      spaceId,
    )
  const purge = (days = 30, now = new Date()) => purgeExpired(database.db, { days, now })
  const memoryIds = async (spaceId = ws.spaceId) =>
    (await inSpace((tx) => tx.select({ id: memories.id }).from(memories), spaceId)).map((r) => r.id)
  // 一条记忆留下的事件：按 memory_id 找，也按快照里记下的 id 找（memory_id 被置空的也算）
  const eventsAbout = (id: string) =>
    inSpace((tx) =>
      tx
        .select()
        .from(memoryEvents)
        .where(
          sql`${memoryEvents.memoryId} = ${id} or ${memoryEvents.before} ->> 'id' = ${id} or ${memoryEvents.after} ->> 'id' = ${id}`,
        )
        .orderBy(asc(memoryEvents.id)),
    )

  it('已删除的记忆过了保留期连同历史、向量、关键词、凭据引用、召回明细与累计统计一起删掉；没到期的留着', async () => {
    await ok(
      await send('POST', '/credentials', {
        identifier: 'nas',
        name: 'NAS',
        source: { kind: 'hosted', values: { password: 'nas-pass' } },
      }),
      201,
    )
    const old = await createMemory({
      uri: 'notes://old',
      content: 'NAS 的密码见 {{cred:nas#password}}',
      glossary: ['旧笔记'],
    })
    await updateMemory({ uri: 'notes://old', content: 'NAS 在书房，密码见 {{cred:nas#password}}' })
    const recent = await createMemory({
      uri: 'notes://recent',
      content: '最近才删的，密码见 {{cred:nas#password}}',
      glossary: ['新笔记'],
    })
    const live = await createMemory({ uri: 'notes://live', content: '还在用的' })
    await deleteMemory('notes://old')
    await deleteMemory('notes://recent')
    await deletedDaysAgo(old.id, 31)
    await deletedDaysAgo(recent.id, 29)
    // 向量、召回明细与累计统计直接写进表里
    await inSpace(async (tx) => {
      const [event] = await tx
        .insert(recallEvents)
        .values({
          spaceId: ws.spaceId,
          appId: randomUUID(),
          ownerAccountId: ws.accountId,
          source: 'rest.recall',
        })
        .returning()
      for (const [rank, m] of [old, recent, live].entries()) {
        await tx.insert(memoryEmbeddings).values({
          spaceId: ws.spaceId,
          memoryId: m.id,
          model: 'm',
          contentHash: 'h',
          embedding: Array.from({ length: 1024 }, () => 0.1),
        })
        await tx.insert(memoryRecallStats).values({
          spaceId: ws.spaceId,
          memoryId: m.id,
          count: 3,
          lastRecalledAt: ago(40),
        })
        await tx.insert(recallEventHits).values({
          eventId: event!.id,
          spaceId: ws.spaceId,
          memoryId: m.id,
          rank: rank + 1,
          score: 1,
          via: ['fts'],
        })
      }
    })
    expect(await eventsAbout(old.id)).toHaveLength(3)

    const { counts, errors } = await purge()
    expect(errors).toEqual([])
    expect(counts).toEqual({ ...ZERO, deletedMemories: 1 })
    expect((await memoryIds()).sort()).toEqual([recent.id, live.id].sort())
    expect(await eventsAbout(old.id)).toEqual([])
    expect((await eventsAbout(recent.id)).map((e) => e.eventType)).toEqual(['create', 'delete'])
    const left = await inSpace(async (tx) => ({
      embeddings: await tx.select({ id: memoryEmbeddings.memoryId }).from(memoryEmbeddings),
      glossary: await tx.select({ id: memoryGlossary.memoryId }).from(memoryGlossary),
      refs: await tx.select({ id: memoryCredentialRefs.memoryId }).from(memoryCredentialRefs),
      hits: await tx.select({ id: recallEventHits.memoryId }).from(recallEventHits),
      stats: await tx.select({ id: memoryRecallStats.memoryId }).from(memoryRecallStats),
      events: await tx.select().from(recallEvents),
    }))
    const ids = (rows: { id: string | null }[]) => rows.map((r) => r.id).sort()
    expect(ids(left.embeddings)).toEqual([recent.id, live.id].sort())
    expect(ids(left.glossary)).toEqual([recent.id])
    expect(ids(left.refs)).toEqual([recent.id])
    expect(ids(left.hits)).toEqual([recent.id, live.id].sort())
    expect(ids(left.stats)).toEqual([recent.id, live.id].sort())
    // 召回事件本身留着，按召回明细自己的保留天数清理
    expect(left.events).toHaveLength(1)
    // 已经删干净了，再清一次什么都不做
    expect((await purge()).counts).toEqual(ZERO)
  })

  it('被推翻的抽取事实与过期的会话摘要过了保留期删掉；到期的策展记忆没删除就留着，让出 URI 时软删除的照「已删除」清', async () => {
    const [subject] = await inSpace((tx) =>
      tx
        .insert(subjects)
        .values({ spaceId: ws.spaceId, kind: 'person', displayName: '小明' })
        .returning(),
    )
    const extracted = {
      spaceId: ws.spaceId,
      form: 'extracted' as const,
      sensitivity: 'public' as const,
      provenance: 'untrusted' as const,
      originScope: `direct:${subject!.id}`,
    }
    const fact = (content: string, validTo: Date | null) => ({
      ...extracted,
      layer: 'subject' as const,
      subjectId: subject!.id,
      content,
      validTo,
    })
    const summary = (content: string, expiresAt: Date) => ({
      ...extracted,
      layer: 'episode' as const,
      content,
      expiresAt,
    })
    const curated = (path: string, extra: { validTo: Date; deletedAt?: Date }) => ({
      spaceId: ws.spaceId,
      form: 'curated' as const,
      layer: 'base' as const,
      sensitivity: 'internal' as const,
      provenance: 'owner' as const,
      domain: 'notes',
      path,
      content: `${path} 的正文`,
      ...extra,
    })
    const rows = await inSpace((tx) =>
      tx
        .insert(memories)
        .values([
          fact('推翻了很久的', ago(31)),
          fact('推翻了更久的', ago(35)),
          fact('刚被推翻的', ago(29)),
          fact('还有效的', null),
          summary('过期很久的摘要', ago(31)),
          summary('刚过期的摘要', ago(29)),
          summary('还没过期的摘要', ago(-10)),
          curated('expired', { validTo: ago(40) }),
          curated('released', { validTo: ago(45), deletedAt: ago(40) }),
        ])
        .returning(),
    )
    const byContent = (content: string) => rows.find((r) => r.content === content)!.id
    const superseded = byContent('推翻了很久的')
    await inSpace((tx) =>
      tx.insert(memoryEvents).values(
        ['create', 'update'].map((eventType) => ({
          spaceId: ws.spaceId,
          memoryId: superseded,
          eventType,
          provenance: 'untrusted' as const,
          after: { id: superseded, content: '推翻了很久的' },
        })),
      ),
    )

    const { counts } = await purge()
    expect(counts).toEqual({
      ...ZERO,
      deletedMemories: 1,
      supersededFacts: 2,
      expiredSummaries: 1,
    })
    const left = await inSpace((tx) =>
      tx.select({ content: memories.content }).from(memories).orderBy(asc(memories.content)),
    )
    expect(left.map((r) => r.content).sort()).toEqual(
      [
        '刚被推翻的',
        '还有效的',
        '刚过期的摘要',
        '还没过期的摘要',
        // 到期的策展记忆一直留着，等人决定要不要重新生效
        'expired 的正文',
      ].sort(),
    )
    expect(await eventsAbout(superseded)).toEqual([])
  })

  it('记忆硬删除时导入事件留下当作去重记录：memory_id 置空，快照只剩 URI', async () => {
    const imported = await createMemory({
      uri: 'notes://imported',
      content: '从 Lore 导进来的正文',
      disclosure: '想起 Lore 时',
      glossary: ['导入'],
    })
    // 和导入工具写下的一样：事件类型是 import，context 里是去重用的出处
    await inSpace((tx) =>
      tx
        .update(memoryEvents)
        .set({ eventType: 'import', context: { source: 'lore', loreNodeUuid: 'node-1' } })
        .where(eq(memoryEvents.memoryId, imported.id)),
    )
    await updateMemory({ uri: 'notes://imported', content: '在 Kioku 里改过' })
    await deleteMemory('notes://imported')
    await deletedDaysAgo(imported.id, 31)

    expect((await purge()).counts).toEqual({ ...ZERO, deletedMemories: 1 })
    const traces = await inSpace((tx) => tx.select().from(memoryEvents))
    expect(traces).toEqual([
      expect.objectContaining({
        memoryId: null,
        eventType: 'import',
        before: null,
        after: { domain: 'notes', path: 'imported' },
        context: { source: 'lore', loreNodeUuid: 'node-1' },
      }),
    ])
    // 已经削过的不再算一次
    expect((await purge()).counts).toEqual(ZERO)
  })

  it('只有 Lore 的导入事件留作去重记录：按空间导入的导入事件随记忆硬删除，之前削成 URI 留下的也删掉', async () => {
    const fromLore = await createMemory({ uri: 'notes://from-lore', content: '从 Lore 导进来的' })
    const fromFile = await createMemory({ uri: 'notes://from-file', content: '从导出文件导进来的' })
    const moved = { source: 'space-export', exportedAt: '2026-10-01T00:00:00.000Z' }
    await inSpace(async (tx) => {
      await tx
        .update(memoryEvents)
        .set({ eventType: 'import', context: { source: 'lore', loreNodeUuid: 'node-lore' } })
        .where(eq(memoryEvents.memoryId, fromLore.id))
      await tx
        .update(memoryEvents)
        .set({ eventType: 'import', context: { ...moved, previousVersions: 0 } })
        .where(eq(memoryEvents.memoryId, fromFile.id))
      // 之前的清理把按空间导入的导入事件也削成了 URI 留着：记忆整行早就不在了
      await tx.insert(memoryEvents).values({
        spaceId: ws.spaceId,
        memoryId: null,
        eventType: 'import',
        provenance: 'system',
        before: null,
        after: { domain: 'notes', path: 'long-gone' },
        context: { ...moved, previousVersions: 2 },
      })
    })
    await deleteMemory('notes://from-lore')
    await deleteMemory('notes://from-file')
    await deletedDaysAgo(fromLore.id, 31)
    await deletedDaysAgo(fromFile.id, 31)

    expect((await purge()).counts).toEqual({ ...ZERO, deletedMemories: 2, orphanEvents: 1 })
    expect(await inSpace((tx) => tx.select().from(memoryEvents))).toEqual([
      expect.objectContaining({
        memoryId: null,
        eventType: 'import',
        before: null,
        after: { domain: 'notes', path: 'from-lore' },
        context: { source: 'lore', loreNodeUuid: 'node-lore' },
      }),
    ])
    expect((await purge()).counts).toEqual(ZERO)
  })

  it('删账号留下的快照：记忆整行不在的事件删掉、导入事件削成 URI；已删账号个人层的快照抹掉正文，别人看到的历史不变', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    // 只在 bob 的私人层：删账号时数据库连带删掉
    const diary = await createMemory(
      {
        uri: 'notes://diary',
        content: '鲍勃的日记',
        disclosure: '写日记时',
        glossary: ['日记'],
      },
      bob.cookie,
    )
    await updateMemory({ uri: 'notes://diary', content: '鲍勃的日记，第二天' }, bob.cookie)
    await inSpace((tx) =>
      tx.insert(memoryEvents).values({
        spaceId: ws.spaceId,
        memoryId: diary.id,
        eventType: 'import',
        provenance: 'system',
        after: { domain: 'notes', path: 'diary', content: '鲍勃的日记（导入）' },
        context: { source: 'lore', loreNodeUuid: 'node-diary' },
      }),
    )
    // 在 bob 的私人层写过草稿，之后改成了共享的基础层：记忆留着，私人层时的快照里有草稿
    const draft = await createMemory(
      { uri: 'notes://draft', content: '鲍勃私下的草稿', disclosure: '草稿' },
      bob.cookie,
    )
    await updateMemory(
      { uri: 'notes://draft', content: '公开的版本', layer: 'base', sensitivity: 'internal' },
      bob.cookie,
    )
    await updateMemory({ uri: 'notes://draft', content: '公开的版本，alice 改过' })
    // alice 的共享记忆被 bob 拿进私人层又放回来：alice 看得到一条「离开」
    const shared = await createMemory({
      uri: 'notes://shared',
      content: '共享的笔记',
      layer: 'base',
      sensitivity: 'internal',
    })
    await updateMemory(
      { uri: 'notes://shared', layer: 'private', content: '在鲍勃那里改过的' },
      bob.cookie,
    )
    await updateMemory(
      { uri: 'notes://shared', layer: 'base', sensitivity: 'internal', content: '放回来的版本' },
      bob.cookie,
    )
    // 还在的账号的私人层历史不动
    const mine = await createMemory({ uri: 'notes://mine', content: 'alice 的私事' })
    await updateMemory({ uri: 'notes://mine', content: 'alice 的私事，改过' })

    await database.db.delete(accounts).where(eq(accounts.id, bob.accountId))
    expect(await memoryIds()).not.toContain(diary.id)
    // 删账号之后、清理之前 alice 看到的历史（bob 的名字已经随账号没了）
    const before = {
      draft: await history(draft.id),
      shared: await history(shared.id),
      mine: await history(mine.id),
    }
    expect(before.shared.events.map((e) => [e.type, e.left])).toEqual([
      ['create', false],
      ['update', true],
    ])
    expect(before.mine.events.map((e) => e.after?.content)).toEqual([
      'alice 的私事',
      'alice 的私事，改过',
    ])

    const { counts } = await purge()
    // 日记的新建与修改两条删掉、导入的那条削掉；草稿的两条与共享笔记的两条抹掉正文
    expect(counts).toEqual({ ...ZERO, orphanEvents: 2, scrubbedSnapshots: 5 })
    const rows = await inSpace((tx) => tx.select().from(memoryEvents))
    const text = JSON.stringify(rows)
    for (const secret of ['鲍勃的日记', '鲍勃私下的草稿', '在鲍勃那里改过的', '写日记时', '日记']) {
      expect(text).not.toContain(secret)
    }
    expect(rows.filter((r) => r.memoryId === null)).toEqual([
      expect.objectContaining({
        eventType: 'import',
        after: { domain: 'notes', path: 'diary' },
        context: { source: 'lore', loreNodeUuid: 'node-diary' },
      }),
    ])
    // 抹掉的只是正文、disclosure 与关键词，判断可见性的字段留着：alice 看到的历史和之前一样
    expect({
      draft: await history(draft.id),
      shared: await history(shared.id),
      mine: await history(mine.id),
    }).toEqual(before)
    expect((await purge()).counts).toEqual(ZERO)
  })

  it('抽取记录与凭据事件按时间删；本月（UTC）的抽取记录留着，抽取预算按它们算用量', async () => {
    const now = new Date('2026-03-10T12:00:00Z')
    const bot = await ws.createApp('qq-bot', { runtimeFamily: 'astrbot' })
    const run = (createdAt: string) => ({
      spaceId: ws.spaceId,
      appId: bot.id,
      scope: 'group:x',
      subjectIds: [],
      turns: 1,
      createdAt: new Date(createdAt),
    })
    const credential = await ok<ConsoleCredential>(
      await send('POST', '/credentials', {
        identifier: 'nas',
        name: 'NAS',
        source: { kind: 'hosted', values: { password: 'nas-pass' } },
      }),
      201,
    )
    const event = (createdAt: string) => ({
      spaceId: ws.spaceId,
      credentialId: credential.id,
      eventType: 'access',
      createdAt: new Date(createdAt),
    })
    await inSpace(async (tx) => {
      await tx
        .insert(extractionRuns)
        .values([
          run('2026-02-20T00:00:00Z'),
          run('2026-03-05T00:00:00Z'),
          run('2026-03-09T00:00:00Z'),
        ])
      await tx
        .insert(credentialEvents)
        .values([event('2026-03-01T00:00:00Z'), event('2026-03-08T00:00:00Z')])
    })

    // 保留 3 天：3 月 7 日中午之前的到期；3 月 5 日的抽取记录在本月，留着
    const { counts } = await purge(3, now)
    expect(counts).toEqual({ ...ZERO, extractionRuns: 1, credentialEvents: 1 })
    const runs = await inSpace((tx) =>
      tx.select({ at: extractionRuns.createdAt }).from(extractionRuns),
    )
    expect(runs.map((r) => r.at.toISOString()).sort()).toEqual([
      '2026-03-05T00:00:00.000Z',
      '2026-03-09T00:00:00.000Z',
    ])
    const events = await inSpace((tx) =>
      tx
        .select({ type: credentialEvents.eventType, at: credentialEvents.createdAt })
        .from(credentialEvents),
    )
    // 新建凭据时记下的事件是现在写的，还没到期
    expect(events.map((e) => e.type).sort()).toEqual(['access', 'create'])
  })

  it('Dream 的运行记录和抽取记录一样留着本月的；建议过了保留期、并且已经作废的才删，还作数的留着', async () => {
    const now = new Date('2026-03-10T12:00:00Z')
    const live = await createMemory({ uri: 'core://live', content: '没改过', layer: 'base' })
    const other = await createMemory({ uri: 'core://other', content: '也没改过', layer: 'base' })
    const changed = await createMemory({ uri: 'core://changed', content: '改过', layer: 'base' })
    await updateMemory({ uri: changed.uri, content: '改过了' })
    const gone = await createMemory({ uri: 'core://gone', content: '删掉了', layer: 'base' })
    await deleteMemory(gone.uri)
    const ended = await createMemory({ uri: 'core://ended', content: '过期了', layer: 'base' })
    await inSpace((tx) =>
      tx
        .update(memories)
        .set({ validTo: new Date('2026-03-08T00:00:00Z') })
        .where(eq(memories.id, ended.id)),
    )
    const run = (createdAt: string) => ({
      spaceId: ws.spaceId,
      runId: randomUUID(),
      trigger: 'scheduled',
      scope: 'base',
      createdAt: new Date(createdAt),
    })
    let n = 0
    const suggestion = (
      status: 'pending' | 'applied' | 'rejected',
      at: string,
      ...involved: MemoryView[]
    ) => ({
      spaceId: ws.spaceId,
      scope: 'base',
      kind: involved.length > 1 ? 'distill' : 'stale',
      memoryIds: involved.map((m) => m.id),
      versions: involved.map(() => 1),
      reason: `第 ${++n} 条`,
      fingerprint: `fp-${n}`,
      status,
      ...(status === 'pending'
        ? { createdAt: new Date(at) }
        : { createdAt: new Date(at), decidedAt: new Date(at), decidedBy: ws.accountId }),
    })
    await inSpace(async (tx) => {
      await tx
        .insert(dreamRuns)
        .values([
          run('2026-02-20T00:00:00Z'),
          run('2026-03-05T00:00:00Z'),
          run('2026-03-09T00:00:00Z'),
        ])
      await tx.insert(dreamSuggestions).values([
        // 拒绝过、涉及的记忆没改过：指纹还要挡住同样的建议，留着
        suggestion('rejected', '2026-03-01T00:00:00Z', live),
        // 执行过的提炼，作为来源的事实没改过：同样的提炼不再提，留着
        suggestion('applied', '2026-03-01T00:00:00Z', live, other),
        // 还在待审里的留着
        suggestion('pending', '2026-03-01T00:00:00Z', other),
        // 作废了、但处理还不到保留期的留着
        suggestion('rejected', '2026-03-09T00:00:00Z', changed),
        // 作废了、过了保留期：改过的、删掉的、过期的
        suggestion('rejected', '2026-03-01T00:00:00Z', changed),
        suggestion('applied', '2026-03-01T00:00:00Z', gone),
        suggestion('pending', '2026-03-01T00:00:00Z', ended),
      ])
    })

    // 保留 3 天：3 月 7 日中午之前的到期；3 月 5 日的运行记录在本月，留着
    const { counts } = await purge(3, now)
    expect(counts).toEqual({ ...ZERO, dreamRuns: 1, dreamSuggestions: 3 })
    const runs = await inSpace((tx) => tx.select({ at: dreamRuns.createdAt }).from(dreamRuns))
    expect(runs.map((r) => r.at.toISOString()).sort()).toEqual([
      '2026-03-05T00:00:00.000Z',
      '2026-03-09T00:00:00.000Z',
    ])
    const left = await inSpace((tx) =>
      tx.select({ reason: dreamSuggestions.reason }).from(dreamSuggestions),
    )
    expect(left.map((s) => s.reason).sort()).toEqual(['第 1 条', '第 2 条', '第 3 条', '第 4 条'])
  })

  it('已删除的凭据与凭据源过了保留期删掉；还有凭据指着的凭据源留着，保留期里已删除的凭据也算', async () => {
    const provider = async (name: string) =>
      ok<CredentialProvider>(
        await send('POST', '/credential-providers', { kind: 'bitwarden', name }),
        201,
      )
    const external = async (identifier: string, providerId: string) =>
      ok<ConsoleCredential>(
        await send('POST', '/credentials', {
          identifier,
          name: identifier,
          source: {
            kind: 'external',
            providerId,
            location: `${identifier} item`,
            fields: [{ name: 'password', sourceField: 'password' }],
          },
        }),
        201,
      )
    const hosted = async (identifier: string) =>
      ok<ConsoleCredential>(
        await send('POST', '/credentials', {
          identifier,
          name: identifier,
          source: { kind: 'hosted', values: { password: 'pw' } },
        }),
        201,
      )
    const removeCredential = async (id: string) =>
      ok(await send('DELETE', `/credentials/${id}`), 204)
    const removeProvider = async (id: string) =>
      ok(await send('DELETE', `/credential-providers/${id}`), 204)

    // 没有凭据指着的凭据源
    const lonely = await provider('没人用的')
    await removeProvider(lonely.id)
    // 凭据删掉、凭据源删掉之后又把凭据恢复了：凭据还在用，显示「凭据源已删除」
    const revived = await provider('凭据恢复了的')
    const router = await external('router', revived.id)
    await removeCredential(router.id)
    await removeProvider(revived.id)
    await ok(await send('POST', `/credentials/${router.id}/undelete`))
    // 凭据最近才删：还能恢复，凭据源也留着
    const pending = await provider('凭据刚删的')
    const nas = await external('nas', pending.id)
    await removeCredential(nas.id)
    await removeProvider(pending.id)
    // 凭据与凭据源都早就删了：一起删掉
    const gone = await provider('都删了很久的')
    const wifi = await external('wifi', gone.id)
    await removeCredential(wifi.id)
    await removeProvider(gone.id)
    const oldHosted = await hosted('old-hosted')
    await removeCredential(oldHosted.id)
    const newHosted = await hosted('new-hosted')
    await removeCredential(newHosted.id)
    await inSpace(async (tx) => {
      const setCredential = (id: string, days: number) =>
        tx
          .update(credentials)
          .set({ deletedAt: ago(days) })
          .where(eq(credentials.id, id))
      const setProvider = (id: string, days: number) =>
        tx
          .update(credentialProviders)
          .set({ deletedAt: ago(days) })
          .where(eq(credentialProviders.id, id))
      for (const p of [lonely, revived, pending, gone]) await setProvider(p.id, 40)
      await setCredential(nas.id, 10)
      await setCredential(wifi.id, 40)
      await setCredential(oldHosted.id, 31)
      await setCredential(newHosted.id, 29)
    })

    const { counts, errors } = await purge()
    expect(errors).toEqual([])
    expect(counts).toEqual({ ...ZERO, deletedCredentials: 2, deletedProviders: 2 })
    const left = await inSpace(async (tx) => ({
      credentials: await tx.select({ id: credentials.id }).from(credentials),
      providers: await tx.select({ id: credentialProviders.id }).from(credentialProviders),
      // 删掉的凭据的事件随凭据一起删掉
      events: await tx.selectDistinct({ id: credentialEvents.credentialId }).from(credentialEvents),
    }))
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort()
    expect(ids(left.credentials)).toEqual([router.id, nas.id, newHosted.id].sort())
    expect(ids(left.providers)).toEqual([revived.id, pending.id].sort())
    expect(ids(left.events)).toEqual([router.id, nas.id, newHosted.id].sort())
    const view = await ok<ConsoleCredential>(await send('GET', `/credentials/${router.id}`))
    expect(view.provider).toMatchObject({ id: revived.id, deleted: true })
  })

  it('处理完的绑定记录过了保留期删掉：合并、确认、拒绝、作废的按处理的时间，过期没处理的按期限；还在等确认的留着', async () => {
    const { id: appId } = await ws.createApp('qq-bot', { runtimeFamily: 'astrbot' })
    const [a, b] = await inSpace((tx) =>
      tx
        .insert(subjects)
        .values([
          { spaceId: ws.spaceId, kind: 'person' as const, displayName: '小明' },
          { spaceId: ws.spaceId, kind: 'person' as const, displayName: '明' },
        ])
        .returning(),
    )
    // 收码的平台账号当作标签，看留下了哪几条
    const record = (
      label: string,
      extra: { status: 'pending' | 'merged' | 'confirmed' | 'rejected' | 'cancelled' } & (
        { decidedAt: Date } | { expiresAt: Date }
      ),
    ) => ({
      spaceId: ws.spaceId,
      appId,
      keyId: appId,
      subjectId: a!.id,
      fromSubjectId: b!.id,
      platform: 'tg',
      externalId: label,
      issuedPlatform: 'qq',
      issuedExternalId: '1001',
      issuedAt: ago(45),
      ...extra,
    })
    await inSpace((tx) =>
      tx
        .insert(subjectBindings)
        .values([
          record('merged-old', { status: 'merged', decidedAt: ago(31) }),
          record('confirmed-old', { status: 'confirmed', decidedAt: ago(40) }),
          record('cancelled-old', { status: 'cancelled', decidedAt: ago(31) }),
          record('rejected-recent', { status: 'rejected', decidedAt: ago(29) }),
          record('expired-old', { status: 'pending', expiresAt: ago(31) }),
          record('expired-recent', { status: 'pending', expiresAt: ago(29) }),
          record('waiting', { status: 'pending', expiresAt: ago(-6) }),
        ]),
    )
    const { counts, errors } = await purge()
    expect(errors).toEqual([])
    expect(counts).toEqual({ ...ZERO, subjectBindings: 4 })
    const left = await inSpace((tx) =>
      tx.select({ label: subjectBindings.externalId }).from(subjectBindings),
    )
    expect(left.map((r) => r.label).sort()).toEqual(
      ['expired-recent', 'rejected-recent', 'waiting'].sort(),
    )
    // 等确认的期限设得再久，也不会因为保留天数短被删
    expect((await purge(1)).counts).toEqual({ ...ZERO, subjectBindings: 2 })
    expect(
      (
        await inSpace((tx) =>
          tx.select({ label: subjectBindings.externalId }).from(subjectBindings),
        )
      ).map((r) => r.label),
    ).toEqual(['waiting'])
  })

  it('正被别的事务锁着的记忆（例如正在撤销删除）这次跳过、不等锁，下一次再删', async () => {
    const busy = await createMemory({ uri: 'notes://busy', content: '正在撤销删除' })
    const idle = await createMemory({ uri: 'notes://idle', content: '没人碰' })
    for (const m of [busy, idle]) {
      await deleteMemory(m.uri)
      await deletedDaysAgo(m.id, 40)
    }
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.space_id', ${ws.spaceId}, true)`)
      await tx.execute(sql`select 1 from memories where id = ${busy.id} for update`)
      expect((await purge()).counts).toEqual({ ...ZERO, deletedMemories: 1 })
    })
    expect(await memoryIds()).toEqual([busy.id])
    expect((await purge()).counts).toEqual({ ...ZERO, deletedMemories: 1 })
    expect(await memoryIds()).toEqual([])
  })

  it('跨空间各删各的', async () => {
    const [other] = await database.db.insert(spaces).values({ name: '别人家' }).returning()
    const dave = await addMember(database.db, other!.id, 'dave', 'owner')
    const plant = async (cookie: string, spaceId: string) => {
      const old = await createMemory({ uri: 'notes://old', content: '早就删了' }, cookie, spaceId)
      const recent = await createMemory({ uri: 'notes://recent', content: '刚删' }, cookie, spaceId)
      await deleteMemory('notes://old', cookie, spaceId)
      await deleteMemory('notes://recent', cookie, spaceId)
      await deletedDaysAgo(old.id, 40, spaceId)
      await deletedDaysAgo(recent.id, 10, spaceId)
      return recent.id
    }
    const mine = await plant(ws.cookie, ws.spaceId)
    const theirs = await plant(dave.cookie, other!.id)

    const { counts } = await purge()
    expect(counts.deletedMemories).toBe(2)
    expect(await memoryIds()).toEqual([mine])
    expect(await memoryIds(other!.id)).toEqual([theirs])
  })

  it('超过一批的分几批删完', async () => {
    const total = RETENTION_BATCH + 20
    await inSpace(async (tx) => {
      await tx.execute(sql`
        insert into memories (space_id, form, layer, sensitivity, provenance, content, deleted_at)
        select ${ws.spaceId}::uuid, 'extracted'::memory_form, 'episode'::memory_layer,
          'public'::sensitivity, 'untrusted'::provenance, '摘要 ' || g, ${ago(40).toISOString()}::timestamptz
        from generate_series(1, ${total}::int) g`)
      await tx.execute(sql`
        insert into memory_events (space_id, memory_id, event_type, provenance, after)
        select space_id, id, 'create', provenance, jsonb_build_object('content', content)
        from memories`)
    })
    expect((await purge()).counts).toEqual({ ...ZERO, deletedMemories: total })
    expect(await memoryIds()).toEqual([])
    expect(await inSpace((tx) => tx.select().from(memoryEvents))).toEqual([])
  })

  // ---- 定时任务、暂停与设置 ----

  const EMPTY_STATUS = { lastRun: null, lastAttempt: null, lastError: null }
  const view = async () =>
    ok<RetentionView>(
      await app.request('/v1/settings/retention', { headers: { cookie: ws.cookie } }),
    )
  const put = (body: unknown, cookie = ws.cookie) =>
    app.request('/v1/settings/retention', jsonRequest('PUT', body, { cookie }))
  const resume = (target = app, cookie = ws.cookie) =>
    target.request('/v1/settings/retention/resume', jsonRequest('POST', {}, { cookie }))
  // 实例上已经有保留期的状态、没有暂停（像是已经生效过一阵子）
  const active = () => database.db.insert(settings).values({ key: 'retention', value: {} })
  const storedSettings = async () =>
    (await database.db.select().from(settings).where(eq(settings.key, 'retention')))[0]?.value
  const plantDeleted = async (uri: string, days: number) => {
    const memory = await createMemory({ uri, content: '早就删了' })
    await deleteMemory(uri)
    await deletedDaysAgo(memory.id, days)
    return memory.id
  }
  const after = (from: Date, days: number) => new Date(from.getTime() + days * DAY)

  it('有一类一直出错时每次只记自己做了什么、下一个小时再试，同一天最多试 3 次；第二天照常再试，做完才记成最近一次', async () => {
    await active()
    const bot = await ws.createApp('qq-bot', { runtimeFamily: 'astrbot' })
    const plant = async (uri: string) => {
      await plantDeleted(uri, 40)
      await inSpace((tx) =>
        tx.insert(extractionRuns).values({
          spaceId: ws.spaceId,
          appId: bot.id,
          scope: 'group:x',
          subjectIds: [],
          turns: 1,
          createdAt: ago(400),
        }),
      )
    }
    expect(await view()).toEqual({ days: 30, pause: null, status: EMPTY_STATUS })

    await plant('notes://first')
    await database.db.execute(sql`
      create or replace function retention_test_fail() returns trigger language plpgsql
      as $$ begin raise exception '测试里故意出的错'; end $$`)
    await database.db.execute(sql`
      create trigger retention_test_fail before delete on extraction_runs
      for each row execute function retention_test_fail()`)
    try {
      for (const [i, hour] of ['08', '09', '10'].entries()) {
        const at = new Date(`2030-05-01T${hour}:17:00Z`)
        const counts = { ...ZERO, deletedMemories: i === 0 ? 1 : 0 }
        expect(await retentionJob(database.db, at)).toMatchObject({
          complete: false,
          paused: false,
          counts,
        })
        const status = (await view()).status
        expect(status.lastRun).toBeNull()
        expect(status.lastAttempt).toEqual({
          at: at.toISOString(),
          paused: false,
          complete: false,
          counts,
          tries: i + 1,
        })
        expect(status.lastError?.message).toContain('抽取记录：测试里故意出的错')
      }
      // 今天已经试了 3 次，不再试；第二天照常再试，从第 1 次算起
      expect(await retentionJob(database.db, new Date('2030-05-01T11:17:00Z'))).toBeNull()
      expect(await retentionJob(database.db, new Date('2030-05-02T00:17:00Z'))).toMatchObject({
        complete: false,
      })
      expect((await view()).status.lastAttempt?.tries).toBe(1)
    } finally {
      await database.db.execute(sql`drop trigger if exists retention_test_fail on extraction_runs`)
      await database.db.execute(sql`drop function if exists retention_test_fail()`)
    }
    // 错误排除之后的下一个小时做完：只记这一次删了多少，错误清掉
    const done = new Date('2030-05-02T01:17:00Z')
    const counts = { ...ZERO, extractionRuns: 1 }
    expect(await retentionJob(database.db, done)).toMatchObject({ complete: true, counts })
    expect((await view()).status).toEqual({
      lastRun: { at: done.toISOString(), days: 30, paused: false, counts },
      lastAttempt: { at: done.toISOString(), paused: false, complete: true, counts, tries: 2 },
      lastError: null,
    })

    // 今天做完了，同一天不再做；第二天照常
    await plant('notes://second')
    expect(await retentionJob(database.db, new Date('2030-05-02T23:17:00Z'))).toBeNull()
    expect((await retentionJob(database.db, new Date('2030-05-03T00:17:00Z')))?.counts).toEqual({
      ...ZERO,
      deletedMemories: 1,
      extractionRuns: 1,
    })
  })

  it('一次清理有时间预算：到了时间不记做完，下一个小时接着删，做完才记成最近一次（只记那一次删的）', async () => {
    await active()
    const total = RETENTION_BATCH + 20
    await inSpace((tx) =>
      tx.execute(sql`
        insert into memories (space_id, form, layer, sensitivity, provenance, content, deleted_at)
        select ${ws.spaceId}::uuid, 'extracted'::memory_form, 'episode'::memory_layer,
          'public'::sensitivity, 'untrusted'::provenance, '摘要 ' || g, ${ago(40).toISOString()}::timestamptz
        from generate_series(1, ${total}::int) g`),
    )
    const first = new Date('2030-06-01T08:17:00Z')
    // 预算为 0：第一批总会做，之后就不再开新批次
    const partial = { ...ZERO, deletedMemories: RETENTION_BATCH }
    expect(await retentionJob(database.db, first, 0)).toMatchObject({
      complete: false,
      counts: partial,
    })
    expect((await view()).status).toEqual({
      lastRun: null,
      lastAttempt: {
        at: first.toISOString(),
        paused: false,
        complete: false,
        counts: partial,
        tries: 1,
      },
      lastError: null,
    })
    const next = new Date('2030-06-01T09:17:00Z')
    const rest = { ...ZERO, deletedMemories: 20 }
    expect(await retentionJob(database.db, next)).toMatchObject({ complete: true, counts: rest })
    expect((await view()).status).toEqual({
      lastRun: { at: next.toISOString(), days: 30, paused: false, counts: rest },
      lastAttempt: {
        at: next.toISOString(),
        paused: false,
        complete: true,
        counts: rest,
        tries: 2,
      },
      lastError: null,
    })
    expect(await memoryIds()).toEqual([])
  })

  it('设置里存的值不对（手改过）时，保存天数与清理照常，写回整理过的值', async () => {
    await database.db.insert(settings).values({
      key: 'retention',
      value: { days: 'abc', pause: { since: '不是时间', reason: 'restored' }, extra: 1 },
    })
    const old = await plantDeleted('notes://old', 40)
    expect(await view()).toMatchObject({ days: 30, pause: null })
    expect((await retentionJob(database.db))?.counts.deletedMemories).toBe(1)
    expect(await memoryIds()).not.toContain(old)
    expect(await ok<RetentionView>(await put({ days: 10 }))).toMatchObject({
      days: 10,
      pause: null,
    })
    expect(await storedSettings()).toEqual({ days: 10 })
    // 存的根本不是对象
    await database.db.update(settings).set({ value: 'oops' }).where(eq(settings.key, 'retention'))
    expect(await ok<RetentionView>(await put({ days: 12 }))).toMatchObject({
      days: 12,
      pause: null,
    })
    expect(await storedSettings()).toEqual({ days: 12 })
    await database.db.execute(
      sql`update settings set value = 'null'::jsonb where key = 'retention'`,
    )
    expect(await retentionJob(database.db, after(new Date(), 1))).toMatchObject({ paused: false })
    expect(await ok<RetentionView>(await put({ days: 13 }))).toMatchObject({ days: 13 })
  })

  it('升级之前存下的清理结果（计数里还没有后来加的几类）照样读得出，同一天不再整个清理一遍', async () => {
    await active()
    const at = new Date('2030-06-01T03:17:00Z').toISOString()
    const later = ['dreamRuns', 'dreamSuggestions', 'subjectBindings']
    const counts = {
      ...Object.fromEntries(Object.entries(ZERO).filter(([key]) => !later.includes(key))),
      deletedMemories: 2,
    }
    await database.db.insert(settings).values({
      key: 'retention-status',
      value: {
        lastRun: { at, days: 30, paused: false, counts },
        lastAttempt: { at, paused: false, complete: true, counts, tries: 1 },
        lastError: null,
      },
    })
    const full = { ...ZERO, deletedMemories: 2 }
    expect((await view()).status).toEqual({
      lastRun: { at, days: 30, paused: false, counts: full },
      lastAttempt: { at, paused: false, complete: true, counts: full, tries: 1 },
      lastError: null,
    })
    // 读不出的话会当作还没清理过：同一天又整个清理一遍
    expect(await retentionJob(database.db, new Date('2030-06-01T04:17:00Z'))).toBeNull()
  })

  it('暂停中试满了 3 次也不挡住提前开始之后当天的完整清理：每种（暂停中与否）各自计数', async () => {
    const restoredAt = new Date('2030-07-01T00:00:00Z')
    await database.db.transaction((tx) => markRestored(tx, restoredAt))
    // 删账号留下的历史这一步删不掉：暂停中的每一次都没做完
    await database.db.execute(sql`
      create or replace function retention_test_fail() returns trigger language plpgsql
      as $$ begin raise exception '测试里故意出的错'; end $$`)
    await database.db.execute(sql`
      create trigger retention_test_fail before delete on memory_events
      for each row execute function retention_test_fail()`)
    try {
      await inSpace((tx) =>
        tx.insert(memoryEvents).values({
          spaceId: ws.spaceId,
          memoryId: null,
          eventType: 'update',
          provenance: 'owner',
          after: { content: '删账号留下的正文' },
        }),
      )
      for (const hour of ['01', '02', '03']) {
        expect(
          await retentionJob(database.db, new Date(`2030-07-02T${hour}:17:00Z`)),
        ).toMatchObject({ paused: true, complete: false })
      }
      expect(await retentionJob(database.db, new Date('2030-07-02T04:17:00Z'))).toBeNull()
      // 提前开始：这一天完整的清理还没试过，照样做
      await endPause(database.db)
      expect(await retentionJob(database.db, new Date('2030-07-02T05:17:00Z'))).toMatchObject({
        paused: false,
      })
      expect((await view()).status.lastAttempt).toMatchObject({ paused: false, tries: 1 })
    } finally {
      await database.db.execute(sql`drop trigger if exists retention_test_fail on memory_events`)
      await database.db.execute(sql`drop function if exists retention_test_fail()`)
    }
  })

  it('保留期第一次生效时先暂停一个保留期：之前删掉的不删，删账号留下的历史照常每天清；到期之后照常清理', async () => {
    const old = await plantDeleted('notes://before-upgrade', 400)
    // 删账号时数据库连带删掉的记忆留下的历史
    await inSpace((tx) =>
      tx.insert(memoryEvents).values({
        spaceId: ws.spaceId,
        memoryId: null,
        eventType: 'update',
        provenance: 'owner',
        after: { content: '删账号留下的正文' },
      }),
    )
    const now = new Date()
    const counts = { ...ZERO, orphanEvents: 1 }
    expect(await retentionJob(database.db, now)).toMatchObject({
      paused: true,
      complete: true,
      counts,
    })
    expect(await memoryIds()).toContain(old)
    expect(await view()).toEqual({
      days: 30,
      pause: { reason: 'started', since: now.toISOString(), until: after(now, 30).toISOString() },
      status: {
        lastRun: { at: now.toISOString(), days: 30, paused: true, counts },
        lastAttempt: { at: now.toISOString(), paused: true, complete: true, counts, tries: 1 },
        lastError: null,
      },
    })
    // 暂停中每天照常做删账号留下的历史，按天数的几类不做
    expect(await retentionJob(database.db, after(now, 1))).toMatchObject({
      paused: true,
      counts: ZERO,
    })
    expect(await memoryIds()).toContain(old)
    // 过了一个保留期，暂停自动结束、照常清理
    expect(await retentionJob(database.db, after(now, 31))).toMatchObject({
      paused: false,
      counts: { ...ZERO, deletedMemories: 1 },
    })
    expect(await storedSettings()).toEqual({})
  })

  it('暂停自然结束后清掉：之后调大天数不会又算出一段暂停，照常清理', async () => {
    // 30 天的暂停十天前就结束了
    await database.db.transaction((tx) => markRestored(tx, ago(40)))
    const first = await plantDeleted('notes://first', 45)
    expect((await view()).pause).toBeNull()
    expect((await retentionJob(database.db))?.counts.deletedMemories).toBe(1)
    expect(await memoryIds()).not.toContain(first)
    // 清理时把结束了的暂停去掉了
    expect(await storedSettings()).toEqual({})
    expect((await ok<RetentionView>(await put({ days: 60 }))).pause).toBeNull()
    const second = await plantDeleted('notes://second', 65)
    expect((await retentionJob(database.db, after(new Date(), 1)))?.counts.deletedMemories).toBe(1)
    expect(await memoryIds()).not.toContain(second)
  })

  it('按原来的天数已经结束的暂停，保存天数时在同一条语句里去掉', async () => {
    await database.db.transaction((tx) => markRestored(tx, ago(40)))
    // 不去掉的话，调成 60 天又会暂停到 20 天以后
    const saved = await ok<RetentionView>(await put({ days: 60 }))
    expect(saved.pause).toBeNull()
    expect(await storedSettings()).toEqual({ days: 60 })
    const old = await plantDeleted('notes://old', 65)
    expect((await retentionJob(database.db))?.counts.deletedMemories).toBe(1)
    expect(await memoryIds()).not.toContain(old)
  })

  it('已删除的列表带上保留天数与是否在暂停；暂停到什么时候只给实例管理员，和实例设置里的是同一个', async () => {
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    const retention = async (cookie: string) =>
      (await ok<DeletedMemoryList>(await send('GET', '/memories/deleted', undefined, cookie)))
        .retention
    // 实例管理员在列表上看到的天数与暂停，和实例设置里的保留期一样
    const asAdmin = async () => {
      const [list, settings] = await Promise.all([retention(ws.cookie), view()])
      expect(list).toEqual({
        days: settings.days,
        paused: settings.pause !== null,
        pausedUntil: settings.pause?.until ?? null,
      })
      return list
    }

    // 保留期还没生效过：和实例设置一样没有暂停，不另外算一段从现在起的
    expect(await asAdmin()).toEqual({ days: 30, paused: false, pausedUntil: null })
    expect(await retention(editor.cookie)).toEqual({ days: 30, paused: false, pausedUntil: null })

    // 从备份恢复：实例管理员看到暂停到恢复的时间加天数，调天数时跟着变；别的成员只知道在暂停，
    // 不知道到什么时候（减去天数就是恢复的时间）
    const restoredAt = ago(3)
    await database.db.transaction((tx) => markRestored(tx, restoredAt))
    expect(await asAdmin()).toEqual({
      days: 30,
      paused: true,
      pausedUntil: after(restoredAt, 30).toISOString(),
    })
    expect(await retention(editor.cookie)).toEqual({ days: 30, paused: true, pausedUntil: null })
    await ok(await put({ days: 60 }))
    expect(await asAdmin()).toEqual({
      days: 60,
      paused: true,
      pausedUntil: after(restoredAt, 60).toISOString(),
    })
    expect(await retention(editor.cookie)).toEqual({ days: 60, paused: true, pausedUntil: null })

    // 提前开始、暂停自然结束之后都没有暂停
    await endPause(database.db)
    expect(await asAdmin()).toEqual({ days: 60, paused: false, pausedUntil: null })
    expect(await retention(editor.cookie)).toEqual({ days: 60, paused: false, pausedUntil: null })
    await database.db.transaction((tx) => markRestored(tx, ago(70)))
    expect(await asAdmin()).toEqual({ days: 60, paused: false, pausedUntil: null })
  })

  it('保留天数只有实例管理员能看、能改；第一次保存时保留期从现在起生效、先暂停，提前开始之后按新的天数删', async () => {
    expect((await put({ days: 0 })).status).toBe(400)
    expect((await put({ days: 3651 })).status).toBe(400)
    const saved = await ok<RetentionView>(await put({ days: 7 }))
    expect(saved.days).toBe(7)
    expect(saved.status).toEqual(EMPTY_STATUS)
    expect(saved.pause?.reason).toBe('started')
    expect(new Date(saved.pause!.until).getTime() - new Date(saved.pause!.since).getTime()).toBe(
      7 * DAY,
    )
    const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
    expect(
      (await app.request('/v1/settings/retention', { headers: { cookie: editor.cookie } })).status,
    ).toBe(403)
    expect((await put({ days: 30 }, editor.cookie)).status).toBe(403)
    expect((await resume(app, editor.cookie)).status).toBe(403)

    const week = await plantDeleted('notes://week', 8)
    expect(await retentionJob(database.db)).toMatchObject({ paused: true, counts: ZERO })
    expect(await memoryIds()).toContain(week)
    // 没有后台任务时排不上，如实返回
    const resumed = await ok<RetentionResumed>(await resume())
    expect(resumed).toMatchObject({ days: 7, pause: null, queued: false })
    // 当天暂停中做过的那次不挡住提前开始之后的完整清理
    expect((await retentionJob(database.db))?.counts.deletedMemories).toBe(1)
    expect(await memoryIds()).not.toContain(week)
  })

  it('从备份恢复之后暂停到恢复时间加保留天数：暂停中只清删账号留下的历史；调大天数暂停跟着延长；提前开始之后马上能清', async () => {
    const restoredAt = new Date()
    const kept = await plantDeleted('notes://restored', 40)
    // 上一个实例最近一次清理的结果随恢复清掉
    await database.db.insert(settings).values({
      key: 'retention-status',
      value: { ...EMPTY_STATUS, lastError: { message: '旧的', at: restoredAt.toISOString() } },
    })
    const until = await database.db.transaction((tx) => markRestored(tx, restoredAt))
    expect(until.getTime()).toBe(after(restoredAt, 30).getTime())
    expect(await view()).toEqual({
      days: 30,
      pause: { reason: 'restored', since: restoredAt.toISOString(), until: until.toISOString() },
      status: EMPTY_STATUS,
    })

    expect(await retentionJob(database.db, after(restoredAt, 1))).toMatchObject({
      paused: true,
      counts: ZERO,
    })
    expect(await memoryIds()).toContain(kept)

    // 调大天数：暂停的结束时间跟着往后挪，保存不会结束暂停
    const saved = await ok<RetentionView>(await put({ days: 60 }))
    expect(saved.pause).toEqual({
      reason: 'restored',
      since: restoredAt.toISOString(),
      until: after(restoredAt, 60).toISOString(),
    })
    expect(await retentionJob(database.db, after(restoredAt, 45))).toMatchObject({ paused: true })
    expect(await memoryIds()).toContain(kept)
    // 过了恢复时间加天数之后照常清
    expect((await retentionJob(database.db, after(restoredAt, 61)))?.counts.deletedMemories).toBe(1)
    expect(await memoryIds()).not.toContain(kept)

    // 再恢复一次，点「现在开始清理」：暂停清掉、马上排一次清理，当天就能清（保留天数现在是 60）
    const again = await plantDeleted('notes://again', 70)
    await database.db.transaction((tx) => markRestored(tx, new Date()))
    expect(await retentionJob(database.db)).toMatchObject({ paused: true, counts: ZERO })
    let cleanups = 0
    const withJobs = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: {
        enqueueEmbed() {},
        enqueueExtraction: async () => {},
        enqueueBackfill: async () => true,
        enqueueSwitch: async () => true,
        enqueuePrune: async () => true,
        enqueueBackup: async () => null,
        backupRun: async () => null,
        enqueueCleanup: async () => (cleanups++, true),
        enqueueDream: async () => null,
        dreamRun: async () => null,
      },
    })
    const resumed = await ok<RetentionResumed>(await resume(withJobs))
    expect(resumed).toMatchObject({ days: 60, pause: null, queued: true })
    expect(cleanups).toBe(1)
    expect((await retentionJob(database.db))?.counts.deletedMemories).toBe(1)
    expect(await memoryIds()).not.toContain(again)
  })
})
