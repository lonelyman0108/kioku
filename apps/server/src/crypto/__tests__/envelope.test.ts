import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { decryptSecret, encryptSecret, parseMasterKey, rewrapKey } from '../envelope'

describe('secret 信封加密', () => {
  const master = randomBytes(32)

  it('加密后能解密回原文，密文里看不到明文', () => {
    const sealed = encryptSecret(master, '路由器密码 hunter2', 'mem-1')
    expect(sealed.ciphertext.toString('utf8')).not.toContain('hunter2')
    expect(decryptSecret(master, sealed, 'mem-1')).toBe('路由器密码 hunter2')
  })

  it('密文挪到别的记录上会解密失败', () => {
    const sealed = encryptSecret(master, 'x', 'mem-1')
    expect(() => decryptSecret(master, sealed, 'mem-2')).toThrow()
  })

  it('主密钥不对会解密失败', () => {
    const sealed = encryptSecret(master, 'x', 'mem-1')
    expect(() => decryptSecret(randomBytes(32), sealed, 'mem-1')).toThrow()
  })

  it('换主密钥只重新包装数据密钥', () => {
    const next = randomBytes(32)
    const sealed = encryptSecret(master, 'x', 'mem-1')
    const rewrapped = { ...sealed, wrappedKey: rewrapKey(master, next, sealed.wrappedKey, 'mem-1') }
    expect(decryptSecret(next, rewrapped, 'mem-1')).toBe('x')
  })

  it('主密钥长度不对时拒绝', () => {
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow()
    expect(parseMasterKey(randomBytes(32).toString('base64'))).toHaveLength(32)
  })
})
