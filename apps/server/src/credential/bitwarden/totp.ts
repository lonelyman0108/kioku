import { createHmac } from 'node:crypto'

import { VaultError } from './types'

// 由条目里的 TOTP 密钥现算验证码。密钥是 otpauth://totp/... 地址或纯 base32；
// steam://、otpauth://hotp 等别的写法报 unsupported_format。错误信息不带密钥

const ALGORITHMS: Record<string, string> = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' }

interface TotpParams {
  key: Buffer
  digits: number
  period: number
  algorithm: string
}

const unsupported = () => new VaultError('unsupported_format', 'TOTP 密钥的格式不受支持')

function base32(text: string): Buffer {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) throw unsupported()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw)) throw unsupported()
  const n = Number(raw)
  if (n < min || n > max) throw unsupported()
  return n
}

function parseSecret(secret: string): TotpParams {
  const text = secret.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw unsupported()
    }
    if (url.protocol !== 'otpauth:' || url.host.toLowerCase() !== 'totp') throw unsupported()
    const key = url.searchParams.get('secret')
    if (!key) throw unsupported()
    const algorithm = ALGORITHMS[(url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase()]
    if (!algorithm) throw unsupported()
    return {
      key: base32(key),
      digits: intParam(url.searchParams.get('digits'), 6, 1, 10),
      period: intParam(url.searchParams.get('period'), 30, 1, 3600),
      algorithm,
    }
  }
  return { key: base32(text), digits: 6, period: 30, algorithm: 'sha1' }
}

export function totpCode(secret: string, now: Date | number): string {
  const { key, digits, period, algorithm } = parseSecret(secret)
  const ms = typeof now === 'number' ? now : now.getTime()
  const counter = Math.floor(ms / 1000 / period)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac(algorithm, key).update(message).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** digits).padStart(digits, '0')
}
