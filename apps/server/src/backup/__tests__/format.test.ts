import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { keyIdOf } from '../../crypto/keyring'
import { backupKeyId, openBackup, sealBackup } from '../format'

async function* parts(...texts: string[]) {
  yield* texts
}

async function seal(key: Parameters<typeof sealBackup>[0], ...texts: string[]): Promise<Buffer> {
  const all: Buffer[] = []
  for await (const chunk of sealBackup(key, parts(...texts))) all.push(chunk)
  return Buffer.concat(all)
}

describe('备份文件的加密', () => {
  const key = randomBytes(32)
  const plain = '{"format":"kioku-backup"}\n第一行\n带换行的 \\n 与表情 😀\n'

  it('压缩加密后用同一把主密钥解得开，文件头里记着它的标识', async () => {
    const file = await seal(key, ...plain.split(/(?<=\n)/))
    expect(backupKeyId(file)).toBe(keyIdOf(key))
    expect(openBackup(key, file).toString('utf8')).toBe(plain)
    // 每份备份的盐与 iv 都不同
    const again = await seal(key, plain)
    expect(again.equals(file)).toBe(false)
    expect(openBackup(key, again).toString('utf8')).toBe(plain)
  })

  it('轮换之后用旧主密钥做的备份：旧的那把配在 previous 也解得开', async () => {
    const file = await seal(key, plain)
    const rotated = { current: randomBytes(32), previous: key }
    expect(openBackup(rotated, file).toString('utf8')).toBe(plain)
    // 新做的备份用当前的那把
    const fresh = await seal(rotated, plain)
    expect(backupKeyId(fresh)).toBe(keyIdOf(rotated.current))
  })

  it('主密钥不对、文件被改过或不完整、不是备份文件时都拒绝', async () => {
    const file = await seal(key, plain)
    expect(() => openBackup(randomBytes(32), file)).toThrow(
      `备份是用另一把主密钥（标识 ${keyIdOf(key)}）加密的`,
    )
    const tampered = Buffer.from(file)
    tampered[tampered.length - 20]! ^= 1
    expect(() => openBackup(key, tampered)).toThrow('文件不完整或被改过')
    expect(() => openBackup(key, file.subarray(0, file.length - 1))).toThrow('文件不完整或被改过')
    // 文件头里的标识改成另一把：认不出时按标识报主密钥不对，不会拿别的密钥去试
    const relabeled = Buffer.from(file)
    relabeled.write(keyIdOf(randomBytes(32)), 8, 'ascii')
    expect(() => openBackup(key, relabeled)).toThrow('另一把主密钥')
    expect(() => openBackup(key, Buffer.from('PGDMP custom dump'))).toThrow('不是 Kioku 的备份文件')
  })
})
