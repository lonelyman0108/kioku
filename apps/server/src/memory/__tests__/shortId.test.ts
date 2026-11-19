import { SHORT_ID_PATTERN } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { generateShortId, normalizeShortId, rewriteWikiLinks } from '../shortId'

describe('短 ID 生成、规范化与双链重写', () => {
  it('生成的短 ID 符合 Base30 无歧义格式且支持 6/7/8 位扩展', () => {
    for (let i = 0; i < 40; i++) {
      const id = generateShortId()
      expect(id).toMatch(SHORT_ID_PATTERN)
      expect(id).toHaveLength(8)
      expect(id).not.toMatch(/[01ilou]/)
    }
    expect(generateShortId(7)).toMatch(SHORT_ID_PATTERN)
    expect(generateShortId(7)).toHaveLength(9)
    expect(generateShortId(8)).toMatch(SHORT_ID_PATTERN)
    expect(generateShortId(8)).toHaveLength(10)
  })

  it('normalizeShortId 会去空白、转小写并拒绝非法或含易混淆字符的串', () => {
    const upper = 'm-234567'.toUpperCase()
    expect(normalizeShortId(`  ${upper}  `)).toBe('m-234567')
    expect(normalizeShortId('m-23456')).toBeNull()
    expect(normalizeShortId('m-234567890')).toBeNull()
    expect(normalizeShortId('m-abcde0')).toBeNull()
    expect(normalizeShortId('m-234560')).toBeNull()
    expect(normalizeShortId('m-234561')).toBeNull()
    expect(normalizeShortId('m-23456i')).toBeNull()
    expect(normalizeShortId('m-23456l')).toBeNull()
    expect(normalizeShortId('m-23456o')).toBeNull()
    expect(normalizeShortId('m-23456u')).toBeNull()
    expect(normalizeShortId('not-an-id')).toBeNull()
  })

  it('rewriteWikiLinks 只替换映射表命中的短 ID 并保留别名与大小写无关匹配', () => {
    const remap = new Map([
      ['m-234567', 'm-89abcd'],
      ['m-aaaaaa', 'm-bbbbbb'],
    ])
    const upper = 'm-234567'.toUpperCase()
    const input = `参见 [[${upper}|网络架构]]、[[m-aaaaaa]] 以及未映射的 [[m-999999|保持不变]]。`
    const output = rewriteWikiLinks(input, remap)
    expect(output).toBe(
      '参见 [[m-89abcd|网络架构]]、[[m-bbbbbb]] 以及未映射的 [[m-999999|保持不变]]。',
    )
  })
})
