import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { generateCode, hashCode, maskAccount, normalizeCode } from '../binding'

describe('绑定码', () => {
  it('8 位，字符集里没有容易看混的 0、O、1、I、L', () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^[2-9A-HJKMNP-Z]{8}$/)
  })

  it('发来的码不分大小写，空格与连字符不算；格式不对的认不出', () => {
    expect(normalizeCode(' abcd-2345 ')).toBe('ABCD2345')
    expect(normalizeCode('AB CD 23 45')).toBe('ABCD2345')
    for (const bad of ['ABCD234', 'ABCD23456', 'ABCD234O', 'ABCD2341', 'ABCD234I', 'ABCD234L']) {
      expect(normalizeCode(bad)).toBeNull()
    }
  })

  it('配了主密钥时用从它派生的密钥算 HMAC，没配时退回不带密钥的 SHA-256；都带上应用', () => {
    const master = randomBytes(32)
    const input = 'kioku-bind-code\u0000app\u0000ABCD2345'
    const derived = Buffer.from(
      hkdfSync('sha256', master, Buffer.alloc(0), 'kioku-bind-code-hmac', 32),
    )
    expect(hashCode(master, 'app', 'ABCD2345')).toBe(
      createHmac('sha256', derived).update(input).digest('hex'),
    )
    // 轮换期间按当前的主密钥算
    expect(hashCode({ current: master, previous: randomBytes(32) }, 'app', 'ABCD2345')).toBe(
      hashCode(master, 'app', 'ABCD2345'),
    )
    expect(hashCode(randomBytes(32), 'app', 'ABCD2345')).not.toBe(
      hashCode(master, 'app', 'ABCD2345'),
    )
    expect(hashCode(null, 'app', 'ABCD2345')).toBe(createHash('sha256').update(input).digest('hex'))
    expect(hashCode(master, 'other', 'ABCD2345')).not.toBe(hashCode(master, 'app', 'ABCD2345'))
  })

  it('平台账号只露出头尾几位，露出的不超过三分之一', () => {
    expect(maskAccount('12345678901')).toBe('12***1')
    expect(maskAccount('10086001')).toBe('1***1')
    expect(maskAccount('123456')).toBe('1***6')
    expect(maskAccount('12345')).toBe('1***')
    expect(maskAccount('1001')).toBe('1***')
    expect(maskAccount('u1')).toBe('***')
    expect(maskAccount('')).toBe('***')
    expect(maskAccount('😀😀😀😀😀😀')).toBe('😀***😀')
    for (const id of ['1', '12', '123', '1234', '12345', '123456', '1234567', '123456789012']) {
      const shown = maskAccount(id).replace('***', '').length
      expect(shown * 3).toBeLessThanOrEqual(id.length)
    }
  })
})
