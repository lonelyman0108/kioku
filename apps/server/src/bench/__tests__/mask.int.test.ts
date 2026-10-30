import { randomBytes, randomUUID } from 'node:crypto'

import type {
  ActivityList,
  ConsoleCredential,
  CredentialEventList,
  CredentialProvider,
} from '@kioku/contracts'
import { and, asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { defaultSession } from '../../access/session'
import { keyToSimulate } from '../../access/simulate'
import { credentialServiceForKey } from '../../credential/context'
import { withSpace, type Database } from '../../db/client'
import { credentialEvents, memories, memoryEvents } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps, KeyPrincipal } from '../../http/env'
import { handleMcpRequest } from '../../mcp/server'
import { memoryServiceForKey, recallScopeForKey } from '../../memory/context'
import { sealMemoryContent } from '../../memory/service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

const SECRET_BODY = '保险柜的位置在书房第三层'
const HOSTED_VALUE = 'hunter2-hosted-value'
const LOCATION = 'router admin login'
const INSTRUCTIONS = '在工作站上用 bw，先 bw unlock'

describe.skipIf(!testDatabaseUrl)('打码：secret 正文与凭据值不出服务', () => {
  let database: Database
  let deps: Deps
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let plainKey: string
  let key: KeyPrincipal
  const masterKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
    deps = {
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    }
    app = createApp(deps)
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    const appId = (await ws.createApp('agent', { runtimeFamily: 'claudecode' })).id
    const created = await ws.createKey(appId)
    plainKey = created.key
    const found = await keyToSimulate(
      deps,
      { spaceId: ws.spaceId, appId, keyId: created.id },
      ws.accountId,
    )
    if ('error' in found) throw new Error(found.error)
    key = found.key
  })

  let id = 0
  const rpc = (name: string, args: Record<string, unknown>) =>
    new Request('http://bench.invalid/v1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
  const parse = async (res: Response) => {
    const body = (await res.json()) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    return { text: body.result.content[0]!.text, isError: body.result.isError === true }
  }
  // 测试台的调用：打码、事件带标记。mask 是凭据的那一档：回滚模式 all，真实模式 hosted
  const mark = () => ({ bench: { account: ws.accountId, run: 'run-1' } })
  const masked = (
    name: string,
    args: Record<string, unknown> = {},
    mask: 'hosted' | 'all' = 'all',
  ) =>
    handleMcpRequest(
      memoryServiceForKey(deps, key, defaultSession(key), {
        maskSecret: true,
        eventContext: mark(),
      }),
      recallScopeForKey(deps, key),
      credentialServiceForKey(deps, key, defaultSession(key), { mask, eventContext: mark() }),
      rpc(name, args),
    ).then(parse)
  // 真实的 /v1/mcp：对照，也用来核对数据没有被打码的文字写坏
  const real = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: {
        ...bearer(plainKey),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    return parse(res)
  }
  const seedSecret = async (uri = 'notes://safe') => {
    const created = await real('kioku_create', { uri, content: SECRET_BODY, sensitivity: 'secret' })
    expect(created.isError).toBe(false)
    expect(created.text).toContain(SECRET_BODY)
  }
  const realBody = async (uri = 'notes://safe') => (await real('kioku_get', { uri })).text

  describe('记忆', () => {
    it('kioku_get：不给 secret 的正文，真实接口照常给', async () => {
      await seedSecret()
      const got = await masked('kioku_get', { uri: 'notes://safe' })
      expect(got.isError).toBe(false)
      expect(got.text).toContain('敏感级: secret')
      expect(got.text).toContain('secret 正文需要显式读取权限')
      expect(got.text).not.toContain(SECRET_BODY)
      expect(await realBody()).toContain(SECRET_BODY)
    })

    it('kioku_list 的父节点：不给 secret 的正文', async () => {
      await seedSecret()
      await real('kioku_create', { uri: 'notes://safe/child', content: '子节点' })
      const listed = await masked('kioku_list', { of: 'notes://safe' })
      expect(listed.text).toContain('notes://safe/child')
      expect(listed.text).not.toContain(SECRET_BODY)
      expect((await real('kioku_list', { of: 'notes://safe' })).text).toContain(SECRET_BODY)
    })

    it('kioku_move：结果不带正文，正文还在', async () => {
      await seedSecret()
      const moved = await masked('kioku_move', { from: 'notes://safe', to: 'notes://moved' })
      expect(moved.isError).toBe(false)
      expect(moved.text).toContain('URI: notes://moved')
      expect(moved.text).not.toContain(SECRET_BODY)
      expect(await realBody('notes://moved')).toContain(SECRET_BODY)
    })

    it('只改 priority 的 kioku_update：结果不带正文，封存回去的还是原文，不是占位文字', async () => {
      await seedSecret()
      const updated = await masked('kioku_update', { uri: 'notes://safe', priority: 7 })
      expect(updated.isError).toBe(false)
      expect(updated.text).toContain('priority: 7')
      expect(updated.text).not.toContain(SECRET_BODY)
      const after = await realBody()
      expect(after).toContain('priority: 7')
      expect(after).toContain(SECRET_BODY)
    })

    it('secret 级的 kioku_create：结果不带正文，存下的是传入的原文', async () => {
      const created = await masked('kioku_create', {
        uri: 'notes://new-safe',
        content: SECRET_BODY,
        sensitivity: 'secret',
      })
      expect(created.isError).toBe(false)
      expect(created.text).toContain('敏感级: secret')
      expect(created.text).not.toContain(SECRET_BODY)
      expect(await realBody('notes://new-safe')).toContain(SECRET_BODY)
    })

    it('把 secret 改成别的敏感级被拒绝：结果与之后读到的都没有明文，敏感级不变', async () => {
      await seedSecret()
      const downgraded = await masked('kioku_update', {
        uri: 'notes://safe',
        sensitivity: 'private',
      })
      expect(downgraded.isError).toBe(true)
      expect(downgraded.text).toContain('记忆页')
      expect(downgraded.text).not.toContain(SECRET_BODY)
      const got = await masked('kioku_get', { uri: 'notes://safe' })
      expect(got.text).toContain('敏感级: secret')
      expect(got.text).not.toContain(SECRET_BODY)
      expect(await realBody()).toContain('敏感级: secret')
    })

    it('改 secret 的正文被拒绝：读不到原文，写回占位文字会永久覆盖', async () => {
      await seedSecret()
      const placeholder = (await masked('kioku_get', { uri: 'notes://safe' })).text
      const rewritten = await masked('kioku_update', { uri: 'notes://safe', content: placeholder })
      expect(rewritten.isError).toBe(true)
      expect(rewritten.text).toContain('记忆页')
      expect(await realBody()).toContain(SECRET_BODY)
      // 带着 secret 不变的敏感级一起改也一样
      const same = await masked('kioku_update', {
        uri: 'notes://safe',
        content: '新正文',
        sensitivity: 'secret',
      })
      expect(same.isError).toBe(true)
      expect(await realBody()).toContain(SECRET_BODY)
    })

    it('真实接口不受影响：照常能改 secret 的正文与敏感级', async () => {
      await seedSecret()
      const rewritten = await real('kioku_update', { uri: 'notes://safe', content: '新正文' })
      expect(rewritten.isError).toBe(false)
      const downgraded = await real('kioku_update', { uri: 'notes://safe', sensitivity: 'private' })
      expect(downgraded.isError).toBe(false)
      expect(downgraded.text).toContain('新正文')
    })

    it('改成 secret 可以，结果不带正文', async () => {
      await real('kioku_create', { uri: 'notes://plain', content: '普通正文' })
      const raised = await masked('kioku_update', { uri: 'notes://plain', sensitivity: 'secret' })
      expect(raised.isError).toBe(false)
      expect(raised.text).not.toContain('普通正文')
      expect(await realBody('notes://plain')).toContain('普通正文')
    })

    it('占位符格式不对的旧数据：解密后的片段不进报错', async () => {
      await seedSecret()
      const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(memories).where(eq(memories.path, 'safe')),
      )
      const legacy = sealMemoryContent(masterKey, row!.id, '旧数据 {{cred:坏的片段')
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx.update(memories).set(legacy).where(eq(memories.id, row!.id)),
      )
      const updated = await masked('kioku_update', { uri: 'notes://safe', priority: 5 })
      expect(updated.isError).toBe(true)
      expect(updated.text).toContain('占位符格式不对')
      expect(updated.text).not.toContain('坏的片段')
      expect((await real('kioku_update', { uri: 'notes://safe', priority: 5 })).text).toContain(
        '坏的片段',
      )
    })
  })

  describe('凭据', () => {
    const accessEvents = (credentialId: string) =>
      withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .select()
          .from(credentialEvents)
          .where(
            and(
              eq(credentialEvents.credentialId, credentialId),
              eq(credentialEvents.eventType, 'access'),
            ),
          ),
      )
    const asOwner = async <T>(method: string, path: string, body?: unknown) => {
      const res = await app.request(
        `/v1/spaces/${ws.spaceId}${path}`,
        jsonRequest(method, body, { cookie: ws.cookie }),
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      return (await res.json()) as T
    }
    const seedHosted = () =>
      asOwner<ConsoleCredential>('POST', '/credentials', {
        identifier: 'nas',
        name: 'NAS',
        source: { kind: 'hosted', values: { username: 'alice', password: HOSTED_VALUE } },
      })
    const seedExternal = async () => {
      const provider = await asOwner<CredentialProvider>('POST', '/credential-providers', {
        kind: 'bitwarden',
        name: '密码库',
        instructions: INSTRUCTIONS,
      })
      return asOwner<ConsoleCredential>('POST', '/credentials', {
        identifier: 'router',
        name: '路由器',
        source: {
          kind: 'external',
          providerId: provider.id,
          location: LOCATION,
          fields: [{ name: 'password', sourceField: 'password' }],
        },
      })
    }

    it.each(['hosted', 'all'] as const)(
      '取托管的值（%s）：不解密、不记访问，只列字段名',
      async (mask) => {
        const credential = await seedHosted()
        const got = await masked('kioku_credential', { identifier: 'nas' }, mask)
        expect(got.isError).toBe(false)
        expect(got.text).not.toContain(HOSTED_VALUE)
        expect(got.text).toContain('password、username')
        expect(await accessEvents(credential.id)).toHaveLength(0)
        // 只取一个字段时只列这个字段
        const one = await masked('kioku_credential', { identifier: 'nas', field: 'password' }, mask)
        expect(one.text).toContain('字段：password。')
        // 真实接口照常给值、记访问
        expect((await real('kioku_credential', { identifier: 'nas' })).text).toContain(HOSTED_VALUE)
        expect(await accessEvents(credential.id)).toHaveLength(1)
      },
    )

    it('外部绑定，回滚模式：条目位置、取法与使用说明都换成占位文字，也不记访问', async () => {
      const credential = await seedExternal()
      const got = await masked('kioku_credential', { identifier: 'router' }, 'all')
      expect(got.isError).toBe(false)
      expect(got.text).toContain('密码库')
      for (const hidden of [LOCATION, INSTRUCTIONS, 'bw get item']) {
        expect(got.text).not.toContain(hidden)
      }
      expect(await accessEvents(credential.id)).toHaveLength(0)
    })

    it('外部绑定，真实模式：照常返回，访问记录带标记，凭据页的访问记录显示操作的账号', async () => {
      const credential = await seedExternal()
      const got = await masked('kioku_credential', { identifier: 'router' }, 'hosted')
      expect(got.text).toContain(LOCATION)
      expect(got.text).toContain(INSTRUCTIONS)
      expect(got.text).toContain('bw get item')
      const [event] = await accessEvents(credential.id)
      expect(event!.context).toEqual({
        bench: { account: ws.accountId, run: 'run-1' },
        via: 'kioku_credential',
        fields: ['password'],
      })
      const listed = await asOwner<CredentialEventList>(
        'GET',
        `/credentials/${credential.id}/events`,
      )
      const access = listed.items.find((e) => e.type === 'access')!
      expect(access.bench).toEqual({ accountName: 'alice', run: 'run-1' })
      expect(access.via).toBe('kioku_credential')
      // 新建这条凭据的是管理界面，不带标记
      expect(listed.items.find((e) => e.type === 'create')!.bench).toBeNull()
    })

    it.each([
      ['all', false],
      ['hosted', true],
    ] as const)(
      'kioku_get 末尾的凭据列表（%s）：外部绑定按模式打码，托管的值不给',
      async (mask, shown) => {
        const external = await seedExternal()
        const hosted = await seedHosted()
        await real('kioku_create', {
          uri: 'notes://login',
          content: '路由器 {{cred:router#password}}，NAS {{cred:nas#password}}',
          layer: 'private',
        })
        const got = await masked('kioku_get', { uri: 'notes://login' }, mask)
        expect(got.text).toContain('正文里引用的凭据')
        expect(got.text).not.toContain(HOSTED_VALUE)
        for (const text of [LOCATION, INSTRUCTIONS, 'bw get item']) {
          expect(got.text.includes(text)).toBe(shown)
        }
        expect(await accessEvents(external.id)).toHaveLength(shown ? 1 : 0)
        expect(await accessEvents(hosted.id)).toHaveLength(0)
      },
    )
  })

  describe('事件的标记', () => {
    it('写下的事件都带标记，让出 URI 时的 expire 事件也一样；活动接口返回它', async () => {
      const uri = 'notes://expiring'
      await real('kioku_create', { uri, content: '旧的' })
      await withSpace(database.db, ws.spaceId, (tx) =>
        tx
          .update(memories)
          .set({ validTo: new Date(Date.now() - 60_000) })
          .where(eq(memories.path, 'expiring')),
      )
      const created = await masked('kioku_create', { uri, content: '新的' })
      expect(created.isError).toBe(false)

      const events = await withSpace(database.db, ws.spaceId, (tx) =>
        tx.select().from(memoryEvents).orderBy(asc(memoryEvents.id)),
      )
      expect(events.map((e) => e.eventType)).toEqual(['create', 'expire', 'create'])
      expect(events[0]!.context).toEqual({})
      expect(events[1]!.context).toEqual(mark())
      expect(events[2]!.context).toEqual(mark())

      const res = await app.request(`/v1/spaces/${ws.spaceId}/activity`, {
        headers: { cookie: ws.cookie },
      })
      const { items } = (await res.json()) as ActivityList
      expect(items.map((i) => i.bench)).toEqual([
        { accountName: 'alice', run: 'run-1' },
        { accountName: 'alice', run: 'run-1' },
        null,
      ])
    })

    it('标记里的账号已经不在时，活动里账号是 null，不报错', async () => {
      const gone = randomUUID()
      await handleMcpRequest(
        memoryServiceForKey(deps, key, defaultSession(key), {
          eventContext: { bench: { account: gone, run: 'run-2' } },
        }),
        recallScopeForKey(deps, key),
        credentialServiceForKey(deps, key),
        rpc('kioku_create', { uri: 'notes://orphan', content: '正文' }),
      )
      const res = await app.request(`/v1/spaces/${ws.spaceId}/activity`, {
        headers: { cookie: ws.cookie },
      })
      const { items } = (await res.json()) as ActivityList
      expect(items[0]!.bench).toEqual({ accountName: null, run: 'run-2' })
    })
  })
})
