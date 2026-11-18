import { randomBytes, randomUUID } from 'node:crypto'

import {
  CIRCLE_EXPORT_FORMAT,
  CIRCLE_EXPORT_VERSION,
  type BootResponse,
  type ConsoleEntryView,
  type DeletedEntryList,
  type DreamApplied,
  type DreamMemberSettings,
  type DreamRunList,
  type DreamRunStatus,
  type DreamSuggestionList,
  type ExpiredEntryList,
  type EntryHistory,
  type EntryList,
  type RecallResponse,
  type SessionContextInput,
  type SubjectDetail,
} from '@kioku/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { sealCircleExport } from '../../backup/circleFormat'
import { importCircle } from '../../backup/circleImport'
import { withCircle, type Database, type Tx } from '../../db/client'
import {
  circleMembers,
  conversations,
  dreamMarks,
  dreamRuns,
  dreamSuggestions,
  entries,
  entryEvents,
  entryVariants,
  settings,
  subjectIdentities,
  subjects,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { DREAM_ERROR_WORDINGS, dreamCircle } from '../../extraction/dream'
import type { ChatMessage, ChatModel } from '../../extraction/provider'
import { saveExtractionConfig } from '../../extraction/settings'
import type { Jobs } from '../../jobs/queue'
import { generateShortId } from '../../memory/shortId'
import { databaseNow, openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeChatModel, handleOf } from '../../testing/fakeChatModel'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const FAST_KDF = { logN: 14, r: 8, p: 1 }
const reply = (suggestions: unknown[]) => JSON.stringify({ suggestions })

describe.skipIf(!testDatabaseUrl)('Dream 的建议（待审）', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let botClientId: string
  const masterKey = randomBytes(32)
  // 按编号查到的任务：测试里跑完的整理当作做完了的任务（见 run），也能直接设成排着、正在整理
  const jobStates = new Map<string, DreamRunStatus>()
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
    dreamRun: async (_circleId, id) => jobStates.get(id) ?? null,
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
    jobStates.clear()
    ws = await bootstrap(app)
    botClientId = (await ws.createClient('qq-bot', { runtimeFamily: 'astrbot' })).id
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
  })

  const inCircle = <T>(fn: (tx: Tx) => Promise<T>, circleId = ws.circleId) =>
    withCircle(database.db, circleId, fn)
  const send = (
    method: string,
    path: string,
    body?: unknown,
    cookie = ws.cookie,
    circleId = ws.circleId,
  ) =>
    app.request(
      `/v1/circles/${circleId}${path}`,
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
  const remember = async (body: object, cookie = ws.cookie, circleId = ws.circleId) =>
    ok<ConsoleEntryView>(await send('POST', '/entries', body, cookie, circleId), 201)
  const edit = async (body: object, cookie = ws.cookie, circleId = ws.circleId) =>
    ok<ConsoleEntryView>(await send('PATCH', '/entries', body, cookie, circleId))
  const list = async (cookie = ws.cookie, circleId = ws.circleId) =>
    ok<DreamSuggestionList>(await send('GET', '/dream/suggestions', undefined, cookie, circleId))
  const apply = (id: string, body: object = {}, cookie = ws.cookie, circleId = ws.circleId) =>
    send('POST', `/dream/suggestions/${id}/apply`, body, cookie, circleId)
  const reject = (id: string, cookie = ws.cookie, circleId = ws.circleId) =>
    send('POST', `/dream/suggestions/${id}/reject`, undefined, cookie, circleId)
  const rowOf = async (id: string, circleId = ws.circleId) => {
    const row = (
      await inCircle((tx) => tx.select().from(entries).where(eq(entries.id, id)), circleId)
    )[0]!
    const [firstVar] = await inCircle(
      (tx) =>
        tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, id))
          .orderBy(asc(entryVariants.sortOrder)),
      circleId,
    )
    return { ...row, content: firstVar?.content ?? null }
  }
  const suggestionRow = async (id: string, circleId = ws.circleId) =>
    (
      await inCircle(
        (tx) => tx.select().from(dreamSuggestions).where(eq(dreamSuggestions.id, id)),
        circleId,
      )
    )[0]!
  const eventsOf = (id: string, circleId = ws.circleId) =>
    inCircle(
      (tx) =>
        tx
          .select()
          .from(entryEvents)
          .where(eq(entryEvents.entryId, id))
          .orderBy(asc(entryEvents.id)),
      circleId,
    )
  // 跑一次整理，模型按每次请求里的词条给出建议
  const dream = async (
    answer: (messages: ChatMessage[], h: (content: string) => string) => unknown[],
    circleId = ws.circleId,
  ) => {
    const { model } = fakeChatModel((messages) =>
      reply(answer(messages, (content) => handleOf(messages, content) ?? 'M0')),
    )
    return run(model, circleId)
  }
  // 按正文挑出这次请求里有的词条，各给一条设为过时的建议
  const staleOf =
    (reasons: Record<string, string>) =>
    (messages: ChatMessage[], h: (content: string) => string) =>
      Object.entries(reasons)
        .filter(([content]) => handleOf(messages, content) !== undefined)
        .map(([content, reason]) => ({ kind: 'stale', entries: [h(content)], reason }))
  let lastRunId = ''
  const run = async (model: ChatModel, circleId = ws.circleId) => {
    const runId = randomUUID()
    lastRunId = runId
    const outcome = await dreamCircle(database.db, masterKey, {
      circleId,
      runId,
      trigger: 'manual',
      modelFor: () => model,
    })
    jobStates.set(runId, { state: 'finished', ...outcome })
    return outcome
  }
  // 这个成员看到的最近一次整理：运行记录里的这一次（不带时间与编号）和按编号查到的状态
  const latest = async (cookie: string, circleId = ws.circleId) => {
    const [r] = (
      await ok<DreamRunList>(await send('GET', '/dream/runs', undefined, cookie, circleId))
    ).runs
    const status = await ok<DreamRunStatus>(
      await send('GET', `/dream/runs/${r!.runId}`, undefined, cookie, circleId),
    )
    return { trigger: r!.trigger, entries: r!.entries, status }
  }
  const only = async (cookie = ws.cookie, circleId = ws.circleId) => {
    const { items } = await list(cookie, circleId)
    expect(items).toHaveLength(1)
    return items[0]!
  }

  // 在 shared circle 中为指定成员播种一个即将到期的本机会话摘要（触发 local_session 整理作用域）
  let localSeq = 0
  const localEpisode = async (
    ownerAccountId: string,
    content: string,
    opts: {
      convId?: string
      provenance?: 'agent' | 'untrusted'
      title?: string
      expiresInMs?: number
    } = {},
  ) =>
    inCircle(async (tx) => {
      let convId = opts.convId
      if (!convId) {
        const [conv] = await tx
          .insert(conversations)
          .values({
            circleId: ws.circleId,
            clientId: botClientId,
            kind: 'none',
            ownerAccountId,
            deviceKey: `dev-${++localSeq}`,
            projectSlug: `proj-${localSeq}`,
          })
          .returning()
        convId = conv!.id
      }
      const title = opts.title ?? content
      const [ep] = await tx
        .insert(entries)
        .values({
          circleId: ws.circleId,
          shortId: generateShortId(),
          circleKind: 'shared',
          kind: 'episode',
          ownerAccountId,
          conversationId: convId,
          sensitivity: 'private',
          provenance: opts.provenance ?? 'agent',
          originScope: 'global',
          title,
          priority: 2,
          expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 2 * 86_400_000)),
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId: ws.circleId,
        entryId: ep!.id,
        kind: 'episode',
        sensitivity: 'private',
        when: {},
        whenSignature: '{}',
        sortOrder: 0,
        content,
        searchHeader: title,
      })
      return { id: ep!.id, convId, scopeKey: `local:${convId}` }
    })

  // 群「读书会」里小明的几条不可信来源的事实，以及群里的一条会话摘要
  const group = async () => {
    const [g] = await inCircle((tx) =>
      tx
        .insert(subjects)
        .values({ circleId: ws.circleId, kind: 'group', displayName: '读书会' })
        .returning(),
    )
    const [p] = await inCircle((tx) =>
      tx
        .insert(subjects)
        .values({ circleId: ws.circleId, kind: 'person', displayName: '小明' })
        .returning(),
    )
    await inCircle((tx) =>
      tx.insert(subjectIdentities).values([
        {
          circleId: ws.circleId,
          subjectId: g!.id,
          kind: 'group',
          platform: 'qq',
          externalId: '2001',
        },
        {
          circleId: ws.circleId,
          subjectId: p!.id,
          kind: 'person',
          platform: 'qq',
          externalId: '1001',
        },
      ]),
    )
    const scope = `group:${g!.id}`
    const fact = async (content: string) =>
      inCircle(async (tx) => {
        const [row] = await tx
          .insert(entries)
          .values({
            circleId: ws.circleId,
            shortId: generateShortId(),
            circleKind: 'shared',
            kind: 'fact',
            ownerAccountId: null,
            sensitivity: 'public',
            provenance: 'untrusted',
            originScope: scope,
            subjectId: p!.id,
            subjectKind: 'person',
            title: content,
            priority: 2,
          })
          .returning()
        await tx.insert(entryVariants).values({
          circleId: ws.circleId,
          entryId: row!.id,
          kind: 'fact',
          sensitivity: 'public',
          when: {},
          whenSignature: '{}',
          sortOrder: 0,
          content,
          searchHeader: content,
        })
        return row!
      })
    return { groupId: g!.id, personId: p!.id, scope, fact }
  }
  const inGroup: SessionContextInput = {
    chatType: 'group',
    platform: 'qq',
    group: { id: '2001', name: '读书会' },
    sender: { id: '1001', name: '小明' },
  }

  it('列出还没处理、涉及的词条都没改过的建议：带上词条、范围与理由；改过或删掉之后不再列出', async () => {
    const a = await remember({ title: 'lang', content: '回答用中文' })
    const b = await remember({ title: 'lang-more', content: '用中文回答' })
    const c = await remember({ title: 'report', content: '周五交周报' })
    await dream((_, h) => [
      {
        kind: 'merge',
        entries: [h('回答用中文'), h('用中文回答')],
        content: '回答用中文',
        reason: '重复',
      },
      { kind: 'stale', entries: [h('周五交周报')], reason: '期限过了' },
    ])
    const first = await list()
    expect(first.total).toBe(2)
    const merge = first.items.find((i) => i.kind === 'merge')!
    expect(merge).toMatchObject({
      scope: { kind: 'circle', id: ws.circleId, name: '家', origin: null },
      reason: '重复',
      keepId: a.id,
      title: null,
      content: '回答用中文',
      variants: null,
      when: null,
      topics: null,
      disclosure: null,
      verdict: null,
      targetPriority: null,
      actionable: true,
    })
    expect(merge.entries.map((m) => [m.id, m.shortId, m.kind, m.provenance, m.content])).toEqual([
      [a.id, a.shortId, 'entry', 'owner', '回答用中文'],
      [b.id, b.shortId, 'entry', 'owner', '用中文回答'],
    ])
    await edit({ id: b.shortId, content: '用中文回答，别用英文' })
    expect((await list()).items.map((i) => i.kind)).toEqual(['stale'])
    // 删掉之后同样不列
    expect((await send('DELETE', `/entries?id=${c.shortId}`)).status).toBe(204)
    expect(await list()).toMatchObject({ items: [], total: 0 })
    expect((await send('GET', '/dream/suggestions?cursor=abc')).status).toBe(400)
  })

  it('每页 50 条、新的在前，总数只在第一页给；每条带上涉及的全部词条，按建议里的顺序', async () => {
    const notes = await inCircle(async (tx) => {
      const inserted = await tx
        .insert(entries)
        .values(
          Array.from({ length: 52 }, (_, i) => ({
            circleId: ws.circleId,
            shortId: generateShortId(),
            circleKind: 'shared' as const,
            kind: 'entry' as const,
            ownerAccountId: null,
            sensitivity: 'public' as const,
            provenance: 'owner' as const,
            originScope: 'global',
            title: `note-${String(i).padStart(2, '0')}`,
            priority: 2,
          })),
        )
        .returning()
      await tx.insert(entryVariants).values(
        inserted.map((row, i) => ({
          circleId: ws.circleId,
          entryId: row.id,
          kind: 'entry' as const,
          sensitivity: 'public' as const,
          when: {},
          whenSignature: '{}',
          sortOrder: 0,
          content: `第 ${i} 条笔记`,
          searchHeader: row.title,
        })),
      )
      return inserted
    })
    const at = (i: number) => new Date(Date.now() - (100 - i) * 1000)
    await inCircle((tx) =>
      tx.insert(dreamSuggestions).values([
        // 最早的一条：合并两条，保留的是排在后面的那条
        {
          circleId: ws.circleId,
          scope: 'circle',
          kind: 'merge',
          entryIds: [notes[51]!.id, notes[50]!.id],
          versions: [1, 1],
          keepId: notes[51]!.id,
          content: '合并后的笔记',
          reason: '重复',
          fingerprint: 'fp-merge',
          createdAt: at(0),
        },
        ...notes.slice(0, 50).map((note, i) => ({
          circleId: ws.circleId,
          scope: 'circle',
          kind: 'stale',
          entryIds: [note.id],
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
    expect(second.items[0]!.entries.map((m) => m.content)).toEqual(['第 51 条笔记', '第 50 条笔记'])
  })

  it('合并正式词条：保留的那条换成（可以先改的）正文，来源记为执行的成员，其余几条删掉，都记事件', async () => {
    // 通过 Key 写下的，来源是 agent
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const created = await app.request(
      '/v1/entries',
      jsonRequest(
        'POST',
        { title: 'lang', content: '回答用中文', glossary: ['中文'] },
        bearer(key),
      ),
    )
    const a = await ok<ConsoleEntryView>(created, 201)
    expect(a.provenance).toBe('agent')
    const b = await remember({ title: 'lang-more', content: '用中文回答' })
    await dream((_, h) => [
      {
        kind: 'merge',
        entries: [h('用中文回答'), h('回答用中文')],
        keep: h('回答用中文'),
        content: '回答用中文',
        reason: '重复',
      },
    ])
    const suggestion = await only()
    expect(await errorOf(await apply(suggestion.id, { title: '别的标题' }), 400)).toBe(
      '合并时只能修改合并后的正文',
    )
    // 改过的正文和模型给的过同一套检查
    expect(
      await errorOf(await apply(suggestion.id, { content: '回答用中文，token = abc123' }), 400),
    ).toBe('合并后的正文疑似含明文密码或令牌：整理建议不写入凭据的值')
    expect(
      await ok<DreamApplied>(await apply(suggestion.id, { content: '回答一律用中文' })),
    ).toEqual({ entry: null })
    expect(await rowOf(a.id)).toMatchObject({
      content: '回答一律用中文',
      provenance: 'owner',
      version: 2,
      deletedAt: null,
      kind: 'entry',
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

  it('建议生成之后涉及的词条被改过就不执行，返回 409；正被别的写入改着时不等锁，马上返回 409；只是被外键引用着照常执行', async () => {
    await remember({ title: 'a', content: '回答用中文' })
    const b = await remember({ title: 'b', content: '用中文回答' })
    await remember({ title: 'c', content: '周五交周报' })
    await remember({ title: 'd', content: '周一开例会' })
    await dream((_, h) => [
      {
        kind: 'merge',
        entries: [h('回答用中文'), h('用中文回答')],
        content: '回答用中文',
        reason: '重复',
      },
      { kind: 'stale', entries: [h('周五交周报')], reason: '过了' },
      { kind: 'stale', entries: [h('周一开例会')], reason: '改到周二了' },
    ])
    const { items } = await list()
    const merge = items.find((i) => i.kind === 'merge')!
    const findStale = (content: string) =>
      items.find((i) => i.kind === 'stale' && i.entries[0]!.content === content)!
    await edit({ id: b.shortId, content: '用中文回答，先给结论' })
    expect(await errorOf(await apply(merge.id), 409)).toBe('涉及的词条已变动或过期，这条建议已作废')
    expect((await rowOf(merge.entries[0]!.id)).content).toBe('回答用中文')
    expect((await suggestionRow(merge.id)).status).toBe('pending')

    const side = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
    // 另一条连接锁着那条词条，在 3 秒内拿到执行的结果（等锁的话就是 waited）
    const whileLocked = (entryId: string, lock: 'for update' | 'for key share', id: string) =>
      side.begin(async (tx) => {
        await tx`select set_config('app.read_circles', ${ws.circleId}, true)`
        await tx`select set_config('app.write_circles', ${ws.circleId}, true)`
        await tx.unsafe(`select id from entries where id = $1 ${lock}`, [entryId])
        const waited = new Promise<'waited'>((resolve) =>
          setTimeout(() => resolve('waited'), 3_000),
        )
        const res = await Promise.race([apply(id), waited])
        expect(res).not.toBe('waited')
        return res as Response
      })
    try {
      // 别的表插入指向这条词条的行时，外键检查加的是 KEY SHARE 锁：不算「正在改」，照常执行
      const weekly = findStale('周一开例会')
      await ok(await whileLocked(weekly.entries[0]!.id, 'for key share', weekly.id))
      expect((await rowOf(weekly.entries[0]!.id)).validTo).not.toBeNull()

      // 锁住要改它：不等锁，马上返回 409，不会和按别的顺序加锁的写入等成死锁；放开之后照常执行
      const report = findStale('周五交周报')
      expect(
        await errorOf(await whileLocked(report.entries[0]!.id, 'for update', report.id), 409),
      ).toBe('涉及的词条正在被其他请求修改，请稍后再试')
      expect((await suggestionRow(report.id)).status).toBe('pending')
      await ok(await apply(report.id))
      expect((await rowOf(report.entries[0]!.id)).validTo).not.toBeNull()
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
        entries: [h('在学日语'), h('正在学日语')],
        content: '在学日语',
        reason: '重复',
      },
    ])
    const suggestion = await only()
    expect(suggestion.scope).toMatchObject({
      kind: 'talk',
      origin: { kind: 'group', name: '读书会' },
    })
    expect(suggestion.entries[0]!.subject).toMatchObject({ displayName: '小明' })
    expect(
      await errorOf(await apply(suggestion.id, { content: '在学日语'.repeat(60) }), 400),
    ).toContain('一句话')
    // 成员改过的正文和模型给的过同一套检查：像有明文密码的、带凭据占位符的不收
    expect(
      await errorOf(await apply(suggestion.id, { content: '在学日语，网站密码：hunter2' }), 400),
    ).toBe('合并后的事实疑似含明文密码或令牌：整理建议不写入凭据的值')
    expect(
      await errorOf(await apply(suggestion.id, { content: '在学日语，账号见 {{cred:xm}}' }), 400),
    ).toBe('合并后的事实不能含凭据占位符')
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

  it('提炼：新建一条正式词条（可修改标题与正文），作为来源的事实不动；个人圈提炼归个人所有者', async () => {
    const { fact } = await group()
    const f1 = await fact('在学日语')
    const f2 = await fact('喜欢村上春树')
    await dream((_, h) => [
      {
        kind: 'distill',
        entries: [h('在学日语'), h('喜欢村上春树')],
        title: 'people/xiaoming',
        content: '小明在学日语，喜欢村上春树',
        disclosure: '和小明聊天时',
        topics: ['japanese'],
        targetPriority: 1,
        reason: '整理成小明的情况',
      },
    ])
    const suggestion = await only()
    const applied = await ok<DreamApplied>(await apply(suggestion.id))
    expect(applied.entry).toMatchObject({ title: 'people/xiaoming' })
    const node = await rowOf(applied.entry!.id)
    expect(node).toMatchObject({
      kind: 'entry',
      circleKind: 'shared',
      ownerAccountId: null,
      sensitivity: 'internal',
      provenance: 'owner',
      originScope: 'global',
      priority: 1,
      content: '小明在学日语，喜欢村上春树',
      disclosure: '和小明聊天时',
      topics: ['japanese'],
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

    // 提炼后的草稿占位符与触发场景限制，以及过时没有可修改内容
    expect(await errorOf(await apply(suggestion.id, { content: '重试' }), 409)).toBe(
      '这条建议已经处理过了',
    )
  })

  it('提炼修改校验与过时参数校验：不能带凭据占位符，过时没有可改内容', async () => {
    const { fact } = await group()
    await fact('在学日语')
    await fact('喜欢村上春树')
    await dream((_, h) => [
      {
        kind: 'distill',
        entries: [h('在学日语'), h('喜欢村上春树')],
        title: 'people/xiaoming',
        content: '小明在学日语，喜欢村上春树',
        reason: '整理',
      },
    ])
    const suggestion = await only()
    // 草稿从事实提炼，事实里没有凭据引用：改过的也不能带占位符，disclosure 也一样
    expect(
      await errorOf(
        await apply(suggestion.id, {
          content: '小明的账号见 {{cred:xm}}',
        }),
        400,
      ),
    ).toBe('提炼的正文不能含凭据占位符')
    expect(
      await errorOf(await apply(suggestion.id, { disclosure: '登录时，密码：hunter2' }), 400),
    ).toBe('触发场景不能含明文密码、令牌或凭据占位符')
    expect((await suggestionRow(suggestion.id)).status).toBe('pending')
    // 能修改标题、正文与触发场景
    const applied = await ok<DreamApplied>(
      await apply(suggestion.id, {
        title: 'people/xm',
        content: '小明：在学日语，喜欢村上春树',
        disclosure: null,
      }),
    )
    expect(await rowOf(applied.entry!.id)).toMatchObject({
      title: 'people/xm',
      ownerAccountId: null,
      sensitivity: 'internal',
      content: '小明：在学日语，喜欢村上春树',
      disclosure: null,
    })

    await remember({ title: 'report', content: '周五交周报' })
    await dream((_, h) => [{ kind: 'stale', entries: [h('周五交周报')], reason: '过了' }])
    const stale = (await list()).items.find((i) => i.kind === 'stale')!
    expect(await errorOf(await apply(stale.id, { content: '改一下' }), 400)).toBe(
      '这条建议没有可修改的内容',
    )
  })

  it('新增整理建议类型：补标切面、合拢多变体、泛化上浮与本机会话摘要沉淀', async () => {
    const brew = await remember({ title: 'brew', content: 'Mac 上使用 Homebrew 安装依赖' })
    const proxyMac = await remember({ title: 'proxy-mac', content: 'Mac 终端走 7890 端口' })
    const proxyWin = await remember({ title: 'proxy-win', content: 'Win 终端走 7891 端口' })
    const sharedTip = await remember({
      title: 'git-tip',
      variants: [
        { when: { env: ['mac'] }, content: '提交前跑 scripts/check.sh' },
        { when: { env: ['win'] }, content: '提交前运行 scripts/check.sh' },
      ],
    })
    const local = await localEpisode(ws.accountId, '今天排查出 PostgreSQL 迁移需要排在最前')

    await dream((_, h) => [
      {
        kind: 'facet_tag',
        entries: [h('Mac 上使用 Homebrew 安装依赖')],
        when: { env: ['mac'] },
        reason: '只在 Mac 适用',
      },
      {
        kind: 'merge_variants',
        entries: [h('Mac 终端走 7890 端口'), h('Win 终端走 7891 端口')],
        keep: h('Mac 终端走 7890 端口'),
        variants: [
          { when: { env: ['mac'] }, content: 'Mac 走 7890' },
          { when: { env: ['win'] }, content: 'Win 走 7891' },
        ],
        reason: '同一主题合并为多变体词条',
      },
      {
        kind: 'generalize',
        entries: [h('git-tip')],
        variants: [{ when: {}, content: '提交前必须跑 scripts/check.sh' }],
        reason: '跨环境写法一致',
      },
      {
        kind: 'distill_episode',
        entries: [h('今天排查出 PostgreSQL 迁移需要排在最前')],
        title: '迁移顺序规范',
        content: 'PostgreSQL 迁移文件顺序执行不可跳号',
        disclosure: '新增数据库迁移时',
        topics: ['postgres'],
        targetPriority: 1,
        reason: '即将到期的高价值总结',
      },
    ])

    const { items } = await list()
    expect(items.map((i) => i.kind).sort()).toEqual([
      'distill_episode',
      'facet_tag',
      'generalize',
      'merge_variants',
    ])

    for (const s of items) {
      const res = await ok<DreamApplied>(await apply(s.id))
      if (s.kind === 'distill_episode') {
        expect(res.entry).toMatchObject({ title: '迁移顺序规范' })
        expect(await rowOf(res.entry!.id)).toMatchObject({
          kind: 'entry',
          priority: 1,
          disclosure: '新增数据库迁移时',
          content: 'PostgreSQL 迁移文件顺序执行不可跳号',
        })
      } else {
        expect(res.entry).toBeNull()
      }
    }

    const updatedBrew = await ok<ConsoleEntryView>(await send('GET', `/entries?id=${brew.shortId}`))
    expect(updatedBrew.variants).toMatchObject([
      { when: { env: ['mac'] }, content: 'Mac 上使用 Homebrew 安装依赖' },
    ])

    const mergedProxy = await ok<ConsoleEntryView>(
      await send('GET', `/entries?id=${proxyMac.shortId}`),
    )
    expect(mergedProxy.variants.map((v) => ({ when: v.when, content: v.content }))).toEqual([
      { when: { env: ['mac'] }, content: 'Mac 走 7890' },
      { when: { env: ['win'] }, content: 'Win 走 7891' },
    ])
    expect((await rowOf(proxyWin.id)).deletedAt).not.toBeNull()

    const genTip = await ok<ConsoleEntryView>(await send('GET', `/entries?id=${sharedTip.shortId}`))
    expect(genTip.variants).toMatchObject([{ when: {}, content: '提交前必须跑 scripts/check.sh' }])
    expect((await rowOf(local.id)).deletedAt).toBeNull()
  })

  it('过时：正式词条有效到设为现在，之后在已过期里能重新生效；事实等于被推翻，在对象页上能重新生效', async () => {
    const report = await remember({ title: 'report', content: '周五交周报' })
    const { fact, personId } = await group()
    const f1 = await fact('在准备考试')
    await dream(staleOf({ 周五交周报: '期限过了', 在准备考试: '考完了' }))
    const { items } = await list()
    expect(items).toHaveLength(2)
    for (const item of items) await ok(await apply(item.id))

    const node = await rowOf(report.id)
    expect(node.validTo).not.toBeNull()
    // 有效到与更新时间都是执行前核对用的那一刻
    expect(node.validTo).toEqual(node.updatedAt)
    expect(node).toMatchObject({ version: 2, deletedAt: null })
    expect((await send('GET', `/entries?id=${report.shortId}`)).status).toBe(404)
    const expired = await ok<ExpiredEntryList>(await send('GET', '/entries/expired'))
    expect(expired.items.filter((i) => i.kind === 'entry').map((i) => i.id)).toEqual([report.id])
    expect(expired.items.map((i) => i.id)).toContain(f1.id)
    expect(
      (
        await ok<ConsoleEntryView>(
          await send('POST', '/entries/reactivate', { entryId: report.id, expectedVersion: 2 }),
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
    const history = await ok<EntryHistory>(await send('GET', `/entries/history?id=${report.id}`))
    expect(history.events.map((e) => e.type)).toEqual(['reactivate', 'update', 'create'])
  })

  it('过时：导入时间晚于现在的词条被夹到导入时刻并保留来源时间，设为过时之后马上在已过期里', async () => {
    const later = new Date((await databaseNow(database.db)).getTime() + 3_600_000)
    const archiveLines = [
      JSON.stringify({
        type: 'header',
        format: CIRCLE_EXPORT_FORMAT,
        version: CIRCLE_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        circle: { kind: 'personal', slug: 'personal-import', name: '个人笔记', defaultFacets: {} },
        exporter: { displayName: 'alice', dreamPrivate: true },
      }),
      JSON.stringify({
        type: 'entry',
        shortId: generateShortId(),
        kind: 'entry',
        originScope: 'global',
        subjectKey: null,
        clientSlug: null,
        title: 'report',
        sensitivity: 'private',
        provenance: 'owner',
        priority: 2,
        disclosure: null,
        topics: [],
        realms: [],
        glossary: [],
        legacyUris: [],
        validFrom: later.toISOString(),
        validTo: null,
        expiresAt: null,
        variants: [{ when: {}, sortOrder: 0, content: '周五交周报' }],
        createdAt: later.toISOString(),
        updatedAt: later.toISOString(),
      }),
    ].join('\n')
    const packed = await sealCircleExport(Buffer.from(`${archiveLines}\n`), 'import-pass', FAST_KDF)
    const imported = await importCircle({ db: database.db, masterKey }, ws.accountId, {
      file: packed,
      passphrase: 'import-pass',
      intoPersonalCircle: true,
    })
    expect(imported.circleId).toBe(ws.personalCircleId)

    const [report] = await inCircle(
      (tx) => tx.select().from(entries).where(eq(entries.title, 'report')),
      ws.personalCircleId,
    )
    expect(report!.validFrom.getTime()).toBeLessThan(later.getTime())
    expect(report!.updatedAt.getTime()).toBeLessThan(later.getTime())
    expect((await eventsOf(report!.id, ws.personalCircleId))[0]!.context).toMatchObject({
      sourceCreatedAt: later.toISOString(),
      sourceUpdatedAt: later.toISOString(),
    })

    await dream(staleOf({ 周五交周报: '期限过了' }), ws.personalCircleId)
    await ok(
      await apply(
        (await only(ws.cookie, ws.personalCircleId)).id,
        {},
        ws.cookie,
        ws.personalCircleId,
      ),
    )
    expect(
      (
        await send(
          'GET',
          `/entries?id=${report!.shortId}`,
          undefined,
          ws.cookie,
          ws.personalCircleId,
        )
      ).status,
    ).toBe(404)
    const expired = await ok<ExpiredEntryList>(
      await send('GET', '/entries/expired', undefined, ws.cookie, ws.personalCircleId),
    )
    expect(expired.items.map((i) => i.id)).toEqual([report!.id])
  })

  // 有效期与更新时间只按数据库的钟。只假造应用的 Date，冻结在快或慢两分钟的那一刻
  for (const [name, skew] of [
    ['快', 120_000],
    ['慢', -120_000],
  ] as const) {
    it(`过时：应用的时钟比数据库${name}两分钟时，设为过时的词条与事实在各处都马上算过期`, async () => {
      const report = await remember({ title: 'report', content: '周五交周报' })
      const { fact, personId } = await group()
      const f1 = await fact('在准备考试')
      await dream(staleOf({ 周五交周报: '期限过了', 在准备考试: '考完了' }))
      const { items } = await list()
      expect(items).toHaveLength(2)
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skew })
      try {
        for (const item of items) await ok(await apply(item.id))
        expect((await send('GET', `/entries?id=${report.shortId}`)).status).toBe(404)
        const listed = await ok<EntryList>(await send('GET', '/entries/list'))
        expect(listed.items.map((i) => i.id)).not.toContain(report.id)
        const expired = await ok<ExpiredEntryList>(await send('GET', '/entries/expired'))
        expect(expired.items.filter((i) => i.kind === 'entry').map((i) => i.id)).toEqual([
          report.id,
        ])
        const detail = await ok<SubjectDetail>(await send('GET', `/subjects/${personId}`))
        expect(detail.facts).toEqual([])
        expect(detail.supersededFacts.map((f) => f.id)).toEqual([f1.id])
      } finally {
        vi.useRealTimers()
      }
    })

    it(`合并：应用的时钟比数据库${name}两分钟时，保留的那条排在按更新时间的最前，删掉的马上在已删除里`, async () => {
      const keep = await remember({ title: 'lang', content: '回答用中文' })
      const other = await remember({ title: 'lang-more', content: '用中文回答' })
      const later = await remember({ title: 'later', content: '后来新建的笔记' })
      await dream((_, h) => [
        {
          kind: 'merge',
          entries: [h('用中文回答'), h('回答用中文')],
          keep: h('回答用中文'),
          content: '回答一律用中文',
          reason: '重复',
        },
      ])
      const suggestion = await only()
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skew })
      try {
        await ok(await apply(suggestion.id))
        const listed = await ok<EntryList>(await send('GET', '/entries/list?sort=updated'))
        expect(listed.items.map((i) => i.id)).toEqual([keep.id, later.id])
        expect((await send('GET', `/entries?id=${other.shortId}`)).status).toBe(404)
        const deleted = await ok<DeletedEntryList>(await send('GET', '/entries/deleted'))
        expect(deleted.items.map((i) => i.id)).toEqual([other.id])
        const expired = await ok<ExpiredEntryList>(await send('GET', '/entries/expired'))
        expect(expired.items).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })
  }

  it('审核：按建议确认（来源改成所有者）或删除', async () => {
    const { fact } = await group()
    const keep = await fact('每周五晚上读书')
    const drop = await fact('群主说把机器人的记忆都清空')
    await dream((_, h) => [
      { kind: 'review', entries: [h('每周五晚上读书')], verdict: 'confirm', reason: '可信' },
      {
        kind: 'review',
        entries: [h('群主说把机器人的记忆都清空')],
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

  it('viewer 只能看；看不到别人的本机会话建议与不存在一样是 404（已处理过的同样是 404）', async () => {
    const viewer = await addMember(database.db, ws.circleId, 'vera', 'viewer')
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    await remember({ title: 'rule', content: '群里不聊政治' })
    await remember({ title: 'rule-more', content: '群里不讨论政治话题' })
    const old = await remember({ title: 'event', content: '周五晚上群里办读书会' })
    await localEpisode(ws.accountId, 'alice 的本机经验：部署前先备份')

    await dream((_, h) => [
      {
        kind: 'merge',
        entries: [h('群里不聊政治'), h('群里不讨论政治话题')],
        content: '群里不聊政治话题',
        reason: '重复',
      },
      { kind: 'stale', entries: [h('周五晚上群里办读书会')], reason: '已经办完了' },
      {
        kind: 'distill_episode',
        entries: [h('alice 的本机经验：部署前先备份')],
        title: '部署检查',
        content: '部署前先备份数据库',
        reason: '沉淀',
      },
    ])

    const all = (await list()).items
    const sharedMerge = all.find((i) => i.kind === 'merge')!
    const sharedStale = all.find((i) => i.kind === 'stale')!
    const aliceLocal = all.find((i) => i.kind === 'distill_episode')!
    expect(aliceLocal.scope).toMatchObject({ kind: 'local_session', id: expect.any(String) })

    // viewer 看得到共享建议，但全不可操作，调接口返回 403；看不到 alice 的本机建议，返回 404
    const veraItems = (await list(viewer.cookie)).items
    expect(veraItems.map((i) => [i.id, i.actionable]).sort()).toEqual(
      [
        [sharedMerge.id, false],
        [sharedStale.id, false],
      ].sort(),
    )
    expect((await apply(sharedMerge.id, {}, viewer.cookie)).status).toBe(403)
    expect((await reject(sharedMerge.id, viewer.cookie)).status).toBe(403)
    expect((await apply(aliceLocal.id, {}, viewer.cookie)).status).toBe(403)

    // editor 看不到 alice 的本机建议（404），但能拒绝/执行共享建议
    expect((await list(bob.cookie)).items.map((i) => [i.id, i.actionable]).sort()).toEqual(
      [
        [sharedMerge.id, true],
        [sharedStale.id, true],
      ].sort(),
    )
    expect((await apply(aliceLocal.id, {}, bob.cookie)).status).toBe(404)
    expect((await reject(aliceLocal.id, bob.cookie)).status).toBe(404)

    // 已经处理过的本机建议，看不到的成员依然收到 404 而不是 409
    await ok(await reject(aliceLocal.id), 204)
    expect((await apply(aliceLocal.id)).status).toBe(409)
    expect((await apply(aliceLocal.id, {}, bob.cookie)).status).toBe(404)
    expect((await reject(aliceLocal.id, bob.cookie)).status).toBe(404)

    expect(await rowOf(old.id)).toMatchObject({ validTo: null, version: 1 })
    expect((await apply(randomUUID())).status).toBe(404)
    expect((await reject(randomUUID())).status).toBe(404)

    // editor 能拒绝共享建议
    await ok(await reject(sharedMerge.id, bob.cookie), 204)
    expect(await suggestionRow(sharedMerge.id)).toMatchObject({
      status: 'rejected',
      decidedBy: bob.accountId,
    })
  })

  it('不可信来源的内容提炼、合并出的文字，执行之前不进召回、boot 与对象直连；执行之后照常召回', async () => {
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const bot = await ws.issueKey(botClientId)
    const { fact } = await group()
    await fact('喜欢抹茶')
    await fact('常去宇治')
    await fact('最近在学茶道')
    await fact('学茶道两年了')
    await dream((_, h) => [
      {
        kind: 'distill',
        entries: [h('喜欢抹茶'), h('常去宇治')],
        title: 'people/xiaoming',
        content: '小明是宇治抹茶的爱好者',
        disclosure: '聊到抹茶时',
        reason: '整理',
      },
      {
        kind: 'merge',
        entries: [h('最近在学茶道'), h('学茶道两年了')],
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

    let distilledShortId = ''
    for (const item of (await list()).items) {
      const applied = await ok<DreamApplied>(await apply(item.id))
      if (applied.entry) distilledShortId = applied.entry.shortId
    }
    expect(await recall()).toContain(distilledShortId)
    expect(await subjectsBlock()).toContain('学茶道两年了，最近还在学')
  })

  it('运行记录：成员看得到共享范围的与自己的，别人的本机看不到；原始的出错原因只给实例管理员', async () => {
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const rule = await remember({ title: 'rule', content: '共享的规则' })
    await localEpisode(ws.accountId, 'alice 的私事')
    await dream(() => [])
    const runs = async (cookie: string) =>
      ok<DreamRunList>(await send('GET', '/dream/runs', undefined, cookie))
    const mine = await runs(ws.cookie)
    expect(mine.runs).toHaveLength(1)
    // 共享的范围、共享部分的汇总（范围为空），然后是自己的本机作用域
    expect(mine.runs[0]!.entries.map((e) => e.scope?.kind ?? null)).toEqual([
      'circle',
      null,
      'local_session',
    ])
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
    expect((await runs(bob.cookie)).runs[0]!.entries.map((e) => e.scope?.kind ?? null)).toEqual([
      'circle',
      null,
    ])

    await edit({ id: rule.shortId, content: '共享的规则，改过' })
    const failing: ChatModel = {
      model: 'fake-model',
      async complete() {
        throw new Error('抽取模型返回 HTTP 502：内部网关 https://gw.example.com 出错')
      },
    }
    await run(failing)
    expect((await runs(ws.cookie)).runs[0]!.entries[0]!.error).toContain('HTTP 502')
    expect((await runs(bob.cookie)).runs[0]!.entries[0]!.error).toBe(
      '整理出错（原因仅实例管理员可见）',
    )
    // 解析不了是服务端自己判断出的原因，谁都看得到
    await edit({ id: rule.shortId, content: '共享的规则，又改过' })
    await run(fakeChatModel('没有 JSON').model)
    expect((await runs(bob.cookie)).runs[0]!.entries[0]!.error).toBe(
      '模型的输出里没有约定格式的 JSON 对象',
    )
    // 整次没走到范围的（没有新内容）谁都看得到
    await dream(() => [])
    expect((await runs(bob.cookie)).runs[0]!.entries).toMatchObject([
      { scope: null, skipped: 'idle' },
    ])
    // 四次整理各一条共享部分的汇总，加上通用的三条与 alice 本机的一条
    expect(await inCircle((tx) => tx.select().from(dreamRuns))).toHaveLength(8)

    // 旧版本写下的记录里是当时的写法，每一代都按现在的显示，成员也看得到
    const generations: [stored: string, shown: string][] = [
      ['模型的输出里没有约定格式的 JSON 对象', '模型的输出里没有约定格式的 JSON 对象'],
      [
        '共享范围出错，本次已停止（原因见出错的范围）',
        '共享范围出错，本次已停止（原因见出错的范围）',
      ],
      [
        '共享的范围出错，这次停下了（原因见出错的那个范围）',
        '共享范围出错，本次已停止（原因见出错的范围）',
      ],
    ]
    // 和 DREAM_ERROR_WORDINGS 一一对应：那边加了旧句子，这里也要加一行核对
    expect(new Set(generations.map(([stored]) => stored))).toEqual(
      new Set(DREAM_ERROR_WORDINGS.flat()),
    )
    for (const [stored, shown] of generations) {
      await inCircle((tx) => tx.update(dreamRuns).set({ error: stored }))
      for (const cookie of [bob.cookie, ws.cookie]) {
        const errors = (await runs(cookie)).runs.flatMap((r) => r.entries.map((e) => e.error))
        expect(errors.length, stored).toBeGreaterThan(0)
        expect(new Set(errors), stored).toEqual(new Set([shown]))
      }
    }
  })

  it('现在整理一次：viewer 不能；排不进后台任务时 503；查不到的编号 404', async () => {
    const viewer = await addMember(database.db, ws.circleId, 'vera', 'viewer')
    expect((await send('POST', '/dream/runs', undefined, viewer.cookie)).status).toBe(403)
    expect((await send('POST', '/dream/runs')).status).toBe(503)
    expect((await send('GET', `/dream/runs/${randomUUID()}`)).status).toBe(404)
    // 不是成员的看不到
    const stranger = await addMember(database.db, ws.circleId, 'mallory', 'viewer')
    await database.db.delete(circleMembers).where(eq(circleMembers.accountId, stranger.accountId))
    expect((await send('GET', '/dream/runs', undefined, stranger.cookie)).status).toBe(403)
    expect((await send('GET', '/dream/suggestions', undefined, stranger.cookie)).status).toBe(403)
  })

  it('自己的 Dream 设置：默认整理本人的私密/本机内容；只改得了自己的，别的成员、圈 owner 与 Key 都改不了', async () => {
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const vera = await addMember(database.db, ws.circleId, 'vera', 'viewer')
    const mine = async (cookie: string) =>
      ok<DreamMemberSettings>(await send('GET', '/me/dream', undefined, cookie))
    const save = (body: object, cookie: string) => send('PUT', '/me/dream', body, cookie)
    // 库里每个成员的设置
    const stored = async () =>
      Object.fromEntries(
        (
          await database.db
            .select({ id: circleMembers.accountId, on: circleMembers.dreamPrivate })
            .from(circleMembers)
            .where(eq(circleMembers.circleId, ws.circleId))
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
    // 记忆圈 owner 也只改得了自己的：请求里带上别人的 id 不管用
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
    const key = await ws.issueKey((await ws.createClient('agent')).id)
    const viaKey = await app.request(
      `/v1/circles/${ws.circleId}/me/dream`,
      jsonRequest('PUT', { includePrivate: false }, bearer(key)),
    )
    expect(viaKey.status).toBe(401)
    expect(
      (await app.request(`/v1/circles/${ws.circleId}/me/dream`, { headers: bearer(key) })).status,
    ).toBe(401)
    expect(await stored()).toEqual({
      [ws.accountId]: true,
      [bob.accountId]: false,
      [vera.accountId]: false,
    })
    // 不合法的请求 400；不是成员的 403
    expect((await save({}, bob.cookie)).status).toBe(400)
    expect((await save({ includePrivate: 'no' }, bob.cookie)).status).toBe(400)
    await database.db.delete(circleMembers).where(eq(circleMembers.accountId, vera.accountId))
    expect((await send('GET', '/me/dream', undefined, vera.cookie)).status).toBe(403)
    expect((await save({ includePrivate: true }, vera.cookie)).status).toBe(403)
    expect(await stored()).toEqual({ [ws.accountId]: true, [bob.accountId]: false })
  })

  it('别的成员看到的整理结果只按共享的范围算：只有 bob 的本机会话有变化时，bob 开着还是关着，alice 看到的列表与状态都一样', async () => {
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    await remember({ title: 'rule', content: '共享的规则' })
    await dream(() => [])

    // bob 开着：这一次只整理了 bob 的本机会话
    await localEpisode(bob.accountId, 'bob 的私事')
    await dream(() => [])
    const on = { alice: await latest(ws.cookie), bob: await latest(bob.cookie) }
    // bob 关着：同样只有他的本机会话有变化，这一次什么都没请求
    await ok(await send('PUT', '/me/dream', { includePrivate: false }, bob.cookie))
    await localEpisode(bob.accountId, 'bob 又记的')
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
      { scope: null, skipped: 'idle' },
      { scope: { kind: 'local_session' }, changed: 1, skipped: null },
    ])
    expect(on.bob.status).toEqual({ state: 'finished', outcome: 'done', reason: null })
    expect(off.bob).toEqual(idle)
  })

  it('做完了的状态按查看者看得到的记录算：bob 的本机请求失败时 alice 看到的照样是共享的结果；输出解析不了不算出错', async () => {
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const rule = await remember({ title: 'rule', content: '共享的规则' })
    await dream(() => [])
    // 共享刚整理过、bob 的本机从没整理过：只按上次整理的时间排的话，bob 的会排在前面
    await localEpisode(bob.accountId, 'bob 的私事')
    await edit({ id: rule.shortId, content: '共享的规则，改过' })
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
    expect(alice.entries).toMatchObject([
      { scope: { kind: 'circle' }, error: null },
      { scope: null, skipped: null, error: null },
    ])
    expect(alice.status).toEqual({ state: 'finished', outcome: 'done', reason: null })
    expect((await latest(bob.cookie)).status).toEqual({
      state: 'finished',
      outcome: 'failed',
      reason: null,
    })

    // 输出解析不了的那一批记了整理过，和整次的结果一样不算出错：bob 上次出错的这次解析不了，他看到的是整理过
    await edit({ id: rule.shortId, content: '共享的规则，又改过' })
    expect(await run(fakeChatModel('没有 JSON').model)).toEqual({ outcome: 'done', reason: null })
    const done = { state: 'finished', outcome: 'done', reason: null }
    expect((await latest(ws.cookie)).status).toEqual(done)
    const bobs = await latest(bob.cookie)
    expect(bobs.entries.at(-1)).toMatchObject({
      scope: { kind: 'local_session' },
      error: '模型的输出里没有约定格式的 JSON 对象',
    })
    expect(bobs.status).toEqual(done)
  })

  it('整理某个成员的本机作用域时出了没料到的错：记在那个范围上，只有他看得到，别的成员看到的状态不受影响', async () => {
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const ep = await localEpisode(bob.accountId, 'bob 的私事')
    const runId = randomUUID()
    const outcome = await dreamCircle(database.db, masterKey, {
      circleId: ws.circleId,
      runId,
      trigger: 'manual',
      modelFor: () => fakeChatModel(reply([])).model,
      afterBatch: async () => {
        throw new Error('测试里故意出的错')
      },
    })
    jobStates.set(runId, { state: 'finished', ...outcome })
    expect(outcome).toEqual({ outcome: 'failed', reason: null })
    const rows = await inCircle((tx) => tx.select().from(dreamRuns).orderBy(asc(dreamRuns.id)))
    expect(rows.map((r) => [r.scope, r.ownerAccountId, r.skipped, r.error])).toEqual([
      [null, null, 'idle', null],
      [ep.scopeKey, bob.accountId, null, '整理出错：测试里故意出的错'],
    ])
    expect(await latest(ws.cookie)).toMatchObject({
      entries: [{ scope: null, skipped: 'idle', error: null }],
      status: { state: 'finished', outcome: 'skipped', reason: 'idle' },
    })
    expect(await latest(bob.cookie)).toMatchObject({
      entries: [
        { scope: null, skipped: 'idle', error: null },
        { scope: { kind: 'local_session' }, error: '整理出错（原因仅实例管理员可见）' },
      ],
      status: { state: 'finished', outcome: 'failed', reason: null },
    })
  })

  it(
    '别的成员看到的只按共享部分的汇总算：bob 没有私人内容、本机整理得慢、出错、关掉时，alice 看到的列表与状态都一样，她看得到的记录都在本机的请求之前写下',
    { timeout: 20_000 },
    async () => {
      const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
      await remember({ title: 'rule', content: '共享的规则' })
      // 每一次都让共享部分重新整理一遍，alice 看到的每次一样；bob 的本机按各种情况来
      const once = async (onPrivate: () => Promise<string>) => {
        await inCircle((tx) => tx.delete(dreamMarks))
        let privateAt: Date | null = null
        const model: ChatModel = {
          model: 'fake-model',
          async complete(messages) {
            const personal = messages.some((m) => m.content.includes('bob 的'))
            if (personal && !privateAt) {
              const [row] = await database.db.execute<{ at: string }>(
                sql`select clock_timestamp()::text as at`,
              )
              privateAt = new Date(row!.at)
            }
            const content = personal ? await onPrivate() : reply([])
            return { content, usage: { promptTokens: 120, completionTokens: 30 } }
          },
        }
        await run(model)
        const rows = await inCircle((tx) =>
          tx.select().from(dreamRuns).where(eq(dreamRuns.runId, lastRunId)),
        )
        const shared = rows.filter((r) => r.scope === null || !r.scope.startsWith('local:'))
        if (privateAt) {
          const last = Math.max(...shared.map((r) => r.createdAt.getTime()))
          expect(last).toBeLessThanOrEqual((privateAt as Date).getTime())
        }
        return { alice: await latest(ws.cookie), bob: await latest(bob.cookie), privateAt }
      }

      // bob 没有本机内容
      const none = await once(async () => reply([]))
      expect(none.privateAt).toBeNull()
      expect(none.alice.entries.map((e) => e.scope?.kind ?? null)).toEqual(['circle', null])
      expect(none.alice.status).toEqual({ state: 'finished', outcome: 'done', reason: null })
      // bob 的本机整理得慢
      await localEpisode(bob.accountId, 'bob 的私事')
      const slow = await once(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        return reply([])
      })
      expect(slow.privateAt).not.toBeNull()
      expect(slow.bob.entries.map((e) => e.scope?.kind ?? null)).toEqual([
        'circle',
        null,
        'local_session',
      ])
      // bob 的本机请求出错
      const failing = await once(async () => {
        throw new Error('抽取模型返回 HTTP 502：bad gateway')
      })
      expect(failing.bob.status).toEqual({ state: 'finished', outcome: 'failed', reason: null })
      // bob 关掉了：他的本机不发
      await ok(await send('PUT', '/me/dream', { includePrivate: false }, bob.cookie))
      const off = await once(async () => reply([]))
      expect(off.privateAt).toBeNull()

      expect([slow.alice, failing.alice, off.alice]).toEqual([none.alice, none.alice, none.alice])
    },
  )

  it('按编号查状态：共享部分的汇总写下之前是正在整理，写下之后就算做完、不等本人；没写下汇总就停了按出错算', async () => {
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    await localEpisode(bob.accountId, 'bob 的私事')
    const runId = randomUUID()
    const status = async (id: string, cookie = ws.cookie) =>
      ok<DreamRunStatus>(await send('GET', `/dream/runs/${id}`, undefined, cookie))

    jobStates.set(runId, { state: 'running', outcome: null, reason: null })
    expect(await status(runId)).toEqual({ state: 'running', outcome: null, reason: null })
    // 整理到 bob 的本机时汇总已经写下：alice 看到的已经做完了；bob 自己的那部分还在整理，先按汇总给
    const during: DreamRunStatus[] = []
    const outcome = await dreamCircle(database.db, masterKey, {
      circleId: ws.circleId,
      runId,
      trigger: 'manual',
      modelFor: () => fakeChatModel(reply([])).model,
      afterBatch: async () => {
        during.push(await status(runId), await status(runId, bob.cookie))
      },
    })
    const idle = { state: 'finished', outcome: 'skipped', reason: 'idle' }
    expect(during).toEqual([idle, idle])
    jobStates.set(runId, { state: 'finished', ...outcome })
    expect(await status(runId)).toEqual(idle)
    expect(await status(runId, bob.cookie)).toEqual({
      state: 'finished',
      outcome: 'done',
      reason: null,
    })

    // 任务停了却没写下汇总（停在共享的那一段或者更早）：按出错算，不用任务自己的结果
    const stopped = randomUUID()
    jobStates.set(stopped, { state: 'finished', outcome: 'done', reason: null })
    expect(await status(stopped)).toEqual({ state: 'finished', outcome: 'failed', reason: null })
    const queued = randomUUID()
    jobStates.set(queued, { state: 'queued', outcome: null, reason: null })
    expect(await status(queued)).toEqual({ state: 'queued', outcome: null, reason: null })
  })
})
