import { describe, expect, it } from 'vitest'

import {
  extractTargetShortIds,
  extractWikiLinks,
  isShortId,
  ShortId,
  SHORT_ID_ALPHABET,
} from '../links'

describe('无歧义 Base30 短 ID', () => {
  it('字符集排除 0/o/1/i/l/u 且共 30 个字符', () => {
    expect(SHORT_ID_ALPHABET).toHaveLength(30)
    for (const ch of ['0', 'o', '1', 'i', 'l', 'u']) {
      expect(SHORT_ID_ALPHABET).not.toContain(ch)
    }
  })

  it('输入不区分大小写并归一为小写，拒绝含混淆字符或长度不符的写法', () => {
    const upper = 'm-8f3k2p'.toUpperCase()
    expect(ShortId.parse(`  ${upper}  `)).toBe('m-8f3k2p')
    expect(ShortId.safeParse('m-23456789').success).toBe(true)
    expect(isShortId('m-23456')).toBe(false)
    for (const bad of ['m-012345', 'm-oabcde', 'm-123456', 'm-iabcde', 'm-labcde', 'm-uabcde']) {
      expect(ShortId.safeParse(bad).success, bad).toBe(false)
    }
  })
})

describe('双链线性提取', () => {
  it('提取 [[m-xxxxxx]] 与带显示文字的 [[m-xxxxxx|别名]] 并去重目标短 ID', () => {
    const upper = 'm-234567'.toUpperCase()
    const md = `参考 [[${upper}]]、[[m-8f3k2p|家里 NAS]]，再次提到 [[m-234567|重复]]，忽略 [[无效]]。`
    const parsed = extractWikiLinks(md)
    expect(parsed.map((p) => ({ target: p.targetShortId, alias: p.alias }))).toEqual([
      { target: 'm-234567', alias: null },
      { target: 'm-8f3k2p', alias: '家里 NAS' },
      { target: 'm-234567', alias: '重复' },
    ])
    expect(extractTargetShortIds(md)).toEqual(['m-234567', 'm-8f3k2p'])
  })
})
