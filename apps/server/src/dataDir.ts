import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DatabaseSource } from '@kioku/contracts'

// 数据目录里的配置文件：初始化页保存的数据库连接。权限 600，连接串里有密码
export const DATA_FILE = 'kioku.json'

export interface DataFile {
  databaseUrl?: string
}

export interface ResolvedDatabase {
  url: string
  source: DatabaseSource
}

// 读数据目录里的 kioku.json。文件不存在时为 null；存在却读不懂时报错，不当作没有配置：
// 当作没有的话，服务会进入初始化、让人在页面上另填一个库
export function readDataFile(dataDir: string): DataFile | null {
  const path = join(dataDir, DATA_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    throw new Error(`无法读取 ${path}（${(err as { code?: string }).code ?? '未知错误'}）`, {
      cause: err,
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path} 不是合法的 JSON：修正或删掉它再启动`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} 的内容应为 JSON 对象：修正或删掉它再启动`)
  }
  const { databaseUrl } = parsed as { databaseUrl?: unknown }
  if (databaseUrl !== undefined && (typeof databaseUrl !== 'string' || !databaseUrl)) {
    throw new Error(`${path} 里的 databaseUrl 应为非空的字符串：修正或删掉它再启动`)
  }
  return databaseUrl ? { databaseUrl } : {}
}

// 数据库连接从哪里来：环境变量 DATABASE_URL 优先，其次数据目录的 kioku.json。服务与命令行工具共用这一份
export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): ResolvedDatabase | null {
  if (env.DATABASE_URL) return { url: env.DATABASE_URL, source: 'env' }
  const url = readDataFile(dataDir)?.databaseUrl
  return url ? { url, source: 'file' } : null
}

// 写 kioku.json：先写同目录的临时文件（600）、落盘，再改名换上，中途失败不留下半个文件。
// 目录不存在时建出来（700）
export async function writeDataFile(dataDir: string, data: DataFile): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const target = join(dataDir, DATA_FILE)
  const temp = join(dataDir, `.${DATA_FILE}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    // umask 不会放宽 600，这里再设一遍只是为了不依赖它
    await chmod(temp, 0o600)
    await rename(temp, target)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

// 数据目录可不可写：接入之前先试一下，免得迁移做完了才发现存不下连接
export async function assertWritable(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const probe = join(dataDir, `.write-test.${randomBytes(6).toString('hex')}`)
  const handle = await open(probe, 'wx', 0o600)
  await handle.close()
  await rm(probe, { force: true })
}
