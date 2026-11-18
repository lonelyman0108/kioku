import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Config } from '../config'
import { DATA_FILE } from '../dataDir'

// 命令行工具共用的收尾：用法错误打印原因和帮助、退出码 2；其余错误只打印原因、退出码 1
export class UsageError extends Error {}

export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const self = fileURLToPath(metaUrl)
  try {
    return realpathSync(self) === realpathSync(entry)
  } catch {
    return resolve(self) === resolve(entry)
  }
}

export async function runCli(
  help: string,
  main: (argv: string[]) => Promise<void | number>,
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const code = await main(argv)
    return typeof code === 'number' ? code : 0
  } catch (err: unknown) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${help}`)
      return 2
    }
    console.error(err instanceof Error ? err.message : err)
    return 1
  }
}

// 命令行工具连哪个库：和服务同一个读取顺序（环境变量 DATABASE_URL 优先，其次数据目录的 kioku.json，见 dataDir.ts）
export function databaseUrlOf(config: Config): string {
  if (config.database) return config.database.url
  throw new UsageError(
    `缺少数据库连接：设置环境变量 DATABASE_URL，或者让 KIOKU_DATA_DIR 指向服务的数据目录（读其中的 ${join(config.dataDir, DATA_FILE)}）`,
  )
}

// 帮助里「环境变量」一节共用的两行
export const DATABASE_ENV_HELP = `  DATABASE_URL               Kioku 的数据库；不设时读 KIOKU_DATA_DIR 下的 kioku.json，与服务相同
  KIOKU_DATA_DIR             服务的数据目录，与服务相同`
