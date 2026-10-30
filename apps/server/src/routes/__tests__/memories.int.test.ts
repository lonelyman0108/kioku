import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'

import type { MemoryChildren, MemoryView } from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { staticEmbedderSource } from '../../embedding/source'
import { withSpace, type Database } from '../../db/client'
import { memories, memoryEvents } from '../../db/schema'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bearer, bootstrap, FULL_SCOPES, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('记忆读写接口', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
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
    const persona = await ws.createPersona('doubao')
    const agent = await ws.createApp('claude-code', { defaultPersonaId: persona.id })
    key = await ws.issueKey(agent.id)
  })

  const call = (method: string, path: string, body?: unknown, k = key) =>
    app.request(
      `/v1${path}`,
      body === undefined ? { method, headers: bearer(k) } : jsonRequest(method, body, bearer(k)),
    )
  const create = (body: Record<string, unknown>, k = key) => call('POST', '/memories', body, k)
  const get = (uri: string, k = key) =>
    call('GET', `/memories?uri=${encodeURIComponent(uri)}`, undefined, k)

  it('创建后能读回，默认是私人层', async () => {
    const res = await create({
      uri: 'projects://kioku',
      content: '多人格记忆服务',
      disclosure: '讨论 Kioku 时',
      glossary: ['kioku', '记忆'],
    })
    expect(res.status).toBe(201)
    const m = (await (await get('projects://kioku')).json()) as MemoryView
    expect(m).toMatchObject({
      layer: 'private',
      sensitivity: 'private',
      provenance: 'agent',
      content: '多人格记忆服务',
      glossary: ['kioku', '记忆'],
      version: 1,
    })
  })

  it('写库真的出错时 500，日志里没有 SQL 与参数：参数就是记忆正文', async () => {
    const BODY = '不该进日志的记忆正文'
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 数据库的文本里存不了 NUL，请求校验不拦它，写库时才报错
      const res = await create({ uri: 'notes://nul', content: `${BODY}\u0000` })
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

  it('重复创建返回 409，不存在返回 404', async () => {
    await create({ uri: 'core://agent', content: 'x', layer: 'base' })
    expect((await create({ uri: 'core://agent', content: 'y', layer: 'base' })).status).toBe(409)
    expect((await get('core://nope')).status).toBe(404)
  })

  it('删除后在同一个 URI 重建的是另一条记忆：带着旧 id 的修改返回 409', async () => {
    const first = (await (
      await create({ uri: 'core://x', content: '旧', layer: 'base' })
    ).json()) as MemoryView
    await call('DELETE', `/memories?uri=${encodeURIComponent('core://x')}`)
    await create({ uri: 'core://x', content: '新', layer: 'base' })
    const stale = await call('PATCH', '/memories', {
      uri: 'core://x',
      expectedId: first.id,
      expectedVersion: first.version,
      content: '覆盖',
    })
    expect(stale.status).toBe(409)
    expect(((await (await get('core://x')).json()) as MemoryView).content).toBe('新')
  })

  it('删除时带着旧的 id 或版本号返回 409，不会删掉别人刚改过或重建的记忆', async () => {
    const first = (await (
      await create({ uri: 'core://y', content: '旧', layer: 'base' })
    ).json()) as MemoryView
    await call('PATCH', '/memories', { uri: 'core://y', content: '改过' })
    const q = (extra: string) => `/memories?uri=${encodeURIComponent('core://y')}${extra}`
    expect((await call('DELETE', q(`&expectedVersion=${first.version}`))).status).toBe(409)
    expect((await call('DELETE', q(`&expectedId=${crypto.randomUUID()}`))).status).toBe(409)
    expect((await call('DELETE', q(`&expectedId=${first.id}&expectedVersion=2`))).status).toBe(204)
  })

  it('移动时带着旧的 id 或版本号返回 409，不会移走别人刚改过或重建的记忆', async () => {
    const first = (await (
      await create({ uri: 'core://m', content: '旧', layer: 'base' })
    ).json()) as MemoryView
    await call('PATCH', '/memories', { uri: 'core://m', content: '改过' })
    const move = (expected: object) =>
      call('POST', '/memories/move', { from: 'core://m', to: 'core://n', ...expected })
    expect((await move({ expectedVersion: first.version })).status).toBe(409)
    expect((await move({ expectedId: crypto.randomUUID() })).status).toBe(409)
    expect((await get('core://n')).status).toBe(404)
    const moved = await move({ expectedId: first.id, expectedVersion: first.version + 1 })
    expect(((await moved.json()) as MemoryView).uri).toBe('core://n')
  })

  // 用另一条连接锁住这条记忆，让请求读完之后等在写入的行锁上，在锁里提交一次改动再放开，
  // 稳定地复现「检查之后、写入之前被别人改了」
  async function raceWithLockedRow(
    uri: string,
    request: () => Response | Promise<Response>,
    change: (side: postgres.TransactionSql, id: string) => Promise<unknown>,
  ): Promise<Response> {
    const view = (await (await get(uri)).json()) as MemoryView
    const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
    try {
      let pending!: Promise<Response>
      await side.begin(async (tx) => {
        await tx`select set_config('app.space_id', ${ws.spaceId}, true)`
        const locked = await tx`select id from memories where id = ${view.id} for update`
        expect(locked).toHaveLength(1)
        const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [{ pid: number }]
        pending = Promise.resolve(request())
        // 等到确实有会话被这个事务的锁挡住；2 秒内等不到就报错，赶在 vitest 默认的 5 秒超时之前
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

  it('删除检查之后、写入之前被改过的记忆，不会被删掉', async () => {
    await create({ uri: 'core://z', content: '第一版', layer: 'base' })
    const deleted = await raceWithLockedRow(
      'core://z',
      () => call('DELETE', `/memories?uri=${encodeURIComponent('core://z')}&expectedVersion=1`),
      (tx, id) =>
        tx`update memories set version = version + 1, content = '第二版' where id = ${id}`,
    )
    expect(deleted.status).toBe(409)
    expect(((await (await get('core://z')).json()) as MemoryView).content).toBe('第二版')
  })

  it('修改读完之后被删掉的记忆，修改不会写进去', async () => {
    await create({ uri: 'core://w', content: '第一版', layer: 'base' })
    const patched = await raceWithLockedRow(
      'core://w',
      () => call('PATCH', '/memories', { uri: 'core://w', content: '第二版' }),
      (tx, id) => tx`update memories set deleted_at = now() where id = ${id}`,
    )
    expect(patched.status).toBe(409)
    const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select({ content: memories.content }).from(memories).where(eq(memories.path, 'w')),
    )
    expect(row?.content).toBe('第一版')
  })

  it('修改会递增版本，旧版本号返回 409', async () => {
    await create({ uri: 'core://agent', content: '第一版', layer: 'base' })
    const res = await call('PATCH', '/memories', {
      uri: 'core://agent',
      content: '第二版',
      expectedVersion: 1,
      glossaryAdd: ['agent'],
    })
    expect(((await res.json()) as MemoryView).version).toBe(2)
    const stale = await call('PATCH', '/memories', {
      uri: 'core://agent',
      content: '第三版',
      expectedVersion: 1,
    })
    expect(stale.status).toBe(409)
  })

  it('删除后不可见，历史事件保留前后快照且不含密文', async () => {
    await create({ uri: 'core://agent', content: 'x', layer: 'base' })
    expect((await call('DELETE', '/memories?uri=core%3A%2F%2Fagent')).status).toBe(204)
    expect((await get('core://agent')).status).toBe(404)
    const events = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memoryEvents).orderBy(memoryEvents.id),
    )
    expect(events.map((e) => e.eventType)).toEqual(['create', 'delete'])
    expect(JSON.stringify(events)).not.toContain('ciphertext')
  })

  it('移动改 URI，移出人格命名空间时不指定新的层返回 400', async () => {
    await create({ uri: 'core://a', content: 'x', layer: 'base' })
    const moved = await call('POST', '/memories/move', { from: 'core://a', to: 'core://b' })
    expect(((await moved.json()) as MemoryView).uri).toBe('core://b')

    await create({ uri: 'persona://doubao/soul', content: '直接、有观点' })
    const out = await call('POST', '/memories/move', {
      from: 'persona://doubao/soul',
      to: 'core://soul',
    })
    expect(out.status).toBe(400)
  })

  it('persona:// 自动归人格层，不存在的人格返回 404', async () => {
    const res = await create({ uri: 'persona://doubao/soul', content: '直接、有观点' })
    expect(((await res.json()) as MemoryView).layer).toBe('persona')
    expect((await create({ uri: 'persona://ghost/soul', content: 'x' })).status).toBe(404)
  })

  it('不能写别的应用的 app:// 命名空间', async () => {
    await ws.createApp('astrbot')
    expect((await create({ uri: 'app://claude-code/rules', content: 'x' })).status).toBe(201)
    expect((await create({ uri: 'app://astrbot/rules', content: 'x' })).status).toBe(403)
  })

  it('读不到别的应用使用的人格', async () => {
    const other = await ws.createPersona('formal')
    const bot = await ws.createApp('bot', { defaultPersonaId: other.id })
    const botKey = await ws.issueKey(bot.id)
    expect((await create({ uri: 'persona://formal/soul', content: '正式' }, botKey)).status).toBe(
      201,
    )
    expect((await get('persona://formal/soul')).status).toBe(404)
    expect((await get('persona://formal/soul', botKey)).status).toBe(200)
  })

  it('人格继承：子人格能读到父人格的记忆', async () => {
    const parent = await ws.createPersona('base-persona')
    const child = await ws.createPersona('child', parent.id)
    const bot = await ws.createApp('kid', { defaultPersonaId: child.id })
    const botKey = await ws.issueKey(bot.id, { ...FULL_SCOPES, admin: true })
    await create({ uri: 'persona://base-persona/tone', content: '温和' }, botKey)
    expect((await get('persona://base-persona/tone', botKey)).status).toBe(200)
  })

  it('Key 没有的层读不到，看起来和不存在一样', async () => {
    await create({ uri: 'home://router', content: '内网信息' })
    const limitedApp = await ws.createApp('limited')
    const limited = await ws.issueKey(limitedApp.id, {
      ...FULL_SCOPES,
      readLayers: ['base'],
      writeLayers: ['base'],
      maxSensitivity: 'public',
    })
    expect((await get('home://router', limited)).status).toBe(404)
    expect((await create({ uri: 'home://x', content: 'x' }, limited)).status).toBe(403)
  })

  it('secret 在库里只有密文，授权 Key 能读回明文', async () => {
    const res = await create({ uri: 'home://wifi', content: 'hunter2', sensitivity: 'secret' })
    expect(res.status).toBe(201)
    const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memories).where(eq(memories.path, 'wifi')),
    )
    expect(row!.content).toBeNull()
    expect(row!.ciphertext!.toString('utf8')).not.toContain('hunter2')
    expect(((await (await get('home://wifi')).json()) as MemoryView).content).toBe('hunter2')

    const plainApp = await ws.createApp('plain')
    const plain = await ws.issueKey(plainApp.id, { ...FULL_SCOPES, maxSensitivity: 'private' })
    expect((await get('home://wifi', plain)).status).toBe(404)
  })

  it('敏感级降到非 secret 时转回明文存储', async () => {
    await create({ uri: 'home://wifi', content: 'hunter2', sensitivity: 'secret' })
    await call('PATCH', '/memories', { uri: 'home://wifi', sensitivity: 'private' })
    const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memories).where(eq(memories.path, 'wifi')),
    )
    expect(row!.content).toBe('hunter2')
    expect(row!.ciphertext).toBeNull()
  })

  it('列出 domain 与子节点', async () => {
    for (const uri of [
      'core://agent',
      'core://agent/claudecode',
      'core://agent/codex',
      'core://soul',
    ]) {
      await create({ uri, content: uri, layer: 'base' })
    }
    await create({ uri: 'projects://kioku', content: 'x' })
    const domains = await (await call('GET', '/memories/domains')).json()
    expect(domains).toEqual([
      { domain: 'core', count: 4 },
      { domain: 'projects', count: 1 },
    ])

    const root = (await (await call('GET', '/memories/children?of=core')).json()) as MemoryChildren
    expect(root.parent).toBeNull()
    expect(root.children.map((c) => [c.uri, c.childCount])).toEqual([
      ['core://agent', 2],
      ['core://soul', 0],
    ])
    const agent = (await (
      await call('GET', `/memories/children?of=${encodeURIComponent('core://agent')}`)
    ).json()) as MemoryChildren
    expect(agent.parent?.uri).toBe('core://agent')
    expect(agent.children.map((c) => c.uri)).toEqual([
      'core://agent/claudecode',
      'core://agent/codex',
    ])
    expect(agent.truncated).toBe(false)
  })

  it('一级超过 500 个时只返回前 500 个并标记截断，priority 高的不会被截掉', async () => {
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(memories).values(
        Array.from({ length: 501 }, (_, i) => ({
          spaceId: ws.spaceId,
          form: 'curated' as const,
          layer: 'base' as const,
          sensitivity: 'public' as const,
          provenance: 'agent' as const,
          domain: 'bulk',
          path: `n${String(i).padStart(3, '0')}`,
          content: 'x',
          priority: i === 500 ? 0 : 5,
        })),
      ),
    )
    const res = (await (await call('GET', '/memories/children?of=bulk')).json()) as MemoryChildren
    expect(res.truncated).toBe(true)
    expect(res.children).toHaveLength(500)
    expect(res.children[0]!.uri).toBe('bulk://n500')
  })

  it('URI 格式错误返回 400', async () => {
    expect((await create({ uri: 'no-scheme', content: 'x' })).status).toBe(400)
    expect((await create({ uri: 'core://Bad Path', content: 'x' })).status).toBe(400)
  })

  it('subject 与 episode 层不能直接按 URI 创建', async () => {
    expect((await create({ uri: 'x://y', content: 'x', layer: 'subject' })).status).toBe(400)
  })
})
