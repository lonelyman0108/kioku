import { existsSync, readFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'

import type { DatabaseInfo, SystemInfo } from '@kioku/contracts'
import { sql } from 'drizzle-orm'

import journal from '../../migrations/meta/_journal.json'
import { keyIdOf, keyringOf } from '../crypto/keyring'
import type { Db } from '../db/client'
import { lastMigration } from '../db/migrate'
import { embeddingSettingsView } from '../embedding/settings'
import { extractionSettingsView } from '../extraction/settings'
import type { Deps } from '../http/env'
import { BUILD } from '../version'
import { updateCheckView } from './updateCheck'

// 系统信息（设置 › 实例 › 系统信息）：排查问题、贴 issue 时要的构建、运行环境、数据库与配置

// 在不在容器里：Docker 留下 /.dockerenv，Podman 留下 /run/.containerenv，别的看 1 号进程的 cgroup。只看一次
let inContainer: boolean | undefined
function detectContainer(): boolean {
  if (inContainer !== undefined) return inContainer
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return (inContainer = true)
  try {
    const cgroup = readFileSync('/proc/1/cgroup', 'utf8')
    inContainer = /docker|kubepods|containerd|libpod|lxc/.test(cgroup)
  } catch {
    inContainer = false
  }
  return inContainer
}

// 迁移的名字：drizzle 只记哈希与时间戳，按打包进来的迁移清单对回名字。对不上（库来自更新的版本）时给时间戳
const MIGRATION_TAGS = new Map(journal.entries.map((e) => [e.when, e.tag]))

// 连接串里的库名与主机：从连接池的设置里取，不含用户名与密码
function connectionTarget(db: Db): Pick<DatabaseInfo, 'name' | 'host'> {
  const options = (db as { $client?: { options?: ConnectionOptions } }).$client?.options
  if (!options) return { name: null, host: null }
  const host = options.path
    ? options.path
    : options.host
        .map((h, i) => {
          const port = options.port[i] ?? options.port[0]
          const name = h.includes(':') ? `[${h}]` : h
          return port ? `${name}:${port}` : name
        })
        .join(',')
  return { name: options.database ?? null, host: host || null }
}
interface ConnectionOptions {
  host: string[]
  port: number[]
  path: string | false
  database: string | null
}

async function databaseInfo(db: Db): Promise<DatabaseInfo> {
  const [[server], extensions, migration] = await Promise.all([
    db.execute<{ version: string }>(sql`select current_setting('server_version') as version`),
    db.execute<{ name: string; version: string }>(
      sql`select extname as name, extversion as version from pg_extension where extname in ('vector', 'zhparser')`,
    ),
    lastMigration(db),
  ])
  const extension = (name: string) => extensions.find((e) => e.name === name)?.version ?? null
  return {
    version: server?.version ?? null,
    pgvector: extension('vector'),
    zhparser: extension('zhparser'),
    migration: migration ? (MIGRATION_TAGS.get(migration.at) ?? String(migration.at)) : null,
    ...connectionTarget(db),
  }
}

function webUiState(webDir: string | undefined): SystemInfo['config']['webUi'] {
  if (!webDir) return 'off'
  return existsSync(join(webDir, 'index.html')) ? 'served' : 'missing'
}

export async function systemInfo(deps: Deps, now: Date = new Date()): Promise<SystemInfo> {
  const [database, embedding, extraction, updates] = await Promise.all([
    databaseInfo(deps.db),
    embeddingSettingsView(deps.db),
    extractionSettingsView(deps.db),
    updateCheckView(deps.db, deps.updateCheck?.current),
  ])
  const uptimeSeconds = Math.floor(process.uptime())
  const ring = deps.masterKey ? keyringOf(deps.masterKey) : null
  const info: Omit<SystemInfo, 'diagnostics'> = {
    build: BUILD,
    runtime: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      container: detectContainer(),
      startedAt: new Date(now.getTime() - uptimeSeconds * 1000).toISOString(),
      uptimeSeconds,
    },
    database,
    config: {
      masterKey: {
        configured: ring !== null,
        id: ring ? keyIdOf(ring.current) : null,
        rotating: Boolean(ring?.previous),
      },
      cookieSecure: deps.cookieSecure,
      trustedProxies: deps.trustedProxies ?? 0,
      webUi: webUiState(deps.webDir),
      jobs: deps.jobs !== null,
      embedding: embedding.active !== null,
      extraction: extraction.configured,
    },
    updates,
  }
  return { ...info, diagnostics: diagnosticsText(info) }
}

// 已运行多久：天、小时、分钟，最多两级
export function durationText(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days) return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`
  if (hours) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`
  return minutes ? `${minutes} 分钟` : '不到 1 分钟'
}

const yesNo = (value: boolean, yes: string, no: string) => (value ? yes : no)
const WEB_UI_TEXT = { served: '已找到构建产物', missing: '未找到构建产物', off: '未配置目录' }

// 贴 issue 用的纯文本。只有排查要用的版本与开关，不放库名、主机与主密钥标识这类地址与标识
export function diagnosticsText(info: Omit<SystemInfo, 'diagnostics'>): string {
  const { build, runtime, database, config, updates } = info
  const lines: [string, string | number | null][] = [
    ['版本', build.version],
    ['提交', build.commit],
    ['构建时间', build.builtAt],
    ['Node', runtime.node],
    ['系统', `${runtime.platform} ${runtime.osRelease}（${runtime.arch}）`],
    ['容器', yesNo(runtime.container, '是', '否')],
    ['已运行', durationText(runtime.uptimeSeconds)],
    ['PostgreSQL', database.version],
    ['pgvector', database.pgvector ?? '未安装'],
    ['zhparser', database.zhparser ?? '未安装'],
    ['当前迁移', database.migration],
    [
      '主密钥',
      config.masterKey.configured
        ? yesNo(config.masterKey.rotating, '已配置，轮换中', '已配置')
        : '未配置',
    ],
    ['KIOKU_COOKIE_SECURE', String(config.cookieSecure)],
    ['KIOKU_TRUSTED_PROXIES', config.trustedProxies],
    ['管理界面', WEB_UI_TEXT[config.webUi]],
    ['后台任务', yesNo(config.jobs, '运行中', '未运行')],
    ['嵌入模型', yesNo(config.embedding, '已配置', '未配置')],
    ['抽取模型', yesNo(config.extraction, '已配置', '未配置')],
    ['检查新版本', yesNo(updates.enabled, '开启', '关闭')],
  ]
  return ['Kioku 诊断信息', ...lines.map(([label, value]) => `${label}：${value ?? '–'}`)].join(
    '\n',
  )
}
