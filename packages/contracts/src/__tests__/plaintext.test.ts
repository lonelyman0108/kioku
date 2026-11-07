import { describe, expect, it } from 'vitest'

import {
  addedPlaintextCredentials,
  ConvertToCredentialRequest,
  CredentialFieldName,
  findPlaintextCredentials,
  MatchCredentialValuesRequest,
  MemoryWriteError,
  PLAINTEXT_CREDENTIAL,
  PLAINTEXT_KINDS,
  placeholderAllowed,
  type PlaintextKind,
} from '../credentials'
import { ErrorResponse } from '../auth'
import { LoreImportApplyRequest, LorePlaintextSpot, LorePlanNode } from '../lore'
import {
  ConsoleCreateMemoryRequest,
  ConsoleUpdateMemoryRequest,
  CreateMemoryRequest,
  UpdateMemoryRequest,
} from '../memories'
import { LAYERS, SENSITIVITIES } from '../memory'
import { PLAINTEXT_KIND_NAMES } from '../names'

// 令牌样例在运行时拼出来：仓库里不出现完整的令牌写法，免得被托管平台的密钥扫描拦下
const join = (...parts: string[]) => parts.join('')
const ALNUM = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zC'
const run = (n: number) => ALNUM.repeat(Math.ceil(n / ALNUM.length)).slice(0, n)
const TOKEN_SAMPLES: Record<string, string> = {
  sk: join('sk', '-', run(48)),
  skProject: join('sk', '-proj-', run(20), '_', run(40), '-', run(20)),
  skAnthropic: join('sk', '-ant-api03-', run(40), '-', run(40), 'AA'),
  github: join('gh', 'p_', run(36)),
  githubServer: join('gh', 's_', run(36)),
  githubFine: join('github', '_pat_', run(22), '_', run(59)),
  gitlab: join('gl', 'pat-', run(20)),
  slack: join('xo', 'xb-', '1234567890-', '1234567890123-', run(24)),
  aws: join('AK', 'IA', run(16).toUpperCase()),
  jwt: join('ey', 'J', run(30), '.', 'ey', 'J', run(40), '.', run(43)),
  privateKey: join(
    '-----BEGIN OPENSSH ',
    'PRIVATE KEY-----\n',
    `${run(70)}\n${run(70)}\n${run(20)}==\n`,
    '-----END OPENSSH ',
    'PRIVATE KEY-----',
  ),
  pgpKey: join('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\n\n', run(64), '\n=abcd\n'),
  kioku: join('kio', 'ku_', run(12), '_', run(40)),
}

const values = (text: string) =>
  findPlaintextCredentials(text).map((m) => ({
    value: text.slice(m.start, m.end),
    field: m.field,
  }))

describe('正文里疑似明文的位置', () => {
  it('找出值与字段名', () => {
    expect(values('访客网络密码：guest-1234')).toEqual([{ value: 'guest-1234', field: 'password' }])
    expect(values('password = abc')).toEqual([{ value: 'abc', field: 'password' }])
    expect(values('passwd=abc')).toEqual([{ value: 'abc', field: 'password' }])
    expect(values('口令 ：1234')).toEqual([{ value: '1234', field: 'password' }])
    expect(values('Token: abc')).toEqual([{ value: 'abc', field: 'token' }])
    expect(values('API Key: xyz')).toEqual([{ value: 'xyz', field: 'api_key' }])
    expect(values('api_key=xyz')).toEqual([{ value: 'xyz', field: 'api_key' }])
    expect(values('secret: s3cret')).toEqual([{ value: 's3cret', field: 'secret' }])
  })

  it('sk- 开头的长串整串都是值，后面跟着的连字符与下划线也算', () => {
    const key = `sk-${'a'.repeat(20)}`
    expect(values(`key ${key}`)).toEqual([{ value: key, field: 'api_key' }])
    expect(values(`${key}-tail_part 之后`)).toEqual([
      { value: `${key}-tail_part`, field: 'api_key' },
    ])
  })

  it('值到空白、中文标点或占位符结束，句末的英文标点不算，感叹号留着', () => {
    expect(values('账号 admin，密码：hunter2，然后登录')).toEqual([
      { value: 'hunter2', field: 'password' },
    ])
    expect(values('password: abc123. 登录')).toEqual([{ value: 'abc123', field: 'password' }])
    expect(values('password: abc123!')).toEqual([{ value: 'abc123!', field: 'password' }])
    expect(values('密码：hunter2{{cred:x}}')).toEqual([{ value: 'hunter2', field: 'password' }])
    expect(values('密码：p@ss,w0rd')).toEqual([{ value: 'p@ss,w0rd', field: 'password' }])
  })

  it('值写在下一行、引号、反引号或粗体里', () => {
    expect(values('密码：\nhunter2')).toEqual([{ value: 'hunter2', field: 'password' }])
    expect(values('密码："correct horse"，别告诉别人')).toEqual([
      { value: 'correct horse', field: 'password' },
    ])
    expect(values('密码：`hunter2`')).toEqual([{ value: 'hunter2', field: 'password' }])
    expect(values('密码：**hunter2**')).toEqual([{ value: 'hunter2', field: 'password' }])
    expect(values('密码：「hunter2」')).toEqual([{ value: 'hunter2', field: 'password' }])
    // 引号没有配对时按普通的值算
    expect(values('密码："hunter2')).toEqual([{ value: '"hunter2', field: 'password' }])
  })

  it('一段正文里有几处都找出来，位置就是字符串的下标', () => {
    const text = '第一行 密码：aaa\n第二行 token=bbb 后面'
    const found = findPlaintextCredentials(text)
    expect(found.map((m) => text.slice(m.start, m.end))).toEqual(['aaa', 'bbb'])
    expect(found.map((m) => m.field)).toEqual(['password', 'token'])
  })

  it('emoji 开头的值不切开代理对', () => {
    expect(values('密码：😀abc')).toEqual([{ value: '😀abc', field: 'password' }])
    expect(values('密码：😀')).toEqual([{ value: '😀', field: 'password' }])
  })

  it('值到 & 为止，查询串里的下一项另算一处；值里又像一处时不重复算', () => {
    expect(values('password=abc&token=def')).toEqual([
      { value: 'abc', field: 'password' },
      { value: 'def', field: 'token' },
    ])
    expect(values('password=abc,token=def')).toEqual([
      { value: 'abc,token=def', field: 'password' },
    ])
  })

  it('值到全角的左括号、左引号为止', () => {
    expect(values('密码：hunter2（旧）')).toEqual([{ value: 'hunter2', field: 'password' }])
    expect(values('密码：hunter2【已换】')).toEqual([{ value: 'hunter2', field: 'password' }])
    expect(values('密码：hunter2「备注」')).toEqual([{ value: 'hunter2', field: 'password' }])
    expect(values('密码：hunter2“x”')).toEqual([{ value: 'hunter2', field: 'password' }])
  })

  it('字段名都能直接用作凭据的字段', () => {
    const samples = ['密码：a1', 'token: a1', 'api key: a1', 'secret: a1', `sk-${'a'.repeat(20)}`]
    for (const text of samples) {
      for (const m of findPlaintextCredentials(text)) {
        expect(CredentialFieldName.safeParse(m.field).success, m.field).toBe(true)
      }
    }
  })

  it('和规则一致：规则没报的这里也没有，规则报了的都有', () => {
    const clean = ['普通的一段话', 'tokenizer: 分词器', 'sk-short', '密码：{{cred:x}}']
    for (const text of clean) {
      expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(false)
      expect(findPlaintextCredentials(text), text).toEqual([])
    }
    const flagged = ['密码：hunter2', 'password = abc', '密码：\nhunter2', 'password　: abc']
    for (const text of flagged) {
      expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(true)
      expect(findPlaintextCredentials(text).length, text).toBeGreaterThan(0)
    }
  })

  it('盖过的不算：整段就是遮盖符，后面是空白、行尾、收尾的引号或中文标点，写在引号里也一样', () => {
    for (const text of [
      '密码：***',
      '密码：*** 后面还有字',
      '密码：***\n下一行',
      '密码：***，别告诉别人',
      '密码：***。',
      'password: ***, then login',
      'password: ***.',
      'password: "***"',
      "password: '***'",
      'password: `***`',
      'password: "***", token: "***"',
      '密码：“***”',
      '密码：‘***’',
      '密码：「***」',
    ]) {
      expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(false)
      expect(findPlaintextCredentials(text), text).toEqual([])
    }
  })

  it('遮盖符开头的真密码照常算：盖掉一部分的、后面还跟着字的', () => {
    for (const text of [
      '密码：***hunter2***',
      '密码：***x',
      '密码：****x',
      'token = ***-old',
      'password: ***,abc',
      'password: "***x"',
      "password: '***hunter2***'",
    ]) {
      expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(true)
      expect(findPlaintextCredentials(text).length, text).toBeGreaterThan(0)
    }
    expect(values('密码：***hunter2***')).toEqual([{ value: 'hunter2', field: 'password' }])
    expect(values('密码：***x')).toEqual([{ value: '***x', field: 'password' }])
    expect(values('密码：**hunter2**')).toEqual([{ value: 'hunter2', field: 'password' }])
    expect(PLAINTEXT_CREDENTIAL.test('密码：*hunter2')).toBe(true)
  })

  it('占位符写在引号、反引号或粗体里也不算：转存之后正文就是这样', () => {
    for (const text of [
      '密码："{{cred:x}}"',
      "密码：'{{cred:x}}'",
      '密码：`{{cred:x#password}}`',
      '密码：**{{cred:x}}**',
      '密码：“{{cred:x}}”',
      '密码：「{{cred:x}}」',
    ]) {
      expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(false)
      expect(findPlaintextCredentials(text), text).toEqual([])
    }
    // 引号里除了占位符还有别的：值到占位符为止，照常报出来，和不写在引号里一样
    for (const text of [
      '密码："abc{{cred:x}}"',
      '密码："abc {{cred:x}}"',
      '密码：abc{{cred:x}}',
      '密码："hunter2{{cred:x#y}}"',
    ]) {
      expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(true)
      expect(
        findPlaintextCredentials(text).map((m) => text.slice(m.start, m.end)),
        text,
      ).toEqual([text.includes('hunter2') ? 'hunter2' : 'abc'])
    }
  })
})

describe('已知格式的令牌', () => {
  const FIELDS: Record<string, [PlaintextKind, string]> = {
    sk: ['sk', 'api_key'],
    skProject: ['sk', 'api_key'],
    skAnthropic: ['sk', 'api_key'],
    github: ['github', 'token'],
    githubServer: ['github', 'token'],
    githubFine: ['github', 'token'],
    gitlab: ['gitlab', 'token'],
    slack: ['slack', 'token'],
    aws: ['aws', 'access_key_id'],
    jwt: ['jwt', 'token'],
    privateKey: ['private_key', 'private_key'],
    pgpKey: ['private_key', 'private_key'],
    kioku: ['kioku', 'api_key'],
  }

  it('每一类都认得出，整串都是值，类别与字段名对得上', () => {
    for (const [name, token] of Object.entries(TOKEN_SAMPLES)) {
      const [kind, field] = FIELDS[name]!
      for (const text of [token, `前面的话 ${token} 后面的话`, `export X="${token}"`]) {
        expect(PLAINTEXT_CREDENTIAL.test(text), `${name}: ${text}`).toBe(true)
        const found = findPlaintextCredentials(text)
        expect(found.length, name).toBe(1)
        const value = text.slice(found[0]!.start, found[0]!.end)
        // PGP 的结尾没有 END 行时到正文的最后一个字符
        expect(value, name).toBe(name === 'pgpKey' ? token.trimEnd() : token)
        expect([found[0]!.kind, found[0]!.field], name).toEqual([kind, field])
        expect(CredentialFieldName.safeParse(field).success).toBe(true)
      }
    }
  })

  it('前缀不区分大小写，和 PostgreSQL 的 ~* 一致', () => {
    expect(PLAINTEXT_CREDENTIAL.test(TOKEN_SAMPLES.github!.toUpperCase())).toBe(true)
    expect(PLAINTEXT_CREDENTIAL.test(TOKEN_SAMPLES.aws!.toLowerCase())).toBe(true)
  })

  it('紧挨着别的词、太短或结构不对的不算', () => {
    for (const text of [
      // 别的词的一部分
      `task-${run(20)}`,
      `my_${TOKEN_SAMPLES.github}`,
      `x${TOKEN_SAMPLES.aws}`,
      `${TOKEN_SAMPLES.aws}X`,
      `${TOKEN_SAMPLES.kioku}x`,
      // 太短
      'sk-short',
      'sk-learn-is-a-python-library',
      join('gh', 'p_', run(20)),
      join('gl', 'pat-', run(10)),
      join('xo', 'xb-', '123'),
      join('AK', 'IA', 'ABC'),
      // 只有访问密钥的前缀：界面上就是这样显示的
      join('kio', 'ku_', run(12)),
      // 只有两段、第二段不是 JSON 的不是 JWT
      join('ey', 'J', run(30), '.', run(40)),
      join('ey', 'J', run(30), '.', run(40), '.', run(40)),
      // 只写了私钥块的开头一行；公钥与证书
      join('私钥文件以 -----BEGIN OPENSSH ', 'PRIVATE KEY----- 开头'),
      join('-----BEGIN PUBLIC KEY-----\n', run(64)),
      join('-----BEGIN CERTIFICATE-----\n', run(64)),
    ]) {
      expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(false)
      expect(findPlaintextCredentials(text), text).toEqual([])
    }
  })

  it('普通的长单词、哈希、UUID、Base64 不算', () => {
    for (const text of [
      'internationalization-and-localization-guidelines',
      'Pneumonoultramicroscopicsilicovolcanoconiosis',
      // SHA-256 与 git 提交号
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'commit 7d74e23a1b2c3d4e5f60718293a4b5c6d7e8f901',
      '0f8fad5b-d9cb-469f-a165-70867728950e',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'Asia Pacific Regional Summit',
      'https://example.com/path/to/some-long-resource-name-1234567890',
    ]) {
      expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(false)
    }
  })

  it('写法后面的值是令牌时只算一处，按令牌算，值是整个令牌', () => {
    for (const [name, token] of Object.entries(TOKEN_SAMPLES)) {
      for (const text of [`token: ${token}`, `secret = "${token}"`, `密码：\n${token}`]) {
        const found = findPlaintextCredentials(text)
        expect(found.length, `${name}: ${text}`).toBe(1)
        expect(text.slice(found[0]!.start, found[0]!.end), name).toBe(
          name === 'pgpKey' ? token.trimEnd() : token,
        )
        expect(found[0]!.kind, name).toBe(FIELDS[name]![0])
      }
    }
  })

  it('私钥块到 END 那一行为止，后面的字不算', () => {
    const text = `私钥：\n${TOKEN_SAMPLES.privateKey}\n用完删掉`
    const found = findPlaintextCredentials(text)
    expect(found.map((m) => [text.slice(m.start, m.end), m.kind, m.line])).toEqual([
      [TOKEN_SAMPLES.privateKey, 'private_key', 2],
    ])
  })
})

describe('值以中文开头的不算', () => {
  it('「密码：见……」这类说明不算，前面隔着引号、粗体或括号也一样', () => {
    for (const text of [
      '密码：见 Vaultwarden 条目',
      '密码：\n见下一行',
      '密码：存在密码库里',
      'password: 见团队的密码库',
      'token = 由运维发放',
      '密码："见条目"',
      '密码：**在 1Password 里**',
      '密码：（见 Vaultwarden）',
      '密码：【已轮换】',
      '口令：ひみつ',
      '비밀번호 password: 비밀',
    ]) {
      expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(false)
      expect(findPlaintextCredentials(text), text).toEqual([])
    }
  })

  it('值以字母、数字、符号或全角字母开头的照常算', () => {
    for (const text of [
      '密码：hunter2',
      '密码：1234',
      '密码：P@ss中文混写',
      '密码：(abc)',
      '密码：ｈｕｎｔｅｒ２',
      '密码：😀abc',
    ]) {
      expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(true)
      expect(findPlaintextCredentials(text).length, text).toBe(1)
    }
  })

  it('写法不算时，同一行里的令牌照常算', () => {
    const text = `API Key：见下面 ${TOKEN_SAMPLES.sk}`
    expect(findPlaintextCredentials(text).map((m) => m.kind)).toEqual(['sk'])
  })
})

describe('每一处的行号与类别', () => {
  it('行号从 1 起，按 \\n 分行', () => {
    const text = `第一行\r\n密码：aaa\n\n第四行 ${TOKEN_SAMPLES.gitlab}\ntoken=bbb`
    expect(findPlaintextCredentials(text).map((m) => [m.line, m.kind])).toEqual([
      [2, 'label'],
      [4, 'gitlab'],
      [5, 'label'],
    ])
  })

  it('每一类都有中文名', () => {
    for (const kind of PLAINTEXT_KINDS) expect(PLAINTEXT_KIND_NAMES[kind]).toBeTruthy()
  })
})

describe('这次新增的疑似明文', () => {
  it('新建时全算', () => {
    expect(addedPlaintextCredentials(null, '密码：aaa\ntoken=bbb').map((m) => m.line)).toEqual([
      1, 2,
    ])
  })

  it('按值比：原来就有的值不算，挪了位置、换了写法也不算；新的值算', () => {
    const before = '密码：aaa\ntoken=bbb'
    const after = '前面加了一行\ntoken: aaa\n密码：ccc\ntoken=bbb'
    const added = addedPlaintextCredentials(before, after)
    expect(added.map((m) => [after.slice(m.start, m.end), m.line])).toEqual([['ccc', 3]])
    expect(addedPlaintextCredentials(before, before)).toEqual([])
    expect(addedPlaintextCredentials(before, '没有了')).toEqual([])
  })

  it('原来的正文里有同样的字却不像明文时，照样算新增', () => {
    expect(addedPlaintextCredentials('hunter2 是一个梗', '密码：hunter2').length).toBe(1)
  })
})

describe('规则只用 PostgreSQL 也认的写法', () => {
  const source = PLAINTEXT_CREDENTIAL.source

  it('没有 \\b \\d \\w \\s、命名分组与捕获分组，重复次数不超过 255', () => {
    // 去掉转义的字符之后再看括号，\\( 这类不算分组
    const unescaped = source.replace(/\\./g, '')
    expect(unescaped).not.toMatch(/\((?!\?)/)
    expect(source).not.toMatch(/\(\?<[A-Za-z]/)
    expect(source).not.toMatch(/(?<!\\)\\[bBdDwWsS]/)
    for (const m of source.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(255)
      if (m[2]) expect(Number(m[2])).toBeLessThanOrEqual(255)
    }
    expect(PLAINTEXT_CREDENTIAL.flags).toBe('i')
  })
})

describe('转存为凭据的请求', () => {
  const hosted = { kind: 'hosted', identifier: 'wifi', name: '无线网络', field: 'password' }
  const base = {
    memoryId: '00000000-0000-4000-8000-000000000000',
    expectedVersion: 1,
    target: hosted,
  }
  const issue = (value: string) => {
    const parsed = ConvertToCredentialRequest.safeParse({ ...base, value })
    return parsed.success ? null : parsed.error.issues[0]!.message
  }
  const parsed = (target: Record<string, unknown>, value = 'hunter2') =>
    ConvertToCredentialRequest.safeParse({ ...base, value, target })

  it('标识、名称、说明与字段名里不能有这个值：它们都是明文', () => {
    const value = 'hunter2'
    expect(parsed(hosted).success).toBe(true)
    expect(parsed({ ...hosted, description: null }).success).toBe(true)
    for (const extra of [
      { identifier: 'hunter2-box' },
      { name: '密码 hunter2' },
      { description: '值是 hunter2' },
      { field: 'hunter2' },
    ]) {
      const result = parsed({ ...hosted, ...extra })
      expect(result.success, JSON.stringify(extra)).toBe(false)
      expect(result.error!.issues[0]!.message).not.toContain(value)
    }
  })

  it('收正常的值，不收太短、前后有空白、不完整的字符与占位符；报错不带值', () => {
    expect(issue('hunter2')).toBeNull()
    expect(issue('abc')).toContain('至少 4 个字符')
    expect(issue(' hunter2')).toContain('空白')
    expect(issue('hunter2\n')).toContain('空白')
    expect(issue('abcd\ud83d')).toContain('不完整')
    expect(issue('abc{{cred:x}}')).toContain('占位符')
    for (const value of ['abc', ' hunter2', 'abc{{cred:x}}']) {
      expect(issue(value)).not.toContain(value)
    }
  })

  it('换成已有凭据：给凭据与字段，字段名里不能有这个值', () => {
    const target = {
      kind: 'credential',
      credentialId: '00000000-0000-4000-8000-000000000001',
      field: 'password',
    }
    expect(parsed(target).success).toBe(true)
    expect(parsed({ ...target, field: 'hunter2' }).success).toBe(false)
    expect(parsed({ ...target, credentialId: 'x' }).success).toBe(false)
  })

  it('给密码库条目起标识：字段对应可以不给，给了要有这个条目字段；明文的部分里不能有这个值', () => {
    const target = {
      kind: 'vault',
      connectionId: '00000000-0000-4000-8000-000000000002',
      itemId: 'abc-123',
      itemField: 'login.password',
      identifier: 'nas',
    }
    expect(parsed(target).success).toBe(true)
    expect(
      parsed({ ...target, fields: [{ name: 'password', itemField: 'login.password' }] }).success,
    ).toBe(true)
    const missing = parsed({ ...target, fields: [{ name: 'user', itemField: 'login.username' }] })
    expect(missing.success).toBe(false)
    expect(missing.error!.issues[0]!.path).toEqual(['target', 'fields'])
    expect(parsed({ ...target, itemField: 'login.uris' }).success).toBe(false)
    for (const extra of [
      { identifier: 'hunter2' },
      { name: 'hunter2 的条目' },
      { description: '值 hunter2' },
      { itemField: 'field:hunter2' },
      {
        fields: [
          { name: 'password', itemField: 'login.password' },
          { name: 'hunter2', itemField: 'notes' },
        ],
      },
    ]) {
      expect(parsed({ ...target, ...extra }).success, JSON.stringify(extra)).toBe(false)
    }
  })

  it('不认识的去处与旧的写法都不收', () => {
    expect(parsed({ kind: 'other' }).success).toBe(false)
    const old = ConvertToCredentialRequest.safeParse({
      memoryId: base.memoryId,
      expectedVersion: 1,
      value: 'hunter2',
      identifier: 'wifi',
      name: '无线网络',
      field: 'password',
    })
    expect(old.success).toBe(false)
  })
})

describe('按值查找的请求', () => {
  const parse = (values: unknown) => MatchCredentialValuesRequest.safeParse({ values })

  it('1 到 20 个值，每个和转存的值同样的规则；报错不带值', () => {
    expect(parse(['hunter2']).success).toBe(true)
    expect(parse(Array.from({ length: 20 }, (_, i) => `value-${i}`)).success).toBe(true)
    expect(parse([]).success).toBe(false)
    expect(parse(Array.from({ length: 21 }, (_, i) => `value-${i}`)).success).toBe(false)
    expect(parse(['x'.repeat(16_384)]).success).toBe(true)
    expect(parse(['x'.repeat(16_385)]).success).toBe(false)
    for (const value of ['abc', ' hunter2', 'abc{{cred:x}}']) {
      const result = parse([value])
      expect(result.success, value).toBe(false)
      expect(result.error!.issues[0]!.message).not.toContain(value)
    }
  })
})

describe('占位符能放在哪里', () => {
  it('只有本人、敏感级不低于私密', () => {
    for (const layer of LAYERS) {
      for (const sensitivity of SENSITIVITIES) {
        const expected = layer === 'user' && (sensitivity === 'private' || sensitivity === 'secret')
        expect(placeholderAllowed(layer, sensitivity), `${layer} ${sensitivity}`).toBe(expected)
      }
    }
  })
})

describe('写入时放行的标记与拒绝时的错误', () => {
  const create = { uri: 'user://notes/wifi', content: '密码：hunter2' }

  it('Key 的请求只收 plaintextOk，管理界面的只收另外两个；给错一边的去掉', () => {
    const all = { plaintextOk: true, ignorePlaintext: true, allowPlaintext: true }
    expect(CreateMemoryRequest.parse({ ...create, ...all })).toMatchObject({ plaintextOk: true })
    expect(CreateMemoryRequest.parse({ ...create, ...all })).not.toHaveProperty('ignorePlaintext')
    expect(CreateMemoryRequest.parse({ ...create, ...all })).not.toHaveProperty('allowPlaintext')
    expect(UpdateMemoryRequest.parse({ uri: create.uri, ...all })).toEqual({
      uri: create.uri,
      plaintextOk: true,
    })
    const console = ConsoleCreateMemoryRequest.parse({ ...create, ...all })
    expect(console).toMatchObject({ ignorePlaintext: true, allowPlaintext: true })
    expect(console).not.toHaveProperty('plaintextOk')
    expect(ConsoleUpdateMemoryRequest.parse({ uri: create.uri, ...all })).toEqual({
      uri: create.uri,
      ignorePlaintext: true,
      allowPlaintext: true,
    })
  })

  it('错误体兼容只有 error 的写法，plaintext 只有行号与类别', () => {
    expect(MemoryWriteError.parse({ error: '没有权限' })).toEqual({ error: '没有权限' })
    const body = { error: '正文第 1 行疑似明文', plaintext: [{ line: 1, kind: 'label' }] }
    expect(MemoryWriteError.parse(body)).toEqual(body)
    expect(ErrorResponse.parse(body)).toEqual({ error: body.error })
    const bad = { ...body, plaintext: [{ line: 1, kind: 'x' }] }
    expect(MemoryWriteError.safeParse(bad).success).toBe(false)
  })
})

describe('Lore 导入里的疑似明文', () => {
  it('计划的每个节点带着疑似明文，只有位置、类别与对上的凭据', () => {
    const spot = {
      index: 0,
      line: 3,
      kind: 'github',
      credential: {
        id: '00000000-0000-4000-8000-000000000001',
        identifier: 'github',
        name: 'GitHub',
        field: 'token',
      },
    }
    expect(LorePlaintextSpot.parse(spot)).toEqual(spot)
    expect(LorePlaintextSpot.parse({ ...spot, credential: null }).credential).toBeNull()
    expect(LorePlanNode.shape.plaintext.parse([spot])).toEqual([spot])
  })

  it('写入时要换成占位符的几处，不给时为空', () => {
    const base = {
      source: { kind: 'url', url: 'http://127.0.0.1:18901', token: '' },
      fingerprint: 'f',
    }
    expect(LoreImportApplyRequest.parse(base).convertPlaintext).toEqual([])
    // 每一处带上计划里对上的凭据：写入时只核对这一条
    const spot = {
      source: 'core://agent',
      index: 1,
      credentialId: '00000000-0000-4000-8000-000000000001',
      field: 'password',
    }
    const convertPlaintext = [spot]
    expect(LoreImportApplyRequest.parse({ ...base, convertPlaintext }).convertPlaintext).toEqual(
      convertPlaintext,
    )
    for (const bad of [
      { ...spot, index: -1 },
      { source: spot.source, index: 1 },
      { ...spot, credentialId: 'x' },
      { ...spot, field: 'Password ' },
    ]) {
      expect(
        LoreImportApplyRequest.safeParse({ ...base, convertPlaintext: [bad] }).success,
        JSON.stringify(bad),
      ).toBe(false)
    }
  })
})

describe('「密码：…」后面不是值的写法', () => {
  const flagged = (text: string) => {
    const found = findPlaintextCredentials(text)
    expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(found.length > 0)
    return found.length > 0
  }

  it('类型名不算，后面紧接字母、数字或 _ 的照样算', () => {
    for (const type of [
      'string',
      'str',
      'number',
      'int',
      'integer',
      'float',
      'bool',
      'boolean',
      'bytes',
      'null',
      'None',
      'nil',
      'undefined',
      'any',
      'unknown',
      'object',
      'Optional[str]',
      'SecretStr',
      'string | null',
      'string;',
      'String,',
      '"string"',
    ]) {
      expect(flagged(`password: ${type}`), type).toBe(false)
    }
    for (const value of ['string123', 'stringent', 'str0ng', 'nullable', 'any_key', 'int3ger']) {
      expect(flagged(`password: ${value}`), value).toBe(true)
    }
  })

  it('变量与环境变量的引用不算', () => {
    for (const ref of [
      '$DB_PASSWORD',
      '${DB_PASSWORD}',
      '$(cat /run/secrets/db)',
      '%DB_PASSWORD%',
      'process.env.API_KEY',
      'os.environ["API_KEY"]',
      "os.getenv('API_KEY')",
      'getenv("API_KEY")',
      "env('API_KEY')",
      '"${DB_PASSWORD}"',
    ]) {
      expect(flagged(`password: ${ref}`), ref).toBe(false)
      expect(flagged(`apiKey: ${ref}`), ref).toBe(false)
    }
    // 不像变量的照样算
    for (const value of ['$100abc', '%abc', 'process.envy', 'environ', 'myenv(x)']) {
      expect(flagged(`password: ${value}`), value).toBe(true)
    }
  })

  it('同一行里的尖括号占位不算，太长或跨行的照样算', () => {
    expect(flagged('password: <你的密码>')).toBe(false)
    expect(flagged('token = <TOKEN>')).toBe(false)
    expect(flagged('password: "<redacted>"')).toBe(false)
    expect(flagged(`password: <${'a'.repeat(65)}>`)).toBe(true)
    expect(flagged('password: <abc\ndef>')).toBe(true)
    expect(flagged('password: <abc')).toBe(true)
  })

  it('空的引号不算，引号里有字的照样算', () => {
    expect(flagged('password: ""')).toBe(false)
    expect(flagged("password: ''")).toBe(false)
    expect(flagged('"password": ""')).toBe(false)
    expect(flagged('password: "a"')).toBe(true)
  })

  it('整段都是遮盖的不算：*、x、.、… 连续 3 个以上，紧接着就是值的结尾', () => {
    for (const mask of [
      '***',
      '********',
      'xxxx',
      'XXXXXXXX',
      '...',
      '………',
      '**xxxx**',
      '"xxxx"',
    ]) {
      expect(flagged(`password: ${mask}`), mask).toBe(false)
      expect(flagged(`password: ${mask}，别告诉别人`), mask).toBe(false)
    }
    for (const value of [
      'xx',
      'xxxxy',
      'xxx1',
      '....a',
      '****x',
      '*****x',
      '…a',
      '***hunter2***',
    ]) {
      expect(flagged(`password: ${value}`), value).toBe(true)
    }
  })

  it('代码表达式照样算：确实不是凭据时由写入方确认', () => {
    expect(flagged('password: config.password')).toBe(true)
    expect(flagged('token = getToken()')).toBe(true)
  })
})

describe('补上的写法', () => {
  it('JSON 与字典的键：标签和冒号之间隔着收尾的引号', () => {
    expect(values('{"password": "hunter2"}')).toEqual([{ value: 'hunter2', field: 'password' }])
    expect(values("{'token': 'abc123'}")).toEqual([{ value: 'abc123', field: 'token' }])
    expect(values('"api_key":"xyz"')).toEqual([{ value: 'xyz', field: 'api_key' }])
  })

  it('SECRET_KEY、AWS_SECRET_ACCESS_KEY 与 passphrase', () => {
    expect(values("SECRET_KEY = 'django-insecure-abc'")).toEqual([
      { value: 'django-insecure-abc', field: 'secret' },
    ])
    expect(values('AWS_SECRET_ACCESS_KEY=example-value')).toEqual([
      { value: 'example-value', field: 'secret' },
    ])
    expect(values('secret-key: s3cret')).toEqual([{ value: 's3cret', field: 'secret' }])
    expect(values('passphrase: correct horse')).toEqual([{ value: 'correct', field: 'password' }])
  })

  it('Stripe 的私钥与受限密钥算 sk 一类，公开的 pk_ 不算', () => {
    for (const prefix of ['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_']) {
      const key = join(prefix, run(24))
      const found = findPlaintextCredentials(`STRIPE=${key}`)
      expect(
        found.map((m) => m.kind),
        prefix,
      ).toEqual(['sk'])
    }
    expect(PLAINTEXT_CREDENTIAL.test(join('pk_live_', run(24)))).toBe(false)
    expect(PLAINTEXT_CREDENTIAL.test(join('sk_prod_', run(24)))).toBe(false)
  })

  it('不该报的：token_count、secrets: 下面接嵌套的键', () => {
    for (const text of [
      'token_count: 5',
      'max_tokens: 1024',
      'secrets:\n  db:\n    host: 127.0.0.1',
      'tokenizer: bpe',
      'secretary: 张三',
    ]) {
      expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(false)
    }
  })
})

describe('私钥块的结尾', () => {
  const header = join('-----BEGIN RSA ', 'PRIVATE KEY-----')
  const footer = join('-----END RSA ', 'PRIVATE KEY-----')

  it('没有 END 时到最后一个整行都是 base64 的行，后面的散文不算', () => {
    const block = `${header}\n${run(64)}\n${run(64)}`
    const text = `${block}\n这是一段说明，后面还有 ${footer} 字样\nmore text`
    const found = findPlaintextCredentials(text)
    expect(found.map((m) => text.slice(m.start, m.end))).toEqual([block])
    // 空行也停
    const gap = `${block}\n\n${run(64)}`
    expect(findPlaintextCredentials(gap).map((m) => gap.slice(m.start, m.end))).toEqual([block])
  })

  it('截断的块后面再跟一个完整的块：各算一处，前一块不吞掉后一块', () => {
    const truncated = `${header}\n${run(64)}`
    const complete = `${header}\n${run(64)}\n${run(20)}==\n${footer}`
    const text = `${truncated}\n${complete}`
    expect(findPlaintextCredentials(text).map((m) => text.slice(m.start, m.end))).toEqual([
      truncated,
      complete,
    ])
  })
})

describe('不切子串：长正文、很多处时也是线性的', () => {
  it('20 万字的 token=a 与几千个令牌都在 1 秒内', () => {
    const inputs = [
      'token=a '.repeat(25_000),
      Array.from({ length: 5000 }, () => join('gh', 'p_', run(36))).join(' '),
      'token="a '.repeat(20_000),
      'token=token='.repeat(15_000),
      `${'password=“a'.repeat(15_000)}`,
      Array.from({ length: 5000 }, () => `token: ${join('gh', 'p_', run(36))}`).join(' '),
      // 引号里的值：找占位符不往后扫到底
      'password:"a"'.repeat(170_000),
    ]
    for (const text of inputs) {
      const started = Date.now()
      findPlaintextCredentials(text)
      findPlaintextCredentials(text, { overlapping: true })
      expect(Date.now() - started, text.slice(0, 20)).toBeLessThan(1000)
    }
  })
})

describe('新增按值比，值的结尾猜得准', () => {
  it('值后面加了括号里的备注、查询串拆成两行，都不算新增', () => {
    expect(addedPlaintextCredentials('密码：hunter2', '密码：hunter2（旧）')).toEqual([])
    expect(addedPlaintextCredentials('token=abc&password=xyz', 'token=abc\npassword=xyz')).toEqual(
      [],
    )
  })
})

describe('不是值的写法后面要紧接值的结尾', () => {
  const flagged = (text: string) => {
    const found = findPlaintextCredentials(text)
    expect(PLAINTEXT_CREDENTIAL.test(text), text).toBe(found.length > 0)
    return found.length > 0
  }

  it('变量引用要是整段值，后面跟着字的照样算', () => {
    for (const value of [
      '$DB_PASSWORD',
      '${DB_PASSWORD}',
      '$(cat /run/secrets/db)',
      '%DB_PASSWORD%',
      'process.env.API_KEY',
      'process.env["API_KEY"]',
      "os.environ['API_KEY']",
      "os.getenv('API_KEY')",
      'getenv("API_KEY")',
      "env('API_KEY')",
      "env('API_KEY'))",
      'process.env.API_KEY,',
      '"${DB_PASSWORD}"',
      // 已知的限制：$ 后面全是字母、数字或 _ 的整段值按变量算
      '$ecretPass1',
    ]) {
      expect(flagged(`password: ${value}`), value).toBe(false)
    }
    for (const value of [
      '${x}abc',
      '$(cmd)x',
      '%X%y',
      '$X-abc',
      '$X;abc',
      'process.env.X+y',
      'process.env["X"]abc',
      "os.environ['X']abc",
      'os.getenv("X")abc',
      'getenv(x)y',
      "env('X')abc",
      `\${${'a'.repeat(65)}}`,
    ]) {
      expect(flagged(`password: ${value}`), value).toBe(true)
    }
  })

  it('尖括号占位与空的引号要是整段值', () => {
    for (const value of [
      '<你的密码>',
      '<TOKEN>',
      '"<redacted>"',
      '<x>，',
      '""',
      "''",
      '"",',
      '"  "',
    ]) {
      expect(flagged(`password: ${value}`), value).toBe(false)
    }
    for (const value of ['<b>hunter2</b>', '<x>hunter2', '""hunter2', "''x"]) {
      expect(flagged(`password: ${value}`), value).toBe(true)
    }
  })

  it('类型名后面可以是值的结尾或代码里常跟着的符号，别的照样算', () => {
    for (const text of [
      'password: string[]',
      'token: Optional<str>',
      'password: string | null',
      'login(password: string)',
      'password: string;',
      'password: str = None',
      'password?: string,',
      '{ password: string }',
    ]) {
      expect(flagged(text), text).toBe(false)
    }
    for (const value of ['none!23', 'any-key-2024abc', 'Str#1234', 'string123', 'null.x']) {
      expect(flagged(`password: ${value}`), value).toBe(true)
    }
  })

  it('引号里只有空白与占位符的不是值', () => {
    for (const text of [
      'password: "  {{cred:a#b}}"',
      'password: "{{cred:a#b}}"',
      'password:   {{cred:a#b}}',
    ]) {
      expect(flagged(text), text).toBe(false)
    }
    expect(flagged('password: "x {{cred:a#b}}"')).toBe(true)
  })
})

describe('写在引号里的键', () => {
  it('标签前面有开头的引号才认收尾的引号', () => {
    expect(values('{"db_password": "x1"}')).toEqual([{ value: 'x1', field: 'password' }])
    expect(values("{'api_key': 'x1'}")).toEqual([{ value: 'x1', field: 'api_key' }])
    expect(values('"密码": "x1"')).toEqual([{ value: 'x1', field: 'password' }])
    expect(PLAINTEXT_CREDENTIAL.test('the token": abc')).toBe(false)
    expect(PLAINTEXT_CREDENTIAL.test("the password' = abc")).toBe(false)
    expect(PLAINTEXT_CREDENTIAL.test('"a b password": abc')).toBe(false)
  })
})

describe('新增按延伸的值比', () => {
  const added = (before: string | null, after: string) =>
    addedPlaintextCredentials(before, after).map((m) => after.slice(m.start, m.end))

  it('截到 & 的值相同、& 后面不同的算新增', () => {
    expect(added('password: hunter2&old', 'password: hunter2&NEWSECRET')).toEqual(['hunter2'])
    expect(added('password: hunter2', 'password: hunter2&NEW')).toEqual(['hunter2'])
  })

  it('后面加注解、拆开、截短的不算', () => {
    expect(added('密码：hunter2', '密码：hunter2（旧）')).toEqual([])
    expect(added('密码：hunter2', '密码：hunter2【已换】')).toEqual([])
    expect(added('token=abc&password=xyz', 'token=abc\npassword=xyz')).toEqual([])
    expect(added('password: hunter2&old', 'password: hunter2')).toEqual([])
    // 注解之后又改了值本身的照样算
    expect(added('密码：hunter2', '密码：hunter3（旧）')).toEqual(['hunter3'])
  })
})
