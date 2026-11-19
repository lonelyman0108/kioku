import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto'
import { pipeline, Readable } from 'node:stream'
import { promisify } from 'node:util'
import { createGzip, gunzip } from 'node:zlib'

import { MemoryError } from '../memory/errors'
import { isBackupFile } from './format'

// 按记忆圈导出的文件：开头是不加密的文件头（格式标记、scrypt 参数、盐、iv、口令校验值），
// 后面是压缩后用口令派生密钥加密的正文（AES-256-GCM，aad 是整个文件头，末尾 16 字节是认证标签）
const MAGIC = Buffer.from('KIOKUCX2')
const LEGACY_SPACE_MAGIC = Buffer.from('KIOKUSX1')
const SALT_LENGTH = 16
const IV_LENGTH = 12
const CHECK_LENGTH = 16
const TAG_LENGTH = 16
const HEADER_LENGTH = MAGIC.length + 3 + SALT_LENGTH + IV_LENGTH + CHECK_LENGTH

export interface KdfParams {
  logN: number
  r: number
  p: number
}

export const DEFAULT_KDF: KdfParams = { logN: 17, r: 8, p: 1 }

const MIN_LOG_N = 14
const MAX_LOG_N = 18
const MAX_R = 16
const MAX_P = 4
const MAX_KDF_MEMORY = 256 * 1024 * 1024
const kdfMemory = (kdf: KdfParams) => 128 * 2 ** kdf.logN * kdf.r

function acceptable(kdf: KdfParams): boolean {
  return (
    kdf.logN >= MIN_LOG_N &&
    kdf.logN <= MAX_LOG_N &&
    kdf.r >= 1 &&
    kdf.r <= MAX_R &&
    kdf.p >= 1 &&
    kdf.p <= MAX_P &&
    kdfMemory(kdf) <= MAX_KDF_MEMORY
  )
}

const scryptAsync = promisify(
  (
    password: string,
    salt: Buffer,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem: number },
    cb: (err: Error | null, key: Buffer) => void,
  ) => scrypt(password, salt, keylen, options, cb),
)

export interface ExportKey {
  encryptionKey: Buffer
  checkValue: Buffer
}

export async function deriveExportKey(
  passphrase: string,
  salt: Buffer,
  kdf: KdfParams,
): Promise<ExportKey> {
  if (!acceptable(kdf)) {
    throw new MemoryError(400, '导出文件的密钥派生参数超出安全范围')
  }
  const N = 2 ** kdf.logN
  const raw = await scryptAsync(passphrase, salt, 64, {
    N,
    r: kdf.r,
    p: kdf.p,
    maxmem: MAX_KDF_MEMORY * 2,
  })
  const encKey = raw.subarray(0, 32)
  const checkKey = raw.subarray(32, 64)
  const checkValue = createHmac('sha256', checkKey)
    .update('kioku-circle-export-check')
    .digest()
    .subarray(0, CHECK_LENGTH)
  return { encryptionKey: encKey, checkValue }
}

export class ExportTooLarge extends Error {}

const gunzipAsync = promisify(gunzip)

export async function sealCircleExport(
  plain: Buffer | AsyncIterable<string>,
  passphrase: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<Buffer> {
  if (!acceptable(kdf)) {
    throw new MemoryError(400, '密钥派生参数不合法')
  }
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const { encryptionKey, checkValue } = await deriveExportKey(passphrase, salt, kdf)
  const header = Buffer.concat([MAGIC, Buffer.from([kdf.logN, kdf.r, kdf.p]), salt, iv, checkValue])
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  cipher.setAAD(header)
  const chunks: Buffer[] = [header]
  const src = Buffer.isBuffer(plain) ? Readable.from([plain]) : Readable.from(plain)
  const gz = createGzip()
  const stream = pipeline(src, gz, cipher, () => {})
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk)
  }
  chunks.push(cipher.getAuthTag())
  return Buffer.concat(chunks)
}

export async function openCircleExport(
  file: Buffer,
  passphrase: string,
  maxOutputLength?: number,
): Promise<Buffer> {
  if (isBackupFile(file)) {
    throw new MemoryError(400, '这是全实例备份文件，不能按记忆圈导入；请到备份页恢复')
  }
  if (file.subarray(0, LEGACY_SPACE_MAGIC.length).equals(LEGACY_SPACE_MAGIC)) {
    throw new MemoryError(400, '这是旧版空间导出文件，无法直接按记忆圈导入')
  }
  if (file.length < HEADER_LENGTH + TAG_LENGTH || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new MemoryError(400, '不是 Kioku 记忆圈导出文件')
  }
  const header = file.subarray(0, HEADER_LENGTH)
  let at = MAGIC.length
  const logN = file[at++]!
  const r = file[at++]!
  const p = file[at++]!
  const kdf: KdfParams = { logN, r, p }
  if (!acceptable(kdf)) {
    throw new MemoryError(400, '导出文件的密钥派生参数不合法')
  }
  const salt = file.subarray(at, (at += SALT_LENGTH))
  const iv = file.subarray(at, (at += IV_LENGTH))
  const expectedCheck = file.subarray(at, at + CHECK_LENGTH)

  const { encryptionKey, checkValue } = await deriveExportKey(passphrase, salt, kdf)
  if (!timingSafeEqual(checkValue, expectedCheck)) {
    throw new MemoryError(400, '导出文件口令不正确')
  }

  const body = file.subarray(HEADER_LENGTH, file.length - TAG_LENGTH)
  const tag = file.subarray(file.length - TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv)
  decipher.setAAD(header)
  decipher.setAuthTag(tag)
  let compressed: Buffer
  try {
    compressed = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new MemoryError(400, '导出文件已损坏或被篡改')
  }

  try {
    return await gunzipAsync(compressed, maxOutputLength ? { maxOutputLength } : {})
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ExportTooLarge('导出文件解压后超出大小上限')
    }
    throw new MemoryError(400, '导出文件内容已损坏，无法解压')
  }
}
