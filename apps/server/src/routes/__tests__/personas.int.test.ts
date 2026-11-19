import { randomBytes } from 'node:crypto'

import type {
  CircleMemberList,
  ClientInfo,
  KeyAccessMatrix,
  KeyInfo,
  PersonaDetail,
  PersonaInfo,
  PersonaTrait,
} from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database } from '../../db/client'
import { circleMembers, circles, clientGroupRules, personas, subjects } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  addMember,
  bearer,
  bootstrap,
  FULL_SCOPES,
  jsonRequest,
  type Workspace,
} from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('人格、接入实例与访问密钥的管理', () => {
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

  const as = (method: string, path: string, body: unknown = undefined, cookie = ws.cookie) =>
    app.request(
      `/v1/circles/${ws.circleId}${path}`,
      body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error

  describe('人格与设定段', () => {
    it('改名称、说明与继承，也能改成不继承；标识不变', async () => {
      const parent = await ws.createPersona('doubao')
      const child = await ws.createPersona('doubao-group')
      const res = await as('PATCH', `/personas/${child.id}`, {
        name: '豆包·群聊',
        description: '群里用的',
        extendsId: parent.id,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        slug: 'doubao-group',
        name: '豆包·群聊',
        description: '群里用的',
        extendsId: parent.id,
      })
      const cleared = await as('PATCH', `/personas/${child.id}`, { extendsId: null })
      expect(((await cleared.json()) as PersonaInfo).extendsId).toBeNull()
    })

    it('继承不能成环，被继承的人格要存在', async () => {
      const a = await ws.createPersona('a')
      const b = await ws.createPersona('b', a.id)
      const c = await ws.createPersona('c', b.id)
      for (const parent of [a.id, c.id]) {
        const res = await as('PATCH', `/personas/${a.id}`, { extendsId: parent })
        expect(res.status).toBe(400)
        expect(await errorOf(res)).toContain('成环')
      }
      const missing = await as('PATCH', `/personas/${a.id}`, {
        extendsId: '00000000-0000-4000-8000-000000000000',
      })
      expect(missing.status).toBe(404)
    })

    it('继承链最多 8 层：新建时按祖先算，改继承时连同继承它的人格一起算', async () => {
      let parent: string | undefined
      for (let i = 1; i <= 8; i++) parent = (await ws.createPersona(`p${i}`, parent)).id
      const ninth = await as('POST', '/personas', { slug: 'p9', name: 'p9', extendsId: parent })
      expect(ninth.status).toBe(400)

      // 两层的小树挂到第 7 层下面，最深的一条就是 9 层
      const root = await ws.createPersona('q1')
      await ws.createPersona('q2', root.id)
      const all = (await (await as('GET', '/personas')).json()) as PersonaInfo[]
      const seventh = all.find((p) => p.slug === 'p7')!.id
      const sixth = all.find((p) => p.slug === 'p6')!.id
      expect((await as('PATCH', `/personas/${root.id}`, { extendsId: seventh })).status).toBe(400)
      expect((await as('PATCH', `/personas/${root.id}`, { extendsId: sixth })).status).toBe(200)
    })

    it('继承没变时不重新检查层数：上限之前建出的更深的链照样能改名', async () => {
      let parent: string | null = null
      for (let i = 1; i <= 9; i++) {
        const [row] = await withCircle(database.db, ws.circleId, (tx) =>
          tx
            .insert(personas)
            .values({
              circleId: ws.circleId,
              slug: `old${i}`,
              name: `old${i}`,
              extendsId: parent,
            })
            .returning(),
        )
        parent = row!.id
      }
      const [deepest] = await withCircle(database.db, ws.circleId, (tx) =>
        tx.select().from(personas).where(eq(personas.slug, 'old9')),
      )
      const res = await as('PATCH', `/personas/${deepest!.id}`, {
        name: '改个名',
        extendsId: deepest!.extendsId,
      })
      expect(res.status).toBe(200)
    })

    it('读出之后被并发删除的人格，修改返回 404 而不是 500', async () => {
      const persona = await ws.createPersona('doubao')
      const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
      let pending: Promise<Response> | undefined
      try {
        await side.begin(async (tx) => {
          await tx`select set_config('app.read_circles', ${ws.circleId}, true)`
          await tx`select set_config('app.write_circles', ${ws.circleId}, true)`
          await tx`select id from personas where id = ${persona.id} for update`
          const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [
            { pid: number },
          ]
          pending = Promise.resolve(as('PATCH', `/personas/${persona.id}`, { name: '改名' }))
          for (let i = 0; ; i++) {
            const [row] = await side<{ n: number }[]>`
              select count(*)::int as n from pg_stat_activity
              where ${pid}::int = any(pg_blocking_pids(pid))`
            if (row!.n > 0) break
            if (i >= 80) throw new Error('修改没有等在人格的行锁上')
            await new Promise((r) => setTimeout(r, 25))
          }
          await tx`delete from personas where id = ${persona.id}`
        })
        expect((await pending!).status).toBe(404)
      } finally {
        await pending?.catch(() => {})
        await side.end()
      }
    })

    it('viewer 不能改、不能删人格与设定段', async () => {
      const persona = await ws.createPersona('doubao')
      const viewer = await addMember(database.db, ws.circleId, 'vic', 'viewer')
      expect(
        (await as('PATCH', `/personas/${persona.id}`, { name: '改名' }, viewer.cookie)).status,
      ).toBe(403)
      expect((await as('DELETE', `/personas/${persona.id}`, undefined, viewer.cookie)).status).toBe(
        403,
      )
      expect(
        (
          await as(
            'PUT',
            `/personas/${persona.id}/traits`,
            { traitKey: 'soul', title: '性格', content: '温柔' },
            viewer.cookie,
          )
        ).status,
      ).toBe(403)
    })

    it('有接入实例设为默认人格、按群规则使用、或被别的人格继承时删不掉', async () => {
      const used = await ws.createPersona('used')
      await ws.createClient('bot', { defaultPersonaId: used.id })

      const ruled = await ws.createPersona('ruled')
      const ruleBot = await ws.createClient('rule-bot')
      await withCircle(database.db, ws.circleId, async (tx) => {
        const [group] = await tx
          .insert(subjects)
          .values({ circleId: ws.circleId, kind: 'group', displayName: '测试群' })
          .returning({ id: subjects.id })
        await tx.insert(clientGroupRules).values({
          circleId: ws.circleId,
          clientId: ruleBot.id,
          groupSubjectId: group!.id,
          personaId: ruled.id,
        })
      })

      const inherited = await ws.createPersona('inherited')
      await ws.createPersona('heir', inherited.id)

      for (const [persona, reason] of [
        [used, '接入实例'],
        [ruled, '按群规则'],
        [inherited, '继承'],
      ] as const) {
        const res = await as('DELETE', `/personas/${persona.id}`)
        expect(res.status).toBe(409)
        expect(await errorOf(res)).toContain(reason)
      }

      const free = await ws.createPersona('free')
      expect((await as('DELETE', `/personas/${free.id}`)).status).toBe(204)
      const left = (await (await as('GET', '/personas')).json()) as PersonaInfo[]
      expect(left.map((p) => p.slug)).not.toContain('free')
      expect((await as('DELETE', `/personas/${free.id}`)).status).toBe(404)
    })

    it('详情列出继承链、自身与继承的设定段（标出覆盖者）与使用它的接入实例；设定段支持增改删', async () => {
      const root = await ws.createPersona('doubao')
      const mid = await ws.createPersona('doubao-group', root.id)
      const leaf = await ws.createPersona('doubao-night', mid.id)
      const sibling = await ws.createPersona('doubao-quiet', mid.id)
      const bot = await ws.createClient('night-bot', { defaultPersonaId: leaf.id })

      const putTrait = async (personaId: string, traitKey: string, content: string) => {
        const res = await as('PUT', `/personas/${personaId}/traits`, {
          traitKey,
          title: traitKey,
          content,
        })
        expect(res.status).toBe(200)
        return (await res.json()) as PersonaTrait
      }
      await putTrait(root.id, 'soul', '主人格')
      await putTrait(root.id, 'tone', '主人格的口吻')
      await putTrait(mid.id, 'soul', '群聊版')
      await putTrait(leaf.id, 'tone', '夜间版口吻')

      const res = await as('GET', `/personas/${leaf.id}`)
      expect(res.status).toBe(200)
      const detail = (await res.json()) as PersonaDetail
      expect(detail.ancestors.map((p) => p.slug)).toEqual(['doubao-group', 'doubao'])
      expect(detail.children).toEqual([])
      expect(detail.clients).toEqual([{ id: bot.id, slug: 'night-bot', name: 'night-bot' }])
      expect(detail.ownTraits.map((t) => [t.traitKey, t.overriddenBy])).toEqual([['tone', null]])
      expect(detail.inheritedTraits.map((t) => [t.personaId, t.traitKey, t.overriddenBy])).toEqual([
        [mid.id, 'soul', null],
        [root.id, 'soul', mid.id],
        [root.id, 'tone', leaf.id],
      ])

      // 删除子人格上的覆盖段，祖先同键设定恢复生效
      expect((await as('DELETE', `/personas/${leaf.id}/traits/tone`)).status).toBe(204)
      expect((await as('DELETE', `/personas/${leaf.id}/traits/tone`)).status).toBe(404)
      const afterDelete = (await (await as('GET', `/personas/${leaf.id}`)).json()) as PersonaDetail
      expect(afterDelete.ownTraits).toEqual([])
      expect(
        afterDelete.inheritedTraits.find((t) => t.personaId === root.id && t.traitKey === 'tone')
          ?.overriddenBy,
      ).toBeNull()

      const middle = (await (await as('GET', `/personas/${mid.id}`)).json()) as PersonaDetail
      expect(middle.children.map((p) => p.id).sort()).toEqual([leaf.id, sibling.id].sort())
    })
  })

  describe('接入实例', () => {
    it('删掉接入实例之后级联失效它的全部访问密钥；重复删除返回 404', async () => {
      const bot = await ws.createClient('bot')
      const key = await ws.issueKey(bot.id)
      const other = await ws.createClient('other')
      const otherKey = await ws.issueKey(other.id)
      expect((await app.request('/v1/whoami', { headers: bearer(otherKey) })).status).toBe(200)
      expect((await as('DELETE', `/clients/${other.id}`)).status).toBe(204)
      expect((await app.request('/v1/whoami', { headers: bearer(otherKey) })).status).toBe(401)
      expect((await app.request('/v1/whoami', { headers: bearer(key) })).status).toBe(200)
      expect((await as('DELETE', `/clients/${other.id}`)).status).toBe(404)
    })

    it('editor 不能改删别人的接入实例，owner 能删成员的，转让所有权立即吊销已有密钥', async () => {
      const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
      const mine = await ws.createClient('mine')
      expect((await as('DELETE', `/clients/${mine.id}`, undefined, editor.cookie)).status).toBe(403)
      const created = await as(
        'POST',
        '/clients',
        { slug: 'eve-bot', name: 'eve-bot', runtimeFamily: 'mcp' },
        editor.cookie,
      )
      expect(created.status).toBe(201)
      const eveClient = (await created.json()) as ClientInfo
      const keyRes = await as(
        'POST',
        `/clients/${eveClient.id}/keys`,
        {
          name: 'eve-k',
          scopes: { ...FULL_SCOPES, maxSensitivity: 'private', credentials: 'none' },
        },
        editor.cookie,
      )
      expect(keyRes.status).toBe(201)
      const eveKey = ((await keyRes.json()) as { key: string }).key
      expect((await app.request('/v1/whoami', { headers: bearer(eveKey) })).status).toBe(200)

      // 转让所有权不能同时夹带其他字段；转让后原有密钥作废
      expect(
        (
          await as('PATCH', `/clients/${eveClient.id}`, {
            ownerAccountId: ws.accountId,
            name: '顺便改名',
          })
        ).status,
      ).toBe(400)
      const transferred = await as('PATCH', `/clients/${eveClient.id}`, {
        ownerAccountId: ws.accountId,
      })
      expect(transferred.status).toBe(200)
      expect(((await transferred.json()) as ClientInfo).ownerAccountId).toBe(ws.accountId)
      expect((await app.request('/v1/whoami', { headers: bearer(eveKey) })).status).toBe(401)

      expect((await as('DELETE', `/clients/${eveClient.id}`)).status).toBe(204)
    })
  })

  it('成员列表给出名字与角色，只给本记忆圈的成员看', async () => {
    await addMember(database.db, ws.circleId, 'eve', 'editor')
    const res = await as('GET', '/members')
    expect(res.status).toBe(200)
    expect(
      ((await res.json()) as CircleMemberList).members.map((m) => [m.username, m.role]),
    ).toEqual([
      ['alice', 'owner'],
      ['eve', 'editor'],
    ])
    // 别的记忆圈的成员看不到
    const [other] = await database.db
      .insert(circles)
      .values({ slug: 'other-circle', name: '别处', kind: 'shared' })
      .returning()
    const stranger = await addMember(database.db, other!.id, 'oscar', 'owner')
    expect((await as('GET', '/members', undefined, stranger.cookie)).status).toBe(403)
  })

  describe('访问密钥与权限矩阵', () => {
    const keysOf = async (clientId: string, cookie = ws.cookie) =>
      (await (await as('GET', `/clients/${clientId}/keys`, undefined, cookie)).json()) as KeyInfo[]

    it('列表给出当前有效上限：主人被降级时收紧，吊销、轮换或主人离开后失效', async () => {
      const bot = await ws.createClient('bot')
      const revoked = await ws.issueKey(bot.id)
      const adminIssued = await ws.createKey(bot.id, { ...FULL_SCOPES, admin: true })
      const adminInfo = (await keysOf(bot.id)).find((k) => k.id === adminIssued.id)!
      expect(adminInfo.effectiveScopes).toEqual(adminInfo.scopes)

      await addMember(database.db, ws.circleId, 'olga', 'owner')
      await database.db
        .update(circleMembers)
        .set({ role: 'editor' })
        .where(
          and(eq(circleMembers.circleId, ws.circleId), eq(circleMembers.accountId, ws.accountId)),
        )
      const clamped = (await keysOf(bot.id)).find((k) => k.id === adminIssued.id)!
      expect(clamped.scopes).toMatchObject({ maxSensitivity: 'secret', admin: true })
      expect(clamped.effectiveScopes).toMatchObject({
        maxSensitivity: 'private',
        admin: false,
        credentials: 'none',
      })

      // 降级为 editor 后无法轮换带 admin/credentials 的旧密钥
      expect(
        (await as('POST', `/clients/${bot.id}/keys/${adminIssued.id}/rotate`, {})).status,
      ).toBe(403)

      // 被降级的主人仍能吊销自己接入实例的 Key
      const revoke = (await keysOf(bot.id)).find((k) => revoked.startsWith(`kioku_${k.prefix}_`))!
      expect((await as('DELETE', `/clients/${bot.id}/keys/${revoke.id}`)).status).toBe(204)
      const afterRevoke = (await keysOf(bot.id)).find((k) => k.id === revoke.id)!
      expect(afterRevoke.effectiveScopes).toBeNull()

      const olga = await addMember(database.db, ws.circleId, 'olga2', 'owner')
      await database.db
        .delete(circleMembers)
        .where(
          and(eq(circleMembers.circleId, ws.circleId), eq(circleMembers.accountId, ws.accountId)),
        )
      for (const key of await keysOf(bot.id, olga.cookie)) expect(key.effectiveScopes).toBeNull()
    })

    it('权限矩阵按会话上下文给出主场共享圈与关联个人圈各物种、各敏感级的读写能力', async () => {
      const persona = await ws.createPersona('doubao')
      const bot = await ws.createClient('bot', {
        defaultPersonaId: persona.id,
        config: { personMemoryMode: 'strict', elevateOwnerDirect: 'internal' },
      })
      const created = await as('POST', `/clients/${bot.id}/keys`, {
        name: 'with-personal',
        linkedCircles: [{ circleId: ws.personalCircleId, mode: 'read_write' }],
        scopes: FULL_SCOPES,
      })
      expect(created.status).toBe(201)
      const issued = (await created.json()) as { id: string }

      const res = await as('GET', `/clients/${bot.id}/keys/${issued.id}/matrix`)
      expect(res.status).toBe(200)
      const { contexts } = (await res.json()) as KeyAccessMatrix
      const cell = (
        context: string,
        circleId: string,
        kind: 'entry' | 'fact' | 'episode',
        sensitivity: string,
      ) =>
        contexts
          .find((c) => c.context === context)!
          .circles.find((g) => g.circleId === circleId)!
          .rows.find((r) => r.kind === kind)!
          .cells.find((c) => c.sensitivity === sensitivity)!

      expect(contexts.map((c) => [c.context, c.originScope])).toEqual([
        ['none', 'any'],
        ['direct', 'direct'],
        ['owner_direct', 'direct'],
        ['group', 'group'],
        ['cron', 'client'],
      ])
      // 关联个人圈私密可读写、public 亦可读写，但关联客场圈上限封顶在 private（读不到也写不了 secret）
      expect(cell('none', ws.personalCircleId, 'entry', 'private')).toMatchObject({
        read: 'recall',
        write: true,
      })
      expect(cell('none', ws.personalCircleId, 'entry', 'secret')).toMatchObject({
        read: 'none',
        write: false,
      })
      expect(cell('none', ws.personalCircleId, 'entry', 'public')).toMatchObject({
        read: 'recall',
        write: true,
      })
      // 主场圈可读写 secret
      expect(cell('none', ws.circleId, 'entry', 'secret')).toMatchObject({
        read: 'explicit',
        write: true,
      })
      // 主场共享圈
      expect(cell('group', ws.circleId, 'entry', 'public')).toMatchObject({
        read: 'recall',
        write: false,
      })
      expect(cell('group', ws.circleId, 'entry', 'internal').read).toBe('none')
      expect(cell('group', ws.circleId, 'fact', 'public')).toMatchObject({
        read: 'recall',
        write: true,
      })
      expect(cell('direct', ws.personalCircleId, 'entry', 'internal').read).toBe('none')
      // 开启「本人私聊读取内部记忆」：本人私聊可读内部记忆，私密仍然不可读
      expect(cell('owner_direct', ws.personalCircleId, 'entry', 'internal').read).toBe('recall')
      expect(cell('owner_direct', ws.personalCircleId, 'entry', 'private').read).toBe('none')
      expect(cell('cron', ws.circleId, 'entry', 'internal')).toMatchObject({
        read: 'recall',
        write: true,
      })
      expect(cell('cron', ws.personalCircleId, 'entry', 'internal')).toMatchObject({
        read: 'none',
        write: false,
      })
      expect(cell('cron', ws.personalCircleId, 'entry', 'private').read).toBe('none')

      // 直接在个人圈建接入实例时（主场为个人圈），secret 为显式可读且可写
      const pClient = await app.request(
        `/v1/circles/${ws.personalCircleId}/clients`,
        jsonRequest(
          'POST',
          { slug: 'p-bot', name: 'p-bot', runtimeFamily: 'mcp' },
          { cookie: ws.cookie },
        ),
      )
      expect(pClient.status).toBe(201)
      const pClientId = ((await pClient.json()) as { id: string }).id
      const pKeyRes = await app.request(
        `/v1/circles/${ws.personalCircleId}/clients/${pClientId}/keys`,
        jsonRequest('POST', { name: 'pk', scopes: FULL_SCOPES }, { cookie: ws.cookie }),
      )
      expect(pKeyRes.status).toBe(201)
      const pKeyId = ((await pKeyRes.json()) as { id: string }).id
      const pMatrix = (await (
        await app.request(
          `/v1/circles/${ws.personalCircleId}/clients/${pClientId}/keys/${pKeyId}/matrix`,
          { headers: { cookie: ws.cookie } },
        )
      ).json()) as KeyAccessMatrix
      const pSecretCell = pMatrix.contexts
        .find((c) => c.context === 'none')!
        .circles.find((g) => g.circleId === ws.personalCircleId)!
        .rows.find((r) => r.kind === 'entry')!
        .cells.find((c) => c.sensitivity === 'secret')!
      expect(pSecretCell).toMatchObject({ read: 'explicit', write: true })
    })

    it('矩阵只给接入实例主人与记忆圈 owner；作废的 Key 返回 404', async () => {
      const editor = await addMember(database.db, ws.circleId, 'eve', 'editor')
      const bot = await ws.createClient('bot')
      const issued = await ws.createKey(bot.id)
      const path = `/clients/${bot.id}/keys/${issued.id}/matrix`
      expect((await as('GET', path, undefined, editor.cookie)).status).toBe(403)
      // 不是主人时，不存在的 Key 也是 403：探不出 Key 在不在
      const made = `/clients/${bot.id}/keys/00000000-0000-4000-8000-000000000000/matrix`
      expect((await as('GET', made, undefined, editor.cookie)).status).toBe(403)
      expect(await errorOf(await as('GET', made))).toBe('访问密钥不存在')
      const noClient = `/clients/00000000-0000-4000-8000-000000000000/keys/${issued.id}/matrix`
      expect(await errorOf(await as('GET', noClient))).toBe('接入实例不存在')
      expect((await as('DELETE', `/clients/${bot.id}/keys/${issued.id}`)).status).toBe(204)
      expect((await as('GET', path)).status).toBe(404)
    })
  })
})
