import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { pipeline, Readable } from 'node:stream'
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

// 正文边生成边压缩、加密，逐块交出：文件头、密文，最后是认证标签。调用方直接写进文件或上传，不用把整份放在内存里
export async function* sealBackup(
  masterKey: MasterKey,
  plain: AsyncIterable<string>,
): AsyncGenerator<Buffer> {
  const { key, id } = encryptionKey(masterKey)
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key, salt), iv)
  cipher.setAAD(MAGIC)
  yield Buffer.concat([MAGIC, Buffer.from(id, 'ascii'), salt, iv])
  // 管道里哪一段出错，整条管道连同正文的来源一起销毁，这里读密文的循环随之抛出那个错误
  yield* pipeline(Readable.from(plain), createGzip(), cipher, () => {}) as AsyncIterable<Buffer>
  yield cipher.getAuthTag()
}

// 备份文件头里记的主密钥标识，不用解密就能看
export function backupKeyId(file: Buffer): string {
  if (file.length < HEADER_LENGTH + TAG_LENGTH || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('不是 Kioku 的备份文件')
  }
  return file.subarray(MAGIC.length, MAGIC.length + KEY_ID_LENGTH).toString('ascii')
}

// 整份解开、核对过认证标签之后才交出正文：恢复要先确认文件没被改过、没有缺，再往库里写
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
