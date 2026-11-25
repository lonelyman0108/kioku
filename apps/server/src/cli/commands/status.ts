import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  COMMIT_SHA,
  DATABASE_FAILURE_NAMES,
  DATABASE_SOURCE_NAMES,
  databaseProblemText,
  EXISTING_DATA_NAMES,
  EXTENSION_STATE_NAMES,
  versionLabel,
} from '@kioku/contracts'

import { loadConfig, type Config } from '../../config'
import { keyIdOf } from '../../crypto/keyring'
import { checkMasterKey } from '../../crypto/rotation'
import { connect } from '../../db/client'
import { pendingMigrations } from '../../db/migrate'
import { probeDatabase, summarize } from '../../db/probe'
import { BUILD } from '../../version'
import { DATABASE_ENV_HELP, runCli, UsageError } from '../common'
import { dim, formatRows, green, red, renderStrataBox, yellow } from '../format'

type WebUiState = 'served' | 'missing' | 'off'

const WEB_UI_NAMES: Record<WebUiState, string> = {
  served: '已托管',
  missing: '未找到构建产物',
  off: '未配置目录',
}

export const STATUS_HELP = `检查服务端配置、数据库连接、扩展、迁移与主密钥状态（只读，不修改数据库）。

用法：kioku-ctl status [--json]

  --json       输出结构化 JSON（不含任何密码或密钥明文）
  -h, --help   显示帮助

环境变量：
${DATABASE_ENV_HELP}
  KIOKU_MASTER_KEY           主密钥
  KIOKU_MASTER_KEY_PREVIOUS  轮换期间的旧主密钥

退出码：0 数据库与主密钥均就绪；1 未配置、无法连接、存在阻断问题、有待执行迁移或主密钥不匹配；2 参数错误`

function parseStatusOptions(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
}

export interface StatusReport {
  ready: boolean
  version: string
  commit: string | null
  configError: string | null
  database: {
    configured: boolean
    source: string | null
    summary: ReturnType<typeof summarize>
    ready: boolean
    failure: string | null
    existing: string | null
    role: { name: string; superuser: boolean } | null
    extensions: { name: string; state: string }[]
    problems: string[]
    pendingMigrations: number | null
    accounts: number | null
    unrelatedTables: number
  } | null
  masterKey: {
    configured: boolean
    currentId: string | null
    previousId: string | null
    matched: boolean | null
    error: string | null
  } | null
  webUi: WebUiState | null
}

export async function collectStatus(): Promise<StatusReport> {
  let config: Config
  try {
    config = loadConfig()
  } catch (err) {
    return {
      ready: false,
      version: BUILD.version,
      commit: BUILD.commit,
      configError: err instanceof Error ? err.message : String(err),
      database: null,
      masterKey: null,
      webUi: null,
    }
  }

  const webUi: WebUiState = !config.webDir
    ? 'off'
    : existsSync(join(config.webDir, 'index.html'))
      ? 'served'
      : 'missing'

  const currentId = config.masterKey ? keyIdOf(config.masterKey.current) : null
  const previousId = config.masterKey?.previous ? keyIdOf(config.masterKey.previous) : null

  if (!config.database) {
    return {
      ready: false,
      version: BUILD.version,
      commit: BUILD.commit,
      configError: null,
      database: {
        configured: false,
        source: null,
        summary: null,
        ready: false,
        failure: null,
        existing: null,
        role: null,
        extensions: [],
        problems: [],
        pendingMigrations: null,
        accounts: null,
        unrelatedTables: 0,
      },
      masterKey: {
        configured: config.masterKey !== null,
        currentId,
        previousId,
        matched: null,
        error: null,
      },
      webUi,
    }
  }

  const summary = summarize(config.database.url)
  const probe = await probeDatabase(config.database.url, config.migrationsFolder)
  const problems = probe.problems.map((p) => databaseProblemText(p, probe.failure))

  let pending: number | null = null
  let matched: boolean | null = null
  let masterKeyError: string | null = null

  const canInspectTables =
    probe.failure === null &&
    (probe.existing === 'kioku' || probe.existing === 'migrated') &&
    !probe.problems.some((p) => p.code === 'insufficient_privilege' || p.code === 'inspect_failed')

  if (canInspectTables) {
    const database = connect(config.database.url, { max: 1 })
    try {
      pending = await pendingMigrations(database.db, config.migrationsFolder)
      try {
        await checkMasterKey(database.db, config.masterKey)
        matched = true
      } catch (err) {
        matched = false
        masterKeyError = err instanceof Error ? err.message : String(err)
      }
    } finally {
      await database.close().catch(() => {})
    }
  }

  const ready = probe.ready && (pending === null || pending === 0) && matched !== false

  return {
    ready,
    version: BUILD.version,
    commit: BUILD.commit,
    configError: null,
    database: {
      configured: true,
      source: config.database.source,
      summary,
      ready: probe.ready,
      failure: probe.failure,
      existing: probe.existing,
      role: probe.role,
      extensions: probe.extensions,
      problems,
      pendingMigrations: pending,
      accounts: probe.accounts,
      unrelatedTables: probe.unrelatedTables,
    },
    masterKey: {
      configured: config.masterKey !== null,
      currentId,
      previousId,
      matched,
      error: masterKeyError,
    },
    webUi,
  }
}

function renderReport(report: StatusReport): string {
  const out = process.stdout
  const badge = versionLabel(report.version)
  if (report.configError) {
    return renderStrataBox('Kioku · 状态检查', [red(`配置错误：${report.configError}`, out)], {
      stream: out,
      badge,
    })
  }

  const db = report.database!
  const mk = report.masterKey!
  const rows: [string, string][] = []

  const commitText =
    report.commit && COMMIT_SHA.test(report.commit) ? ` (${report.commit.slice(0, 7)})` : ''
  rows.push(['版本', `${badge}${commitText}`])
  if (report.webUi) rows.push(['管理界面', WEB_UI_NAMES[report.webUi]])

  if (!db.configured) {
    rows.push(['数据库', yellow('尚未配置（将启动初始化页）', out)])
  } else {
    const sourceLabel =
      db.source === 'env' || db.source === 'file'
        ? DATABASE_SOURCE_NAMES[db.source]
        : (db.source ?? '')
    const host = db.summary
      ? `${db.summary.host}:${db.summary.port}/${db.summary.database}`
      : '未知'
    rows.push(['数据库', `${host} ${dim(`(${sourceLabel})`, out)}`])
    if (db.failure) {
      const text =
        DATABASE_FAILURE_NAMES[db.failure as keyof typeof DATABASE_FAILURE_NAMES] ?? db.failure
      rows.push(['连接状态', red(text, out)])
    } else {
      rows.push(['连接状态', db.ready ? green('正常', out) : red('存在阻断问题', out)])
    }
    if (db.role) {
      rows.push(['角色', `${db.role.name}${db.role.superuser ? '（超级用户）' : ''}`])
    }
    if (db.extensions.length) {
      const extText = db.extensions
        .map((e) => {
          const stateText =
            EXTENSION_STATE_NAMES[e.state as keyof typeof EXTENSION_STATE_NAMES] ?? e.state
          return `${e.name}: ${stateText}`
        })
        .join('，')
      rows.push(['扩展', extText])
    }
    if (db.existing) {
      const text =
        EXISTING_DATA_NAMES[db.existing as keyof typeof EXISTING_DATA_NAMES] ?? db.existing
      rows.push(['库结构', text])
    }
    if (db.pendingMigrations !== null) {
      rows.push([
        '待执行迁移',
        db.pendingMigrations === 0
          ? green('0（已是最新）', out)
          : yellow(`${db.pendingMigrations} 个`, out),
      ])
    }
    if (db.accounts !== null) rows.push(['账号数', String(db.accounts)])
  }

  if (!mk.configured) {
    rows.push(['主密钥', yellow('未配置（无法保存加密凭据或模型 API Key）', out)])
  } else {
    const state =
      mk.matched === true
        ? green('已匹配', out)
        : mk.matched === false
          ? red('不匹配', out)
          : '已配置'
    rows.push(['主密钥', `${state} ${dim(`(${mk.currentId})`, out)}`])
  }

  const lines: (string | { divider: true })[] = [...formatRows(rows, { stream: out })]
  if (db.problems.length || mk.error) {
    lines.push({ divider: true })
    for (const p of db.problems) lines.push(red(`× ${p}`, out))
    if (mk.error) lines.push(red(`× ${mk.error}`, out))
  }
  lines.push({ divider: true })
  lines.push(report.ready ? green('状态就绪', out) : red('尚未就绪', out))

  return renderStrataBox('Kioku · 状态检查', lines, { stream: out, badge })
}

export function runStatus(argv: string[]): Promise<number> {
  return runCli('status', async () => {
    const opts = parseStatusOptions(argv)
    if (opts.help) {
      console.log(STATUS_HELP)
      return 0
    }
    const report = await collectStatus()
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(renderReport(report))
    }
    return report.ready ? 0 : 1
  })
}
