import { randomBytes } from 'node:crypto'

import type {
  ActivityList,
  ConsoleEntryView,
  CreatedCircle,
  EntryHistory,
  EntryView,
  LensKeyScopes,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database } from '../../db/client'
import { entries, entryEvents, entryVariants, subjects } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import {
  openTestDatabase,
  resetDatabase,
  summaryConversation,
  testDatabaseUrl,
} from '../../testing/db'
import {
  addMember,
  bearer,
  bootstrap,
  FULL_SCOPES,
  jsonRequest,
  type Workspace,
} from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('圈间边界、跨圈迁移与切面场域隔离', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace

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
  })

  const ok = async <T>(res: Response, status = 200) => {
    expect(res.status, await res.clone().text()).toBe(status)
    return (await res.json()) as T
  }
  const createRes = (circleId: string, cookie: string, body: Record<string, unknown>) =>
    app.request(`/v1/circles/${circleId}/entries`, jsonRequest('POST', body, { cookie }))
  const create = async (circleId: string, cookie: string, body: Record<string, unknown>) =>
    ok<ConsoleEntryView>(await createRes(circleId, cookie, body), 201)
  const patchRes = (circleId: string, cookie: string, body: Record<string, unknown>) =>
    app.request(`/v1/circles/${circleId}/entries`, jsonRequest('PATCH', body, { cookie }))
  const transferRes = (circleId: string, cookie: string, body: Record<string, unknown>) =>
    app.request(`/v1/circles/${circleId}/entries/transfer`, jsonRequest('POST', body, { cookie }))
  const getRes = (circleId: string, cookie: string, id: string) =>
    app.request(`/v1/circles/${circleId}/entries?id=${encodeURIComponent(id)}`, {
      headers: { cookie },
    })

  it('个人圈成员各自隔离，经管理界面迁入共享圈后成员可见且不带出个人圈旧历史', async () => {
    const eve = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const m = await create(ws.personalCircleId, ws.cookie, {
      title: '个人计划',
      content: '本人的计划',
    })
    expect(m.circleId).toBe(ws.personalCircleId)
    expect(m.sensitivity).toBe('private')
    expect((await getRes(ws.personalCircleId, eve.cookie, m.shortId)).status).toBe(403)

    // 两位成员各自的个人圈可建同名标题词条，分配各自独立的短 ID
    const theirs = await create(eve.personalCircleId, eve.cookie, {
      title: '个人计划',
      content: 'eve 的计划',
    })
    expect(theirs.id).not.toBe(m.id)
    expect(theirs.shortId).not.toBe(m.shortId)

    // 先在个人圈改过一次正文
    await ok(
      await patchRes(ws.personalCircleId, ws.cookie, { id: m.shortId, content: '改过的个人计划' }),
    )

    // 迁入共享圈：保持同一短 ID、version 重置为 1、只记 transfer_in，不泄露个人圈期间旧版本
    const shared = await ok<ConsoleEntryView>(
      await transferRes(ws.personalCircleId, ws.cookie, {
        entryId: m.id,
        toCircleId: ws.circleId,
      }),
    )
    expect(shared.circleId).toBe(ws.circleId)
    expect(shared.shortId).toBe(m.shortId)
    expect(shared.version).toBe(1)
    expect((await getRes(ws.personalCircleId, ws.cookie, m.shortId)).status).toBe(404)
    expect((await getRes(ws.circleId, eve.cookie, m.shortId)).status).toBe(200)

    const sharedHistory = await ok<EntryHistory>(
      await app.request(`/v1/circles/${ws.circleId}/entries/history?id=${shared.id}`, {
        headers: { cookie: eve.cookie },
      }),
    )
    expect(sharedHistory.events.map((e) => e.type)).toEqual(['transfer_in'])
    expect(JSON.stringify(sharedHistory)).not.toContain('本人的计划')

    // 原个人圈仍保留 transfer_out 审计事件（after = null）
    const outEvents = await withCircle(database.db, ws.personalCircleId, (tx) =>
      tx.select().from(entryEvents).where(eq(entryEvents.eventType, 'transfer_out')),
    )
    expect(outEvents).toHaveLength(1)
    expect(outEvents[0]!.entryId).toBeNull()
    expect(outEvents[0]!.after).toBeNull()
  })

  it('跨圈迁移权限限制：viewer 不能在管理界面迁移；Key 只能在可写共享圈之间迁移且不能涉及个人圈或机密', async () => {
    const viewer = await addMember(database.db, ws.circleId, 'vic', 'viewer')
    const faq = await create(ws.circleId, ws.cookie, { title: 'FAQ', content: '常见问题' })
    const secondShared = await ok<CreatedCircle>(
      await app.request(
        '/v1/circles',
        jsonRequest('POST', { name: '二号共享圈' }, { cookie: ws.cookie }),
      ),
      201,
    )
    const thirdShared = await ok<CreatedCircle>(
      await app.request(
        '/v1/circles',
        jsonRequest('POST', { name: '只读共享圈' }, { cookie: ws.cookie }),
      ),
      201,
    )

    expect(
      (
        await transferRes(ws.circleId, viewer.cookie, {
          entryId: faq.id,
          toCircleId: ws.circleId,
        })
      ).status,
    ).toBe(403)

    const bot = await ws.createClient('agent')
    const keyRes = await app.request(
      `/v1/circles/${ws.circleId}/clients/${bot.id}/keys`,
      jsonRequest(
        'POST',
        {
          name: 'multi',
          linkedCircles: [
            { circleId: secondShared.id, mode: 'read_write' },
            { circleId: thirdShared.id, mode: 'read' },
            { circleId: ws.personalCircleId, mode: 'read_write' },
          ],
          scopes: FULL_SCOPES,
        },
        { cookie: ws.cookie },
      ),
    )
    expect(keyRes.status).toBe(201)
    const key = ((await keyRes.json()) as { key: string }).key
    const viaKey = (body: Record<string, unknown>) =>
      app.request('/v1/entries/transfer', jsonRequest('POST', body, bearer(key)))

    // 只读关联共享圈拒绝、跨进个人圈拒绝
    expect((await viaKey({ id: faq.shortId, toCircle: thirdShared.slug })).status).toBe(403)
    expect((await viaKey({ id: faq.shortId, toCircle: ws.personalCircleId })).status).toBe(403)

    // 可写共享圈之间成功
    const moved = await ok<EntryView>(
      await viaKey({ id: faq.shortId, toCircle: secondShared.slug }),
    )
    expect(moved.circleId).toBe(secondShared.id)
    expect(moved.shortId).toBe(faq.shortId)

    // 主圈上的机密词条禁止用 Key 跨圈迁移
    const sec = await create(ws.circleId, ws.cookie, {
      title: '机密说明',
      content: '内部口令',
      sensitivity: 'secret',
    })
    expect((await viaKey({ id: sec.shortId, toCircle: secondShared.slug })).status).toBe(403)
  })

  it('切面场域（realm）隔离：allowedRealms 限制读写范围', async () => {
    const workClient = await ws.createClient('work-bot')
    const personalBotClient = await ws.createClient('personal-bot')
    const workScopes: LensKeyScopes = { ...FULL_SCOPES, allowedRealms: ['work'] }
    const homeScopes: LensKeyScopes = { ...FULL_SCOPES, allowedRealms: ['home'] }
    const workKey = await ws.issueKey(workClient.id, workScopes)
    const homeKey = await ws.issueKey(personalBotClient.id, homeScopes)

    const workEntry = await ok<EntryView>(
      await app.request(
        '/v1/entries',
        jsonRequest(
          'POST',
          {
            title: '公司规范',
            content: '工作要求',
            sensitivity: 'secret',
            when: { realm: ['work'] },
          },
          bearer(workKey),
        ),
      ),
      201,
    )
    // workKey 不能写超出 allowedRealms 的切片，homeKey 读不到也写不进 work 切片
    expect(
      (
        await app.request(
          '/v1/entries',
          jsonRequest(
            'POST',
            {
              title: '越权场域',
              content: 'home',
              sensitivity: 'secret',
              when: { realm: ['home'] },
            },
            bearer(workKey),
          ),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(`/v1/entries?id=${workEntry.shortId}`, {
          headers: bearer(homeKey),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await app.request(`/v1/entries?id=${workEntry.shortId}`, {
          headers: bearer(workKey),
        })
      ).status,
    ).toBe(200)
  })

  it('会话摘要与未确认来源禁止设为 secret，也禁止跨圈迁移', async () => {
    const convId = await withCircle(database.db, ws.circleId, (tx) =>
      summaryConversation(tx, ws.circleId),
    )
    expect(convId).toBeTruthy()
    const key = await ws.issueKey((await ws.createClient('bot')).id)
    const created = await app.request(
      '/v1/lifecycle/event',
      jsonRequest(
        'POST',
        {
          event: 'turn.end',
          sessionId: 's1',
          user: '聊一聊',
          reply: '好的',
        },
        bearer(key),
      ),
    )
    expect(created.status).toBe(200)
    const seeded = await withCircle(database.db, ws.circleId, async (tx) => {
      const [ep] = await tx
        .insert(entries)
        .values({
          circleId: ws.circleId,
          circleKind: 'shared',
          shortId: 'm-ep2222',
          kind: 'episode',
          title: '会话摘要',
          sensitivity: 'internal',
          provenance: 'owner',
          originScope: 'global',
          conversationId: convId,
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId: ws.circleId,
        entryId: ep!.id,
        kind: 'episode',
        sensitivity: 'internal',
        content: '聊了一轮',
      })
      const [sub] = await tx
        .insert(subjects)
        .values({ circleId: ws.circleId, kind: 'person', displayName: '群友甲' })
        .returning()
      const [untrusted] = await tx
        .insert(entries)
        .values({
          circleId: ws.circleId,
          circleKind: 'shared',
          shortId: 'm-nt2222',
          kind: 'fact',
          title: '未确认来源',
          sensitivity: 'internal',
          provenance: 'untrusted',
          originScope: 'global',
          subjectId: sub!.id,
          subjectKind: 'person',
        })
        .returning()
      await tx.insert(entryVariants).values({
        circleId: ws.circleId,
        entryId: untrusted!.id,
        kind: 'fact',
        sensitivity: 'internal',
        content: '陌生群聊内容',
      })
      return { ep: ep!, untrusted: untrusted! }
    })
    const protectRes = (entryId: string) =>
      app.request(
        `/v1/circles/${ws.circleId}/entries/protect`,
        jsonRequest('POST', { entryId, target: 'secret' }, { cookie: ws.cookie }),
      )
    expect(
      (
        await patchRes(ws.circleId, ws.cookie, {
          id: seeded.ep.shortId,
          sensitivity: 'secret',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await patchRes(ws.circleId, ws.cookie, {
          id: seeded.untrusted.shortId,
          sensitivity: 'secret',
        })
      ).status,
    ).toBe(400)
    expect((await protectRes(seeded.ep.id)).status).toBe(400)
    expect((await protectRes(seeded.untrusted.id)).status).toBe(400)
    expect(
      (
        await transferRes(ws.circleId, ws.cookie, {
          entryId: seeded.ep.id,
          toCircleId: ws.personalCircleId,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await transferRes(ws.circleId, ws.cookie, {
          entryId: seeded.untrusted.id,
          toCircleId: ws.personalCircleId,
        })
      ).status,
    ).toBe(400)
  })

  it('词条改成 secret 后，editor 的变更记录与历史里留下离开事件并抹除新快照', async () => {
    const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
    const wifi = await create(ws.circleId, ws.cookie, {
      title: '无线网',
      content: '密码在柜子里',
    })
    await ok(
      await patchRes(ws.circleId, ws.cookie, {
        id: wifi.shortId,
        sensitivity: 'secret',
      }),
    )

    const items = (
      await ok<ActivityList>(
        await app.request(`/v1/circles/${ws.circleId}/activity`, {
          headers: { cookie: editor.cookie },
        }),
      )
    ).items
    expect(items.map((i) => [i.type, i.shortId, i.left])).toEqual([['update', wifi.shortId, true]])
    // 升为 secret 之前那次 create 快照也被剥光后只留改前可读的这次 update 离开记录；editor 调历史直接 404
    expect(
      (
        await app.request(`/v1/circles/${ws.circleId}/entries/history?id=${wifi.id}`, {
          headers: { cookie: editor.cookie },
        })
      ).status,
    ).toBe(404)
  })
})
