import { randomBytes, randomUUID } from 'node:crypto'

import type {
  DreamQueued,
  DreamRunList,
  DreamRunStatus,
  DreamSuggestionList,
  ExtractionUsage,
  MemoryView,
} from '@kioku/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database, type Tx } from '../../db/client'
import {
  dreamMarks,
  dreamRuns,
  dreamSuggestions,
  extractionRuns,
  memories,
  memoryEmbeddings,
  settings,
  spaceMembers,
  spaces,
  subjects,
} from '../../db/schema'
import { backfillJob } from '../../embedding/jobs'
import { staticEmbedderSource } from '../../embedding/source'
import { startJobs, type Jobs } from '../../jobs/queue'
import {
  openTestDatabase,
  resetDatabase,
  settingsQueryFails,
  testDatabaseUrl,
} from '../../testing/db'
import { fakeChatModel, dreamLines, handleOf } from '../../testing/fakeChatModel'
import { startFakeChatServer } from '../../testing/fakeChatServer'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import {
  DREAM_CHANGED_PER_CALL,
  DREAM_MAX_CALLS,
  DREAM_MAX_TOKENS,
  DREAM_PERSONAL_CALLS,
  DREAM_PERSONAL_TOKENS,
  dreamsDue,
  dreamSpace,
} from '../dream'
import type { ChatMessage, ChatModel } from '../provider'
import { clearExtractionConfig, saveExtractionConfig } from '../settings'

// 请求里「## 范围」下面那一行
const titleOf = (messages: ChatMessage[]) => {
  const user = messages.find((m) => m.role === 'user')!.content
  return user.split('\n')[user.split('\n').indexOf('## 范围') + 1]!
}
const contentsOf = (messages: ChatMessage[]) => dreamLines(messages).map((l) => l.content)
const reply = (suggestions: unknown[]) => JSON.stringify({ suggestions })

describe.skipIf(!testDatabaseUrl)('Dream 的整理', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  const masterKey = randomBytes(32)
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
    dreamRun: async () => null,
  }
  const clearSettings = () =>
    database.db.delete(settings).where(sql`${settings.key} in ('extraction', 'embedding')`)

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
    await clearSettings()
    await database.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await clearSettings()
    ws = await bootstrap(app)
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
  })

  const inSpace = <T>(fn: (tx: Tx) => Promise<T>, spaceId = ws.spaceId) =>
    withSpace(database.db, spaceId, fn)
  const send = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(
      `/v1/spaces/${ws.spaceId}${path}`,
      body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const remember = async (body: object, cookie = ws.cookie) => {
    const res = await send('POST', '/memories', body, cookie)
    expect(res.status, await res.clone().text()).toBe(201)
    return (await res.json()) as MemoryView
  }
  const edit = async (body: object, cookie = ws.cookie) => {
    const res = await send('PATCH', '/memories', body, cookie)
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as MemoryView
  }
  const subject = async (kind: 'person' | 'group', name: string) =>
    (
      await inSpace((tx) =>
        tx
          .insert(subjects)
          .values({ spaceId: ws.spaceId, kind, displayName: name })
          .returning({ id: subjects.id }),
      )
    )[0]!.id
  // 群里抽取的一条事实（默认不可信来源）
  const fact = async (
    subjectId: string,
    content: string,
    scope: string,
    provenance: 'untrusted' | 'owner' = 'untrusted',
  ) =>
    (
      await inSpace((tx) =>
        tx
          .insert(memories)
          .values({
            spaceId: ws.spaceId,
            form: 'extracted',
            layer: 'subject',
            sensitivity: 'public',
            provenance,
            originScope: scope,
            subjectId,
            content,
          })
          .returning(),
      )
    )[0]!
  const summary = async (content: string, scope: string) =>
    (
      await inSpace((tx) =>
        tx
          .insert(memories)
          .values({
            spaceId: ws.spaceId,
            form: 'extracted',
            layer: 'episode',
            sensitivity: 'public',
            provenance: 'untrusted',
            originScope: scope,
            content,
            expiresAt: new Date(Date.now() + 30 * 86_400_000),
          })
          .returning(),
      )
    )[0]!
  const dream = (
    model: ChatModel,
    trigger: 'manual' | 'scheduled' = 'manual',
    spaceId = ws.spaceId,
  ) =>
    dreamSpace(database.db, masterKey, {
      spaceId,
      runId: randomUUID(),
      trigger,
      modelFor: () => model,
    })
  const stored = () =>
    inSpace((tx) =>
      tx
        .select()
        .from(dreamSuggestions)
        .orderBy(asc(dreamSuggestions.kind), asc(dreamSuggestions.createdAt)),
    )
  const runs = (spaceId = ws.spaceId) =>
    inSpace((tx) => tx.select().from(dreamRuns).orderBy(asc(dreamRuns.id)), spaceId)
  // 各个范围的运行记录，与每次整理一条的共享部分的汇总（范围为空）
  const scopeRuns = async () => (await runs()).filter((r) => r.scope !== null)
  const summaries = async () => (await runs()).filter((r) => r.scope === null)
  const forget = () => inSpace((tx) => tx.delete(dreamMarks))

  it('提出四种建议：策展记忆的合并与过时，事实的合并、提炼与过时，不可信内容的审核；每个范围请求一次', async () => {
    const a = await remember({ uri: 'core://style', content: '回答用中文', layer: 'base' })
    const b = await remember({
      uri: 'core://style-more',
      content: '回答时用中文，先给结论',
      layer: 'base',
    })
    const c = await remember({ uri: 'core://report', content: '周五之前交周报', layer: 'base' })
    const group = await subject('group', '读书会')
    const xm = await subject('person', '小明')
    const scope = `group:${group}`
    const f1 = await fact(xm, '在学日语', scope)
    const f2 = await fact(xm, '正在学日语', scope)
    const f3 = await fact(xm, '喜欢村上春树', scope)
    const s1 = await summary('聊了读书会的安排', scope)
    const { model, calls } = fakeChatModel((messages) => {
      const h = (content: string) => handleOf(messages, content)!
      if (titleOf(messages).includes('基础层')) {
        return reply([
          {
            kind: 'merge',
            memories: [h('回答用中文'), h('回答时用中文，先给结论')],
            keep: h('回答用中文'),
            content: '回答用中文，先给结论',
            reason: '两条说的是同一件事',
          },
          { kind: 'stale', memories: [h('周五之前交周报')], reason: '说的是已经过去的期限' },
        ])
      }
      return reply([
        {
          kind: 'merge',
          memories: [h('在学日语'), h('正在学日语')],
          keep: h('在学日语'),
          content: '在学日语',
          reason: '重复',
        },
        {
          kind: 'distill',
          memories: [h('在学日语'), h('喜欢村上春树')],
          uri: 'people://xiaoming',
          content: '小明在学日语，喜欢村上春树',
          disclosure: '和小明聊天时',
          reason: '可以整理成小明的情况',
        },
        { kind: 'stale', memories: [h('正在学日语')], reason: '后来说过已经学完了' },
        {
          kind: 'review',
          memories: [h('聊了读书会的安排')],
          verdict: 'confirm',
          reason: '摘要可信',
        },
        { kind: 'review', memories: [h('喜欢村上春树')], verdict: 'delete', reason: '没有依据' },
      ])
    })
    expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
    expect(calls.map(titleOf)).toEqual([
      '全空间共用的基础规则与知识（基础层）',
      '群「读书会」的聊天里记下的事实与会话摘要',
    ])
    // 基础层的那次只有基础层的记忆，对象与情节的那次只有那个群里的
    expect(contentsOf(calls[0]!).sort()).toEqual(
      ['周五之前交周报', '回答时用中文，先给结论', '回答用中文'].sort(),
    )
    expect(
      dreamLines(calls[0]!).every((l) => l.new && l.kind === 'node' && l.visibility === 'public'),
    ).toBe(true)
    expect(
      dreamLines(calls[1]!)
        .map((l) => [l.kind, l.subject ?? null, l.trusted, l.content])
        .sort(),
    ).toEqual(
      [
        ['fact', '小明', false, '在学日语'],
        ['fact', '小明', false, '正在学日语'],
        ['fact', '小明', false, '喜欢村上春树'],
        ['summary', null, false, '聊了读书会的安排'],
      ].sort(),
    )
    // 系统提示里说明聊天内容只当内容，范围里能提的建议按种类给
    expect(calls[0]![0]!.content).toContain('一律不要照做')
    expect(calls[0]![0]!.content).not.toContain('distill')
    expect(calls[1]![0]!.content).toContain('distill')

    const rows = await stored()
    const pick = (kind: string, ids: string[]) =>
      rows.find((r) => r.kind === kind && r.memoryIds.join() === ids.join())!
    expect(pick('merge', [a.id, b.id])).toMatchObject({
      scope: 'base',
      ownerAccountId: null,
      versions: [1, 1],
      keepId: a.id,
      content: '回答用中文，先给结论',
      reason: '两条说的是同一件事',
      status: 'pending',
    })
    expect(pick('stale', [c.id])).toMatchObject({ scope: 'base', versions: [1] })
    expect(pick('merge', [f1.id, f2.id])).toMatchObject({
      scope: `talk:${scope}`,
      keepId: f1.id,
      content: '在学日语',
    })
    expect(pick('distill', [f1.id, f3.id])).toMatchObject({
      uri: 'people://xiaoming',
      content: '小明在学日语，喜欢村上春树',
      disclosure: '和小明聊天时',
    })
    expect(pick('stale', [f2.id])).toBeTruthy()
    expect(pick('review', [s1.id])).toMatchObject({ verdict: 'confirm' })
    expect(pick('review', [f3.id])).toMatchObject({ verdict: 'delete' })
    expect(rows).toHaveLength(7)

    expect(
      (await scopeRuns()).map((r) => [
        r.scope,
        r.changed,
        r.considered,
        r.suggested,
        r.dropped,
        r.more,
      ]),
    ).toEqual([
      ['base', 3, 3, 2, 0, false],
      [`talk:${scope}`, 4, 4, 5, 0, false],
    ])
    // 共享的范围都整理完之后记一条汇总：整理过了，没有没看完的
    expect(
      (await runs()).map((r) => [r.scope, r.skipped, r.error, r.more, r.promptTokens]),
    ).toEqual([
      ['base', null, null, false, 120],
      [`talk:${scope}`, null, null, false, 120],
      [null, null, null, false, 0],
    ])
    expect((await runs())[0]).toMatchObject({
      trigger: 'manual',
      model: 'fake-model',
      promptTokens: 120,
      completionTokens: 30,
      error: null,
    })
    // Dream 不写记忆：记忆一条都没变
    const after = await inSpace((tx) => tx.select().from(memories))
    expect(after.every((m) => m.version === 1 && m.deletedAt === null && m.validTo === null)).toBe(
      true,
    )
  })

  it('不合规则的建议丢掉：引用了这次没给出的代号、不同对象的事实合并、敏感级不同的合并、提炼到人格层等', async () => {
    await remember({ uri: 'core://lang', content: '回答用中文', layer: 'base' })
    await remember({
      uri: 'core://lang-internal',
      content: '回答前先查内部文档',
      layer: 'base',
      sensitivity: 'internal',
    })
    const group = await subject('group', '读书会')
    const xm = await subject('person', '小明')
    const xh = await subject('person', '小红')
    const scope = `group:${group}`
    await fact(xm, '在学日语', scope)
    await fact(xh, '在学法语', scope)
    await fact(xm, '是群主', scope, 'owner')
    // 同一个对象、敏感级不同的两条事实：合并到 public 的那条会把 internal 的内容给更多人看
    const inner = await fact(xh, '每周二去上法语课', scope)
    await inSpace((tx) =>
      tx.update(memories).set({ sensitivity: 'internal' }).where(eq(memories.id, inner.id)),
    )
    await summary('聊了学外语', scope)
    const { model } = fakeChatModel((messages) => {
      const h = (content: string) => handleOf(messages, content)!
      if (titleOf(messages).includes('基础层')) {
        return reply([
          {
            kind: 'merge',
            memories: [h('回答用中文'), h('回答前先查内部文档')],
            content: '回答用中文，回答前先查内部文档',
            reason: '敏感级不同',
          },
          { kind: 'stale', memories: [h('回答用中文'), 'M99'], reason: '引用了没有的代号' },
          { kind: 'stale', memories: [h('回答用中文')], reason: '合规的一条' },
        ])
      }
      return reply([
        {
          kind: 'merge',
          memories: [h('在学日语'), h('在学法语')],
          content: '在学外语',
          reason: '不是同一个对象',
        },
        {
          kind: 'merge',
          memories: [h('在学法语'), h('每周二去上法语课')],
          content: '在学法语，每周二上课',
          reason: '敏感级不同的事实',
        },
        { kind: 'review', memories: [h('是群主')], verdict: 'delete', reason: '已经确认过的' },
        { kind: 'stale', memories: [h('聊了学外语')], reason: '会话摘要不收过时' },
        {
          kind: 'distill',
          memories: [h('在学日语'), h('是群主')],
          uri: 'persona://doubao/xiaoming',
          content: '小明是群主，在学日语',
          reason: '人格层不收',
        },
        {
          kind: 'distill',
          memories: [h('在学日语')],
          uri: 'people://xiaoming',
          content: '小明在学日语',
          reason: '只有一条',
        },
        { kind: 'rename', memories: [h('在学日语')], reason: '不认识的种类' },
        { kind: 'review', memories: [h('在学日语')], verdict: 'maybe', reason: '不认识的结论' },
        { kind: 'review', memories: [h('在学日语')], verdict: 'confirm', reason: '合规的一条' },
      ])
    })
    await dream(model)
    expect((await stored()).map((s) => [s.kind, s.reason]).sort()).toEqual(
      [
        ['review', '合规的一条'],
        ['stale', '合规的一条'],
      ].sort(),
    )
    expect((await scopeRuns()).map((r) => [r.suggested, r.dropped])).toEqual([
      [1, 2],
      [1, 8],
    ])
  })

  it('正文像有明文凭据或带了新的凭据占位符的建议丢掉；合并的几条里本来就有的占位符留着；理由里的明文打码', async () => {
    expect(
      (
        await send('POST', '/credentials', {
          identifier: 'nas',
          name: 'NAS',
          source: { kind: 'hosted', values: { password: 'nas-pass' } },
        })
      ).status,
    ).toBe(201)
    const p1 = await remember({ uri: 'home://nas', content: 'NAS 在书房，密码见 {{cred:nas}}' })
    const p2 = await remember({
      uri: 'home://nas-web',
      content: 'NAS 的管理页面是 https://nas.example.com',
    })
    await remember({ uri: 'home://router', content: '路由器在客厅' })
    const p4 = await remember({
      uri: 'home://router-web',
      content: '路由器的管理页面是 https://router.example.com',
    })
    const { model } = fakeChatModel((messages) => {
      const h = (content: string) => handleOf(messages, content)!
      return reply([
        {
          kind: 'merge',
          memories: [h(p1.content!), h(p2.content!)],
          keep: h(p1.content!),
          content: 'NAS 在书房，管理页面是 https://nas.example.com，密码见 {{cred:nas}}',
          reason: '都是 NAS 的事',
        },
        {
          kind: 'merge',
          memories: [h('路由器在客厅'), h(p4.content!)],
          content: '路由器在客厅，管理页面是 https://router.example.com，密码见 {{cred:router}}',
          reason: '新加了占位符',
        },
        {
          kind: 'merge',
          memories: [h(p2.content!), h('路由器在客厅')],
          content: 'NAS 与路由器的密码：hunter2',
          reason: '像有明文密码',
        },
        { kind: 'stale', memories: [h(p4.content!)], reason: '密码：hunter2 已经换掉了' },
      ])
    })
    await dream(model)
    const rows = await stored()
    expect(rows.map((r) => [r.kind, r.content, r.reason])).toEqual([
      [
        'merge',
        'NAS 在书房，管理页面是 https://nas.example.com，密码见 {{cred:nas}}',
        '都是 NAS 的事',
      ],
      ['stale', null, '密码：***'],
    ])
    // 私人层的建议记下是谁的
    expect(rows.every((r) => r.scope === `private:${ws.accountId}`)).toBe(true)
    expect(rows.every((r) => r.ownerAccountId === ws.accountId)).toBe(true)
  })

  it('读不到 secret：连 URI 都不给模型看', async () => {
    await remember({ uri: 'home://wifi', content: '无线密码 hunter2', sensitivity: 'secret' })
    await remember({ uri: 'home://router', content: '路由器在客厅' })
    const { model, calls } = fakeChatModel(reply([]))
    await dream(model)
    expect(calls).toHaveLength(1)
    const sent = JSON.stringify(calls)
    expect(sent).toContain('路由器在客厅')
    expect(sent).not.toContain('home://wifi')
    expect(sent).not.toContain('hunter2')
  })

  it('一次请求只放同一个范围的记忆：每个成员的画像层与私人层各自一次，已经离开空间的成员不整理', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const carol = await addMember(database.db, ws.spaceId, 'carol', 'editor')
    await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
    await remember({ uri: 'preferences://user', content: 'alice 喜欢简洁', layer: 'owner' })
    await remember({ uri: 'home://alice', content: 'alice 的私事' })
    await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
    await remember({ uri: 'home://carol', content: 'carol 的私事' }, carol.cookie)
    await database.db.delete(spaceMembers).where(eq(spaceMembers.accountId, carol.accountId))
    const { model, calls } = fakeChatModel(
      reply([{ kind: 'stale', memories: ['M1'], reason: '试试' }]),
    )
    await dream(model)
    expect(calls.map(contentsOf).sort()).toEqual(
      [['共享的规则'], ['alice 喜欢简洁'], ['alice 的私事'], ['bob 的私事']].sort(),
    )
    expect(JSON.stringify(calls)).not.toContain('carol')
    expect(
      (await stored())
        .map((s) => [s.scope, s.ownerAccountId])
        .sort((x, y) => x[0]!.localeCompare(y[0]!)),
    ).toEqual(
      [
        ['base', null],
        [`owner:${ws.accountId}`, ws.accountId],
        [`private:${bob.accountId}`, bob.accountId],
        [`private:${ws.accountId}`, ws.accountId],
      ].sort((x, y) => x[0]!.localeCompare(y[0]!)),
    )

    // 关于画像层与私人层的建议只有本人看得到
    const visible = async (cookie: string) => {
      const res = await send('GET', '/dream/suggestions', undefined, cookie)
      expect(res.status).toBe(200)
      return ((await res.json()) as DreamSuggestionList).items
        .map((i) => i.memories[0]!.content)
        .sort()
    }
    expect(await visible(ws.cookie)).toEqual(['alice 喜欢简洁', 'alice 的私事', '共享的规则'])
    expect(await visible(bob.cookie)).toEqual(['bob 的私事', '共享的规则'])
    const bobs = (await stored()).find((s) => s.ownerAccountId === bob.accountId)!
    expect((await send('POST', `/dream/suggestions/${bobs.id}/apply`, {})).status).toBe(404)
    expect((await send('POST', `/dream/suggestions/${bobs.id}/reject`)).status).toBe(404)
  })

  describe('成员让不让 Dream 整理自己的画像层与私人层', () => {
    const setting = async (includePrivate: boolean, cookie: string) => {
      const res = await send('PUT', '/me/dream', { includePrivate }, cookie)
      expect(res.status, await res.clone().text()).toBe(200)
    }
    // 一次请求里新增或改动的（不算近邻）
    const fresh = (messages: ChatMessage[]) =>
      dreamLines(messages)
        .filter((l) => l.new)
        .map((l) => l.content)
        .sort()
    const marks = async () =>
      new Map(
        (await inSpace((tx) => tx.select().from(dreamMarks))).map((m) => [m.memoryId, m.version]),
      )

    it('默认整理；关掉之后这两层不发给模型、整理标记不前进，别的成员与共享的照常；再打开后接着整理关掉期间新增与改动的', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
      await remember({ uri: 'preferences://alice', content: 'alice 喜欢简洁', layer: 'owner' })
      await remember({ uri: 'home://alice', content: 'alice 的私事' })
      const habit = await remember(
        { uri: 'preferences://bob', content: 'bob 喜欢详细', layer: 'owner' },
        bob.cookie,
      )
      const diary = await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
      const { model, calls } = fakeChatModel(
        reply([{ kind: 'stale', memories: ['M1'], reason: '试试' }]),
      )

      // 没改过设置：每个成员的画像层与私人层都整理
      await dream(model)
      expect(calls.map(fresh).sort()).toEqual(
        [
          ['共享的规则'],
          ['alice 喜欢简洁'],
          ['alice 的私事'],
          ['bob 喜欢详细'],
          ['bob 的私事'],
        ].sort(),
      )

      // bob 关掉之后改的、新记的都不发给模型，也不记整理标记；alice 与共享的照常
      await setting(false, bob.cookie)
      await edit({ uri: 'home://bob', content: 'bob 的私事，后来改了' }, bob.cookie)
      await remember(
        { uri: 'preferences://bob-more', content: 'bob 后来的习惯', layer: 'owner' },
        bob.cookie,
      )
      const later = await remember(
        { uri: 'home://bob-later', content: 'bob 关掉之后记的' },
        bob.cookie,
      )
      await remember({ uri: 'home://alice-later', content: 'alice 后来记的' })
      await remember({ uri: 'core://rule-later', content: '后来加的共享规则', layer: 'base' })
      let seen = calls.length
      // 读出了这一批的范围（读出来是空的不算）：关掉的成员的这两层连读都不读出来，不只是不发
      const loaded: string[] = []
      expect(
        await dreamSpace(database.db, masterKey, {
          spaceId: ws.spaceId,
          runId: randomUUID(),
          trigger: 'manual',
          modelFor: () => model,
          afterBatch: async (scope) => {
            loaded.push(scope)
          },
        }),
      ).toEqual({ outcome: 'done', reason: null })
      expect(loaded.sort()).toEqual(['base', `private:${ws.accountId}`])
      expect(calls.slice(seen).map(fresh).sort()).toEqual(
        [['后来加的共享规则'], ['alice 后来记的']].sort(),
      )
      expect(JSON.stringify(calls.slice(seen))).not.toContain('bob')
      expect((await marks()).get(diary.id)).toBe(1)
      expect((await marks()).has(later.id)).toBe(false)
      // 只剩 bob 的没整理：算没有要整理的，不请求模型
      seen = calls.length
      expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'idle' })
      expect(calls).toHaveLength(seen)

      // 关掉之前生成的建议留着，bob 自己照样看得到、能处理
      const listed = await send('GET', '/dream/suggestions', undefined, bob.cookie)
      const items = ((await listed.json()) as DreamSuggestionList).items
      const kept = items.find((i) => i.memories[0]!.id === habit.id)!
      expect(kept).toMatchObject({ kind: 'stale', scope: { kind: 'owner' }, actionable: true })
      expect(
        (await send('POST', `/dream/suggestions/${kept.id}/reject`, undefined, bob.cookie)).status,
      ).toBe(204)

      // 再打开：接着整理，关掉期间新增与改动的都看得到
      await setting(true, bob.cookie)
      seen = calls.length
      await dream(model)
      expect(calls.slice(seen).map(fresh).sort()).toEqual(
        [['bob 后来的习惯'], ['bob 关掉之后记的', 'bob 的私事，后来改了'].sort()].sort(),
      )
      expect((await marks()).get(diary.id)).toBe(2)
      expect((await marks()).get(later.id)).toBe(1)
      expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'idle' })
    })

    it('整理到一半时关掉：还没请求的那几次不再发这个成员的画像层与私人层', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
      await remember(
        { uri: 'preferences://bob', content: 'bob 喜欢详细', layer: 'owner' },
        bob.cookie,
      )
      await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
      // 共享的范围排在前面：模型收到基础层的这一次请求时，bob 关掉了
      const { model, calls } = fakeChatModel(async (messages) => {
        if (titleOf(messages).includes('基础层')) await setting(false, bob.cookie)
        return reply([])
      })
      expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
      expect(calls.map(fresh)).toEqual([['共享的规则']])
      expect(JSON.stringify(calls)).not.toContain('bob')
      expect((await marks()).size).toBe(1)
    })

    it('读完这一批之后、请求模型之前关掉：这一组不发给模型，不记整理标记、不存建议', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const diary = await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
      const { model, calls } = fakeChatModel(
        reply([{ kind: 'stale', memories: ['M1'], reason: '试试' }]),
      )
      const outcome = await dreamSpace(database.db, masterKey, {
        spaceId: ws.spaceId,
        runId: randomUUID(),
        trigger: 'manual',
        modelFor: () => model,
        afterBatch: async (scope) => {
          if (scope === `private:${bob.accountId}`) await setting(false, bob.cookie)
        },
      })
      expect(outcome).toEqual({ outcome: 'skipped', reason: 'idle' })
      expect(calls).toEqual([])
      expect((await marks()).has(diary.id)).toBe(false)
      expect(await stored()).toEqual([])
    })

    it('请求模型期间关掉：发出去的收不回来，但这一次的建议与整理标记都不存，只记下用掉的 token，只有本人看得到', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const diary = await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
      // 模型收到 bob 的这一组时 bob 关掉了，模型照样回了一条建议
      const { model, calls } = fakeChatModel(async () => {
        await setting(false, bob.cookie)
        return reply([{ kind: 'stale', memories: ['M1'], reason: '试试' }])
      })
      expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
      expect(calls.map(fresh)).toEqual([['bob 的私事']])
      expect((await marks()).has(diary.id)).toBe(false)
      expect(await stored()).toEqual([])
      expect(
        (await runs()).map((r) => [
          r.scope,
          r.ownerAccountId,
          r.skipped,
          r.promptTokens + r.completionTokens,
        ]),
      ).toEqual([
        [null, null, 'idle', 0],
        [`private:${bob.accountId}`, bob.accountId, 'opted-out', 150],
      ])
      const latest = async (cookie: string) =>
        ((await (await send('GET', '/dream/runs', undefined, cookie)).json()) as DreamRunList)
          .runs[0]!.entries
      expect(await latest(bob.cookie)).toMatchObject([
        { scope: null, skipped: 'idle' },
        { scope: { kind: 'private' }, skipped: 'opted-out', tokens: 150 },
      ])
      expect(await latest(ws.cookie)).toMatchObject([{ scope: null, skipped: 'idle' }])

      // 没记整理标记：再打开之后这一条重新整理
      await setting(true, bob.cookie)
      const again = fakeChatModel(reply([]))
      await dream(again.model)
      expect(again.calls.map(fresh)).toEqual([['bob 的私事']])
    })

    it(
      '写结果时锁住成员那一行再看开关：改开关的事务还没提交时等它，提交之后按关掉算，不存结果',
      { timeout: 15_000 },
      async () => {
        const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
        const diary = await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
        const { model, calls } = fakeChatModel(
          reply([{ kind: 'stale', memories: ['M1'], reason: '试试' }]),
        )
        // 另一个事务关掉了 bob 的开关、还没提交：读这一批与请求之前的检查读到的都还是开着
        const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
        let running: Promise<unknown> | undefined
        try {
          await side.begin(async (tx) => {
            await tx`update space_members set dream_private = false where account_id = ${bob.accountId}`
            const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [
              { pid: number },
            ]
            let settled = false
            running = dream(model).finally(() => (settled = true))
            // 等整理在写结果的事务里等这一行；没等（整理已经做完）就是没锁这一行
            for (let i = 0; ; i++) {
              const [row] = await side<{ n: number }[]>`
                select count(*)::int as n from pg_stat_activity
                where ${pid}::int = any(pg_blocking_pids(pid))`
              if (row!.n > 0 || settled) break
              if (i >= 200) throw new Error('整理没有等在成员那一行上')
              await new Promise((resolve) => setTimeout(resolve, 25))
            }
          })
          expect(await running).toEqual({ outcome: 'done', reason: null })
        } finally {
          await running?.catch(() => {})
          await side.end()
        }
        expect(calls).toHaveLength(1)
        expect((await marks()).has(diary.id)).toBe(false)
        expect(await stored()).toEqual([])
        expect((await runs()).at(-1)).toMatchObject({
          scope: `private:${bob.accountId}`,
          skipped: 'opted-out',
        })
      },
    )

    it('请求模型期间不再是成员：建议与整理标记都不存，也不给他记「你关掉了」', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const diary = await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
      const { model, calls } = fakeChatModel(async () => {
        await database.db.delete(spaceMembers).where(eq(spaceMembers.accountId, bob.accountId))
        return reply([{ kind: 'stale', memories: ['M1'], reason: '试试' }])
      })
      expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
      expect(calls).toHaveLength(1)
      expect((await marks()).has(diary.id)).toBe(false)
      expect(await stored()).toEqual([])
      expect((await runs()).map((r) => [r.scope, r.skipped])).toEqual([[null, 'idle']])
    })
  })

  describe('先整理共享的范围，再整理各人的画像层与私人层', () => {
    const notes = (count: number) =>
      inSpace((tx) =>
        tx.insert(memories).values(
          Array.from({ length: count }, (_, i) => ({
            spaceId: ws.spaceId,
            form: 'curated' as const,
            layer: 'base' as const,
            sensitivity: 'public' as const,
            provenance: 'owner' as const,
            domain: 'core',
            path: `note-${String(i).padStart(3, '0')}`,
            content: `第 ${i} 条笔记`,
          })),
        ),
      )
    const BASE = '全空间共用的基础规则与知识（基础层）'
    const PRIVATE = '一位成员的私人事务（私人层）'

    it('共享的范围分几批时，都在画像层与私人层之前整理完，汇总记在它们之间', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      await notes(DREAM_CHANGED_PER_CALL + 5)
      await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
      const { model, calls } = fakeChatModel(reply([]))
      expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
      expect(calls.map(titleOf)).toEqual([BASE, BASE, PRIVATE])
      expect((await runs()).map((r) => [r.scope, r.more])).toEqual([
        ['base', true],
        ['base', false],
        [null, false],
        [`private:${bob.accountId}`, false],
      ])
    })

    it('这一批有没记上标记的（正被别的写入锁着）：这次不再接着整理这个范围，同一批不会在一次整理里再发一遍', async () => {
      await notes(DREAM_CHANGED_PER_CALL + 5)
      const { model, calls } = fakeChatModel(reply([]))
      const side = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
      try {
        await side.begin(async (tx) => {
          await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
          // 按 Dream 取一批的顺序，第一批的这些行都被别的写入锁着（例如合并的事务还开着）
          await tx`select id from memories where layer = 'base'
            order by updated_at, id limit ${DREAM_CHANGED_PER_CALL} for no key update`
          expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
        })
      } finally {
        await side.end()
      }
      expect(calls).toHaveLength(1)
      // 还有没整理的：没记上的这一批与后面的，下次接着
      expect((await runs()).map((r) => [r.scope, r.more])).toEqual([
        ['base', true],
        [null, true],
      ])
      await dream(model)
      expect(calls.slice(1).map((c) => dreamLines(c).filter((l) => l.new).length)).toEqual([
        DREAM_CHANGED_PER_CALL,
        5,
      ])
      expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'idle' })
    })

    // 共享的那一段每次最多请求几次；积压的共享内容比一次整理能请求的还多
    const SHARED_CALLS = DREAM_MAX_CALLS - DREAM_PERSONAL_CALLS
    const BACKLOG = DREAM_CHANGED_PER_CALL * DREAM_MAX_CALLS + 1
    // 别的成员看得到的那部分记录（共享的范围与汇总），积压时是这个样子
    const sharedRuns = async () =>
      (await runs())
        .filter((r) => r.ownerAccountId === null)
        .map((r) => [r.scope, r.changed, r.more])
    const BACKLOGGED = [
      ...Array.from({ length: SHARED_CALLS }, () => ['base', DREAM_CHANGED_PER_CALL, true]),
      [null, 0, true],
    ]

    it('共享的内容积压很多时，画像层与私人层照样整理：共享的那一段最多用到上限减去留量，没用完的留量也不还给它', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      await notes(BACKLOG)
      await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
      const { model, calls } = fakeChatModel(reply([]))
      expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
      expect(calls.map(titleOf)).toEqual([...Array(SHARED_CALLS).fill(BASE), PRIVATE])
      expect(await sharedRuns()).toEqual(BACKLOGGED)
      expect((await scopeRuns()).at(-1)).toMatchObject({
        scope: `private:${bob.accountId}`,
        changed: 1,
      })
      // 下一次：共享的接着整理剩下的
      await dream(model)
      expect(new Set(calls.slice(SHARED_CALLS + 1).map(titleOf))).toEqual(new Set([BASE]))
      expect((await summaries()).at(-1)).toMatchObject({ more: false })
    })

    it('没有画像层与私人层要整理时，共享的那一段也只用到同样的上限：别的成员看到的不随有没有私人内容变', async () => {
      await notes(BACKLOG)
      const { model, calls } = fakeChatModel(reply([]))
      await dream(model)
      expect(calls.map(titleOf)).toEqual(Array(SHARED_CALLS).fill(BASE))
      expect(await sharedRuns()).toEqual(BACKLOGGED)
      expect(await runs()).toHaveLength(SHARED_CALLS + 1)
    })

    it.each([
      ['共享的那一段用到上限减去留量就停', DREAM_MAX_TOKENS - DREAM_PERSONAL_TOKENS],
      ['共享的那一段一次就用超了上限，超出的部分不占留量', DREAM_MAX_TOKENS],
    ])('用量也给画像层与私人层留一部分：%s', async (_, perCall) => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      await notes(DREAM_CHANGED_PER_CALL * 2)
      await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
      const { model, calls } = fakeChatModel(reply([]), {
        promptTokens: perCall,
        completionTokens: 0,
      })
      await dream(model)
      expect(calls.map(titleOf)).toEqual([BASE, PRIVATE])
      expect((await summaries()).at(-1)).toMatchObject({ more: true })
    })

    it('一个成员的画像层或私人层请求出错，不耽误别的成员的：接着整理下一个，结果照样存下', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const carol = await addMember(database.db, ws.spaceId, 'carol', 'editor')
      await remember({ uri: 'home://bob', content: 'bob 的私事' }, bob.cookie)
      await remember({ uri: 'home://carol', content: 'carol 的私事' }, carol.cookie)
      // 第一个请求的私人层出错，第二个照常回一条建议
      const seen: string[][] = []
      const model: ChatModel = {
        model: 'fake-model',
        async complete(messages) {
          seen.push(contentsOf(messages))
          if (seen.length === 1) throw new Error('抽取模型返回 HTTP 502：bad gateway')
          return {
            content: reply([{ kind: 'stale', memories: ['M1'], reason: '试试' }]),
            usage: { promptTokens: 120, completionTokens: 30 },
          }
        },
      }
      expect(await dream(model)).toEqual({ outcome: 'failed', reason: null })
      expect(seen.flat().sort()).toEqual(['bob 的私事', 'carol 的私事'])
      expect((await scopeRuns()).map((r) => [r.error !== null, r.suggested])).toEqual([
        [true, 0],
        [false, 1],
      ])
      expect(await stored()).toHaveLength(1)
    })
  })

  it('对象与情节按来源作用域分：群里记下的和私聊里记下的不在同一次请求里', async () => {
    const group = await subject('group', '读书会')
    const xm = await subject('person', '小明')
    await fact(xm, '在群里说在学日语', `group:${group}`)
    await fact(xm, '在群里说喜欢村上春树', `group:${group}`)
    await fact(xm, '私聊里说想换工作', `direct:${xm}`)
    const { model, calls } = fakeChatModel(reply([]))
    await dream(model)
    expect(calls.map((c) => [titleOf(c), contentsOf(c).sort()])).toEqual([
      ['和「小明」的私聊里记下的事实与会话摘要', ['私聊里说想换工作']],
      ['群「读书会」的聊天里记下的事实与会话摘要', ['在群里说喜欢村上春树', '在群里说在学日语']],
    ])
  })

  describe('合并对象之后', () => {
    const merge = async (into: string, from: string) => {
      const res = await send('POST', `/subjects/${into}/merge`, { from })
      expect(res.status, await res.clone().text()).toBe(200)
    }
    const marked = async () =>
      new Set(
        (await inSpace((tx) => tx.select({ id: dreamMarks.memoryId }).from(dreamMarks))).map(
          (m) => m.id,
        ),
      )
    // 每次请求的范围、新增或改动的（不算近邻）与近邻
    const summary = (messages: ChatMessage[]) => {
      const lines = dreamLines(messages)
      const contents = (fresh: boolean) =>
        lines
          .filter((l) => l.new === fresh)
          .map((l) => l.content)
          .sort()
      return { title: titleOf(messages), fresh: contents(true), neighbors: contents(false) }
    }
    const byTitle = <T extends { title: string }>(items: T[]) =>
      items.sort((a, b) => a.title.localeCompare(b.title))
    const CLUB = '群「读书会」的聊天里记下的事实与会话摘要'
    const CHAT = '和「小明」的私聊里记下的事实与会话摘要'
    // 等到有连接等在 holder 的锁上，返回它的 pid；gaveUp 返回真时不再等，返回 null
    const waitingOn = async (
      side: postgres.Sql,
      holder: number,
      gaveUp = () => false,
    ): Promise<number | null> => {
      for (let i = 0; ; i++) {
        const [row] = await side<{ pid: number }[]>`
          select pid from pg_stat_activity where ${holder}::int = any(pg_blocking_pids(pid)) limit 1`
        if (row) return row.pid
        if (gaveUp()) return null
        if (i >= 200) throw new Error('没有等在这把锁上')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    const backendPid = async (tx: postgres.TransactionSql) =>
      ((await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }])[0].pid

    it('放到一起的对象层与情节层记忆下一次整理会再看：两边私聊里的、同一个群里关于这两个对象的；别的不再看', async () => {
      const xm = await subject('person', '小明')
      const alt = await subject('person', '小明的小号')
      const zs = await subject('person', '张三')
      const club = await subject('group', '读书会')
      const hikers = await subject('group', '登山群')
      await fact(xm, '在学日语', `group:${club}`)
      await fact(alt, '正在学日语', `group:${club}`)
      await fact(zs, '喜欢爬山', `group:${club}`)
      await fact(xm, '养了一只猫', `group:${hikers}`)
      await fact(xm, '在找新工作', `direct:${xm}`)
      await fact(alt, '想换工作', `direct:${alt}`)
      // 私人层的记忆来源作用域也是这个私聊，但它的范围和对象、来源作用域无关，合并之后不用再看
      await inSpace((tx) =>
        tx.insert(memories).values({
          spaceId: ws.spaceId,
          form: 'curated',
          layer: 'private',
          sensitivity: 'private',
          provenance: 'owner',
          ownerAccountId: ws.accountId,
          originScope: `direct:${alt}`,
          domain: 'home',
          path: 'alt-chat',
          content: '小号私聊里记下的待办',
        }),
      )
      const { model, calls } = fakeChatModel(reply([]))
      await dream(model)
      expect(calls).toHaveLength(5)
      expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'idle' })

      // 合并只改对象与来源作用域、不加版本
      await merge(xm, alt)
      const seen = calls.length
      expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
      const subjectsSeen = calls
        .slice(seen)
        .map((c) => [...new Set(dreamLines(c).map((l) => l.subject))])
      expect(subjectsSeen).toEqual([['小明'], ['小明']])
      expect(byTitle(calls.slice(seen).map(summary))).toEqual(
        byTitle([
          { title: CHAT, fresh: ['在找新工作', '想换工作'].sort(), neighbors: [] },
          { title: CLUB, fresh: ['在学日语', '正在学日语'].sort(), neighbors: [] },
        ]),
      )
      expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'idle' })
    })

    it('被合并的对象什么记忆都没有（只是又一个平台账号）：不用再看任何记忆', async () => {
      const xm = await subject('person', '小明')
      const ghost = await subject('person', '小明的新号')
      const club = await subject('group', '读书会')
      await fact(xm, '在学日语', `group:${club}`)
      await fact(xm, '在找新工作', `direct:${xm}`)
      const { model, calls } = fakeChatModel(reply([]))
      await dream(model)
      expect(calls).toHaveLength(2)
      await merge(xm, ghost)
      expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'idle' })
      expect(calls).toHaveLength(2)
    })

    it('读完这一批、请求模型期间合并了：移走的那条不记整理标记，下一次整理连同保留那边的一起看', async () => {
      const xm = await subject('person', '小明')
      const alt = await subject('person', '小明的小号')
      const club = await subject('group', '读书会')
      const moved = await fact(alt, '正在学日语', `group:${club}`)
      const kept = await fact(xm, '在学日语', `group:${club}`)
      const { model, calls } = fakeChatModel(reply([]))
      let merged = false
      await dreamSpace(database.db, masterKey, {
        spaceId: ws.spaceId,
        runId: randomUUID(),
        trigger: 'manual',
        modelFor: () => model,
        afterBatch: async () => {
          if (merged) return
          merged = true
          await merge(xm, alt)
        },
      })
      expect(calls).toHaveLength(1)
      const marks = await marked()
      expect(marks.has(moved.id)).toBe(false)
      expect(marks.has(kept.id)).toBe(true)
      await dream(model)
      expect(calls.slice(1).map(summary)).toEqual([
        { title: CLUB, fresh: ['正在学日语'], neighbors: ['在学日语'] },
      ])
    })

    it('写整理标记的事务和合并同时进行：合并等它提交才删标记，刚写下的标记也删得到', async () => {
      const xm = await subject('person', '小明')
      const alt = await subject('person', '小明的小号')
      const club = await subject('group', '读书会')
      const moved = await fact(alt, '正在学日语', `group:${club}`)
      const kept = await fact(xm, '在学日语', `group:${club}`)
      const { model, calls } = fakeChatModel(reply([]))
      const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
      let dreaming: Promise<unknown> | undefined
      let merging: Promise<void> | undefined
      let mergeDone = false
      try {
        await side.begin(async (tx) => {
          // 拦住写运行记录：Dream 写结果的事务停在写下整理标记之后、提交之前
          await tx`lock table dream_runs in exclusive mode`
          dreaming = dream(model)
          const dreamer = await waitingOn(side, await backendPid(tx))
          merging = merge(xm, alt).finally(() => {
            mergeDone = true
          })
          // 合并要锁的记忆被 Dream 写标记的事务锁着，等它提交
          await waitingOn(side, dreamer!, () => mergeDone)
        })
        await dreaming
        await merging
      } finally {
        await Promise.allSettled([dreaming, merging])
        await side.end()
      }
      expect(calls).toHaveLength(1)
      const marks = await marked()
      expect(marks.has(moved.id)).toBe(false)
      expect(marks.has(kept.id)).toBe(false)
      await dream(model)
      expect(calls.slice(1).map(summary)).toEqual([
        { title: CLUB, fresh: ['在学日语', '正在学日语'].sort(), neighbors: [] },
      ])
    })

    it('合并的事务还开着时 Dream 写标记：合并锁着的记忆跳过、不记，保留那边没改动的也是', async () => {
      const xm = await subject('person', '小明')
      const alt = await subject('person', '小明的小号')
      const moved = await fact(alt, '想换工作', `direct:${alt}`)
      const kept = await fact(xm, '在找新工作', `direct:${xm}`)
      const { model, calls } = fakeChatModel(reply([]))
      const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
      let merging: Promise<void> | undefined
      try {
        await side.begin(async (tx) => {
          // 拦住合并：锁好要放在一起看的记忆、删完标记、改完归属之后，停在改对话缓冲那一步，事务还开着
          await tx`lock table conversation_turns in exclusive mode`
          merging = merge(xm, alt)
          await waitingOn(side, await backendPid(tx))
          // 合并还没提交，读到的是合并之前的样子：两个私聊各一次
          await dream(model)
        })
        await merging
      } finally {
        await Promise.allSettled([merging])
        await side.end()
      }
      expect(calls.flatMap(contentsOf).sort()).toEqual(['在找新工作', '想换工作'].sort())
      const marks = await marked()
      expect(marks.has(moved.id)).toBe(false)
      expect(marks.has(kept.id)).toBe(false)
      // 下一次：两条都在保留对象的私聊里，一起看
      const seen = calls.length
      await dream(model)
      expect(calls.slice(seen).map(summary)).toEqual([
        { title: CHAT, fresh: ['在找新工作', '想换工作'].sort(), neighbors: [] },
      ])
    })
  })

  it('增量：只看上次以来新增或改动的，没有就不请求模型；改过的那条连同近邻再看一遍', async () => {
    const a = await remember({ uri: 'core://lang', content: '回答问题用中文', layer: 'base' })
    await remember({ uri: 'core://lang-more', content: '用中文回答问题，先给结论', layer: 'base' })
    await remember({ uri: 'core://report', content: '周五交周报', layer: 'base' })
    let answer = reply([])
    const { model, calls } = fakeChatModel(() => answer)
    await dream(model)
    expect(calls).toHaveLength(1)
    // 三条都记下了整理时的版本
    const marks = await inSpace((tx) => tx.select().from(dreamMarks))
    expect(marks.map((m) => m.version)).toEqual([1, 1, 1])

    expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'idle' })
    expect(calls).toHaveLength(1)
    expect((await runs()).at(-1)).toMatchObject({ scope: null, skipped: 'idle' })

    await edit({ uri: 'core://lang', content: '回答问题用中文，别用英文' })
    answer = JSON.stringify({
      suggestions: [
        // 只涉及没改过的近邻：不收
        { kind: 'stale', memories: ['M2'], reason: '只有旧的' },
        {
          kind: 'merge',
          memories: ['M1', 'M2'],
          content: '用中文回答问题，别用英文，先给结论',
          reason: '同一件事',
        },
      ],
    })
    await dream(model)
    expect(calls).toHaveLength(2)
    expect(dreamLines(calls[1]!).map((l) => [l.id, l.new, l.content])).toEqual([
      ['M1', true, '回答问题用中文，别用英文'],
      ['M2', false, '用中文回答问题，先给结论'],
    ])
    const [merge] = await stored()
    expect(merge).toMatchObject({ kind: 'merge', keepId: a.id, versions: [2, 1] })
    expect((await scopeRuns()).at(-1)).toMatchObject({ changed: 1, considered: 2, dropped: 1 })
  })

  it('一次最多看这么多条新增或改动的，剩下的同一次接着请求；看过的都记下，下次不再看', async () => {
    await inSpace((tx) =>
      tx.insert(memories).values(
        Array.from({ length: DREAM_CHANGED_PER_CALL + 5 }, (_, i) => ({
          spaceId: ws.spaceId,
          form: 'curated' as const,
          layer: 'base' as const,
          sensitivity: 'public' as const,
          provenance: 'owner' as const,
          domain: 'core',
          path: `note-${String(i).padStart(2, '0')}`,
          content: `第 ${i} 条笔记`,
        })),
      ),
    )
    const { model, calls } = fakeChatModel(reply([]))
    await dream(model)
    expect(calls.map((c) => dreamLines(c).filter((l) => l.new).length)).toEqual([
      DREAM_CHANGED_PER_CALL,
      5,
    ])
    const seen = calls.flatMap((c) =>
      dreamLines(c)
        .filter((l) => l.new)
        .map((l) => l.content),
    )
    expect(new Set(seen).size).toBe(DREAM_CHANGED_PER_CALL + 5)
    expect((await runs()).map((r) => [r.scope, r.changed, r.more])).toEqual([
      ['base', DREAM_CHANGED_PER_CALL, true],
      ['base', 5, false],
      [null, 0, false],
    ])
    expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'idle' })
  })

  it('近邻：有向量时按向量找最相近的，这条没有向量时按全文', async () => {
    const res = await app.request(
      '/v1/settings/embedding',
      jsonRequest(
        'PUT',
        { model: 'm', channels: [{ baseUrl: 'https://embed.example.com/v1', model: 'm' }] },
        { cookie: ws.cookie },
      ),
    )
    expect(res.status).toBe(200)
    await remember({ uri: 'core://a', content: '回答问题时用中文', layer: 'base' })
    await remember({ uri: 'core://b', content: '回答问题时用中文并且先给结论', layer: 'base' })
    await remember({ uri: 'core://c', content: '周五下午交周报', layer: 'base' })
    await remember({ uri: 'core://e', content: '中文', layer: 'base' })
    await backfillJob(database.db, staticEmbedderSource(fakeEmbedder('m')), async () => [])
    const { model, calls } = fakeChatModel(reply([]))
    await dream(model)
    // 只有 a 改过；e 的向量删掉：按向量找时它不在候选里，按全文找时它会命中「中文」
    await edit({ uri: 'core://a', content: '回答问题时用中文，别用英文' })
    const [e] = await inSpace((tx) => tx.select().from(memories).where(eq(memories.path, 'e')))
    await inSpace((tx) => tx.delete(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, e!.id)))
    await dream(model)
    expect(
      dreamLines(calls[1]!)
        .filter((l) => !l.new)
        .map((l) => l.content)
        .sort(),
    ).toEqual(['周五下午交周报', '回答问题时用中文并且先给结论'].sort())

    // 改过的这条自己没有向量时按全文
    await inSpace((tx) => tx.delete(memoryEmbeddings))
    await edit({ uri: 'core://a', content: '回答问题时用中文，不要英文' })
    await dream(model)
    const neighbors = dreamLines(calls[2]!)
      .filter((l) => !l.new)
      .map((l) => l.content)
    expect(neighbors).toContain('中文')
    expect(neighbors).not.toContain('周五下午交周报')
  })

  it('本月的抽取预算用完了不整理；Dream 用掉的 token 计入同一份预算，用完了就停在那里', async () => {
    const budget = async (monthlyTokens: number) =>
      expect(
        (
          await send('PUT', '/extraction-budget', {
            monthlyTokens,
            dailyWritesPerSubject: 20,
          })
        ).status,
      ).toBe(200)
    const usage = async () =>
      ((await (await send('GET', '/extraction-budget')).json()) as ExtractionUsage).usedTokens
    const bot = await ws.createApp('qq-bot')
    await inSpace((tx) =>
      tx.insert(extractionRuns).values({
        spaceId: ws.spaceId,
        appId: bot.id,
        scope: 'group:x',
        subjectIds: [],
        turns: 1,
        promptTokens: 1_000,
      }),
    )
    await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
    await remember({ uri: 'home://note', content: '自己的笔记' })
    const { model, calls } = fakeChatModel(reply([]))

    await budget(1_000)
    expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'budget' })
    expect(calls).toEqual([])
    expect((await runs()).at(-1)).toMatchObject({ scope: null, skipped: 'budget', promptTokens: 0 })

    // 还剩一点：第一个范围用掉 150，超出之后第二个范围不再请求，没整理的原因记在那个范围上（私人层的只给本人看）
    await budget(1_100)
    expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
    expect(calls).toHaveLength(1)
    expect(await usage()).toBe(1_150)
    // 共享的汇总写在画像层与私人层之前，私人层没整理的原因只记在它自己的范围上
    expect((await runs()).slice(-3).map((r) => [r.scope, r.ownerAccountId, r.skipped])).toEqual([
      ['base', null, null],
      [null, null, null],
      [`private:${ws.accountId}`, ws.accountId, 'budget'],
    ])
  })

  it('没配抽取模型时不整理，记下原因', async () => {
    await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
    await clearExtractionConfig(database.db)
    const { model, calls } = fakeChatModel(reply([]))
    expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'no-model' })
    expect(calls).toEqual([])
    expect(await runs()).toMatchObject([{ scope: null, skipped: 'no-model', trigger: 'manual' }])
  })

  it('拒绝过的、还在待审里的建议不再提；涉及的记忆改过之后可以再提', async () => {
    await remember({ uri: 'core://report', content: '周五之前交周报', layer: 'base' })
    await remember({ uri: 'core://meeting', content: '周一开例会', layer: 'base' })
    const { model } = fakeChatModel((messages) =>
      reply(
        dreamLines(messages).map((l) => ({ kind: 'stale', memories: [l.id], reason: '过时了' })),
      ),
    )
    await dream(model)
    const first = await stored()
    expect(first).toHaveLength(2)
    const report = first.find((s) => s.versions[0] === 1 && s.memoryIds.length === 1)!
    expect((await send('POST', `/dream/suggestions/${report.id}/reject`)).status).toBe(204)

    // 让它重看一遍：同样的两条，拒绝过的与还在待审的都不再存
    await forget()
    await dream(model)
    expect(await stored()).toHaveLength(2)
    expect((await scopeRuns()).at(-1)).toMatchObject({ suggested: 0, known: 2 })

    // 改过之后版本变了，可以再提
    const [row] = await inSpace((tx) =>
      tx.select().from(memories).where(eq(memories.id, report.memoryIds[0]!)),
    )
    await edit({ uri: `${row!.domain}://${row!.path}`, content: `${row!.content}（已延期）` })
    await dream(model)
    const now = await stored()
    expect(now).toHaveLength(3)
    expect(
      now.filter((s) => s.memoryIds[0] === row!.id).map((s) => [s.versions[0], s.status]),
    ).toEqual([
      [1, 'rejected'],
      [2, 'pending'],
    ])
  })

  it('请求模型失败时记下原因、不记整理过，这次就停下；输出解析不了时记下原因与用量、记下整理过', async () => {
    await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
    await remember({ uri: 'home://note', content: '自己的笔记' })
    const failing: ChatModel = {
      model: 'fake-model',
      async complete() {
        throw new Error('抽取模型返回 HTTP 502：bad gateway')
      },
    }
    expect(await dream(failing)).toEqual({ outcome: 'failed', reason: null })
    // 共享的范围出错就停下，汇总记出错，画像层与私人层这次不整理
    expect(await runs()).toMatchObject([
      { scope: 'base', error: '抽取模型返回 HTTP 502：bad gateway', promptTokens: 0 },
      { scope: null, error: '共享范围出错，本次已停止（原因见出错的范围）' },
    ])
    expect(await inSpace((tx) => tx.select().from(dreamMarks))).toEqual([])

    const { model, calls } = fakeChatModel('今天没什么好整理的')
    expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
    expect(calls).toHaveLength(2)
    expect((await scopeRuns()).slice(1)).toMatchObject([
      { scope: 'base', error: '模型的输出里没有约定格式的 JSON 对象', promptTokens: 120 },
      {
        scope: `private:${ws.accountId}`,
        error: '模型的输出里没有约定格式的 JSON 对象',
        promptTokens: 120,
      },
    ])
    // 解析不了的那一批记了整理过，汇总照样是整理过了
    expect((await summaries()).at(-1)).toMatchObject({ skipped: null, error: null })
    expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'idle' })
  })

  it('不按时间判断：写了很久才提交的、导入的（带着原来的更新时间）都会整理；整理过、没改过的不再给模型看', async () => {
    await remember({ uri: 'core://a', content: '刚写下的', layer: 'base' })
    // 另一条连接里写下一条、先不提交：更新时间是十分钟前（像是事务开始得早、过了很久才提交）
    const side = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
    let commit!: () => void
    const committed = new Promise<void>((resolve) => (commit = resolve))
    try {
      const late = side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        await tx`
          insert into memories (space_id, form, layer, sensitivity, provenance, domain, path, content, updated_at)
          values (${ws.spaceId}, 'curated', 'base', 'public', 'owner', 'core', 'late', '晚提交的',
            now() - interval '10 minutes')`
        await committed
      })
      const { model, calls } = fakeChatModel(reply([]))
      const fresh = () =>
        dreamLines(calls.at(-1)!)
          .filter((l) => l.new)
          .map((l) => l.content)
      await dream(model)
      expect(fresh()).toEqual(['刚写下的'])
      commit()
      await late

      // 提交之后，比整理过的那条早十分钟的这条照样看得到
      await dream(model)
      expect(calls).toHaveLength(2)
      expect(fresh()).toEqual(['晚提交的'])

      // 导入的记忆带着原来的更新时间（一年前）
      await inSpace((tx) =>
        tx.insert(memories).values({
          spaceId: ws.spaceId,
          form: 'curated',
          layer: 'base',
          sensitivity: 'public',
          provenance: 'owner',
          domain: 'core',
          path: 'imported',
          content: '导入的',
          createdAt: new Date(Date.now() - 365 * 86_400_000),
          updatedAt: new Date(Date.now() - 365 * 86_400_000),
        }),
      )
      await dream(model)
      expect(calls).toHaveLength(3)
      expect(fresh()).toEqual(['导入的'])

      // 都整理过、没改过：不再请求模型
      expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'idle' })
      expect(calls).toHaveLength(3)
    } finally {
      commit()
      await side.end()
    }
  })

  it('整理中途出了没料到的错也记一条运行记录、写明原因，当天就算整理过', async () => {
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
      apiKey: 'test-api-key',
    })
    await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
    const { model, calls } = fakeChatModel(reply([]))
    // 没配主密钥：抽取模型的 Key 解不开，读设置时就出错
    const outcome = await dreamSpace(database.db, null, {
      spaceId: ws.spaceId,
      runId: randomUUID(),
      trigger: 'scheduled',
      modelFor: () => model,
    })
    expect(outcome).toEqual({ outcome: 'failed', reason: null })
    expect(calls).toEqual([])
    expect(await runs()).toMatchObject([
      {
        trigger: 'scheduled',
        scope: null,
        error: '整理出错：抽取模型的 Key 已加密保存，但服务端未配置 KIOKU_MASTER_KEY',
      },
    ])
    expect(await dreamsDue(database.db)).toEqual([])
  })

  it('主密钥对不上：运行记录里是给管理员的说明（轮换时旧的那把配在哪里），不是里面那层的报错', async () => {
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
      apiKey: 'test-api-key',
    })
    await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
    const { model, calls } = fakeChatModel(reply([]))
    const failing = () =>
      dreamSpace(database.db, randomBytes(32), {
        spaceId: ws.spaceId,
        runId: randomUUID(),
        trigger: 'scheduled',
        modelFor: () => model,
      })
    // 记着主密钥的标识：还没解密就知道对不上
    expect(await failing()).toEqual({ outcome: 'failed', reason: null })
    // 加上标识之前保存的：解密时才失败，里面那层是解密库的英文报错
    const [row] = await database.db.select().from(settings).where(eq(settings.key, 'extraction'))
    const value = row!.value as { apiKey: { keyId?: string } }
    delete value.apiKey.keyId
    await database.db.update(settings).set({ value }).where(eq(settings.key, 'extraction'))
    expect(await failing()).toEqual({ outcome: 'failed', reason: null })

    expect(calls).toEqual([])
    const errors = (await runs()).map((r) => r.error)
    expect(errors).toHaveLength(2)
    for (const error of errors) {
      expect(error).toMatch(/^整理出错：抽取模型的 Key 无法解密/)
      expect(error).toContain('旧密钥须配置在 KIOKU_MASTER_KEY_PREVIOUS')
    }
  })

  it('读库出错：运行记录里只有数据库的说明，没有 SQL 与参数', async () => {
    const outcome = await dreamSpace(settingsQueryFails(database.db), masterKey, {
      spaceId: ws.spaceId,
      runId: randomUUID(),
      trigger: 'scheduled',
      modelFor: () => fakeChatModel(reply([])).model,
    })
    expect(outcome).toEqual({ outcome: 'failed', reason: null })
    const [run] = await runs()
    expect(run!.error).toMatch(/^整理出错：.*no_such_table/)
    for (const leaked of ['Failed query', 'params:', 'select']) {
      expect(run!.error).not.toContain(leaked)
    }
  })

  it('连运行记录都写不进去时，两个错误都记进日志，原来的错误照样抛出去（后台任务记成失败）', async () => {
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
      apiKey: 'test-api-key',
    })
    await database.db.execute(sql`
      create or replace function dream_test_fail() returns trigger language plpgsql
      as $$ begin raise exception '测试里故意出的错'; end $$`)
    await database.db.execute(sql`
      create trigger dream_test_fail before insert on dream_runs
      for each row execute function dream_test_fail()`)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        dreamSpace(database.db, null, {
          spaceId: ws.spaceId,
          runId: randomUUID(),
          trigger: 'scheduled',
          modelFor: () => fakeChatModel(reply([])).model,
        }),
      ).rejects.toThrow('服务端未配置 KIOKU_MASTER_KEY')
      // 数据库报的错由 drizzle 包在 cause 里
      const messageOf = (err: unknown) => {
        const e = err as Error & { cause?: Error }
        return e.cause?.message ?? e.message
      }
      expect(logged.mock.calls.map(([label, err]) => [label, messageOf(err)])).toEqual([
        ['Dream 整理出错', '抽取模型的 Key 已加密保存，但服务端未配置 KIOKU_MASTER_KEY'],
        ['Dream 的运行记录也写不进去', '测试里故意出的错'],
      ])
    } finally {
      logged.mockRestore()
      await database.db.execute(sql`drop trigger if exists dream_test_fail on dream_runs`)
      await database.db.execute(sql`drop function if exists dream_test_fail()`)
    }
    // 没有运行记录：下一个小时照样会排
    expect(await runs()).toEqual([])
    expect(await dreamsDue(database.db)).toEqual([ws.spaceId])
  })

  it('每天一次：今天（UTC）还没做过定时整理的空间才到期；手动整理不算', async () => {
    const [other] = await database.db
      .insert(spaces)
      .values({ name: '另一个空间' })
      .returning({ id: spaces.id })
    const now = new Date()
    expect((await dreamsDue(database.db, now)).sort()).toEqual([ws.spaceId, other!.id].sort())
    const { model } = fakeChatModel(reply([]))
    await dream(model, 'scheduled')
    await dream(model, 'manual', other!.id)
    expect(await dreamsDue(database.db, now)).toEqual([other!.id])
    // 到了明天（UTC）又到期
    const tomorrow = new Date(now.getTime() + 86_400_000)
    expect((await dreamsDue(database.db, tomorrow)).sort()).toEqual([ws.spaceId, other!.id].sort())
    await inSpace((tx) => tx.update(dreamRuns).set({ createdAt: sql`now() - interval '1 day'` }))
    expect((await dreamsDue(database.db, now)).sort()).toEqual([ws.spaceId, other!.id].sort())
  })

  it('真实的后台任务：现在整理一次按编号查得到状态与结果', { timeout: 30_000 }, async () => {
    const server = await startFakeChatServer(() =>
      reply([{ kind: 'stale', memories: ['M1'], reason: '试试' }]),
    )
    const real = await startJobs({
      connectionString: testDatabaseUrl!,
      db: database.db,
      embedder: staticEmbedderSource(null),
      masterKey,
    })
    const api = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: real,
    })
    const call = (method: string, path: string) =>
      api.request(`/v1/spaces/${ws.spaceId}${path}`, {
        method,
        headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' },
      })
    const finished = async (runId: string) => {
      for (let i = 0; i < 100; i++) {
        const res = await call('GET', `/dream/runs/${runId}`)
        const status = (await res.json()) as DreamRunStatus
        if (status.state === 'finished') return status
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('整理没有做完')
    }
    try {
      await saveExtractionConfig(database.db, masterKey, { baseUrl: server.url, model: 'm' })
      await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
      const res = await call('POST', '/dream/runs')
      expect(res.status).toBe(202)
      const { runId } = (await res.json()) as DreamQueued
      expect(await finished(runId)).toEqual({ state: 'finished', outcome: 'done', reason: null })
      expect(server.requests).toHaveLength(1)
      expect(await stored()).toMatchObject([{ kind: 'stale', status: 'pending' }])
      expect(await runs()).toMatchObject([
        { runId, trigger: 'manual', scope: 'base', suggested: 1 },
        { runId, scope: null, skipped: null, error: null },
      ])

      // 没有新内容：做完了，结果是没整理
      const again = (await (await call('POST', '/dream/runs')).json()) as DreamQueued
      expect(await finished(again.runId)).toEqual({
        state: 'finished',
        outcome: 'skipped',
        reason: 'idle',
      })
      // 别的空间查不到这个编号
      const [other] = await database.db.insert(spaces).values({ name: '别的' }).returning()
      await database.db
        .insert(spaceMembers)
        .values({ spaceId: other!.id, accountId: ws.accountId, role: 'owner' })
      const elsewhere = await api.request(`/v1/spaces/${other!.id}/dream/runs/${runId}`, {
        headers: { cookie: ws.cookie },
      })
      expect(elsewhere.status).toBe(404)
      expect((await call('GET', `/dream/runs/${randomUUID()}`)).status).toBe(404)
    } finally {
      await real.stop()
      await server.close()
    }
  })
})
