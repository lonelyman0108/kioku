import { randomBytes } from 'node:crypto'

import type {
  BootPreview,
  ConversationDetail,
  ConversationList,
  LensKeyScopes,
  LifecycleResponse,
  SubjectDetail,
  SubjectList,
} from '@kioku/contracts'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { canRead, type SessionContext } from '../../access/access'
import { createApp } from '../../app'
import { principalForKeyId } from '../../auth/middleware'
import { withCircle, type Database, type Db, type Tx } from '../../db/client'
import {
  apiKeys,
  conversations,
  conversationTurns,
  entries,
  entryVariants,
  extractionRuns,
  settings,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { noContextScope } from '../../extraction/buffer'
import { NO_USABLE_KEY } from '../../extraction/extract'
import type { ChatMessage, ChatModel } from '../../extraction/provider'
import { saveExtractionConfig } from '../../extraction/settings'
import { processSession } from '../../extraction/worker'
import type { Jobs } from '../../jobs/queue'
import { accessForKey } from '../../memory/context'
import { parseEntryFacts } from '../../memory/service'
import { generateShortId } from '../../memory/shortId'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  addMember,
  bearer,
  bootstrap,
  FULL_SCOPES,
  jsonRequest,
  type Workspace,
} from '../../testing/fixtures'

// 假的抽取模型：记下收到的消息，按给定的内容回答
function fakeModel(reply: string) {
  const calls: ChatMessage[][] = []
  const model: ChatModel = {
    model: 'fake-model',
    async complete(messages) {
      calls.push(messages)
      return { content: reply, usage: { promptTokens: 120, completionTokens: 30 } }
    },
  }
  return { model, calls }
}

describe.skipIf(!testDatabaseUrl)('会话', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let botClient: string
  let ccClient: string
  let botKey: string
  let ccKey: { id: string; key: string }
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
    await database?.db.delete(settings).where(eq(settings.key, 'extraction'))
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    botClient = (
      await ws.createClient('qq-bot', {
        runtimeFamily: 'astrbot',
        config: { elevateOwnerDirect: 'internal' },
      })
    ).id
    ccClient = (await ws.createClient('cc', { runtimeFamily: 'claudecode' })).id
    botKey = await ws.issueKey(botClient)
    ccKey = await ws.createKey(ccClient)
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
  })

  const inCircle = <T>(fn: (tx: Tx, now: Date) => Promise<T>) =>
    withCircle(database.db, ws.circleId, fn)
  const event = async (body: object, key: string) => {
    const res = await app.request('/v1/lifecycle/event', jsonRequest('POST', body, bearer(key)))
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as LifecycleResponse
  }
  // claudecode 会话开始的输出：注入的上下文文字
  const startContext = async (key: string, context?: object) => {
    const res = await event(
      { event: 'session.start', sessionId: 's', ...(context ? { context } : {}) },
      key,
    )
    const value = res.hostOutput.value as {
      hookSpecificOutput?: { additionalContext: string }
      context?: string
    } | null
    return value?.hookSpecificOutput?.additionalContext ?? value?.context ?? ''
  }
  const group = (sender = '1001', name = '小明') => ({
    chatType: 'group',
    platform: 'qq',
    group: { id: '2001', name: '读书会' },
    sender: { id: sender, name },
  })
  const direct = (sender = '1002', name = '小红') => ({
    chatType: 'direct',
    platform: 'qq',
    sender: { id: sender, name },
  })
  const get = async <T>(path: string, cookie = ws.cookie) => {
    const res = await app.request(`/v1/circles/${ws.circleId}${path}`, { headers: { cookie } })
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as T
  }
  const list = (cookie = ws.cookie) => get<ConversationList>('/conversations', cookie)
  const detailRes = (id: string, cookie = ws.cookie) =>
    app.request(`/v1/circles/${ws.circleId}/conversations/${id}`, { headers: { cookie } })
  const turns = () =>
    inCircle((tx) => tx.select().from(conversationTurns).orderBy(asc(conversationTurns.id)))
  const conversationRows = () =>
    inCircle((tx) => tx.select().from(conversations).orderBy(asc(conversations.createdAt)))
  // 直接写一段会话摘要，挂在给定的会话上
  const summary = (
    conversationId: string,
    content: string,
    extra: Partial<typeof entries.$inferInsert> = {},
  ) =>
    inCircle(async (tx) => {
      const sensitivity = extra.sensitivity ?? 'private'
      const [row] = await tx
        .insert(entries)
        .values({
          circleId: ws.circleId,
          shortId: generateShortId(),
          circleKind: 'shared',
          kind: 'episode',
          title: content.slice(0, 40),
          sensitivity,
          provenance: 'agent',
          originScope: `client:${ccClient}`,
          ownerAccountId: ws.accountId,
          conversationId,
          priority: 2,
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          ...extra,
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId: ws.circleId,
        entryId: row!.id,
        kind: 'episode',
        sensitivity,
        when: {},
        whenSignature: '{}',
        sortOrder: 0,
        content,
      })
      return row!
    })

  it('生命周期事件来时建立会话、更新最近活动：群聊按群，私聊按人，不带会话上下文的按接入实例所有者；定时任务不算', async () => {
    await event({ event: 'prompt.submit', prompt: '周五读什么', context: group() }, botKey)
    await event(
      { event: 'turn.end', sessionId: 'qq:1002', context: direct(), user: '你好', reply: '你好呀' },
      botKey,
    )
    await event({ event: 'session.start', sessionId: 'cc-1' }, ccKey.key)
    await event(
      { event: 'prompt.submit', prompt: '定时任务', context: { chatType: 'cron' } },
      ccKey.key,
    )
    const first = await list()
    expect(first.items.map((c) => [c.kind, c.client.name, c.displayName])).toEqual([
      ['none', 'cc', 'alice'],
      ['direct', 'qq-bot', '小红'],
      ['group', 'qq-bot', '读书会'],
    ])
    expect(first.items[0]).toMatchObject({ subject: null, owner: { id: ws.accountId } })
    expect(first.items[2]!.subject).toMatchObject({ kind: 'group', displayName: '读书会' })

    // 同一个群里换个人说话：还是那个会话，只更新最近活动，排到最前面（最近活动早于一分钟以前才更新）
    await inCircle((tx) =>
      tx.update(conversations).set({ lastActiveAt: sql`now() - interval '2 minutes'` }),
    )
    const before = (await list()).items.find((c) => c.kind === 'group')!
    await event(
      { event: 'prompt.submit', prompt: '还是读书会', context: group('1003', '小刚') },
      botKey,
    )
    const again = await list()
    expect(again.items).toHaveLength(3)
    expect(again.items[0]!.id).toBe(before.id)
    expect(Date.parse(again.items[0]!.lastActiveAt)).toBeGreaterThanOrEqual(
      Date.parse(before.lastActiveAt),
    )
    expect(await conversationRows()).toHaveLength(3)
  })

  it('最近活动早于一分钟以前才更新：一分钟之内再来的生命周期事件不写会话这一行；最近活动在将来时照样更新', async () => {
    const row = async () => {
      const [r] = await inCircle((tx) =>
        tx.execute<{ xmin: string; at: string }>(
          sql`select xmin::text as xmin, last_active_at::text as at from conversations`,
        ),
      )
      return r!
    }
    await event({ event: 'session.start', sessionId: 'cc-1' }, ccKey.key)
    const first = await row()
    await event({ event: 'prompt.submit', prompt: '接着上次的' }, ccKey.key)
    await event({ event: 'turn.end', sessionId: 'cc-1', user: '你好', reply: '你好' }, ccKey.key)
    // 行没有改写：同一个事务号写下的同一版
    expect(await row()).toEqual(first)

    await inCircle((tx) =>
      tx.update(conversations).set({ lastActiveAt: sql`now() - interval '2 minutes'` }),
    )
    const stale = await row()
    await event({ event: 'prompt.submit', prompt: '过了一会儿' }, ccKey.key)
    const touched = await row()
    expect(touched.xmin).not.toBe(stale.xmin)
    expect(Date.parse(touched.at) - Date.parse(stale.at)).toBeGreaterThan(60_000)

    // 最近活动在将来（时钟偏差、合并时带过来的时间）：下一次事件把它拉回现在，不会一直停着
    await inCircle((tx) =>
      tx.update(conversations).set({ lastActiveAt: sql`now() + interval '1 hour'` }),
    )
    const ahead = await row()
    await event({ event: 'prompt.submit', prompt: '又来了' }, ccKey.key)
    const pulled = await row()
    expect(pulled.xmin).not.toBe(ahead.xmin)
    expect(Date.parse(pulled.at)).toBeLessThan(Date.parse(ahead.at))
  })

  it('写会话出错时只记日志，生命周期事件照常处理', async () => {
    const failing = (db: Db): Db =>
      new Proxy(db, {
        get(target, prop) {
          if (prop === 'transaction') {
            return (run: (tx: Db) => Promise<unknown>, config?: unknown) =>
              target.transaction((tx) => run(failing(tx as unknown as Db)), config as never)
          }
          if (prop !== 'insert') return Reflect.get(target, prop)
          return (table: PgTable) => {
            if (table === conversations) throw new Error('写会话失败')
            return target.insert(table)
          }
        },
      })
    const broken = createApp({
      db: failing(database.db),
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs,
    })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await broken.request(
        '/v1/lifecycle/event',
        jsonRequest('POST', { event: 'session.start', sessionId: 'cc-1' }, bearer(ccKey.key)),
      )
      expect(res.status).toBe(200)
      expect(warned).toHaveBeenCalledWith('记下会话的最近活动失败', expect.anything())
    } finally {
      warned.mockRestore()
    }
    expect(await conversationRows()).toEqual([])
  })

  it('不带会话上下文的会话只有所属成员看得到；群聊、私聊的会话成员都看得到', async () => {
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    await event({ event: 'prompt.submit', prompt: '你好', context: group() }, botKey)
    await event({ event: 'session.start', sessionId: 'cc-1' }, ccKey.key)
    const local = (await list()).items.find((c) => c.kind === 'none')!
    expect(local.owner).toEqual({ id: ws.accountId, displayName: 'alice' })
    expect((await list(bob.cookie)).items.map((c) => c.kind)).toEqual(['group'])
    expect((await detailRes(local.id, bob.cookie)).status).toBe(404)
    expect((await detailRes(local.id)).status).toBe(200)
  })

  it('不带会话上下文的轮次只写会话摘要：归所属成员、私密、来源 Agent，挂在会话上；模型给了事实也不记', async () => {
    await event(
      {
        event: 'turn.end',
        sessionId: 'cc-1',
        user: '记忆架构改版做到哪了',
        reply: '在做会话这部分',
      },
      ccKey.key,
    )
    const expectedScope = noContextScope(ws.accountId, '', '')
    expect(await turns()).toMatchObject([
      {
        clientId: ccClient,
        chatType: 'none',
        scope: expectedScope,
        ownerAccountId: ws.accountId,
        senderSubjectId: null,
        groupSubjectId: null,
      },
    ])
    const { model, calls } = fakeModel(
      JSON.stringify({
        facts: [{ subject: 'M1', op: 'add', content: '在做记忆架构改版' }],
        summary: '讨论了记忆架构改版的进度',
      }),
    )
    await processSession(
      database.db,
      masterKey,
      { circleId: ws.circleId, clientId: ccClient, scope: expectedScope },
      () => model,
    )
    // 只要摘要的提示语：不列联系人，也不要事实；说话的是本人
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]!.content).toContain('你用一两句话概括')
    expect(calls[0]![1]!.content).toContain('本人：记忆架构改版做到哪了')
    const [local] = (await list()).items
    const rows = await inCircle((tx) =>
      tx
        .select({ entry: entries, content: entryVariants.content })
        .from(entries)
        .innerJoin(entryVariants, eq(entryVariants.entryId, entries.id))
        .where(inArray(entries.kind, ['fact', 'episode'])),
    )
    expect(rows).toMatchObject([
      {
        entry: {
          kind: 'episode',
          sensitivity: 'private',
          provenance: 'agent',
          originScope: `client:${ccClient}`,
          ownerAccountId: ws.accountId,
          conversationId: local!.id,
        },
        content: '讨论了记忆架构改版的进度',
      },
    ])
    expect(await inCircle((tx) => tx.select().from(extractionRuns))).toMatchObject([
      { conversationId: local!.id, summarized: true, summaryOnly: false, added: 0, turns: 1 },
    ])
    expect(await turns()).toEqual([])
    const detail = (await (await detailRes(local!.id)).json()) as ConversationDetail
    expect(detail.summaries.map((s) => s.content)).toEqual(['讨论了记忆架构改版的进度'])
    expect(detail.runs.map((r) => r.conversationId)).toEqual([local!.id])
  })

  it('写不了会话摘要、或敏感级不到私密的 Key 发来的不带会话上下文的轮次不缓冲', async () => {
    const scopes: LensKeyScopes[] = [
      { ...FULL_SCOPES, writeKinds: ['entry'] },
      { ...FULL_SCOPES, maxSensitivity: 'internal' },
    ]
    for (const s of scopes) {
      const key = await ws.issueKey(ccClient, s)
      await event({ event: 'turn.end', sessionId: 'cc-1', user: '你好', reply: '你好' }, key)
    }
    expect(await turns()).toEqual([])
  })

  it('缓冲之后 Key 的上限降到私密以下：抽取时按同一条规则，这几轮不给模型看', async () => {
    await event({ event: 'turn.end', sessionId: 'cc-1', user: '你好', reply: '你好' }, ccKey.key)
    const buffered = await turns()
    expect(buffered).toHaveLength(1)
    // 签发范围在库里改低（模拟这把 Key 现在的上限不够写私密的会话摘要）
    await database.db
      .update(apiKeys)
      .set({ scopes: { ...FULL_SCOPES, maxSensitivity: 'internal' } })
      .where(eq(apiKeys.id, ccKey.id))
    const { model, calls } = fakeModel(JSON.stringify({ summary: '不该写下的摘要' }))
    await processSession(
      database.db,
      masterKey,
      { circleId: ws.circleId, clientId: ccClient, scope: buffered[0]!.scope },
      () => model,
    )
    expect(calls).toEqual([])
    expect(await turns()).toEqual([])
    expect(await inCircle((tx) => tx.select().from(extractionRuns))).toMatchObject([
      { error: NO_USABLE_KEY, turns: 0, skippedTurns: 1, summarized: false },
    ])
  })

  it('会话开始带上同一会话最近 3 段摘要；别的成员、群聊、私聊、定时任务都读不到；启动预览也列出来', async () => {
    await startContext(ccKey.key)
    const local = (await conversationRows())[0]!
    for (const n of [4, 3, 2, 1]) {
      await summary(local.id, `第 ${n} 段摘要`, {
        createdAt: new Date(Date.now() - n * 60_000),
      })
    }
    const context = await startContext(ccKey.key)
    expect(context).toContain('## 最近的会话摘要')
    for (const n of [1, 2, 3]) expect(context).toContain(`第 ${n} 段摘要`)
    expect(context).not.toContain('第 4 段摘要')
    expect(context.indexOf('第 1 段摘要')).toBeLessThan(context.indexOf('第 3 段摘要'))

    // 别的成员自己的 Claude Code、群聊与私聊、定时任务的会话开始都没有
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const bobsClient = await app.request(
      `/v1/circles/${ws.circleId}/clients`,
      jsonRequest(
        'POST',
        { slug: 'bob-cc', name: 'bob-cc', runtimeFamily: 'claudecode' },
        { cookie: bob.cookie },
      ),
    )
    const bobClientId = ((await bobsClient.json()) as { id: string }).id
    const bobsKey = await app.request(
      `/v1/circles/${ws.circleId}/clients/${bobClientId}/keys`,
      jsonRequest(
        'POST',
        { name: 'k', scopes: { ...FULL_SCOPES, maxSensitivity: 'private', credentials: 'none' } },
        { cookie: bob.cookie },
      ),
    )
    const bobKey = (await bobsKey.json()) as { id: string; key: string }
    for (const seen of [
      await startContext(bobKey.key),
      await startContext(botKey, group()),
      await startContext(botKey, direct()),
      await startContext(ccKey.key, { chatType: 'cron' }),
    ]) {
      expect(seen).not.toContain('段摘要')
    }

    // 读权限本身：只有所属成员不带会话上下文的 Key 读得到
    const { row, now } = await inCircle(async (tx, now) => {
      const [row] = await tx
        .select({ entry: entries })
        .from(entries)
        .innerJoin(entryVariants, eq(entryVariants.entryId, entries.id))
        .where(eq(entryVariants.content, '第 1 段摘要'))
      return { row: row!.entry, now }
    })
    const subjects = (await get<SubjectList>('/subjects')).items
    const person = subjects.find((s) => s.displayName === '小红')!
    const room = subjects.find((s) => s.displayName === '读书会')!
    const readsWith = async (keyId: string, context: SessionContext) => {
      const principal = (await principalForKeyId(database.db, keyId))!
      const access = accessForKey(principal, { context, personaId: null, subjects: [] })
      return canRead(access, parseEntryFacts(row), { now })
    }
    expect(await readsWith(ccKey.id, {})).toBe(true)
    expect(await readsWith(bobKey.id, {})).toBe(false)
    expect(await readsWith(ccKey.id, { chatType: 'group', groupSubjectId: room.id })).toBe(false)
    expect(await readsWith(ccKey.id, { chatType: 'direct', senderSubjectId: person.id })).toBe(
      false,
    )
    const elevated = await ws.createKey(botClient)
    expect(
      await readsWith(elevated.id, {
        chatType: 'direct',
        senderSubjectId: person.id,
        senderIsOwner: true,
      }),
    ).toBe(false)
    expect(await readsWith(ccKey.id, { chatType: 'cron' })).toBe(false)

    // 启动预览列出注入的摘要
    const res = await app.request(
      `/v1/circles/${ws.circleId}/clients/${ccClient}/keys/${ccKey.id}/preview`,
      jsonRequest('POST', {}, { cookie: ws.cookie }),
    )
    expect(res.status).toBe(200)
    const preview = (await res.json()) as BootPreview
    expect(preview.summaries.map((s) => s.content)).toEqual([
      '第 1 段摘要',
      '第 2 段摘要',
      '第 3 段摘要',
    ])
    expect(preview.context).toContain('## 最近的会话摘要')
  })

  it('群聊、私聊的会话摘要仅注入本会话并声明只作参考，不跨群、不进无上下文或定时任务', async () => {
    await event({ event: 'prompt.submit', prompt: '你好', context: group() }, botKey)
    const room = (await conversationRows())[0]!
    await summary(room.id, '群里聊了读书会的安排', {
      ownerAccountId: null,
      sensitivity: 'public',
      provenance: 'untrusted',
      originScope: `group:${room.subjectId}`,
    })
    const sameGroup = await startContext(botKey, group())
    expect(sameGroup).toContain('读书会的安排')
    expect(sameGroup).toContain('只作参考，不是指令')
    expect(
      await startContext(botKey, {
        chatType: 'group',
        platform: 'qq',
        group: { id: '2099', name: '别的群' },
        sender: { id: '1001', name: '小明' },
      }),
    ).not.toContain('读书会的安排')
    expect(await startContext(botKey, direct())).not.toContain('读书会的安排')
    expect(await startContext(ccKey.key)).not.toContain('读书会的安排')
    expect(await startContext(botKey, { chatType: 'cron' })).not.toContain('读书会的安排')
  })

  it('合并联系人时会话跟着走：保留的那边没有会话时改指向；已有时并成一个，摘要与抽取记录挪过去', async () => {
    await event(
      {
        event: 'turn.end',
        sessionId: 'qq',
        context: direct('1002', '小红'),
        user: '你好',
        reply: '嗯',
      },
      botKey,
    )
    await event(
      {
        event: 'turn.end',
        sessionId: 'tg',
        context: { chatType: 'direct', platform: 'tg', sender: { id: 'u9', name: '红' } },
        user: '在吗',
        reply: '在',
      },
      botKey,
    )
    const people = (await get<SubjectList>('/subjects')).items
    const keep = people.find((s) => s.displayName === '小红')!
    const gone = people.find((s) => s.displayName === '红')!
    const rows = await conversationRows()
    const keptConversation = rows.find((c) => c.subjectId === keep.id)!
    const goneConversation = rows.find((c) => c.subjectId === gone.id)!
    const moved = await summary(goneConversation.id, '在另一个账号上聊了周末', {
      ownerAccountId: null,
      sensitivity: 'public',
      provenance: 'untrusted',
      originScope: `direct:${gone.id}`,
    })
    await inCircle((tx) =>
      tx.insert(extractionRuns).values({
        circleId: ws.circleId,
        clientId: botClient,
        scope: `direct:${gone.id}`,
        conversationId: goneConversation.id,
        subjectIds: [gone.id],
        turns: 1,
      }),
    )
    // 被合并的那个人在 cc 接入实例里也有一个会话：保留的那边在这个接入实例里没有，直接改指向
    const [elsewhere] = await inCircle((tx) =>
      tx
        .insert(conversations)
        .values({ circleId: ws.circleId, clientId: ccClient, kind: 'direct', subjectId: gone.id })
        .returning(),
    )

    const merged = await app.request(
      `/v1/circles/${ws.circleId}/subjects/${keep.id}/merge`,
      jsonRequest('POST', { from: gone.id }, { cookie: ws.cookie }),
    )
    expect(merged.status, await merged.clone().text()).toBe(200)

    const after = await conversationRows()
    expect(after.map((c) => [c.id, c.subjectId]).sort()).toEqual(
      [
        [keptConversation.id, keep.id],
        [elsewhere!.id, keep.id],
      ].sort(),
    )
    const [row] = await inCircle((tx) => tx.select().from(entries).where(eq(entries.id, moved.id)))
    expect(row).toMatchObject({
      conversationId: keptConversation.id,
      originScope: `direct:${keep.id}`,
    })
    expect(await inCircle((tx) => tx.select().from(extractionRuns))).toMatchObject([
      { conversationId: keptConversation.id },
    ])
    // 最近活动取两边较新的
    const latest = Math.max(
      keptConversation.lastActiveAt.getTime(),
      goneConversation.lastActiveAt.getTime(),
    )
    expect(
      after.find((c) => c.id === keptConversation.id)!.lastActiveAt.getTime(),
    ).toBeGreaterThanOrEqual(latest - 1)

    // 联系人详情列出参与的会话
    const detail = await get<SubjectDetail>(`/subjects/${keep.id}`)
    expect(detail.conversations.map((c) => c.id).sort()).toEqual(
      [keptConversation.id, elsewhere!.id].sort(),
    )
    const shown = (await (await detailRes(keptConversation.id)).json()) as ConversationDetail
    expect(shown.summaries.map((s) => s.content)).toEqual(['在另一个账号上聊了周末'])
  })
})
