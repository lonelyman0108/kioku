import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { createGzip, gunzipSync } from 'node:zlib'

import { decryptionKey, encryptionKey, type MasterKey } from '../crypto/keyring'

// 备份文件：开头是不加密的文件头（格式标记、主密钥的标识、盐、iv），后面是压缩后用主密钥派生的密钥
// 加密的正文（AES-256-GCM，最后 16 字节是认证标签）。主密钥另存，恢复时按文件头里的标识选用当前的或旧的那把；
// 派生的密钥每份备份不同（随机的盐），不直接拿主密钥加密大段数据
const MAGIC = Buffer.from('KIOKUBK1')
const KEY_ID_LENGTH = 16
const SALT_LENGTH = 16
const IV_LENGTH = 12
const TAG_LENGTH = 16
const HEADER_LENGTH = MAGIC.length + KEY_ID_LENGTH + SALT_LENGTH + IV_LENGTH

const deriveKey = (master: Buffer, salt: Buffer) =>
  Buffer.from(hkdfSync('sha256', master, salt, 'kioku-backup', 32))

// 正文边生成边压缩、加密，内存里只留加密后的结果
export async function sealBackup(
  masterKey: MasterKey,
  plain: AsyncIterable<string>,
): Promise<Buffer> {
  const { key, id } = encryptionKey(masterKey)
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key, salt), iv)
  cipher.setAAD(MAGIC)
  const chunks: Buffer[] = [MAGIC, Buffer.from(id, 'ascii'), salt, iv]
  await pipeline(plain, createGzip(), cipher, async (encrypted: AsyncIterable<Buffer>) => {
    for await (const chunk of encrypted) chunks.push(chunk)
  })
  chunks.push(cipher.getAuthTag())
  return Buffer.concat(chunks)
}

// 备份文件头里记的主密钥标识，不用解密就能看
export function backupKeyId(file: Buffer): string {
  if (file.length < HEADER_LENGTH + TAG_LENGTH || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('不是 Kioku 的备份文件')
  }
  return file.subarray(MAGIC.length, MAGIC.length + KEY_ID_LENGTH).toString('ascii')
}

export function openBackup(masterKey: MasterKey, file: Buffer): Buffer {
  const keyId = backupKeyId(file)
  let master: Buffer
  try {
    master = decryptionKey(masterKey, keyId)
  } catch {
    throw new Error(
      `备份是用另一把主密钥（标识 ${keyId}）加密的：用备份时的 KIOKU_MASTER_KEY 恢复（轮换过的话配在 KIOKU_MASTER_KEY_PREVIOUS）`,
    )
  }
  let at = MAGIC.length + KEY_ID_LENGTH
  const salt = file.subarray(at, (at += SALT_LENGTH))
  const iv = file.subarray(at, (at += IV_LENGTH))
  const body = file.subarray(at, file.length - TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(master, salt), iv)
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(file.subarray(file.length - TAG_LENGTH))
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error('备份文件解不开：文件不完整或被改过')
  }
  return gunzipSync(plain)
}
