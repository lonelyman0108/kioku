import { randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import type { CredentialValues, EntryList, EntryView } from '@kioku/contracts'
import { and, eq, ne, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { encryptSecret } from '../../crypto/envelope'
import { encryptionKey } from '../../crypto/keyring'
import { prepareMasterKey } from '../../crypto/rotation'
import { withCircle, type Database, type Tx } from '../../db/client'
import { lastMigration, pendingMigrations, runMigrations } from '../../db/migrate'
import {
  accountLinks,
  circleMembers,
  circles,
  conversations,
  credentials,
  dreamMarks,
  dreamRuns,
  dreamSuggestions,
  entries,
  entryRecallStats,
  entryVariants,
  extractionRuns,
  legacyApiKeys,
  legacyUris,
  settings,
  subjectBindings,
  subjects,
  vaultConnections,
} from '../../db/schema'
import { backfillJob } from '../../embedding/jobs'
import { staticEmbedderSource } from '../../embedding/source'
import { settleRecallEvents } from '../../recall/events'
import { openTestDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeEmbedder } from '../../testing/fakeEmbedder'
import { addMember, bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { createBackup } from '../export'
import { sealBackup } from '../format'
import { readBackup, restoreBackup } from '../restore'
import { BACKUP_TABLES } from '../tables'

const migrationsFolder = fileURLToPath(new URL('../../../migrations', import.meta.url))

async function* parts(...texts: string[]) {
  yield* texts
}

async function collect(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const all: Buffer[] = []
  for await (const chunk of chunks) all.push(chunk)
  return Buffer.concat(all)
}

describe.skipIf(!testDatabaseUrl)('备份与恢复', () => {
  let database: Database
  let api: ReturnType<typeof createApp>
  let ws: Workspace
  let agentId: string
  let key: string
  let original: (typeof settings.$inferSelect)[] = []
  const masterKey = randomBytes(32)

  // 模拟一个新实例：表都是空的、序列从头开始，只有迁移写下的默认设置（开始记录召回的时间）
  async function wipe(recallStarted: string) {
    await settleRecallEvents()
    await database.db.execute(
      sql`truncate circles, accounts, login_attempts, settings restart identity cascade`,
    )
    await database.db.insert(settings).values({ key: 'recall-started', value: recallStarted })
  }

  beforeAll(async () => {
    database = await openTestDatabase()
    original = await database.db.select().from(settings)
    api = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })
  afterAll(async () => {
    if (!database) return
    await wipe('2000-01-01T00:00:00.000Z')
    await database.db.delete(settings)
    if (original.length) await database.db.insert(settings).values(original)
    await database.close()
  })
  beforeEach(async () => {
    await wipe('2001-01-01T00:00:00.000Z')
    ws = await bootstrap(api)
    agentId = (await ws.createClient('agent')).id
    key = await ws.issueKey(agentId)
  })

  const send = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    api.request(
      path,
      body === undefined
        ? { method, headers: { 'sec-fetch-site': 'same-origin', ...headers } }
        : jsonRequest(method, body, headers),
    )
  const write = async (method: 'POST' | 'PATCH', body: object) => {
    const res = await send(method, '/v1/entries', body, bearer(key))
    expect(res.status, await res.clone().text()).toBe(method === 'POST' ? 201 : 200)
    return (await res.json()) as EntryView
  }
  const inCircle = <T>(fn: (tx: Tx) => Promise<T>) => withCircle(database.db, ws.circleId, fn)

  // 每张进备份的表都写上数据：成员（有一个关掉了 Dream 整理本人的记忆）、继承的人格与设定段、切面维度与词条、
  // 两个客户端与 Key、各种记忆（secret、带关键词与互链与凭据引用、旧坐标映射、改过的、删掉的）、
  // 密码库连接、托管与密码库的凭据、召回记录与命中、群聊里认出的联系人、按群规则、群聊与不带会话上下文的会话、
  // 召回统计、抽取记录、等确认的绑定、嵌入接口与抽取模型的设置，以及（不进备份的）向量
  async function seed() {
    const cookie = { cookie: ws.cookie }
    const bob = await addMember(database.db, ws.circleId, 'bob', 'editor')
    // 一次性链接不进备份
    await database.db.insert(accountLinks).values({
      accountId: bob.accountId,
      purpose: 'reset',
      tokenHash: 'link',
      expiresAt: new Date(Date.now() + 3600_000),
    })
    // bob 关掉了 Dream 整理他的本人记忆：成员的设置也要跟着恢复
    expect(
      (
        await send(
          'PUT',
          `/v1/circles/${ws.circleId}/me/dream`,
          { includePrivate: false },
          { cookie: bob.cookie },
        )
      ).status,
    ).toBe(200)
    // 离开了记忆圈的成员：离开记录要跟着恢复，满期的清理才知道从什么时候算
    const dave = await addMember(database.db, ws.circleId, 'dave', 'viewer')
    expect(
      (
        await send(
          'DELETE',
          `/v1/circles/${ws.circleId}/members/${dave.accountId}`,
          undefined,
          cookie,
        )
      ).status,
    ).toBe(204)
    // 被继承的排在后面：按标识排序、按存放的位置（改过之后新版本的行落在 child 后面）都是 child 在前，
    // 导出时仍要把 base 排在前面
    const base = await ws.createPersona('zeta-base')
    const child = await ws.createPersona('alpha-child', base.id)
    expect(
      (
        await send(
          'PATCH',
          `/v1/circles/${ws.circleId}/personas/${base.id}`,
          { name: '基础' },
          cookie,
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await send(
          'PUT',
          `/v1/circles/${ws.circleId}/personas/${base.id}/traits`,
          { traitKey: 'tone', title: '说话风格', content: '温和' },
          cookie,
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await send(
          'POST',
          `/v1/circles/${ws.circleId}/facets/dimensions`,
          { key: 'mood', name: '心情', matchMode: 'additive' },
          cookie,
        )
      ).status,
    ).toBe(201)
    expect(
      (
        await send(
          'POST',
          `/v1/circles/${ws.circleId}/facets/terms`,
          { dimensionKey: 'realm', slug: 'home', label: '家里' },
          cookie,
        )
      ).status,
    ).toBe(201)
    const bot = await ws.createClient('qq-bot', { name: '群聊 bot', runtimeFamily: 'astrbot' })
    const botKey = await ws.issueKey(bot.id)

    const credential = await send(
      'POST',
      `/v1/circles/${ws.personalCircleId}/credentials`,
      {
        identifier: 'nas',
        name: 'NAS',
        source: { kind: 'new', values: { password: 'nas-pass' } },
      },
      cookie,
    )
    expect(credential.status).toBe(201)
    const credentialId = ((await credential.json()) as { id: string }).id
    // 凭据占位符仅允许放在个人圈、敏感级不低于 private 的正式词条中
    expect(
      (
        await send(
          'POST',
          `/v1/circles/${ws.personalCircleId}/entries`,
          {
            title: '个人凭据备忘',
            content: '家里的 NAS 密码见 {{cred:nas}}',
            sensitivity: 'private',
          },
          cookie,
        )
      ).status,
    ).toBe(201)

    await write('POST', {
      title: 'home/wifi',
      content: '无线密码 hunter2',
      sensitivity: 'secret',
    })
    const nas = await write('POST', {
      title: '书房的 NAS',
      content: 'NAS 在书房',
      sensitivity: 'private',
      glossary: ['书房存储'],
    })
    await write('POST', {
      title: '笔记 "引号" \\ 😀',
      content: `第一行\n第二行 "引号" \\ 反斜杠 😀，参见 [[${nas.shortId}]]`,
    })
    // 忽略过明文提示的：哈希在变体切片上，要跟着恢复
    const dismissed = await write('POST', {
      title: 'home/dismissed',
      content: 'token = tokenizer 的说明',
      plaintextOk: true,
    })
    expect(
      (
        await send(
          'POST',
          `/v1/circles/${ws.circleId}/entries/ignore-plaintext`,
          { entryId: dismissed.id, expectedVersion: dismissed.version },
          cookie,
        )
      ).status,
    ).toBe(200)
    await write('PATCH', {
      id: '笔记 "引号" \\ 😀',
      content: `改过的笔记\t带制表符，参见 [[${nas.shortId}]]`,
    })
    await write('POST', { title: 'home/old', content: '要删掉的' })
    expect((await send('DELETE', '/v1/entries?id=home%2Fold', undefined, bearer(key))).status).toBe(
      204,
    )

    expect((await send('POST', '/v1/recall', { query: 'NAS 在书房吗' }, bearer(key))).status).toBe(
      200,
    )
    const context = {
      chatType: 'group',
      platform: 'qq',
      group: { id: '2001', name: '读书会' },
      sender: { id: '1001', name: '小明' },
    }
    expect(
      (await send('POST', '/v1/recall', { query: '你好', context }, bearer(botKey))).status,
    ).toBe(200)
    await settleRecallEvents()
    const [group] = await inCircle((tx) =>
      tx.select().from(subjects).where(eq(subjects.kind, 'group')),
    )
    expect(
      (
        await send(
          'PUT',
          `/v1/circles/${ws.circleId}/clients/${bot.id}/group-rules`,
          {
            rules: [{ groupSubjectId: group!.id, personaId: child.id, isolateGroupMemory: false }],
          },
          cookie,
        )
      ).status,
    ).toBe(200)
    const [person] = await inCircle((tx) =>
      tx.select().from(subjects).where(eq(subjects.kind, 'person')),
    )
    expect(
      (
        await send(
          'POST',
          '/v1/recall',
          {
            query: '你好',
            context: { chatType: 'direct', platform: 'tg', sender: { id: 'u1', name: '明' } },
          },
          bearer(botKey),
        )
      ).status,
    ).toBe(200)
    const [other] = await inCircle((tx) =>
      tx
        .select()
        .from(subjects)
        .where(and(eq(subjects.kind, 'person'), ne(subjects.id, person!.id))),
    )
    await inCircle(async (tx) => {
      await tx.insert(legacyUris).values({
        circleId: ws.circleId,
        entryId: nas.id,
        legacyUri: 'user://home/nas',
        source: 'kioku-legacy',
      })
      await tx.insert(subjectBindings).values({
        circleId: ws.circleId,
        clientId: bot.id,
        keyId: bot.id,
        subjectId: person!.id,
        fromSubjectId: other!.id,
        platform: 'tg',
        externalId: 'u1',
        displayName: '明',
        issuedPlatform: 'qq',
        issuedExternalId: '1001',
        issuedAt: new Date(),
        status: 'pending',
        accountId: ws.accountId,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      await tx
        .insert(entryRecallStats)
        .values({ entryId: nas.id, circleId: ws.circleId, count: 3, lastRecalledAt: new Date() })
        .onConflictDoUpdate({
          target: entryRecallStats.entryId,
          set: { count: 3, lastRecalledAt: new Date() },
        })
      await tx.insert(extractionRuns).values({
        circleId: ws.circleId,
        clientId: bot.id,
        scope: `group:${group!.id}`,
        subjectIds: [group!.id],
        turns: 4,
        model: 'm',
        added: 1,
      })
      // 群里的会话挂着一段会话摘要，在群里听到的事实也记着这个会话；不带会话上下文的会话归成员本人。
      // 记忆指向会话：写回时会话要排在记忆前面
      const [talk] = await tx
        .insert(conversations)
        .values({ circleId: ws.circleId, clientId: bot.id, kind: 'group', subjectId: group!.id })
        .returning({ id: conversations.id })
      const [local] = await tx
        .insert(conversations)
        .values({
          circleId: ws.circleId,
          clientId: agentId,
          kind: 'none',
          ownerAccountId: ws.accountId,
        })
        .returning({ id: conversations.id })
      const ep1Id = randomUUID()
      const factId = randomUUID()
      const ep2Id = randomUUID()
      await tx.insert(entries).values([
        {
          id: ep1Id,
          circleId: ws.circleId,
          circleKind: 'shared',
          shortId: 'm-234567',
          kind: 'episode',
          title: '读书会会话摘要',
          sensitivity: 'public',
          provenance: 'untrusted',
          originScope: `group:${group!.id}`,
          conversationId: talk!.id,
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
        },
        {
          id: factId,
          circleId: ws.circleId,
          circleKind: 'shared',
          shortId: 'm-234568',
          kind: 'fact',
          title: '小明学日语',
          sensitivity: 'public',
          provenance: 'untrusted',
          originScope: `group:${group!.id}`,
          subjectId: person!.id,
          subjectKind: 'person',
          conversationId: talk!.id,
        },
        {
          id: ep2Id,
          circleId: ws.circleId,
          circleKind: 'shared',
          shortId: 'm-234569',
          kind: 'episode',
          title: '架构改版讨论',
          sensitivity: 'private',
          provenance: 'agent',
          ownerAccountId: ws.accountId,
          conversationId: local!.id,
        },
      ])
      await tx.insert(entryVariants).values([
        {
          circleId: ws.circleId,
          entryId: ep1Id,
          sensitivity: 'public',
          kind: 'episode',
          content: '读书会定了下周的书目',
        },
        {
          circleId: ws.circleId,
          entryId: factId,
          sensitivity: 'public',
          kind: 'fact',
          content: '小明在学日语',
        },
        {
          circleId: ws.circleId,
          entryId: ep2Id,
          sensitivity: 'private',
          kind: 'episode',
          content: '讨论了记忆架构改版',
        },
      ])
      // Dream 的运行记录、一条拒绝过的建议（指纹要跟着恢复，不然同样的建议会再提）与整理过的标记
      const scope = `user:${ws.accountId}`
      await tx.insert(dreamRuns).values({
        circleId: ws.circleId,
        runId: randomUUID(),
        trigger: 'scheduled',
        scope,
        ownerAccountId: ws.accountId,
        model: 'm',
        promptTokens: 40,
        changed: 1,
        considered: 1,
        suggested: 1,
      })
      await tx.insert(dreamSuggestions).values({
        circleId: ws.circleId,
        scope,
        ownerAccountId: ws.accountId,
        kind: 'stale',
        entryIds: [nas.id],
        versions: [nas.version],
        reason: '可能已经搬走了',
        fingerprint: 'stale-fingerprint',
        status: 'rejected',
        decidedBy: ws.accountId,
        decidedAt: new Date(),
      })
      await tx
        .insert(dreamMarks)
        .values({ circleId: ws.circleId, entryId: nas.id, version: nas.version })
      // 密码库连接（令牌与账户密钥加密保存）与给它的一个条目起的标识
      const connectionId = randomUUID()
      const { key: dataKey, id: keyId } = encryptionKey(masterKey)
      await tx.insert(vaultConnections).values({
        id: connectionId,
        circleId: ws.circleId,
        ownerAccountId: ws.accountId,
        serverUrl: 'https://vault.example.com',
        email: 'agent@example.com',
        vaultUserId: randomUUID(),
        deviceId: randomUUID(),
        ...encryptSecret(
          dataKey,
          JSON.stringify({ refreshToken: 'r', userKey: randomBytes(64).toString('base64') }),
          `vault-connection:${connectionId}`,
        ),
        keyId,
        lastCheckedAt: new Date(),
      })
      await tx.insert(credentials).values({
        circleId: ws.circleId,
        ownerAccountId: ws.accountId,
        identifier: 'file-server',
        name: '文件服务器',
        source: 'vault',
        vaultConnectionId: connectionId,
        vaultItemId: randomUUID(),
        fields: [
          { name: 'username', itemField: 'login.username' },
          { name: 'password', itemField: 'login.password' },
        ],
      })
    })

    const provRes = await send(
      'POST',
      '/v1/settings/models/providers',
      {
        name: '测试服务商',
        format: 'openai-chat',
        baseUrl: 'https://e.example.com/v1',
        apiKey: 'sk-embed',
        profiles: [
          { kind: 'embedding', model: 'm' },
          { kind: 'chat', model: 'x' },
        ],
      },
      cookie,
    )
    expect(provRes.status).toBe(201)
    const prov = (await provRes.json()) as { profiles: { id: string; kind: string }[] }
    const embedId = prov.profiles.find((p) => p.kind === 'embedding')!.id
    const chatId = prov.profiles.find((p) => p.kind === 'chat')!.id
    for (const [path, body] of [
      ['/v1/settings/embedding', { model: 'm', profileIds: [embedId] }],
      ['/v1/settings/models/bindings/extraction', { profileIds: [chatId] }],
    ] as const) {
      expect((await send('PUT', path, body, cookie)).status).toBe(200)
    }
    await database.db.insert(legacyApiKeys).values({
      prefix: 'kioku_leg1234',
      secretHash: 'legacy-secret-hash',
      name: '旧版测试密钥',
      ownerAccountId: ws.accountId,
    })
    await backfillJob(database.db, staticEmbedderSource(fakeEmbedder('m')), async () => [])
    return { credentialId, nasShortId: nas.shortId, base, child, bob }
  }

  // 每张表的全部数据（按记忆圈的表逐个记忆圈读），排好序方便比较。Key 的最后使用时间是请求返回之后才异步写的，
  // 不参与比较
  async function snapshot() {
    const ids = (await database.db.select({ id: circles.id }).from(circles)).map((r) => r.id)
    const result: Record<string, string[]> = {}
    for (const table of BACKUP_TABLES) {
      const skip = table.name === 'api_keys' ? sql` - 'last_used_at'` : sql``
      const query = sql`select (to_jsonb(t)${skip})::text as row from ${sql.identifier(table.name)} t`
      const rows: string[] = []
      for (const circle of table.perCircle ? ids : [null]) {
        const batch = circle
          ? await withCircle(database.db, circle, (tx) => tx.execute<{ row: string }>(query))
          : await database.db.execute<{ row: string }>(query)
        rows.push(...batch.map((r) => r.row))
      }
      result[table.name] = rows.sort()
    }
    return result
  }
  const embeddings = async () => {
    const [row] = await inCircle((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from entry_embeddings`),
    )
    return row!.n
  }
  const restore = (file: Buffer, key: Buffer = masterKey, folder = migrationsFolder) =>
    restoreBackup(database, { migrationsFolder: folder, masterKey: key, file })

  // 模拟更新的版本：迁移目录里多一个迁移。用完由 forget 撤掉它在库里留下的表与迁移记录
  const latest = readMigrationFiles({ migrationsFolder }).at(-1)!
  const folders: string[] = []
  const newer = async (statement: string) => {
    const folder = await mkdtemp(join(tmpdir(), 'kioku-test-migrations-'))
    folders.push(folder)
    await cp(migrationsFolder, folder, { recursive: true })
    const journalFile = join(folder, 'meta/_journal.json')
    const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[]
    }
    const last = journal.entries[journal.entries.length - 1]!
    journal.entries.push({
      ...last,
      idx: last.idx + 1,
      when: latest.folderMillis + 1000,
      tag: '9999_probe',
    })
    await writeFile(journalFile, JSON.stringify(journal))
    await writeFile(join(folder, '9999_probe.sql'), statement)
    return folder
  }
  const forget = async () => {
    await database.db.execute(sql`drop table if exists restore_probe`)
    await database.db.execute(
      sql`delete from drizzle.__drizzle_migrations where created_at > ${latest.folderMillis}`,
    )
  }
  afterAll(async () => {
    for (const folder of folders) await rm(folder, { recursive: true, force: true })
  })
  const backup = async () => {
    const chunks: Buffer[] = []
    const out = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk)
        done()
      },
    })
    const summary = await createBackup(database.db, masterKey, out)
    return { file: Buffer.concat(chunks), summary }
  }

  it('恢复到新实例后数据与备份时一致：登录、Key、secret、托管的凭据、历史都在，向量重新补齐', async () => {
    const { credentialId, nasShortId, base, child, bob } = await seed()
    const vectors = await embeddings()
    expect(vectors).toBeGreaterThan(0)
    const before = await snapshot()
    const { file, summary } = await backup()
    for (const table of BACKUP_TABLES)
      expect(summary.rows[table.name], table.name).toBeGreaterThan(0)
    expect(summary.rows).not.toHaveProperty('sessions')
    expect(summary.rows).not.toHaveProperty('account_links')
    expect(summary.rows).not.toHaveProperty('entry_embeddings')

    // 人格按继承关系排：表里 child 在 base 前面，备份里 base 在前
    const physical = await inCircle((tx) =>
      tx.execute<{ id: string }>(
        sql`select id from personas where id in (${base.id}, ${child.id}) order by ctid`,
      ),
    )
    expect(physical.map((r) => r.id)).toEqual([child.id, base.id])
    const { plain, sections } = readBackup(masterKey, file)
    const personas = sections.find((s) => s.table === 'personas')!
    const order = plain
      .toString('utf8', personas.start, personas.end)
      .split('\n')
      .map((line) => (JSON.parse(line) as { id: string }).id)
    expect(order.indexOf(base.id)).toBeLessThan(order.indexOf(child.id))

    const [events] = await inCircle((tx) =>
      tx.execute<{ max: number }>(sql`select max(id)::int as max from entry_events`),
    )
    await wipe('2030-01-01T00:00:00.000Z')
    const started = Date.now()
    const result = await restore(file)
    expect(result.rows).toEqual(summary.rows)
    expect(result.upgraded).toBe(0)
    // 和备份时一样，只多出恢复时记下的恢复时间：保留期的清理暂停到它加上保留天数
    const restored = await snapshot()
    const pause = restored.settings!.find(
      (row) => (JSON.parse(row) as { key: string }).key === 'retention',
    )
    expect((JSON.parse(pause!) as { value: unknown }).value).toEqual({
      pause: { since: expect.any(String), reason: 'restored' },
    })
    expect(result.retentionPausedUntil.getTime()).toBeGreaterThanOrEqual(started + 30 * 86_400_000)
    expect({ ...restored, settings: restored.settings!.filter((row) => row !== pause) }).toEqual(
      before,
    )
    await prepareMasterKey(database.db, masterKey)
    // 成员的设置跟着恢复：bob 关掉的 Dream 整理还关着，别人的照旧开着
    const members = await database.db
      .select({ id: circleMembers.accountId, dreamPrivate: circleMembers.dreamPrivate })
      .from(circleMembers)
      .where(eq(circleMembers.circleId, ws.circleId))
    expect(Object.fromEntries(members.map((m) => [m.id, m.dreamPrivate]))).toEqual({
      [ws.accountId]: true,
      [bob.accountId]: false,
    })

    // 会话不在备份里，要重新登录
    expect((await send('GET', '/v1/auth/me', undefined, { cookie: ws.cookie })).status).toBe(401)
    const login = await send(
      'POST',
      '/v1/auth/login',
      { username: 'alice', password: 'correct horse battery' },
      {},
    )
    expect(login.status).toBe(200)
    const cookie = login.headers
      .getSetCookie()
      .find((c) => c.startsWith('kioku_session='))!
      .split(';')[0]!
    // Key 照常可用，secret 与托管的凭据都解得开
    const wifi = await send('GET', '/v1/entries?id=home%2Fwifi', undefined, bearer(key))
    expect(((await wifi.json()) as EntryView).variants[0]!.content).toBe('无线密码 hunter2')
    const revealed = await send(
      'POST',
      `/v1/circles/${ws.personalCircleId}/credentials/${credentialId}/reveal`,
      undefined,
      { cookie },
    )
    expect(((await revealed.json()) as CredentialValues).values).toEqual({ password: 'nas-pass' })
    // 明文提示的忽略跟着恢复，还对得上正文
    const dismissed = await send(
      'GET',
      `/v1/circles/${ws.circleId}/entries/list?plaintext=ignored`,
      undefined,
      { cookie },
    )
    expect(((await dismissed.json()) as EntryList).items.map((m) => m.title)).toEqual([
      'home/dismissed',
    ])
    // 序列推到了写回的最大值：之后写下的历史接着编号。上面 Key 读 secret 记了一条访问事件，这次修改是下一条
    await write('PATCH', { id: nasShortId, content: '恢复之后改的' })
    const [after] = await inCircle((tx) =>
      tx.execute<{ max: number }>(sql`select max(id)::int as max from entry_events`),
    )
    expect(after!.max).toBe(events!.max + 2)
    // 向量不在备份里，由补齐任务重新生成
    expect(await embeddings()).toBe(0)
    await backfillJob(database.db, staticEmbedderSource(fakeEmbedder('m')), async () => [])
    expect(await embeddings()).toBe(vectors)

    // 已经初始化的实例拒绝再恢复
    await expect(restore(file)).rejects.toThrow('这个实例已经初始化过（3 个账号、4 个记忆圈）')
  })

  it('实例级的表在备份里是空的：新库里迁移写下的默认值也以备份为准清掉', async () => {
    await database.db.delete(settings)
    const { file, summary } = await backup()
    expect(summary.rows.settings).toBe(0)
    await wipe('2030-01-01T00:00:00.000Z')
    await restore(file)
    // 只剩恢复时记下的恢复时间（保留期的清理暂停到它加上保留天数）
    expect((await database.db.select().from(settings)).map((s) => s.key)).toEqual(['retention'])
  })

  // 先写两万条再备份、恢复，CI 的机器上要五秒上下，单独放宽时限
  it('两万条记忆也在一个事务里写回', async () => {
    await inCircle((tx) =>
      tx.execute(sql`
        with ins as (
          insert into entries (circle_id, circle_kind, short_id, kind, title, sensitivity, provenance)
          select ${ws.circleId}, 'shared',
            'm-' || translate(lpad(to_hex(g + 100000), 6, '0'), '01', 'gh'),
            'entry', 'n' || g, 'public', 'owner'
          from generate_series(0, 19999) g
          returning circle_id, id, sensitivity, kind, title
        )
        insert into entry_variants (circle_id, entry_id, sensitivity, kind, content)
        select circle_id, id, sensitivity, kind, '第 ' || substring(title from 2) || ' 条'
        from ins`),
    )
    const { file, summary } = await backup()
    expect(summary.rows.entries).toBe(20_000)

    // 写出中途出错（例如磁盘满了）：备份失败，读正文的查询停在事务里，连接照常可用
    let chunks = 0
    const full = new Writable({
      write(_chunk, _encoding, done) {
        done(++chunks > 1 ? new Error('磁盘满了') : null)
      },
    })
    await expect(createBackup(database.db, masterKey, full)).rejects.toThrow('磁盘满了')
    const [state] = await database.db.execute<{ open: number }>(sql`
      select count(*)::int as open from pg_stat_activity
      where datname = current_database() and state like 'idle in transaction%'`)
    expect(state!.open).toBe(0)

    await wipe('2030-01-01T00:00:00.000Z')
    expect((await restore(file)).rows.entries).toBe(20_000)
  }, 90_000)

  it('主密钥不对、格式版本或迁移对不上、内容不对时拒绝；写回到一半失败时什么都不留下', async () => {
    await write('POST', { title: 'home/wifi', content: '无线密码', sensitivity: 'secret' })
    await write('POST', { title: 'home/nas', content: 'NAS 在书房', glossary: ['书房存储'] })
    // 会话表上有触发器：写回期间停用，失败后要照常开着
    await inCircle((tx) =>
      tx.insert(conversations).values({
        circleId: ws.circleId,
        clientId: agentId,
        kind: 'none',
        ownerAccountId: ws.accountId,
      }),
    )
    const { file } = await backup()
    const lines = readBackup(masterKey, file).plain.toString('utf8').split('\n')
    const header = JSON.parse(lines[0]!) as Record<string, unknown>
    const reseal = (changed: object, rest = lines.slice(1)) =>
      collect(sealBackup(masterKey, parts([JSON.stringify(changed), ...rest].join('\n'))))
    await wipe('2030-01-01T00:00:00.000Z')

    await expect(restore(file, randomBytes(32))).rejects.toThrow('另一把主密钥')
    await expect(restore(await reseal({ ...header, version: 3 }))).rejects.toThrow(
      '备份的格式版本是 3',
    )
    const migrated = (migrations: { hash: string; at: number }) => reseal({ ...header, migrations })
    await expect(
      restore(await migrated({ hash: 'x', at: latest.folderMillis + 1 })),
    ).rejects.toThrow('备份来自更新的版本')
    await expect(restore(await migrated({ hash: 'x', at: latest.folderMillis }))).rejects.toThrow(
      '备份的迁移与这个版本的对不上',
    )
    // 较早版本的备份只能恢复到新建的空库：这个库已经迁移到了更新的版本
    const count = readMigrationFiles({ migrationsFolder }).length
    const probe = await newer('CREATE TABLE restore_probe (id int)')
    try {
      await runMigrations(database, probe)
      await expect(restore(file, masterKey, probe)).rejects.toThrow(
        `这个库已经执行过迁移（到第 ${count + 1} 个），备份是在第 ${count} 个时做的`,
      )
    } finally {
      await forget()
    }
    // 记录出现在任何段头之前
    await expect(restore(await reseal(header, [lines[2]!, ...lines.slice(1)]))).rejects.toThrow(
      '备份的内容不是预期的格式',
    )

    // 关键词那一段多出一行重复的：前面的账号、会话、记忆都已写下，失败后整个撤销，触发器也照常开着
    const at = lines.findIndex((l) => l.startsWith('["entry_glossary"'))
    const duplicated = [...lines.slice(1, at + 2), lines[at + 1]!, ...lines.slice(at + 2)]
    await expect(restore(await reseal(header, duplicated))).rejects.toThrow()
    const [state] = await database.db.execute<{ accounts: number; trigger: string }>(sql`
      select (select count(*) from accounts)::int as accounts,
        (select tgenabled from pg_trigger where tgname = 'conversations_delete_episodes') as trigger`)
    expect(state).toEqual({ accounts: 0, trigger: 'O' })

    // 原样的备份照常恢复
    await restore(file)
    const wifi = await send('GET', '/v1/entries?id=home%2Fwifi', undefined, bearer(key))
    expect(((await wifi.json()) as EntryView).variants[0]!.content).toBe('无线密码')
  })

  it('改版之前的库与备份：启动时不迁移、恢复时拒绝，都说清是改版之前的结构，要清空数据库重建后从 Lore 重新导入', async () => {
    // 改版之前的迁移都早于这个版本的第一个迁移（基线）
    const old = readMigrationFiles({ migrationsFolder })[0]!.folderMillis - 86_400_000
    const { file } = await backup()
    const lines = readBackup(masterKey, file).plain.toString('utf8').split('\n')
    const header = JSON.parse(lines[0]!) as Record<string, unknown>
    const before = await collect(
      sealBackup(
        masterKey,
        parts(
          [
            JSON.stringify({ ...header, migrations: { hash: 'x', at: old } }),
            ...lines.slice(1),
          ].join('\n'),
        ),
      ),
    )
    await wipe('2030-01-01T00:00:00.000Z')
    await expect(restore(before)).rejects.toThrow(
      /^备份来自记忆圈重构之前的版本（.+），这个版本不兼容旧数据，无法恢复.*迁入工具导入数据/,
    )

    // 改版之前的库：迁移记录里只有这个版本没有的、更早的迁移。照常迁移的话 drizzle 从基线开始建表，
    // 在已有的表上报「已存在」，看不出是怎么回事
    const saved = await database.db.execute<{ hash: string; at: string }>(
      sql`select hash, created_at::text as at from drizzle.__drizzle_migrations order by id`,
    )
    const rewrite = async (rows: { hash: string; at: string }[]) => {
      await database.db.execute(sql`delete from drizzle.__drizzle_migrations`)
      for (const r of rows) {
        await database.db.execute(
          sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${r.hash}, ${r.at}::bigint)`,
        )
      }
    }
    try {
      await rewrite([
        { hash: 'before-1', at: String(old - 1000) },
        { hash: 'before-2', at: String(old) },
      ])
      await expect(runMigrations(database, migrationsFolder)).rejects.toThrow(
        /^数据库是记忆圈重构之前的结构.*一键迁移.*migrate-legacy --in-place/,
      )
      // 库里有这个版本没有、却不早于基线的迁移（更新的版本，或者合并之后改过的迁移文件）：同样不迁移
      await rewrite([...saved, { hash: 'newer', at: String(latest.folderMillis + 1000) }])
      await expect(runMigrations(database, migrationsFolder)).rejects.toThrow(
        '数据库里有这个版本没有的迁移',
      )
    } finally {
      await rewrite([...saved])
    }
    expect(await pendingMigrations(database.db, migrationsFolder)).toBe(0)
    await runMigrations(database, migrationsFolder)
  })

  it('较早的备份：写回之后在同一个事务里执行这个版本新增的迁移；新增的迁移失败时数据一条也不留下', async () => {
    await write('POST', { title: 'home/nas', content: 'NAS 在书房' })
    const { file } = await backup()
    try {
      // 新增的迁移读写回的数据：能看出它是在写回之后执行的
      await wipe('2030-01-01T00:00:00.000Z')
      const probe = await newer('CREATE TABLE restore_probe AS SELECT username FROM accounts')
      expect(await pendingMigrations(database.db, probe)).toBe(1)
      const result = await restore(file, masterKey, probe)
      expect(result.upgraded).toBe(1)
      expect(await database.db.execute(sql`select username from restore_probe`)).toEqual([
        { username: 'alice' },
      ])
      expect((await lastMigration(database.db))?.at).toBe(latest.folderMillis + 1000)
      // 恢复时自己执行的迁移记录，drizzle 的迁移器认得：服务启动时不会再执行一遍
      expect(await pendingMigrations(database.db, probe)).toBe(0)
      await runMigrations(database, probe)
      await forget()

      await wipe('2030-01-01T00:00:00.000Z')
      await expect(restore(file, masterKey, await newer('SELECT 1 / 0'))).rejects.toThrow()
      const [state] = await database.db.execute<{ accounts: number }>(
        sql`select count(*)::int as accounts from accounts`,
      )
      expect(state!.accounts).toBe(0)
      expect((await lastMigration(database.db))?.at).toBe(latest.folderMillis)
    } finally {
      await forget()
    }
  })
})
