import { describe, expect, it } from 'vitest'

import { placeholderOf, splitPlaceholders } from '../placeholders'

describe('正文里的凭据占位符', () => {
  it('拆出整条与单个字段的引用，格式不对的留作普通文字', () => {
    expect(
      splitPlaceholders('账号 {{cred:file-server#username}}，{{cred:API}} 与 {{cred:token}}'),
    ).toEqual([
      { text: '账号 ' },
      {
        text: '{{cred:file-server#username}}',
        ref: { identifier: 'file-server', field: 'username' },
      },
      { text: '，{{cred:API}} 与 ' },
      { text: '{{cred:token}}', ref: { identifier: 'token', field: null } },
    ])
    expect(splitPlaceholders('没有占位符')).toEqual([{ text: '没有占位符' }])
  })

  it('插入时的写法与服务端认的一致', () => {
    expect(placeholderOf('file-server', 'password')).toBe('{{cred:file-server#password}}')
    expect(placeholderOf('file-server', null)).toBe('{{cred:file-server}}')
  })
})
