import { generateKeyPairSync, randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  decryptBytes,
  decryptRsa,
  decryptText,
  encryptRsa,
  encryptText,
  kdfParams,
  splitKey,
  stretchMasterKey,
} from '../crypto'
import { totpCode } from '../totp'
import { VaultError } from '../types'

const key = splitKey(randomBytes(64))

function kindOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof VaultError) return err.kind
    throw err
  }
  return 'ok'
}

// 改 base64 里的一个字符，长度不变
function flip(b64: string, at = 2): string {
  const ch = b64[at] === 'A' ? 'B' : 'A'
  return b64.slice(0, at) + ch + b64.slice(at + 1)
}

describe('EncString 类型 2', () => {
  it('加密之后解得回来，中文与空串也一样', () => {
    for (const text of ['hello', '中文：密码', '']) {
      expect(decryptText(encryptText(text, key), key)).toBe(text)
    }
  })

  it('MAC、密文、IV 任何一处被改都报 integrity', () => {
    const enc = encryptText('secret value', key)
    const [head, data, mac] = enc.split('|') as [string, string, string]
    expect(kindOf(() => decryptText(`${head}|${data}|${flip(mac)}`, key))).toBe('integrity')
    expect(kindOf(() => decryptText(`${head}|${flip(data)}|${mac}`, key))).toBe('integrity')
    expect(kindOf(() => decryptText(`${flip(head, 4)}|${data}|${mac}`, key))).toBe('integrity')
  })

  it('换一把密钥报 integrity，不会解出别的内容', () => {
    const enc = encryptText('secret value', key)
    expect(kindOf(() => decryptText(enc, splitKey(randomBytes(64))))).toBe('integrity')
  })

  it('类型 0、1、没有类型前缀与不认识的类型都报 unsupported_format', () => {
    const enc = encryptText('x', key)
    const body = enc.slice(2)
    const [iv, data] = body.split('|') as [string, string]
    expect(kindOf(() => decryptBytes(`0.${iv}|${data}`, key))).toBe('unsupported_format')
    expect(kindOf(() => decryptBytes(`1.${body}`, key))).toBe('unsupported_format')
    expect(kindOf(() => decryptBytes(body, key))).toBe('unsupported_format')
    expect(kindOf(() => decryptBytes(`7.${body}`, key))).toBe('unsupported_format')
    expect(kindOf(() => decryptBytes(`x.${body}`, key))).toBe('unsupported_format')
    expect(kindOf(() => decryptBytes('2.', key))).toBe('unsupported_format')
    expect(kindOf(() => decryptBytes(`2.${iv}|${data}`, key))).toBe('unsupported_format')
    expect(kindOf(() => decryptBytes(`2.${body}|extra`, key))).toBe('unsupported_format')
    // base64 里混进别的字符：Buffer.from 会跳过它们，这里要拒绝
    expect(kindOf(() => decryptBytes(`2.${iv}|${data}!|${body.split('|')[2]}`, key))).toBe(
      'unsupported_format',
    )
  })

  it('错误信息不带密文', () => {
    const enc = encryptText('x', key)
    try {
      decryptBytes(`9.${enc.slice(2)}`, key)
    } catch (err) {
      expect((err as Error).message).not.toContain(enc.slice(2, 12))
    }
  })
})

describe('RSA-OAEP', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const orgKey = randomBytes(64)

  it('SHA-1（类型 4）与 SHA-256（类型 3）都解得开', () => {
    const sha1 = encryptRsa(orgKey, publicKey, 'sha1')
    const sha256 = encryptRsa(orgKey, publicKey, 'sha256')
    expect(sha1.startsWith('4.')).toBe(true)
    expect(sha256.startsWith('3.')).toBe(true)
    expect(decryptRsa(sha1, privateKey).equals(orgKey)).toBe(true)
    expect(decryptRsa(sha256, privateKey).equals(orgKey)).toBe(true)
  })

  it('类型与哈希对不上时解不开', () => {
    const sha1 = encryptRsa(orgKey, publicKey, 'sha1')
    expect(kindOf(() => decryptRsa(`3.${sha1.slice(2)}`, privateKey))).toBe('integrity')
  })

  it('带 MAC 的 5、6 与对称的类型 2 报 unsupported_format', () => {
    const sha1 = encryptRsa(orgKey, publicKey, 'sha1').slice(2)
    expect(kindOf(() => decryptRsa(`6.${sha1}|AAAA`, privateKey))).toBe('unsupported_format')
    expect(kindOf(() => decryptRsa(`5.${sha1}|AAAA`, privateKey))).toBe('unsupported_format')
    // 类型 6 的 RSA 部分就是 SHA-1 的 OAEP，去掉 MAC 也不能当作类型 4 解
    expect(kindOf(() => decryptRsa(`6.${sha1}`, privateKey))).toBe('unsupported_format')
    expect(kindOf(() => decryptRsa(encryptText('x', key), privateKey))).toBe('unsupported_format')
  })
})

describe('KDF 参数', () => {
  it('PBKDF2 与 Argon2id 在官方客户端的范围内', () => {
    expect(kdfParams({ kdf: 0, iterations: 600_000, memory: null, parallelism: null })).toEqual({
      kind: 'pbkdf2',
      iterations: 600_000,
    })
    expect(kdfParams({ kdf: 1, iterations: 3, memory: 64, parallelism: 4 })).toEqual({
      kind: 'argon2id',
      iterations: 3,
      memoryMiB: 64,
      parallelism: 4,
    })
  })

  it('超出范围或不认识的 KDF 报 unsupported_format', () => {
    const bad = [
      { kdf: 0, iterations: 100, memory: null, parallelism: null },
      { kdf: 0, iterations: 1e9, memory: null, parallelism: null },
      { kdf: 1, iterations: 3, memory: 1e6, parallelism: 4 },
      { kdf: 1, iterations: 3, memory: 64, parallelism: 0 },
      { kdf: 2, iterations: 3, memory: 64, parallelism: 4 },
      { kdf: '0', iterations: 600_000, memory: null, parallelism: null },
    ]
    for (const raw of bad) expect(kindOf(() => kdfParams(raw))).toBe('unsupported_format')
  })

  it('拉伸主密钥的两半不同，也都不等于主密钥', () => {
    const master = randomBytes(32)
    const stretched = stretchMasterKey(master)
    expect(stretched.encKey.equals(stretched.macKey)).toBe(false)
    expect(stretched.encKey.equals(master)).toBe(false)
  })
})

describe('TOTP', () => {
  // RFC 6238 附录 B 的测试向量，8 位
  const ascii = (s: string) => Buffer.from(s, 'ascii')
  const b32 = (buf: Buffer) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = 0
    let value = 0
    let out = ''
    for (const byte of buf) {
      value = (value << 8) | byte
      bits += 8
      while (bits >= 5) {
        out += alphabet[(value >>> (bits - 5)) & 31]
        bits -= 5
      }
    }
    return bits > 0 ? out + alphabet[(value << (5 - bits)) & 31] : out
  }
  const sha1 = b32(ascii('12345678901234567890'))
  const sha256 = b32(ascii('12345678901234567890123456789012'))
  const sha512 = b32(ascii('1234567890123456789012345678901234567890123456789012345678901234'))
  const url = (secret: string, algorithm: string) =>
    `otpauth://totp/Example:alice?secret=${secret}&digits=8&algorithm=${algorithm}&issuer=Example`

  it('RFC 6238 的向量（SHA1、SHA256、SHA512）', () => {
    const cases: [number, string, string, string][] = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [2000000000, '69279037', '90698825', '38618901'],
    ]
    for (const [t, a, b, c] of cases) {
      expect(totpCode(url(sha1, 'SHA1'), t * 1000)).toBe(a)
      expect(totpCode(url(sha256, 'SHA256'), t * 1000)).toBe(b)
      expect(totpCode(url(sha512, 'SHA512'), new Date(t * 1000))).toBe(c)
    }
  })

  it('纯 base32 按 6 位、30 秒、SHA1；空格与小写也认', () => {
    expect(totpCode(sha1, 59_000)).toBe('287082')
    expect(totpCode(sha1.toLowerCase().replace(/(.{4})/g, '$1 '), 59_000)).toBe('287082')
  })

  it('period 参数', () => {
    const at = 120_000
    expect(totpCode(`otpauth://totp/x?secret=${sha1}&period=60`, at)).toBe(
      totpCode(sha1, (at / 60) * 30),
    )
  })

  it('steam://、hotp、坏的 base32 与参数报 unsupported_format', () => {
    for (const secret of [
      `steam://${sha1}`,
      `otpauth://hotp/x?secret=${sha1}&counter=1`,
      'otpauth://totp/x',
      `otpauth://totp/x?secret=${sha1}&algorithm=MD5`,
      `otpauth://totp/x?secret=${sha1}&digits=abc`,
      `otpauth://totp/x?secret=${sha1}&period=0`,
      'not base32 !',
      '',
    ]) {
      expect(kindOf(() => totpCode(secret, 0))).toBe('unsupported_format')
    }
  })

  it('错误信息不带密钥', () => {
    try {
      totpCode(`steam://${sha1}`, 0)
    } catch (err) {
      expect((err as Error).message).not.toContain(sha1)
    }
  })
})
