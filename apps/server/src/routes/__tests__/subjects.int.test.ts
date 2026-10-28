import { randomBytes } from 'node:crypto'

import type {
  RecallResponse,
  SessionContextInput,
  SubjectDetail,
  SubjectInfo,
  SubjectList,
} from '@kioku/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import {
  conversationTurns,
  extractionRuns,
  memories,
  settings,
  spaces,
  subjects,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { ChatModel } from '../../extraction/provider'
import { NO_USABLE_KEY } from '../../extraction/extract'
import { saveExtractionConfig } from '../../extraction/settings'
import { processSession } from '../../extraction/worker'
import type { Jobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const fakeModel = (reply: unknown): ChatModel => ({
  model: 'fake-model',
  async complete() {
    return { content: JSON.stringify(reply), usage: { promptTokens: 40, completionTokens: 10 } }
  },
})

describe.skipIf(!testDatabaseUrl)('对象页', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let appId: string
  let key: string
  const masterKey = randomBytes(32)
  const jobs: Jobs = {
    enqueueEmbed() {},
    enqueueBackfill: async () => true,
    enqueueExtraction: async () => {},
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
    appId = (await ws.createApp('qq-bot', { name: '群聊 bot', runtimeFamily: 'astrbot' })).id
    key = await ws.issueKey(appId)
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
  })

  const api = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(
      `/v1/spaces/${ws.spaceId}${path}`,
      method === 'GET' ? { headers: { cookie } } : jsonRequest(method, body, { cookie }),
    )
  const listOf = async (query = '', cookie = ws.cookie) => {
    const res = await api('GET', `/subjects${query}`, undefined, cookie)
    expect(res.status).toBe(200)
    return (await res.json()) as SubjectList
  }
  const detailOf = async (id: string) => {
    const res = await api('GET', `/subjects/${id}`)
    expect(res.status).toBe(200)
    return (await res.json()) as SubjectDetail
  }
  const group = (sender: string, name: string): SessionContextInput => ({
    chatType: 'group',
    platform: 'qq',
    group: { id: '2001', name: '读书会' },
    sender: { id: sender, name },
  })
  const direct = (sender: string, name?: string): SessionContextInput => ({
    chatType: 'direct',
    platform: 'qq',
    sender: { id: sender, ...(name ? { name } : {}) },
  })
  const lifecycle = (body: Record<string, unknown>) =>
    app.request('/v1/lifecycle/event', jsonRequest('POST', body, bearer(key)))
  const say = async (user: string, context: SessionContextInput) => {
    const res = await lifecycle({ event: 'turn.end', sessionId: 's', context, user, reply: '嗯' })
    expect(res.status).toBe(200)
  }
  // 群里两个人各说一句，抽取出两人与群的事实和一条会话摘要
  const chatInGroup = async () => {
    await say('我在学日语', group('1001', '小明'))
    await say('我喜欢猫', group('1002', '小红'))
    const [turn] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(conversationTurns).orderBy(asc(conversationTurns.id)).limit(1),
    )
    await processSession(
      database.db,
      masterKey,
      { spaceId: ws.spaceId, appId, scope: turn!.scope },
      () =>
        fakeModel({
          facts: [
            { subject: 'M1', op: 'add', content: '在学日语' },
            { subject: 'M2', op: 'add', content: '喜欢猫' },
            { subject: 'G', op: 'add', content: '是个读书会' },
          ],
          summary: '群里聊了学日语和猫',
        }),
    )
  }
  const find = (list: SubjectList, name: string) => list.items.find((s) => s.displayName === name)!

  it('列出人与群：带平台账号与事实条数，能按种类筛选、按名字或平台账号查找', async () => {
    await chatInGroup()
    const all = await listOf()
    expect(all.items.map((s) => [s.kind, s.displayName]).sort()).toEqual([
      ['group', '读书会'],
      ['person', '小明'],
      ['person', '小红'],
    ])
    expect(find(all, '小明')).toMatchObject({
      account: null,
      identities: [{ platform: 'qq', externalId: '1001', displayName: '小明' }],
      factCount: 1,
    })
    expect((await listOf('?kind=group')).items.map((s) => s.displayName)).toEqual(['读书会'])
    expect((await listOf('?q=小红')).items.map((s) => s.displayName)).toEqual(['小红'])
    // 按平台账号找；LIKE 的通配符按字面算
    expect((await listOf('?q=1001')).items.map((s) => s.displayName)).toEqual(['小明'])
    expect((await listOf('?q=%25')).items).toEqual([])
  })

  it('翻页：每页 50 个，新遇到的在前；改名、标记不会让对象挪位置；游标无效时返回 400', async () => {
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(subjects).values(
        Array.from({ length: 55 }, (_, i) => ({
          spaceId: ws.spaceId,
          kind: 'person' as const,
          displayName: `人${i}`,
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
        })),
      ),
    )
    const first = await listOf()
    expect(first.items).toHaveLength(50)
    expect(first.items[0]!.displayName).toBe('人54')
    // 翻页之间改了第二页上的一个对象
    const third = (await listOf('?q=人3')).items.find((s) => s.displayName === '人3')!
    expect((await api('PATCH', `/subjects/${third.id}`, { linkedToMe: true })).status).toBe(200)
    const second = await listOf(`?cursor=${first.nextCursor}`)
    expect(second.items.map((s) => s.displayName)).toEqual(['人4', '人3', '人2', '人1', '人0'])
    expect(second.nextCursor).toBeNull()
    expect((await api('GET', '/subjects?cursor=abc')).status).toBe(400)
  })

  it('详情：事实带来源（哪个群）、群的会话摘要、涉及它的抽取记录', async () => {
    await chatInGroup()
    // 别的群的一批，不涉及这里的人
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(extractionRuns).values({
        spaceId: ws.spaceId,
        appId,
        scope: `group:${crypto.randomUUID()}`,
        subjectIds: [crypto.randomUUID()],
        turns: 1,
      }),
    )
    const all = await listOf()
    const person = await detailOf(find(all, '小明').id)
    expect(person.facts).toMatchObject([
      {
        content: '在学日语',
        provenance: 'untrusted',
        scope: { kind: 'group', id: find(all, '读书会').id, name: '读书会' },
      },
    ])
    // 摘要是群里的，不挂在人身上
    expect(person.summaries).toEqual([])
    expect(person.runs).toMatchObject([
      {
        app: { id: appId, name: '群聊 bot' },
        scope: { kind: 'group', name: '读书会' },
        turns: 2,
        added: 3,
        summarized: true,
        error: null,
      },
    ])
    const room = await detailOf(find(all, '读书会').id)
    expect(room.facts.map((f) => f.content)).toEqual(['是个读书会'])
    expect(room.summaries.map((s) => s.content)).toEqual(['群里聊了学日语和猫'])
    expect(room.summaries[0]!.expiresAt).not.toBeNull()

    // 被推翻（失效）的事实不列、不计数
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx
        .update(memories)
        .set({ validTo: sql`now()` })
        .where(eq(memories.content, '在学日语')),
    )
    expect((await detailOf(person.id)).facts).toEqual([])
    expect(find(await listOf(), '小明').factCount).toBe(0)
    expect((await api('GET', `/subjects/${crypto.randomUUID()}`)).status).toBe(404)
  })

  it('改名之后，平台上的显示名再变也不跟着改', async () => {
    await say('你好', direct('1001', '小明'))
    const id = (await listOf()).items[0]!.id
    const renamed = await api('PATCH', `/subjects/${id}`, { displayName: '  明明  ' })
    expect(renamed.status).toBe(200)
    expect(((await renamed.json()) as SubjectInfo).displayName).toBe('明明')
    await say('我改名了', direct('1001', '小明明'))
    expect(await detailOf(id)).toMatchObject({
      displayName: '明明',
      nameLocked: true,
      identities: [{ displayName: '小明明' }],
    })
    // 改回和平台上一样的名字也算改过：之后平台上再改名不跟
    await api('PATCH', `/subjects/${id}`, { displayName: '小明明' })
    await say('我又改名了', direct('1001', '小明三'))
    expect((await detailOf(id)).displayName).toBe('小明明')
    expect((await api('PATCH', `/subjects/${id}`, {})).status).toBe(400)
  })

  it('平台改名读到「没锁」之后成员刚好把名字改回原样：写名字时再看一次锁，不覆盖', async () => {
    await say('你好', direct('1001', '小明'))
    const id = (await listOf()).items[0]!.id
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    let pending: Promise<void> | undefined
    try {
      await side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        await tx`select id from subjects where id = ${id} for update`
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }]
        pending = say('我改名了', direct('1001', '小明二'))
        for (let i = 0; ; i++) {
          const [row] = await side<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where ${pid}::int = any(pg_blocking_pids(pid))`
          if (row!.n > 0) break
          if (i >= 80) throw new Error('请求没有等在对象这一行上')
          await new Promise((r) => setTimeout(r, 25))
        }
        // 成员把名字「改」成原来的样子：名字没变，但从此锁住
        await tx`update subjects set name_locked = true where id = ${id}`
      })
      await pending
      expect(await detailOf(id)).toMatchObject({
        displayName: '小明',
        nameLocked: true,
        identities: [{ displayName: '小明二' }],
      })
    } finally {
      await pending?.catch(() => {})
      await side.end()
    }
  })

  it('标记为自己：只有人能标记；标记之后这个人的私聊算主人私聊', async () => {
    await chatInGroup()
    const all = await listOf()
    expect(
      (await api('PATCH', `/subjects/${find(all, '读书会').id}`, { linkedToMe: true })).status,
    ).toBe(400)
    const res = await api('PATCH', `/subjects/${find(all, '小明').id}`, { linkedToMe: true })
    expect(res.status).toBe(200)
    expect(((await res.json()) as SubjectInfo).account).toEqual({
      id: ws.accountId,
      displayName: 'alice',
    })

    // 应用开了主人私聊的提升：标记为自己的人私聊时读得到画像层，别人读不到
    await api('POST', '/memories', {
      uri: 'preferences://user',
      content: '主人喜欢简洁',
      layer: 'owner',
      sensitivity: 'internal',
      glossary: ['简洁'],
    })
    expect(
      (await api('PATCH', `/apps/${appId}`, { config: { elevateOwnerDirect: 'internal' } })).status,
    ).toBe(200)
    const recallAs = async (sender: string) => {
      const res = await app.request(
        '/v1/recall',
        jsonRequest('POST', { query: '简洁', context: direct(sender) }, bearer(key)),
      )
      return ((await res.json()) as RecallResponse).candidates.map((c) => c.uri)
    }
    expect(await recallAs('1001')).toEqual(['preferences://user'])
    expect(await recallAs('1002')).toEqual([])
  })

  it('标记的冲突与权限：已是别人的返回 409；只能取消自己的，空间 owner 能取消任何人的；viewer 只能看', async () => {
    await say('你好', direct('1001', '小明'))
    const id = (await listOf()).items[0]!.id
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const carol = await addMember(database.db, ws.spaceId, 'carol', 'viewer')

    expect((await api('PATCH', `/subjects/${id}`, { linkedToMe: true })).status).toBe(200)
    expect((await api('PATCH', `/subjects/${id}`, { linkedToMe: true }, bob.cookie)).status).toBe(
      409,
    )
    expect((await api('PATCH', `/subjects/${id}`, { linkedToMe: false }, bob.cookie)).status).toBe(
      403,
    )
    expect((await listOf('', carol.cookie)).items).toHaveLength(1)
    expect((await api('PATCH', `/subjects/${id}`, { displayName: 'x' }, carol.cookie)).status).toBe(
      403,
    )

    // bob 标记为自己之后，空间 owner 能取消
    expect((await api('PATCH', `/subjects/${id}`, { linkedToMe: false })).status).toBe(200)
    expect((await api('PATCH', `/subjects/${id}`, { linkedToMe: true }, bob.cookie)).status).toBe(
      200,
    )
    const cleared = await api('PATCH', `/subjects/${id}`, { linkedToMe: false })
    expect(((await cleared.json()) as SubjectInfo).account).toBeNull()

    // 被降为 viewer 的成员撤得掉自己当初的标记，但不能标记、不能改名
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.update(subjects).set({ accountId: carol.accountId }).where(eq(subjects.id, id)),
    )
    expect(
      (await api('PATCH', `/subjects/${id}`, { linkedToMe: false }, carol.cookie)).status,
    ).toBe(200)
    expect((await api('PATCH', `/subjects/${id}`, { linkedToMe: true }, carol.cookie)).status).toBe(
      403,
    )
    // 没标记在她身上的，viewer 连「取消」也碰不了
    expect(
      (await api('PATCH', `/subjects/${id}`, { linkedToMe: false }, carol.cookie)).status,
    ).toBe(403)

    // 抽取的失败原因可能带着模型接口的原文，viewer 只看到失败
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(extractionRuns).values({
        spaceId: ws.spaceId,
        appId,
        scope: `direct:${id}`,
        subjectIds: [id],
        turns: 1,
        error: '抽取模型返回 HTTP 401：令牌无效',
      }),
    )
    const runError = async (cookie: string) => {
      const res = await api('GET', `/subjects/${id}`, undefined, cookie)
      return ((await res.json()) as SubjectDetail).runs[0]!.error
    }
    // 模型接口的原文只给实例管理员（alice 是初始化时建的管理员），空间里的 editor、viewer 都看不到
    expect(await runError(ws.cookie)).toBe('抽取模型返回 HTTP 401：令牌无效')
    expect(await runError(bob.cookie)).toBe('抽取失败（原因只有实例管理员看得到）')
    expect(await runError(carol.cookie)).toBe('抽取失败（原因只有实例管理员看得到）')
    // 服务端自己判断出的原因不带外部原文，谁都看得到
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.update(extractionRuns).set({ error: NO_USABLE_KEY }),
    )
    expect(await runError(carol.cookie)).toBe(NO_USABLE_KEY)
  })

  it('别的空间的对象看不到也改不了', async () => {
    const [other] = await database.db.insert(spaces).values({ name: '别人家' }).returning()
    const [stranger] = await withSpace(database.db, other!.id, (tx) =>
      tx
        .insert(subjects)
        .values({ spaceId: other!.id, kind: 'person', displayName: '外人' })
        .returning(),
    )
    expect((await listOf()).items).toEqual([])
    expect((await api('GET', `/subjects/${stranger!.id}`)).status).toBe(404)
    expect((await api('PATCH', `/subjects/${stranger!.id}`, { displayName: 'x' })).status).toBe(404)
    // 不是这个空间的成员
    expect(
      (await app.request(`/v1/spaces/${other!.id}/subjects`, { headers: { cookie: ws.cookie } }))
        .status,
    ).toBe(403)
  })
})
