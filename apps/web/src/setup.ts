import {
  DATABASE_FAILURE_NAMES,
  DATABASE_PROBLEM_NAMES,
  DATABASE_SOURCE_NAMES,
  DatabaseSetupError,
  EXISTING_DATA_NAMES,
  EXTENSION_STATE_NAMES,
  type DatabaseCheck,
  type DatabaseFailure,
  type DatabaseProblem,
  type DatabaseProblemCode,
  type DatabaseSource,
  type DatabaseSslMode,
  type DatabaseSummary,
} from '@kioku/contracts'

import { ApiError } from './api/client'
import type { Property } from './components/ui/PropertyList.vue'

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
  detail?: string
}

const PROBLEM_HINTS: Record<
  Exclude<DatabaseProblemCode, 'connection'>,
  (p: DatabaseProblem) => string
> = {
  extension_not_installed: (p) =>
    `需要超级用户在这个库里执行 CREATE EXTENSION ${p.extension ?? ''}，或者改用「用超级用户创建」。`,
  extension_missing: () =>
    '需要 Kioku 的 PostgreSQL 镜像，或者在服务器上自行安装 pgvector 与 zhparser。',
  pre_baseline: () => '当前版本不兼容旧架构的库结构，请清空或改用空库后再接入。',
  newer: () => '请使用匹配该库迁移版本的服务端启动。',
  insufficient_privilege: () =>
    '库里已有别的角色建的表，当前角色无权读取。改用这些表的所有者连接，或者换一个专用的库。',
  inspect_failed: () => '原因见服务日志。',
}

function existingRow(check: DatabaseCheck): Pick<CheckRow, 'value' | 'verdict' | 'detail'> {
  if (check.existing === 'kioku' && check.accounts) {
    return {
      value: `${EXISTING_DATA_NAMES.kioku}（${check.accounts} 个账号）`,
      verdict: 'notice',
      detail: '将接入已有实例，接入后用已有账号登录。',
    }
  }
  return { value: EXISTING_DATA_NAMES[check.existing!], verdict: 'passed' }
}

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
  const problem = (match: (p: DatabaseProblem) => boolean) => check.problems.find(match)
  const verdictOf = (found: DatabaseProblem | undefined) =>
    found
      ? {
          verdict: 'blocked' as const,
          detail: PROBLEM_HINTS[found.code as keyof typeof PROBLEM_HINTS](found),
        }
      : { verdict: 'passed' as const }

  const rows: CheckRow[] = [{ key: 'connection', label: '连接', value: '成功', verdict: 'passed' }]
  if (check.role) {
    rows.push({
      key: 'role',
      label: '角色',
      value: check.role.name,
      verdict: 'passed',
    })
  }
  for (const { name, state } of check.extensions) {
    rows.push({
      key: `extension-${name}`,
      label: `扩展 ${name}`,
      value: EXTENSION_STATE_NAMES[state],
      ...verdictOf(problem((p) => p.extension === name)),
    })
  }
  if (check.existing) {
    const found = problem((p) => p.code === 'pre_baseline' || p.code === 'newer')
    rows.push({
      key: 'existing',
      label: '已有数据',
      ...(found
        ? { value: EXISTING_DATA_NAMES[check.existing], ...verdictOf(found) }
        : existingRow(check)),
    })
  }
  const access = problem((p) => p.code === 'insufficient_privilege' || p.code === 'inspect_failed')
  if (access) {
    rows.push({
      key: 'access',
      label: '读取库',
      value: DATABASE_PROBLEM_NAMES[access.code],
      ...verdictOf(access),
    })
  }
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

export function lockedHint(source: DatabaseSource): string {
  return source === 'env'
    ? '修改环境变量 DATABASE_URL 后重启服务。'
    : '修改数据目录里的 kioku.json 后重启服务。'
}

export function setupFailure(
  err: unknown,
  fallback: string,
): { message: string; check: DatabaseCheck | null } {
  if (!(err instanceof ApiError)) return { message: fallback, check: null }
  const parsed = DatabaseSetupError.safeParse(err.payload)
  return { message: err.message, check: parsed.success ? (parsed.data.check ?? null) : null }
}
