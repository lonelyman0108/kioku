import { randomBytes } from 'node:crypto'

import { PLAINTEXT_CREDENTIAL, type MemoryList, type SpaceOverview } from '@kioku/contracts'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { plaintextMatch } from '../../memory/service'
import type { Database } from '../../db/client'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { TOKEN_SAMPLES } from '../../testing/plaintext'

const join = (...parts: string[]) => parts.join('')
const run = (n: number) => 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zC'.repeat(4).slice(0, n)
const TOKENS = TOKEN_SAMPLES.map((t) => t.token)

// 界面、导入工具与概览统计用的是同一条规则：JS 里直接用正则，数据库里把它的 source 交给 ~*
const SAMPLES = [
  // 「密码：…」后面不是值的：类型名、变量引用、尖括号占位、空的引号、整段遮盖；紧挨着的真值照样算
  ...[
    'string',
    'Optional[str]',
    'SecretStr',
    'None',
    'string123',
    'nullable',
    '$DB_PASSWORD',
    '${DB_PASSWORD}',
    '$(cat x)',
    '%DB_PASSWORD%',
    'process.env.API_KEY',
    'os.environ["X"]',
    "os.getenv('X')",
    'getenv("X")',
    "env('X')",
    '$100abc',
    '<你的密码>',
    `<${'a'.repeat(65)}>`,
    '<abc',
    '""',
    "''",
    '"a"',
    '********',
    'xxxx',
    'XXXXXXXX',
    '...',
    '………',
    '**xxxx**',
    '**xxxx**，后面',
    'xxxxy',
    '*****x',
    '…a',
    'config.password',
    // 不是值的写法后面跟着字的照样算
    '${x}abc',
    '$(cmd)x',
    '%X%y',
    '$X;abc',
    'process.env.X+y',
    'process.env["X"]',
    'process.env["X"]abc',
    'os.getenv("X")abc',
    "env('X'))",
    '$ecretPass1',
    '<b>hunter2</b>',
    '<x>hunter2',
    '""hunter2',
    '"",',
    '"  "',
    'none!23',
    'any-key-2024abc',
    'Str#1234',
    'string[]',
    'Optional<str>',
    'string | null',
    'string)',
    '"  {{cred:a#b}}"',
    '"x {{cred:a#b}}"',
  ].map((v) => `password: ${v}`),
  // 写在引号里的键才认收尾的引号
  '{"db_password": "x1"}',
  "{'api_key': 'x1'}",
  '"密码": "x1"',
  'the token": abc',
  '"a b password": abc',
  // JSON 与字典的键、SECRET_KEY、passphrase；不该报的键
  '{"password": "hunter2"}',
  "{'token': 'abc123'}",
  "SECRET_KEY = 'django-insecure-abc'",
  'AWS_SECRET_ACCESS_KEY=example-value',
  'passphrase: correct horse',
  'token_count: 5',
  'secrets:\n  db:\n    host: 127.0.0.1',
  // Stripe：私钥与受限密钥算，公开的不算
  join('sk_live_', run(24)),
  join('rk_test_', run(24)),
  join('pk_live_', run(24)),
  // 值到左括号、左引号或 & 为止
  '密码：hunter2（旧）',
  'token=abc&password=xyz',
  // 已知格式的令牌：单独写、写在句子里、大小写换过
  ...TOKENS,
  ...TOKENS.map((t) => `前面 ${t} 后面`),
  ...TOKENS.map((t) => t.toUpperCase()),
  // 紧挨着别的词、太短或结构不对的不算
  ...TOKENS.map((t) => `x${t}`),
  `${join('AK', 'IA', run(16).toUpperCase())}X`,
  `${join('kio', 'ku_', run(12), '_', run(40))}x`,
  `task-${run(20)}`,
  'sk-learn-is-a-python-library',
  join('kio', 'ku_', run(12)),
  join('ey', 'J', run(30), '.', run(40), '.', run(40)),
  join('私钥以 -----BEGIN OPENSSH ', 'PRIVATE KEY----- 开头'),
  join('-----BEGIN PUBLIC KEY-----\n', run(64)),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '0f8fad5b-d9cb-469f-a165-70867728950e',
  'Asia Pacific Regional Summit',
  // 值以中文开头的不算，前面隔着引号、粗体或括号也一样；全角字母、emoji 开头的照常算
  '密码：见 Vaultwarden 条目',
  'password: 见团队的密码库',
  '密码："见条目"',
  '密码：**在 1Password 里**',
  '密码：（见 Vaultwarden）',
  '密码：【已轮换】',
  '口令：ひみつ',
  'password: 비밀',
  '密码：(abc)',
  '密码：ｈｕｎｔｅｒ２',
  '密码：😀abc',
  `API Key：见下面 ${join('sk', '-', run(48))}`,
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
      jsonRequest('POST', { ...body, allowPlaintext: true }, { cookie: ws.cookie }),
    )
    expect(res.status).toBe(201)
  }
  const get = async <T>(path: string) => {
    const res = await app.request(`${space()}${path}`, { headers: { cookie: ws.cookie } })
    expect(res.status).toBe(200)
    return (await res.json()) as T
  }

  it('数据库里的判断与 JS 的规则一致', async () => {
    const rows = await database.db.execute<{ s: string; hit: boolean; whole: boolean }>(sql`
      select s, ${plaintextMatch(sql.raw('s'))} as hit, s ~* ${PLAINTEXT_CREDENTIAL.source} as whole
      from (values ${sql.join(
        SAMPLES.map((s) => sql`(${s}::text)`),
        sql`, `,
      )}) as t(s)`)
    // 服务端用的是拆开的几条（plaintextMatch），合起来的一整条也要一样
    expect(rows.map((r) => [r.s, r.hit, r.whole])).toEqual(
      SAMPLES.map((s) => [s, PLAINTEXT_CREDENTIAL.test(s), PLAINTEXT_CREDENTIAL.test(s)]),
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
    expect((await lower('user://notes/real', '密码：***hunter2***')).status).toBe(400)
    expect((await lower('user://notes/prefix', '密码：***x')).status).toBe(400)
    expect((await lower('user://notes/masked', '密码：***')).status).toBe(200)
    expect((await lower('user://notes/quoted', 'password: "***"')).status).toBe(200)
  })

  it('概览数出像有明文凭据的记忆，列表能按它筛选；secret 的正文是密文，不算', async () => {
    await create({ uri: 'user://notes/wifi', content: '访客网络密码：guest-1234' })
    await create({ uri: 'core://api', content: 'token = abc123' })
    await create({ uri: 'user://notes/ok', content: '密码放在密码库里，用到时再取' })
    await create({ uri: 'user://notes/vault', content: '密码：hunter2', sensitivity: 'secret' })

    const overview = await get<SpaceOverview>('/overview')
    expect(overview.plaintextCredentials).toBe(2)
    const hits = await get<MemoryList>('/memories/list?plaintext=true&sort=uri')
    expect(hits.items.map((m) => m.uri)).toEqual(['core://api', 'user://notes/wifi'])
    const rest = await get<MemoryList>('/memories/list?plaintext=false&sort=uri')
    expect(rest.items.map((m) => m.uri)).toEqual(['user://notes/ok', 'user://notes/vault'])
  })
})
