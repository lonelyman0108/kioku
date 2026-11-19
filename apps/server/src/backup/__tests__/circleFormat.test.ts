import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { MemoryError } from '../../memory/errors'
import { ExportTooLarge, openCircleExport, sealCircleExport } from '../circleFormat'
import { sealBackup } from '../format'

const FAST_KDF = { logN: 14, r: 8, p: 1 }

describe('按圈导出文件加密格式（KIOKUCX2）', () => {
  it('支持密封与口令解封往返', async () => {
    const payload = Buffer.from(JSON.stringify({ hello: '世界' }) + '\n', 'utf8')
    const sealed = await sealCircleExport(payload, 'correct-horse-battery-staple', FAST_KDF)
    expect(sealed.subarray(0, 8).toString('ascii')).toBe('KIOKUCX2')
    const opened = await openCircleExport(sealed, 'correct-horse-battery-staple')
    expect(opened).toEqual(payload)
  })

  it('口令错误、密文被篡改或 KDF 参数越界均拒绝', async () => {
    const sealed = await sealCircleExport(Buffer.from('test-data'), 'passphrase-1234', FAST_KDF)
    await expect(openCircleExport(sealed, 'wrong-passphrase')).rejects.toSatisfy(
      (err) => err instanceof MemoryError && err.status === 400 && err.message.includes('口令'),
    )

    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff
    await expect(openCircleExport(tampered, 'passphrase-1234')).rejects.toSatisfy(
      (err) => err instanceof MemoryError && err.status === 400,
    )

    const badKdf = Buffer.from(sealed)
    badKdf[8] = 25 // 超出 MAX_LOG_N
    await expect(openCircleExport(badKdf, 'passphrase-1234')).rejects.toSatisfy(
      (err) => err instanceof MemoryError && err.status === 400,
    )
  })

  it('拒绝全实例备份与旧版空间导出文件，并拦截超出明文体积上限的压缩炸弹', async () => {
    const chunks: Buffer[] = []
    for await (const chunk of sealBackup(
      randomBytes(32),
      (async function* () {
        yield 'ok'
      })(),
    )) {
      chunks.push(chunk)
    }
    const backup = Buffer.concat(chunks)
    await expect(openCircleExport(backup, 'anything-12345')).rejects.toSatisfy(
      (err) =>
        err instanceof MemoryError && err.status === 400 && err.message.includes('全实例备份'),
    )

    const legacyHeader = Buffer.concat([Buffer.from('KIOKUSX1'), Buffer.alloc(64)])
    await expect(openCircleExport(legacyHeader, 'anything-12345')).rejects.toSatisfy(
      (err) => err instanceof MemoryError && err.status === 400 && err.message.includes('旧版空间'),
    )

    const largePlain = Buffer.from('a'.repeat(16 * 1024), 'utf8')
    const sealedLarge = await sealCircleExport(largePlain, 'passphrase-1234', FAST_KDF)
    await expect(openCircleExport(sealedLarge, 'passphrase-1234', 1024)).rejects.toBeInstanceOf(
      ExportTooLarge,
    )
  })
})
