import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { sealBackup } from '../format'
import {
  DEFAULT_KDF,
  deriveExportKey,
  ExportTooLarge,
  openSpaceExport,
  sealSpaceExport,
  type KdfParams,
} from '../spaceFormat'

async function* parts(...texts: string[]) {
  yield* texts
}

const LIMITS = { maxPlainBytes: 1024 * 1024, maxBytes: 1024 * 1024 }
// 测试里用接受范围里最低的参数，省时间；默认参数单独测一次
const FAST: KdfParams = { logN: 14, r: 8, p: 1 }

async function seal(passphrase: string, texts: string[], kdf = FAST, limits = LIMITS) {
  return sealSpaceExport(await deriveExportKey(passphrase, kdf), parts(...texts), limits)
}

const open = (passphrase: string, file: Buffer, maxPlainBytes = LIMITS.maxPlainBytes) =>
  openSpaceExport(file, { passphrase, maxPlainBytes })

describe('空间导出文件的加密', () => {
  const passphrase = 'correct horse battery staple'
  const plain =
    '{"format":"kioku-space-export"}\n{"type":"memory","content":"带换行的 \\n 与表情 😀"}\n'

  it('用默认参数压缩加密后，同一个口令解得开；每份的盐与 iv 都不同', async () => {
    const file = await seal(passphrase, plain.split(/(?<=\n)/), DEFAULT_KDF)
    expect(file.subarray(0, 8).toString()).toBe('KIOKUSX1')
    // 参数写在文件头里
    expect([...file.subarray(8, 11)]).toEqual([DEFAULT_KDF.logN, DEFAULT_KDF.r, DEFAULT_KDF.p])
    expect((await open(passphrase, file)).toString()).toBe(plain)
    const again = await seal(passphrase, [plain], DEFAULT_KDF)
    expect(again.subarray(0, 50).equals(file.subarray(0, 50))).toBe(false)
    expect((await open(passphrase, again)).toString()).toBe(plain)
  })

  it('口令按 NFKC 归一：全角与半角的同一个口令解得开', async () => {
    const file = await seal('ｐａｓｓｐｈｒａｓｅ　１２３４５', [plain])
    expect((await open('passphrase 12345', file)).toString()).toBe(plain)
  })

  it('口令不对、文件被改过或不完整、不是导出文件时都拒绝，并说清是哪一种', async () => {
    const file = await seal(passphrase, [plain])
    await expect(open('wrong passphrase!', file)).rejects.toThrow('口令不对')
    const tampered = Buffer.from(file)
    tampered[tampered.length - 20]! ^= 1
    await expect(open(passphrase, tampered)).rejects.toThrow('文件不完整或被改过')
    await expect(open(passphrase, file.subarray(0, file.length - 1))).rejects.toThrow(
      '文件不完整或被改过',
    )
    // 文件头不加密但参与认证：改了盐或参数，派生出的就不是同一把密钥
    const salted = Buffer.from(file)
    salted[12]! ^= 1
    await expect(open(passphrase, salted)).rejects.toThrow('口令不对')
    const params = Buffer.from(file)
    params[9] = 9
    await expect(open(passphrase, params)).rejects.toThrow('口令不对')
    // 参数被改得超出接受的范围时不去派生（挡住拿文件头占满内存）
    const huge = Buffer.from(file)
    huge[8] = 30
    await expect(open(passphrase, huge)).rejects.toThrow('加密参数超出了能接受的范围')
    await expect(open(passphrase, Buffer.from('PGDMP custom dump'))).rejects.toThrow(
      '不是 Kioku 的空间导出文件',
    )
  })

  it('全实例的备份文件被当成导出文件上传时说清楚', async () => {
    const backup: Buffer[] = []
    for await (const chunk of sealBackup(randomBytes(32), parts('{}\n'))) backup.push(chunk)
    await expect(open(passphrase, Buffer.concat(backup))).rejects.toThrow('这是全实例的备份文件')
  })

  it('解压后超过上限时停下，不把压缩炸弹解进内存', async () => {
    const zeros = '0'.repeat(64 * 1024)
    const file = await seal(passphrase, Array(32).fill(zeros), FAST, {
      maxPlainBytes: 4 * 1024 * 1024,
      maxBytes: 1024 * 1024,
    })
    // 两 MB 的正文压缩后很小
    expect(file.length).toBeLessThan(64 * 1024)
    await expect(open(passphrase, file, 1024 * 1024)).rejects.toThrow('解压后超过 1 MB 的上限')
  })

  it('导出时正文或整个文件超过上限就停下', async () => {
    const zeros = '0'.repeat(64 * 1024)
    await expect(
      seal(passphrase, Array(32).fill(zeros), FAST, {
        maxPlainBytes: 1024 * 1024,
        maxBytes: 4 * 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(ExportTooLarge)
    // 压缩不了的随机内容：压缩前不超，加密后超过
    const noise = randomBytes(256 * 1024).toString('base64')
    await expect(
      seal(passphrase, [noise], FAST, { maxPlainBytes: 1024 * 1024, maxBytes: 128 * 1024 }),
    ).rejects.toBeInstanceOf(ExportTooLarge)
  })
})
