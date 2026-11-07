import { createHmac } from 'node:crypto'

// 密码库条目里的 TOTP 密钥现算验证码（RFC 6238）。密钥是 otpauth://totp/… 地址或 base32 的密钥本身；
// 地址里可以带 digits、period 与 algorithm。别的写法（例如 steam://）认不出，抛 TotpFormatError，不猜

export class TotpFormatError extends Error {
  constructor() {
    super('TOTP 密钥的格式无法识别')
    this.name = 'TotpFormatError'
  }
}

interface TotpParams {
  key: Buffer
  digits: number
  period: number
  algorithm: 'sha1' | 'sha256' | 'sha512'
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32(text: string): Buffer {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new TotpFormatError()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function parse(secret: string): TotpParams {
  const text = secret.trim()
  if (!/^otpauth:/i.test(text)) {
    return { key: base32(text), digits: 6, period: 30, algorithm: 'sha1' }
  }
  const match = /^otpauth:\/\/totp\/[^?]*\?(.*)$/i.exec(text)
  if (!match) throw new TotpFormatError()
  const query = new URLSearchParams(match[1])
  const digits = Number(query.get('digits') ?? 6)
  const period = Number(query.get('period') ?? 30)
  const algorithm = (query.get('algorithm') ?? 'SHA1').toLowerCase()
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new TotpFormatError()
  if (!Number.isInteger(period) || period < 1 || period > 300) throw new TotpFormatError()
  if (algorithm !== 'sha1' && algorithm !== 'sha256' && algorithm !== 'sha512') {
    throw new TotpFormatError()
  }
  return { key: base32(query.get('secret') ?? ''), digits, period, algorithm }
}

export function totpCode(secret: string, now: number = Date.now()): string {
  const { key, digits, period, algorithm } = parse(secret)
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)))
  const mac = createHmac(algorithm, key).update(counter).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const binary = mac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** digits).padStart(digits, '0')
}
