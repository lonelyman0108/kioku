import { describe, expect, it } from 'vitest'

import { generateApiKey, parseApiKey, verifyApiKey } from '../keys'
import { hashPassword, verifyPassword } from '../password'

describe('API Key', () => {
  it('生成的 Key 能被解析和校验', () => {
    const key = generateApiKey()
    expect(parseApiKey(key.plaintext)?.prefix).toBe(key.prefix)
    expect(verifyApiKey(key.plaintext, key.secretHash)).toBe(true)
  })

  it('改动任何一位都校验失败', () => {
    const key = generateApiKey()
    const tampered = key.plaintext.slice(0, -1) + (key.plaintext.endsWith('a') ? 'b' : 'a')
    expect(verifyApiKey(tampered, key.secretHash)).toBe(false)
  })

  it('格式不对的字符串解析为 null', () => {
    expect(parseApiKey('Bearer xxx')).toBeNull()
    expect(parseApiKey('kioku_short_x')).toBeNull()
  })

  it('每次生成都不同', () => {
    expect(generateApiKey().plaintext).not.toBe(generateApiKey().plaintext)
  })
})

describe('密码', () => {
  it('正确密码通过，错误密码不通过', async () => {
    const stored = await hashPassword('correct horse')
    expect(await verifyPassword('correct horse', stored)).toBe(true)
    expect(await verifyPassword('wrong', stored)).toBe(false)
  })

  it('格式损坏的哈希返回 false 而不是抛错', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
  })
})
