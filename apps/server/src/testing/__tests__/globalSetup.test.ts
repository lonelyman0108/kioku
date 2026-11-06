import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { waitForTestDatabase } from '../globalSetup'

const background = fileURLToPath(
  new URL('../../../../../scripts/ci/background.sh', import.meta.url),
)

describe('等后台准备的测试库', () => {
  const tempDir = () => mkdtempSync(join(tmpdir(), 'kioku-db-'))
  // 和 background.sh 一样先写临时文件再改名，等的一方不会读到写了一半的状态
  const writeStatus = (file: string, text: string) => {
    writeFileSync(`${file}.tmp`, text)
    renameSync(`${file}.tmp`, file)
  }
  const collect = () => {
    const reported: string[] = []
    return { reported, report: (text: string) => void reported.push(text) }
  }

  it('没设状态文件时不等', async () => {
    await expect(waitForTestDatabase(undefined, 10)).resolves.toBeUndefined()
  })

  it('等到状态文件出现；写的是 ok 就继续', async () => {
    const file = join(tempDir(), 'bg-test-db.status')
    setTimeout(() => writeStatus(file, 'ok\n'), 30)
    await expect(waitForTestDatabase(file, 2000, 5)).resolves.toBeUndefined()
  })

  it('准备失败时打出日志末尾再报错，不往下跑测试', async () => {
    const file = join(tempDir(), 'bg-test-db.status')
    writeStatus(file, 'failed\n数据库镜像构建失败\n')
    const { reported, report } = collect()
    await expect(waitForTestDatabase(file, 2000, 5, report)).rejects.toThrow('测试数据库没有起来')
    expect(reported.join('\n')).toContain('数据库镜像构建失败')
  })

  it('一直没有结果时按时限报错，并打出到现在的日志', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'bg-test-db.log'), '正在编译 zhparser\n')
    const { reported, report } = collect()
    await expect(
      waitForTestDatabase(join(dir, 'bg-test-db.status'), 30, 5, report),
    ).rejects.toThrow('没有准备好')
    expect(reported.join('\n')).toContain('正在编译 zhparser')
  })

  // 状态文件的格式在 background.sh 和这里各写了一份，拿真的脚本对一遍
  it.each([
    ['成功', 'exit 0', true],
    ['失败', 'echo 构建出错; exit 3', false],
  ])('和 background.sh 写下的状态文件对得上：%s', async (_, script, succeeds) => {
    const dir = tempDir()
    const env = { ...process.env, RUNNER_TEMP: dir }
    execFileSync('bash', [background, 'start', 'test-db', 'bash', '-c', script], { env })
    const file = execFileSync('bash', [background, 'status-file', 'test-db'], { env })
      .toString()
      .trim()
    const { reported, report } = collect()
    const waiting = waitForTestDatabase(file, 10_000, 20, report)
    if (succeeds) {
      await expect(waiting).resolves.toBeUndefined()
    } else {
      await expect(waiting).rejects.toThrow('测试数据库没有起来')
      expect(reported.join('\n')).toContain('构建出错')
    }
  })
})
