import { randomBytes, randomUUID } from 'node:crypto'
import { getEventListeners } from 'node:events'

import type {
  ActivityList,
  AppInfo,
  ConsoleCredentialList,
  ConsoleMemoryView,
  CredentialAccess,
  CredentialEventList,
  CredentialValues,
  DreamMemberSettings,
  ExpiredMemoryList,
  ExtractionUsage,
  GroupPersonaRuleList,
  Me,
  MemoryHistory,
  MemoryList,
  MemoryView,
  PersonaInfo,
  RecallStats,
  ReviewList,
  SpaceImportPreview,
  SpaceImportResult,
  SpaceOverview,
  SubjectDetail,
  SubjectList,
  VaultConnectionList,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { decryptSecret } from '../../crypto/envelope'
import { keyIdOf } from '../../crypto/keyring'
import { connect, withSpace, type Database } from '../../db/client'
import { sealVaultSecrets } from '../../credential/vault'
import {
  credentialEvents,
  credentials,
  memories,
  memoryEvents,
  settings,
  spaces,
  subjects,
  vaultConnections,
} from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Jobs } from '../../jobs/queue'
import { settleRecallEvents } from '../../recall/events'
import {
  openTestDatabase,
  resetDatabase,
  summaryConversation,
  testDatabaseUrl,
} from '../../testing/db'
import { addMember, bearer, bootstrap, FULL_SCOPES, jsonRequest } from '../../testing/fixtures'
import { exportableMemories } from '../spaceExport'
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
    space: { name, extractionMonthlyTokens: 1000, extractionDailyWrites: 5 },
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
    layer: 'user',
    sensitivity: 'private',
    provenance: 'owner',
    originScope: 'global',
    personaId: null,
    appId: null,
    subjectId: null,
    uri,
    title: uri.slice(uri.lastIndexOf('/') + 1),
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
  // 抽取的事实与会话摘要、两个成员各自的凭据与密码库连接、召回记录与 Key
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
    // 密码库连接直接写库（不用真的登录）：alice 一个连着的、一个断开的，bob 一个
    const vaultConnection = (owner: string, email: string, connected: boolean) =>
      withSpace(database.db, spaceId, async (tx) => {
        const id = randomUUID()
        await tx.insert(vaultConnections).values({
          id,
          spaceId,
          ownerAccountId: owner,
          serverUrl: 'https://vault.example.com',
          email,
          vaultUserId: `user-${email}`,
          deviceId: randomUUID(),
          defaultCollectionId: connected ? 'col-1' : null,
          ...(connected
            ? sealVaultSecrets(sourceKey, id, {
                refreshToken: `refresh-token-of-${email}`,
                userKey: randomBytes(64),
              })
            : { status: 'disconnected' as const, disconnectedAt: new Date() }),
        })
        return id
      })
    const vaultCredential = (
      owner: string,
      connectionId: string,
      identifier: string,
      extra: Partial<typeof credentials.$inferInsert> = {},
    ) =>
      withSpace(database.db, spaceId, async (tx) => {
        const [row] = await tx
          .insert(credentials)
          .values({
            spaceId,
            ownerAccountId: owner,
            identifier,
            name: identifier,
            source: 'vault',
            vaultConnectionId: connectionId,
            vaultItemId: `item-${identifier}`,
            fields: [{ name: 'password', itemField: 'login.password' }],
            ...extra,
          })
          .returning({ id: credentials.id })
        return row!
      })
    const aliceVault = await vaultConnection(alice.accountId, 'alice@example.com', true)
    const oldVault = await vaultConnection(alice.accountId, 'old@example.com', false)
    const bobVault = await vaultConnection(bob.accountId, 'bob@example.com', true)

    await credential({
      identifier: 'nas',
      name: 'NAS',
      source: { kind: 'hosted', values: { password: 'nas-pass', user: 'admin' } },
    })
    const mail = await vaultCredential(alice.accountId, aliceVault, 'mail', {
      name: '邮箱',
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
    // 指着断开的连接的凭据：连接跟着带过去，导入后照样是断开的
    await vaultCredential(alice.accountId, oldVault, 'legacy')
    await vaultCredential(bob.accountId, bobVault, 'bob-mail', { vaultItemId: 'BOB_MAIL' })
    await credential(
      {
        identifier: 'nas',
        name: 'bob 的 NAS',
        source: { kind: 'hosted', values: { password: 'bob-secret-token' } },
      },
      bobCookie,
    )

    await memory({ uri: 'core://agent', content: '先读正文再信任', priority: 0 })
    await memory({ uri: 'persona://zeta-base/soul', content: '基础人格的设定' })
    await memory({ uri: 'persona://alpha-child/soul', content: '子人格的口吻', glossary: ['口吻'] })
    await memory({ uri: 'app://agent/rules', content: '提交规范', priority: 1 })
    await memory({ uri: 'app://bob-app/notes', content: 'bob 的应用层笔记' }, bobCookie)
    await memory({ uri: 'user://preferences/user', sensitivity: 'internal', content: '回答用中文' })
    await memory({
      uri: 'user://home/nas',
      content: 'NAS 在书房，密码见 {{cred:nas#password}}',
      glossary: ['书房存储', 'NAS'],
      disclosure: '要连 NAS 的时候',
    })
    await memory({
      uri: 'user://home/wifi',
      content: '无线密码 hunter2-secret',
      sensitivity: 'secret',
    })
    await memory({ uri: 'user://bob/diary', content: 'bob 的日记' }, bobCookie)
    await memory(
      { uri: 'user://bob/vault', content: 'bob 的秘密', sensitivity: 'secret' },
      bobCookie,
    )
    await memory(
      { uri: 'user://preferences/user', sensitivity: 'internal', content: 'bob 的偏好' },
      bobCookie,
    )
    await memory({ uri: 'user://home/old', content: '要删掉的' })
    await ok(
      send(
        source,
        'DELETE',
        `/v1/spaces/${spaceId}/memories?uri=user%3A%2F%2Fhome%2Fold`,
        undefined,
        cookie,
      ),
      204,
    )
    const expired = await memory({ uri: 'user://home/expired', content: '已经过期的' })

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
        `/v1/spaces/${spaceId}/extraction-budget`,
        { monthlyTokens: 123_456, dailyWritesPerSubject: 7 },
        cookie,
      ),
    )

    // 抽取的事实与会话摘要来自群聊，是不可信来源；还有一条事实是在已经删掉的群里听到的（作用域指向不在的联系人）。
    // 会话摘要挂在会话上，不随空间导出
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
          conversationId: await summaryConversation(tx, spaceId),
          content: '读书会讨论了村上春树',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          ...extracted,
          layer: 'subject',
          subjectId: ming.id,
          originScope: `group:${orphanGroup}`,
          content: '一个已经删掉的群里听到的事',
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
        extractionMonthlyTokens: 123_456,
        extractionDailyWrites: 7,
      })
      const uris = parsed.memories.map((m) => m.uri).filter(Boolean)
      expect(uris.sort()).toEqual(
        [
          'app://agent/rules',
          'app://bob-app/notes',
          'core://agent',
          'user://home/expired',
          'user://home/nas',
          'user://home/wifi',
          'persona://alpha-child/soul',
          'persona://zeta-base/soul',
          'user://preferences/user',
        ].sort(),
      )
      // 本人的只有 alice 自己的那份；bob 的本人与删掉的不在；过期的带上，有效期原样写出
      expect(parsed.memories.find((m) => m.uri === 'user://preferences/user')!.content).toBe(
        '回答用中文',
      )
      expect(parsed.memories.find((m) => m.uri === 'user://home/expired')!.validTo).not.toBeNull()
      // 来自对话的只有联系人的事实，会话摘要不导出
      expect(parsed.memories.filter((m) => m.form === 'extracted').map((m) => m.layer)).toEqual([
        'subject',
        'subject',
      ])
      expect(parsed.memories.find((m) => m.uri === 'user://home/wifi')).toMatchObject({
        sensitivity: 'secret',
        content: '无线密码 hunter2-secret',
      })
      expect(parsed.credentials.map((c) => c.identifier).sort()).toEqual(['legacy', 'mail', 'nas'])
      expect(parsed.credentials.find((c) => c.identifier === 'nas')!.source).toEqual({
        kind: 'hosted',
        values: { password: 'nas-pass', user: 'admin' },
      })
      expect(parsed.credentials.find((c) => c.identifier === 'mail')!.source).toEqual({
        kind: 'vault',
        connectionId: expect.any(String),
        itemId: 'item-mail',
        fields: [{ name: 'password', itemField: 'login.password' }],
      })
      // 文件里记着导出人是谁
      expect(parsed.header.exporter).toEqual({ displayName: 'alice', dreamPrivate: true })
      // 只有 alice 的连接，不带令牌与密钥；bob 的不在
      expect(parsed.vaultConnections.map((v) => v.email).sort()).toEqual([
        'alice@example.com',
        'old@example.com',
      ])
      expect(parsed.vaultConnections[0]).not.toHaveProperty('ciphertext')
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
        'refresh-token-of-',
      ]) {
        expect(plain).not.toContain(text)
      }
      // 托管的值随文件带走了：给凭据的所有者记一条导出的访问事件；密码库的只带条目 id，不记
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
      expect(events.items[0]).toMatchObject({ type: 'access', via: 'space_export', result: 'ok' })
      const mailEvents = await ok<CredentialEventList>(
        send(
          source,
          'GET',
          `/v1/spaces/${spaceId}/credentials/${sourceCredentials.items.find((c) => c.identifier === 'mail')!.id}/events`,
          undefined,
          { cookie: alice.cookie },
        ),
      )
      expect(mailEvents.items.filter((e) => e.type === 'access')).toEqual([])

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
        memories: 11,
        userMemories: 4,
        secrets: 1,
        credentials: 3,
        vaultConnections: 2,
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
      expect(await get<ExtractionUsage>('/extraction-budget')).toMatchObject({
        monthlyTokens: 123_456,
        dailyWritesPerSubject: 7,
        usedTokens: 0,
      })

      // 记忆的正文、归属与来源照旧；secret 用这个实例的主密钥重新加密，读得出来
      const read = (uri: string) => get<MemoryView>(`/memories?uri=${encodeURIComponent(uri)}`)
      expect(await read('user://preferences/user')).toMatchObject({
        layer: 'user',
        content: '回答用中文',
        provenance: 'owner',
        version: 1,
      })
      expect(await read('user://home/nas')).toMatchObject({
        layer: 'user',
        sensitivity: 'private',
        glossary: ['NAS', '书房存储'],
        disclosure: '要连 NAS 的时候',
      })
      expect(await read('persona://alpha-child/soul')).toMatchObject({
        layer: 'persona',
        glossary: ['口吻'],
      })
      // 管理界面默认不给机密正文；用目标实例的主密钥解得开，见下面
      expect((await read('user://home/wifi')).content).toBeNull()
      const [wifi] = await withSpace(database.db, newSpace, (tx) =>
        tx.select().from(memories).where(eq(memories.path, 'home/wifi')),
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
      const nas = await read('user://home/nas')
      const history = await get<MemoryHistory>(`/memories/history?id=${nas.id}`)
      expect(history.events.map((e) => e.type)).toEqual(['import'])
      expect(history.events[0]!.after).toMatchObject({ content: nas.content, layer: 'user' })

      // 抽取的事实仍是不可信来源，作用域换成新的群，照样进待审；作用域指向不在的群的，换成另一个不在的群，不会变成全局
      const ming = subjectList.items.find((s) => s.displayName === '小明')!
      const detail = await get<SubjectDetail>(`/subjects/${ming.id}`)
      expect(detail.facts.find((f) => f.content === '小明在学日语')).toMatchObject({
        provenance: 'untrusted',
        scope: { kind: 'group', id: newGroup.id },
      })
      const review = await get<ReviewList>('/review')
      expect(review.items.map((i) => i.content).sort()).toEqual(
        ['一个已经删掉的群里听到的事', '小明在学日语'].sort(),
      )
      const scopes = await withSpace(database.db, newSpace, (tx) =>
        tx.execute<{ scope: string }>(
          sql`select origin_scope as scope from memories where content = '一个已经删掉的群里听到的事'`,
        ),
      )
      expect(scopes[0]!.scope).toMatch(/^group:/)
      expect(scopes[0]!.scope).not.toBe(`group:${orphanGroup}`)
      expect(subjectList.items.map((s) => s.id)).not.toContain(scopes[0]!.scope.slice(6))

      // 凭据：托管的值用新的主密钥解得开；占位符照样解析到导入人的凭据；限定的应用换成新的，删掉的应用去掉
      const credentialList = await get<ConsoleCredentialList>('/credentials')
      const newNas = credentialList.items.find((c) => c.identifier === 'nas')!
      expect(newNas).toMatchObject({ source: 'hosted', referenceCount: 1, appIds: null })
      const connectionList = await get<VaultConnectionList>('/vault-connections')
      expect(connectionList.items.map((v) => [v.email, v.status]).sort()).toEqual([
        ['alice@example.com', 'disconnected'],
        ['old@example.com', 'disconnected'],
      ])
      const newVault = connectionList.items.find((v) => v.email === 'alice@example.com')!
      expect(credentialList.items.find((c) => c.identifier === 'mail')).toMatchObject({
        source: 'vault',
        vault: { connectionId: newVault.id, itemId: 'item-mail' },
        fields: [{ name: 'password', itemField: 'login.password' }],
        appIds: [app('agent').id],
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
            send(
              target,
              'GET',
              '/v1/memories?uri=user%3A%2F%2Fhome%2Fwifi',
              undefined,
              bearer(newKey),
            ),
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
    '已过期的记下的记忆与被推翻的事实按管理读取一起导出，导入后有效期不变、能重新生效；删掉的、会话摘要、别的成员的本人记忆不带',
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

      const plan = await memory({ uri: 'user://home/plan', content: '十月的旅行计划' })
      await expire(plan.id)
      const shared = await memory({ uri: 'core://taken', content: '过期的共享节点' })
      await expire(shared.id)
      await memory({ uri: 'user://home/gone', content: '删掉的' })
      await ok(
        send(
          source,
          'DELETE',
          `/v1/spaces/${spaceId}/memories?uri=user%3A%2F%2Fhome%2Fgone`,
          undefined,
          cookie,
        ),
        204,
      )
      const bobs = await memory(
        { uri: 'user://bob/old', content: 'bob 过期的日记' },
        { cookie: bob.cookie },
      )
      await expire(bobs.id)
      // 联系人上被推翻的与现在的事实，到期的与没到期的会话摘要
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
        const conversationId = await summaryConversation(tx, spaceId)
        await tx.insert(memories).values([
          { ...extracted, layer: 'subject', subjectId: ming!.id, content: '小明在学法语' },
          { ...extracted, layer: 'subject', subjectId: ming!.id, content: '小明在学日语' },
          {
            ...extracted,
            layer: 'episode',
            conversationId,
            content: '到期的会话摘要',
            expiresAt: past,
          },
          {
            ...extracted,
            layer: 'episode',
            conversationId,
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
        ['十月的旅行计划', '过期的共享节点', '小明在学法语', '小明在学日语'].sort(),
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
      expect((await byUri('user://home/plan')).status).toBe(404)
      expect((await byUri('core://taken')).status).toBe(404)

      // 已过期的在「已过期」里，能重新生效
      const expiredList = await get<ExpiredMemoryList>('/memories/expired')
      const expiredOf = (uri: string) => expiredList.items.find((m) => m.uri === uri)!
      expect(expiredList.items.map((m) => m.uri).sort()).toEqual([
        'core://taken',
        'user://home/plan',
      ])
      const reactivate = (item: ExpiredMemoryList['items'][number]) =>
        send(
          source,
          'POST',
          `/v1/spaces/${space}/memories/reactivate`,
          { memoryId: item.id, expectedVersion: item.version },
          cookie,
        )
      await ok(reactivate(expiredOf('user://home/plan')))
      expect((await ok<MemoryView>(byUri('user://home/plan'))).content).toBe('十月的旅行计划')
      await ok(reactivate(expiredOf('core://taken')))
      expect((await ok<MemoryView>(byUri('core://taken'))).content).toBe('过期的共享节点')

      // 被推翻的事实在联系人详情里，能重新生效
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
      const original = await read(spaceId, 'user://home/wifi')
      const copied = await read(copy.spaceId, 'user://home/wifi')
      expect(copied.content).toBe(original.content)
      expect(copied.id).not.toBe(original.id)
      // 同一个实例里两个空间的凭据互不相干
      expect((await read(copy.spaceId, 'user://home/nas')).content).toContain(
        '{{cred:nas#password}}',
      )
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
        vaultConnections: 0,
      },
    })
  })

  it('导出带走的 secret 记忆留访问事件：经由 export，只进这条记忆的历史；没导出的不记', async () => {
    const alice = await bootstrap(source, 'alice')
    const bob = await addMember(database.db, alice.spaceId, 'bob', 'owner')
    const cookie = { cookie: alice.cookie }
    const space = `/v1/spaces/${alice.spaceId}`
    const remember = (body: object, who = cookie) =>
      ok<MemoryView>(send(source, 'POST', `${space}/memories`, body, who), 201)
    const shared = await remember({
      uri: 'core://kb/door',
      content: '机房门禁 8842',
      sensitivity: 'secret',
    })
    const mine = await remember({
      uri: 'user://notes/vault',
      content: '保险柜 1234',
      sensitivity: 'secret',
    })
    await remember({ uri: 'user://notes/plain', content: '普通的正文' })
    // 别的成员私人层的、已删除的不在文件里
    await remember(
      { uri: 'user://notes/hers', content: 'bob 的', sensitivity: 'secret' },
      { cookie: bob.cookie },
    )
    const gone = await remember({
      uri: 'user://notes/gone',
      content: '删了',
      sensitivity: 'secret',
    })
    await ok(
      send(
        source,
        'DELETE',
        `${space}/memories?uri=${encodeURIComponent(gone.uri)}`,
        undefined,
        cookie,
      ),
      204,
    )

    await exportSpace(source, alice.spaceId, alice.cookie)
    const events = await withSpace(database.db, alice.spaceId, (tx) =>
      tx.select().from(memoryEvents).where(eq(memoryEvents.eventType, 'access')),
    )
    expect(events.map((e) => e.memoryId).sort()).toEqual([shared.id, mine.id].sort())
    for (const event of events) {
      expect(event).toMatchObject({
        actorAccountId: alice.accountId,
        actorKeyId: null,
        context: { via: 'export' },
        after: null,
        before: { sensitivity: 'secret', content: null },
      })
    }
    expect(JSON.stringify(events)).not.toContain('8842')

    const history = await ok<MemoryHistory>(
      send(source, 'GET', `${space}/memories/history?id=${shared.id}`, undefined, cookie),
    )
    expect(history.events.at(-1)).toMatchObject({
      type: 'access',
      via: 'export',
      actor: { accountName: 'alice' },
    })
    const activity = await ok<ActivityList>(
      send(source, 'GET', `${space}/activity`, undefined, cookie),
    )
    expect(activity.items.map((i) => i.type)).not.toContain('access')
  })

  it('明文提示的忽略不随文件走：历史不带过去，到了那边查不到是谁忽略的，提示要回来；访问记录也不带', async () => {
    const alice = await bootstrap(source, 'alice')
    const cookie = { cookie: alice.cookie }
    const space = `/v1/spaces/${alice.spaceId}`
    const note = await ok<ConsoleMemoryView>(
      send(
        source,
        'POST',
        `${space}/memories`,
        { uri: 'user://notes/api', content: 'token = abc' },
        cookie,
      ),
      201,
    )
    await ok(
      send(
        source,
        'POST',
        `${space}/memories/ignore-plaintext`,
        { memoryId: note.id, expectedVersion: note.version },
        cookie,
      ),
    )
    const vault = await ok<ConsoleMemoryView>(
      send(
        source,
        'POST',
        `${space}/memories`,
        { uri: 'user://notes/vault', content: '门禁 8842', sensitivity: 'secret' },
        cookie,
      ),
      201,
    )
    await ok(send(source, 'POST', `${space}/memories/reveal`, { memoryId: vault.id }, cookie))

    const file = await exportSpace(source, alice.spaceId, alice.cookie)
    const parsed = await contents(file)
    const exported = parsed.memories.find((m) => m.uri === note.uri)!
    expect(Object.keys(exported).filter((k) => k.toLowerCase().includes('ignored'))).toEqual([])
    // 不只是解析时丢掉了：文件的原文里也没有这一列
    expect((await plainOf(file)).toString('utf8')).not.toContain('Ignored')

    const imported = await ok<SpaceImportResult>(importRequest(source, alice.cookie, file), 201)
    const list = (plaintext: string) =>
      ok<MemoryList>(
        send(
          source,
          'GET',
          `/v1/spaces/${imported.spaceId}/memories/list?plaintext=${plaintext}`,
          undefined,
          cookie,
        ),
      )
    expect((await list('true')).items.map((m) => m.uri)).toEqual([note.uri])
    expect((await list('ignored')).items).toEqual([])
    const events = await withSpace(database.db, imported.spaceId, (tx) =>
      tx.select({ type: memoryEvents.eventType }).from(memoryEvents),
    )
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['import']))
  })

  it('导出人关掉的整理本人记忆跟着文件走：导入人在新空间里也关着；文件格式是 4，凭据改版之前的 1、2、3 与更新的格式都拒收', async () => {
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

    // 文件里必须有这一项
    expect((await contents(file)).header.version).toBe(4)
    const missing = await importRequest(
      source,
      alice.cookie,
      await craft([], { ...header(), exporter: { displayName: '漏了的人' } }),
    )
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: string }).error).toContain(
      '第 1 行 exporter.dreamPrivate',
    )

    // 记忆架构改版之前的格式（层、坐标与本人都不一样）、凭据改版之前的（凭据源）和认不得的更新的格式都拒收，
    // 不悄悄丢掉或猜测内容
    const before = await spaceCount()
    for (const version of [1, 2, 3, 5]) {
      const res = await inspectRequest(
        source,
        alice.cookie,
        await craft([], { ...header(), version }),
      )
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe(
        `导出文件的格式版本是 ${version}，当前 Kioku 只支持 4。版本 1、2 是记忆架构改版之前的格式，版本 3 带着凭据改版之前的凭据源，都无法导入；更新的版本请升级 Kioku 后再导入。`,
      )
    }
    expect(await spaceCount()).toBe(before)
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
    expect(((await denied.json()) as { error: string }).error).toBe('仅实例管理员可导入空间')
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
    await rejected(await importRequest(source, alice.cookie, file, 'wrong passphrase'), '口令错误')
    await rejected(await inspectRequest(source, alice.cookie, file, 'wrong passphrase'), '口令错误')
    const tampered = Buffer.from(file)
    tampered[tampered.length - 100]! ^= 1
    await rejected(await importRequest(source, alice.cookie, tampered), '文件不完整或已被修改')
    await rejected(
      await importRequest(source, alice.cookie, file.subarray(0, file.length - 10)),
      '文件不完整或已被修改',
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
        '文件中有 1 条机密记忆和 1 条托管的凭据，需要用主密钥加密保存，当前实例未配置 KIOKU_MASTER_KEY。请配置主密钥并重启服务后再导入。',
      )
      expect(await spaceCount()).toBe(before)
      // 没有要加密的内容时照样能导入
      const plain = await craft([curated('user://home/plain')])
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

  it('表单解析不了时返回 400，传的不是表单时返回 415：和别的错误同样的格式，不打堆栈', async () => {
    const alice = await bootstrap(source, 'alice')
    const post = (contentType: string, body: string) =>
      source.request('/v1/spaces/import/inspect', {
        method: 'POST',
        headers: { ...sameSite, cookie: alice.cookie, 'content-type': contentType },
        body,
      })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const type of ['multipart/form-data; boundary=kioku-boundary', 'multipart/form-data']) {
        const res = await post(type, 'not a form at all')
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: '请求格式错误' })
      }
      const json = await post('application/json', JSON.stringify({ passphrase: PASSPHRASE }))
      expect(json.status).toBe(415)
      expect(await json.json()).toEqual({ error: '请求体类型（Content-Type）错误' })
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
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

  it('文件里的内容对不上时拒绝：坐标重复、继承成环、归属与坐标不符、指向不在的对象', async () => {
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
    const shared = { layer: 'core', sensitivity: 'public' } as const
    await importing(
      [curated('core://agent', shared), curated('core://agent', shared)],
      '第 3 行记忆 core://agent 的坐标重复',
    )
    await importing(
      [curated('user://home/a'), curated('user://home/a')],
      '第 3 行记忆 user://home/a 的坐标重复',
    )
    // 同一归属里过期的也算重复（唯一索引不看有效期）
    await importing(
      [curated('user://home/a', { validTo: '2020-01-01T00:00:00.000Z' }), curated('user://home/a')],
      '第 3 行记忆 user://home/a 的坐标重复',
    )
    // 开头决定归属：写着本人的却是 core:// 的坐标
    await importing([curated('core://agent')], '第 2 行记忆 core://agent 的坐标开头与归属不符')
    await importing(
      [curated('user://home/open', { sensitivity: 'public' })],
      '属于本人，本人的记忆不设公开',
    )
    const [a, b] = [randomUUID(), randomUUID()]
    await importing([persona(a, 'a', b), persona(b, 'b', a)], '继承关系成环')
    await importing(
      [persona(a, 'a', null), curated('persona://b/soul', { layer: 'persona', personaId: a })],
      '不在所属人格 a 下',
    )
    await importing(
      [curated('persona://a/soul', { layer: 'core', sensitivity: 'public' })],
      '的坐标开头与归属不符',
    )
    await importing(
      [curated('core://x', { layer: 'core', sensitivity: 'public', provenance: 'untrusted' })],
      '来自未确认来源，只能是联系人的事实',
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
      '关联的联系人不在文件中',
    )
    // 数据库存不下的值在检查文件时就挡下，说清是第几行：公元 0 年的时间、NUL 字符
    await importing(
      [curated('user://home/old', { createdAt: '0000-06-01T00:00:00.000Z' })],
      '第 2 行 createdAt：不是有效的时间',
    )
    await importing(
      [curated('user://home/nul', { content: '前\u0000后' })],
      '第 2 行 content：含无法存入数据库的字符（NUL 或落单的代理项）',
    )
    expect(await spaceCount()).toBe(before)
  })

  it('导出挑记忆的条件：管理读取之外，去掉已删除的（含过期后让出坐标的）与会话摘要', async () => {
    const alice = await bootstrap(source, 'alice')
    const bob = await addMember(database.db, alice.spaceId, 'bob', 'editor')
    const spaceId = alice.spaceId
    const persona = await alice.createPersona('helper')
    const past = new Date(Date.now() - 3_600_000)
    const future = new Date(Date.now() + 3_600_000)
    const labels = new Map<string, string>()
    const insert = async (label: string, values: Partial<typeof memories.$inferInsert>) => {
      const [row] = await withSpace(database.db, spaceId, (tx) =>
        tx
          .insert(memories)
          .values({
            spaceId,
            form: 'curated',
            layer: 'user',
            sensitivity: 'private',
            provenance: 'owner',
            ownerAccountId: alice.accountId,
            domain: 'user',
            path: `home/${label}`,
            title: label,
            content: label,
            ...values,
          })
          .returning({ id: memories.id }),
      )
      labels.set(row!.id, label)
    }
    const episode = {
      form: 'extracted' as const,
      layer: 'episode' as const,
      ownerAccountId: null,
      conversationId: await withSpace(database.db, spaceId, (tx) =>
        summaryConversation(tx, spaceId),
      ),
    }
    const noUri = { domain: null, path: null, title: null }
    await insert('live', {})
    await insert('expired', { validTo: past })
    await insert('deleted', { deletedAt: past })
    await insert('released', { validTo: past, deletedAt: new Date() })
    await insert('shared', { layer: 'core', ownerAccountId: null, domain: 'core' })
    await insert('persona', {
      layer: 'persona',
      ownerAccountId: null,
      personaId: persona.id,
      domain: 'persona',
      path: 'helper/soul',
    })
    await insert('secret', {
      sensitivity: 'secret',
      content: null,
      ciphertext: randomBytes(32),
      wrappedKey: randomBytes(32),
    })
    await insert('bob', { ownerAccountId: bob.accountId })
    await insert('bob-expired', { ownerAccountId: bob.accountId, validTo: past })
    await insert('summary', { ...episode, ...noUri, content: '没到期的摘要', expiresAt: future })
    await insert('summary-stale', {
      ...episode,
      ...noUri,
      content: '被标成过时、还没到期的摘要',
      expiresAt: future,
      validTo: past,
    })
    await insert('summary-lapsed', { ...episode, ...noUri, content: '到期的摘要', expiresAt: past })
    const picked = await withSpace(database.db, spaceId, (tx) =>
      tx.select({ id: memories.id }).from(memories).where(exportableMemories(alice.accountId)),
    )
    expect(picked.map((r) => labels.get(r.id)).sort()).toEqual(
      ['live', 'expired', 'shared', 'persona', 'secret'].sort(),
    )
  })

  it('写文件里来的值时数据库拒绝（值超出范围、违反约束）算文件的问题，说清是哪几行，只给错误码；派生的出错照常 500，都记日志', async () => {
    const alice = await bootstrap(source, 'alice')
    const before = await spaceCount()
    // 模拟数据库拒绝某个值：对象的名字是「坏的」时报 22 类错误，是「冲突的」时报违反约束，说明里都带着文件里的值；
    // 关键词是「坏关键词」时也报违反约束（关键词是文件里的值，算文件的问题）；
    // 正文是「事件出错」的记忆，写它的导入事件时报违反约束（导入事件是服务端派生的，不算文件的问题）
    await database.db.execute(
      sql.raw(`create or replace function kioku_test_reject() returns trigger language plpgsql as $$
      begin
        -- 按表分开判断：PL/pgSQL 不短路，别的表的行上没有这些字段
        if tg_table_name = 'subjects' then
          if new.display_name = '坏的' then
            raise exception '时间超出范围：%', new.display_name using errcode = 'datetime_field_overflow';
          end if;
          if new.display_name = '冲突的' then
            raise exception '冲突：%', new.display_name using errcode = 'check_violation', constraint = 'kioku_test_check';
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
        const file = await craft([curated('user://home/a'), subject('好的'), subject(name)])
        const res = await importRequest(source, alice.cookie, file)
        expect(res.status, await res.clone().text()).toBe(400)
        expect(((await res.json()) as { error: string }).error).toBe(message)
      }
      // 只给错误码：数据库的说明带着文件里的值，只进日志
      await rejected('坏的', '导出文件的内容有误：第 3–4 行的联系人写入数据库失败（22008）')
      expect(wasLogged('第 3–4 行的联系人', '22008')).toBe(true)
      await rejected('冲突的', '导出文件的内容有误：第 3–4 行的联系人写入数据库失败（23514）')
      expect(wasLogged('第 3–4 行的联系人', '23514', 'kioku_test_check')).toBe(true)
      // 关键词是文件里的值：写不进去算文件的问题
      const keyword = await importRequest(
        source,
        alice.cookie,
        await craft([curated('user://home/a', { glossary: ['坏关键词'] })]),
      )
      expect(keyword.status, await keyword.clone().text()).toBe(400)
      expect(((await keyword.json()) as { error: string }).error).toBe(
        '导出文件的内容有误：第 2 行的记忆的关键词写入数据库失败（23514）',
      )
      expect(wasLogged('第 2 行的记忆的关键词', '23514', 'kioku_test_check')).toBe(true)
      // 导入事件是服务端派生的：出错是服务端的缺陷，不说成文件的问题
      const derived = await importRequest(
        source,
        alice.cookie,
        await craft([curated('user://home/a', { content: '事件出错' })]),
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

  it('写文件里来的值时连接断开：不算文件的问题，照常 500，日志记 CONNECTION_CLOSED，不留下新空间', async () => {
    const alice = await bootstrap(source, 'alice')
    const before = await spaceCount()
    await database.db.execute(
      sql.raw(`create or replace function kioku_test_kill() returns trigger language plpgsql as $$
      begin
        perform pg_terminate_backend(pg_backend_pid());
        return new;
      end $$`),
    )
    await database.db.execute(
      sql.raw(`create trigger kioku_test_kill before insert on subjects
        for each row execute function kioku_test_kill()`),
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await importRequest(
        source,
        alice.cookie,
        await craft([
          curated('user://home/a'),
          {
            type: 'subject',
            id: randomUUID(),
            kind: 'person',
            displayName: '写到这里断开',
            nameLocked: false,
            linkedToExporter: false,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      )
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: string }).error).toBe('服务内部错误')
      const detail = logged.mock.calls.find(([message]) =>
        String(message).includes('导入空间时数据库报错'),
      )?.[1] as { code?: string; constraint?: string } | undefined
      expect(detail?.code).toBe('CONNECTION_CLOSED')
      expect(detail?.constraint).toBeUndefined()
      expect(await spaceCount()).toBe(before)
    } finally {
      logged.mockRestore()
      await database.db.execute(sql.raw('drop trigger if exists kioku_test_kill on subjects'))
      await database.db.execute(sql.raw('drop function if exists kioku_test_kill()'))
    }
  })

  it('文件里的文字有存不进数据库的字符（落单的代理项、NUL）：返回 400，指出是哪一行、哪个字段', async () => {
    const alice = await bootstrap(source, 'alice')
    const before = await spaceCount()
    const rejected = async (records: SpaceExportRecord[], where: string) => {
      const res = await importRequest(source, alice.cookie, await craft(records))
      expect(res.status, await res.clone().text()).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe(
        `导出文件的内容有误：${where}：含无法存入数据库的字符（NUL 或落单的代理项）`,
      )
    }
    // JSON 里的 "\ud800" 解出来是落单的代理项：写进 text 会被换成 U+FFFD，写进 jsonb（导入事件）会报错
    await rejected(
      [curated('user://home/a'), curated('user://home/b', { content: '半个\ud800字' })],
      '第 3 行 content',
    )
    await rejected(
      [curated('user://home/a', { glossary: ['好的', '\udc00坏'] })],
      '第 2 行 glossary.1',
    )
    await rejected([curated('user://home/a', { disclosure: '有\u0000的' })], '第 2 行 disclosure')
    // 密码库连接与凭据里的文字也一样查
    const connection = randomUUID()
    await rejected(
      [
        {
          type: 'vault_connection',
          id: connection,
          serverUrl: 'https://vault.example.com',
          email: 'agent@example.com',
          vaultUserId: 'user-1',
          defaultCollectionId: null,
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
            kind: 'vault',
            connectionId: connection,
            itemId: 'item-1',
            fields: [{ name: 'password', itemField: 'field:pass\ud800word' }],
          },
          appIds: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      '第 3 行 source.fields.0.itemField',
    )
    expect(await spaceCount()).toBe(before)
  })

  it('密码库连接的地址与邮箱按连接接口的规则检查：末尾的 / 去掉，外网的 http 拒收', async () => {
    const alice = await bootstrap(source, 'alice')
    const record = (serverUrl: string, email = 'agent@example.com'): SpaceExportRecord => ({
      type: 'vault_connection',
      id: randomUUID(),
      serverUrl,
      email,
      vaultUserId: 'user-1',
      defaultCollectionId: null,
      createdAt: now,
      updatedAt: now,
    })
    const imported = await ok<SpaceImportResult>(
      importRequest(source, alice.cookie, await craft([record('https://vault.example.com/')])),
      201,
    )
    const connections = await ok<VaultConnectionList>(
      send(source, 'GET', `/v1/spaces/${imported.spaceId}/vault-connections`, undefined, {
        cookie: alice.cookie,
      }),
    )
    expect(connections.items.map((v) => [v.serverUrl, v.status])).toEqual([
      ['https://vault.example.com', 'disconnected'],
    ])
    const before = await spaceCount()
    for (const [bad, where] of [
      [record('http://vault.example.com'), '第 2 行 serverUrl'],
      [record('https://vault.example.com', '不是邮箱'), '第 2 行 email'],
    ] as const) {
      const res = await importRequest(source, alice.cookie, await craft([bad]))
      expect(res.status, await res.clone().text()).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain(where)
    }
    expect(await spaceCount()).toBe(before)
  })

  it('密码库凭据没有字段、或者字段重名：导入时被拒，导出时也被拒', async () => {
    const alice = await bootstrap(source, 'alice')
    const space = alice.spaceId
    const connection = randomUUID()
    const external = (fields: { name: string; itemField: string }[]): SpaceExportRecord[] => [
      {
        type: 'vault_connection',
        id: connection,
        serverUrl: 'https://vault.example.com',
        email: 'agent@example.com',
        vaultUserId: 'user-1',
        defaultCollectionId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        type: 'credential',
        id: randomUUID(),
        identifier: 'mail',
        name: '邮箱',
        description: null,
        source: { kind: 'vault', connectionId: connection, itemId: 'item-1', fields },
        appIds: null,
        createdAt: now,
        updatedAt: now,
      },
    ]
    const before = await spaceCount()
    for (const [fields, message] of [
      [[], '第 3 行 source.fields：至少需要一个字段'],
      [
        [
          { name: 'password', itemField: 'login.password' },
          { name: 'password', itemField: 'notes' },
        ],
        '第 3 行 source.fields：字段名不能重复',
      ],
    ] as const) {
      const res = await importRequest(source, alice.cookie, await craft(external([...fields])))
      expect(res.status, await res.clone().text()).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain(message)
    }
    expect(await spaceCount()).toBe(before)

    const connectionId = randomUUID()
    await withSpace(database.db, space, async (tx) => {
      await tx.insert(vaultConnections).values({
        id: connectionId,
        spaceId: space,
        ownerAccountId: alice.accountId,
        serverUrl: 'https://vault.example.com',
        email: 'agent@example.com',
        vaultUserId: 'user-1',
        deviceId: randomUUID(),
        status: 'disconnected',
        disconnectedAt: new Date(),
      })
      await tx.insert(credentials).values({
        spaceId: space,
        ownerAccountId: alice.accountId,
        identifier: 'mail',
        name: '邮箱',
        source: 'vault',
        vaultConnectionId: connectionId,
        vaultItemId: 'item-1',
        fields: [{ name: 'password', itemField: 'login.password' }],
      })
    })
    for (const [fields, message] of [
      ['[]', '凭据 mail 导出后无法导入（source.fields：至少需要一个字段）'],
      [
        '[{"name":"password","itemField":"login.password"},{"name":"password","itemField":"notes"}]',
        '凭据 mail 导出后无法导入（source.fields：字段名不能重复）',
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
      await failing('托管的凭据 nas 无法解密')
      await inSpace(sql`update credentials set deleted_at = now()`)

      await ok(
        send(
          source,
          'POST',
          `/v1/spaces/${space}/memories`,
          { uri: 'user://home/wifi', content: '无线密码', sensitivity: 'secret' },
          cookie,
        ),
        201,
      )
      await inSpace(sql`update memories set wrapped_key = ${randomBytes(60)}`)
      await failing('机密记忆 user://home/wifi 无法解密')
      await inSpace(sql`update memories set deleted_at = now()`)

      // 库里存着认不出的条目字段：导出了也导入不了，导出时就点名
      const connectionId = randomUUID()
      await withSpace(database.db, space, async (tx) => {
        await tx.insert(vaultConnections).values({
          id: connectionId,
          spaceId: space,
          ownerAccountId: alice.accountId,
          serverUrl: 'https://vault.example.com',
          email: 'agent@example.com',
          vaultUserId: 'user-1',
          deviceId: randomUUID(),
          status: 'disconnected',
          disconnectedAt: new Date(),
        })
        await tx.insert(credentials).values({
          spaceId: space,
          ownerAccountId: alice.accountId,
          identifier: 'mail',
          name: '邮箱',
          source: 'vault',
          vaultConnectionId: connectionId,
          vaultItemId: 'item-1',
          fields: [{ name: 'password', itemField: 'login.uris' }],
        })
      })
      await failing('凭据 mail 导出后无法导入（source.fields.0.itemField：')
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
    expect(((await res.json()) as { error: string }).error).toBe('导出导入正忙，请稍后重试')
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

  describe('导出写访问事件时，读完之后记忆又变了', () => {
    // 另一条连接锁住这一行，发出导出，等它确实卡在这把锁上（读文件不用行锁，卡住的只能是写事件那一步），
    // 做完 between 再提交、放开锁
    const whileRowLocked = async (
      spaceId: string,
      memoryId: string,
      leaving: () => Response | Promise<Response>,
      between: (tx: postgres.TransactionSql) => Promise<unknown>,
    ): Promise<Response> => {
      const side = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} })
      let pending: Promise<Response> | undefined
      try {
        await side.begin(async (tx) => {
          await tx`select set_config('app.space_id', ${spaceId}, true)`
          await tx`select 1 from memories where id = ${memoryId} for update`
          const [{ pid }] = (await tx`select pg_backend_pid() as pid`) as unknown as [
            { pid: number },
          ]
          pending = Promise.resolve(leaving())
          for (let i = 0; ; i++) {
            const [row] = await side<{ n: number }[]>`
              select count(*)::int as n from pg_stat_activity
              where ${pid}::int = any(pg_blocking_pids(pid))`
            if (row!.n > 0) break
            if (i >= 400) throw new Error('导出没有等在这把锁上')
            await new Promise((r) => setTimeout(r, 25))
          }
          await between(tx)
        })
        return await pending!
      } finally {
        await pending?.catch(() => {})
        await side.end()
      }
    }
    const seedTwo = async () => {
      const alice = await bootstrap(source, 'alice')
      const remember = (uri: string) =>
        ok<MemoryView>(
          send(
            source,
            'POST',
            `/v1/spaces/${alice.spaceId}/memories`,
            { uri, content: `${uri} 的正文`, sensitivity: 'secret', disclosure: '读文件时的' },
            { cookie: alice.cookie },
          ),
          201,
        )
      return {
        alice,
        first: await remember('user://notes/first'),
        second: await remember('user://notes/second'),
      }
    }
    const accessEvents = (spaceId: string) =>
      withSpace(database.db, spaceId, (tx) =>
        tx.select().from(memoryEvents).where(eq(memoryEvents.eventType, 'access')),
      )

    it('期间被硬删除：跳过这一条，不影响导出，别的照记', async () => {
      const { alice, first, second } = await seedTwo()
      const res = await whileRowLocked(
        alice.spaceId,
        first.id,
        () => exportRequest(source, alice.spaceId, alice.cookie),
        (tx) => tx`delete from memories where id = ${first.id}`,
      )
      expect(res.status, await res.clone().text()).toBe(200)
      const parsed = await contents(Buffer.from(await res.arrayBuffer()))
      expect(parsed.memories.map((m) => m.uri).sort()).toEqual([
        'user://notes/first',
        'user://notes/second',
      ])
      expect((await accessEvents(alice.spaceId)).map((e) => e.memoryId)).toEqual([second.id])
    })

    it('这一批全都被硬删除：什么都不写，也不影响导出', async () => {
      const alice = await bootstrap(source, 'alice')
      const only = await ok<MemoryView>(
        send(
          source,
          'POST',
          `/v1/spaces/${alice.spaceId}/memories`,
          { uri: 'user://notes/only', content: '只有一条', sensitivity: 'secret' },
          { cookie: alice.cookie },
        ),
        201,
      )
      const res = await whileRowLocked(
        alice.spaceId,
        only.id,
        () => exportRequest(source, alice.spaceId, alice.cookie),
        (tx) => tx`delete from memories where id = ${only.id}`,
      )
      expect(res.status, await res.clone().text()).toBe(200)
      await res.arrayBuffer()
      expect(await accessEvents(alice.spaceId)).toEqual([])
    })

    it('期间被改过：事件用现在的快照，不把读文件时的旧内容写回历史', async () => {
      const { alice, first } = await seedTwo()
      const res = await whileRowLocked(
        alice.spaceId,
        first.id,
        () => exportRequest(source, alice.spaceId, alice.cookie),
        (tx) =>
          tx`update memories set disclosure = '转存之后的', version = version + 1 where id = ${first.id}`,
      )
      expect(res.status).toBe(200)
      // 文件读完才放掉导出的名额
      await res.arrayBuffer()
      const event = (await accessEvents(alice.spaceId)).find((e) => e.memoryId === first.id)!
      expect(event.before).toMatchObject({
        disclosure: '转存之后的',
        version: first.version + 1,
        content: null,
      })
      expect(JSON.stringify(event)).not.toContain('读文件时的')
    })

    it('期间被降级：事件的快照也不带正文', async () => {
      const { alice, first } = await seedTwo()
      const res = await whileRowLocked(
        alice.spaceId,
        first.id,
        () => exportRequest(source, alice.spaceId, alice.cookie),
        (tx) =>
          tx`update memories set sensitivity = 'private', content = '降级之后的明文',
            ciphertext = null, wrapped_key = null, key_id = null where id = ${first.id}`,
      )
      expect(res.status).toBe(200)
      // 文件读完才放掉导出的名额
      await res.arrayBuffer()
      const event = (await accessEvents(alice.spaceId)).find((e) => e.memoryId === first.id)!
      expect(event.before).toMatchObject({ sensitivity: 'private', content: null })
      expect(JSON.stringify(event)).not.toContain('降级之后的明文')
    })
  })

  it('读完最后一批时客户端已经断开：文件交不出去，不记凭据与 secret 记忆的访问事件', async () => {
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
    await ok(
      send(
        source,
        'POST',
        `/v1/spaces/${alice.spaceId}/memories`,
        { uri: 'user://notes/vault', content: '保险柜 1234', sensitivity: 'secret' },
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
    const read = await withSpace(database.db, alice.spaceId, (tx) =>
      tx.select().from(memoryEvents).where(eq(memoryEvents.eventType, 'access')),
    )
    expect(read).toEqual([])
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

  it('文件做好之后一直不读、也不断开：空闲到了时限中止响应、放掉名额，记一行日志，下一个导出照常', async () => {
    const quick = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: sourceKey,
      embedder: staticEmbedderSource(null),
      jobs,
      exportSendLimits: { idleMs: 300, totalMs: 60_000 },
    })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const alice = await bootstrap(quick, 'alice')
      const stalled = await exportRequest(quick, alice.spaceId, alice.cookie)
      expect(stalled.status).toBe(200)
      // 响应没人读：名额占着，别人来要排队
      const probe = acquireTransferSlot('probe')
      expect(queuedTransfers()).toBe(1)
      // 到了时限：名额交给排着的那个；没有底层连接可断，让这个响应出错，再也读不出来
      ;(await within(probe))()
      await expect(stalled.arrayBuffer()).rejects.toThrow('太久没有进度')
      expect(warned).toHaveBeenCalledTimes(1)
      // 下一个导出照常进来；读得及时，时限碍不着它
      const file = await exportSpace(quick, alice.spaceId, alice.cookie)
      expect((await contents(file)).header.exporter.displayName).toBe('alice')
      await slotFree()
    } finally {
      warned.mockRestore()
    }
  })

  it(
    '一次导入两万条带 URI 的记忆：不为每个 URI 加咨询锁，锁表不会被占满',
    { timeout: 120_000 },
    async () => {
      const alice = await bootstrap(source, 'alice')
      const records = Array.from({ length: 20_000 }, (_, i) =>
        curated(`user://bulk/n${i}`, { glossary: i % 2 ? ['批量'] : [] }),
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
})
