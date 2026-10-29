import { randomBytes, randomUUID } from 'node:crypto'

import type {
  DreamQueued,
  DreamRunStatus,
  DreamSuggestionList,
  ExtractionUsage,
  MemoryView,
} from '@kioku/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database, type Tx } from '../../db/client'
import {
  dreamCursors,
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
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeChatModel, dreamLines, handleOf } from '../../testing/fakeChatModel'
import { startFakeChatServer } from '../../testing/fakeChatServer'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { DREAM_CHANGED_PER_CALL, dreamsDue, dreamSpace } from '../dream'
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
  const forget = () => inSpace((tx) => tx.delete(dreamCursors))

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
      (await runs()).map((r) => [r.scope, r.changed, r.considered, r.suggested, r.dropped, r.more]),
    ).toEqual([
      ['base', 3, 3, 2, 0, false],
      [`talk:${scope}`, 4, 4, 5, 0, false],
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
    expect((await runs()).map((r) => [r.suggested, r.dropped])).toEqual([
      [1, 2],
      [1, 7],
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

  it('增量：只看上次以来新增或改动的，没有就不请求模型；改过的那条连同近邻再看一遍', async () => {
    const a = await remember({ uri: 'core://lang', content: '回答问题用中文', layer: 'base' })
    await remember({ uri: 'core://lang-more', content: '用中文回答问题，先给结论', layer: 'base' })
    await remember({ uri: 'core://report', content: '周五交周报', layer: 'base' })
    let answer = reply([])
    const { model, calls } = fakeChatModel(() => answer)
    await dream(model)
    expect(calls).toHaveLength(1)
    expect(await inSpace((tx) => tx.select().from(dreamCursors))).toHaveLength(1)

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
    expect((await runs()).at(-1)).toMatchObject({ changed: 1, considered: 2, dropped: 1 })
  })

  it('一次最多看这么多条新增或改动的，剩下的同一次接着请求；游标停在看过的最后一条', async () => {
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
    expect((await runs()).map((r) => [r.changed, r.more])).toEqual([
      [DREAM_CHANGED_PER_CALL, true],
      [5, false],
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
    await backfillJob(database.db, staticEmbedderSource(fakeEmbedder('m')), () => {})
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

    // 还剩一点：第一个范围用掉 150，超出之后第二个范围不再请求
    await budget(1_100)
    expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
    expect(calls).toHaveLength(1)
    expect(await usage()).toBe(1_150)
    expect((await runs()).slice(-2).map((r) => [r.scope, r.skipped])).toEqual([
      ['base', null],
      [null, 'budget'],
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
    expect((await runs()).at(-1)).toMatchObject({ suggested: 0, known: 2 })

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

  it('请求模型失败时记下原因、不挪游标，这次就停下；输出解析不了时记下原因与用量、挪游标', async () => {
    await remember({ uri: 'core://rule', content: '共享的规则', layer: 'base' })
    await remember({ uri: 'home://note', content: '自己的笔记' })
    const failing: ChatModel = {
      model: 'fake-model',
      async complete() {
        throw new Error('抽取模型返回 HTTP 502：bad gateway')
      },
    }
    expect(await dream(failing)).toEqual({ outcome: 'failed', reason: null })
    expect(await runs()).toMatchObject([
      { scope: 'base', error: '抽取模型返回 HTTP 502：bad gateway', promptTokens: 0 },
    ])
    expect(await inSpace((tx) => tx.select().from(dreamCursors))).toEqual([])

    const { model, calls } = fakeChatModel('今天没什么好整理的')
    expect(await dream(model)).toEqual({ outcome: 'done', reason: null })
    expect(calls).toHaveLength(2)
    expect((await runs()).slice(1)).toMatchObject([
      { error: '模型的输出里没有约定格式的 JSON 对象', promptTokens: 120 },
      { error: '模型的输出里没有约定格式的 JSON 对象', promptTokens: 120 },
    ])
    expect(await dream(model)).toEqual({ outcome: 'skipped', reason: 'idle' })
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
      expect(await runs()).toMatchObject([{ runId, trigger: 'manual', suggested: 1 }])

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
