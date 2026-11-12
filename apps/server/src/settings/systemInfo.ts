import { existsSync, readFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'

import {
  CONTAINER_NAMES,
  configuredText,
  cookieText,
  extensionText,
  jobsText,
  masterKeyText,
  systemText,
  trustedProxiesText,
  uptimeText,
  WEB_UI_NAMES,
  type ContainerState,
  type DatabaseInfo,
  type SystemInfo,
} from '@kioku/contracts'
import { sql } from 'drizzle-orm'

import journal from '../../migrations/meta/_journal.json'
import { keyIdOf, keyringOf } from '../crypto/keyring'
import type { Db } from '../db/client'
import { lastMigration } from '../db/migrate'
import { embeddingSettingsView } from '../embedding/settings'
import { extractionSettingsView } from '../extraction/settings'
import type { Deps } from '../http/env'
import { BUILD } from '../version'
import { loadUpdateStatus, updateCheckView } from './updateCheck'

// 系统信息（设置 › 实例 › 系统信息）：排查问题、贴 issue 时要的构建、运行环境、数据库与配置

// 服务启动的时间：模块加载时记一次
const STARTED_AT = new Date()

const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// 在不在容器里，按能看到的痕迹判断，一条都对不上时说判断不了，不说「否」：
// Docker 留下 /.dockerenv，Podman 留下 /run/.containerenv，Kubernetes 给每个容器设 KUBERNETES_SERVICE_HOST；
// 旧版 cgroup 下 1 号进程的 cgroup 路径带着容器运行时的名字（统一层级的 cgroup 下只有 0::/，看不出来）；
// 根目录挂的是 overlay 的多半是容器。1 号进程是 systemd 或 init 时是宿主机。只看一次
let container: ContainerState | undefined
export function detectContainer(
  probe: {
    exists: (path: string) => boolean
    read: (path: string) => string | null
    env: NodeJS.ProcessEnv
    platform: string
  } = { exists: existsSync, read: readText, env: process.env, platform: platform() },
): ContainerState {
  if (probe.platform !== 'linux') return 'no'
  if (probe.exists('/.dockerenv') || probe.exists('/run/.containerenv')) return 'yes'
  if (probe.env.KUBERNETES_SERVICE_HOST) return 'yes'
  if (/docker|kubepods|containerd|libpod|lxc/.test(probe.read('/proc/1/cgroup') ?? '')) return 'yes'
  // mountinfo 每行第 5 项是挂载点，「 - 」之后第一项是文件系统类型
  const root = (probe.read('/proc/self/mountinfo') ?? '')
    .split('\n')
    .find((line) => line.split(' ')[4] === '/')
  if (root && /\s-\soverlay\s/.test(root)) return 'yes'
  const init = (probe.read('/proc/1/sched') ?? '').split('\n')[0] ?? ''
  if (/^(systemd|init) \(/.test(init)) return 'no'
  return 'unknown'
}
const containerState = () => (container ??= detectContainer())

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
  const [database, embedding, extraction, update] = await Promise.all([
    databaseInfo(deps.db),
    embeddingSettingsView(deps.db),
    extractionSettingsView(deps.db),
    loadUpdateStatus(deps.db),
  ])
  const uptimeSeconds = Math.max(0, Math.floor((now.getTime() - STARTED_AT.getTime()) / 1000))
  const ring = deps.masterKey ? keyringOf(deps.masterKey) : null
  const info: Omit<SystemInfo, 'diagnostics'> = {
    build: BUILD,
    runtime: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      container: containerState(),
      startedAt: STARTED_AT.toISOString(),
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
    updates: updateCheckView(update, deps.updateCheck?.current),
  }
  return { ...info, diagnostics: diagnosticsText(info) }
}

// 贴 issue 用的纯文本，分组与说法和页面上的一样（都取 contracts 的 system.ts）。
// 只有排查要用的版本与开关，不放库名、主机与主密钥标识这类地址与标识
export function diagnosticsText(info: Omit<SystemInfo, 'diagnostics'>): string {
  const { build, runtime, database, config, updates } = info
  const groups: [string, [string, string | null][]][] = [
    [
      '构建',
      [
        ['版本', build.version],
        ['提交', build.commit],
        ['构建时间', build.builtAt],
      ],
    ],
    [
      '运行环境',
      [
        ['Node', runtime.node],
        ['系统', systemText(runtime)],
        ['容器', CONTAINER_NAMES[runtime.container]],
        ['已运行', uptimeText(runtime.uptimeSeconds)],
      ],
    ],
    [
      '数据库',
      [
        ['版本', database.version],
        ['pgvector', extensionText(database.pgvector)],
        ['zhparser', extensionText(database.zhparser)],
        ['迁移', database.migration],
      ],
    ],
    [
      '配置与后台任务',
      [
        ['主密钥', masterKeyText(config.masterKey)],
        ['Cookie', cookieText(config.cookieSecure)],
        ['受信代理', trustedProxiesText(config.trustedProxies)],
        ['管理界面', WEB_UI_NAMES[config.webUi]],
        ['后台任务', jobsText(config.jobs)],
        ['嵌入模型', configuredText(config.embedding)],
        ['抽取模型', configuredText(config.extraction)],
        ['检查新版本', updates.enabled ? '开启' : '关闭'],
      ],
    ],
  ]
  return [
    'Kioku 诊断信息',
    ...groups.map(([title, lines]) =>
      [`\n[${title}]`, ...lines.map(([label, value]) => `${label}：${value ?? '–'}`)].join('\n'),
    ),
  ].join('\n')
}
