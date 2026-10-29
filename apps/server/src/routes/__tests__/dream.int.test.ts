import { randomBytes, randomUUID } from 'node:crypto'

import type {
  BootResponse,
  DreamApplied,
  DreamMemberSettings,
  DreamRunList,
  DreamRunStatus,
  DreamSuggestionList,
  ExpiredMemoryList,
  MemoryHistory,
  MemoryView,
  RecallResponse,
  SessionContextInput,
  SubjectDetail,
} from '@kioku/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database, type Tx } from '../../db/client'
import {
  dreamRuns,
  dreamSuggestions,
  memories,
  memoryEvents,
  settings,
  spaceMembers,
  subjectIdentities,
  subjects,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { dreamSpace, type DreamOutcome } from '../../extraction/dream'
import type { ChatMessage, ChatModel } from '../../extraction/provider'
import { saveExtractionConfig } from '../../extraction/settings'
import type { Jobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeChatModel, handleOf } from '../../testing/fakeChatModel'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const reply = (suggestions: unknown[]) => JSON.stringify({ suggestions })

describe.skipIf(!testDatabaseUrl)('Dream 的建议（待审）', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  const masterKey = randomBytes(32)
  // 测试里跑完的整理（见 run）：按编号查状态时当作做完了的任务
  const finished = new Map<string, DreamOutcome>()
  const jobs: Jobs = {
    enqueueEmbed() {},
    enqueueBackfill: async () => true,
    enqueueSwitch: async () => true,
    enqueuePrune: async () => true,
    enqueueBackup: async () => null,
    backupRun: async () => null,
    enqueueExtraction: async () => {},
    enqueueCleanup: async () => true,
    enqueueDream: async () => null,
    dreamRun: async (_spaceId, id) => {
      const outcome = finished.get(id)
      return outcome ? { state: 'finished', ...outcome } : null
    },
  }

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs,
    })
  })
  afterAll(async () => {
    if (!database) return
    await database.db.delete(settings).where(eq(settings.key, 'extraction'))
    await database.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
  })

  const inSpace = <T>(fn: (tx: Tx) => Promise<T>) => withSpace(database.db, ws.spaceId, fn)
  const send = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(
      `/v1/spaces/${ws.spaceId}${path}`,
      body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    if (res.status !== status) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    return (status === 204 ? undefined : await res.json()) as T
  }
  const errorOf = async (res: Response, status: number) => {
    expect(res.status).toBe(status)
    return ((await res.json()) as { error: string }).error
  }
  const remember = async (body: object, cookie = ws.cookie) =>
    ok<MemoryView>(await send('POST', '/memories', body, cookie), 201)
  const edit = async (body: object, cookie = ws.cookie) =>
    ok<MemoryView>(await send('PATCH', '/memories', body, cookie))
  const list = async (cookie = ws.cookie) =>
    ok<DreamSuggestionList>(await send('GET', '/dream/suggestions', undefined, cookie))
  const apply = (id: string, body: object = {}, cookie = ws.cookie) =>
    send('POST', `/dream/suggestions/${id}/apply`, body, cookie)
  const reject = (id: string, cookie = ws.cookie) =>
    send('POST', `/dream/suggestions/${id}/reject`, undefined, cookie)
  const rowOf = async (id: string) =>
    (await inSpace((tx) => tx.select().from(memories).where(eq(memories.id, id))))[0]!
  const suggestionRow = async (id: string) =>
    (
      await inSpace((tx) => tx.select().from(dreamSuggestions).where(eq(dreamSuggestions.id, id)))
    )[0]!
  const eventsOf = (id: string) =>
    inSpace((tx) =>
      tx
        .select()
        .from(memoryEvents)
        .where(eq(memoryEvents.memoryId, id))
        .orderBy(asc(memoryEvents.id)),
    )
  // 跑一次整理，模型按每次请求里的记忆给出建议
  const dream = async (
    answer: (messages: ChatMessage[], h: (content: string) => string) => unknown[],
  ) => {
    const { model } = fakeChatModel((messages) =>
      reply(answer(messages, (content) => handleOf(messages, content) ?? 'M0')),
    )
    return run(model)
  }
  const run = async (model: ChatModel) => {
    const runId = randomUUID()
    const outcome = await dreamSpace(database.db, masterKey, {
      spaceId: ws.spaceId,
      runId,
      trigger: 'manual',
      modelFor: () => model,
    })
    finished.set(runId, outcome)
    return outcome
  }
  // 这个成员看到的最近一次整理：运行记录里的这一次（不带时间与编号）和按编号查到的状态
  const latest = async (cookie: string) => {
    const [run] = (await ok<DreamRunList>(await send('GET', '/dream/runs', undefined, cookie))).runs
    const status = await ok<DreamRunStatus>(
      await send('GET', `/dream/runs/${run!.runId}`, undefined, cookie),
    )
    return { trigger: run!.trigger, entries: run!.entries, status }
  }
  const only = async () => {
    const { items } = await list()
    expect(items).toHaveLength(1)
    return items[0]!
  }

  // 群「读书会」里小明的几条不可信来源的事实，以及群里的一条会话摘要
  const group = async () => {
    const [g] = await inSpace((tx) =>
      tx
        .insert(subjects)
        .values({ spaceId: ws.spaceId, kind: 'group', displayName: '读书会' })
        .returning(),
    )
    const [p] = await inSpace((tx) =>
      tx
        .insert(subjects)
        .values({ spaceId: ws.spaceId, kind: 'person', displayName: '小明' })
        .returning(),
    )
    await inSpace((tx) =>
      tx.insert(subjectIdentities).values([
        {
          spaceId: ws.spaceId,
          subjectId: g!.id,
          kind: 'group',
          platform: 'qq',
          externalId: '2001',
        },
        {
          spaceId: ws.spaceId,
          subjectId: p!.id,
          kind: 'person',
          platform: 'qq',
          externalId: '1001',
        },
      ]),
    )
    const scope = `group:${g!.id}`
    const fact = async (content: string) =>
      (
        await inSpace((tx) =>
          tx
            .insert(memories)
            .values({
              spaceId: ws.spaceId,
              form: 'extracted',
              layer: 'subject',
              sensitivity: 'public',
              provenance: 'untrusted',
              originScope: scope,
              subjectId: p!.id,
              content,
            })
            .returning(),
        )
      )[0]!
    return { groupId: g!.id, personId: p!.id, scope, fact }
  }
  const inGroup: SessionContextInput = {
    chatType: 'group',
    platform: 'qq',
    group: { id: '2001', name: '读书会' },
    sender: { id: '1001', name: '小明' },
  }

  it('列出还没处理、涉及的记忆都没改过的建议：带上记忆、范围与理由；改过或删掉之后不再列出', async () => {
    const a = await remember({ uri: 'core://lang', content: '回答用中文', layer: 'base' })
    const b = await remember({ uri: 'core://lang-more', content: '用中文回答', layer: 'base' })
    const c = await remember({ uri: 'core://report', content: '周五交周报', layer: 'base' })
    await dream((_, h) => [
      {
        kind: 'merge',
        memories: [h('回答用中文'), h('用中文回答')],
        content: '回答用中文',
        reason: '重复',
      },
      { kind: 'stale', memories: [h('周五交周报')], reason: '期限过了' },
    ])
    const first = await list()
    expect(first.total).toBe(2)
    const merge = first.items.find((i) => i.kind === 'merge')!
    expect(merge).toMatchObject({
      scope: { kind: 'base', id: null, name: null, origin: null },
      reason: '重复',
      keepId: a.id,
      content: '回答用中文',
      uri: null,
      verdict: null,
      actionable: true,
    })
    expect(merge.memories.map((m) => [m.id, m.uri, m.layer, m.provenance, m.content])).toEqual([
      [a.id, 'core://lang', 'base', 'owner', '回答用中文'],
      [b.id, 'core://lang-more', 'base', 'owner', '用中文回答'],
    ])
    await edit({ uri: 'core://lang-more', content: '用中文回答，别用英文' })
    expect((await list()).items.map((i) => i.kind)).toEqual(['stale'])
    // 删掉之后同样不列；被删的那条撤销删除之后版本也变了，这条建议作废
    expect((await send('DELETE', `/memories?uri=${encodeURIComponent(c.uri)}`)).status).toBe(204)
    expect(await list()).toMatchObject({ items: [], total: 0 })
    expect((await send('GET', '/dream/suggestions?cursor=abc')).status).toBe(400)
  })

  it('每页 50 条、新的在前，总数只在第一页给；每条带上涉及的全部记忆，按建议里的顺序', async () => {
    const notes = await inSpace((tx) =>
      tx
        .insert(memories)
        .values(
          Array.from({ length: 52 }, (_, i) => ({
            spaceId: ws.spaceId,
            form: 'curated' as const,
            layer: 'base' as const,
            sensitivity: 'public' as const,
            provenance: 'owner' as const,
            domain: 'core',
            path: `note-${String(i).padStart(2, '0')}`,
            content: `第 ${i} 条笔记`,
          })),
        )
        .returning(),
    )
    const at = (i: number) => new Date(Date.now() - (100 - i) * 1000)
    await inSpace((tx) =>
      tx.insert(dreamSuggestions).values([
        // 最早的一条：合并两条，保留的是排在后面的那条
        {
          spaceId: ws.spaceId,
          scope: 'base',
          kind: 'merge',
          memoryIds: [notes[51]!.id, notes[50]!.id],
          versions: [1, 1],
          keepId: notes[51]!.id,
          content: '合并后的笔记',
          reason: '重复',
          fingerprint: 'fp-merge',
          createdAt: at(0),
        },
        ...notes.slice(0, 50).map((note, i) => ({
          spaceId: ws.spaceId,
          scope: 'base',
          kind: 'stale',
          memoryIds: [note.id],
          versions: [1],
          reason: `第 ${i} 条过时了`,
          fingerprint: `fp-${i}`,
          createdAt: at(i + 1),
        })),
      ]),
    )
    const first = await list()
    expect([first.items.length, first.total]).toEqual([50, 51])
    expect([first.items[0]!.reason, first.items.at(-1)!.reason]).toEqual([
      '第 49 条过时了',
      '第 0 条过时了',
    ])
    const second = await ok<DreamSuggestionList>(
      await send('GET', `/dream/suggestions?cursor=${first.nextCursor}`),
    )
    expect([second.items.length, second.total, second.nextCursor]).toEqual([1, null, null])
    expect(second.items[0]!.memories.map((m) => m.content)).toEqual([
      '第 51 条笔记',
      '第 50 条笔记',
    ])
  })

  it('合并策展记忆：保留的那条换成（可以先改的）正文，来源记为执行的成员，其余几条删掉，都记事件', async () => {
    // 通过 Key 写下的，来源是 agent
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const created = await app.request(
      '/v1/memories',
      jsonRequest(
        'POST',
        { uri: 'core://lang', content: '回答用中文', layer: 'base', glossary: ['中文'] },
        bearer(key),
      ),
    )
    const a = await ok<MemoryView>(created, 201)
    expect(a.provenance).toBe('agent')
    const b = await remember({ uri: 'core://lang-more', content: '用中文回答', layer: 'base' })
    await dream((_, h) => [
      {
        kind: 'merge',
        memories: [h('用中文回答'), h('回答用中文')],
        keep: h('回答用中文'),
        content: '回答用中文',
        reason: '重复',
      },
    ])
    const suggestion = await only()
    expect(await errorOf(await apply(suggestion.id, { uri: 'core://other' }), 400)).toBe(
      '合并只能改合并后的正文',
    )
    // 改过的正文和模型给的过同一套检查
    expect(
      await errorOf(await apply(suggestion.id, { content: '回答用中文，token = abc123' }), 400),
    ).toBe('合并后的正文像有明文密码或 Token：Dream 的建议里不写凭据的值')
    expect(
      await ok<DreamApplied>(await apply(suggestion.id, { content: '回答一律用中文' })),
    ).toEqual({ memory: null })
    expect(await rowOf(a.id)).toMatchObject({
      content: '回答一律用中文',
      provenance: 'owner',
      version: 2,
      deletedAt: null,
      domain: 'core',
      path: 'lang',
      layer: 'base',
    })
    expect((await rowOf(b.id)).deletedAt).not.toBeNull()
    const keptEvents = await eventsOf(a.id)
    expect(keptEvents.at(-1)).toMatchObject({
      eventType: 'update',
      provenance: 'owner',
      actorAccountId: ws.accountId,
      context: { source: 'dream', suggestionId: suggestion.id, mergedFrom: [b.id] },
    })
    expect((await eventsOf(b.id)).at(-1)).toMatchObject({
      eventType: 'delete',
      context: { source: 'dream', suggestionId: suggestion.id, mergedInto: a.id },
    })
    expect(await suggestionRow(suggestion.id)).toMatchObject({
      status: 'applied',
      decidedBy: ws.accountId,
    })
    expect((await list()).items).toEqual([])
    expect(await errorOf(await apply(suggestion.id), 409)).toBe('这条建议已经处理过了')
    expect(await errorOf(await reject(suggestion.id), 409)).toBe('这条建议已经处理过了')
  })

  it('建议生成之后涉及的记忆被改过就不执行，返回 409；正被别的写入改着时不等锁，马上返回 409；只是被外键引用着照常执行', async () => {
    await remember({ uri: 'core://a', content: '回答用中文', layer: 'base' })
    await remember({ uri: 'core://b', content: '用中文回答', layer: 'base' })
    await remember({ uri: 'core://c', content: '周五交周报', layer: 'base' })
    await remember({ uri: 'core://d', content: '周一开例会', layer: 'base' })
    await dream((_, h) => [
      {
        kind: 'merge',
        memories: [h('回答用中文'), h('用中文回答')],
        content: '回答用中文',
        reason: '重复',
      },
      { kind: 'stale', memories: [h('周五交周报')], reason: '过了' },
      { kind: 'stale', memories: [h('周一开例会')], reason: '改到周二了' },
    ])
    const { items } = await list()
    const merge = items.find((i) => i.kind === 'merge')!
    const staleOf = (content: string) =>
      items.find((i) => i.kind === 'stale' && i.memories[0]!.content === content)!
    await edit({ uri: 'core://b', content: '用中文回答，先给结论' })
    expect(await errorOf(await apply(merge.id), 409)).toBe(
      '建议生成之后这些记忆被改过，等下次整理或手动处理',
    )
    expect((await rowOf(merge.memories[0]!.id)).content).toBe('回答用中文')
    expect((await suggestionRow(merge.id)).status).toBe('pending')

    const side = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
    // 另一条连接锁着那条记忆，在 3 秒内拿到执行的结果（等锁的话就是 waited）
    const whileLocked = (memoryId: string, lock: 'for update' | 'for key share', id: string) =>
      side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        await tx.unsafe(`select id from memories where id = $1 ${lock}`, [memoryId])
        const waited = new Promise<'waited'>((resolve) =>
          setTimeout(() => resolve('waited'), 3_000),
        )
        const res = await Promise.race([apply(id), waited])
        expect(res).not.toBe('waited')
        return res as Response
      })
    try {
      // 别的表插入指向这条记忆的行（记事件、写关键词与向量）时，外键检查加的是 KEY SHARE 锁：不算「正在改」，照常执行
      const weekly = staleOf('周一开例会')
      await ok(await whileLocked(weekly.memories[0]!.id, 'for key share', weekly.id))
      expect((await rowOf(weekly.memories[0]!.id)).validTo).not.toBeNull()

      // 锁住要改它（例如抽取正在推翻它）：不等锁，马上返回 409，不会和按别的顺序加锁的写入等成死锁；放开之后照常执行
      const report = staleOf('周五交周报')
      expect(
        await errorOf(await whileLocked(report.memories[0]!.id, 'for update', report.id), 409),
      ).toBe('这些记忆正被别的写入改动，请稍后再试')
      expect((await suggestionRow(report.id)).status).toBe('pending')
      await ok(await apply(report.id))
      expect((await rowOf(report.memories[0]!.id)).validTo).not.toBeNull()
    } finally {
      await side.end()
    }
  })

  it('合并事实：保留的那条换成合并后的一句话、来源记为成员（离开待审队列），另一条删掉；太长的不收', async () => {
    const { fact } = await group()
    const f1 = await fact('在学日语')
    const f2 = await fact('正在学日语')
    await dream((_, h) => [
      {
        kind: 'merge',
        memories: [h('在学日语'), h('正在学日语')],
        content: '在学日语',
        reason: '重复',
      },
    ])
    const suggestion = await only()
    expect(suggestion.scope).toMatchObject({
      kind: 'talk',
      origin: { kind: 'group', name: '读书会' },
    })
    expect(suggestion.memories[0]!.subject).toMatchObject({ displayName: '小明' })
    expect(
      await errorOf(await apply(suggestion.id, { content: '在学日语'.repeat(60) }), 400),
    ).toContain('一句话')
    // 成员改过的正文和模型给的过同一套检查：像有明文密码的、带凭据占位符的不收
    expect(
      await errorOf(await apply(suggestion.id, { content: '在学日语，网站密码：hunter2' }), 400),
    ).toBe('合并后的事实像有明文密码或 Token：Dream 的建议里不写凭据的值')
    expect(
      await errorOf(await apply(suggestion.id, { content: '在学日语，账号见 {{cred:xm}}' }), 400),
    ).toBe('合并后的事实里不能带凭据占位符')
    expect((await suggestionRow(suggestion.id)).status).toBe('pending')
    await ok(await apply(suggestion.id, { content: '在学日语，\n准备考 N2' }))
    expect(await rowOf(f1.id)).toMatchObject({
      content: '在学日语， 准备考 N2',
      provenance: 'owner',
      version: 2,
    })
    expect((await rowOf(f2.id)).deletedAt).not.toBeNull()
    const queue = await ok<{ items: { id: string }[] }>(await send('GET', '/review'))
    expect(queue.items.map((i) => i.id)).toEqual([])
  })

  it('提炼：新建一条策展记忆（默认放在执行的成员自己的私人层，能先改 URI、层与正文），作为来源的事实不动', async () => {
    const { fact } = await group()
    const f1 = await fact('在学日语')
    const f2 = await fact('喜欢村上春树')
    await dream((_, h) => [
      {
        kind: 'distill',
        memories: [h('在学日语'), h('喜欢村上春树')],
        uri: 'people://xiaoming',
        content: '小明在学日语，喜欢村上春树',
        disclosure: '和小明聊天时',
        reason: '整理成小明的情况',
      },
    ])
    const suggestion = await only()
    const applied = await ok<DreamApplied>(await apply(suggestion.id))
    expect(applied.memory).toMatchObject({ uri: 'people://xiaoming' })
    const node = await rowOf(applied.memory!.id)
    expect(node).toMatchObject({
      form: 'curated',
      layer: 'private',
      ownerAccountId: ws.accountId,
      sensitivity: 'private',
      provenance: 'owner',
      originScope: 'global',
      content: '小明在学日语，喜欢村上春树',
      disclosure: '和小明聊天时',
    })
    expect((await eventsOf(node.id))[0]).toMatchObject({
      eventType: 'create',
      context: { source: 'dream', suggestionId: suggestion.id, distilledFrom: [f1.id, f2.id] },
    })
    for (const f of [f1, f2]) {
      expect(await rowOf(f.id)).toMatchObject({
        version: 1,
        deletedAt: null,
        provenance: 'untrusted',
      })
    }
  })

  it('提炼时改的 URI 被占用返回 409；改到写不了的层返回 403；改过的草稿和模型给的一样不能带凭据占位符', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    // alice 的应用：bob 是 editor，写不了它的应用层
    await ws.createApp('qq-bot')
    await remember({ uri: 'people://taken', content: '已经有了', layer: 'base' })
    const { fact } = await group()
    await fact('在学日语')
    await fact('喜欢村上春树')
    await dream((_, h) => [
      {
        kind: 'distill',
        memories: [h('在学日语'), h('喜欢村上春树')],
        uri: 'people://xiaoming',
        content: '小明在学日语，喜欢村上春树',
        reason: '整理',
      },
    ])
    const suggestion = await only()
    expect(
      await errorOf(await apply(suggestion.id, { uri: 'people://taken', layer: 'base' }), 409),
    ).toBe('这个 URI 已被另一条记忆占用，换一个 URI 再执行')
    // editor 只能写自己是主人的应用的应用层
    expect((await apply(suggestion.id, { uri: `app://qq-bot/xiaoming` }, bob.cookie)).status).toBe(
      403,
    )
    // 草稿从事实提炼，事实里没有凭据引用：改过的也不能带占位符，disclosure 也一样
    expect(
      await errorOf(
        await apply(suggestion.id, {
          layer: 'private',
          content: '小明的账号见 {{cred:xm}}',
        }),
        400,
      ),
    ).toBe('提炼的正文里不能带凭据占位符')
    expect(
      await errorOf(await apply(suggestion.id, { disclosure: '登录时，密码：hunter2' }), 400),
    ).toBe('disclosure 里不能有明文密码、Token 或凭据占位符')
    expect((await suggestionRow(suggestion.id)).status).toBe('pending')
    // 能改成别的 URI 与层
    const applied = await ok<DreamApplied>(
      await apply(suggestion.id, {
        uri: 'people://xm',
        layer: 'base',
        content: '小明：在学日语，喜欢村上春树',
        disclosure: null,
      }),
    )
    expect(await rowOf(applied.memory!.id)).toMatchObject({
      layer: 'base',
      ownerAccountId: null,
      sensitivity: 'public',
      content: '小明：在学日语，喜欢村上春树',
      disclosure: null,
    })
    // 过时与审核没有能改的
    await remember({ uri: 'core://report', content: '周五交周报', layer: 'base' })
    await dream((_, h) => [{ kind: 'stale', memories: [h('周五交周报')], reason: '过了' }])
    const stale = (await list()).items.find((i) => i.kind === 'stale')!
    expect(await errorOf(await apply(stale.id, { content: '改一下' }), 400)).toBe(
      '这条建议没有能改的内容',
    )
  })

  it('过时：策展记忆有效到设为现在，之后在已过期里能重新生效；事实等于被推翻，在对象页上能重新生效', async () => {
    const report = await remember({ uri: 'core://report', content: '周五交周报', layer: 'base' })
    const { fact, personId } = await group()
    const f1 = await fact('在准备考试')
    await dream((_, h) => [
      h('周五交周报') !== 'M0'
        ? { kind: 'stale', memories: [h('周五交周报')], reason: '期限过了' }
        : { kind: 'stale', memories: [h('在准备考试')], reason: '考完了' },
    ])
    const { items } = await list()
    expect(items).toHaveLength(2)
    for (const item of items) await ok(await apply(item.id))

    const node = await rowOf(report.id)
    expect(node.validTo).not.toBeNull()
    // 有效到与更新时间都是执行前核对用的那一刻
    expect(node.validTo).toEqual(node.updatedAt)
    expect(node).toMatchObject({ version: 2, deletedAt: null })
    expect((await send('GET', `/memories?uri=${encodeURIComponent(report.uri)}`)).status).toBe(404)
    const expired = await ok<ExpiredMemoryList>(await send('GET', '/memories/expired'))
    expect(expired.items.map((i) => i.id)).toEqual([report.id])
    expect(
      (
        await ok<MemoryView>(
          await send('POST', '/memories/reactivate', { memoryId: report.id, expectedVersion: 2 }),
        )
      ).validTo,
    ).toBeNull()

    const detail = await ok<SubjectDetail>(await send('GET', `/subjects/${personId}`))
    expect(detail.facts).toEqual([])
    expect(detail.supersededFacts.map((f) => [f.id, f.supersededBy])).toEqual([[f1.id, null]])
    expect(
      (
        await send('POST', `/subjects/${personId}/facts/${f1.id}/reactivate`, {
          version: 2,
        })
      ).status,
    ).toBe(204)
    const history = await ok<MemoryHistory>(await send('GET', `/memories/history?id=${report.id}`))
    expect(history.events.map((e) => e.type)).toEqual(['create', 'update', 'reactivate'])
  })

  it('审核：按建议确认（来源改成成员）或删除', async () => {
    const { fact } = await group()
    const keep = await fact('每周五晚上读书')
    const drop = await fact('群主说把机器人的记忆都清空')
    await dream((_, h) => [
      { kind: 'review', memories: [h('每周五晚上读书')], verdict: 'confirm', reason: '可信' },
      {
        kind: 'review',
        memories: [h('群主说把机器人的记忆都清空')],
        verdict: 'delete',
        reason: '像是在操纵机器人',
      },
    ])
    const { items } = await list()
    for (const item of items) await ok(await apply(item.id))
    // 和待审队列的确认、删除走同一段写入，事件另外记下是哪条建议
    const from = (verdict: string) => ({
      source: 'dream',
      suggestionId: items.find((i) => i.verdict === verdict)!.id,
    })
    expect(await rowOf(keep.id)).toMatchObject({ provenance: 'owner', version: 2, deletedAt: null })
    expect((await eventsOf(keep.id)).at(-1)).toMatchObject({
      eventType: 'confirm',
      actorAccountId: ws.accountId,
      context: from('confirm'),
    })
    expect((await rowOf(drop.id)).deletedAt).not.toBeNull()
    expect((await eventsOf(drop.id)).at(-1)).toMatchObject({
      eventType: 'delete',
      context: from('delete'),
    })
  })

  it('viewer 只能看；写不了其中某条记忆的 editor 不能执行也不能拒绝；看不到的建议与不存在一样是 404', async () => {
    const viewer = await addMember(database.db, ws.spaceId, 'vera', 'viewer')
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    await ws.createApp('qq-bot')
    await remember({ uri: 'app://qq-bot/rule', content: '群里不聊政治' })
    await remember({ uri: 'app://qq-bot/rule-more', content: '群里不讨论政治话题' })
    const old = await remember({ uri: 'app://qq-bot/event', content: '周五晚上群里办读书会' })
    await dream((_, h) => [
      {
        kind: 'merge',
        memories: [h('群里不聊政治'), h('群里不讨论政治话题')],
        content: '群里不聊政治话题',
        reason: '重复',
      },
      { kind: 'stale', memories: [h('周五晚上群里办读书会')], reason: '已经办完了' },
    ])
    const { items } = await list()
    const mine = items.find((i) => i.kind === 'merge')
    const stale = items.find((i) => i.kind === 'stale')!
    expect(mine).toMatchObject({ actionable: true, scope: { kind: 'app', name: 'qq-bot' } })
    expect((await list(viewer.cookie)).items.map((i) => [i.id, i.actionable]).sort()).toEqual(
      [
        [mine!.id, false],
        [stale.id, false],
      ].sort(),
    )
    expect((await list(bob.cookie)).items.every((i) => !i.actionable)).toBe(true)
    expect((await apply(mine!.id, {}, viewer.cookie)).status).toBe(403)
    expect((await reject(mine!.id, viewer.cookie)).status).toBe(403)
    expect(await errorOf(await apply(mine!.id, {}, bob.cookie), 403)).toContain('没有权限')
    expect(await errorOf(await apply(stale.id, {}, bob.cookie), 403)).toContain('没有权限')
    expect((await reject(mine!.id, bob.cookie)).status).toBe(403)
    expect((await suggestionRow(mine!.id)).status).toBe('pending')
    expect(await rowOf(old.id)).toMatchObject({ validTo: null, version: 1 })
    expect((await apply(randomUUID())).status).toBe(404)
    expect((await reject(randomUUID())).status).toBe(404)
    // 写得了的成员能拒绝
    await ok(await reject(mine!.id), 204)
    expect(await suggestionRow(mine!.id)).toMatchObject({
      status: 'rejected',
      decidedBy: ws.accountId,
    })
  })

  it('不可信来源的内容提炼、合并出的文字，执行之前不进召回、boot 与对象直连；执行之后照常召回', async () => {
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const bot = await ws.issueKey((await ws.createApp('qq-bot', { runtimeFamily: 'astrbot' })).id)
    const { fact } = await group()
    await fact('喜欢抹茶')
    await fact('常去宇治')
    await fact('最近在学茶道')
    await fact('学茶道两年了')
    await dream((_, h) => [
      {
        kind: 'distill',
        memories: [h('喜欢抹茶'), h('常去宇治')],
        uri: 'people://xiaoming',
        content: '小明是宇治抹茶的爱好者',
        disclosure: '聊到抹茶时',
        reason: '整理',
      },
      {
        kind: 'merge',
        memories: [h('最近在学茶道'), h('学茶道两年了')],
        content: '学茶道两年了，最近还在学',
        reason: '重复',
      },
    ])
    const recall = async () =>
      JSON.stringify(
        await ok<RecallResponse>(
          await app.request(
            '/v1/recall',
            jsonRequest('POST', { query: '宇治抹茶的爱好者' }, bearer(key)),
          ),
        ),
      )
    const boot = async () =>
      JSON.stringify(
        await ok<BootResponse>(await app.request('/v1/boot', { headers: bearer(key) })),
      )
    const subjectsBlock = async () => {
      const res = await app.request(
        '/v1/lifecycle/event',
        jsonRequest(
          'POST',
          { event: 'prompt.submit', sessionId: 's', prompt: '你好', context: inGroup },
          bearer(bot),
        ),
      )
      return JSON.stringify(await res.json())
    }
    const before = [await recall(), await boot(), await subjectsBlock()].join('\n')
    expect(before).not.toContain('宇治抹茶的爱好者')
    expect(before).not.toContain('最近还在学')
    expect(await subjectsBlock()).toContain('最近在学茶道')

    for (const item of (await list()).items) await ok(await apply(item.id))
    expect(await recall()).toContain('people://xiaoming')
    expect(await subjectsBlock()).toContain('学茶道两年了，最近还在学')
  })

  it('运行记录：成员看得到共享范围的与自己的，别人的画像层与私人层看不到；原始的出错原因只给实例管理员', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
    await remember({ uri: 'home://alice', content: 'alice 的私事' })
    await dream(() => [])
    const runs = async (cookie: string) =>
      ok<DreamRunList>(await send('GET', '/dream/runs', undefined, cookie))
    const mine = await runs(ws.cookie)
    expect(mine.runs).toHaveLength(1)
    expect(mine.runs[0]!.entries.map((e) => e.scope?.kind)).toEqual(['base', 'private'])
    expect(mine.runs[0]).toMatchObject({ trigger: 'manual' })
    expect(mine.runs[0]!.entries[0]).toMatchObject({
      model: 'fake-model',
      tokens: 150,
      changed: 1,
      considered: 1,
      suggested: 0,
      more: false,
      skipped: null,
      error: null,
    })
    expect((await runs(bob.cookie)).runs[0]!.entries.map((e) => e.scope?.kind)).toEqual(['base'])

    await edit({ uri: 'core://rule', content: '共享的规则，改过' })
    const failing: ChatModel = {
      model: 'fake-model',
      async complete() {
        throw new Error('抽取模型返回 HTTP 502：内部网关 https://gw.example.com 出错')
      },
    }
    await run(failing)
    expect((await runs(ws.cookie)).runs[0]!.entries[0]!.error).toContain('HTTP 502')
    expect((await runs(bob.cookie)).runs[0]!.entries[0]!.error).toBe(
      '整理出错（原因只有实例管理员看得到）',
    )
    // 解析不了是服务端自己判断出的原因，谁都看得到
    await edit({ uri: 'core://rule', content: '共享的规则，又改过' })
    await run(fakeChatModel('没有 JSON').model)
    expect((await runs(bob.cookie)).runs[0]!.entries[0]!.error).toBe(
      '模型的输出里没有约定格式的 JSON 对象',
    )
    // 整次没走到范围的（没有新内容）谁都看得到
    await dream(() => [])
    expect((await runs(bob.cookie)).runs[0]!.entries).toMatchObject([
      { scope: null, skipped: 'idle' },
    ])
    expect(await inSpace((tx) => tx.select().from(dreamRuns))).toHaveLength(5)
  })

  it('现在整理一次：viewer 不能；排不进后台任务时 503；查不到的编号 404', async () => {
    const viewer = await addMember(database.db, ws.spaceId, 'vera', 'viewer')
    expect((await send('POST', '/dream/runs', undefined, viewer.cookie)).status).toBe(403)
    expect((await send('POST', '/dream/runs')).status).toBe(503)
    expect((await send('GET', `/dream/runs/${randomUUID()}`)).status).toBe(404)
    // 不是成员的看不到
    const stranger = await addMember(database.db, ws.spaceId, 'mallory', 'viewer')
    await database.db.execute(
      sql`delete from space_members where account_id = ${stranger.accountId}`,
    )
    expect((await send('GET', '/dream/runs', undefined, stranger.cookie)).status).toBe(403)
    expect((await send('GET', '/dream/suggestions', undefined, stranger.cookie)).status).toBe(403)
  })

  it('自己的 Dream 设置：默认整理画像层与私人层；只改得了自己的，别的成员、空间 owner 与 Key 都改不了', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const vera = await addMember(database.db, ws.spaceId, 'vera', 'viewer')
    const mine = async (cookie: string) =>
      ok<DreamMemberSettings>(await send('GET', '/me/dream', undefined, cookie))
    const save = (body: object, cookie: string) => send('PUT', '/me/dream', body, cookie)
    // 库里每个成员的设置
    const stored = async () =>
      Object.fromEntries(
        (
          await database.db
            .select({ id: spaceMembers.accountId, on: spaceMembers.dreamPrivate })
            .from(spaceMembers)
            .where(eq(spaceMembers.spaceId, ws.spaceId))
        ).map((m) => [m.id, m.on]),
      )

    for (const cookie of [ws.cookie, bob.cookie, vera.cookie]) {
      expect(await mine(cookie)).toEqual({ includePrivate: true })
    }
    // bob 关掉的只是他自己的
    expect(await ok(await save({ includePrivate: false }, bob.cookie))).toEqual({
      includePrivate: false,
    })
    expect(await mine(bob.cookie)).toEqual({ includePrivate: false })
    expect(await mine(ws.cookie)).toEqual({ includePrivate: true })
    expect(await stored()).toEqual({
      [ws.accountId]: true,
      [bob.accountId]: false,
      [vera.accountId]: true,
    })
    // 空间 owner 也只改得了自己的：请求里带上别人的 id 不管用
    expect(
      await ok(await save({ includePrivate: true, accountId: bob.accountId }, ws.cookie)),
    ).toEqual({ includePrivate: true })
    expect(
      await ok(await save({ includePrivate: false, accountId: vera.accountId }, ws.cookie)),
    ).toEqual({ includePrivate: false })
    expect(await stored()).toEqual({
      [ws.accountId]: false,
      [bob.accountId]: false,
      [vera.accountId]: true,
    })
    // viewer 也能改自己的
    expect(await ok(await save({ includePrivate: false }, vera.cookie))).toEqual({
      includePrivate: false,
    })
    expect(await ok(await save({ includePrivate: true }, ws.cookie))).toEqual({
      includePrivate: true,
    })

    // Key 改不了：这里只认管理界面的会话
    const key = await ws.issueKey((await ws.createApp('agent')).id)
    const viaKey = await app.request(
      `/v1/spaces/${ws.spaceId}/me/dream`,
      jsonRequest('PUT', { includePrivate: false }, bearer(key)),
    )
    expect(viaKey.status).toBe(401)
    expect(
      (await app.request(`/v1/spaces/${ws.spaceId}/me/dream`, { headers: bearer(key) })).status,
    ).toBe(401)
    expect(await stored()).toEqual({
      [ws.accountId]: true,
      [bob.accountId]: false,
      [vera.accountId]: false,
    })
    // 不合法的请求 400；不是成员的 403
    expect((await save({}, bob.cookie)).status).toBe(400)
    expect((await save({ includePrivate: 'no' }, bob.cookie)).status).toBe(400)
    await database.db.execute(sql`delete from space_members where account_id = ${vera.accountId}`)
    expect((await send('GET', '/me/dream', undefined, vera.cookie)).status).toBe(403)
    expect((await save({ includePrivate: true }, vera.cookie)).status).toBe(403)
    expect(await stored()).toEqual({ [ws.accountId]: true, [bob.accountId]: false })
  })

  it('别的成员看到的整理结果只按共享的范围算：只有 bob 的私人层有变化时，bob 开着还是关着，alice 看到的列表与状态都一样', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
    await dream(() => [])

    // bob 开着：这一次只整理了 bob 的私人层
    await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
    await dream(() => [])
    const on = { alice: await latest(ws.cookie), bob: await latest(bob.cookie) }
    // bob 关着：同样只有他的私人层有变化，这一次什么都没请求
    await ok(await send('PUT', '/me/dream', { includePrivate: false }, bob.cookie))
    await remember({ uri: 'home://bob-more', content: 'bob 又记的' }, bob.cookie)
    expect(await dream(() => [])).toEqual({ outcome: 'skipped', reason: 'idle' })
    const off = { alice: await latest(ws.cookie), bob: await latest(bob.cookie) }

    const idle = {
      trigger: 'manual',
      entries: [
        {
          scope: null,
          model: null,
          tokens: 0,
          changed: 0,
          considered: 0,
          suggested: 0,
          known: 0,
          dropped: 0,
          more: false,
          skipped: 'idle',
          error: null,
        },
      ],
      status: { state: 'finished', outcome: 'skipped', reason: 'idle' },
    }
    expect(on.alice).toEqual(idle)
    expect(off.alice).toEqual(idle)
    // bob 自己看得到他的那部分
    expect(on.bob.entries).toMatchObject([
      { scope: { kind: 'private' }, changed: 1, skipped: null },
    ])
    expect(on.bob.status).toEqual({ state: 'finished', outcome: 'done', reason: null })
    expect(off.bob).toEqual(idle)
  })

  it('做完了的状态按查看者看得到的记录算：bob 的私人层请求失败时 alice 看到的照样是共享的结果；输出解析不了不算出错', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
    await dream(() => [])
    // 基础层刚整理过、bob 的私人层从没整理过：只按上次整理的时间排的话，bob 的会排在前面
    await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
    await edit({ uri: 'core://rule', content: '共享的规则，改过' })
    const flaky: ChatModel = {
      model: 'fake-model',
      async complete(messages) {
        if (messages.some((m) => m.content.includes('bob 的私事'))) {
          throw new Error('抽取模型返回 HTTP 502：bad gateway')
        }
        return { content: reply([]), usage: { promptTokens: 120, completionTokens: 30 } }
      },
    }
    expect(await run(flaky)).toEqual({ outcome: 'failed', reason: null })
    const alice = await latest(ws.cookie)
    expect(alice.entries).toMatchObject([{ scope: { kind: 'base' }, error: null }])
    expect(alice.status).toEqual({ state: 'finished', outcome: 'done', reason: null })
    expect((await latest(bob.cookie)).status).toEqual({
      state: 'finished',
      outcome: 'failed',
      reason: null,
    })

    // 输出解析不了的那一批记了整理过，和整次的结果一样不算出错
    await edit({ uri: 'core://rule', content: '共享的规则，又改过' })
    expect(await run(fakeChatModel('没有 JSON').model)).toEqual({ outcome: 'done', reason: null })
    expect((await latest(ws.cookie)).status).toEqual({
      state: 'finished',
      outcome: 'done',
      reason: null,
    })
  })

  it('整理某个成员的私人层时出了没料到的错：记在那个范围上，只有他看得到，别的成员看到的状态不受影响', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
    const runId = randomUUID()
    const outcome = await dreamSpace(database.db, masterKey, {
      spaceId: ws.spaceId,
      runId,
      trigger: 'manual',
      modelFor: () => fakeChatModel(reply([])).model,
      afterBatch: async () => {
        throw new Error('测试里故意出的错')
      },
    })
    finished.set(runId, outcome)
    expect(outcome).toEqual({ outcome: 'failed', reason: null })
    const rows = await inSpace((tx) => tx.select().from(dreamRuns).orderBy(asc(dreamRuns.id)))
    expect(rows.map((r) => [r.scope, r.ownerAccountId, r.skipped, r.error])).toEqual([
      [null, null, 'idle', null],
      [`private:${bob.accountId}`, bob.accountId, null, '整理出错：测试里故意出的错'],
    ])
    expect(await latest(ws.cookie)).toMatchObject({
      entries: [{ scope: null, skipped: 'idle', error: null }],
      status: { state: 'finished', outcome: 'skipped', reason: 'idle' },
    })
    expect(await latest(bob.cookie)).toMatchObject({
      entries: [{ scope: { kind: 'private' }, error: '整理出错（原因只有实例管理员看得到）' }],
      status: { state: 'finished', outcome: 'failed', reason: null },
    })
  })
})
