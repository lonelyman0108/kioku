import { randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import type { CredentialValues, MemoryView } from '@kioku/contracts'
import { eq, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { prepareMasterKey } from '../../crypto/rotation'
import { withSpace, type Database, type Tx } from '../../db/client'
import { lastMigration, pendingMigrations, runMigrations } from '../../db/migrate'
import {
  dreamCursors,
  dreamRuns,
  dreamSuggestions,
  extractionRuns,
  memoryRecallStats,
  settings,
  spaces,
  subjects,
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
  let key: string
  let original: (typeof settings.$inferSelect)[] = []
  const masterKey = randomBytes(32)

  // 模拟一个新实例：表都是空的、序列从头开始，只有迁移写下的默认设置（开始记录召回的时间）
  async function wipe(recallStarted: string) {
    await settleRecallEvents()
    await database.db.execute(
      sql`truncate spaces, accounts, login_attempts, settings restart identity cascade`,
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
    key = await ws.issueKey((await ws.createApp('agent')).id)
  })

  const send = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    api.request(
      path,
      body === undefined
        ? { method, headers: { 'sec-fetch-site': 'same-origin', ...headers } }
        : jsonRequest(method, body, headers),
    )
  const write = async (method: 'POST' | 'PATCH', body: object) => {
    const res = await send(method, '/v1/memories', body, bearer(key))
    expect(res.status, await res.clone().text()).toBe(method === 'POST' ? 201 : 200)
    return (await res.json()) as MemoryView
  }
  const inSpace = <T>(fn: (tx: Tx) => Promise<T>) => withSpace(database.db, ws.spaceId, fn)

  // 每张进备份的表都写上数据：成员、继承的人格、两个应用与 Key、各种记忆（secret、带关键词与凭据引用、
  // 改过的、删掉的）、凭据源与托管的凭据、召回记录与命中、群聊里认出的对象、按群换人格、召回统计、
  // 抽取记录、嵌入接口与抽取模型的设置，以及（不进备份的）向量
  async function seed() {
    const cookie = { cookie: ws.cookie }
    await addMember(database.db, ws.spaceId, 'bob', 'editor')
    // 被继承的排在后面：按标识排序、按存放的位置（改过之后新版本的行落在 child 后面）都是 child 在前，
    // 导出时仍要把 base 排在前面
    const base = await ws.createPersona('zeta-base')
    const child = await ws.createPersona('alpha-child', base.id)
    expect(
      (
        await send(
          'PATCH',
          `/v1/spaces/${ws.spaceId}/personas/${base.id}`,
          { name: '基础' },
          cookie,
        )
      ).status,
    ).toBe(200)
    const bot = await ws.createApp('qq-bot', { name: '群聊 bot', runtimeFamily: 'astrbot' })
    const botKey = await ws.issueKey(bot.id)

    const provider = await send(
      'POST',
      `/v1/spaces/${ws.spaceId}/credential-providers`,
      { kind: 'bitwarden', name: 'Vaultwarden', instructions: '用 bw get 取' },
      cookie,
    )
    expect(provider.status).toBe(201)
    const credential = await send(
      'POST',
      `/v1/spaces/${ws.spaceId}/credentials`,
      {
        identifier: 'nas',
        name: 'NAS',
        source: { kind: 'hosted', values: { password: 'nas-pass' } },
      },
      cookie,
    )
    expect(credential.status).toBe(201)
    const credentialId = ((await credential.json()) as { id: string }).id

    await write('POST', {
      uri: 'home://wifi',
      content: '无线密码 hunter2',
      layer: 'private',
      sensitivity: 'secret',
    })
    const nas = await write('POST', {
      uri: 'home://nas',
      content: 'NAS 在书房，密码见 {{cred:nas}}',
      glossary: ['书房存储'],
    })
    await write('POST', { uri: 'home://notes', content: '第一行\n第二行 "引号" \\ 反斜杠 😀' })
    await write('PATCH', { uri: 'home://notes', content: '改过的笔记\t带制表符' })
    await write('POST', { uri: 'home://old', content: '要删掉的' })
    expect(
      (await send('DELETE', '/v1/memories?uri=home%3A%2F%2Fold', undefined, bearer(key))).status,
    ).toBe(204)

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
    const [group] = await inSpace((tx) =>
      tx.select().from(subjects).where(eq(subjects.kind, 'group')),
    )
    expect(
      (
        await send(
          'PUT',
          `/v1/spaces/${ws.spaceId}/apps/${bot.id}/group-personas`,
          { rules: [{ subjectId: group!.id, personaId: child.id }] },
          cookie,
        )
      ).status,
    ).toBe(200)
    await inSpace(async (tx) => {
      await tx
        .insert(memoryRecallStats)
        .values({ memoryId: nas.id, spaceId: ws.spaceId, count: 3, lastRecalledAt: new Date() })
      await tx.insert(extractionRuns).values({
        spaceId: ws.spaceId,
        appId: bot.id,
        scope: `group:${group!.id}`,
        subjectIds: [group!.id],
        turns: 4,
        model: 'm',
        added: 1,
      })
      // Dream 的运行记录、一条拒绝过的建议（指纹要跟着恢复，不然同样的建议会再提）与整理到的位置
      const scope = `private:${ws.accountId}`
      await tx.insert(dreamRuns).values({
        spaceId: ws.spaceId,
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
        spaceId: ws.spaceId,
        scope,
        ownerAccountId: ws.accountId,
        kind: 'stale',
        memoryIds: [nas.id],
        versions: [nas.version],
        reason: '可能已经搬走了',
        fingerprint: 'stale-fingerprint',
        status: 'rejected',
        decidedBy: ws.accountId,
        decidedAt: new Date(),
      })
      await tx.insert(dreamCursors).values({
        spaceId: ws.spaceId,
        scope,
        ownerAccountId: ws.accountId,
        at: new Date(),
        lastId: nas.id,
      })
    })

    for (const [path, body] of [
      [
        '/v1/settings/embedding',
        {
          model: 'm',
          channels: [{ baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: 'sk-embed' }],
        },
      ],
      [
        '/v1/settings/extraction',
        { baseUrl: 'https://x.example.com/v1', model: 'x', apiKey: 'sk-extract' },
      ],
    ] as const) {
      expect((await send('PUT', path, body, cookie)).status).toBe(200)
    }
    await backfillJob(database.db, staticEmbedderSource(fakeEmbedder('m')), () => {})
    return { credentialId, base, child }
  }

  // 每张表的全部数据（按空间的表逐个空间读），排好序方便比较。Key 的最后使用时间是请求返回之后才异步写的，
  // 不参与比较
  async function snapshot() {
    const ids = (await database.db.select({ id: spaces.id }).from(spaces)).map((r) => r.id)
    const result: Record<string, string[]> = {}
    for (const table of BACKUP_TABLES) {
      const skip = table.name === 'api_keys' ? sql` - 'last_used_at'` : sql``
      const query = sql`select (to_jsonb(t)${skip})::text as row from ${sql.identifier(table.name)} t`
      const rows: string[] = []
      for (const space of table.perSpace ? ids : [null]) {
        const batch = space
          ? await withSpace(database.db, space, (tx) => tx.execute<{ row: string }>(query))
          : await database.db.execute<{ row: string }>(query)
        rows.push(...batch.map((r) => r.row))
      }
      result[table.name] = rows.sort()
    }
    return result
  }
  const embeddings = async () => {
    const [row] = await inSpace((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from memory_embeddings`),
    )
    return row!.n
  }
  const restore = (file: Buffer, key: Buffer = masterKey, folder = migrationsFolder) =>
    restoreBackup(database, { migrationsFolder: folder, masterKey: key, file })
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
    const { credentialId, base, child } = await seed()
    const vectors = await embeddings()
    expect(vectors).toBeGreaterThan(0)
    const before = await snapshot()
    const { file, summary } = await backup()
    for (const table of BACKUP_TABLES)
      expect(summary.rows[table.name], table.name).toBeGreaterThan(0)
    expect(summary.rows).not.toHaveProperty('sessions')
    expect(summary.rows).not.toHaveProperty('memory_embeddings')

    // 人格按继承关系排：表里 child 在 base 前面，备份里 base 在前
    const physical = await inSpace((tx) =>
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

    const [events] = await inSpace((tx) =>
      tx.execute<{ max: number }>(sql`select max(id)::int as max from memory_events`),
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
    const wifi = await send('GET', '/v1/memories?uri=home%3A%2F%2Fwifi', undefined, bearer(key))
    expect(((await wifi.json()) as MemoryView).content).toBe('无线密码 hunter2')
    const revealed = await send(
      'POST',
      `/v1/spaces/${ws.spaceId}/credentials/${credentialId}/reveal`,
      undefined,
      { cookie },
    )
    expect(((await revealed.json()) as CredentialValues).values).toEqual({ password: 'nas-pass' })
    // 序列推到了写回的最大值：之后写下的历史接着编号
    await write('PATCH', { uri: 'home://nas', content: '恢复之后改的' })
    const [after] = await inSpace((tx) =>
      tx.execute<{ max: number }>(sql`select max(id)::int as max from memory_events`),
    )
    expect(after!.max).toBe(events!.max + 1)
    // 向量不在备份里，由补齐任务重新生成
    expect(await embeddings()).toBe(0)
    await backfillJob(database.db, staticEmbedderSource(fakeEmbedder('m')), () => {})
    expect(await embeddings()).toBe(vectors)

    // 已经初始化的实例拒绝再恢复
    await expect(restore(file)).rejects.toThrow('这个实例已经初始化过（2 个账号、1 个空间）')
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

  it('两万条带 URI 的记忆也在一个事务里写回：不逐行加 URI 互斥检查的咨询锁', async () => {
    // 写入时每行一把咨询锁，一个事务里放不下这么多，分批写
    for (let i = 0; i < 20_000; i += 1000) {
      await inSpace((tx) =>
        tx.execute(sql`
          insert into memories (space_id, form, layer, sensitivity, provenance, domain, path, content)
          select ${ws.spaceId}, 'curated', 'base', 'public', 'owner', 'bulk', 'n' || g, '第 ' || g || ' 条'
          from generate_series(${i}::int, ${i + 999}::int) g`),
      )
    }
    const { file, summary } = await backup()
    expect(summary.rows.memories).toBe(20_000)

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
    expect((await restore(file)).rows.memories).toBe(20_000)
  })

  it('主密钥不对、格式版本或迁移对不上、内容不对时拒绝；写回到一半失败时什么都不留下', async () => {
    await write('POST', { uri: 'home://wifi', content: '无线密码', sensitivity: 'secret' })
    await write('POST', { uri: 'home://nas', content: 'NAS 在书房', glossary: ['书房存储'] })
    const { file } = await backup()
    const lines = readBackup(masterKey, file).plain.toString('utf8').split('\n')
    const header = JSON.parse(lines[0]!) as Record<string, unknown>
    const reseal = (changed: object, rest = lines.slice(1)) =>
      collect(sealBackup(masterKey, parts([JSON.stringify(changed), ...rest].join('\n'))))
    const local = readMigrationFiles({ migrationsFolder })
    await wipe('2030-01-01T00:00:00.000Z')

    await expect(restore(file, randomBytes(32))).rejects.toThrow('另一把主密钥')
    await expect(restore(await reseal({ ...header, version: 2 }))).rejects.toThrow(
      '备份的格式版本是 2',
    )
    const latest = local[local.length - 1]!
    const migrated = (migrations: { hash: string; at: number }) => reseal({ ...header, migrations })
    await expect(
      restore(await migrated({ hash: 'x', at: latest.folderMillis + 1 })),
    ).rejects.toThrow('备份来自更新的版本')
    await expect(restore(await migrated({ hash: 'x', at: latest.folderMillis }))).rejects.toThrow(
      '备份的迁移与这个版本的对不上',
    )
    // 较早版本的备份只能恢复到新建的空库：这个库已经迁移到了这个版本
    const older = local[local.length - 2]!
    await expect(
      restore(await migrated({ hash: older.hash, at: older.folderMillis })),
    ).rejects.toThrow(
      `这个库已经执行过迁移（到第 ${local.length} 个），备份是在第 ${local.length - 1} 个时做的`,
    )
    // 记录出现在任何段头之前
    await expect(restore(await reseal(header, [lines[2]!, ...lines.slice(1)]))).rejects.toThrow(
      '备份的内容不是预期的格式',
    )

    // 关键词那一段多出一行重复的：前面的账号、记忆都已写下，失败后整个撤销，触发器也照常开着
    const at = lines.findIndex((l) => l.startsWith('["memory_glossary"'))
    const duplicated = [...lines.slice(1, at + 2), lines[at + 1]!, ...lines.slice(at + 2)]
    await expect(restore(await reseal(header, duplicated))).rejects.toThrow()
    const [state] = await database.db.execute<{ accounts: number; trigger: string }>(sql`
      select (select count(*) from accounts)::int as accounts,
        (select tgenabled from pg_trigger where tgname = 'memories_uri_exclusive') as trigger`)
    expect(state).toEqual({ accounts: 0, trigger: 'O' })

    // 原样的备份照常恢复
    await restore(file)
    const wifi = await send('GET', '/v1/memories?uri=home%3A%2F%2Fwifi', undefined, bearer(key))
    expect(((await wifi.json()) as MemoryView).content).toBe('无线密码')
  })

  it('较早的备份：写回之后在同一个事务里执行这个版本新增的迁移；新增的迁移失败时数据一条也不留下', async () => {
    await write('POST', { uri: 'home://nas', content: 'NAS 在书房' })
    const { file } = await backup()
    const latest = readMigrationFiles({ migrationsFolder }).at(-1)!
    const folders: string[] = []
    // 模拟更新的版本：迁移目录里多一个迁移
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
      for (const folder of folders) await rm(folder, { recursive: true, force: true })
    }
  })
})
