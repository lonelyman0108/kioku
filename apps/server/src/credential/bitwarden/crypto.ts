import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  constants,
  pbkdf2,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

import { argon2id } from 'hash-wasm'

import { VaultError } from './types'

// Bitwarden 的密钥与密文格式。只认 EncString 类型 2（AES-256-CBC 加 HMAC-SHA256）与 RSA-OAEP 的类型 3、4，
// 别的格式报 unsupported_format，不猜。错误信息只写类别，不带密文与密钥

const pbkdf2Async = promisify(pbkdf2)

// 64 字节的对称密钥：前 32 字节加密，后 32 字节 MAC
export interface SymmetricKey {
  encKey: Buffer
  macKey: Buffer
}

export function splitKey(key: Buffer): SymmetricKey {
  if (key.length !== 64) throw new VaultError('unsupported_format', '密钥长度不受支持')
  return { encKey: key.subarray(0, 32), macKey: key.subarray(32, 64) }
}

export function joinKey(key: SymmetricKey): Buffer {
  return Buffer.concat([key.encKey, key.macKey])
}

// 严格的 base64：Buffer.from 会跳过不认识的字符，坏的密文要报错而不是解出别的东西
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function base64(text: string): Buffer {
  if (!BASE64.test(text)) throw new VaultError('unsupported_format', '密文不是合法的 base64')
  return Buffer.from(text, 'base64')
}

// EncString 写成「类型.内容」；没有类型前缀的是很旧的类型 0，也不认
function encType(enc: string): { type: number; body: string } {
  const dot = enc.indexOf('.')
  const type = dot > 0 ? enc.slice(0, dot) : ''
  if (!/^\d{1,2}$/.test(type)) throw new VaultError('unsupported_format', '不支持的加密格式')
  return { type: Number(type), body: enc.slice(dot + 1) }
}

interface AesParts {
  iv: Buffer
  data: Buffer
  mac: Buffer
}

function parseAes(enc: string): AesParts {
  const { type, body } = encType(enc)
  if (type !== 2) throw new VaultError('unsupported_format', `不支持的加密格式（类型 ${type}）`)
  const parts = body.split('|')
  if (parts.length !== 3) throw new VaultError('unsupported_format', '密文的格式无法识别')
  const [iv, data, mac] = parts.map(base64) as [Buffer, Buffer, Buffer]
  if (iv.length !== 16 || mac.length !== 32 || data.length === 0 || data.length % 16 !== 0) {
    throw new VaultError('unsupported_format', '密文的格式无法识别')
  }
  return { iv, data, mac }
}

function macOf(key: SymmetricKey, iv: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key.macKey).update(iv).update(data).digest()
}

// 先校验 MAC 再解密：MAC 对不上的密文不交给 CBC
export function decryptBytes(enc: string, key: SymmetricKey): Buffer {
  const { iv, data, mac } = parseAes(enc)
  if (!timingSafeEqual(macOf(key, iv, data), mac)) {
    throw new VaultError('integrity', '密文校验失败')
  }
  try {
    const decipher = createDecipheriv('aes-256-cbc', key.encKey, iv)
    return Buffer.concat([decipher.update(data), decipher.final()])
  } catch {
    throw new VaultError('integrity', '密文校验失败')
  }
}

export function decryptText(enc: string, key: SymmetricKey): string {
  return decryptBytes(enc, key).toString('utf8')
}

export function encryptBytes(plain: Buffer, key: SymmetricKey): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key.encKey, iv)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  const mac = macOf(key, iv, data)
  return `2.${iv.toString('base64')}|${data.toString('base64')}|${mac.toString('base64')}`
}

export function encryptText(plain: string, key: SymmetricKey): string {
  return encryptBytes(Buffer.from(plain, 'utf8'), key)
}

// RSA-OAEP：类型 3 是 SHA-256，类型 4 是 SHA-1。带 MAC 的 5、6 已被官方废弃，不认
const RSA_HASH: Record<number, string> = { 3: 'sha256', 4: 'sha1' }

export function decryptRsa(enc: string, privateKeyDer: Buffer): Buffer {
  const { type, body } = encType(enc)
  const oaepHash = RSA_HASH[type]
  if (!oaepHash) {
    throw new VaultError('unsupported_format', `不支持的加密格式（类型 ${type}）`)
  }
  const data = base64(body)
  try {
    const key = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' })
    return privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash }, data)
  } catch {
    throw new VaultError('integrity', '无法解开组织密钥')
  }
}

export function encryptRsa(
  plain: Buffer,
  publicKeyDer: Buffer,
  oaepHash: 'sha1' | 'sha256',
): string {
  const key = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' })
  const data = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash }, plain)
  return `${oaepHash === 'sha1' ? 4 : 3}.${data.toString('base64')}`
}

// 预登录给的 KDF 参数。范围照官方客户端的上下限：服务器地址由成员填写，参数过大会拖住整个进程
export type KdfParams =
  | { kind: 'pbkdf2'; iterations: number }
  | { kind: 'argon2id'; iterations: number; memoryMiB: number; parallelism: number }

const inRange = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max

export function kdfParams(raw: {
  kdf: unknown
  iterations: unknown
  memory: unknown
  parallelism: unknown
}): KdfParams {
  if (raw.kdf === 0 && inRange(raw.iterations, 5000, 2_000_000)) {
    return { kind: 'pbkdf2', iterations: raw.iterations }
  }
  if (
    raw.kdf === 1 &&
    inRange(raw.iterations, 2, 10) &&
    inRange(raw.memory, 15, 1024) &&
    inRange(raw.parallelism, 1, 16)
  ) {
    return {
      kind: 'argon2id',
      iterations: raw.iterations,
      memoryMiB: raw.memory,
      parallelism: raw.parallelism,
    }
  }
  throw new VaultError('unsupported_format', '不支持的密钥派生参数')
}

// 主密钥：盐是规范化的邮箱（去掉首尾空白、小写）；Argon2id 的盐是它的 SHA-256
export async function deriveMasterKey(
  password: string,
  salt: string,
  kdf: KdfParams,
): Promise<Buffer> {
  const pass = Buffer.from(password, 'utf8')
  if (kdf.kind === 'pbkdf2') return pbkdf2Async(pass, salt, kdf.iterations, 32, 'sha256')
  const out = await argon2id({
    password: pass,
    salt: createHash('sha256').update(salt, 'utf8').digest(),
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
    memorySize: kdf.memoryMiB * 1024,
    hashLength: 32,
    outputType: 'binary',
  })
  return Buffer.from(out)
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase()

// 发给服务器的主密码哈希：主密钥对主密码再做一轮 PBKDF2
export async function masterPasswordHash(masterKey: Buffer, password: string): Promise<string> {
  const hash = await pbkdf2Async(masterKey, Buffer.from(password, 'utf8'), 1, 32, 'sha256')
  return hash.toString('base64')
}

// 拉伸主密钥：HKDF-Expand（不做 Extract），info 分别是 enc 与 mac。输出 32 字节，只需要第一块
function hkdfExpand(prk: Buffer, info: string): Buffer {
  return createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([1])]))
    .digest()
}

export function stretchMasterKey(masterKey: Buffer): SymmetricKey {
  return { encKey: hkdfExpand(masterKey, 'enc'), macKey: hkdfExpand(masterKey, 'mac') }
}
