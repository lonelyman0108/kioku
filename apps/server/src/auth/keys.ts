import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// Key 格式：kioku_<前缀>_<密钥>。前缀用于在库里定位记录、在界面上辨认，密钥部分只在创建时出现一次。
const KEY_PATTERN = /^kioku_([A-Za-z0-9]{12})_([A-Za-z0-9]{40})$/
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomToken(length: number): string {
  // 拒绝采样，避免取模带来的字符分布偏差
  const out: string[] = []
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out.push(ALPHABET[byte % 62]!)
    }
  }
  return out.join('')
}

export interface GeneratedKey {
  plaintext: string
  prefix: string
  secretHash: string
}

export function generateApiKey(): GeneratedKey {
  const prefix = randomToken(12)
  const plaintext = `kioku_${prefix}_${randomToken(40)}`
  return { plaintext, prefix, secretHash: hashApiKey(plaintext) }
}

// 密钥部分有 238 位熵，用 SHA-256 存储足够，不需要慢哈希
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export function parseApiKey(plaintext: string): { prefix: string } | null {
  const match = KEY_PATTERN.exec(plaintext)
  return match ? { prefix: match[1]! } : null
}

export function verifyApiKey(plaintext: string, secretHash: string): boolean {
  const actual = Buffer.from(hashApiKey(plaintext), 'hex')
  const expected = Buffer.from(secretHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
