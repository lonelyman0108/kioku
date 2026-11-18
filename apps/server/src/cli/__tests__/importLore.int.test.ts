import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SERVER_DIR = fileURLToPath(new URL('../../..', import.meta.url))

async function importLore(args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/importLore.ts', ...args], {
    cwd: SERVER_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const [code] = (await once(child, 'close')) as [number | null]
  return { code, stdout, stderr }
}

describe('从 Lore 导入的命令行（适配占位）', () => {
  it('--help 返回 0 并打印帮助，直接执行提示正在适配记忆圈架构并退出 1', async () => {
    const help = await importLore(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('Lore 迁入工具正在适配记忆圈架构')

    const res = await importLore([])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('Lore 迁入工具正在适配记忆圈架构')
  })
})
