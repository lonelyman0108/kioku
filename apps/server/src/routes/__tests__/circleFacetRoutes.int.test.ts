import { randomBytes } from 'node:crypto'

import type {
  ConsoleEntryView,
  CreatedCircle,
  EntryBrowseResponse,
  EntryView,
  FacetDimensionView,
  FacetTermView,
  FacetVocabularyView,
  IssuedKey,
  KeyAccessMatrix,
  PersonaDetail,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withCircle, type Database } from '../../db/client'
import { entries, entryVariants, subjects } from '../../db/schema'
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

describe.skipIf(!testDatabaseUrl)('记忆圈、多切片、切面、轮换与人物事实升级路由', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  const masterKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
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

  const asMember = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(
      path,
      body === undefined
        ? { method, headers: { 'sec-fetch-site': 'same-origin', cookie } }
        : jsonRequest(method, body, { cookie }),
    )

  const ok = async <T>(res: Response, status = 200): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status)
    return (await res.json()) as T
  }

  it('Key 读写多变体词条、按焦点过滤、分组浏览与跨共享圈迁移', async () => {
    const workCircle = await ok<CreatedCircle>(
      await asMember('POST', '/v1/circles', { name: '工作圈', slug: 'work-circle' }),
      201,
    )
    const client = await ws.createClient('agent-multi')
    const keyRes = await ok<IssuedKey>(
      await asMember('POST', `/v1/circles/${ws.circleId}/clients/${client.id}/keys`, {
        name: '多圈钥匙',
        linkedCircles: [{ circleId: workCircle.id, mode: 'read_write' }],
        contextFacets: { realm: ['work'] },
        scopes: FULL_SCOPES,
      }),
      201,
    )
    const key = keyRes.key

    // 创建单切片词条与多变体切片词条
    const single = await ok<EntryView>(
      await app.request(
        '/v1/entries',
        jsonRequest(
          'POST',
          {
            title: '部署脚本说明',
            content: '通用部署脚本入口在 scripts/deploy.sh',
            topics: ['ops'],
          },
          bearer(key),
        ),
      ),
      201,
    )
    expect(single.variants).toHaveLength(1)

    const multi = await ok<EntryView>(
      await app.request(
        '/v1/entries',
        jsonRequest(
          'POST',
          {
            title: '代理配置',
            topics: ['network'],
            variants: [
              { when: { realm: ['work'] }, content: '公司代理 127.0.0.1:7890', sortOrder: 0 },
              { when: { realm: ['home'] }, content: '家里直连不用代理', sortOrder: 1 },
            ],
          },
          bearer(key),
        ),
      ),
      201,
    )

    // 默认按钥匙上下文焦点 realm=work 过滤，并给出 otherVariants 提示
    const focused = await ok<EntryView>(
      await app.request(`/v1/entries?id=${multi.shortId}`, { headers: bearer(key) }),
    )
    expect(focused.variants).toHaveLength(1)
    expect(focused.variants[0]?.when).toEqual({ realm: ['work'] })
    expect(focused.variants[0]?.content).toBe('公司代理 127.0.0.1:7890')
    expect(focused.otherVariants.map((o) => o.when)).toEqual([{ realm: ['home'] }])

    // 显式传 allVariants=true 时返回全部可见切片
    const allView = await ok<EntryView>(
      await app.request(`/v1/entries?id=${multi.shortId}&allVariants=true`, {
        headers: bearer(key),
      }),
    )
    expect(allView.variants).toHaveLength(2)
    expect(allView.otherVariants).toEqual([])

    // 分组浏览索引
    const browse = await ok<EntryBrowseResponse>(
      await app.request('/v1/entries/browse?groupBy=topic', { headers: bearer(key) }),
    )
    const networkGroup = browse.groups.find((g) => g.key === 'network')
    expect(networkGroup?.items.find((i) => i.id === multi.id)?.variantCount).toBe(2)

    // upsertVariants 与 removeVariantWhens
    const upserted = await ok<EntryView>(
      await app.request(
        '/v1/entries',
        jsonRequest(
          'PATCH',
          {
            id: multi.shortId,
            upsertVariants: [
              { when: { realm: ['work'] }, content: '公司新代理 127.0.0.1:8899', sortOrder: 0 },
            ],
            removeVariantWhens: [{ realm: ['home'] }],
          },
          bearer(key),
        ),
      ),
    )
    expect(upserted.variants).toHaveLength(1)
    expect(upserted.variants[0]?.content).toBe('公司新代理 127.0.0.1:8899')

    // 机密词条禁止迁移，跨共享圈迁移非机密词条成功，迁入个人圈被拒
    const secretEntry = await ok<EntryView>(
      await app.request(
        '/v1/entries',
        jsonRequest(
          'POST',
          { title: '机密口令', content: 'top-secret', sensitivity: 'secret' },
          bearer(key),
        ),
      ),
      201,
    )
    const deniedSecretTransfer = await app.request(
      '/v1/entries/transfer',
      jsonRequest('POST', { id: secretEntry.shortId, toCircle: workCircle.slug }, bearer(key)),
    )
    expect(deniedSecretTransfer.status).toBeGreaterThanOrEqual(400)

    const personalDenied = await app.request(
      '/v1/entries/transfer',
      jsonRequest('POST', { id: single.shortId, toCircle: ws.personalCircleId }, bearer(key)),
    )
    expect(personalDenied.status).toBeGreaterThanOrEqual(400)

    const transferred = await ok<EntryView>(
      await app.request(
        '/v1/entries/transfer',
        jsonRequest('POST', { id: single.shortId, toCircle: workCircle.slug }, bearer(key)),
      ),
    )
    expect(transferred.circleId).toBe(workCircle.id)
    expect(transferred.circleSlug).toBe('work-circle')

    // 删除词条
    const delRes = await app.request(`/v1/entries?id=${transferred.shortId}`, {
      method: 'DELETE',
      headers: bearer(key),
    })
    expect(delRes.status).toBe(204)
  })

  it('切面维度与词条 CRUD、循环蕴含拦截与删除引用保护', async () => {
    const initial = await ok<FacetVocabularyView>(
      await asMember('GET', `/v1/circles/${ws.circleId}/facets`),
    )
    expect(initial.dimensions.length).toBeGreaterThanOrEqual(4)

    const mood = await ok<FacetDimensionView>(
      await asMember('POST', `/v1/circles/${ws.circleId}/facets/dimensions`, {
        key: 'mood',
        name: '心情',
        matchMode: 'additive',
      }),
      201,
    )
    expect(mood.key).toBe('mood')

    const updatedMood = await ok<FacetDimensionView>(
      await asMember('PATCH', `/v1/circles/${ws.circleId}/facets/dimensions/mood`, {
        name: '心境',
      }),
    )
    expect(updatedMood.name).toBe('心境')

    await ok<FacetDimensionView>(
      await asMember('POST', `/v1/circles/${ws.circleId}/facets/dimensions`, {
        key: 'style',
        name: '语气风格',
        matchMode: 'additive',
      }),
      201,
    )

    const focusTerm = await ok<FacetTermView>(
      await asMember('POST', `/v1/circles/${ws.circleId}/facets/terms`, {
        dimensionKey: 'mood',
        slug: 'focus',
        label: '专注',
      }),
      201,
    )
    const conciseTerm = await ok<FacetTermView>(
      await asMember('POST', `/v1/circles/${ws.circleId}/facets/terms`, {
        dimensionKey: 'style',
        slug: 'concise',
        label: '简洁',
        implies: { mood: ['focus'] },
      }),
      201,
    )

    // 循环蕴含（focus -> concise -> focus）返回 400
    const cycleRes = await asMember(
      'PATCH',
      `/v1/circles/${ws.circleId}/facets/terms/${focusTerm.id}`,
      { implies: { style: ['concise'] } },
    )
    expect(cycleRes.status).toBe(400)

    // 删除仍被 style 蕴含引用的 mood 维度返回 409
    const referencedDelete = await asMember(
      'DELETE',
      `/v1/circles/${ws.circleId}/facets/dimensions/mood`,
    )
    expect(referencedDelete.status).toBe(409)

    // 先删引用方词条，再删维度成功
    const delTerm = await asMember(
      'DELETE',
      `/v1/circles/${ws.circleId}/facets/terms/${conciseTerm.id}`,
    )
    expect(delTerm.status).toBe(204)

    const delDim = await asMember('DELETE', `/v1/circles/${ws.circleId}/facets/dimensions/mood`)
    expect(delDim.status).toBe(204)
  })

  it('访问密钥权限矩阵查询与同配置轮换', async () => {
    const secondCircle = await ok<CreatedCircle>(
      await asMember('POST', '/v1/circles', { name: '项目圈', slug: 'proj-circle' }),
      201,
    )
    const persona = await ws.createPersona('helper')
    const client = await ws.createClient('cli-client')
    const issued = await ok<IssuedKey>(
      await asMember('POST', `/v1/circles/${ws.circleId}/clients/${client.id}/keys`, {
        name: '工作密钥',
        linkedCircles: [{ circleId: secondCircle.id, mode: 'read' }],
        contextFacets: { realm: ['work'] },
        personaOverrideId: persona.id,
        scopes: FULL_SCOPES,
      }),
      201,
    )

    const matrix = await ok<KeyAccessMatrix>(
      await asMember(
        'GET',
        `/v1/circles/${ws.circleId}/clients/${client.id}/keys/${issued.id}/matrix`,
      ),
    )
    expect(matrix.contexts.length).toBeGreaterThan(0)
    const directCtx = matrix.contexts.find((ctx) => ctx.context === 'direct')
    expect(directCtx?.circles.some((c) => c.circleId === secondCircle.id && !c.isPrimary)).toBe(
      true,
    )

    const rotated = await ok<IssuedKey>(
      await asMember(
        'POST',
        `/v1/circles/${ws.circleId}/clients/${client.id}/keys/${issued.id}/rotate`,
        { name: '轮换后的工作密钥' },
      ),
      201,
    )
    expect(rotated.id).not.toBe(issued.id)
    expect(rotated.name).toBe('轮换后的工作密钥')
    expect(rotated.linkedCircles).toEqual([{ circleId: secondCircle.id, mode: 'read' }])
    expect(rotated.contextFacets).toEqual({ realm: ['work'] })
    expect(rotated.personaOverrideId).toBe(persona.id)

    // 旧密钥立即失效，新密钥可调用
    expect((await app.request('/v1/whoami', { headers: bearer(issued.key) })).status).toBe(401)
    expect((await app.request('/v1/whoami', { headers: bearer(rotated.key) })).status).toBe(200)
  })

  it('人格设定段初始创建、继承链与子人格覆盖及删除还原', async () => {
    const parent = await ok<{ id: string; slug: string }>(
      await asMember('POST', `/v1/circles/${ws.circleId}/personas`, {
        slug: 'base-mentor',
        name: '基础导师',
        extendsId: null,
        traits: [
          { traitKey: 'tone', title: '语气', content: '稳重礼貌', sortOrder: 0 },
          { traitKey: 'rule', title: '原则', content: '先给结论', sortOrder: 1 },
        ],
      }),
      201,
    )
    const child = await ws.createPersona('sharp-mentor', parent.id)

    await ok<PersonaDetail>(
      await asMember('PUT', `/v1/circles/${ws.circleId}/personas/${child.id}/traits`, {
        traitKey: 'tone',
        title: '语气覆盖',
        content: '直接锐利',
        sortOrder: 0,
      }),
    )

    const detail = await ok<PersonaDetail>(
      await asMember('GET', `/v1/circles/${ws.circleId}/personas/${child.id}`),
    )
    expect(detail.ownTraits.map((t) => t.traitKey)).toEqual(['tone'])
    const inheritedTone = detail.inheritedTraits.find((t) => t.traitKey === 'tone')
    const inheritedRule = detail.inheritedTraits.find((t) => t.traitKey === 'rule')
    expect(inheritedTone?.overriddenBy).toBe(child.id)
    expect(inheritedRule?.overriddenBy).toBeNull()

    const delTraitRes = await asMember(
      'DELETE',
      `/v1/circles/${ws.circleId}/personas/${child.id}/traits/tone`,
    )
    expect(delTraitRes.status).toBe(204)
    const restored = await ok<PersonaDetail>(
      await asMember('GET', `/v1/circles/${ws.circleId}/personas/${child.id}`),
    )
    expect(restored.ownTraits).toEqual([])
    expect(restored.inheritedTraits.find((t) => t.traitKey === 'tone')?.overriddenBy).toBeNull()
  })

  it('联系人待核实事实升级为正式词条并保留原事实不动', async () => {
    const factId = '11111111-1111-4111-8111-111111111111'
    const subjectId = '22222222-2222-4222-8222-222222222222'
    await withCircle(database.db, ws.circleId, async (tx) => {
      await tx.insert(subjects).values({
        id: subjectId,
        circleId: ws.circleId,
        kind: 'person',
        displayName: '林晓',
      })
      await tx.insert(entries).values({
        id: factId,
        circleId: ws.circleId,
        circleKind: 'shared',
        shortId: 'm-345678',
        kind: 'fact',
        title: '茶饮偏好',
        sensitivity: 'public',
        provenance: 'untrusted',
        originScope: `subject:${subjectId}`,
        subjectId,
        subjectKind: 'person',
      })
      await tx.insert(entryVariants).values({
        circleId: ws.circleId,
        entryId: factId,
        sensitivity: 'public',
        kind: 'fact',
        content: '林晓平时喜欢喝乌龙茶',
      })
    })

    const viewer = await addMember(database.db, ws.circleId, 'viewer-bob', 'viewer')
    const denied = await asMember(
      'POST',
      `/v1/circles/${ws.circleId}/subjects/${subjectId}/facts/${factId}/promote`,
      { targetCircleId: ws.circleId, title: '饮茶习惯' },
      viewer.cookie,
    )
    expect(denied.status).toBe(403)

    const promoted = await ok<ConsoleEntryView>(
      await asMember(
        'POST',
        `/v1/circles/${ws.circleId}/subjects/${subjectId}/facts/${factId}/promote`,
        {
          targetCircleId: ws.circleId,
          sensitivity: 'internal',
          title: '饮茶习惯',
          content: '林晓常喝乌龙茶（出处 [[m-345678]]）',
          topics: ['preference'],
        },
      ),
      201,
    )
    expect(promoted.kind).toBe('entry')
    expect(promoted.title).toBe('饮茶习惯')

    // 原事实保持完好存在
    const [originalFact] = await withCircle(database.db, ws.circleId, (tx) =>
      tx.select().from(entries).where(eq(entries.id, factId)),
    )
    expect(originalFact?.kind).toBe('fact')
    expect(originalFact?.deletedAt).toBeNull()
  })
})
