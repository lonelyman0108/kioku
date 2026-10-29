import { randomBytes } from 'node:crypto'

import type {
  BindCode,
  BindResult,
  CreatedKey,
  RecallResponse,
  SessionContextInput,
  SpaceOverview,
  SubjectBinding,
  SubjectDetail,
  SubjectInfo,
} from '@kioku/contracts'
import { and, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ACCOUNT_ATTEMPTS, APP_ATTEMPTS } from '../../access/binding'
import { createApp } from '../../app'
import { withSpace, type Database, type Tx } from '../../db/client'
import {
  memories,
  settings,
  spaceMembers,
  spaces,
  subjectBindAttempts,
  subjectBindCodes,
  subjectBindings,
  subjectIdentities,
  subjects,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { saveExtractionConfig } from '../../extraction/settings'
import type { Jobs } from '../../jobs/queue'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  addMember,
  bearer,
  bootstrap,
  FULL_SCOPES,
  jsonRequest,
  type Workspace,
} from '../../testing/fixtures'

const DAY = 86_400_000
const INVALID = '绑定码不对或已经失效，请重新申请'

describe.skipIf(!testDatabaseUrl)('验证码自助绑定', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let appId: string
  let key: string
  const masterKey = randomBytes(32)
  // 排进抽取队列的批次与延迟，合并之后看有没有按合并后的批次排
  const queued: { scope: string; delay: number }[] = []
  const jobs: Jobs = {
    enqueueEmbed() {},
    enqueueBackfill: async () => true,
    enqueueSwitch: async () => true,
    enqueuePrune: async () => true,
    enqueueBackup: async () => null,
    backupRun: async () => null,
    enqueueCleanup: async () => true,
    enqueueExtraction: async (target, delay) => {
      queued.push({ scope: target.scope, delay })
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
    await database?.db.delete(settings).where(eq(settings.key, 'extraction'))
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    appId = (await ws.createApp('qq-bot', { name: '群聊 bot', runtimeFamily: 'astrbot' })).id
    key = await ws.issueKey(appId)
    // 配了抽取模型，私聊的对话才进缓冲：合并时看缓冲有没有跟过去
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
    queued.length = 0
  })

  const inSpace = <T>(fn: (tx: Tx) => Promise<T>) => withSpace(database.db, ws.spaceId, fn)
  const direct = (sender: string, platform = 'qq', name?: string): SessionContextInput => ({
    chatType: 'direct',
    platform,
    sender: { id: sender, ...(name ? { name } : {}) },
  })
  const inGroup = (sender: string): SessionContextInput => ({
    chatType: 'group',
    platform: 'qq',
    group: { id: '2001', name: '读书会' },
    sender: { id: sender, name: '小明' },
  })

  // 接入方：申请与使用绑定码
  const issue = (context: SessionContextInput, k = key) =>
    app.request('/v1/bind/code', jsonRequest('POST', { context }, bearer(k)))
  const codeFor = async (context: SessionContextInput, k = key) => {
    const res = await issue(context, k)
    expect(res.status, await res.clone().text()).toBe(200)
    return ((await res.json()) as BindCode).code
  }
  const redeem = (code: string, context: SessionContextInput, k = key) =>
    app.request('/v1/bind', jsonRequest('POST', { code, context }, bearer(k)))
  const errorOf = async (res: Response, status: number) => {
    expect(res.status, await res.clone().text()).toBe(status)
    return ((await res.json()) as { error: string }).error
  }
  const resultOf = async (res: Response) => {
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as BindResult
  }
  // 一次私聊：没见过的平台账号会建出对象
  const meet = async (context: SessionContextInput) => {
    const res = await app.request(
      '/v1/recall',
      jsonRequest('POST', { query: '你好', context }, bearer(key)),
    )
    expect(res.status).toBe(200)
  }
  const say = async (user: string, context: SessionContextInput) => {
    const res = await app.request(
      '/v1/lifecycle/event',
      jsonRequest(
        'POST',
        { event: 'turn.end', sessionId: 's', context, user, reply: '嗯' },
        bearer(key),
      ),
    )
    expect(res.status).toBe(200)
  }
  const recallSubjects = async (context: SessionContextInput) => {
    const res = await app.request(
      '/v1/recall',
      jsonRequest('POST', { query: '你好', context }, bearer(key)),
    )
    return ((await res.json()) as RecallResponse).subjects.flatMap((s) =>
      s.facts.map((f) => f.content),
    )
  }
  // 平台账号现在挂在哪个对象上
  const subjectIdOf = async (platform: string, externalId: string) => {
    const [row] = await inSpace((tx) =>
      tx
        .select({ id: subjectIdentities.subjectId })
        .from(subjectIdentities)
        .where(
          and(
            eq(subjectIdentities.platform, platform),
            eq(subjectIdentities.externalId, externalId),
          ),
        ),
    )
    return row?.id
  }
  const extracted = (values: {
    layer: 'subject' | 'episode'
    content: string
    originScope: string
    subjectId?: string
  }) =>
    inSpace((tx) =>
      tx.insert(memories).values({
        spaceId: ws.spaceId,
        form: 'extracted',
        sensitivity: 'public',
        provenance: 'untrusted',
        subjectId: values.subjectId ?? null,
        expiresAt: values.layer === 'episode' ? new Date(Date.now() + DAY) : null,
        ...values,
      }),
    )

  // 管理界面
  const api = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(
      `/v1/spaces/${ws.spaceId}${path}`,
      method === 'GET' ? { headers: { cookie } } : jsonRequest(method, body ?? {}, { cookie }),
    )
  const detailOf = async (id: string, cookie = ws.cookie) => {
    const res = await api('GET', `/subjects/${id}`, undefined, cookie)
    expect(res.status).toBe(200)
    return (await res.json()) as SubjectDetail
  }
  const pendingOf = async (cookie = ws.cookie) => {
    const res = await api('GET', '/overview', undefined, cookie)
    expect(res.status).toBe(200)
    return ((await res.json()) as SpaceOverview).pendingBindings
  }
  const link = async (subjectId: string, cookie = ws.cookie, linkedToMe = true) =>
    expect((await api('PATCH', `/subjects/${subjectId}`, { linkedToMe }, cookie)).status).toBe(200)
  const confirm = (binding: SubjectBinding, cookie = ws.cookie) =>
    api('POST', `/subject-bindings/${binding.id}/confirm`, {}, cookie)
  const reject = (binding: SubjectBinding, cookie = ws.cookie) =>
    api('POST', `/subject-bindings/${binding.id}/reject`, {}, cookie)
  const identitiesOf = (info: SubjectInfo) =>
    info.identities.map((i) => `${i.platform}:${i.externalId}`).sort()
  // 输错计数：计数键 → 次数
  const counters = async () =>
    Object.fromEntries(
      (
        await inSpace((tx) =>
          tx
            .select({ key: subjectBindAttempts.key, count: subjectBindAttempts.count })
            .from(subjectBindAttempts),
        )
      ).map((r) => [r.key, r.count]),
    )
  const accountCounter = (platform: string, id: string) => JSON.stringify(['account', platform, id])
  const APP_COUNTER = JSON.stringify(['app'])

  it('私聊里申请绑定码，到另一个平台的私聊里用它：收码的对象并进发码的对象，平台账号、事实、私聊里记下的与缓冲都归过去', async () => {
    await say('你好', direct('1001', 'qq', '小明'))
    await say('我住在上海', direct('u1', 'tg', '明'))
    const a = (await subjectIdOf('qq', '1001'))!
    const b = (await subjectIdOf('tg', 'u1'))!
    await extracted({
      layer: 'subject',
      content: '住在上海',
      originScope: `direct:${b}`,
      subjectId: b,
    })
    await extracted({ layer: 'episode', content: '私聊里聊了上海', originScope: `direct:${b}` })

    const res = await issue(direct('1001', 'qq', '小明'))
    expect(res.status).toBe(200)
    const issued = (await res.json()) as BindCode
    // 8 位，没有容易看混的 0、O、1、I、L
    expect(issued.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/)
    expect(issued.expiresInSeconds).toBe(600)
    expect(new Date(issued.expiresAt).getTime() - Date.now()).toBeGreaterThan(590_000)
    // 库里只有哈希，记着谁、用哪个平台账号申请的
    const [stored] = await inSpace((tx) => tx.select().from(subjectBindCodes))
    expect(stored!.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(issued.code)
    expect(stored).toMatchObject({ subjectId: a, platform: 'qq', externalId: '1001', usedAt: null })

    queued.length = 0
    // 不分大小写，空格与连字符不算
    const typed = ` ${issued.code.slice(0, 4).toLowerCase()}-${issued.code.slice(4)} `
    expect(await resultOf(await redeem(typed, direct('u1', 'tg', '明')))).toEqual({
      status: 'merged',
      expiresAt: null,
    })
    expect((await api('GET', `/subjects/${b}`)).status).toBe(404)
    const merged = await detailOf(a)
    expect(identitiesOf(merged)).toEqual(['qq:1001', 'tg:u1'])
    expect(merged.facts.map((f) => [f.content, f.scope.kind, f.scope.id])).toEqual([
      ['住在上海', 'direct', a],
    ])
    expect(merged.summaries.map((s) => s.content)).toEqual(['私聊里聊了上海'])
    // 缓冲里还没抽取的对话跟过来，按合并后的批次排抽取
    expect(queued).toEqual([{ scope: `direct:${a}`, delay: 600 }])
    // 合并后用哪个平台账号私聊，都读得到私聊里记下的
    expect(await recallSubjects(direct('1001'))).toEqual(['住在上海'])
    expect(await recallSubjects(direct('u1', 'tg'))).toEqual(['住在上海'])
    // 对象页的绑定记录：谁、什么时候、用哪个平台账号发码与收码，经由哪个应用
    expect(merged.bindings).toMatchObject([
      {
        status: 'merged',
        subject: { id: a, displayName: '小明' },
        incoming: null,
        redeemedBy: { platform: 'tg', externalId: 'u1', displayName: '明' },
        issuedBy: { platform: 'qq', externalId: '1001' },
        issuedAt: new Date(stored!.createdAt).toISOString(),
        app: { id: appId, name: '群聊 bot' },
        confirmer: null,
        decidedBy: null,
        expiresAt: null,
        canConfirm: false,
        canReject: false,
      },
    ])
    expect(merged.bindings[0]!.decidedAt).not.toBeNull()
    const [used] = await inSpace((tx) => tx.select().from(subjectBindCodes))
    expect(used!.usedAt).not.toBeNull()
  })

  it('同一个人再申请时旧码作废；码只能用一次；过期的不认', async () => {
    const first = await codeFor(direct('1001'))
    const second = await codeFor(direct('1001'))
    expect(second).not.toBe(first)
    expect(await errorOf(await redeem(first, direct('u1', 'tg')), 400)).toBe(INVALID)
    expect((await resultOf(await redeem(second, direct('u2', 'tg')))).status).toBe('merged')
    const a = await subjectIdOf('qq', '1001')
    expect(await subjectIdOf('tg', 'u2')).toBe(a)
    // 用过的码换一个账号再用也不认
    expect(await errorOf(await redeem(second, direct('u3', 'tg')), 400)).toBe(INVALID)
    expect(await subjectIdOf('tg', 'u1')).not.toBe(a)
    expect(await subjectIdOf('tg', 'u3')).not.toBe(a)

    const third = await codeFor(direct('1002'))
    await inSpace((tx) =>
      tx
        .update(subjectBindCodes)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(subjectBindCodes.platform, 'qq')),
    )
    expect(await errorOf(await redeem(third, direct('u4', 'tg')), 400)).toBe(INVALID)
    expect(await subjectIdOf('tg', 'u4')).not.toBe(await subjectIdOf('qq', '1002'))
  })

  it('群里不发码也不收码，不因此建对象', async () => {
    expect(await errorOf(await issue(inGroup('1001')), 400)).toBe('只能在私聊里申请绑定码')
    expect((await issue({ chatType: 'cron' })).status).toBe(400)
    const code = await codeFor(direct('1001'))
    expect(await errorOf(await redeem(code, inGroup('1002')), 400)).toBe('只能在私聊里绑定')
    // 群和群里的人都没建出来；码也还在
    const all = await inSpace((tx) => tx.select().from(subjectIdentities))
    expect(all.map((i) => i.externalId)).toEqual(['1001'])
    expect((await resultOf(await redeem(code, direct('u1', 'tg')))).status).toBe('merged')
  })

  it('不能绑自己：用申请的账号自己收码、或者已经并在一起的账号收码都不行', async () => {
    const code = await codeFor(direct('1001'))
    expect(await errorOf(await redeem(code, direct('1001')), 409)).toBe(
      '这个账号和申请绑定码的账号已经是同一个人了',
    )
    expect((await resultOf(await redeem(code, direct('u1', 'tg')))).status).toBe('merged')
    const again = await codeFor(direct('u1', 'tg'))
    expect((await redeem(again, direct('1001'))).status).toBe(409)
  })

  it('Key 在私聊里写不了对象层时不能申请也不能使用，也不建对象', async () => {
    const episodeOnly = await ws.issueKey(appId, { ...FULL_SCOPES, writeLayers: ['episode'] })
    const notAllowed = '这个 bot 的 Key 写不了对象层，不能绑定账号'
    expect(await errorOf(await issue(direct('1001'), episodeOnly), 403)).toBe(notAllowed)
    const code = await codeFor(direct('1002'))
    expect(await errorOf(await redeem(code, direct('u1', 'tg'), episodeOnly), 403)).toBe(notAllowed)
    expect(await subjectIdOf('qq', '1001')).toBeUndefined()
    expect(await subjectIdOf('tg', 'u1')).toBeUndefined()

    // 应用主人被降为 viewer 之后，他的 Key 什么都写不了
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const created = await app.request(
      `/v1/spaces/${ws.spaceId}/apps`,
      jsonRequest(
        'POST',
        { slug: 'bob-bot', name: 'bob', runtimeFamily: 'astrbot' },
        {
          cookie: bob.cookie,
        },
      ),
    )
    const bobApp = ((await created.json()) as { id: string }).id
    const issued = await app.request(
      `/v1/spaces/${ws.spaceId}/apps/${bobApp}/keys`,
      jsonRequest(
        'POST',
        { name: 'k', scopes: { ...FULL_SCOPES, maxSensitivity: 'private' } },
        { cookie: bob.cookie },
      ),
    )
    const bobKey = ((await issued.json()) as CreatedKey).key
    expect((await issue(direct('1003'), bobKey)).status).toBe(200)
    await database.db
      .update(spaceMembers)
      .set({ role: 'viewer' })
      .where(eq(spaceMembers.accountId, bob.accountId))
    expect((await issue(direct('1003'), bobKey)).status).toBe(403)
  })

  it('收码的对象标记成了别的成员时拒绝，码不作废；标记成同一个成员时可以，等那个成员确认', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    await meet(direct('u1', 'tg'))
    const b = (await subjectIdOf('tg', 'u1'))!
    await link(b, bob.cookie)
    // 发码的没标记，收码的标记成 bob：合并会把发码的账号挂到 bob 名下
    const code = await codeFor(direct('1001'))
    expect(await errorOf(await redeem(code, direct('u1', 'tg')), 403)).toContain(
      '标记成了空间里的成员',
    )
    expect(await subjectIdOf('tg', 'u1')).toBe(b)
    expect((await detailOf(b)).account?.id).toBe(bob.accountId)
    // 码没有作废：没标记的账号照样能用
    expect((await resultOf(await redeem(code, direct('u2', 'tg')))).status).toBe('merged')

    // 发码的标记成 alice、收码的标记成 bob：也不行
    const a = (await subjectIdOf('qq', '1001'))!
    await link(a)
    const second = await codeFor(direct('1001'))
    expect(await errorOf(await redeem(second, direct('u1', 'tg')), 403)).toBe(
      '两个账号标记成了不同的成员，不能绑在一起',
    )
    // 收码的也标记成 alice：可以，等 alice 确认
    await link(b, bob.cookie, false)
    await link(b)
    expect((await resultOf(await redeem(second, direct('u1', 'tg')))).status).toBe('pending')
    const [pending] = await pendingOf()
    expect((await (await confirm(pending!)).json()) as SubjectInfo).toMatchObject({
      id: a,
      account: { id: ws.accountId },
    })
    expect(await subjectIdOf('tg', 'u1')).toBe(a)
  })

  it('发码的对象标记了成员：等那个成员本人确认，空间 owner 也不能代办；确认后按合并对象执行', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    const carol = await addMember(database.db, ws.spaceId, 'carol', 'viewer')
    await meet(direct('1001', 'qq', '小明'))
    await meet(direct('u1', 'tg', '明'))
    const a = (await subjectIdOf('qq', '1001'))!
    const b = (await subjectIdOf('tg', 'u1'))!
    await link(a, bob.cookie)
    await extracted({
      layer: 'subject',
      content: '住在上海',
      originScope: `direct:${b}`,
      subjectId: b,
    })

    const code = await codeFor(direct('1001'))
    const result = await resultOf(await redeem(code, direct('u1', 'tg', '明')))
    expect(result.status).toBe('pending')
    expect(new Date(result.expiresAt!).getTime() - Date.now()).toBeGreaterThan(6.9 * DAY)
    // 还没合并；码已经用掉了
    expect(await subjectIdOf('tg', 'u1')).toBe(b)
    expect(await errorOf(await redeem(code, direct('u2', 'tg')), 400)).toBe(INVALID)
    // 同一对对象再来一次时沿用那一条
    const again = await codeFor(direct('1001'))
    expect(await resultOf(await redeem(again, direct('u1', 'tg')))).toEqual(result)
    expect(await inSpace((tx) => tx.select().from(subjectBindings))).toHaveLength(1)

    // 只有 bob 在概览里看得到、能处理；对象页里大家都看得到这一条在等谁
    const [pending] = await pendingOf(bob.cookie)
    expect(pending).toMatchObject({
      status: 'pending',
      subject: { id: a },
      incoming: {
        id: b,
        identities: [{ platform: 'tg', externalId: 'u1', displayName: '明' }],
      },
      redeemedBy: { platform: 'tg', externalId: 'u1' },
      confirmer: { id: bob.accountId, displayName: 'bob' },
      decidedBy: null,
      decidedAt: null,
      canConfirm: true,
      canReject: true,
    })
    expect(await pendingOf()).toEqual([])
    expect(await pendingOf(carol.cookie)).toEqual([])
    expect((await detailOf(a)).bindings).toMatchObject([
      { id: pending!.id, status: 'pending', canConfirm: false, canReject: false },
    ])
    // 收码的那一边也看得到它申请绑到哪里
    expect((await detailOf(b, carol.cookie)).bindings.map((x) => x.id)).toEqual([pending!.id])

    // 空间 owner、viewer 都不能确认或拒绝
    expect(await errorOf(await confirm(pending!), 403)).toBe(
      '只有这个对象标记成的成员本人能处理这次绑定',
    )
    expect((await reject(pending!)).status).toBe(403)
    expect((await confirm(pending!, carol.cookie)).status).toBe(403)
    expect(await subjectIdOf('tg', 'u1')).toBe(b)

    queued.length = 0
    const confirmed = await confirm(pending!, bob.cookie)
    expect(confirmed.status).toBe(200)
    expect(identitiesOf((await confirmed.json()) as SubjectInfo)).toEqual(['qq:1001', 'tg:u1'])
    expect(await subjectIdOf('tg', 'u1')).toBe(a)
    const after = await detailOf(a, bob.cookie)
    expect(after.facts.map((f) => [f.content, f.scope.id])).toEqual([['住在上海', a]])
    expect(after.bindings).toMatchObject([
      {
        id: pending!.id,
        status: 'confirmed',
        decidedBy: { id: bob.accountId, displayName: 'bob' },
        incoming: null,
        canConfirm: false,
        canReject: false,
      },
    ])
    // 处理过的不能再处理
    expect(await errorOf(await confirm(pending!, bob.cookie), 409)).toBe('已经合并了')
    expect((await reject(pending!, bob.cookie)).status).toBe(409)
    expect(await pendingOf(bob.cookie)).toEqual([])
  })

  it('拒绝后不合并；过了确认期限作废；被标记的成员是 viewer 时只能拒绝', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    await meet(direct('1001'))
    const a = (await subjectIdOf('qq', '1001'))!
    await link(a, bob.cookie)

    expect(
      (await resultOf(await redeem(await codeFor(direct('1001')), direct('u1', 'tg')))).status,
    ).toBe('pending')
    const [first] = await pendingOf(bob.cookie)
    expect((await reject(first!, bob.cookie)).status).toBe(204)
    expect(await subjectIdOf('tg', 'u1')).not.toBe(a)
    expect(await errorOf(await confirm(first!, bob.cookie), 409)).toBe('已经拒绝了')
    expect((await detailOf(a)).bindings).toMatchObject([
      { id: first!.id, status: 'rejected', decidedBy: { id: bob.accountId } },
    ])

    expect(
      (await resultOf(await redeem(await codeFor(direct('1001')), direct('u2', 'tg')))).status,
    ).toBe('pending')
    const [second] = await pendingOf(bob.cookie)
    await inSpace((tx) =>
      tx
        .update(subjectBindings)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(subjectBindings.id, second!.id)),
    )
    expect(await pendingOf(bob.cookie)).toEqual([])
    expect(await errorOf(await confirm(second!, bob.cookie), 409)).toBe(
      '已经过了确认期限，这次绑定作废了',
    )
    expect((await reject(second!, bob.cookie)).status).toBe(409)
    expect(await subjectIdOf('tg', 'u2')).not.toBe(a)
    const expired = (await detailOf(a)).bindings.find((x) => x.id === second!.id)!
    expect(expired).toMatchObject({ status: 'expired', canConfirm: false, canReject: false })
    expect(expired.decidedAt).toBe(expired.expiresAt)

    // 被标记的成员降成了 viewer：合并要写权限，确认不了，能拒绝
    expect(
      (await resultOf(await redeem(await codeFor(direct('1001')), direct('u3', 'tg')))).status,
    ).toBe('pending')
    await database.db
      .update(spaceMembers)
      .set({ role: 'viewer' })
      .where(eq(spaceMembers.accountId, bob.accountId))
    const [third] = await pendingOf(bob.cookie)
    expect(third).toMatchObject({ canConfirm: false, canReject: true })
    expect(await errorOf(await confirm(third!, bob.cookie), 403)).toBe('需要 owner 或 editor 角色')
    expect((await reject(third!, bob.cookie)).status).toBe(204)
    expect(await subjectIdOf('tg', 'u3')).not.toBe(a)
  })

  it('等确认期间两边被合并或标记变了：确认时作废并说明，不合并', async () => {
    const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
    await meet(direct('1001'))
    await meet(direct('u1', 'tg'))
    await meet(direct('u9', 'wx'))
    const a = (await subjectIdOf('qq', '1001'))!
    const b = (await subjectIdOf('tg', 'u1'))!
    const d = (await subjectIdOf('wx', 'u9'))!
    await link(a, bob.cookie)
    await resultOf(await redeem(await codeFor(direct('1001')), direct('u1', 'tg')))
    const [pending] = await pendingOf(bob.cookie)
    // 有人在管理界面把别的账号并进了收码的对象：确认的话会连这个账号一起并过去，bob 看到的已经不是这样
    expect((await api('POST', `/subjects/${b}/merge`, { from: d })).status).toBe(200)
    expect(await pendingOf(bob.cookie)).toEqual([])
    expect(await errorOf(await confirm(pending!, bob.cookie), 409)).toBe(
      '这次绑定已经作废：等确认期间对象被合并了',
    )
    expect(await subjectIdOf('tg', 'u1')).toBe(b)
    expect((await detailOf(b)).bindings).toMatchObject([
      { id: pending!.id, status: 'cancelled', note: '等确认期间对象被合并了' },
    ])

    // bob 取消了「这是我」：确认时作废
    await resultOf(await redeem(await codeFor(direct('1001')), direct('u1', 'tg')))
    const [next] = await pendingOf(bob.cookie)
    await link(a, bob.cookie, false)
    expect(await errorOf(await confirm(next!, bob.cookie), 409)).toBe(
      '这个对象已经不再标记成你，这次绑定作废了',
    )
    expect(await subjectIdOf('tg', 'u1')).toBe(b)
    const [row] = await inSpace((tx) =>
      tx.select().from(subjectBindings).where(eq(subjectBindings.id, next!.id)),
    )
    expect(row).toMatchObject({ status: 'cancelled', decidedBy: null })
  })

  it('输错上限：同一个平台账号一小时 5 次；超了之后对的码也不认，提示里看不出码存不存在', async () => {
    const code = await codeFor(direct('1001'))
    const wrong = code === '22222222' ? '33333333' : '22222222'
    for (let i = 0; i < ACCOUNT_ATTEMPTS; i++) {
      expect(await errorOf(await redeem(wrong, direct('u9', 'tg')), 400)).toBe(INVALID)
    }
    const limited = await redeem(wrong, direct('u9', 'tg'))
    const message = await errorOf(limited, 429)
    expect(message).toMatch(/^输错的次数太多了，\d+ 分钟后再试$/)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(3500)
    const right = await redeem(code, direct('u9', 'tg'))
    expect((await errorOf(right, 429)).replace(/\d+/, 'N')).toBe(message.replace(/\d+/, 'N'))
    expect(await subjectIdOf('tg', 'u9')).not.toBe(await subjectIdOf('qq', '1001'))
    // 别的账号不受影响，码也没被用掉
    expect((await resultOf(await redeem(code, direct('u1', 'tg')))).status).toBe('merged')
  })

  it('格式不对的码不算输错；绑定成了清掉这个账号的计数、退回整个应用的那一次，别人的不清', async () => {
    for (let i = 0; i < ACCOUNT_ATTEMPTS + 1; i++) {
      expect(await errorOf(await redeem('hello', direct('u9', 'tg')), 400)).toBe(
        '绑定码是 8 位字母和数字',
      )
    }
    expect(await counters()).toEqual({})
    const code = await codeFor(direct('1001'))
    const wrong = code === '22222222' ? '33333333' : '22222222'
    for (let i = 0; i < 2; i++) await redeem(wrong, direct('u8', 'tg'))
    for (let i = 0; i < 3; i++) await redeem(wrong, direct('u9', 'tg'))
    expect(await counters()).toEqual({
      [accountCounter('tg', 'u8')]: 2,
      [accountCounter('tg', 'u9')]: 3,
      [APP_COUNTER]: 5,
    })
    expect((await resultOf(await redeem(code, direct('u9', 'tg')))).status).toBe('merged')
    expect(await counters()).toEqual({ [accountCounter('tg', 'u8')]: 2, [APP_COUNTER]: 5 })
  })

  it('同一个应用合计一小时 100 次：换着账号猜也会被挡下，被挡下的不占这个账号的次数、不建对象，别的应用不受影响', async () => {
    const code = await codeFor(direct('1001'))
    await inSpace((tx) =>
      tx.insert(subjectBindAttempts).values({
        spaceId: ws.spaceId,
        appId,
        key: APP_COUNTER,
        count: APP_ATTEMPTS,
        resetAt: sql`now() + interval '1 hour'`,
      }),
    )
    const res = await redeem(code, direct('fresh', 'tg'))
    expect(await errorOf(res, 429)).toMatch(/^最近输错绑定码的太多，\d+ 分钟后再试$/)
    expect(await counters()).toEqual({
      [accountCounter('tg', 'fresh')]: 0,
      [APP_COUNTER]: APP_ATTEMPTS + 1,
    })
    expect(await subjectIdOf('tg', 'fresh')).toBeUndefined()
    // 窗口过了就恢复
    await inSpace((tx) =>
      tx.update(subjectBindAttempts).set({ resetAt: sql`now() - interval '1 second'` }),
    )
    expect((await resultOf(await redeem(code, direct('fresh', 'tg')))).status).toBe('merged')
  })

  it('别的应用、别的空间的码不认', async () => {
    const code = await codeFor(direct('1001'))
    const otherApp = (await ws.createApp('tg-bot', { runtimeFamily: 'astrbot' })).id
    const otherKey = await ws.issueKey(otherApp)
    expect(await errorOf(await redeem(code, direct('u1', 'tg'), otherKey), 400)).toBe(INVALID)

    const [space] = await database.db.insert(spaces).values({ name: '别人家' }).returning()
    await database.db
      .insert(spaceMembers)
      .values({ spaceId: space!.id, accountId: ws.accountId, role: 'owner' })
    const created = await app.request(
      `/v1/spaces/${space!.id}/apps`,
      jsonRequest(
        'POST',
        { slug: 'qq-bot', name: 'bot', runtimeFamily: 'astrbot' },
        {
          cookie: ws.cookie,
        },
      ),
    )
    const foreignApp = ((await created.json()) as { id: string }).id
    const issued = await app.request(
      `/v1/spaces/${space!.id}/apps/${foreignApp}/keys`,
      jsonRequest('POST', { name: 'k', scopes: FULL_SCOPES }, { cookie: ws.cookie }),
    )
    const foreignKey = ((await issued.json()) as CreatedKey).key
    expect(await errorOf(await redeem(code, direct('u1', 'tg'), foreignKey), 400)).toBe(INVALID)

    // 原来的应用里照样能用
    expect((await resultOf(await redeem(code, direct('u1', 'tg')))).status).toBe('merged')
    expect(await subjectIdOf('tg', 'u1')).toBe(await subjectIdOf('qq', '1001'))
  })

  it('同一个码被两边同时用：只有一边成功', async () => {
    const code = await codeFor(direct('1001'))
    await meet(direct('u1', 'tg'))
    await meet(direct('u2', 'tg'))
    const a = (await subjectIdOf('qq', '1001'))!
    const [held] = await inSpace((tx) => tx.select().from(subjectBindCodes))
    // 另开一条连接锁住这个码，两个请求都发出去；等它们确实都等在锁上（一个等这个码，
    // 另一个等前一个锁住的发码的对象）之后放开，不靠睡眠猜时机
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    let pending: Promise<Response[]> | undefined
    try {
      await side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        await tx`select id from subject_bind_codes where id = ${held!.id} for update`
        pending = Promise.all([redeem(code, direct('u1', 'tg')), redeem(code, direct('u2', 'tg'))])
        for (let i = 0; ; i++) {
          const [row] = await side<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0
              and query ilike '%for update%'`
          if (row!.n >= 2) break
          if (i >= 400) throw new Error('两个请求没有都等在锁上')
          await new Promise((r) => setTimeout(r, 25))
        }
      })
      const results = await pending!
      expect(results.map((r) => r.status).sort()).toEqual([200, 400])
    } finally {
      await pending?.catch(() => {})
      await side.end()
    }
    const owners = [await subjectIdOf('tg', 'u1'), await subjectIdOf('tg', 'u2')]
    expect(owners.filter((id) => id === a)).toHaveLength(1)
    expect(await inSpace((tx) => tx.select().from(subjectBindings))).toHaveLength(1)
    const [used] = await inSpace((tx) => tx.select().from(subjectBindCodes))
    expect(used!.usedAt).not.toBeNull()
    expect(await inSpace((tx) => tx.select({ id: subjects.id }).from(subjects))).toHaveLength(2)
  })
})
