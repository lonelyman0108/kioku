import { randomBytes, randomUUID } from 'node:crypto'

import type {
  AppInfo,
  ConsoleCredentialList,
  CredentialAccess,
  CredentialEventList,
  CredentialValues,
  DomainLayers,
  ExtractionUsage,
  GroupPersonaRuleList,
  Me,
  MemoryHistory,
  MemoryView,
  PersonaInfo,
  RecallStats,
  ReviewList,
  SpaceImportResult,
  SpaceOverview,
  SubjectDetail,
  SubjectList,
} from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { decryptSecret } from '../../crypto/envelope'
import { keyIdOf } from '../../crypto/keyring'
import { connect, withSpace, type Database } from '../../db/client'
import { memories, settings, spaces } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Jobs } from '../../jobs/queue'
import { settleRecallEvents } from '../../recall/events'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bearer, bootstrap, FULL_SCOPES, jsonRequest } from '../../testing/fixtures'
import { deriveExportKey, openSpaceExport, sealSpaceExport, type KdfParams } from '../spaceFormat'
import { parseSpaceExport, type ParsedSpaceExport } from '../spaceImport'
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
  const importRequest = (
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
    return app.request('/v1/spaces/import', {
      method: 'POST',
      headers: { ...sameSite, cookie },
      body: form,
    })
  }
  const contents = async (file: Buffer): Promise<ParsedSpaceExport> =>
    parseSpaceExport(await openSpaceExport(PASSPHRASE, file, SPACE_EXPORT_MAX_PLAIN_BYTES))
  const spaceCount = async () =>
    (await database.db.execute<{ n: number }>(sql`select count(*)::int as n from spaces`))[0]!.n

  // 自己拼一份导出文件：测数据库约束与边界用
  const header = (name = '拼的空间'): SpaceExportHeader => ({
    format: SPACE_EXPORT_FORMAT,
    version: SPACE_EXPORT_VERSION,
    createdAt: new Date().toISOString(),
    kioku: 'test',
    space: { name, domainLayers: {}, extractionMonthlyTokens: 1000, extractionDailyWrites: 5 },
  })
  async function craft(records: SpaceExportRecord[], head = header()): Promise<Buffer> {
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
          'home://nas',
          'home://wifi',
          'persona://alpha-child/soul',
          'persona://zeta-base/soul',
          'preferences://user',
        ].sort(),
      )
      // 画像只有 alice 自己的那份；bob 的私人层、删掉的与过期的都不在
      expect(parsed.memories.find((m) => m.uri === 'preferences://user')!.content).toBe(
        '回答用中文',
      )
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
      const plain = (
        await openSpaceExport(PASSPHRASE, file, SPACE_EXPORT_MAX_PLAIN_BYTES)
      ).toString()
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
      const result = await ok<SpaceImportResult>(importRequest(target, carol.cookie, file), 201)
      expect(result).toMatchObject({
        name: '家',
        counts: {
          personas: 2,
          apps: 3,
          subjects: 3,
          memories: 11,
          secrets: 1,
          credentials: 3,
          providers: 2,
        },
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
      '既有共享的记忆，又有个人的记忆',
    )
    await importing([curated('home://a'), curated('home://a')], 'URI home://a 重复')
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
    expect(await spaceCount()).toBe(before)
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
