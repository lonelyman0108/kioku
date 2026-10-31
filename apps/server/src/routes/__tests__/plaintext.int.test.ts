import { randomBytes } from 'node:crypto'

import { PLAINTEXT_CREDENTIAL, type MemoryList, type SpaceOverview } from '@kioku/contracts'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import type { Database } from '../../db/client'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

// 界面、导入工具与概览统计用的是同一条规则：JS 里直接用正则，数据库里把它的 source 交给 ~*
const SAMPLES = [
  '密码：hunter2',
  'password = abc',
  'API Key: xyz',
  'api_key=xyz',
  '口令 ：1234',
  'token:\tabc',
  `key sk-${'a'.repeat(20)}`,
  '密码：{{cred:file-server#password}}',
  'token = {{cred:api#token}}',
  '密码：\n见下一行',
  // 占位符写在引号、反引号或粗体里也不算
  '密码："{{cred:x}}"',
  "密码：'{{cred:x}}'",
  '密码：`{{cred:x#password}}`',
  '密码：**{{cred:x}}**',
  '密码：“{{cred:x}}”',
  '密码：「{{cred:x}}」',
  '密码："abc{{cred:x}}"',
  // 整段是遮盖符的不算，写在引号里、后面跟着空白或标点的也一样
  '密码：***',
  '密码：*** 后面',
  '密码：***\n下一行',
  '密码：***，别告诉别人',
  'password: ***, then',
  'password: "***"',
  "password: '***'",
  'password: `***`',
  '密码：“***”',
  '密码：「***」',
  // 遮盖符开头的真密码、粗体的值照常算
  '密码：***hunter2***',
  '密码：***x',
  '密码：***-old',
  'password: ***,abc',
  'password: "***x"',
  '密码：**hunter2**',
  'tokenizer: 分词器',
  'sk-short',
  '普通的一段话',
  // 非 ASCII 的空白：两边要按同一个集合判断
  '密码：\u3000{{cred:x}}',
  '密码：\ufeff{{cred:x}}',
  '密码：\u00a0hunter2',
  'password\u3000: abc',
]

describe.skipIf(!testDatabaseUrl)('明文凭据提醒', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace

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
  })

  const space = () => `/v1/spaces/${ws.spaceId}`
  const create = async (body: Record<string, unknown>) => {
    const res = await app.request(
      `${space()}/memories`,
      jsonRequest('POST', body, { cookie: ws.cookie }),
    )
    expect(res.status).toBe(201)
  }
  const get = async <T>(path: string) => {
    const res = await app.request(`${space()}${path}`, { headers: { cookie: ws.cookie } })
    expect(res.status).toBe(200)
    return (await res.json()) as T
  }

  it('数据库里的判断与 JS 的规则一致', async () => {
    const rows = await database.db.execute<{ s: string; hit: boolean }>(sql`
      select s, s ~* ${PLAINTEXT_CREDENTIAL.source} as hit
      from (values ${sql.join(
        SAMPLES.map((s) => sql`(${s}::text)`),
        sql`, `,
      )}) as t(s)`)
    expect(rows.map((r) => [r.s, r.hit])).toEqual(
      SAMPLES.map((s) => [s, PLAINTEXT_CREDENTIAL.test(s)]),
    )
  })

  it('遮盖符开头的真密码挡得住降级；整段是遮盖符的不挡', async () => {
    const lower = async (uri: string, content: string) => {
      await create({ uri, content, sensitivity: 'secret' })
      return app.request(
        `${space()}/memories`,
        jsonRequest('PATCH', { uri, sensitivity: 'private' }, { cookie: ws.cookie }),
      )
    }
    expect((await lower('notes://real', '密码：***hunter2***')).status).toBe(400)
    expect((await lower('notes://prefix', '密码：***x')).status).toBe(400)
    expect((await lower('notes://masked', '密码：***')).status).toBe(200)
    expect((await lower('notes://quoted', 'password: "***"')).status).toBe(200)
  })

  it('概览数出像有明文凭据的记忆，列表能按它筛选；secret 的正文是密文，不算', async () => {
    await create({ uri: 'notes://wifi', content: '访客网络密码：guest-1234' })
    await create({ uri: 'core://api', content: 'token = abc123', layer: 'base' })
    await create({ uri: 'notes://ok', content: '密码放在密码库里，用到时再取' })
    await create({ uri: 'notes://vault', content: '密码：hunter2', sensitivity: 'secret' })

    const overview = await get<SpaceOverview>('/overview')
    expect(overview.plaintextCredentials).toBe(2)
    const hits = await get<MemoryList>('/memories/list?plaintext=true&sort=uri')
    expect(hits.items.map((m) => m.uri)).toEqual(['core://api', 'notes://wifi'])
    const rest = await get<MemoryList>('/memories/list?plaintext=false&sort=uri')
    expect(rest.items.map((m) => m.uri)).toEqual(['notes://ok', 'notes://vault'])
  })
})
