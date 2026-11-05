import type { ConvertedToCredential } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  convertLeftovers,
  convertSummary,
  occurrences,
  plaintextCandidates,
  suggestIdentifier,
  suggestName,
  valueContext,
} from '../plaintext'

describe('猜出来的值', () => {
  it('每一处的值和字段名，来自 contracts 的规则', () => {
    expect(plaintextCandidates('密码：hunter2-not-real\n\ntoken=abcd1234 后面的话')).toEqual([
      { value: 'hunter2-not-real', field: 'password' },
      { value: 'abcd1234', field: 'token' },
    ])
  })

  it('同一个值只列一次：提交一次全都换掉', () => {
    expect(plaintextCandidates('password: abcd1234\ntoken: abcd1234')).toEqual([
      { value: 'abcd1234', field: 'password' },
    ])
  })

  it('已经是占位符的不算', () => {
    expect(plaintextCandidates('密码：{{cred:nas#password}}')).toEqual([])
  })
})

describe('建议的标识', () => {
  it('路径的各段连起来', () => {
    expect(suggestIdentifier('infra://nas/admin', 'password', [])).toBe('nas-admin')
  })

  it('开头和结尾的分隔符去掉，保证合规', () => {
    expect(suggestIdentifier('infra://_nas', 'password', [])).toBe('nas')
    expect(suggestIdentifier('infra://--', 'password', [])).toBe('password')
  })

  it('最长 64 个字符', () => {
    const long = 'a'.repeat(70)
    expect(suggestIdentifier(`infra://${long}`, 'password', [])).toHaveLength(64)
  })

  it('已有这个标识时加字段名，再不行加序号，也不超长', () => {
    expect(suggestIdentifier('infra://nas', 'password', ['nas'])).toBe('nas-password')
    expect(suggestIdentifier('infra://nas', 'password', ['nas', 'nas-password'])).toBe('nas-2')
    expect(
      suggestIdentifier('infra://nas', 'password', ['nas', 'nas-password', 'nas-2', 'nas-3']),
    ).toBe('nas-4')
    const long = 'b'.repeat(64)
    const next = suggestIdentifier(`infra://${long}`, 'password', [long])
    expect(next).toHaveLength(64)
    expect(next).not.toBe(long)
  })

  it('名称用路径', () => {
    expect(suggestName('infra://nas/admin')).toBe('nas/admin')
  })
})

describe('值在正文里的位置', () => {
  it('出现几处换几处，占位符里的不算，和服务端替换时一个规则', () => {
    expect(occurrences('abcd 和 abcd', 'abcd')).toBe(2)
    expect(occurrences('{{cred:abcd#password}} 和 abcd', 'abcd')).toBe(1)
    expect(occurrences('{{cred:abcd}}', 'abcd')).toBe(0)
    expect(occurrences('正文', '没有')).toBe(0)
    expect(occurrences('正文', '')).toBe(0)
  })

  it('格式不对的不算占位符，里面的值照样换', () => {
    expect(occurrences('{{cred:AB CD}} abcd', 'AB CD')).toBe(1)
  })

  it('前后文只取同一行：看得出值的结尾猜得对不对', () => {
    expect(valueContext('上一行\n密码：abc,def 备注\n下一行', 'abc')).toEqual({
      before: '密码：',
      after: ',def 备注',
      clippedBefore: false,
      clippedAfter: false,
    })
  })

  it('取第一处占位符之外的位置', () => {
    expect(valueContext('{{cred:abcd}} 后面 abcd 结束', 'abcd')).toMatchObject({
      before: '{{cred:abcd}} 后面 ',
      after: ' 结束',
    })
  })

  it('太长时截断并标出来，不切开表情符号', () => {
    const emoji = '😀'.repeat(40)
    const context = valueContext(`${emoji}abcd${emoji}`, 'abcd')!
    expect(context.clippedBefore).toBe(true)
    expect(context.clippedAfter).toBe(true)
    expect([...context.before]).toHaveLength(32)
    expect([...context.after]).toHaveLength(32)
    expect(context.before.startsWith('😀')).toBe(true)
    expect(context.after.endsWith('😀')).toBe(true)
  })

  it('找不到时没有前后文', () => {
    expect(valueContext('正文', '没有')).toBeNull()
    expect(valueContext('正文', '')).toBeNull()
    expect(valueContext('{{cred:abcd}}', 'abcd')).toBeNull()
  })
})

describe('转存做了什么', () => {
  const result = (scrubbedEvents: number) =>
    ({ credential: { name: 'NAS' }, replaced: 2, scrubbedEvents }) as ConvertedToCredential

  it('写新建的凭据和替换了几处，历史里替换过才说', () => {
    expect(convertSummary(result(0))).toBe('已新建凭据「NAS」，正文中 2 处已换成占位符。')
    expect(convertSummary(result(3))).toBe(
      '已新建凭据「NAS」，正文中 2 处已换成占位符。历史中 3 个事件里的这个值也已替换。',
    )
  })
})

describe('转存之后还要告诉人的', () => {
  const result = (plaintextVersions: number, otherMemories: number) =>
    ({ plaintextVersions, otherMemories }) as ConvertedToCredential

  it('都处理完了就不提', () => {
    expect(convertLeftovers(result(0, 0))).toEqual([])
  })

  it('历史里还有疑似明文的版本：说几个，建议怎么办', () => {
    const [item, ...rest] = convertLeftovers(result(2, 0))
    expect(rest).toEqual([])
    expect(item!.title).toContain('2 个版本')
    expect(item!.detail).toContain('改为机密')
  })

  it('别的记忆里还有这个值：说几条', () => {
    const [item, ...rest] = convertLeftovers(result(0, 3))
    expect(rest).toEqual([])
    expect(item!.title).toContain('3 条')
    expect(item!.detail).toContain('未改动')
  })

  it('两样都有时都说', () => {
    expect(convertLeftovers(result(1, 1))).toHaveLength(2)
  })
})
