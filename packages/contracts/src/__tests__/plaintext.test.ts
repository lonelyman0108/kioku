import { describe, expect, it } from 'vitest'

import {
  ConvertToCredentialRequest,
  CredentialFieldName,
  findPlaintextCredentials,
  PLAINTEXT_CREDENTIAL,
  placeholderAllowed,
} from '../credentials'
import { LAYERS, SENSITIVITIES } from '../memory'

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

  it('一个值里又像一处时不重复算', () => {
    expect(values('password=abc&token=def')).toEqual([
      { value: 'abc&token=def', field: 'password' },
    ])
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
    const flagged = ['密码：hunter2', 'password = abc', '密码：\n见下一行', 'password　: abc']
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
    // 引号里除了占位符还有别的：还是要看一眼
    expect(PLAINTEXT_CREDENTIAL.test('密码："abc{{cred:x}}"')).toBe(true)
    expect(findPlaintextCredentials('密码："abc{{cred:x}}"')).toEqual([])
  })
})

describe('转存为凭据的请求', () => {
  const base = {
    memoryId: '00000000-0000-4000-8000-000000000000',
    expectedVersion: 1,
    identifier: 'wifi',
    name: '无线网络',
    field: 'password',
  }
  const issue = (value: string) => {
    const parsed = ConvertToCredentialRequest.safeParse({ ...base, value })
    return parsed.success ? null : parsed.error.issues[0]!.message
  }

  it('标识、名称、说明与字段名里不能有这个值：它们都是明文', () => {
    const value = 'hunter2'
    const parsed = (extra: Record<string, unknown>) =>
      ConvertToCredentialRequest.safeParse({ ...base, value, ...extra })
    expect(parsed({}).success).toBe(true)
    expect(parsed({ description: null }).success).toBe(true)
    for (const extra of [
      { identifier: 'hunter2-box' },
      { name: '密码 hunter2' },
      { description: '值是 hunter2' },
      { field: 'hunter2' },
    ]) {
      const result = parsed(extra)
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
})

describe('占位符能放在哪里', () => {
  it('只有私人层、敏感级不低于私密', () => {
    for (const layer of LAYERS) {
      for (const sensitivity of SENSITIVITIES) {
        const expected =
          layer === 'private' && (sensitivity === 'private' || sensitivity === 'secret')
        expect(placeholderAllowed(layer, sensitivity), `${layer} ${sensitivity}`).toBe(expected)
      }
    }
  })
})
