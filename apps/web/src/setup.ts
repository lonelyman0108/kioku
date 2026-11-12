import {
  DATABASE_FAILURE_NAMES,
  DATABASE_SOURCE_NAMES,
  DatabaseSetupError,
  EXISTING_DATA_NAMES,
  EXTENSION_STATE_NAMES,
  type DatabaseCheck,
  type DatabaseFailure,
  type DatabaseSource,
  type DatabaseSslMode,
  type DatabaseSummary,
} from '@kioku/contracts'

import { ApiError } from './api/client'
import type { Property } from './components/strata/PropertyList.vue'

// 初始化页的数据库这一步：检查结果怎么列、连接信息怎么显示。用词只在这里与契约的 names.ts

export const SSL_MODE_ITEMS: { value: DatabaseSslMode; label: string }[] = [
  { value: 'disable', label: 'disable（不加密）' },
  { value: 'require', label: 'require（加密，不校验证书）' },
  { value: 'verify-full', label: 'verify-full（加密并校验证书）' },
]

const FAILURE_HINTS: Record<DatabaseFailure, string> = {
  unreachable: '检查主机与端口，以及数据库是否在运行。',
  host_not_found: '检查主机名。',
  timeout: '检查网络与防火墙。',
  auth_failed: '检查用户名与密码。',
  not_allowed: '服务器的 pg_hba.conf 未放行此地址、用户与库的组合。',
  database_missing: '先建库，或者改用「用超级用户创建」。',
  permission_denied: '此角色没有这个库的 CONNECT 权限。',
  ssl_unsupported: '把 SSL 改为 disable，或者在服务器上开启 SSL。',
  ssl_failed: '检查服务器证书；自签证书选 require。',
  busy: '稍后重试。',
  unknown: '原因见服务日志。',
}

export type CheckVerdict = 'passed' | 'notice' | 'blocked'

export const VERDICT_NAMES: Record<CheckVerdict, string> = {
  passed: '通过',
  notice: '提醒',
  blocked: '未通过',
}

export interface CheckRow {
  key: string
  label: string
  value: string
  verdict: CheckVerdict
  // 下一步怎么做，没有时不显示
  detail?: string
}

const BYPASS_DETAIL =
  '会绕过行级安全，空间之间的隔离不生效。改用 NOSUPERUSER NOBYPASSRLS 的普通角色。'
const EXTENSION_AVAILABLE = (name: string) =>
  `需要超级用户在这个库里执行 CREATE EXTENSION ${name}，或者改用「用超级用户创建」。`
const EXTENSION_MISSING =
  '需要 Kioku 的 PostgreSQL 镜像，或者在服务器上自行安装 pgvector 与 zhparser。'

// 检查结果逐项列出：连不上时只有连接一项
export function checkRows(check: DatabaseCheck): CheckRow[] {
  if (check.failure) {
    return [
      {
        key: 'connection',
        label: '连接',
        value: DATABASE_FAILURE_NAMES[check.failure],
        verdict: 'blocked',
        detail: FAILURE_HINTS[check.failure],
      },
    ]
  }
  const rows: CheckRow[] = [{ key: 'connection', label: '连接', value: '成功', verdict: 'passed' }]
  if (check.role) {
    const { name, superuser, bypassRls } = check.role
    rows.push({
      key: 'role',
      label: '角色',
      value: superuser ? `${name}（超级用户）` : bypassRls ? `${name}（带 BYPASSRLS）` : name,
      verdict: superuser || bypassRls ? 'blocked' : 'passed',
      ...(superuser || bypassRls ? { detail: BYPASS_DETAIL } : {}),
    })
  }
  for (const { name, state } of check.extensions) {
    const detail =
      state === 'available'
        ? EXTENSION_AVAILABLE(name)
        : state === 'missing'
          ? EXTENSION_MISSING
          : null
    rows.push({
      key: `extension-${name}`,
      label: `扩展 ${name}`,
      value: EXTENSION_STATE_NAMES[state],
      verdict: state === 'installed' ? 'passed' : 'blocked',
      ...(detail ? { detail } : {}),
    })
  }
  if (check.existing) rows.push(existingRow(check.existing, check.accounts))
  if (check.unrelatedTables > 0) {
    rows.push({
      key: 'unrelated',
      label: '其他表',
      value: `${check.unrelatedTables} 张`,
      verdict: 'notice',
      detail: '库里有不是 Kioku 建的表。建议给 Kioku 用专用的库。',
    })
  }
  return rows
}

function existingRow(
  existing: NonNullable<DatabaseCheck['existing']>,
  accounts: number | null,
): CheckRow {
  const base = { key: 'existing', label: '已有数据' }
  if (existing === 'pre_baseline') {
    return {
      ...base,
      value: EXISTING_DATA_NAMES.pre_baseline,
      verdict: 'blocked',
      detail: '这个版本不兼容旧数据：清空数据库重建后再接入，然后从 Lore 重新导入。',
    }
  }
  if (existing === 'newer') {
    return {
      ...base,
      value: EXISTING_DATA_NAMES.newer,
      verdict: 'blocked',
      detail: '用做这个库的版本启动。',
    }
  }
  if (existing === 'kioku' && accounts) {
    return {
      ...base,
      value: `${EXISTING_DATA_NAMES.kioku}（${accounts} 个账号）`,
      verdict: 'notice',
      detail: '将接入已有实例，接入后用已有账号登录。',
    }
  }
  return { ...base, value: EXISTING_DATA_NAMES[existing], verdict: 'passed' }
}

// 当前连接的属性列表：密码只说填没填
export function summaryFacts(
  summary: DatabaseSummary,
  source: DatabaseSource | null,
): Property[][] {
  return [
    [
      ...(source ? [{ key: 'source', label: '来源', value: DATABASE_SOURCE_NAMES[source] }] : []),
      { key: 'host', label: '主机', value: summary.host },
      { key: 'port', label: '端口', value: summary.port },
      { key: 'database', label: '库名', value: summary.database },
      { key: 'username', label: '用户名', value: summary.username },
      { key: 'password', label: '密码', value: summary.passwordSet ? '已填' : '未填' },
      { key: 'ssl', label: 'SSL', value: summary.ssl },
    ],
  ]
}

// 来自环境变量或 kioku.json 的连接改在哪里
export function lockedHint(source: DatabaseSource): string {
  return source === 'env'
    ? '修改环境变量 DATABASE_URL 后重启服务。'
    : '修改数据目录里的 kioku.json 后重启服务。'
}

// 接口报错：检查没过时带着检查结果，其余只有说明
export function setupFailure(
  err: unknown,
  fallback: string,
): { message: string; check: DatabaseCheck | null } {
  if (!(err instanceof ApiError)) return { message: fallback, check: null }
  const parsed = DatabaseSetupError.safeParse(err.payload)
  return { message: err.message, check: parsed.success ? (parsed.data.check ?? null) : null }
}
