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
  WEB_UI_NAMES,
  type WebUiState,
} from '@kioku/contracts'

import { loadConfig, type Config } from '../../config'
import { keyIdOf } from '../../crypto/keyring'
import { checkMasterKey, masterKeyStatus, remainingTotal } from '../../crypto/rotation'
import { connect } from '../../db/client'
import { pendingMigrations } from '../../db/migrate'
import { probeDatabase, summarize } from '../../db/probe'
import { BUILD } from '../../version'
import { DATABASE_ENV_HELP, runCli, UsageError } from '../common'
import { dim, formatRows, green, red, renderStrataBox, yellow } from '../format'

export const STATUS_HELP = `检查服务端配置、数据库连接、角色权限、扩展、迁移与主密钥状态（只读，不修改数据库）。

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
    role: { name: string; superuser: boolean; bypassRls: boolean } | null
    extensions: { name: string; state: string }[]
    problems: string[]
    pendingMigrations: number | null
    accounts: number | null
    spaces: number | null
    unrelatedTables: number
  } | null
  masterKey: {
    configured: boolean
    currentId: string | null
    previousId: string | null
    matched: boolean | null
    error: string | null
    rotationRemaining: number | null
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
        spaces: null,
        unrelatedTables: 0,
      },
      masterKey: {
        configured: config.masterKey !== null,
        currentId,
        previousId,
        matched: null,
        error: null,
        rotationRemaining: null,
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
  let rotationRemaining: number | null = null

  const canInspectTables =
    probe.failure === null &&
    (probe.existing === 'kioku' || probe.existing === 'migrated') &&
    !probe.problems.some((p) => p.code === 'insufficient_privilege' || p.code === 'inspect_failed')

  if (canInspectTables) {
    const database = connect(config.database.url, { max: 1 })
    try {
      pending = await pendingMigrations(database.db, config.migrationsFolder)
      if (pending === 0) {
        try {
          await checkMasterKey(database.db, config.masterKey)
          matched = true
        } catch (err) {
          matched = false
          masterKeyError = err instanceof Error ? err.message : String(err)
        }
        const mk = await masterKeyStatus(database.db, config.masterKey)
        if (mk.previousId) rotationRemaining = remainingTotal(mk.remaining)
      }
    } finally {
      await database.close()
    }
  }

  const migrationsOk =
    probe.existing === 'kioku' || probe.existing === 'migrated' ? pending === 0 : true
  const masterKeyOk = matched !== false
  const ready = probe.ready && migrationsOk && masterKeyOk

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
      spaces: probe.spaces,
      unrelatedTables: probe.unrelatedTables,
    },
    masterKey: {
      configured: config.masterKey !== null,
      currentId,
      previousId,
      matched,
      error: masterKeyError,
      rotationRemaining,
    },
    webUi,
  }
}

function renderStatusBox(report: StatusReport): string {
  const stream = process.stdout
  const ver = versionLabel(report.version)
  const shortCommit =
    report.commit && COMMIT_SHA.test(report.commit) ? report.commit.slice(0, 7) : null
  const rows: [string, string][] = [['版本', shortCommit ? `${ver} (${shortCommit})` : ver]]

  if (report.configError) {
    rows.push(['配置', red(`✕ ${report.configError}`, stream)])
    return renderStrataBox('Kioku · 服务端诊断', formatRows(rows, { stream }), {
      stream,
      badge: ver,
    })
  }

  const db = report.database!
  if (!db.configured) {
    rows.push(['数据库', red('✕ 未配置（未设置 DATABASE_URL 且数据目录暂无 kioku.json）', stream)])
  } else {
    const sourceText =
      db.source === 'env' || db.source === 'file'
        ? DATABASE_SOURCE_NAMES[db.source]
        : String(db.source)
    rows.push(['来源', sourceText])
    rows.push([
      '连接',
      db.summary
        ? `${db.summary.username}@${db.summary.host}:${db.summary.port}/${db.summary.database} (ssl: ${db.summary.ssl})`
        : '无法解析连接串',
    ])

    if (db.failure) {
      const failName =
        DATABASE_FAILURE_NAMES[db.failure as keyof typeof DATABASE_FAILURE_NAMES] ?? db.failure
      rows.push(['数据库', red(`✕ ${failName}`, stream)])
    } else {
      const existingName =
        (db.existing && EXISTING_DATA_NAMES[db.existing as keyof typeof EXISTING_DATA_NAMES]) ??
        '未知'
      if (!db.ready) {
        rows.push(['数据库', red(`✕ 不可用（${db.problems.join('；')}）`, stream)])
      } else if (db.pendingMigrations !== null && db.pendingMigrations !== 0) {
        rows.push([
          '数据库',
          yellow(`! ${existingName}（待执行 ${db.pendingMigrations} 个迁移）`, stream),
        ])
      } else {
        rows.push(['数据库', green(`● 已就绪 · ${existingName}`, stream)])
      }

      if (db.role) {
        if (db.role.superuser || db.role.bypassRls) {
          const why = db.role.superuser ? '超级用户' : '带 BYPASSRLS'
          rows.push(['角色', red(`✕ ${db.role.name}（${why}，会绕过行级安全）`, stream)])
        } else {
          rows.push(['角色', green(`✓ ${db.role.name}（行级安全生效）`, stream)])
        }
      }

      if (db.extensions.length) {
        const extText = db.extensions
          .map((e) => {
            const stateName =
              EXTENSION_STATE_NAMES[e.state as keyof typeof EXTENSION_STATE_NAMES] ?? e.state
            return e.state === 'installed'
              ? green(`✓ ${e.name}`, stream)
              : red(`✕ ${e.name}（${stateName}）`, stream)
          })
          .join('  ')
        rows.push(['扩展', extText])
      }

      if (db.existing === 'kioku' || db.existing === 'migrated') {
        if (db.pendingMigrations === 0) {
          rows.push(['迁移', green('✓ 已是最新', stream)])
        } else if (db.pendingMigrations === null) {
          rows.push(['迁移', red('✕ 含有当前版本不认识的迁移', stream)])
        } else {
          rows.push([
            '迁移',
            yellow(`! 待执行 ${db.pendingMigrations} 个迁移（启动服务后自动完成）`, stream),
          ])
        }
      }

      if (db.accounts !== null && db.spaces !== null) {
        const extra = db.unrelatedTables > 0 ? `（另有 ${db.unrelatedTables} 张非 Kioku 表）` : ''
        rows.push(['数据', `${db.accounts} 个账号 · ${db.spaces} 个空间${extra}`])
      }
    }
  }

  const mk = report.masterKey!
  if (mk.error) {
    rows.push(['主密钥', red(`✕ ${mk.error}`, stream)])
  } else if (!mk.configured) {
    rows.push(['主密钥', yellow('! 未配置（机密记忆、托管凭据与加密设置不可用）', stream)])
  } else if (mk.rotationRemaining !== null && mk.rotationRemaining > 0) {
    rows.push([
      '主密钥',
      yellow(`! 已匹配（标识 ${mk.currentId}，轮换剩余 ${mk.rotationRemaining} 条）`, stream),
    ])
  } else if (mk.previousId) {
    rows.push([
      '主密钥',
      green(`✓ 已匹配（标识 ${mk.currentId}，轮换完成，可移除旧主密钥）`, stream),
    ])
  } else if (mk.matched === true) {
    rows.push(['主密钥', green(`✓ 已匹配（标识 ${mk.currentId}）`, stream)])
  } else {
    rows.push(['主密钥', green(`✓ 已配置（标识 ${mk.currentId}）`, stream)])
  }

  if (report.webUi) {
    const uiName = WEB_UI_NAMES[report.webUi]
    rows.push([
      '管理界面',
      report.webUi === 'served' ? green(`✓ ${uiName}`, stream) : dim(uiName, stream),
    ])
  }

  return renderStrataBox('Kioku · 服务端诊断', formatRows(rows, { stream }), {
    stream,
    badge: ver,
  })
}

async function statusMain(argv: string[]): Promise<number> {
  const values = parseStatusOptions(argv)
  if (values.help) {
    console.log(STATUS_HELP)
    return 0
  }
  const report = await collectStatus()
  if (values.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderStatusBox(report))
  }
  return report.ready ? 0 : 1
}

export function runStatus(argv: string[]): Promise<number> {
  return runCli(STATUS_HELP, statusMain, argv)
}
