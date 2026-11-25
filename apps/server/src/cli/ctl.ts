import { COMMIT_SHA, versionLabel } from '@kioku/contracts'

import { BUILD } from '../version'
import { runStatus } from './commands/status'
import { isMainModule } from './common'
import { dim, formatRows, renderStrataBox } from './format'

interface Subcommand {
  description: string
  run: (argv: string[]) => Promise<number>
}

const COMMANDS: Record<string, Subcommand> = {
  status: {
    description: '检查数据库、扩展、迁移与主密钥状态',
    run: runStatus,
  },
}

function versionText(): string {
  const label = versionLabel(BUILD.version)
  const commit =
    BUILD.commit && COMMIT_SHA.test(BUILD.commit) ? ` (${BUILD.commit.slice(0, 7)})` : ''
  return `kioku-ctl ${label}${commit}`
}

export const CTL_HELP = `Kioku 服务端运维工具。

用法：kioku-ctl <子命令> [参数…]

  status          检查数据库、扩展、迁移与主密钥状态

  -h, --help     显示本说明
  -v, --version  显示版本号

查看子命令用法：kioku-ctl <子命令> --help`

function renderOverview(): string {
  if (!process.stdout.isTTY) return CTL_HELP
  const ver = versionLabel(BUILD.version)
  const rows = Object.entries(COMMANDS).map(([name, info]): [string, string] => [
    name,
    info.description,
  ])
  return renderStrataBox(
    'Kioku · 服务端运维',
    [
      '用法：kioku-ctl <子命令> [参数…]',
      { divider: true },
      ...formatRows(rows, { stream: process.stdout }),
      { divider: true },
      dim('查看子命令用法：kioku-ctl <子命令> --help', process.stdout),
    ],
    { stream: process.stdout, badge: ver },
  )
}

export async function runCtl(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (!sub || sub === '-h' || sub === '--help') {
    console.log(renderOverview())
    return 0
  }
  if (sub === '-v' || sub === '--version') {
    console.log(versionText())
    return 0
  }
  if (sub === 'help') {
    if (!rest.length) {
      console.log(renderOverview())
      return 0
    }
    const target = rest[0]!
    if (!Object.hasOwn(COMMANDS, target)) {
      console.error(`kioku-ctl：不认识的子命令 ${target}\n\n${CTL_HELP}`)
      return 2
    }
    return COMMANDS[target]!.run(['--help'])
  }
  if (!Object.hasOwn(COMMANDS, sub)) {
    console.error(`kioku-ctl：不认识的子命令 ${sub}\n\n${CTL_HELP}`)
    return 2
  }
  return COMMANDS[sub]!.run(rest)
}

if (isMainModule(import.meta.url)) {
  void runCtl(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
