import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client'
import {
  addedSpots,
  linesText,
  plaintextRejection,
  saveFlags,
  spotsFromFindings,
} from '../plaintextSave'

describe('这次新增的疑似明文', () => {
  it('新建时全算；同一个值只算一处，行号合在一起', () => {
    const content = '密码：hunter22\ntoken=abcd1234\n备用 password: hunter22'
    expect(addedSpots(null, content)).toEqual([
      { value: 'hunter22', lines: [1, 3], kind: 'label', field: 'password' },
      { value: 'abcd1234', lines: [2], kind: 'label', field: 'token' },
    ])
  })

  it('修改时原来就有的值不算，挪了位置、换了写法也不算；新的值算', () => {
    const before = '密码：hunter22'
    expect(addedSpots(before, '前面加一行\ntoken: hunter22')).toEqual([])
    expect(addedSpots(before, '密码：hunter22\n密码：newpass99')).toEqual([
      { value: 'newpass99', lines: [2], kind: 'label', field: 'password' },
    ])
  })

  it('占位符不算', () => {
    expect(addedSpots(null, '密码：{{cred:nas#password}}')).toEqual([])
  })
})

describe('服务端拒绝的兜底', () => {
  it('只认 400 且带着疑似明文的位置', () => {
    const body = { error: '疑似明文', plaintext: [{ line: 2, kind: 'label' }] }
    expect(plaintextRejection(new ApiError(400, '疑似明文', body))).toEqual(body.plaintext)
    expect(plaintextRejection(new ApiError(400, '别的', { error: '别的' }))).toBeNull()
    expect(plaintextRejection(new ApiError(409, '冲突', body))).toBeNull()
    expect(plaintextRejection(new Error('x'))).toBeNull()
  })

  it('按行号与类别在正文里找值；找不到的照样列出，没有值', () => {
    const content = '第一行\n密码：hunter22\n第三行'
    expect(
      spotsFromFindings(content, [
        { line: 2, kind: 'label' },
        { line: 3, kind: 'github' },
      ]),
    ).toEqual([
      { value: 'hunter22', lines: [2], kind: 'label', field: 'password' },
      { value: null, lines: [3], kind: 'github', field: 'password' },
    ])
  })
})

describe('保存时的标记', () => {
  it('照样保存带 allowPlaintext；有不是凭据的带 ignorePlaintext；全部转存不带', () => {
    expect(saveFlags(['convert', 'ignore'], true)).toEqual({ allowPlaintext: true })
    expect(saveFlags(['convert', 'ignore'])).toEqual({ ignorePlaintext: true })
    expect(saveFlags(['ignore'])).toEqual({ ignorePlaintext: true })
    expect(saveFlags(['convert', 'convert'])).toEqual({})
  })

  it('行号按先后写', () => {
    expect(linesText([5, 2])).toBe('第 2、5 行')
  })
})
