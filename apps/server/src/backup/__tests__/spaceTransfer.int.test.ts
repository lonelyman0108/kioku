import { randomBytes, randomUUID } from 'node:crypto'
import { getEventListeners } from 'node:events'

import type {
  AppInfo,
  ConsoleCredentialList,
  CredentialAccess,
  CredentialEventList,
  CredentialValues,
  DomainLayers,
  DreamMemberSettings,
  ExpiredMemoryList,
  ExtractionUsage,
  GroupPersonaRuleList,
  Me,
  MemoryHistory,
  MemoryView,
  PersonaInfo,
  RecallStats,
  ReviewList,
  SpaceImportPreview,
  SpaceImportResult,
  SpaceOverview,
  SubjectDetail,
  SubjectList,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { decryptSecret } from '../../crypto/envelope'
import { keyIdOf } from '../../crypto/keyring'
import { connect, withSpace, type Database } from '../../db/client'
import { credentialEvents, memories, settings, spaces, subjects } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Jobs } from '../../jobs/queue'
import { settleRecallEvents } from '../../recall/events'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, FULL_SCOPES, jsonRequest } from '../../testing/fixtures'
import { deriveExportKey, openSpaceExport, sealSpaceExport, type KdfParams } from '../spaceFormat'
import { parseSpaceExport, type ParsedSpaceExport } from '../spaceImport'
import { acquireTransferSlot, queuedTransfers } from '../transferGate'
import {
  SPACE_EXPORT_FORMAT,
  SPACE_EXPORT_MAX_PLAIN_BYTES,
  SPACE_EXPORT_VERSION,
  type MemoryRecord,
  type SpaceExportHeader,
  type SpaceExportRecord,
} from '../spaceRecords'

type App = ReturnType<typeof createApp>

const PASSPHRASE = 'correct horse battery staple'
const FAST: KdfParams = { logN: 14, r: 8, p: 1 }
const sameSite = { 'sec-fetch-site': 'same-origin' }

describe.skipIf(!testDatabaseUrl)('按空间导出与导入', () => {
  let database: Database
  const sourceKey = randomBytes(32)
  const targetKey = randomBytes(32)
  let source: App
  let target: App
  let backfills = 0
  let recallStarted: (typeof settings.$inferSelect)[] = []

  // 后台任务只记下导入之后有没有排向量补齐，别的都不做
  const jobs: Jobs = {
    enqueueEmbed: () => {},
    enqueueExtraction: async () => {},
    enqueueBackfill: async () => {
      backfills++
      return true
    },
    enqueueSwitch: async () => true,
    enqueuePrune: async () => true,
    enqueueBackup: async () => null,
    backupRun: async () => null,
    enqueueCleanup: async () => true,
    enqueueDream: async () => null,
    dreamRun: async () => null,
  }
  const appWith = (masterKey: Buffer | null) =>
    createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs,
    })

  beforeAll(async () => {
    database = await openTestDatabase()
    source = appWith(sourceKey)
    target = appWith(targetKey)
    recallStarted = await database.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'recall-started'))
  })
  afterAll(async () => {
    if (!database) return
    await resetDatabase(database)
    await database.db.delete(settings).where(eq(settings.key, 'recall-started'))
    if (recallStarted.length) await database.db.insert(settings).values(recallStarted)
    await database.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    backfills = 0
  })

  const send = (
    app: App,
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ) =>
    app.request(
      path,
      body === undefined
        ? { method, headers: { ...sameSite, ...headers } }
        : jsonRequest(method, body, headers),
    )
  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res
    expect(r.status, await r.clone().text()).toBe(status)
    return (r.status === 204 ? undefined : await r.json()) as T
  }
  const exportRequest = (app: App, spaceId: string, cookie: string, passphrase = PASSPHRASE) =>
    send(app, 'POST', `/v1/spaces/${spaceId}/export`, { passphrase }, { cookie })
  async function exportSpace(app: App, spaceId: string, cookie: string): Promise<Buffer> {
    const res = await exportRequest(app, spaceId, cookie)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="kioku-space-\d{8}T\d{6}Z\.kioku-space"; filename\*=UTF-8''/,
    )
    return Buffer.from(await res.arrayBuffer())
  }
  const upload = (
    path: string,
    app: App,
    cookie: string,
    file: Buffer | Blob,
    passphrase = PASSPHRASE,
    name?: string,
  ) => {
    const form = new FormData()
    form.set(
      'file',
      file instanceof Blob ? file : new Blob([new Uint8Array(file)]),
      'space.kioku-space',
    )
    form.set('passphrase', passphrase)
    if (name !== undefined) form.set('name', name)
    return app.request(path, { method: 'POST', headers: { ...sameSite, cookie }, body: form })
  }
  const importRequest = (...args: [App, string, Buffer | Blob, string?, string?]) =>
    upload('/v1/spaces/import', ...args)
  const inspectRequest = (...args: [App, string, Buffer | Blob, string?]) =>
    upload('/v1/spaces/import/inspect', ...args)
  const plainOf = (file: Buffer) =>
    openSpaceExport(file, {
      passphrase: PASSPHRASE,
      maxPlainBytes: SPACE_EXPORT_MAX_PLAIN_BYTES,
    })
  const contents = async (file: Buffer): Promise<ParsedSpaceExport> =>
    parseSpaceExport(await plainOf(file))
  const spaceCount = async () =>
    (await database.db.execute<{ n: number }>(sql`select count(*)::int as n from spaces`))[0]!.n

  // 自己拼一份导出文件：测数据库约束与边界用
  const header = (name = '拼的空间'): SpaceExportHeader => ({
    format: SPACE_EXPORT_FORMAT,
    version: SPACE_EXPORT_VERSION,
    createdAt: new Date().toISOString(),
    kioku: 'test',
    exporter: { displayName: '拼文件的人', dreamPrivate: true },
    space: { name, domainLayers: {}, extractionMonthlyTokens: 1000, extractionDailyWrites: 5 },
  })
  // 文件头按原样写出，测别的格式版本、缺字段时传别的样子
  async function craft(records: SpaceExportRecord[], head: object = header()): Promise<Buffer> {
    async function* lines() {
      yield `${JSON.stringify(head)}\n`
      for (const r of records) yield `${JSON.stringify(r)}\n`
    }
    return sealSpaceExport(await deriveExportKey(PASSPHRASE, FAST), lines(), {
      maxPlainBytes: SPACE_EXPORT_MAX_PLAIN_BYTES,
      maxBytes: 64 * 1024 * 1024,
    })
  }
  const now = new Date().toISOString()
  const curated = (uri: string, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({
    type: 'memory',
    id: randomUUID(),
    form: 'curated',
    layer: 'private',
    sensitivity: 'private',
    provenance: 'owner',
    originScope: 'global',
    personaId: null,
    appId: null,
    subjectId: null,
    uri,
    content: `${uri} 的正文`,
    priority: 2,
    disclosure: null,
    glossary: [],
    validFrom: now,
    validTo: null,
    expiresAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...extra,
  })

  // 源空间：两个成员（bob 也是 owner，有自己的 secret 与托管的凭据）、继承的人格、三个应用（一个是 bob 的）、
  // 群聊里认出的对象与按群换人格、各层的记忆（secret、带凭据占位符与关键词、bob 的私人层与画像、删掉的、过期的）、
  // 抽取的事实与会话摘要、两个成员各自的凭据与凭据源、召回记录与 Key
  async function seed() {
    const alice = await bootstrap(source, 'alice')
    const cookie = { cookie: alice.cookie }
    const spaceId = alice.spaceId
    const bob = await addMember(database.db, spaceId, 'bob', 'owner')
    const bobCookie = { cookie: bob.cookie }
    const base = await alice.createPersona('zeta-base')
    const child = await alice.createPersona('alpha-child', base.id)
    const agent = await alice.createApp('agent', { defaultPersonaId: child.id })
    const bot = await alice.createApp('qq-bot', {
      runtimeFamily: 'astrbot',
      defaultPersonaId: base.id,
      config: { elevateOwnerDirect: 'internal' },
    })
    await ok<AppInfo>(
      send(
        source,
        'POST',
        `/v1/spaces/${spaceId}/apps`,
        { slug: 'bob-app', name: 'bob 的应用', runtimeFamily: 'codex' },
        bobCookie,
      ),
      201,
    )
    const agentKey = await alice.issueKey(agent.id)
    const botKey = await alice.issueKey(bot.id)

    const memory = (body: object, who = cookie) =>
      ok<MemoryView>(send(source, 'POST', `/v1/spaces/${spaceId}/memories`, body, who), 201)
    const credential = (body: object, who = cookie) =>
      ok<{ id: string }>(send(source, 'POST', `/v1/spaces/${spaceId}/credentials`, body, who), 201)
    const provider = (body: object, who = cookie) =>
      ok<{ id: string }>(
        send(source, 'POST', `/v1/spaces/${spaceId}/credential-providers`, body, who),
        201,
      )

    const vault = await provider({ kind: 'bitwarden', name: 'Vaultwarden', instructions: 'bw get' })
    const oldProvider = await provider({ kind: 'other', name: '旧的密码本' })
    await ok(
      send(
        source,
        'DELETE',
        `/v1/spaces/${spaceId}/credential-providers/${oldProvider.id}`,
        undefined,
        cookie,
      ),
      204,
    )
    await credential({
      identifier: 'nas',
      name: 'NAS',
      source: { kind: 'hosted', values: { password: 'nas-pass', user: 'admin' } },
    })
    const mail = await credential({
      identifier: 'mail',
      name: '邮箱',
      source: {
        kind: 'external',
        providerId: vault.id,
        location: 'mail-item',
        fields: [{ name: 'password', sourceField: 'password' }],
      },
      appIds: [agent.id],
    })
    const gone = await credential({
      identifier: 'gone',
      name: '删掉的',
      source: { kind: 'hosted', values: { token: 'gone-token' } },
    })
    await ok(
      send(
        source,
        'DELETE',
        `/v1/spaces/${spaceId}/credentials/${gone.id}?expectedVersion=1`,
        undefined,
        cookie,
      ),
      204,
    )
    // 还绑着已删除的凭据源的凭据（先删凭据、再删凭据源、再恢复凭据）：凭据源跟着带过去，照样是已删除
    const replaced = await provider({ kind: '1password', name: '换掉的密码本' })
    const legacy = await credential({
      identifier: 'legacy',
      name: '旧的绑定',
      source: {
        kind: 'external',
        providerId: replaced.id,
        location: 'old-item',
        fields: [{ name: 'password', sourceField: 'password' }],
      },
    })
    const credentialPath = `/v1/spaces/${spaceId}/credentials/${legacy.id}`
    await ok(send(source, 'DELETE', `${credentialPath}?expectedVersion=1`, undefined, cookie), 204)
    await ok(
      send(
        source,
        'DELETE',
        `/v1/spaces/${spaceId}/credential-providers/${replaced.id}`,
        undefined,
        cookie,
      ),
      204,
    )
    await ok(send(source, 'POST', `${credentialPath}/undelete`, undefined, cookie))
    const bobVault = await provider({ kind: 'env', name: 'bob 的环境变量' }, bobCookie)
    await credential(
      {
        identifier: 'bob-mail',
        name: 'bob 的邮箱',
        source: {
          kind: 'external',
          providerId: bobVault.id,
          location: 'BOB_MAIL',
          fields: [{ name: 'password', sourceField: 'password' }],
        },
      },
      bobCookie,
    )
    await credential(
      {
        identifier: 'nas',
        name: 'bob 的 NAS',
        source: { kind: 'hosted', values: { password: 'bob-secret-token' } },
      },
      bobCookie,
    )

    await memory({ uri: 'core://agent', content: '先读正文再信任', layer: 'base', priority: 0 })
    await memory({ uri: 'persona://zeta-base/soul', content: '基础人格的设定' })
    await memory({ uri: 'persona://alpha-child/soul', content: '子人格的口吻', glossary: ['口吻'] })
    await memory({ uri: 'app://agent/rules', content: '提交规范', priority: 1 })
    await memory({ uri: 'app://bob-app/notes', content: 'bob 的应用层笔记' }, bobCookie)
    await memory({ uri: 'preferences://user', content: '回答用中文', layer: 'owner' })
    await memory({
      uri: 'home://nas',
      content: 'NAS 在书房，密码见 {{cred:nas#password}}',
      glossary: ['书房存储', 'NAS'],
      disclosure: '要连 NAS 的时候',
    })
    await memory({ uri: 'home://wifi', content: '无线密码 hunter2-secret', sensitivity: 'secret' })
    await memory({ uri: 'bob://diary', content: 'bob 的日记' }, bobCookie)
    await memory({ uri: 'bob://vault', content: 'bob 的秘密', sensitivity: 'secret' }, bobCookie)
    await memory({ uri: 'preferences://user', content: 'bob 的偏好', layer: 'owner' }, bobCookie)
    await memory({ uri: 'home://old', content: '要删掉的' })
    await ok(
      send(
        source,
        'DELETE',
        `/v1/spaces/${spaceId}/memories?uri=home%3A%2F%2Fold`,
        undefined,
        cookie,
      ),
      204,
    )
    const expired = await memory({ uri: 'home://expired', content: '已经过期的' })

    // 群聊与私聊里认出的对象：群、群里的发言人（标记成 alice）、私聊的人（标记成 bob）
    const recall = (key: string, query: string, context?: object) =>
      ok(
        send(source, 'POST', '/v1/recall', { query, ...(context ? { context } : {}) }, bearer(key)),
      )
    await recall(botKey, '你好', {
      chatType: 'group',
      platform: 'qq',
      group: { id: '2001', name: '读书会' },
      sender: { id: '1001', name: '小明' },
    })
    await recall(botKey, '在吗', {
      chatType: 'direct',
      platform: 'qq',
      sender: { id: '1002', name: '小红' },
    })
    await recall(agentKey, 'NAS 在书房吗')
    await settleRecallEvents()
    const people = await ok<SubjectList>(
      send(source, 'GET', `/v1/spaces/${spaceId}/subjects`, undefined, cookie),
    )
    const subjectNamed = (name: string) => people.items.find((s) => s.displayName === name)!
    const group = subjectNamed('读书会')
    const ming = subjectNamed('小明')
    const hong = subjectNamed('小红')
    await ok(
      send(
        source,
        'PATCH',
        `/v1/spaces/${spaceId}/subjects/${ming.id}`,
        { linkedToMe: true },
        cookie,
      ),
    )
    await ok(
      send(
        source,
        'PATCH',
        `/v1/spaces/${spaceId}/subjects/${hong.id}`,
        { linkedToMe: true },
        bobCookie,
      ),
    )
    await ok(
      send(
        source,
        'PUT',
        `/v1/spaces/${spaceId}/apps/${bot.id}/group-personas`,
        { rules: [{ subjectId: group.id, personaId: child.id }] },
        cookie,
      ),
    )
    await ok(
      send(
        source,
        'PUT',
        `/v1/spaces/${spaceId}/domain-layers`,
        { defaults: { core: 'base', preferences: 'owner' } },
        cookie,
      ),
    )
    await ok(
      send(
        source,
        'PUT',
        `/v1/spaces/${spaceId}/extraction-budget`,
        { monthlyTokens: 123_456, dailyWritesPerSubject: 7 },
        cookie,
      ),
    )

    // 抽取的事实与会话摘要来自群聊，是不可信来源；还有一条的群已经删掉了（作用域指向不在的对象）
    const orphanGroup = randomUUID()
    await withSpace(database.db, spaceId, async (tx) => {
      const extracted = {
        spaceId,
        form: 'extracted' as const,
        sensitivity: 'public' as const,
        provenance: 'untrusted' as const,
        originScope: `group:${group.id}`,
      }
      await tx.insert(memories).values([
        { ...extracted, layer: 'subject', subjectId: ming.id, content: '小明在学日语' },
        {
          ...extracted,
          layer: 'episode',
          content: '读书会讨论了村上春树',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          ...extracted,
          layer: 'episode',
          originScope: `group:${orphanGroup}`,
          content: '一个已经删掉的群里的摘要',
        },
      ])
      await tx
        .update(memories)
        .set({ validTo: new Date(Date.now() - 1000) })
        .where(eq(memories.id, expired.id))
      // 记忆都是很久以前建的：导入之后也不该一下子都算成「从没被召回」
      await tx.execute(sql`update memories set created_at = now() - interval '400 days'`)
    })
    // 限定给已经删掉的应用：导入时去掉，限定不会因此放宽
    await withSpace(database.db, spaceId, (tx) =>
      tx.execute(
        sql`update credentials set app_ids = array[${agent.id}::uuid, ${randomUUID()}::uuid] where id = ${mail.id}`,
      ),
    )
    // 字段没有来源字段（取值时按字段名取）：导出时写成字段名，和新建凭据的接口一样，导入后取法不变
    await withSpace(database.db, spaceId, (tx) =>
      tx.execute(
        sql`update credentials set fields = '[{"name":"password","sourceField":null}]'::jsonb where id = ${mail.id}`,
      ),
    )
    return { alice, bob, spaceId, agentKey, botKey, orphanGroup }
  }

  it(
    '导出只带导出人读得到的；导入到另一个实例的新空间后，内容、继承、归属与加密都对得上',
    { timeout: 30_000 },
    async () => {
      const { alice, spaceId, agentKey, orphanGroup } = await seed()
      const file = await exportSpace(source, spaceId, alice.cookie)

      // 文件本身是加密的：secret、托管的值、正文都看不到
      for (const text of ['hunter2-secret', 'nas-pass', '回答用中文', 'NAS']) {
        expect(file.includes(Buffer.from(text))).toBe(false)
      }
      const parsed = await contents(file)
      expect(parsed.header.space).toEqual({
        name: '家',
        domainLayers: { core: 'base', preferences: 'owner' },
        extractionMonthlyTokens: 123_456,
        extractionDailyWrites: 7,
      })
      const uris = parsed.memories.map((m) => m.uri).filter(Boolean)
      expect(uris.sort()).toEqual(
        [
          'app://agent/rules',
          'app://bob-app/notes',
          'core://agent',
          'home://expired',
          'home://nas',
          'home://wifi',
          'persona://alpha-child/soul',
          'persona://zeta-base/soul',
          'preferences://user',
        ].sort(),
      )
      // 画像只有 alice 自己的那份；bob 的私人层与删掉的不在；过期的带上，有效期原样写出
      expect(parsed.memories.find((m) => m.uri === 'preferences://user')!.content).toBe(
        '回答用中文',
      )
      expect(parsed.memories.find((m) => m.uri === 'home://expired')!.validTo).not.toBeNull()
      expect(parsed.memories.filter((m) => m.form === 'extracted')).toHaveLength(3)
      expect(parsed.memories.find((m) => m.uri === 'home://wifi')).toMatchObject({
        sensitivity: 'secret',
        content: '无线密码 hunter2-secret',
      })
      expect(parsed.credentials.map((c) => c.identifier).sort()).toEqual(['legacy', 'mail', 'nas'])
      expect(parsed.credentials.find((c) => c.identifier === 'nas')!.source).toEqual({
        kind: 'hosted',
        values: { password: 'nas-pass', user: 'admin' },
      })
      expect(parsed.credentials.find((c) => c.identifier === 'mail')!.source).toMatchObject({
        kind: 'external',
        fields: [{ name: 'password', sourceField: 'password' }],
      })
      // 文件里记着导出人是谁
      expect(parsed.header.exporter).toEqual({ displayName: 'alice', dreamPrivate: true })
      // 没有凭据绑着的已删除凭据源（旧的密码本）与 bob 的凭据源都不在
      expect(parsed.providers.map((p) => [p.name, p.deletedAt !== null])).toEqual([
        ['Vaultwarden', false],
        ['换掉的密码本', true],
      ])
      expect(parsed.apps.map((a) => a.slug).sort()).toEqual(['agent', 'bob-app', 'qq-bot'])
      expect(parsed.subjects.map((s) => [s.displayName, s.linkedToExporter]).sort()).toEqual([
        ['小明', true],
        ['小红', false],
        ['读书会', false],
      ])
      // Key、召回事件、召回时的提示语都不在文件里
      const plain = (await plainOf(file)).toString()
      for (const text of [
        agentKey,
        agentKey.slice(0, 12),
        'NAS 在书房吗',
        'bob 的日记',
        'bob 的秘密',
        'bob-secret-token',
        'BOB_MAIL',
        'gone-token',
      ]) {
        expect(plain).not.toContain(text)
      }
      // 托管的值与外部的绑定随文件带走了：给凭据的主人记一条导出的访问事件
      const sourceCredentials = await ok<ConsoleCredentialList>(
        send(source, 'GET', `/v1/spaces/${spaceId}/credentials`, undefined, {
          cookie: alice.cookie,
        }),
      )
      const nasId = sourceCredentials.items.find((c) => c.identifier === 'nas')!.id
      const events = await ok<CredentialEventList>(
        send(source, 'GET', `/v1/spaces/${spaceId}/credentials/${nasId}/events`, undefined, {
          cookie: alice.cookie,
        }),
      )
      expect(events.items[0]).toMatchObject({ type: 'access', via: 'export' })

      // 换成另一个实例：库清空，主密钥也换了一把
      await resetDatabase(database)
      await database.db
        .insert(settings)
        .values({ key: 'recall-started', value: '2000-01-01T00:00:00.000Z' })
        .onConflictDoUpdate({ target: settings.key, set: { value: '2000-01-01T00:00:00.000Z' } })
      const carol = await bootstrap(target, 'carol')
      const cookie = { cookie: carol.cookie }
      // 导入之前先检查：说清是谁导出的、哪些会归导入人，不写库
      const counts = {
        personas: 2,
        apps: 3,
        subjects: 3,
        linkedSubjects: 1,
        memories: 12,
        ownerMemories: 1,
        privateMemories: 3,
        secrets: 1,
        credentials: 3,
        providers: 2,
      }
      const spacesBefore = await spaceCount()
      const preview = await ok<SpaceImportPreview>(inspectRequest(target, carol.cookie, file))
      expect(preview).toEqual({
        exporter: { displayName: 'alice', dreamPrivate: true },
        spaceName: '家',
        exportedAt: parsed.header.createdAt,
        counts,
      })
      expect(await spaceCount()).toBe(spacesBefore)
      const result = await ok<SpaceImportResult>(importRequest(target, carol.cookie, file), 201)
      expect(result).toEqual({
        spaceId: expect.any(String),
        name: '家',
        exporter: { displayName: 'alice', dreamPrivate: true },
        counts,
      })
      expect(backfills).toBe(1)
      const newSpace = result.spaceId
      const me = await ok<Me>(send(target, 'GET', '/v1/auth/me', undefined, cookie))
      expect(me.spaces).toContainEqual({ id: newSpace, name: '家', role: 'owner' })
      const get = <T>(path: string) =>
        ok<T>(send(target, 'GET', `/v1/spaces/${newSpace}${path}`, undefined, cookie))

      // 人格的继承、应用的默认人格与主人、按群换人格都按新的 id 对上
      const personaList = await get<PersonaInfo[]>('/personas')
      const newBase = personaList.find((p) => p.slug === 'zeta-base')!
      const newChild = personaList.find((p) => p.slug === 'alpha-child')!
      expect(newChild.extendsId).toBe(newBase.id)
      const appList = await get<AppInfo[]>('/apps')
      const app = (slug: string) => appList.find((a) => a.slug === slug)!
      expect(app('agent')).toMatchObject({
        defaultPersonaId: newChild.id,
        ownerAccountId: carol.accountId,
      })
      expect(app('qq-bot')).toMatchObject({
        defaultPersonaId: newBase.id,
        runtimeFamily: 'astrbot',
        config: { elevateOwnerDirect: 'internal' },
      })
      expect(app('bob-app').ownerAccountId).toBe(carol.accountId)
      // Key 不在文件里
      expect(await get<unknown[]>(`/apps/${app('agent').id}/keys`)).toEqual([])
      const subjectList = await get<SubjectList>('/subjects')
      const newGroup = subjectList.items.find((s) => s.displayName === '读书会')!
      expect(newGroup.identities).toEqual([
        { platform: 'qq', externalId: '2001', displayName: '读书会' },
      ])
      expect(subjectList.items.find((s) => s.displayName === '小明')!.account?.id).toBe(
        carol.accountId,
      )
      expect(subjectList.items.find((s) => s.displayName === '小红')!.account).toBeNull()
      const rules = await get<GroupPersonaRuleList>(`/apps/${app('qq-bot').id}/group-personas`)
      expect(rules.rules).toEqual([
        { subjectId: newGroup.id, personaId: newChild.id, groupName: '读书会' },
      ])
      expect(await get<DomainLayers>('/domain-layers')).toEqual({
        defaults: { core: 'base', preferences: 'owner' },
      })
      expect(await get<ExtractionUsage>('/extraction-budget')).toMatchObject({
        monthlyTokens: 123_456,
        dailyWritesPerSubject: 7,
        usedTokens: 0,
      })

      // 记忆的正文、层与来源照旧；secret 用这个实例的主密钥重新加密，读得出来
      const read = (uri: string) => get<MemoryView>(`/memories?uri=${encodeURIComponent(uri)}`)
      expect(await read('preferences://user')).toMatchObject({
        layer: 'owner',
        content: '回答用中文',
        provenance: 'owner',
        version: 1,
      })
      expect(await read('home://nas')).toMatchObject({
        layer: 'private',
        sensitivity: 'private',
        glossary: ['NAS', '书房存储'],
        disclosure: '要连 NAS 的时候',
      })
      expect(await read('persona://alpha-child/soul')).toMatchObject({
        layer: 'persona',
        glossary: ['口吻'],
      })
      expect((await read('home://wifi')).content).toBe('无线密码 hunter2-secret')
      const [wifi] = await withSpace(database.db, newSpace, (tx) =>
        tx.select().from(memories).where(eq(memories.path, 'wifi')),
      )
      expect(wifi!.keyId).toBe(keyIdOf(targetKey))
      expect(
        decryptSecret(
          targetKey,
          { ciphertext: wifi!.ciphertext!, wrappedKey: wifi!.wrappedKey! },
          wifi!.id,
        ),
      ).toBe('无线密码 hunter2-secret')
      expect(() =>
        decryptSecret(
          sourceKey,
          { ciphertext: wifi!.ciphertext!, wrappedKey: wifi!.wrappedKey! },
          wifi!.id,
        ),
      ).toThrow()
      // 每条记一条导入事件，历史从这里开始
      const nas = await read('home://nas')
      const history = await get<MemoryHistory>(`/memories/history?id=${nas.id}`)
      expect(history.events.map((e) => e.type)).toEqual(['import'])
      expect(history.events[0]!.after).toMatchObject({ content: nas.content, layer: 'private' })

      // 抽取的事实仍是不可信来源，作用域换成新的群，照样进待审；作用域指向不在的群的，换成另一个不在的群，不会变成全局
      const ming = subjectList.items.find((s) => s.displayName === '小明')!
      const detail = await get<SubjectDetail>(`/subjects/${ming.id}`)
      expect(detail.facts).toMatchObject([
        {
          content: '小明在学日语',
          provenance: 'untrusted',
          scope: { kind: 'group', id: newGroup.id },
        },
      ])
      const review = await get<ReviewList>('/review')
      expect(review.items.map((i) => i.content).sort()).toEqual(
        ['一个已经删掉的群里的摘要', '小明在学日语', '读书会讨论了村上春树'].sort(),
      )
      const scopes = await withSpace(database.db, newSpace, (tx) =>
        tx.execute<{ scope: string }>(
          sql`select origin_scope as scope from memories where content = '一个已经删掉的群里的摘要'`,
        ),
      )
      expect(scopes[0]!.scope).toMatch(/^group:/)
      expect(scopes[0]!.scope).not.toBe(`group:${orphanGroup}`)
      expect(subjectList.items.map((s) => s.id)).not.toContain(scopes[0]!.scope.slice(6))

      // 凭据：托管的值用新的主密钥解得开；占位符照样解析到导入人的凭据；限定的应用换成新的，删掉的应用去掉
      const credentialList = await get<ConsoleCredentialList>('/credentials')
      const newNas = credentialList.items.find((c) => c.identifier === 'nas')!
      expect(newNas).toMatchObject({ source: 'hosted', referenceCount: 1, appIds: null })
      expect(credentialList.items.find((c) => c.identifier === 'mail')).toMatchObject({
        source: 'external',
        location: 'mail-item',
        fields: [{ name: 'password', sourceField: 'password' }],
        provider: { name: 'Vaultwarden', deleted: false },
        appIds: [app('agent').id],
      })
      expect(credentialList.items.find((c) => c.identifier === 'legacy')!.provider).toMatchObject({
        name: '换掉的密码本',
        deleted: true,
      })
      const revealed = await ok<CredentialValues>(
        send(
          target,
          'POST',
          `/v1/spaces/${newSpace}/credentials/${newNas.id}/reveal`,
          undefined,
          cookie,
        ),
      )
      expect(revealed.values).toEqual({ password: 'nas-pass', user: 'admin' })
      const importEvents = await get<CredentialEventList>(`/credentials/${newNas.id}/events`)
      expect(importEvents.items.map((e) => e.type)).toEqual(['access', 'import'])
      // 用新签发的 Key 照样读得到 secret 与托管的值
      const { key: newKey } = await ok<{ key: string }>(
        send(
          target,
          'POST',
          `/v1/spaces/${newSpace}/apps/${app('agent').id}/keys`,
          { name: 'agent', scopes: FULL_SCOPES },
          cookie,
        ),
        201,
      )
      expect(
        (
          await ok<MemoryView>(
            send(target, 'GET', '/v1/memories?uri=home%3A%2F%2Fwifi', undefined, bearer(newKey)),
          )
        ).content,
      ).toBe('无线密码 hunter2-secret')
      expect(
        (
          await ok<CredentialAccess>(
            send(target, 'GET', '/v1/credentials?identifier=nas', undefined, bearer(newKey)),
          )
        ).values,
      ).toEqual({ password: 'nas-pass', user: 'admin' })

      // 召回统计没带过来：记忆保留了原来的建立时间，但新空间刚建，还不算「从没被召回」
      const overview = await get<SpaceOverview>('/overview')
      expect(overview.total).toBeGreaterThan(0)
      expect(overview.neverRecalled).toBe(0)
      // 这个空间的召回事件从导入时才开始记
      const recallStats = await get<RecallStats>('/recall/stats')
      expect(new Date(recallStats.recordingSince).getTime()).toBeGreaterThan(Date.now() - 600_000)
      expect(recallStats.top).toEqual([])
    },
  )

  it(
    '已过期的策展记忆与被推翻的事实按管理读取一起导出，导入后有效期不变、能重新生效；删掉的、到期的会话摘要、别的成员的私人层不带',
    { timeout: 30_000 },
    async () => {
      const alice = await bootstrap(source, 'alice')
      const spaceId = alice.spaceId
      const cookie = { cookie: alice.cookie }
      const bob = await addMember(database.db, spaceId, 'bob', 'editor')
      const memory = (body: object, who = cookie) =>
        ok<MemoryView>(send(source, 'POST', `/v1/spaces/${spaceId}/memories`, body, who), 201)
      const past = new Date(Date.now() - 3_600_000)
      const expire = (id: string) =>
        withSpace(database.db, spaceId, (tx) =>
          tx.update(memories).set({ validTo: past }).where(eq(memories.id, id)),
        )

      const plan = await memory({ uri: 'home://plan', content: '十月的旅行计划' })
      await expire(plan.id)
      // 共享节点过期之后，只能写私人层的 Key 在同一个 URI 写了个人节点：它让不出共享节点，两条并存
      const shared = await memory({ uri: 'core://taken', content: '过期的共享节点', layer: 'base' })
      await expire(shared.id)
      const agent = await alice.createApp('agent')
      const privateOnly = await alice.issueKey(agent.id, {
        ...FULL_SCOPES,
        writeLayers: ['private'],
      })
      await ok(
        send(
          source,
          'POST',
          '/v1/memories',
          { uri: 'core://taken', content: '现在的个人节点', layer: 'private' },
          bearer(privateOnly),
        ),
        201,
      )
      await memory({ uri: 'home://gone', content: '删掉的' })
      await ok(
        send(
          source,
          'DELETE',
          `/v1/spaces/${spaceId}/memories?uri=home%3A%2F%2Fgone`,
          undefined,
          cookie,
        ),
        204,
      )
      const bobs = await memory(
        { uri: 'bob://old', content: 'bob 过期的日记' },
        { cookie: bob.cookie },
      )
      await expire(bobs.id)
      // 对象上被推翻的与现在的事实，到期的与没到期的会话摘要
      await withSpace(database.db, spaceId, async (tx) => {
        const [ming] = await tx
          .insert(subjects)
          .values({ spaceId, kind: 'person', displayName: '小明' })
          .returning()
        const extracted = {
          spaceId,
          form: 'extracted' as const,
          sensitivity: 'public' as const,
          provenance: 'owner' as const,
        }
        await tx.insert(memories).values([
          { ...extracted, layer: 'subject', subjectId: ming!.id, content: '小明在学法语' },
          { ...extracted, layer: 'subject', subjectId: ming!.id, content: '小明在学日语' },
          { ...extracted, layer: 'episode', content: '到期的会话摘要', expiresAt: past },
          {
            ...extracted,
            layer: 'episode',
            content: '没到期的会话摘要',
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        ])
        await tx.update(memories).set({ validTo: past }).where(eq(memories.content, '小明在学法语'))
      })

      const file = await exportSpace(source, spaceId, alice.cookie)
      const parsed = await contents(file)
      const byContent = new Map(parsed.memories.map((m) => [m.content, m]))
      expect([...byContent.keys()].sort()).toEqual(
        [
          '十月的旅行计划',
          '过期的共享节点',
          '现在的个人节点',
          '小明在学法语',
          '小明在学日语',
          '没到期的会话摘要',
        ].sort(),
      )
      expect(byContent.get('十月的旅行计划')!.validTo).toBe(past.toISOString())
      expect(byContent.get('小明在学法语')!.validTo).toBe(past.toISOString())

      // 导入成新空间：有效期照原样，过期的与被推翻的照样读不到
      const imported = await ok<SpaceImportResult>(
        importRequest(source, alice.cookie, file, PASSPHRASE, '搬过来的'),
        201,
      )
      const space = imported.spaceId
      const rows = await withSpace(database.db, space, (tx) =>
        tx
          .select({
            content: memories.content,
            validTo: memories.validTo,
            expiresAt: memories.expiresAt,
          })
          .from(memories),
      )
      for (const row of rows) {
        const record = byContent.get(row.content!)!
        expect(row.validTo?.toISOString() ?? null).toBe(record.validTo)
        expect(row.expiresAt?.toISOString() ?? null).toBe(record.expiresAt)
      }
      const get = <T>(path: string) =>
        ok<T>(send(source, 'GET', `/v1/spaces/${space}${path}`, undefined, cookie))
      const byUri = (uri: string) =>
        send(
          source,
          'GET',
          `/v1/spaces/${space}/memories?uri=${encodeURIComponent(uri)}`,
          undefined,
          cookie,
        )
      expect((await byUri('home://plan')).status).toBe(404)
      expect((await ok<MemoryView>(byUri('core://taken'))).content).toBe('现在的个人节点')

      // 已过期的在「已过期」里，能重新生效；共享节点的 URI 被个人节点占着，和原来的空间一样不能重新生效
      const expiredList = await get<ExpiredMemoryList>('/memories/expired')
      const expiredOf = (uri: string) => expiredList.items.find((m) => m.uri === uri)!
      expect(expiredList.items.map((m) => m.uri).sort()).toEqual(['core://taken', 'home://plan'])
      const reactivate = (item: ExpiredMemoryList['items'][number]) =>
        send(
          source,
          'POST',
          `/v1/spaces/${space}/memories/reactivate`,
          { memoryId: item.id, expectedVersion: item.version },
          cookie,
        )
      await ok(reactivate(expiredOf('home://plan')))
      expect((await ok<MemoryView>(byUri('home://plan'))).content).toBe('十月的旅行计划')
      expect((await reactivate(expiredOf('core://taken'))).status).toBe(409)

      // 被推翻的事实在对象页上，能重新生效
      const people = await get<SubjectList>('/subjects')
      const ming = people.items.find((s) => s.displayName === '小明')!
      const detail = await get<SubjectDetail>(`/subjects/${ming.id}`)
      expect(detail.facts.map((f) => f.content)).toEqual(['小明在学日语'])
      const [superseded] = detail.supersededFacts
      expect(superseded).toMatchObject({ content: '小明在学法语', supersededBy: null })
      await ok(
        send(
          source,
          'POST',
          `/v1/spaces/${space}/subjects/${ming.id}/facts/${superseded!.id}/reactivate`,
          { version: superseded!.version },
          cookie,
        ),
        204,
      )
      const after = await get<SubjectDetail>(`/subjects/${ming.id}`)
      expect(after.facts.map((f) => f.content).sort()).toEqual(['小明在学日语', '小明在学法语'])
      expect(after.supersededFacts).toEqual([])
    },
  )

  it(
    '导入到同一个实例的另一个空间：名字可以另填，原来的空间不受影响',
    { timeout: 30_000 },
    async () => {
      const { alice, spaceId } = await seed()
      const file = await exportSpace(source, spaceId, alice.cookie)
      const copy = await ok<SpaceImportResult>(
        importRequest(source, alice.cookie, file, PASSPHRASE, '  家的副本 '),
        201,
      )
      expect(copy.name).toBe('家的副本')
      expect(copy.spaceId).not.toBe(spaceId)
      const read = (space: string, uri: string) =>
        ok<MemoryView>(
          send(
            source,
            'GET',
            `/v1/spaces/${space}/memories?uri=${encodeURIComponent(uri)}`,
            undefined,
            { cookie: alice.cookie },
          ),
        )
      const original = await read(spaceId, 'home://wifi')
      const copied = await read(copy.spaceId, 'home://wifi')
      expect(copied.content).toBe(original.content)
      expect(copied.id).not.toBe(original.id)
      // 同一个实例里两个空间的凭据互不相干
      expect((await read(copy.spaceId, 'home://nas')).content).toContain('{{cred:nas#password}}')
      expect(await spaceCount()).toBe(2)
    },
  )

  it('空空间也能导出导入，导入时没填名字就用导出时的空间名', async () => {
    const alice = await bootstrap(source, 'alice')
    const file = await exportSpace(source, alice.spaceId, alice.cookie)
    const parsed = await contents(file)
    expect(parsed.memories).toEqual([])
    expect(parsed.personas).toEqual([])
    const result = await ok<SpaceImportResult>(
      importRequest(source, alice.cookie, file, PASSPHRASE, ''),
      201,
    )
    expect(result).toMatchObject({
      name: '家',
      counts: {
        personas: 0,
        apps: 0,
        subjects: 0,
        memories: 0,
        secrets: 0,
        credentials: 0,
        providers: 0,
      },
    })
  })

  it('导出人关掉的 Dream 整理画像层与私人层跟着文件走：导入人在新空间里也关着；文件格式升到 2，格式 1 的旧文件按开着，更新的格式拒收', async () => {
    const alice = await bootstrap(source, 'alice')
    const bob = await addMember(database.db, alice.spaceId, 'bob', 'editor')
    const cookie = { cookie: alice.cookie }
    const mine = (spaceId: string, who = cookie) =>
      ok<DreamMemberSettings>(send(source, 'GET', `/v1/spaces/${spaceId}/me/dream`, undefined, who))
    await ok(
      send(
        source,
        'PUT',
        `/v1/spaces/${alice.spaceId}/me/dream`,
        { includePrivate: false },
        cookie,
      ),
    )
    // 别的成员的设置不进文件，也不影响导出人那一项
    await ok(
      send(
        source,
        'PUT',
        `/v1/spaces/${alice.spaceId}/me/dream`,
        { includePrivate: true },
        { cookie: bob.cookie },
      ),
    )
    const file = await exportSpace(source, alice.spaceId, alice.cookie)
    expect((await contents(file)).header.exporter).toEqual({
      displayName: 'alice',
      dreamPrivate: false,
    })
    expect(
      (await ok<SpaceImportPreview>(inspectRequest(source, alice.cookie, file))).exporter,
    ).toEqual({ displayName: 'alice', dreamPrivate: false })
    const imported = await ok<SpaceImportResult>(importRequest(source, alice.cookie, file), 201)
    expect(await mine(imported.spaceId)).toEqual({ includePrivate: false })

    // 打开之后再导出：文件里是开着的
    await ok(
      send(source, 'PUT', `/v1/spaces/${alice.spaceId}/me/dream`, { includePrivate: true }, cookie),
    )
    const reopened = await exportSpace(source, alice.spaceId, alice.cookie)
    expect((await contents(reopened)).header.exporter.dreamPrivate).toBe(true)
    const again = await ok<SpaceImportResult>(importRequest(source, alice.cookie, reopened), 201)
    expect(await mine(again.spaceId)).toEqual({ includePrivate: true })

    // 带上这一项之后文件格式是 2，2 的文件里必须有它
    expect((await contents(file)).header.version).toBe(2)
    const missing = await importRequest(
      source,
      alice.cookie,
      await craft([], { ...header(), exporter: { displayName: '漏了的人' } }),
    )
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: string }).error).toContain(
      '第 1 行 exporter.dreamPrivate',
    )

    // 格式 1 的文件（有这一项之前导出的）照样认：那时还关不掉，按开着
    const older = await ok<SpaceImportResult>(
      importRequest(
        source,
        alice.cookie,
        await craft([], { ...header(), version: 1, exporter: { displayName: '旧版本导出的人' } }),
      ),
      201,
    )
    expect(older.exporter).toEqual({ displayName: '旧版本导出的人', dreamPrivate: true })
    expect(await mine(older.spaceId)).toEqual({ includePrivate: true })

    // 认不得的更新的格式拒收，不悄悄丢掉不认识的内容（只认 1 的旧版本遇到 2 也是这样）
    const newer = await inspectRequest(
      source,
      alice.cookie,
      await craft([], { ...header(), version: 3 }),
    )
    expect(newer.status).toBe(400)
    expect(((await newer.json()) as { error: string }).error).toBe(
      '导出文件的格式版本是 3，这个版本的 Kioku 认 1 到 2：升级到导出它的版本（或更新的）再导入',
    )
  })

  it('只有空间 owner 能导出，只有实例管理员能导入', async () => {
    const alice = await bootstrap(source, 'alice')
    const bob = await addMember(database.db, alice.spaceId, 'bob', 'editor')
    const stranger = await addMember(database.db, alice.spaceId, 'dave', 'owner')
    // dave 是 owner，但不是实例管理员；另建一个他不在的空间
    const [other] = await database.db.insert(spaces).values({ name: '别人的' }).returning()
    expect((await exportRequest(source, alice.spaceId, bob.cookie)).status).toBe(403)
    expect((await exportRequest(source, other!.id, alice.cookie)).status).toBe(403)
    expect((await exportRequest(source, alice.spaceId, 'kioku_session=nope')).status).toBe(401)
    expect((await exportRequest(source, alice.spaceId, alice.cookie, '太短的口令')).status).toBe(
      400,
    )
    const file = await exportSpace(source, alice.spaceId, stranger.cookie)
    const before = await spaceCount()
    const denied = await importRequest(source, stranger.cookie, file)
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { error: string }).error).toBe('只有实例管理员能导入空间')
    expect((await importRequest(source, bob.cookie, file)).status).toBe(403)
    expect((await inspectRequest(source, stranger.cookie, file)).status).toBe(403)
    expect(await spaceCount()).toBe(before)
  })

  it('口令不对、文件被改过、不是导出文件时拒绝，什么都不留下', { timeout: 30_000 }, async () => {
    const { alice, spaceId } = await seed()
    const file = await exportSpace(source, spaceId, alice.cookie)
    const before = await spaceCount()
    const rejected = async (res: Response, message: string) => {
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain(message)
    }
    await rejected(await importRequest(source, alice.cookie, file, 'wrong passphrase'), '口令不对')
    await rejected(await inspectRequest(source, alice.cookie, file, 'wrong passphrase'), '口令不对')
    const tampered = Buffer.from(file)
    tampered[tampered.length - 100]! ^= 1
    await rejected(await importRequest(source, alice.cookie, tampered), '文件不完整或被改过')
    await rejected(
      await importRequest(source, alice.cookie, file.subarray(0, file.length - 10)),
      '文件不完整或被改过',
    )
    await rejected(
      await importRequest(source, alice.cookie, Buffer.from('not a kioku file at all, really')),
      '不是 Kioku 的空间导出文件',
    )
    const missing = await target.request('/v1/spaces/import', {
      method: 'POST',
      headers: { ...sameSite, cookie: alice.cookie },
      body: new FormData(),
    })
    expect(missing.status).toBe(400)
    expect(await spaceCount()).toBe(before)
  })

  it(
    '目标实例没配主密钥而文件里有 secret 或托管的值时拒绝导入，并说清原因',
    { timeout: 30_000 },
    async () => {
      const { alice, spaceId } = await seed()
      const file = await exportSpace(source, spaceId, alice.cookie)
      const before = await spaceCount()
      const res = await importRequest(appWith(null), alice.cookie, file)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe(
        '文件里有 1 条 secret 记忆和 1 条托管的凭据，要用主密钥加密保存，这个实例没有配置 KIOKU_MASTER_KEY：配好主密钥、重启服务之后再导入',
      )
      expect(await spaceCount()).toBe(before)
      // 没有要加密的内容时照样能导入
      const plain = await craft([curated('home://plain')])
      expect((await importRequest(appWith(null), alice.cookie, plain)).status).toBe(201)
    },
  )

  it('上传超过大小上限时返回 413，不读进来', async () => {
    const alice = await bootstrap(source, 'alice')
    const res = await importRequest(
      source,
      alice.cookie,
      new Blob([new Uint8Array(33 * 1024 * 1024)]),
    )
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('文件超过 32 MB 的上限')
  })

  it('超大的上传马上 413：先看大小、读完表单才拿名额，不排队也不占名额', async () => {
    const alice = await bootstrap(source, 'alice')
    // 正在做的与排队的名额都满了：先拿名额的话就是 429
    const running = await acquireTransferSlot('other-0')
    const queued = Array.from({ length: 4 }, (_, i) => acquireTransferSlot(`other-${i + 1}`))
    const huge = new Blob([new Uint8Array(33 * 1024 * 1024)])
    for (const send of [importRequest, inspectRequest]) {
      expect((await send(source, alice.cookie, huge)).status).toBe(413)
    }
    expect(queuedTransfers()).toBe(4)
    running()
    for (const next of queued) (await next)()
  })

  it('文件里的内容对不上时拒绝：URI 冲突、继承成环、层与 URI 不符、指向不在的对象', async () => {
    const alice = await bootstrap(source, 'alice')
    const before = await spaceCount()
    const importing = async (records: SpaceExportRecord[], message: string) => {
      const res = await importRequest(source, alice.cookie, await craft(records))
      expect(res.status, await res.clone().text()).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain(message)
    }
    const persona = (id: string, slug: string, extendsId: string | null) => ({
      type: 'persona' as const,
      id,
      slug,
      name: slug,
      extendsId,
      description: null,
      createdAt: now,
      updatedAt: now,
    })
    await importing(
      [curated('core://agent', { layer: 'base', sensitivity: 'public' }), curated('core://agent')],
      '既有有效的共享记忆，又有有效的个人记忆',
    )
    await importing([curated('home://a'), curated('home://a')], '第 3 行记忆 home://a 的 URI 重复')
    // 同一归属里过期的也算重复（唯一索引不看有效期）
    await importing(
      [curated('home://a', { validTo: '2020-01-01T00:00:00.000Z' }), curated('home://a')],
      '第 3 行记忆 home://a 的 URI 重复',
    )
    const [a, b] = [randomUUID(), randomUUID()]
    await importing([persona(a, 'a', b), persona(b, 'b', a)], '继承关系成环')
    await importing(
      [persona(a, 'a', null), curated('persona://b/soul', { layer: 'persona', personaId: a })],
      '不在它的人格 a 下面',
    )
    await importing([curated('persona://a/soul', { layer: 'base' })], '却是 base 层')
    await importing(
      [curated('home://x', { layer: 'base', provenance: 'untrusted' })],
      '来自不可信来源，只能在对象层或情节层',
    )
    await importing(
      [
        {
          type: 'identity',
          subjectId: randomUUID(),
          kind: 'person',
          platform: 'qq',
          externalId: '1',
          displayName: null,
          createdAt: now,
        },
      ],
      '挂的对象不在文件里',
    )
    // 数据库存不下的值在检查文件时就挡下，说清是第几行：公元 0 年的时间、NUL 字符
    await importing(
      [curated('home://old', { createdAt: '0000-06-01T00:00:00.000Z' })],
      '第 2 行 createdAt：不是有效的时间',
    )
    await importing(
      [curated('home://nul', { content: '前\u0000后' })],
      '第 2 行 content：含有存不进数据库的字符（NUL 或落单的代理项）',
    )
    expect(await spaceCount()).toBe(before)
  })

  it('写文件里来的值时数据库拒绝（值超出范围、违反约束）算文件的问题，说清是哪几行；派生的出错照常 500，都记日志', async () => {
    const alice = await bootstrap(source, 'alice')
    const before = await spaceCount()
    // 模拟数据库拒绝某个值：对象的名字是「坏的」时报 22 类错误，是「冲突的」时报违反约束；
    // 关键词是「坏关键词」时也报违反约束（关键词是文件里的值，算文件的问题）；
    // 正文是「事件出错」的记忆，写它的导入事件时报违反约束（导入事件是服务端派生的，不算文件的问题）
    await database.db.execute(
      sql.raw(`create or replace function kioku_test_reject() returns trigger language plpgsql as $$
      begin
        -- 按表分开判断：PL/pgSQL 不短路，别的表的行上没有这些字段
        if tg_table_name = 'subjects' then
          if new.display_name = '坏的' then
            raise exception '时间超出范围' using errcode = 'datetime_field_overflow';
          end if;
          if new.display_name = '冲突的' then
            raise exception '冲突' using errcode = 'check_violation', constraint = 'kioku_test_check';
          end if;
        elsif tg_table_name = 'memory_glossary' then
          if new.keyword = '坏关键词' then
            raise exception '冲突' using errcode = 'check_violation', constraint = 'kioku_test_check';
          end if;
        elsif new.after ->> 'content' = '事件出错' then
          raise exception '冲突' using errcode = 'check_violation', constraint = 'kioku_test_check';
        end if;
        return new;
      end $$`),
    )
    for (const table of ['subjects', 'memory_glossary', 'memory_events']) {
      await database.db.execute(sql.raw(`drop trigger if exists kioku_test_reject on ${table}`))
      await database.db.execute(
        sql.raw(
          `create trigger kioku_test_reject before insert on ${table} for each row execute function kioku_test_reject()`,
        ),
      )
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const subject = (displayName: string): SpaceExportRecord => ({
        type: 'subject',
        id: randomUUID(),
        kind: 'person',
        displayName,
        nameLocked: false,
        linkedToExporter: false,
        createdAt: now,
        updatedAt: now,
      })
      const wasLogged = (step: string, code: string, constraint?: string) =>
        logged.mock.calls.some(
          ([message, detail]) =>
            String(message).includes(step) &&
            (detail as { code?: string }).code === code &&
            (detail as { constraint?: string }).constraint === constraint,
        )
      const rejected = async (name: string, message: string) => {
        const file = await craft([curated('home://a'), subject('好的'), subject(name)])
        const res = await importRequest(source, alice.cookie, file)
        expect(res.status, await res.clone().text()).toBe(400)
        expect(((await res.json()) as { error: string }).error).toBe(message)
      }
      await rejected('坏的', '导出文件的内容不对：第 3–4 行的对象写不进数据库（时间超出范围）')
      expect(wasLogged('第 3–4 行的对象', '22008')).toBe(true)
      await rejected(
        '冲突的',
        '导出文件的内容不对：第 3–4 行的对象写不进数据库（违反了约束 kioku_test_check）',
      )
      expect(wasLogged('第 3–4 行的对象', '23514', 'kioku_test_check')).toBe(true)
      // 关键词是文件里的值：写不进去算文件的问题
      const keyword = await importRequest(
        source,
        alice.cookie,
        await craft([curated('home://a', { glossary: ['坏关键词'] })]),
      )
      expect(keyword.status, await keyword.clone().text()).toBe(400)
      expect(((await keyword.json()) as { error: string }).error).toBe(
        '导出文件的内容不对：第 2 行的记忆的关键词写不进数据库（违反了约束 kioku_test_check）',
      )
      expect(wasLogged('第 2 行的记忆的关键词', '23514', 'kioku_test_check')).toBe(true)
      // 导入事件是服务端派生的：出错是服务端的缺陷，不说成文件的问题
      const derived = await importRequest(
        source,
        alice.cookie,
        await craft([curated('home://a', { content: '事件出错' })]),
      )
      expect(derived.status).toBe(500)
      expect(((await derived.json()) as { error: string }).error).toBe('服务内部错误')
      expect(wasLogged('第 2 行的记忆的导入事件', '23514', 'kioku_test_check')).toBe(true)
      expect(await spaceCount()).toBe(before)
    } finally {
      logged.mockRestore()
      for (const table of ['subjects', 'memory_glossary', 'memory_events']) {
        await database.db.execute(sql.raw(`drop trigger if exists kioku_test_reject on ${table}`))
      }
      await database.db.execute(sql.raw('drop function if exists kioku_test_reject()'))
    }
  })

  it('文件里的文字有存不进数据库的字符（落单的代理项、NUL）：返回 400，指出是哪一行、哪个字段', async () => {
    const alice = await bootstrap(source, 'alice')
    const before = await spaceCount()
    const rejected = async (records: SpaceExportRecord[], where: string) => {
      const res = await importRequest(source, alice.cookie, await craft(records))
      expect(res.status, await res.clone().text()).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe(
        `导出文件的内容不对：${where}：含有存不进数据库的字符（NUL 或落单的代理项）`,
      )
    }
    // JSON 里的 "\ud800" 解出来是落单的代理项：写进 text 会被换成 U+FFFD，写进 jsonb（导入事件）会报错
    await rejected(
      [curated('home://a'), curated('home://b', { content: '半个\ud800字' })],
      '第 3 行 content',
    )
    await rejected([curated('home://a', { glossary: ['好的', '\udc00坏'] })], '第 2 行 glossary.1')
    await rejected([curated('home://a', { disclosure: '有\u0000的' })], '第 2 行 disclosure')
    // 外部凭据的条目位置用的是接口的定义，也一样查
    const provider = randomUUID()
    await rejected(
      [
        {
          type: 'provider',
          id: provider,
          kind: 'bitwarden',
          name: 'Vaultwarden',
          instructions: '',
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          type: 'credential',
          id: randomUUID(),
          identifier: 'mail',
          name: '邮箱',
          description: null,
          source: {
            kind: 'external',
            providerId: provider,
            location: 'mail\ud800item',
            fields: [{ name: 'password', sourceField: 'password' }],
          },
          appIds: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      '第 3 行 source.location',
    )
    expect(await spaceCount()).toBe(before)
  })

  it('外部凭据没有字段、或者字段重名：导入时被拒，导出时也被拒', async () => {
    const alice = await bootstrap(source, 'alice')
    const cookie = { cookie: alice.cookie }
    const space = alice.spaceId
    const provider = randomUUID()
    const external = (fields: { name: string; sourceField: string }[]): SpaceExportRecord[] => [
      {
        type: 'provider',
        id: provider,
        kind: 'bitwarden',
        name: 'Vaultwarden',
        instructions: '',
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        type: 'credential',
        id: randomUUID(),
        identifier: 'mail',
        name: '邮箱',
        description: null,
        source: { kind: 'external', providerId: provider, location: 'mail-item', fields },
        appIds: null,
        createdAt: now,
        updatedAt: now,
      },
    ]
    const before = await spaceCount()
    for (const [fields, message] of [
      [[], '第 3 行 source.fields：至少要有一个字段'],
      [
        [
          { name: 'password', sourceField: 'a' },
          { name: 'password', sourceField: 'b' },
        ],
        '第 3 行 source.fields：字段名不能重复',
      ],
    ] as const) {
      const res = await importRequest(source, alice.cookie, await craft(external([...fields])))
      expect(res.status, await res.clone().text()).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain(message)
    }
    expect(await spaceCount()).toBe(before)

    const vault = await ok<{ id: string }>(
      send(
        source,
        'POST',
        `/v1/spaces/${space}/credential-providers`,
        { kind: 'bitwarden', name: 'Vaultwarden' },
        cookie,
      ),
      201,
    )
    await ok(
      send(
        source,
        'POST',
        `/v1/spaces/${space}/credentials`,
        {
          identifier: 'mail',
          name: '邮箱',
          source: {
            kind: 'external',
            providerId: vault.id,
            location: 'mail-item',
            fields: [{ name: 'password', sourceField: 'password' }],
          },
        },
        cookie,
      ),
      201,
    )
    for (const [fields, message] of [
      ['[]', '凭据 mail 导出后导入不了（source.fields：至少要有一个字段）'],
      [
        '[{"name":"password","sourceField":"a"},{"name":"password","sourceField":"b"}]',
        '凭据 mail 导出后导入不了（source.fields：字段名不能重复）',
      ],
    ] as const) {
      await withSpace(database.db, space, (tx) =>
        tx.execute(sql`update credentials set fields = ${fields}::jsonb where identifier = 'mail'`),
      )
      const res = await exportRequest(source, space, alice.cookie)
      expect(res.status, await res.clone().text()).toBe(409)
      expect(((await res.json()) as { error: string }).error).toContain(message)
    }
  })

  it(
    '托管的凭据或 secret 记忆解不开、或者有导出了也导入不了的内容时，导出停下并点名是哪一条',
    { timeout: 30_000 },
    async () => {
      const alice = await bootstrap(source, 'alice')
      const cookie = { cookie: alice.cookie }
      const space = alice.spaceId
      const inSpace = (query: ReturnType<typeof sql>) =>
        withSpace(database.db, space, (tx) => tx.execute(query))
      const failing = async (message: string) => {
        const res = await exportRequest(source, space, alice.cookie)
        expect(res.status, await res.clone().text()).toBe(409)
        expect(((await res.json()) as { error: string }).error).toContain(message)
      }
      await ok(
        send(
          source,
          'POST',
          `/v1/spaces/${space}/credentials`,
          { identifier: 'nas', name: 'NAS', source: { kind: 'hosted', values: { password: 'p' } } },
          cookie,
        ),
        201,
      )
      await inSpace(sql`update credentials set ciphertext = ${randomBytes(48)}`)
      await failing('托管的凭据 nas 解不开')
      await inSpace(sql`update credentials set deleted_at = now()`)

      await ok(
        send(
          source,
          'POST',
          `/v1/spaces/${space}/memories`,
          { uri: 'home://wifi', content: '无线密码', sensitivity: 'secret' },
          cookie,
        ),
        201,
      )
      await inSpace(sql`update memories set wrapped_key = ${randomBytes(60)}`)
      await failing('secret 记忆 home://wifi 解不开')
      await inSpace(sql`update memories set deleted_at = now()`)

      // 规则收紧之前存下的条目位置（带分号）：导出了也导入不了，导出时就点名
      const vault = await ok<{ id: string }>(
        send(
          source,
          'POST',
          `/v1/spaces/${space}/credential-providers`,
          { kind: 'bitwarden', name: 'Vaultwarden' },
          cookie,
        ),
        201,
      )
      await ok(
        send(
          source,
          'POST',
          `/v1/spaces/${space}/credentials`,
          {
            identifier: 'mail',
            name: '邮箱',
            source: {
              kind: 'external',
              providerId: vault.id,
              location: 'mail-item',
              fields: [{ name: 'password', sourceField: 'password' }],
            },
          },
          cookie,
        ),
        201,
      )
      await inSpace(sql`update credentials set location = 'mail;item' where identifier = 'mail'`)
      await failing('凭据 mail 导出后导入不了（source.location：')
      // 导出没做成：不记导出的访问事件
      const [row] = await inSpace(
        sql`select count(*)::int as n from credential_events where event_type = 'access'`,
      )
      expect(row).toEqual({ n: 0 })
    },
  )

  // 等到条件成立（例如请求已经排进队里），最多等 5 秒
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (const started = Date.now(); !(await check());) {
      if (Date.now() - started > 5000) throw new Error('等不到条件成立')
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const busy = async (res: Response) => {
    expect(res.status, await res.clone().text()).toBe(429)
    expect(((await res.json()) as { error: string }).error).toBe('导出导入正忙，稍后再试')
  }
  // 带着断开信号导出：测客户端断开
  const exportWithSignal = (spaceId: string, cookie: string, signal: AbortSignal) =>
    Promise.resolve(
      source.request(`/v1/spaces/${spaceId}/export`, {
        ...jsonRequest('POST', { passphrase: PASSPHRASE }, { cookie }),
        signal,
      }),
    )
  // 最多等 3 秒：等不到时报错，后面的清理照样做
  const within = <T>(promise: Promise<T>, ms = 3000) =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('等不到结果')), ms)),
    ])
  // 另开一条连接锁住一张表：导出读到它时就卡在锁上。body 做完（或者调了 unlock）才放锁
  const whileLocked = async (table: string, body: (unlock: () => void) => Promise<void>) => {
    const locker = connect(testDatabaseUrl!, { max: 1 })
    let unlock!: () => void
    const unlocked = new Promise<void>((resolve) => (unlock = resolve))
    let taken!: () => void
    const lockTaken = new Promise<void>((resolve) => (taken = resolve))
    const holding = locker.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`lock table ${table} in access exclusive mode`))
      taken()
      await unlocked
    })
    try {
      await Promise.race([lockTaken, holding])
      await body(unlock)
    } finally {
      unlock()
      await holding
      await locker.close()
    }
  }
  // 有请求卡在表锁上
  const blockedOnLock = async () => {
    const [row] = await database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    )
    return row!.n > 0
  }
  // 名额空着：别人来拿不用排队
  const slotFree = async () => {
    const next = acquireTransferSlot('next')
    expect(queuedTransfers()).toBe(0)
    ;(await next)()
  }

  it('导出导入正忙时，导出、检查与导入都直接返回 429，放开之后照常', async () => {
    const alice = await bootstrap(source, 'alice')
    const file = await exportSpace(source, alice.spaceId, alice.cookie)
    // 同一个账号已经占着一个名额
    const mine = await acquireTransferSlot(alice.accountId)
    await busy(await exportRequest(source, alice.spaceId, alice.cookie))
    await busy(await importRequest(source, alice.cookie, file))
    await busy(await inspectRequest(source, alice.cookie, file))
    mine()
    // 别的账号占满了运行与排队的名额
    const running = await acquireTransferSlot('other-0')
    const queued = Array.from({ length: 4 }, (_, i) => acquireTransferSlot(`other-${i + 1}`))
    await busy(await exportRequest(source, alice.spaceId, alice.cookie))
    running()
    for (const next of queued) (await next)()
    await exportSpace(source, alice.spaceId, alice.cookie)
  })

  it('一个导入还在写库时，别的导出、检查与导入都在排队，做完一个才轮到下一个', async () => {
    const alice = await bootstrap(source, 'alice')
    const bob = await addMember(database.db, alice.spaceId, 'bob', 'owner')
    // 让导入卡在写库这一步：对象的名字是「慢的」时触发器睡一会儿
    await database.db.execute(
      sql.raw(`create or replace function kioku_test_slow() returns trigger language plpgsql as $$
      begin
        if new.display_name = '慢的' then perform pg_sleep(1); end if;
        return new;
      end $$`),
    )
    await database.db.execute(sql.raw('drop trigger if exists kioku_test_slow on subjects'))
    await database.db.execute(
      sql.raw(
        'create trigger kioku_test_slow before insert on subjects for each row execute function kioku_test_slow()',
      ),
    )
    try {
      const file = await craft([
        {
          type: 'subject',
          id: randomUUID(),
          kind: 'person',
          displayName: '慢的',
          nameLocked: false,
          linkedToExporter: false,
          createdAt: now,
          updatedAt: now,
        },
      ])
      const finished: string[] = []
      const importing = Promise.resolve(importRequest(source, alice.cookie, file)).then((res) => {
        finished.push('import')
        return res
      })
      // 导入已经在写库（触发器睡着）时，bob 的导出进来：排在后面，不同时做
      await until(async () => {
        const [row] = await database.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep'`,
        )
        return row!.n > 0
      })
      const exporting = Promise.resolve(exportRequest(source, alice.spaceId, bob.cookie)).then(
        async (res) => {
          finished.push('export')
          expect(res.status, await res.clone().text()).toBe(200)
          await res.arrayBuffer()
        },
      )
      await until(() => queuedTransfers() === 1)
      expect(finished).toEqual([])
      expect((await importing).status).toBe(201)
      await exporting
      expect(finished).toEqual(['import', 'export'])
    } finally {
      await database.db.execute(sql.raw('drop trigger if exists kioku_test_slow on subjects'))
      await database.db.execute(sql.raw('drop function if exists kioku_test_slow()'))
    }
  })

  it('导出的文件发完才放名额：文件还在等着发时，别的导出在排队', async () => {
    const alice = await bootstrap(source, 'alice')
    const bob = await addMember(database.db, alice.spaceId, 'bob', 'owner')
    const first = await exportRequest(source, alice.spaceId, alice.cookie)
    expect(first.status).toBe(200)
    const second = exportRequest(source, alice.spaceId, bob.cookie)
    await until(() => queuedTransfers() === 1)
    // 第一个的文件读完（发完），才轮到第二个
    expect((await first.arrayBuffer()).byteLength).toBe(Number(first.headers.get('content-length')))
    const res = await second
    expect(res.status, await res.clone().text()).toBe(200)
    await res.arrayBuffer()
  })

  it('排着队的请求断开之后，同一个账号马上能再排', async () => {
    const alice = await bootstrap(source, 'alice')
    const holder = await acquireTransferSlot('holder')
    const controller = new AbortController()
    const leaving = source.request(`/v1/spaces/${alice.spaceId}/export`, {
      ...jsonRequest('POST', { passphrase: PASSPHRASE }, { cookie: alice.cookie }),
      signal: controller.signal,
    })
    await until(() => queuedTransfers() === 1)
    // 它还排着时，同一个账号再来就是 429
    await busy(await exportRequest(source, alice.spaceId, alice.cookie))
    controller.abort()
    await until(() => queuedTransfers() === 0)
    const again = exportRequest(source, alice.spaceId, alice.cookie)
    await until(() => queuedTransfers() === 1)
    holder()
    const res = await again
    expect(res.status, await res.clone().text()).toBe(200)
    await res.arrayBuffer()
    expect((await leaving).status).toBe(400)
  })

  it('拿到响应、文件还没读时客户端断开：没人读响应流，名额照样放掉', async () => {
    const alice = await bootstrap(source, 'alice')
    // node 的服务端在客户端断开之后既不读也不取消这个响应流：读之前名额一直占着，断开就放
    const late = new AbortController()
    const res = await exportWithSignal(alice.spaceId, alice.cookie, late.signal)
    expect(res.status).toBe(200)
    const probe = acquireTransferSlot('probe')
    expect(queuedTransfers()).toBe(1)
    late.abort()
    ;(await probe)()
  })

  it('派生口令期间客户端断开：派生完就停下、马上放掉名额，不再读库', async () => {
    const alice = await bootstrap(source, 'alice')
    const holder = await acquireTransferSlot('holder')
    const controller = new AbortController()
    const leaving = exportWithSignal(alice.spaceId, alice.cookie, controller.signal)
    await until(() => queuedTransfers() === 1)
    // 空间表锁着：派生完要是接着开事务读库，就卡在锁上、一直占着名额
    await whileLocked('spaces', async () => {
      // 轮到它就开始派生，这时断开
      holder()
      controller.abort()
      expect((await within(leaving)).status).toBe(400)
      await slotFree()
    })
  })

  it('读库期间客户端断开：读下一批之前停下，不把文件做完', async () => {
    const alice = await bootstrap(source, 'alice')
    // 记忆表一直锁着：导出要是不停、接着往下读，就卡在它上面
    await whileLocked('memories', async () => {
      await whileLocked('personas', async (unlockPersonas) => {
        const controller = new AbortController()
        const leaving = exportWithSignal(alice.spaceId, alice.cookie, controller.signal)
        // 派生完、开了事务，卡在人格表上时断开，再放开人格表
        await until(blockedOnLock)
        controller.abort()
        unlockPersonas()
        expect((await within(leaving)).status).toBe(400)
        await slotFree()
      })
    })
  })

  it('读完最后一批时客户端已经断开：文件交不出去，不记凭据的访问事件', async () => {
    const alice = await bootstrap(source, 'alice')
    await ok(
      send(
        source,
        'POST',
        `/v1/spaces/${alice.spaceId}/credentials`,
        { identifier: 'nas', name: 'NAS', source: { kind: 'hosted', values: { password: 'pw' } } },
        { cookie: alice.cookie },
      ),
      201,
    )
    await whileLocked('memories', async (unlockMemories) => {
      const controller = new AbortController()
      const leaving = exportWithSignal(alice.spaceId, alice.cookie, controller.signal)
      // 卡在最后一批（记忆）上时断开：读完这一批就没有下一批了
      await until(blockedOnLock)
      controller.abort()
      unlockMemories()
      expect((await within(leaving)).status).toBe(400)
    })
    const accessed = await withSpace(database.db, alice.spaceId, (tx) =>
      tx.select().from(credentialEvents).where(eq(credentialEvents.eventType, 'access')),
    )
    expect(accessed).toEqual([])
    await slotFree()
  })

  it('导出的文件发完之后不再监听断开', async () => {
    const alice = await bootstrap(source, 'alice')
    const request = new Request(
      `http://localhost/v1/spaces/${alice.spaceId}/export`,
      jsonRequest('POST', { passphrase: PASSPHRASE }, { cookie: alice.cookie }),
    )
    const listeners = () => getEventListeners(request.signal, 'abort').length
    const before = listeners()
    const res = await source.request(request)
    expect(res.status).toBe(200)
    // 文件还没发完：等着客户端断开时放名额
    expect(listeners()).toBe(before + 1)
    await res.arrayBuffer()
    expect(listeners()).toBe(before)
    await slotFree()
  })

  it(
    '一次导入两万条带 URI 的记忆：不为每个 URI 加咨询锁，锁表不会被占满',
    { timeout: 120_000 },
    async () => {
      const alice = await bootstrap(source, 'alice')
      const records = Array.from({ length: 20_000 }, (_, i) =>
        curated(`bulk://n${i}`, { glossary: i % 2 ? ['批量'] : [] }),
      )
      const result = await ok<SpaceImportResult>(
        importRequest(source, alice.cookie, await craft(records)),
        201,
      )
      expect(result.counts.memories).toBe(20_000)
      const [row] = await withSpace(database.db, result.spaceId, (tx) =>
        tx.execute<{ n: number; events: number }>(
          sql`select count(*)::int as n, (select count(*)::int from memory_events) as events from memories`,
        ),
      )
      expect(row).toEqual({ n: 20_000, events: 20_000 })
    },
  )

  it('导出在 withSpace 给的可重复读、只读事务里读', async () => {
    const alice = await bootstrap(source, 'alice')
    const [row] = await withSpace(
      database.db,
      alice.spaceId,
      (tx) =>
        tx.execute<{ isolation: string; readOnly: string; space: string }>(
          sql`select current_setting('transaction_isolation') as isolation,
            current_setting('transaction_read_only') as "readOnly",
            current_setting('app.space_id') as space`,
        ),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
    expect(row).toEqual({ isolation: 'repeatable read', readOnly: 'on', space: alice.spaceId })
  })

  describe('URI 互斥的触发器', () => {
    // 单独的一条连接：这个会话里从来没设过 app.importing_space
    let fresh: Database
    beforeAll(() => {
      fresh = connect(testDatabaseUrl!, { max: 1 })
    })
    afterAll(async () => {
      await fresh?.close()
    })

    const locksAfterInsert = (
      setup: (spaceId: string) => ReturnType<typeof sql>,
      options: { reuse?: string } = {},
    ): Promise<number> =>
      fresh.db.transaction(async (tx) => {
        const spaceId =
          options.reuse ??
          (await tx.insert(spaces).values({ name: 't' }).returning({ id: spaces.id }))[0]!.id
        await tx.execute(setup(spaceId))
        await tx.insert(memories).values(
          ['a', 'b', 'c'].map((path) => ({
            spaceId,
            form: 'curated' as const,
            layer: 'base' as const,
            sensitivity: 'public' as const,
            provenance: 'owner' as const,
            domain: 'core',
            path,
            content: path,
          })),
        )
        const [row] = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`,
        )
        return row!.n
      })

    it('导入的事务里、空间是这个事务刚建的才不加锁；别的情况照常每个 URI 一把', async () => {
      const importing = (id: string) =>
        sql`select set_config('app.space_id', ${id}, true), set_config('app.importing_space', ${id}, true)`
      const plain = (id: string) => sql`select set_config('app.space_id', ${id}, true)`
      // 这个会话里还没设过 app.importing_space（读出来是 NULL），空间是本事务建的：照样加锁
      expect(await locksAfterInsert(plain)).toBe(3)
      expect(await locksAfterInsert(importing)).toBe(0)
      // 设过一次之后读出来是空串：照样加锁
      expect(await locksAfterInsert(plain)).toBe(3)
      // 空间早就提交了，导入的标记对不上它的 xmin：照常加锁
      const [old] = await database.db.insert(spaces).values({ name: 'old' }).returning()
      expect(await locksAfterInsert(importing, { reuse: old!.id })).toBe(3)
    })

    it('不加锁时冲突照样拦下', async () => {
      await expect(
        fresh.db.transaction(async (tx) => {
          const [space] = await tx.insert(spaces).values({ name: 't' }).returning()
          const [account] = await tx.execute<{ id: string }>(
            sql`insert into accounts (username, display_name, password_hash) values ('t', 't', 'x') returning id`,
          )
          await tx.execute(
            sql`select set_config('app.space_id', ${space!.id}, true), set_config('app.importing_space', ${space!.id}, true)`,
          )
          const row = {
            spaceId: space!.id,
            form: 'curated' as const,
            sensitivity: 'private' as const,
            provenance: 'owner' as const,
            domain: 'home',
            path: 'x',
            content: 'x',
          }
          await tx.insert(memories).values({ ...row, layer: 'base' })
          await tx
            .insert(memories)
            .values({ ...row, layer: 'private', ownerAccountId: account!.id })
        }),
      ).rejects.toMatchObject({
        cause: { code: '23505', constraint_name: 'memories_uri_live_idx' },
      })
    })
  })
})
