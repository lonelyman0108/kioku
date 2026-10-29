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
