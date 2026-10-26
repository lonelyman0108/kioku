import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// secret 级记忆的信封加密：每条记录随机一个数据密钥加密内容，数据密钥再由主密钥加密后与密文一起存库。
// 换主密钥只需重新包装数据密钥，不用重加密内容。两段都是 AES-256-GCM，格式为 iv(12) | tag(16) | 密文。
const IV_LENGTH = 12
const TAG_LENGTH = 16

export function parseMasterKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) throw new Error('KIOKU_MASTER_KEY 必须是 32 字节密钥的 base64 编码')
  return key
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

function open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  const iv = sealed.subarray(0, IV_LENGTH)
  const tag = sealed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(sealed.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()])
}

export interface Sealed {
  ciphertext: Buffer
  wrappedKey: Buffer
}

// aad 绑定记录身份（例如记忆 id），把一条记录的密文挪到另一条记录上会解密失败
export function encryptSecret(masterKey: Buffer, plaintext: string, aad: string): Sealed {
  const dataKey = randomBytes(32)
  const binding = Buffer.from(aad)
  return {
    ciphertext: seal(dataKey, Buffer.from(plaintext, 'utf8'), binding),
    wrappedKey: seal(masterKey, dataKey, binding),
  }
}

export function decryptSecret(masterKey: Buffer, sealed: Sealed, aad: string): string {
  const binding = Buffer.from(aad)
  const dataKey = open(masterKey, sealed.wrappedKey, binding)
  return open(dataKey, sealed.ciphertext, binding).toString('utf8')
}

export function rewrapKey(oldKey: Buffer, newKey: Buffer, wrappedKey: Buffer, aad: string): Buffer {
  const binding = Buffer.from(aad)
  return seal(newKey, open(oldKey, wrappedKey, binding), binding)
}
