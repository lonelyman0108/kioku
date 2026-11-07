import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client'
import {
  addedSpots,
  afterGate,
  linesText,
  plaintextRejection,
  saveFlags,
  spotsAfterRejection,
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

describe('服务端拒绝之后开哪一份弹窗', () => {
  it('正文还是发出去的那份：以服务端为准，本地没认出新增的也列出来', () => {
    // 原来就有 hunter22：本地按值比不算新增，服务端说第 1 行是新增的
    const before = '旧的 hunter22'
    const sent = '密码：hunter22\ntoken=abcd1234'
    const gate = spotsAfterRejection(before, sent, sent, [
      { line: 1, kind: 'label' },
      { line: 2, kind: 'label' },
    ])
    expect(gate!.content).toBe(sent)
    expect(gate!.spots.map((s) => s.value)).toEqual(['hunter22', 'abcd1234'])
  })

  it('请求期间又改过正文：按现在的正文重算，不用发出去的那份', () => {
    const sent = '密码：hunter22'
    const current = '密码：hunter22\n又打了几个字 token=abcd1234'
    const gate = spotsAfterRejection(null, sent, current, [{ line: 1, kind: 'label' }])
    expect(gate!.content).toBe(current)
    expect(gate!.spots.map((s) => s.value)).toEqual(['hunter22', 'abcd1234'])
  })

  it('改过之后没有新增的：不开弹窗', () => {
    expect(
      spotsAfterRejection(null, '密码：hunter22', '删掉了', [{ line: 1, kind: 'label' }]),
    ).toBe(null)
  })
})

describe('弹窗处理完之后', () => {
  const result = {
    source: '密码：hunter22',
    content: '密码：{{cred:a#password}}',
    flags: { ignorePlaintext: true } as const,
  }

  it('结果是按现在的正文算的：用它', () => {
    expect(afterGate(null, '密码：hunter22', result)).toEqual({
      kind: 'save',
      content: result.content,
      flags: result.flags,
    })
  })

  it('这期间正文变了：不丢新打的字，按现在的正文重算', () => {
    const current = '密码：hunter22\n新打的字 token=abcd1234'
    const next = afterGate(null, current, result)
    expect(next.kind).toBe('reopen')
    expect(next.kind === 'reopen' && next.spots.map((s) => s.value)).toEqual([
      'hunter22',
      'abcd1234',
    ])
    expect(afterGate(null, '没有明文了', result)).toEqual({
      kind: 'save',
      content: '没有明文了',
      flags: {},
    })
  })
})
