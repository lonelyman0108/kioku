import { randomBytes } from 'node:crypto'

import type {
  AppAdvancedView,
  AppInfo,
  BootPreview,
  BootResponse,
  InstanceAdvancedView,
  KeyInfo,
  LifecycleResponse,
  RecallDebug,
  RecallResponse,
  SpaceAdvancedView,
} from '@kioku/contracts'
import { TUNING_DEFAULTS } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { principalForKeyId } from '../../auth/middleware'
import { inProcessExecutor } from '../../bench/inProcess'
import { inRollback } from '../../bench/rollback'
import { withSpace, type Database } from '../../db/client'
import { apps, settings, spaceMembers } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps } from '../../http/env'
import { GUIDANCE } from '../../lifecycle/lifecycle'
import { recallScopeForKey } from '../../memory/context'
import { saveAppAdvanced } from '../../settings/advanced'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  addMember,
  bearer,
  bootstrap,
  FULL_SCOPES,
  jsonRequest,
  type Workspace,
} from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('高级设置', () => {
  let database: Database
  let deps: Deps
  let app: ReturnType<typeof createApp>
  let ws: Workspace

  beforeAll(async () => {
    database = await openTestDatabase()
    deps = {
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
    }
    app = createApp(deps)
  })
  afterAll(async () => {
    await database?.db.delete(settings).where(eq(settings.key, 'advanced'))
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings).where(eq(settings.key, 'advanced'))
    ws = await bootstrap(app)
  })

  const send = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(
      `/v1${path}`,
      body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )
  const json = async <T>(res: Response, status = 200): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status)
    return (await res.json()) as T
  }
  const spacePath = () => `/spaces/${ws.spaceId}/settings/advanced`
  const appPath = (appId: string) => `/spaces/${ws.spaceId}/apps/${appId}/settings/advanced`
  const remember = async (body: Record<string, unknown>) => {
    const res = await send('POST', `/spaces/${ws.spaceId}/memories`, body)
    expect(res.status, await res.clone().text()).toBe(201)
  }
  const keyIdOf = async (appId: string) =>
    (await json<KeyInfo[]>(await send('GET', `/spaces/${ws.spaceId}/apps/${appId}/keys`)))[0]!.id

  describe('权限', () => {
    it('实例级只给实例管理员', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'owner')
      expect((await send('GET', '/settings/advanced', undefined, bob.cookie)).status).toBe(403)
      expect(
        (await send('PUT', '/settings/advanced', { 'recall.limit': 3 }, bob.cookie)).status,
      ).toBe(403)
      await json(await send('PUT', '/settings/advanced', { 'recall.limit': 3 }))
    })

    it('空间级：成员都能看，只有空间所有者能改；不是成员的看不到', async () => {
      const viewer = await addMember(database.db, ws.spaceId, 'vic', 'viewer')
      const editor = await addMember(database.db, ws.spaceId, 'eve', 'editor')
      const view = await json<SpaceAdvancedView>(
        await send('GET', spacePath(), undefined, viewer.cookie),
      )
      expect(view.canEdit).toBe(false)
      for (const member of [viewer, editor]) {
        const res = await send('PUT', spacePath(), { 'recall.limit': 3 }, member.cookie)
        expect(res.status).toBe(403)
      }
      const stranger = await addMember(database.db, ws.spaceId, 'sam', 'viewer')
      await database.db.delete(spaceMembers).where(eq(spaceMembers.accountId, stranger.accountId))
      expect((await send('GET', spacePath(), undefined, stranger.cookie)).status).toBe(403)
      const saved = await json<SpaceAdvancedView>(
        await send('PUT', spacePath(), { 'recall.limit': 3 }),
      )
      expect(saved).toMatchObject({ canEdit: true, overrides: { 'recall.limit': 3 } })
    })

    it('应用级：应用所有者能看能改；空间所有者只能看；别的成员看不到', async () => {
      const bob = await addMember(database.db, ws.spaceId, 'bob', 'editor')
      const carol = await addMember(database.db, ws.spaceId, 'carol', 'editor')
      const created = await json<AppInfo>(
        await send(
          'POST',
          `/spaces/${ws.spaceId}/apps`,
          { slug: 'bob-app', name: 'bob 的应用', runtimeFamily: 'mcp' },
          bob.cookie,
        ),
        201,
      )
      const own = await json<AppAdvancedView>(
        await send('GET', appPath(created.id), undefined, bob.cookie),
      )
      expect(own.canEdit).toBe(true)
      const asOwner = await json<AppAdvancedView>(await send('GET', appPath(created.id)))
      expect(asOwner.canEdit).toBe(false)
      expect((await send('GET', appPath(created.id), undefined, carol.cookie)).status).toBe(403)
      expect((await send('PUT', appPath(created.id), { 'recall.limit': 2 })).status).toBe(403)
      expect(
        (await send('PUT', appPath(created.id), { 'recall.limit': 2 }, carol.cookie)).status,
      ).toBe(403)
      await json(await send('PUT', appPath(created.id), { 'recall.limit': 2 }, bob.cookie))
      expect((await send('GET', appPath(crypto.randomUUID()))).status).toBe(404)
    })
  })

  it('逐级覆盖与来源、恢复，实例上的覆盖计数，空间里有覆盖的应用', async () => {
    const appId = (await ws.createApp('codex', { runtimeFamily: 'codex' })).id
    await ws.createApp('plain')
    await json(
      await send('PUT', '/settings/advanced', {
        'recall.minScore': 0.3,
        'recallWeights.semantic': 0.5,
        'prompts.extractionRules': '实例的抽取规则',
      }),
    )
    await json(await send('PUT', spacePath(), { 'recall.minScore': 0.25, 'dream.maxCalls': 5 }))
    await json(
      await send('PUT', appPath(appId), {
        'recall.minScore': 0.4,
        'prompts.guidance': '应用的指引',
      }),
    )

    const space = await json<SpaceAdvancedView>(await send('GET', spacePath()))
    expect(space.effective['recall.minScore']).toBe(0.25)
    expect(space.sources).toMatchObject({
      'recall.minScore': 'space',
      'recallWeights.semantic': 'instance',
      'dream.maxCalls': 'space',
      'recall.limit': 'builtin',
    })
    expect(space.instance['recall.minScore']).toBe(0.3)
    expect(space.instancePrompts['prompts.extractionRules']).toBe('实例的抽取规则')
    expect(space.apps).toEqual([
      { id: appId, name: 'codex', overrides: { 'recall.minScore': 0.4 }, hasGuidance: true },
    ])

    const appView = await json<AppAdvancedView>(await send('GET', appPath(appId)))
    expect(appView).toMatchObject({
      overrides: { 'recall.minScore': 0.4, 'prompts.guidance': '应用的指引' },
      effective: { 'recall.minScore': 0.4, 'dream.maxCalls': 5 },
      sources: { 'recall.minScore': 'app', 'dream.maxCalls': 'space' },
      inherited: { 'recall.minScore': 0.25 },
      guidance: { kind: 'agent', fixed: GUIDANCE, instance: null },
    })

    const instance = await json<InstanceAdvancedView>(await send('GET', '/settings/advanced'))
    expect(instance.builtin).toEqual(TUNING_DEFAULTS)
    expect(instance.effective['recall.minScore']).toBe(0.3)
    expect(instance.overriddenBy['recall.minScore']).toEqual({ spaces: 1, apps: 1 })
    expect(instance.overriddenBy['dream.maxCalls']).toEqual({ spaces: 1, apps: 0 })
    expect(instance.overriddenBy['recall.limit']).toEqual({ spaces: 0, apps: 0 })
    expect(instance.fixedPrompts['prompts.agentGuidance']).toEqual([GUIDANCE])
    // 再改一项：并进已有的覆盖，不替换整份
    const again = await json<InstanceAdvancedView>(
      await send('PUT', '/settings/advanced', {
        'recall.limit': 6,
        'recallWeights.semantic': null,
      }),
    )
    expect(again.overrides).toEqual({
      'recall.minScore': 0.3,
      'recall.limit': 6,
      'prompts.extractionRules': '实例的抽取规则',
    })

    // null 恢复：空间的去掉了沿用实例，应用的去掉了沿用空间；只改给了的项
    const restored = await json<SpaceAdvancedView>(
      await send('PUT', spacePath(), { 'recall.minScore': null }),
    )
    expect(restored.overrides).toEqual({ 'dream.maxCalls': 5 })
    expect(restored.sources['recall.minScore']).toBe('instance')
    const appRestored = await json<AppAdvancedView>(
      await send('PUT', appPath(appId), { 'recall.minScore': null, 'prompts.guidance': '  ' }),
    )
    expect(appRestored.overrides).toEqual({})
    expect(appRestored.sources['recall.minScore']).toBe('instance')
    expect((await json<SpaceAdvancedView>(await send('GET', spacePath()))).apps).toEqual([])
  })

  it('取值不对、各级不能覆盖的项回 400', async () => {
    const appId = (await ws.createApp('codex')).id
    for (const [path, body] of [
      ['/settings/advanced', { 'recall.limit': 21 }],
      ['/settings/advanced', { 'recall.minScore': 0.255 }],
      ['/settings/advanced', { 'prompts.agentGuidance': '字'.repeat(2001) }],
      ['/settings/advanced', { 'prompts.agentGuidance': 'a\u0000b' }],
      [spacePath(), { 'recallWeights.semantic': 0.5 }],
      [spacePath(), { 'prompts.agentGuidance': '补充' }],
      [appPath(appId), { 'extraction.batchTurns': 3 }],
      [appPath(appId), { 'dream.maxSuggestions': 3 }],
    ] as const) {
      expect((await send('PUT', path, body)).status, `${path} ${JSON.stringify(body)}`).toBe(400)
    }
  })

  it('修改应用的配置时，应用的高级设置原样留着，也不随应用信息交出去', async () => {
    const appId = (await ws.createApp('codex')).id
    await json(await send('PUT', appPath(appId), { 'recall.limit': 2 }))
    const updated = await json<AppInfo>(
      await send('PATCH', `/spaces/${ws.spaceId}/apps/${appId}`, {
        config: { recordPrompt: false },
      }),
    )
    expect(updated.config).toEqual({ recordPrompt: false })
    const view = await json<AppAdvancedView>(await send('GET', appPath(appId)))
    expect(view.overrides).toEqual({ 'recall.limit': 2 })
    const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select({ config: apps.config }).from(apps).where(eq(apps.id, appId)),
    )
    expect(row!.config).toEqual({ recordPrompt: false, advanced: { 'recall.limit': 2 } })
  })

  describe('访问密钥的请求按设置', () => {
    let appId: string
    let key: string
    const lifecycle = async (body: Record<string, unknown>) =>
      json<LifecycleResponse>(
        await app.request('/v1/lifecycle/event', jsonRequest('POST', body, bearer(key))),
      )
    const contextOf = (res: LifecycleResponse) =>
      (res.hostOutput.value as { context: string }).context

    beforeEach(async () => {
      appId = (await ws.createApp('agent')).id
      key = await ws.issueKey(appId, { ...FULL_SCOPES, credentials: 'none' })
      for (const name of ['a', 'b', 'c']) {
        await remember({
          uri: `core://reply/${name}`,
          content: `回复规则${name}`,
          glossary: ['回复'],
        })
      }
    })

    it('每轮召回的条数与最低分；/recall 显式给的条数照旧优先', async () => {
      const submit = () => lifecycle({ event: 'prompt.submit', prompt: '怎么回复' })
      expect((await submit()).nodeUris).toHaveLength(3)
      await json(await send('PUT', spacePath(), { 'recall.limit': 2 }))
      expect((await submit()).nodeUris).toHaveLength(2)
      await json(await send('PUT', appPath(appId), { 'recall.limit': 1 }))
      expect((await submit()).nodeUris).toHaveLength(1)

      const recall = async (body: Record<string, unknown>) =>
        json<RecallResponse>(
          await app.request(
            '/v1/recall',
            jsonRequest('POST', { query: '怎么回复', ...body }, bearer(key)),
          ),
        )
      expect((await recall({})).candidates).toHaveLength(1)
      expect((await recall({ limit: 3 })).candidates).toHaveLength(3)

      // 关键词命中一个约 0.3 分：最低分抬到它之上就都不注入
      await json(await send('PUT', '/settings/advanced', { 'recall.minScore': 0.9 }))
      expect((await submit()).nodeUris).toEqual([])
      expect((await recall({ limit: 3 })).candidates).toEqual([])
    })

    it('启动加载的字数预算、附带内容的开关与补充；启动预览与真实路径一致', async () => {
      await remember({ uri: 'core://long', content: '长'.repeat(2500), priority: 0 })
      await remember({ uri: 'core://short', content: '短', priority: 0 })
      const boot = async () =>
        json<BootResponse>(await app.request('/v1/boot', { headers: bearer(key) }))
      expect((await boot()).omitted).toEqual([])
      await json(await send('PUT', spacePath(), { 'boot.charBudget': 2000 }))
      const limited = await boot()
      expect(limited.omitted).toEqual(['core://long'])
      expect(limited.entries.map((e) => e.uri)).toEqual(['core://short'])

      await json(
        await send('PUT', '/settings/advanced', { 'prompts.agentGuidance': '实例补充：先读正文' }),
      )
      await json(
        await send('PUT', appPath(appId), {
          'prompts.guidance': '应用补充：只回中文',
          'boot.recent.enabled': false,
        }),
      )
      const start = await lifecycle({ event: 'session.start' })
      const context = contextOf(start)
      expect(context.startsWith(`${GUIDANCE}\n实例补充：先读正文\n应用补充：只回中文\n\n`)).toBe(
        true,
      )
      expect(context).not.toContain('最近更新')

      const keyId = await keyIdOf(appId)
      const preview = await json<BootPreview>(
        await send('POST', `/spaces/${ws.spaceId}/apps/${appId}/keys/${keyId}/preview`, {}),
      )
      expect(preview.context).toBe(context)
      expect(preview.recent).toEqual([])
      expect(preview.omitted.map((o) => o.uri)).toEqual(['core://long'])

      // 近期记忆打开之后才有
      await json(await send('PUT', appPath(appId), { 'boot.recent.enabled': null }))
      const reopened = await json<BootPreview>(
        await send('POST', `/spaces/${ws.spaceId}/apps/${appId}/keys/${keyId}/preview`, {}),
      )
      expect(reopened.recent.length).toBeGreaterThan(0)
    })

    it('召回调试：按生效的设置模拟，带最低分与条数时按给的试算，低于最低分的列在没注入的里', async () => {
      await json(await send('PUT', appPath(appId), { 'recall.limit': 2, 'recall.minScore': 0.25 }))
      const keyId = await keyIdOf(appId)
      const debug = async (body: Record<string, unknown>) =>
        json<RecallDebug>(
          await send('POST', `/spaces/${ws.spaceId}/apps/${appId}/keys/${keyId}/debug`, {
            query: '怎么回复',
            ...body,
          }),
        )
      const actual = await debug({})
      expect(actual).toMatchObject({ minScore: 0.25, limit: 2 })
      expect(actual.injected).toHaveLength(2)
      expect(actual.others).toHaveLength(1)
      // 未取整的分数：取整后就是 score，注入的都不低于最低分
      for (const c of [...actual.injected, ...actual.others]) {
        expect(Math.round(c.rawScore * 100) / 100).toBe(c.score)
      }
      for (const c of actual.injected) expect(c.rawScore).toBeGreaterThanOrEqual(0.25)

      const strict = await debug({ minScore: 0.9, limit: 3 })
      expect(strict).toMatchObject({ minScore: 0.9, limit: 3, injected: [], block: '' })
      expect(strict.others).toHaveLength(3)
      for (const c of strict.others) expect(c.score).toBeLessThan(0.9)

      const invalid = await send(
        'POST',
        `/spaces/${ws.spaceId}/apps/${appId}/keys/${keyId}/debug`,
        {
          query: '怎么回复',
          minScore: 1.5,
        },
      )
      expect(invalid.status).toBe(400)
    })

    it('测试台的回滚模式下读的是同一个事务里的设置，回滚之后不留下', async () => {
      const keyId = await keyIdOf(appId)
      const principal = (await principalForKeyId(database.db, keyId))!
      const nodeUris = await inRollback(
        deps,
        { model: null, vectors: new Map() },
        async (scoped, run) => {
          await withSpace(scoped.db, ws.spaceId, (tx) =>
            saveAppAdvanced(tx, appId, { 'recall.limit': 1 }),
          )
          expect(
            (await recallScopeForKey(scoped, principal).settings()).values['recall.limit'],
          ).toBe(1)
          const executor = inProcessExecutor(scoped, principal, {
            run: 'r1',
            account: ws.accountId,
            rollback: run,
          })
          const outcome = await executor.execute({
            kind: 'lifecycle',
            body: { event: 'prompt.submit', prompt: '怎么回复' },
          })
          return (outcome.raw as LifecycleResponse).nodeUris
        },
      )
      expect(nodeUris).toHaveLength(1)
      const view = await json<AppAdvancedView>(await send('GET', appPath(appId)))
      expect(view.overrides).toEqual({})
    })
  })
})
