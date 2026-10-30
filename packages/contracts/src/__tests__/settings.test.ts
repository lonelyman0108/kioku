import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import { UpdateBackupSettings, UpdateEmbeddingSettings, UpdateExtractionSettings } from '../index'

// 解析一份设置：通过时取出密钥字段，不通过时取第一条问题
const outcome = <T>(result: z.ZodSafeParseResult<T>, field: (data: T) => unknown) =>
  result.success
    ? { success: true, value: field(result.data) }
    : { success: false, message: result.error.issues[0]?.message }

const extraction = (apiKey: unknown) =>
  outcome(
    UpdateExtractionSettings.safeParse({ baseUrl: 'https://example.com/v1', model: 'm', apiKey }),
    (data) => data.apiKey,
  )
const embedding = (apiKey: unknown) =>
  outcome(
    UpdateEmbeddingSettings.safeParse({
      model: 'm',
      channels: [{ baseUrl: 'https://example.com/v1', model: 'm', apiKey }],
    }),
    (data) => data.channels[0]?.apiKey,
  )
const backup = (secretAccessKey: unknown) =>
  outcome(
    UpdateBackupSettings.safeParse({
      endpoint: 'https://example.com',
      bucket: 'kioku-test',
      accessKeyId: 'id',
      secretAccessKey,
      hour: 3,
      keep: 2,
    }),
    (data) => data.secretAccessKey,
  )

describe.each([
  ['抽取模型的 Key', 'Key', extraction],
  ['嵌入渠道的 Key', 'Key', embedding],
  ['备份存储的 Secret', 'Secret Access Key', backup],
])('%s', (_, name, parse) => {
  it.each(['sk-abc\n', 'sk-abc\r\n', ' sk-abc', '\tsk-abc \n', 'sk-abc\u00a0'])(
    '首尾的空白去掉：%j',
    (value) => {
      expect(parse(value)).toEqual({ success: true, value: 'sk-abc' })
    },
  )

  it.each([
    ['换行', 'sk\nabc'],
    ['回车', 'sk\rabc'],
    ['制表符', 'sk\tabc'],
    ['NUL', 'sk\u0000abc'],
    ['DEL', 'sk\u007fabc'],
    ['0x85 这种不常见的控制字符', 'sk\u0085abc'],
  ])('中间有控制字符（%s）：拒绝，用中文说明，不带填的内容', (_, value) => {
    const result = parse(value)
    expect(result.success).toBe(false)
    expect(result.message).toBe(`${name} 里不能有换行等控制字符，检查粘贴的内容`)
  })

  it.each(['', ' ', ' \n\t'])('只有空白：拒绝，不当成沿用已保存的：%j', (value) => {
    expect(parse(value)).toEqual({ success: false, message: `${name} 不能只有空白` })
  })

  it('别的字符不动：中间的空格、标点', () => {
    expect(parse('sk-a b/c+d="e"')).toEqual({ success: true, value: 'sk-a b/c+d="e"' })
  })

  it('不填表示沿用', () => {
    expect(parse(undefined)).toEqual({ success: true, value: undefined })
  })
})

describe('Key 与 Secret 的差别', () => {
  it('Key 填 null 表示不用 Key；Secret 不能清除', () => {
    expect(extraction(null)).toEqual({ success: true, value: null })
    expect(embedding(null)).toEqual({ success: true, value: null })
    expect(backup(null).success).toBe(false)
  })

  it('Secret 的长度上限按去掉空白之后算', () => {
    expect(backup(`${'x'.repeat(256)}\n`)).toEqual({ success: true, value: 'x'.repeat(256) })
    expect(backup('x'.repeat(257)).success).toBe(false)
  })
})
