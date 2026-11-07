import { randomBytes } from 'node:crypto'

import type {
  BootPreview,
  ConversationDetail,
  ConversationList,
  KeyScopes,
  LifecycleResponse,
  SubjectDetail,
  SubjectList,
} from '@kioku/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { canRead, type SessionContext } from '../../access/access'
import { createApp } from '../../app'
import { principalForKeyId } from '../../auth/middleware'
import { withSpace, type Database, type Db, type Tx } from '../../db/client'
import {
  apiKeys,
  conversations,
  conversationTurns,
  extractionRuns,
  memories,
  settings,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { NO_USABLE_KEY } from '../../extraction/extract'
import type { ChatMessage, ChatModel } from '../../extraction/provider'
import { saveExtractionConfig } from '../../extraction/settings'
import { processSession } from '../../extraction/worker'
import type { Jobs } from '../../jobs/queue'
import { accessForKey } from '../../memory/context'
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
  let botApp: string
  let ccApp: string
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
    botApp = (
      await ws.createApp('qq-bot', {
        runtimeFamily: 'astrbot',
        config: { elevateOwnerDirect: 'internal' },
      })
    ).id
    ccApp = (await ws.createApp('cc', { runtimeFamily: 'claudecode' })).id
    botKey = await ws.issueKey(botApp)
    ccKey = await ws.createKey(ccApp)
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
  })

  const inSpace = <T>(fn: (tx: Tx) => Promise<T>) => withSpace(database.db, ws.spaceId, fn)
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
    const res = await app.request(`/v1/spaces/${ws.spaceId}${path}`, { headers: { cookie } })
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as T
  }
  const list = (cookie = ws.cookie) => get<ConversationList>('/conversations', cookie)
  const detailRes = (id: string, cookie = ws.cookie) =>
    app.request(`/v1/spaces/${ws.spaceId}/conversations/${id}`, { headers: { cookie } })
  const turns = () =>
    inSpace((tx) => tx.select().from(conversationTurns).orderBy(asc(conversationTurns.id)))
  const conversationRows = () =>
    inSpace((tx) => tx.select().from(conversations).orderBy(asc(conversations.createdAt)))
  // 直接写一段会话摘要，挂在给定的会话上
  const summary = (
    conversationId: string,
    content: string,
    extra: Partial<typeof memories.$inferInsert> = {},
  ) =>
    inSpace(async (tx) => {
      const [row] = await tx
        .insert(memories)
        .values({
          spaceId: ws.spaceId,
          form: 'extracted',
          layer: 'episode',
          sensitivity: 'private',
          provenance: 'agent',
          ownerAccountId: ws.accountId,
          conversationId,
          content,
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          ...extra,
        })
        .returning()
      return row!
    })

  it('生命周期事件来时建立会话、更新最近活动：群聊按群，私聊按人，不带会话上下文的按应用所有者；定时任务不算', async () => {
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
    expect(first.items.map((c) => [c.kind, c.app.name, c.displayName])).toEqual([
      ['none', 'cc', 'alice'],
      ['direct', 'qq-bot', '小红'],
      ['group', 'qq-bot', '读书会'],
    ])
    expect(first.items[0]).toMatchObject({ subject: null, owner: { id: ws.accountId } })
    expect(first.items[2]!.subject).toMatchObject({ kind: 'group', displayName: '读书会' })

    // 同一个群里换个人说话：还是那个会话，只更新最近活动，排到最前面（最近活动早于一分钟以前才更新，见下一个用例）
    await inSpace((tx) =>
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
      const [r] = await inSpace((tx) =>
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

    await inSpace((tx) =>
      tx.update(conversations).set({ lastActiveAt: sql`now() - interval '2 minutes'` }),
    )
    const stale = await row()
    await event({ event: 'prompt.submit', prompt: '过了一会儿' }, ccKey.key)
    const touched = await row()
    expect(touched.xmin).not.toBe(stale.xmin)
    expect(Date.parse(touched.at) - Date.parse(stale.at)).toBeGreaterThan(60_000)

    // 最近活动在将来（时钟偏差、合并时带过来的时间）：下一次事件把它拉回现在，不会一直停着
    await inSpace((tx) =>
      tx.update(conversations).set({ lastActiveAt: sql`now() + interval '1 hour'` }),
    )
    const ahead = await row()
    await event({ event: 'prompt.submit', prompt: '又来了' }, ccKey.key)
    const pulled = await row()
    expect(pulled.xmin).not.toBe(ahead.xmin)
    expect(Date.parse(pulled.at)).toBeLessThan(Date.parse(ahead.at))
  })

  it('写会话出错时只记日志，生命周期事件照常处理', async () => {
    // 写会话这一步报错，别的照常
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
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
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
    expect(await turns()).toMatchObject([
      {
        appId: ccApp,
        chatType: 'none',
        scope: 'global',
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
      { spaceId: ws.spaceId, appId: ccApp, scope: 'global' },
      () => model,
    )
    // 只要摘要的提示语：不列联系人，也不要事实；说话的是本人
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]!.content).toContain('你用一两句话概括')
    expect(calls[0]![1]!.content).toContain('本人：记忆架构改版做到哪了')
    const [local] = (await list()).items
    const rows = await inSpace((tx) =>
      tx.select().from(memories).where(eq(memories.form, 'extracted')),
    )
    expect(rows).toMatchObject([
      {
        layer: 'episode',
        sensitivity: 'private',
        provenance: 'agent',
        originScope: 'global',
        ownerAccountId: ws.accountId,
        conversationId: local!.id,
        content: '讨论了记忆架构改版的进度',
      },
    ])
    expect(await inSpace((tx) => tx.select().from(extractionRuns))).toMatchObject([
      { conversationId: local!.id, summarized: true, summaryOnly: false, added: 0, turns: 1 },
    ])
    expect(await turns()).toEqual([])
    const detail = (await (await detailRes(local!.id)).json()) as ConversationDetail
    expect(detail.summaries.map((s) => s.content)).toEqual(['讨论了记忆架构改版的进度'])
    expect(detail.runs.map((r) => r.conversationId)).toEqual([local!.id])
  })

  it('写不了会话摘要、或敏感级不到私密的 Key 发来的不带会话上下文的轮次不缓冲', async () => {
    const scopes: KeyScopes[] = [
      { ...FULL_SCOPES, writeLayers: ['core', 'user'] },
      { ...FULL_SCOPES, maxSensitivity: 'internal' },
    ]
    for (const s of scopes) {
      const key = await ws.issueKey(ccApp, s)
      await event({ event: 'turn.end', sessionId: 'cc-1', user: '你好', reply: '你好' }, key)
    }
    expect(await turns()).toEqual([])
  })

  it('缓冲之后 Key 的上限降到私密以下：抽取时按同一条规则，这几轮不给模型看', async () => {
    await event({ event: 'turn.end', sessionId: 'cc-1', user: '你好', reply: '你好' }, ccKey.key)
    expect(await turns()).toHaveLength(1)
    // 签发范围在库里改低（模拟这把 Key 现在的上限不够写私密的会话摘要）
    await database.db
      .update(apiKeys)
      .set({ scopes: { ...FULL_SCOPES, maxSensitivity: 'internal' } })
      .where(eq(apiKeys.id, ccKey.id))
    const { model, calls } = fakeModel(JSON.stringify({ summary: '不该写下的摘要' }))
    await processSession(
      database.db,
      masterKey,
      { spaceId: ws.spaceId, appId: ccApp, scope: 'global' },
      () => model,
    )
    expect(calls).toEqual([])
    expect(await turns()).toEqual([])
    expect(await inSpace((tx) => tx.select().from(extractionRuns))).toMatchObject([
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
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const bobsApp = await app.request(
      `/v1/spaces/${ws.spaceId}/apps`,
      jsonRequest(
        'POST',
        { slug: 'bob-cc', name: 'bob-cc', runtimeFamily: 'claudecode' },
        { cookie: bob.cookie },
      ),
    )
    const bobAppId = ((await bobsApp.json()) as { id: string }).id
    const bobsKey = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${bobAppId}/keys`,
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

    // 读权限本身：只有所属成员不带会话上下文的 Key 读得到；本人私聊开启后读本人的内部及以下，这段私密的照样读不到
    const [row] = await inSpace((tx) =>
      tx.select().from(memories).where(eq(memories.content, '第 1 段摘要')),
    )
    const subjects = (await get<SubjectList>('/subjects')).items
    const person = subjects.find((s) => s.displayName === '小红')!
    const room = subjects.find((s) => s.displayName === '读书会')!
    const readsWith = async (keyId: string, context: SessionContext) => {
      const principal = (await principalForKeyId(database.db, keyId))!
      const access = accessForKey(principal, { context, personaId: null, subjects: [] })
      return canRead(access, row!, { personaIds: [] })
    }
    expect(await readsWith(ccKey.id, {})).toBe(true)
    expect(await readsWith(bobKey.id, {})).toBe(false)
    expect(await readsWith(ccKey.id, { chatType: 'group', groupSubjectId: room.id })).toBe(false)
    expect(await readsWith(ccKey.id, { chatType: 'direct', senderSubjectId: person.id })).toBe(
      false,
    )
    const elevated = await ws.createKey(botApp)
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
      `/v1/spaces/${ws.spaceId}/apps/${ccApp}/keys/${ccKey.id}/preview`,
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

  it('群聊、私聊的会话摘要来自未确认来源，不进会话开始', async () => {
    await event({ event: 'prompt.submit', prompt: '你好', context: group() }, botKey)
    const room = (await conversationRows())[0]!
    await summary(room.id, '群里聊了读书会的安排', {
      ownerAccountId: null,
      sensitivity: 'public',
      provenance: 'untrusted',
      originScope: `group:${room.subjectId}`,
    })
    expect(await startContext(botKey, group())).not.toContain('读书会的安排')
    expect(await startContext(ccKey.key)).not.toContain('读书会的安排')
  })

  it('合并联系人时会话跟着走：保留的那边没有会话时改指向；已有时并成一个，摘要与抽取记录挪过去', async () => {
    // 同一个人在两个平台账号上各和机器人私聊过
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
    await inSpace((tx) =>
      tx.insert(extractionRuns).values({
        spaceId: ws.spaceId,
        appId: botApp,
        scope: `direct:${gone.id}`,
        conversationId: goneConversation.id,
        subjectIds: [gone.id],
        turns: 1,
      }),
    )
    // 被合并的那个人在 cc 应用里也有一个会话：保留的那边在这个应用里没有，直接改指向
    const [elsewhere] = await inSpace((tx) =>
      tx
        .insert(conversations)
        .values({ spaceId: ws.spaceId, appId: ccApp, kind: 'direct', subjectId: gone.id })
        .returning(),
    )

    const merged = await app.request(
      `/v1/spaces/${ws.spaceId}/subjects/${keep.id}/merge`,
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
    const [row] = await inSpace((tx) => tx.select().from(memories).where(eq(memories.id, moved.id)))
    expect(row).toMatchObject({
      conversationId: keptConversation.id,
      originScope: `direct:${keep.id}`,
    })
    expect(await inSpace((tx) => tx.select().from(extractionRuns))).toMatchObject([
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
