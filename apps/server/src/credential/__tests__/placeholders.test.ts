import { describe, expect, it } from 'vitest'

import {
  looksLikePlaintextCredential,
  maskPlaintextCredentials,
  placeholderIdentifiers,
  replaceOutsidePlaceholders,
  scanPlaceholders,
} from '../placeholders'

describe('凭据占位符', () => {
  it('找出整条与单个字段的引用，代码块与行内代码里的也算', () => {
    const text = [
      '账号 {{cred:file-server#username}}，密码 `{{cred:file-server#password}}`',
      '```',
      'curl -u {{cred:api_token}}',
      '```',
    ].join('\n')
    expect(scanPlaceholders(text)).toEqual({
      refs: [
        { identifier: 'file-server', field: 'username' },
        { identifier: 'file-server', field: 'password' },
        { identifier: 'api_token', field: null },
      ],
      malformed: [],
    })
    expect([...placeholderIdentifiers(text)]).toEqual(['file-server', 'api_token'])
  })

  it('以 {{cred: 开头、格式不对的都算格式错误', () => {
    for (const bad of [
      '{{cred:File}}',
      '{{cred:x#}}',
      '{{cred:x',
      '{{cred:x#a#b}}',
      '{{cred:}}',
      '{{cred:x }}',
    ]) {
      expect(scanPlaceholders(`前面 ${bad} 后面`).malformed, bad).toHaveLength(1)
    }
    // 嵌在一起时，外层那个格式不对，里面那个照常算引用
    expect(scanPlaceholders('{{cred:{{cred:x}}')).toEqual({
      refs: [{ identifier: 'x', field: null }],
      malformed: ['{{cred:{{cred:x}}'],
    })
  })

  it('不以 {{cred: 开头的写法不算引用：要在正文里写到占位符的写法时，去掉花括号', () => {
    expect(scanPlaceholders('写法是 cred:<标识>#<字段>，或 { {cred:x} }、{{ cred:x }}')).toEqual({
      refs: [],
      malformed: [],
    })
  })
})

describe('明文凭据提醒', () => {
  it('「密码：…」「token = …」这类写法与 sk- 开头的长串算像有明文，值写在下一行的也算', () => {
    for (const text of [
      '密码：hunter2',
      'password = abc',
      'API Key: xyz',
      'api_key=xyz',
      '口令 ：1234',
      `key sk-${'a'.repeat(20)}`,
      '密码：\n  hunter2',
      'password\n: hunter2',
    ]) {
      expect(looksLikePlaintextCredential(text), text).toBe(true)
    }
  })

  it('后面跟着占位符（换行之后的也算）、冒号后面没有值、或只是词的一部分的不算', () => {
    for (const text of [
      '密码：{{cred:file-server#password}}',
      'token = {{cred:api#token}}',
      'token =\n  {{cred:api#token}}',
      '密码：',
      'tokenizer: 分词器',
      'sk-short',
    ]) {
      expect(looksLikePlaintextCredential(text), text).toBe(false)
    }
  })
})

describe('把值换掉', () => {
  const swap = (text: string, value: string) => replaceOutsidePlaceholders(text, value, '<新>')

  it('出现几处换几处，数得对', () => {
    expect(swap('abcd 和 abcd', 'abcd')).toEqual({ text: '<新> 和 <新>', replaced: 2 })
    expect(swap('没有', 'abcd')).toEqual({ text: '没有', replaced: 0 })
  })

  it('占位符不动：值是 cred、标识或字段名时都不改坏', () => {
    expect(swap('{{cred:foo}} 的 cred', 'cred')).toEqual({
      text: '{{cred:foo}} 的 <新>',
      replaced: 1,
    })
    expect(swap('{{cred:prod-db#password}} 在 prod-db', 'prod-db')).toEqual({
      text: '{{cred:prod-db#password}} 在 <新>',
      replaced: 1,
    })
    expect(swap('{{cred:a#password}}password{{cred:b}}', 'password')).toEqual({
      text: '{{cred:a#password}}<新>{{cred:b}}',
      replaced: 1,
    })
    expect(swap('只在 {{cred:prod-db}} 里', 'prod-db').replaced).toBe(0)
  })

  it('跨过占位符边界的不算；格式不对的不算占位符，里面的值照样换', () => {
    expect(swap('x{{cred:a}}y', 'x{{cred')).toEqual({ text: 'x{{cred:a}}y', replaced: 0 })
    expect(swap('{{cred:BAD hunter2}}', 'hunter2')).toEqual({
      text: '{{cred:BAD <新>}}',
      replaced: 1,
    })
  })

  it('替换用的文字里的 $ 不当特殊符号', () => {
    expect(replaceOutsidePlaceholders('abcd', 'abcd', "$&$'")).toEqual({
      text: "$&$'",
      replaced: 1,
    })
  })
})

describe('提示语打码', () => {
  it('盖过之后规则不再算明文', () => {
    for (const text of [
      '路由器密码：hunter2 怎么改',
      'token=abc,password: hunter2',
      '密码：a1\n口令：b2',
    ]) {
      expect(looksLikePlaintextCredential(text), text).toBe(true)
      expect(looksLikePlaintextCredential(maskPlaintextCredentials(text)), text).toBe(false)
    }
  })

  it('从值开始盖到行尾，下一行照常', () => {
    expect(maskPlaintextCredentials('路由器密码：hunter2 怎么改')).toBe('路由器密码：***')
    expect(maskPlaintextCredentials('token=abc.def\n下一行')).toBe('token=***\n下一行')
    expect(maskPlaintextCredentials('用 sk-abcdefghijklmnopqrst 调接口')).toBe('用 ***')
    expect(maskPlaintextCredentials('password = "correct horse battery staple"')).toBe(
      'password = ***',
    )
  })

  it('挨着的几处凭据都打码，重叠的匹配不会漏掉后面的值', () => {
    for (const text of [
      'token=abc,password: hunter2',
      'token=abc&secret=\tS3cr3t!',
      'apikey=xyz,api_key=\nsk-abcdefghijklmnopqrstuv',
      '密码：a1\n口令：b2\n用 sk-abcdefghijklmnopqrst 调接口',
    ]) {
      const masked = maskPlaintextCredentials(text)
      for (const secret of ['hunter2', 'S3cr3t!', 'sk-abcdefghijklmnopqrstuv', 'a1', 'b2']) {
        expect(masked).not.toContain(secret)
      }
    }
    expect(maskPlaintextCredentials('密码：a1\n口令：b2')).toBe('密码：***\n口令：***')
    // sk- 串吞掉后面紧跟的关键词时，照样盖到行尾；挨着的两处合成一段
    expect(maskPlaintextCredentials('sk-AAAAAAAAAAAAAAAApassword:correct horse battery')).toBe(
      '***',
    )
    expect(maskPlaintextCredentials('前 sk-abcdefghijklmnopqrst密码：hunter2 x')).toBe('前 ***')
  })

  it('没有像凭据的片段时原样返回，占位符不打码', () => {
    expect(maskPlaintextCredentials('帮我看看今天的天气')).toBe('帮我看看今天的天气')
    expect(maskPlaintextCredentials('密码：{{cred:router#password}}')).toBe(
      '密码：{{cred:router#password}}',
    )
  })
})
