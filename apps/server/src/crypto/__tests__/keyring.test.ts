import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../config'
import { decryptionKey, encryptionKey, keyIdOf } from '../keyring'

describe('主密钥', () => {
  const current = randomBytes(32)
  const previous = randomBytes(32)
  const ring = { current, previous }

  it('标识是固定长度的哈希，同一把密钥总是一样，不同的密钥不一样', () => {
    expect(keyIdOf(current)).toMatch(/^[0-9a-f]{16}$/)
    expect(keyIdOf(Buffer.from(current))).toBe(keyIdOf(current))
    expect(keyIdOf(previous)).not.toBe(keyIdOf(current))
  })

  it('加密只用当前的；解密按记下的标识选，没记标识的按当前的，认不出的报错', () => {
    expect(encryptionKey(ring)).toEqual({ key: current, id: keyIdOf(current) })
    expect(encryptionKey(current)).toEqual({ key: current, id: keyIdOf(current) })
    expect(decryptionKey(ring, keyIdOf(previous))).toBe(previous)
    expect(decryptionKey(ring, keyIdOf(current))).toBe(current)
    expect(decryptionKey(ring, null)).toBe(current)
    expect(() => decryptionKey(current, keyIdOf(previous))).toThrow('另一把主密钥')
  })

  it('配置：新旧两把同时配，旧的不能单独配，两把不能一样', () => {
    const base = { DATABASE_URL: 'postgres://127.0.0.1/kioku' }
    const encode = (k: Buffer) => k.toString('base64')
    expect(
      loadConfig({
        ...base,
        KIOKU_MASTER_KEY: encode(current),
        KIOKU_MASTER_KEY_PREVIOUS: encode(previous),
      }).masterKey,
    ).toEqual(ring)
    expect(loadConfig({ ...base, KIOKU_MASTER_KEY: encode(current) }).masterKey).toEqual(current)
    expect(loadConfig(base).masterKey).toBeNull()
    expect(() => loadConfig({ ...base, KIOKU_MASTER_KEY_PREVIOUS: encode(previous) })).toThrow(
      '却没有配置 KIOKU_MASTER_KEY',
    )
    expect(() =>
      loadConfig({
        ...base,
        KIOKU_MASTER_KEY: encode(current),
        KIOKU_MASTER_KEY_PREVIOUS: encode(current),
      }),
    ).toThrow('同一把密钥')
  })
})
