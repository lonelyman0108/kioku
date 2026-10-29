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

import { MemoryError } from '../memory/service'
import { isBackupFile } from './format'

// 按空间导出的文件：开头是不加密的文件头（格式标记、scrypt 参数、盐、iv、口令校验值），后面是压缩后用口令派生的
// 密钥加密的正文（AES-256-GCM，aad 是整个文件头，最后 16 字节是认证标签）。
// scrypt(口令, 盐) 得到 64 字节：前一半加密正文，后一半算口令校验值。导入时先核对校验值，口令不对时直接说清，
// 不必先解一遍整个文件；校验值推不出密钥，用它试口令也不比试着解开头几个字节更快。
// 口令由导出人另存，Kioku 不保存它，也不用主密钥：文件要能导入到主密钥不同的另一个实例
const MAGIC = Buffer.from('KIOKUSX1')
const SALT_LENGTH = 16
const IV_LENGTH = 12
const CHECK_LENGTH = 16
const TAG_LENGTH = 16
// 格式标记、三个 scrypt 参数（各一个字节）、盐、iv、口令校验值
const HEADER_LENGTH = MAGIC.length + 3 + SALT_LENGTH + IV_LENGTH + CHECK_LENGTH

export interface KdfParams {
  // N = 2^logN
  logN: number
  r: number
  p: number
}

// 2^17、8、1：派生一次要 128 MiB 内存，本机两三百毫秒
export const DEFAULT_KDF: KdfParams = { logN: 17, r: 8, p: 1 }

// 读文件时只接受这个范围里的参数：文件头不加密，参数被改大可以占满服务端的内存或 CPU。
// 内存按 scrypt 的 128 × N × r 字节算
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

// 派生同时只跑一个：每次要上百 MiB 内存，连点几下导出、或者同时导入几份，不该把内存一下子叠上去
let pending: Promise<unknown> = Promise.resolve()
function serially<T>(fn: () => Promise<T>): Promise<T> {
  const run = pending.then(fn)
  pending = run.catch(() => {})
  return run
}

const scryptAsync = (passphrase: string, salt: Buffer, kdf: KdfParams) =>
  serially(
    () =>
      new Promise<Buffer>((resolve, reject) =>
        scrypt(
          // 和账号密码一样先做 NFKC：不同输入法打出的全角、半角字符派生出同一把密钥
          passphrase.normalize('NFKC'),
          salt,
          64,
          { N: 2 ** kdf.logN, r: kdf.r, p: kdf.p, maxmem: kdfMemory(kdf) + 32 * 1024 * 1024 },
          (err, key) => (err ? reject(err) : resolve(key)),
        ),
      ),
  )

// 口令派生出的密钥与文件头。导出时先派生好，再开读库的事务：派生要排队、要几百毫秒，不该占着事务
export interface ExportKey {
  key: Buffer
  header: Buffer
}

function checkValue(material: Buffer): Buffer {
  return createHmac('sha256', material)
    .update('kioku-space-export-check')
    .digest()
    .subarray(0, CHECK_LENGTH)
}

export async function deriveExportKey(
  passphrase: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<ExportKey> {
  if (!acceptable(kdf)) throw new Error('scrypt 参数超出了导入时接受的范围')
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const derived = await scryptAsync(passphrase, salt, kdf)
  const header = Buffer.concat([
    MAGIC,
    Buffer.from([kdf.logN, kdf.r, kdf.p]),
    salt,
    iv,
    checkValue(derived.subarray(32)),
  ])
  return { key: derived.subarray(0, 32), header }
}

// 超出大小上限：正文（压缩前）或整个文件（加密后）
export class ExportTooLarge extends Error {}

// 正文边生成边压缩、加密，攒成整个文件：导出要先确认读完、没出错，再交给浏览器下载，
// 半截的文件会被当成导出成功。压缩前的正文超过 maxPlainBytes、文件超过 maxBytes 时停下并抛出 ExportTooLarge
export async function sealSpaceExport(
  exportKey: ExportKey,
  plain: AsyncIterable<string>,
  limits: { maxPlainBytes: number; maxBytes: number },
): Promise<Buffer> {
  const iv = exportKey.header.subarray(MAGIC.length + 3 + SALT_LENGTH, HEADER_LENGTH - CHECK_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', exportKey.key, iv)
  cipher.setAAD(exportKey.header)
  let plainBytes = 0
  async function* counted() {
    for await (const text of plain) {
      plainBytes += Buffer.byteLength(text)
      if (plainBytes > limits.maxPlainBytes) throw new ExportTooLarge()
      yield text
    }
  }
  const chunks: Buffer[] = [exportKey.header]
  let bytes = exportKey.header.length + TAG_LENGTH
  // 管道里哪一段出错，整条管道连同正文的来源一起销毁，这里读密文的循环随之抛出那个错误
  for await (const chunk of pipeline(
    Readable.from(counted()),
    createGzip(),
    cipher,
    () => {},
  ) as AsyncIterable<Buffer>) {
    bytes += chunk.length
    if (bytes > limits.maxBytes) throw new ExportTooLarge()
    chunks.push(chunk)
  }
  chunks.push(cipher.getAuthTag())
  return Buffer.concat(chunks)
}

const gunzipAsync = promisify(gunzip)

// 解开导出文件：先核对口令，再整份解密、核对认证标签，最后解压。解压后超过 maxPlainBytes 时拒绝（压缩炸弹）。
// 出错时抛出给用户看的 MemoryError（400）
export async function openSpaceExport(
  passphrase: string,
  file: Buffer,
  maxPlainBytes: number,
): Promise<Buffer> {
  if (isBackupFile(file)) {
    throw new MemoryError(
      400,
      '这是全实例的备份文件，不是空间的导出文件：备份用 restore.mjs 恢复到新实例',
    )
  }
  if (file.length < HEADER_LENGTH + TAG_LENGTH || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new MemoryError(400, '不是 Kioku 的空间导出文件')
  }
  const header = file.subarray(0, HEADER_LENGTH)
  let at = MAGIC.length
  const kdf: KdfParams = { logN: header[at++]!, r: header[at++]!, p: header[at++]! }
  if (!acceptable(kdf)) {
    throw new MemoryError(400, '导出文件的文件头不对：加密参数超出了能接受的范围')
  }
  const salt = header.subarray(at, (at += SALT_LENGTH))
  const iv = header.subarray(at, (at += IV_LENGTH))
  const expected = header.subarray(at, at + CHECK_LENGTH)
  const derived = await scryptAsync(passphrase, salt, kdf)
  if (!timingSafeEqual(checkValue(derived.subarray(32)), expected)) {
    throw new MemoryError(400, '口令不对（也可能是文件头被改过）')
  }
  const decipher = createDecipheriv('aes-256-gcm', derived.subarray(0, 32), iv)
  decipher.setAAD(header)
  decipher.setAuthTag(file.subarray(file.length - TAG_LENGTH))
  let compressed: Buffer
  try {
    compressed = Buffer.concat([
      decipher.update(file.subarray(HEADER_LENGTH, file.length - TAG_LENGTH)),
      decipher.final(),
    ])
  } catch {
    throw new MemoryError(400, '导出文件解不开：文件不完整或被改过')
  }
  try {
    return await gunzipAsync(compressed, { maxOutputLength: maxPlainBytes })
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new MemoryError(400, `导出文件解压后超过 ${maxPlainBytes / 1024 / 1024} MB 的上限`)
    }
    throw new MemoryError(400, '导出文件的内容不对：解压失败')
  }
}
