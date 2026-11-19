import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'

import type { EntryBrowseResponse, EntryView } from '@kioku/contracts'
import { asc, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database } from '../../db/client'
import { entryEvents, entryVariants, legacyUris } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bearer, bootstrap, FULL_SCOPES, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('词条读写接口', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let clientId: string
  let key: string

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
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    const client = await ws.createClient('claude-code')
    clientId = client.id
    key = await ws.issueKey(clientId)
  })

  const call = (method: string, path: string, body?: unknown, k = key) =>
    app.request(
      `/v1${path}`,
      body === undefined ? { method, headers: bearer(k) } : jsonRequest(method, body, bearer(k)),
    )
  const create = (body: Record<string, unknown>, k = key) => call('POST', '/entries', body, k)
  const get = (id: string, k = key, extra = '') =>
    call('GET', `/entries?id=${encodeURIComponent(id)}${extra}`, undefined, k)

  it('创建后能读回：共享圈默认 internal，关联个人圈默认 private', async () => {
    const res = await create({
      title: 'Kioku',
      content: '多人格记忆服务',
      disclosure: '讨论 Kioku 时',
      topics: ['Arch', 'MCP'],
      glossary: ['kioku', '记忆'],
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as EntryView
    const m = (await (await get(created.shortId)).json()) as EntryView
    expect(m).toMatchObject({
      circleId: ws.circleId,
      kind: 'entry',
      sensitivity: 'internal',
      provenance: 'agent',
      topics: ['arch', 'mcp'],
      glossary: ['kioku', '记忆'],
      version: 1,
    })
    expect(m.variants[0]!.content).toBe('多人格记忆服务')

    const linkedKeyRes = await app.request(
      `/v1/circles/${ws.circleId}/clients/${clientId}/keys`,
      jsonRequest(
        'POST',
        {
          name: 'with-personal',
          scopes: FULL_SCOPES,
          linkedCircles: [{ circleId: ws.personalCircleId, mode: 'read_write' }],
        },
        { cookie: ws.cookie },
      ),
    )
    expect(linkedKeyRes.status).toBe(201)
    const linkedKey = ((await linkedKeyRes.json()) as { key: string }).key
    const pRes = await create(
      {
        circle: ws.personalCircleId,
        title: '私人计划',
        content: '个人笔记',
      },
      linkedKey,
    )
    expect(pRes.status).toBe(201)
    const p = (await pRes.json()) as EntryView
    expect(p).toMatchObject({
      circleId: ws.personalCircleId,
      sensitivity: 'private',
      provenance: 'agent',
    })
    expect(p.variants[0]!.content).toBe('个人笔记')
  })

  it('写库真的出错时 500，日志里没有 SQL 与参数：参数就是词条正文', async () => {
    const BODY = '不该进日志的记忆正文'
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 数据库的文本里存不了 NUL，请求校验不拦它，写库时才报错
      const res = await create({ title: 'notes-nul', content: `${BODY}\u0000` })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: '服务内部错误' })
      expect(logged).toHaveBeenCalledOnce()
      const text = inspect(logged.mock.calls, { depth: null })
      for (const leaked of [BODY, 'Failed query', 'insert into']) {
        expect(text).not.toContain(leaked)
      }
      expect(logged.mock.calls[0]![1]).toMatchObject({ code: '22021' })
    } finally {
      logged.mockRestore()
    }
  })

  it('支持按短 ID、UUID、legacy_uris 与精确标题查找；重名标题返回 409，不存在返回 404', async () => {
    const aRes = await create({ title: '部署文档', content: '第一步' })
    expect(aRes.status).toBe(201)
    const a = (await aRes.json()) as EntryView

    await withCircle(database.db, ws.circleId, (tx) =>
      tx.insert(legacyUris).values({
        circleId: ws.circleId,
        entryId: a.id,
        legacyUri: 'core://docs/deploy',
        source: 'lore',
      }),
    )

    for (const ref of [a.shortId, a.id, 'core://docs/deploy', '部署文档']) {
      const r = await get(ref)
      expect(r.status).toBe(200)
      expect(((await r.json()) as EntryView).id).toBe(a.id)
    }

    const bRes = await create({ title: '部署文档', content: '第二步' })
    expect(bRes.status).toBe(201)
    const b = (await bRes.json()) as EntryView

    const ambiguous = await get('部署文档')
    expect(ambiguous.status).toBe(409)
    const errText = ((await ambiguous.json()) as { error: string }).error
    expect(errText).toContain('匹配到多条词条')
    expect(errText).toContain(a.shortId)
    expect(errText).toContain(b.shortId)
    expect((await get('不存在的词条')).status).toBe(404)
  })

  it('修改与删除带错 expectedVersion 返回 409', async () => {
    const first = (await (await create({ title: 'x', content: '旧' })).json()) as EntryView
    const stalePatch = await call('PATCH', '/entries', {
      id: first.shortId,
      expectedVersion: 99,
      content: '覆盖',
    })
    expect(stalePatch.status).toBe(409)
    expect(((await (await get(first.shortId)).json()) as EntryView).variants[0]!.content).toBe('旧')

    const updated = (await (
      await call('PATCH', '/entries', {
        id: first.shortId,
        expectedVersion: first.version,
        content: '改过',
      })
    ).json()) as EntryView
    expect(updated.version).toBe(2)

    expect((await call('DELETE', `/entries?id=${first.shortId}&expectedVersion=1`)).status).toBe(
      409,
    )
    expect((await call('DELETE', `/entries?id=${first.shortId}&expectedVersion=2`)).status).toBe(
      204,
    )
    expect((await get(first.shortId)).status).toBe(404)
  })

  // 用另一条连接锁住这条词条，让请求等待行锁时先在锁内提交一次修改再放开，
  // 稳定复现「检查之后、写入之前被别人改了或删了」
  async function raceWithLockedRow(
    id: string,
    request: () => Response | Promise<Response>,
    change: (side: postgres.TransactionSql, entryId: string) => Promise<unknown>,
  ): Promise<Response> {
    const view = (await (await get(id)).json()) as EntryView
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    try {
      let pending!: Promise<Response>
      await side.begin(async (tx) => {
        await tx`select set_config('app.read_circles', ${ws.circleId}, true)`
        await tx`select set_config('app.write_circles', ${ws.circleId}, true)`
        const locked = await tx`select id from entries where id = ${view.id} for update`
        expect(locked).toHaveLength(1)
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }]
        pending = Promise.resolve(request())
        for (let i = 0; ; i++) {
          const [row] = await side<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where ${pid}::int = any(pg_blocking_pids(pid))`
          if (row!.n > 0) break
          if (i >= 80) throw new Error('请求没有等在行锁上')
          await new Promise((r) => setTimeout(r, 25))
        }
        await change(tx, view.id)
      })
      return await pending
    } finally {
      await side.end()
    }
  }

  it('删除检查之后、写入之前被改过的词条，不会被删掉', async () => {
    const created = (await (await create({ title: 'z', content: '第一版' })).json()) as EntryView
    const deleted = await raceWithLockedRow(
      created.shortId,
      () => call('DELETE', `/entries?id=${created.shortId}&expectedVersion=1`),
      async (tx, id) => {
        await tx`update entries set version = version + 1 where id = ${id}`
        await tx`update entry_variants set content = '第二版' where entry_id = ${id}`
      },
    )
    expect(deleted.status).toBe(409)
    const after = (await (await get(created.shortId)).json()) as EntryView
    expect(after.version).toBe(2)
    expect(after.variants[0]!.content).toBe('第二版')
  })

  it('修改读完之后被删掉的词条，修改不会写进去', async () => {
    const created = (await (await create({ title: 'w', content: '第一版' })).json()) as EntryView
    const patched = await raceWithLockedRow(
      created.shortId,
      () => call('PATCH', '/entries', { id: created.shortId, content: '第二版' }),
      (tx, id) => tx`update entries set deleted_at = now() where id = ${id}`,
    )
    expect(patched.status).toBe(409)
    const [vRow] = await withCircle(database.db, ws.circleId, (tx) =>
      tx
        .select({ content: entryVariants.content })
        .from(entryVariants)
        .where(eq(entryVariants.entryId, created.id)),
    )
    expect(vRow?.content).toBe('第一版')
  })

  it('多变体切片创建、按条件追加覆盖与移除，并同步双链', async () => {
    const target = (await (
      await create({ title: '目标词条', content: '被引用内容' })
    ).json()) as EntryView

    const res = await create({
      title: '部署流程',
      variants: [
        { when: {}, content: '通用步骤' },
        { when: { env: ['prod'] }, content: `生产步骤参考 [[${target.shortId}]]` },
      ],
    })
    expect(res.status).toBe(201)
    const multi = (await res.json()) as EntryView
    expect(multi.variants).toHaveLength(2)
    expect(multi.links.map((l) => [l.shortId, l.direction])).toEqual([[target.shortId, 'outgoing']])

    // 传入重复的切面条件时校验拒绝
    expect(
      (
        await create({
          title: '重复切片',
          variants: [
            { when: { env: ['prod'] }, content: 'a' },
            { when: { env: ['prod'] }, content: 'b' },
          ],
        })
      ).status,
    ).toBe(400)

    const updatedRes = await call('PATCH', '/entries', {
      id: multi.shortId,
      upsertVariants: [{ when: { env: ['staging'] }, content: '预发步骤' }],
      removeVariantWhens: [{ env: ['prod'] }],
      glossaryAdd: ['deploy'],
    })
    expect(updatedRes.status).toBe(200)
    const updated = (await updatedRes.json()) as EntryView
    expect(updated.version).toBe(2)
    expect(updated.variants.map((v) => v.when)).toEqual([{}, { env: ['staging'] }])
    expect(updated.links).toEqual([])
    expect(updated.glossary).toEqual(['deploy'])
  })

  it('标题派生规则：显式标题优先，否则取首个 # 标题，再否则回退短 ID；机密不从正文取', async () => {
    const fromHeading = (await (
      await create({ content: '# 路由器密码\n放在玄关柜里' })
    ).json()) as EntryView
    expect(fromHeading.title).toBe('路由器密码')

    const fallback = (await (await create({ content: '没有井号标题的正文' })).json()) as EntryView
    expect(fallback.title).toBe(fallback.shortId)

    const explicit = (await (
      await create({ title: '自定义标题', content: '# 忽略这个标题\n正文' })
    ).json()) as EntryView
    expect(explicit.title).toBe('自定义标题')

    const secretEntry = (await (
      await create({ content: '# 不应泄露\nhunter2', sensitivity: 'secret' })
    ).json()) as EntryView
    expect(secretEntry.title).toBe(secretEntry.shortId)
  })

  it('删除后不可见，历史事件保留前后快照且不含密文', async () => {
    const created = (await (await create({ title: 'agent', content: 'x' })).json()) as EntryView
    expect((await call('DELETE', `/entries?id=${created.shortId}`)).status).toBe(204)
    expect((await get(created.shortId)).status).toBe(404)
    const events = await withCircle(database.db, ws.circleId, (tx) =>
      tx.select().from(entryEvents).orderBy(asc(entryEvents.id)),
    )
    expect(events.map((e) => e.eventType)).toEqual(['create', 'delete'])
    expect(JSON.stringify(events)).not.toContain('ciphertext')
  })

  it('Key 没有的敏感级与读写权限限制生效：读不到像不存在，写越权报 403', async () => {
    const created = (await (
      await create({ title: '内网路由', content: '内网信息', sensitivity: 'internal' })
    ).json()) as EntryView

    const limitedClient = await ws.createClient('limited')
    const limited = await ws.issueKey(limitedClient.id, {
      ...FULL_SCOPES,
      readKinds: ['fact'],
      writeKinds: ['entry'],
      maxSensitivity: 'public',
    })
    expect((await get(created.shortId, limited)).status).toBe(404)

    const denied = await create({ title: 'x', content: 'x', sensitivity: 'internal' }, limited)
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { error: string }).error).toContain('写入此敏感级词条')
  })

  it('secret 在库里只有密文，授权 Key 能读回明文；降级到非 secret 时转回明文存储', async () => {
    const res = await create({ title: '无线配置', content: 'hunter2', sensitivity: 'secret' })
    expect(res.status).toBe(201)
    const created = (await res.json()) as EntryView
    const [row] = await withCircle(database.db, ws.circleId, (tx) =>
      tx.select().from(entryVariants).where(eq(entryVariants.entryId, created.id)),
    )
    expect(row!.content).toBeNull()
    expect(row!.ciphertext!.toString('utf8')).not.toContain('hunter2')
    expect(((await (await get(created.shortId)).json()) as EntryView).variants[0]!.content).toBe(
      'hunter2',
    )

    const plainClient = await ws.createClient('plain')
    const plain = await ws.issueKey(plainClient.id, { ...FULL_SCOPES, maxSensitivity: 'private' })
    expect((await get(created.shortId, plain)).status).toBe(404)

    const loweredRes = await call('PATCH', '/entries', {
      id: created.shortId,
      sensitivity: 'private',
    })
    expect(loweredRes.status).toBe(200)
    const [afterRow] = await withCircle(database.db, ws.circleId, (tx) =>
      tx.select().from(entryVariants).where(eq(entryVariants.entryId, created.id)),
    )
    expect(afterRow!.content).toBe('hunter2')
    expect(afterRow!.ciphertext).toBeNull()
  })

  it('按维度与主题分组浏览：超出 limit 时标记 truncated，priority 靠前的不会被截掉', async () => {
    for (let i = 0; i < 4; i++) {
      expect(
        (
          await create({
            title: `条目-${i}`,
            content: `内容-${i}`,
            topics: ['ops'],
            when: i === 0 ? {} : { realm: ['work'] },
            priority: i === 3 ? 0 : 5,
          })
        ).status,
      ).toBe(201)
    }

    const byTopicRes = await call('GET', '/entries/browse?groupBy=topic&limit=3')
    expect(byTopicRes.status).toBe(200)
    const byTopic = (await byTopicRes.json()) as EntryBrowseResponse
    expect(byTopic.truncated).toBe(true)
    const ops = byTopic.groups.find((g) => g.key === 'ops')!
    expect(ops.count).toBe(3)
    expect(ops.items[0]!.title).toBe('条目-3')

    const byRealmRes = await call('GET', '/entries/browse?groupBy=realm')
    expect(byRealmRes.status).toBe(200)
    const byRealm = (await byRealmRes.json()) as EntryBrowseResponse
    expect(byRealm.truncated).toBe(false)
    expect(byRealm.groups.map((g) => [g.key, g.count])).toEqual([
      ['__default__', 1],
      ['work', 3],
    ])
  })
})
