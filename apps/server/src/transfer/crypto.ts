import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'

import { ExportedCredentialRecord, type EncryptedCredentialsBundle } from '@kioku/contracts'
import { z } from 'zod'

import { MemoryError } from '../memory/errors'

const AAD = Buffer.from('kioku-export-credentials-v2', 'utf8') // lint-comments: allow
const DEFAULT_KDF = { n: 32_768, r: 8, p: 1 } as const
const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_SCRYPT_MEM = 256 * 1024 * 1024

const PayloadSchema = z.object({
  credentials: z.array(ExportedCredentialRecord),
})

function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: { n: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_BYTES,
      { N: params.n, r: params.r, p: params.p, maxmem: MAX_SCRYPT_MEM },
      (err, key) => {
        if (err) reject(err)
        else resolve(key)
      },
    )
  })
}

export async function encryptExportCredentials(
  records: ExportedCredentialRecord[],
  passphrase: string,
): Promise<EncryptedCredentialsBundle> {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = await deriveKey(passphrase, salt, DEFAULT_KDF)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const plaintext = Buffer.from(JSON.stringify({ credentials: records }), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    kdf: 'scrypt',
    params: { ...DEFAULT_KDF },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export async function decryptExportCredentials(
  bundle: EncryptedCredentialsBundle,
  passphrase: string,
): Promise<ExportedCredentialRecord[]> {
  const salt = Buffer.from(bundle.salt, 'base64')
  const iv = Buffer.from(bundle.iv, 'base64')
  const tag = Buffer.from(bundle.tag, 'base64')
  const ciphertext = Buffer.from(bundle.ciphertext, 'base64')

  if (salt.length < 8 || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new MemoryError(400, '导出文件中的加密凭据结构无效')
  }

  let raw: string
  try {
    const key = await deriveKey(passphrase, salt, bundle.params)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    raw = plain.toString('utf8')
  } catch {
    throw new MemoryError(400, '加密口令不正确，或凭据密文已损坏')
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new MemoryError(400, '解密后的凭据数据格式有误')
  }

  const parsed = PayloadSchema.safeParse(json)
  if (!parsed.success) {
    throw new MemoryError(400, '解密后的凭据记录不符合格式要求')
  }
  return parsed.data.credentials
}
