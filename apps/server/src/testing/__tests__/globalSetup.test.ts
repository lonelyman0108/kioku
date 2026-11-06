import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { waitForTestDatabase } from '../globalSetup'

describe('等后台准备的测试库', () => {
  const statusFile = () => join(mkdtempSync(join(tmpdir(), 'kioku-db-')), 'bg-test-db.status')

  it('没设状态文件时不等', async () => {
    await expect(waitForTestDatabase(undefined, 10)).resolves.toBeUndefined()
  })

  it('等到状态文件出现；写的是 ok 就继续', async () => {
    const file = statusFile()
    setTimeout(() => writeFileSync(file, 'ok\n'), 30)
    await expect(waitForTestDatabase(file, 2000, 5)).resolves.toBeUndefined()
  })

  it('准备失败时打出日志末尾再报错，不往下跑测试', async () => {
    const file = statusFile()
    writeFileSync(
      file,
      'failed\nView build details: docker-desktop://dashboard/build/x\n数据库镜像构建失败\n',
    )
    const reported: string[] = []
    await expect(waitForTestDatabase(file, 2000, 5, (text) => reported.push(text))).rejects.toThrow(
      '测试数据库没有起来',
    )
    expect(reported.join('\n')).toContain('数据库镜像构建失败')
  })

  it('一直没有结果时按时限报错', async () => {
    await expect(waitForTestDatabase(statusFile(), 30, 5)).rejects.toThrow('没有准备好')
  })
})
