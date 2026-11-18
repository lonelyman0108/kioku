import { randomBytes, randomUUID } from 'node:crypto'

import type { ActivityList, ConsoleCredential } from '@kioku/contracts'
import { and, asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { defaultSession } from '../../access/session'
import { keyToSimulate } from '../../access/simulate'
import { credentialServiceForKey } from '../../credential/context'
import { withCircle, type Database } from '../../db/client'
import { credentialEvents, entries, entryEvents, entryVariants } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps, KeyPrincipal } from '../../http/env'
import { handleMcpRequest } from '../../mcp/server'
import { entryServiceForKey, recallScopeForKey } from '../../memory/context'
import { MASKED_CREDENTIAL_VALUES, MASKED_SECRET_CONTENT } from '../../memory/masked'
import { sealVariantContent } from '../../memory/service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bearer, bootstrap, FULL_SCOPES, jsonRequest, type Workspace } from '../../testing/fixtures'

const SECRET_BODY = '保险柜的位置在书房第三层'
const HOSTED_VALUE = 'hunter2-hosted-value'

describe.skipIf(!testDatabaseUrl)('打码：secret 正文与凭据值不出服务', () => {
  let database: Database
  let deps: Deps
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let plainKey: string
  let key: KeyPrincipal
  let workCircleId: string
  let personalKey: KeyPrincipal
  let personalPlainKey: string
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
    const workRes = await app.request(
      '/v1/circles',
      jsonRequest('POST', { slug: 'work', name: '公司' }, { cookie: ws.cookie }),
    )
    expect(workRes.status).toBe(201)
    workCircleId = ((await workRes.json()) as { id: string }).id

    const clientId = (await ws.createClient('agent', { runtimeFamily: 'claudecode' })).id
    const createdRes = await app.request(
      `/v1/circles/${ws.circleId}/clients/${clientId}/keys`,
      jsonRequest(
        'POST',
        {
          name: 'shared-agent',
          linkedCircles: [{ circleId: workCircleId, mode: 'read_write' }],
          scopes: FULL_SCOPES,
        },
        { cookie: ws.cookie },
      ),
    )
    expect(createdRes.status).toBe(201)
    const created = (await createdRes.json()) as { id: string; key: string }
    plainKey = created.key
    const found = await keyToSimulate(
      deps,
      { circleId: ws.circleId, clientId, keyId: created.id },
      ws.accountId,
    )
    if ('error' in found) throw new Error(found.error)
    key = found.key

    const pClientRes = await app.request(
      `/v1/circles/${ws.personalCircleId}/clients`,
      jsonRequest(
        'POST',
        { slug: 'personal-agent', name: 'Personal Agent', runtimeFamily: 'claudecode' },
        { cookie: ws.cookie },
      ),
    )
    expect(pClientRes.status).toBe(201)
    const pClientId = ((await pClientRes.json()) as { id: string }).id
    const pKeyRes = await app.request(
      `/v1/circles/${ws.personalCircleId}/clients/${pClientId}/keys`,
      jsonRequest('POST', { name: 'personal-key', scopes: FULL_SCOPES }, { cookie: ws.cookie }),
    )
    expect(pKeyRes.status).toBe(201)
    const pCreated = (await pKeyRes.json()) as { id: string; key: string }
    personalPlainKey = pCreated.key
    const pFound = await keyToSimulate(
      deps,
      { circleId: ws.personalCircleId, clientId: pClientId, keyId: pCreated.id },
      ws.accountId,
    )
    if ('error' in pFound) throw new Error(pFound.error)
    personalKey = pFound.key
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
  // 测试台的调用：打码、事件带标记。凭据两种模式一样：取用一律不给值、不记访问
  const mark = () => ({ bench: { account: ws.accountId, run: 'run-1' } })
  const masked = (
    name: string,
    args: Record<string, unknown> = {},
    targetKey: KeyPrincipal = key,
  ) =>
    handleMcpRequest(
      entryServiceForKey(deps, targetKey, defaultSession(targetKey), {
        maskSecret: true,
        eventContext: mark(),
      }),
      recallScopeForKey(deps, targetKey),
      credentialServiceForKey(deps, targetKey, defaultSession(targetKey), {
        bench: true,
        eventContext: mark(),
      }),
      rpc(name, args),
    ).then(parse)
  // 真实的 /v1/mcp：对照，也用来核对数据没有被打码的文字写坏
  const real = async (
    name: string,
    args: Record<string, unknown> = {},
    bearerKey: string = plainKey,
  ) => {
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: {
        ...bearer(bearerKey),
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
  const seedSecret = async (title = 'safe') => {
    const created = await real('kioku_create', {
      title,
      content: SECRET_BODY,
      sensitivity: 'secret',
      topics: ['vault'],
    })
    expect(created.isError).toBe(false)
    expect(created.text).toContain(SECRET_BODY)
    return created
  }
  const realBody = async (entryRef = 'safe', circle?: string) =>
    (await real('kioku_get', { id: entryRef, ...(circle ? { circle } : {}) })).text

  describe('词条与变体', () => {
    it('kioku_get：不给 secret 的正文，真实接口照常给', async () => {
      await seedSecret()
      const got = await masked('kioku_get', { id: 'safe' })
      expect(got.isError).toBe(false)
      expect(got.text).toContain('敏感级: secret')
      expect(got.text).toContain('secret 正文需要显式读取权限')
      expect(got.text).not.toContain(SECRET_BODY)
      expect(await realBody()).toContain(SECRET_BODY)
    })

    it('kioku_browse：列表不给 secret 词条与正文', async () => {
      await seedSecret()
      await real('kioku_create', { title: 'child-note', content: '子节点', topics: ['vault'] })
      const browsed = await masked('kioku_browse', { group_by: 'topic', topic: 'vault' })
      expect(browsed.text).not.toContain('safe')
      expect(browsed.text).toContain('child-note')
      expect(browsed.text).not.toContain(SECRET_BODY)
    })

    it('打码时不解密，也不记访问；真实接口读到才记', async () => {
      await seedSecret()
      const accessEvents = () =>
        withCircle(database.db, ws.circleId, (tx) =>
          tx.select().from(entryEvents).where(eq(entryEvents.eventType, 'access')),
        )
      await masked('kioku_get', { id: 'safe' })
      await masked('kioku_browse', { group_by: 'topic', topic: 'vault' })
      await masked('kioku_update', { id: 'safe', priority: 7 })
      expect(await accessEvents()).toEqual([])
      await realBody()
      expect((await accessEvents()).map((e) => e.context)).toEqual([{ via: 'kioku_get' }])
    })

    it('kioku_transfer：密钥跨圈迁移 secret 词条被拒绝；普通词条迁出后原文不丢', async () => {
      await seedSecret()
      const denied = await masked('kioku_transfer', { id: 'safe', to_circle: 'work' })
      expect(denied.isError).toBe(true)
      expect(denied.text).toContain('不能跨圈迁移机密词条')
      expect(await realBody()).toContain(SECRET_BODY)

      await real('kioku_create', { title: 'portable', content: '便携内容' })
      const moved = await masked('kioku_transfer', { id: 'portable', to_circle: 'work' })
      expect(moved.isError).toBe(false)
      expect(moved.text).toContain('记忆圈: work')
      expect(await realBody('portable', 'work')).toContain('便携内容')
    })

    it('只改 priority 的 kioku_update：结果不带正文，封存回去的还是原文，不是占位文字', async () => {
      await seedSecret()
      const updated = await masked('kioku_update', { id: 'safe', priority: 7 })
      expect(updated.isError).toBe(false)
      expect(updated.text).toContain('priority: 7')
      expect(updated.text).not.toContain(SECRET_BODY)
      const after = await realBody()
      expect(after).toContain('priority: 7')
      expect(after).toContain(SECRET_BODY)
    })

    it('secret 级的 kioku_create：结果不带正文，存下的是传入的原文', async () => {
      const created = await masked('kioku_create', {
        title: 'new-safe',
        content: SECRET_BODY,
        sensitivity: 'secret',
      })
      expect(created.isError).toBe(false)
      expect(created.text).toContain('敏感级: secret')
      expect(created.text).not.toContain(SECRET_BODY)
      expect(await realBody('new-safe')).toContain(SECRET_BODY)
    })

    it('把 secret 改成别的敏感级被拒绝：结果与之后读到的都没有明文，敏感级不变', async () => {
      await seedSecret()
      const downgraded = await masked('kioku_update', { id: 'safe', sensitivity: 'private' })
      expect(downgraded.isError).toBe(true)
      expect(downgraded.text).toContain('禁止降级或改写机密词条正文')
      expect(downgraded.text).not.toContain(SECRET_BODY)
      const got = await masked('kioku_get', { id: 'safe' })
      expect(got.text).toContain('敏感级: secret')
      expect(got.text).not.toContain(SECRET_BODY)
      expect(await realBody()).toContain('敏感级: secret')
      // 搜也搜不到；同一个查询在真的降级之后就搜得到，说明这里不是查询没有命中
      const searched = await masked('kioku_search', { query: '保险柜' })
      expect(searched.isError).toBe(false)
      expect(searched.text).not.toContain(SECRET_BODY)
      expect(searched.text).not.toContain('safe')
      expect((await real('kioku_update', { id: 'safe', sensitivity: 'private' })).isError).toBe(
        false,
      )
      expect((await masked('kioku_search', { query: '保险柜' })).text).toContain('safe')
    })

    it('改 secret 的正文被拒绝：读不到原文，写回占位文字会永久覆盖', async () => {
      await seedSecret()
      const placeholder = (await masked('kioku_get', { id: 'safe' })).text
      const rewritten = await masked('kioku_update', { id: 'safe', content: placeholder })
      expect(rewritten.isError).toBe(true)
      expect(rewritten.text).toContain('禁止降级或改写机密词条正文')
      expect(await realBody()).toContain(SECRET_BODY)
      // 带着 secret 不变的敏感级一起改也一样
      const same = await masked('kioku_update', {
        id: 'safe',
        content: '新正文',
        sensitivity: 'secret',
      })
      expect(same.isError).toBe(true)
      expect(await realBody()).toContain(SECRET_BODY)
    })

    it('正文里有占位文字时拒绝：模型照抄读到的结果，新建与改普通记忆都一样', async () => {
      await seedSecret()
      const copied = (await masked('kioku_get', { id: 'safe' })).text
      const created = await masked('kioku_create', { title: 'copy', content: copied })
      expect(created.isError).toBe(true)
      expect(created.text).toContain('占位文字')
      expect((await real('kioku_get', { id: 'copy' })).isError).toBe(true)
      const sealed = await masked('kioku_create', {
        title: 'copy',
        content: copied,
        sensitivity: 'secret',
      })
      expect(sealed.isError).toBe(true)
      expect((await real('kioku_get', { id: 'copy' })).isError).toBe(true)

      await real('kioku_create', { title: 'plain', content: '普通正文' })
      for (const placeholder of [MASKED_SECRET_CONTENT, MASKED_CREDENTIAL_VALUES]) {
        const updated = await masked('kioku_update', {
          id: 'plain',
          content: `前面的话 ${placeholder} 后面的话`,
        })
        expect(updated.isError, placeholder).toBe(true)
        expect(updated.text, placeholder).toContain('占位文字')
      }
      const after = await realBody('plain')
      expect(after).toContain('普通正文')
      expect(after).toContain('版本: 1')
      // 只改别的字段不受影响
      const raised = await masked('kioku_update', { id: 'plain', priority: 7 })
      expect(raised.isError).toBe(false)
    })

    it('真实接口不受影响：正文里可以写到占位文字', async () => {
      const created = await real('kioku_create', {
        title: 'about-mask',
        content: `测试台读 secret 时显示 ${MASKED_SECRET_CONTENT}`,
      })
      expect(created.isError).toBe(false)
      const updated = await real('kioku_update', {
        id: 'about-mask',
        content: MASKED_CREDENTIAL_VALUES,
      })
      expect(updated.isError).toBe(false)
    })

    it('真实接口不受影响：照常能改 secret 的正文与敏感级', async () => {
      await seedSecret()
      const rewritten = await real('kioku_update', { id: 'safe', content: '新正文' })
      expect(rewritten.isError).toBe(false)
      const downgraded = await real('kioku_update', { id: 'safe', sensitivity: 'private' })
      expect(downgraded.isError).toBe(false)
      expect(downgraded.text).toContain('新正文')
    })

    it('改成 secret 可以，结果不带正文', async () => {
      await real('kioku_create', { title: 'plain', content: '普通正文' })
      const raised = await masked('kioku_update', { id: 'plain', sensitivity: 'secret' })
      expect(raised.isError).toBe(false)
      expect(raised.text).not.toContain('普通正文')
      expect(await realBody('plain')).toContain('普通正文')
    })

    it('占位符格式不对的旧数据：解密后的片段不进报错', async () => {
      await seedSecret()
      await withCircle(database.db, ws.circleId, async (tx) => {
        const [row] = await tx.select().from(entries).where(eq(entries.title, 'safe'))
        const [vRow] = await tx
          .select()
          .from(entryVariants)
          .where(eq(entryVariants.entryId, row!.id))
        const legacy = sealVariantContent(masterKey, vRow!.id, '旧数据 {{cred:坏的片段')
        await tx.update(entryVariants).set(legacy).where(eq(entryVariants.id, vRow!.id))
      })
      const updated = await masked('kioku_update', { id: 'safe', priority: 5 })
      expect(updated.isError).toBe(true)
      expect(updated.text).toContain('占位符格式错误')
      expect(updated.text).not.toContain('坏的片段')
      // 真实接口没带正文时查的也是解出来的原文，同样不带
      const direct = await real('kioku_update', { id: 'safe', priority: 5 })
      expect(direct.text).toContain('占位符格式错误')
      expect(direct.text).not.toContain('坏的片段')
    })

    it('不是 secret 的记忆照常报出标识：正文本来就读得到（个人圈）', async () => {
      const created = await masked(
        'kioku_create',
        { title: 'refs', content: '{{cred:missing-cred}}' },
        personalKey,
      )
      expect(created.isError).toBe(true)
      expect(created.text).toContain('missing-cred')
    })
  })

  describe('凭据', () => {
    const accessEvents = (credentialId: string) =>
      withCircle(database.db, ws.circleId, (tx) =>
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
    const asOwner = async <T>(
      method: string,
      path: string,
      body?: unknown,
      circleId = ws.circleId,
    ) => {
      const res = await app.request(
        `/v1/circles/${circleId}${path}`,
        jsonRequest(method, body, { cookie: ws.cookie }),
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      return (await res.json()) as T
    }
    const seedHosted = (circleId = ws.circleId) =>
      asOwner<ConsoleCredential>(
        'POST',
        '/credentials',
        {
          identifier: 'nas',
          name: 'NAS',
          source: { kind: 'new', values: { username: 'alice', password: HOSTED_VALUE } },
        },
        circleId,
      )

    it('取用（托管的）：不解密、不给值、不记访问，只列字段名', async () => {
      const credential = await seedHosted()
      const got = await masked('kioku_credential', { identifier: 'nas', purpose: '测试' })
      expect(got.isError).toBe(false)
      expect(got.text).not.toContain(HOSTED_VALUE)
      expect(got.text).toContain('字段 password、username')
      expect(got.text).toContain(`值：${MASKED_CREDENTIAL_VALUES}`)
      expect(await accessEvents(credential.id)).toHaveLength(0)
      // 真实接口照常给值、记访问
      expect((await real('kioku_credential', { identifier: 'nas' })).text).toContain(HOSTED_VALUE)
      expect(await accessEvents(credential.id)).toHaveLength(1)
    })

    it('值里有占位文字时拒绝：新建与修改都不写入，真实的值不变', async () => {
      await seedHosted()
      const copied = (await masked('kioku_credential', { identifier: 'nas' })).text
      expect(copied).toContain(MASKED_CREDENTIAL_VALUES)
      const updated = await masked('kioku_credential_save', {
        identifier: 'nas',
        expected_version: 1,
        values: { password: copied },
      })
      expect(updated.isError).toBe(true)
      expect(updated.text).toContain('占位文字')
      const created = await masked('kioku_credential_save', {
        identifier: 'copied',
        name: '抄的',
        values: { password: MASKED_SECRET_CONTENT },
      })
      expect(created.isError).toBe(true)
      expect(created.text).toContain('占位文字')

      const after = await real('kioku_credential', { identifier: 'nas' })
      expect(after.text).toContain(HOSTED_VALUE)
      expect(after.text).toContain('版本 1')
      expect((await real('kioku_credential', { identifier: 'copied' })).isError).toBe(true)
      // 改别的字段不受影响，事件带标记
      const renamed = await masked('kioku_credential_save', {
        identifier: 'nas',
        expected_version: 1,
        name: '新名字',
      })
      expect(renamed.isError).toBe(false)
    })

    it('真实接口不受影响：值里可以写到占位文字', async () => {
      const saved = await real('kioku_credential_save', {
        identifier: 'odd',
        name: '奇怪的值',
        values: { note: MASKED_CREDENTIAL_VALUES },
      })
      expect(saved.isError).toBe(false)
      expect((await real('kioku_credential', { identifier: 'odd' })).text).toContain(
        MASKED_CREDENTIAL_VALUES,
      )
    })

    it('kioku_get 末尾的凭据列表：只说能不能取用，不给值，也不记访问', async () => {
      const hosted = await seedHosted(ws.personalCircleId)
      await real(
        'kioku_create',
        { title: 'login-note', content: 'NAS {{cred:nas#password}}', sensitivity: 'private' },
        personalPlainKey,
      )
      const got = await masked('kioku_get', { id: 'login-note' }, personalKey)
      expect(got.text).toContain('- nas（NAS）：可以取用')
      expect(got.text).not.toContain(HOSTED_VALUE)
      const events = await withCircle(database.db, ws.personalCircleId, (tx) =>
        tx
          .select()
          .from(credentialEvents)
          .where(
            and(
              eq(credentialEvents.credentialId, hosted.id),
              eq(credentialEvents.eventType, 'access'),
            ),
          ),
      )
      expect(events).toHaveLength(0)
    })
  })

  describe('事件的标记', () => {
    it('写下的事件都带标记，活动接口返回它', async () => {
      await real('kioku_create', { title: 'marked', content: 'initial content' })
      const updated = await masked('kioku_update', { id: 'marked', priority: 5 })
      expect(updated.isError).toBe(false)
      const deleted = await masked('kioku_delete', { id: 'marked' })
      expect(deleted.isError).toBe(false)

      const events = await withCircle(database.db, ws.circleId, (tx) =>
        tx.select().from(entryEvents).orderBy(asc(entryEvents.id)),
      )
      expect(events.map((e) => e.eventType)).toEqual(['create', 'update', 'delete'])
      expect(events[0]!.context).toEqual({})
      expect(events[1]!.context).toEqual(mark())
      expect(events[2]!.context).toEqual(mark())

      const res = await app.request(`/v1/circles/${ws.circleId}/activity`, {
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
        entryServiceForKey(deps, key, defaultSession(key), {
          eventContext: { bench: { account: gone, run: 'run-2' } },
        }),
        recallScopeForKey(deps, key),
        credentialServiceForKey(deps, key),
        rpc('kioku_create', { title: 'orphan', content: '正文' }),
      )
      const res = await app.request(`/v1/circles/${ws.circleId}/activity`, {
        headers: { cookie: ws.cookie },
      })
      const { items } = (await res.json()) as ActivityList
      expect(items[0]!.bench).toEqual({ accountName: null, run: 'run-2' })
    })
  })
})
