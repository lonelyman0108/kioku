import { describe, expect, it } from 'vitest'

import {
  looksLikePlaintextCredential,
  placeholderIdentifiers,
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
  it('「密码：…」「token = …」这类写法与 sk- 开头的长串算像有明文', () => {
    for (const text of [
      '密码：hunter2',
      'password = abc',
      'API Key: xyz',
      'api_key=xyz',
      '口令 ：1234',
      `key sk-${'a'.repeat(20)}`,
    ]) {
      expect(looksLikePlaintextCredential(text), text).toBe(true)
    }
  })

  it('后面跟着占位符、冒号后面没有值、或只是词的一部分的不算', () => {
    for (const text of [
      '密码：{{cred:file-server#password}}',
      'token = {{cred:api#token}}',
      '密码：\n见下一行',
      'tokenizer: 分词器',
      'sk-short',
    ]) {
      expect(looksLikePlaintextCredential(text), text).toBe(false)
    }
  })
})
