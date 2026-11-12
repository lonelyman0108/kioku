import { join } from 'node:path'

import type { Config } from '../config'
import { DATA_FILE } from '../dataDir'

// 命令行工具共用的收尾：用法错误打印原因和帮助、退出码 2；其余错误只打印原因、退出码 1
export class UsageError extends Error {}

export function runCli(help: string, main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${help}`)
      process.exitCode = 2
      return
    }
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
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
