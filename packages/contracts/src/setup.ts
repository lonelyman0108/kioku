import { z } from 'zod'

import { DisplayName, Password, Username } from './auth'

export const DATABASE_UNAVAILABLE_CODE = 'database_unavailable'
export const SETUP_CODE_INVALID = 'setup_code_invalid'
export const SETUP_CODE_LIMITED = 'setup_code_limited'

export const SetupCode = z
  .string()
  .trim()
  .min(1, '请填写初始化码')
  .max(256, '初始化码不超过 256 个字符')

export const DATABASE_SOURCES = ['env', 'file'] as const
export const DatabaseSource = z.enum(DATABASE_SOURCES)
export type DatabaseSource = z.infer<typeof DatabaseSource>

export const DATABASE_STATES = ['missing', 'unavailable', 'ready'] as const
export const DatabaseState = z.enum(DATABASE_STATES)
export type DatabaseState = z.infer<typeof DatabaseState>

export const DATABASE_SSL_MODES = ['disable', 'require', 'verify-full'] as const
export const DatabaseSslMode = z.enum(DATABASE_SSL_MODES)
export type DatabaseSslMode = z.infer<typeof DatabaseSslMode>

export const DATABASE_FAILURES = [
  'unreachable',
  'host_not_found',
  'timeout',
  'auth_failed',
  'not_allowed',
  'database_missing',
  'permission_denied',
  'ssl_unsupported',
  'ssl_failed',
  'busy',
  'unknown',
] as const
export const DatabaseFailure = z.enum(DATABASE_FAILURES)
export type DatabaseFailure = z.infer<typeof DatabaseFailure>

export const DATABASE_EXTENSIONS = ['vector', 'zhparser'] as const
export const DatabaseExtension = z.enum(DATABASE_EXTENSIONS)
export type DatabaseExtension = z.infer<typeof DatabaseExtension>

export const EXTENSION_STATES = ['installed', 'available', 'missing'] as const
export const ExtensionState = z.enum(EXTENSION_STATES)
export type ExtensionState = z.infer<typeof ExtensionState>

export const EXISTING_DATA = ['empty', 'migrated', 'kioku', 'pre_baseline', 'newer'] as const
export const ExistingData = z.enum(EXISTING_DATA)
export type ExistingData = z.infer<typeof ExistingData>

// 单人自托管不启用行级安全，连接检查只核对连通性、必需扩展、迁移基线与表权限
export const DATABASE_PROBLEMS = [
  'connection',
  'extension_not_installed',
  'extension_missing',
  'pre_baseline',
  'newer',
  'insufficient_privilege',
  'inspect_failed',
] as const
export const DatabaseProblemCode = z.enum(DATABASE_PROBLEMS)
export type DatabaseProblemCode = z.infer<typeof DatabaseProblemCode>

export const DatabaseProblem = z.object({
  code: DatabaseProblemCode,
  extension: DatabaseExtension.optional(),
})
export type DatabaseProblem = z.infer<typeof DatabaseProblem>

export const PROVISION_PROBLEMS = [
  'connection',
  'not_superuser',
  'role_exists',
  'database_exists',
  'extension_missing',
  'failed',
] as const
export const ProvisionProblem = z.enum(PROVISION_PROBLEMS)
export type ProvisionProblem = z.infer<typeof ProvisionProblem>

const Host = z
  .string()
  .trim()
  .min(1, '请填写主机')
  .max(255, '主机不超过 255 个字符')
  .regex(/^[A-Za-z0-9._%:-]+$/, '主机只能是主机名或 IP 地址')

export const DatabaseIdentifier = z
  .string()
  .trim()
  .regex(
    /^[a-z_][a-z0-9_]{0,62}$/,
    '只能包含小写字母、数字和下划线，以字母或下划线开头，最多 63 位',
  )

export const DatabaseConnection = z.object({
  host: Host,
  port: z.number().int().min(1, '端口在 1 到 65535 之间').max(65535, '端口在 1 到 65535 之间'),
  database: z.string().trim().min(1, '请填写库名').max(63, '库名不超过 63 个字符'),
  username: z.string().trim().min(1, '请填写用户名').max(128, '用户名不超过 128 个字符'),
  password: z.string().max(1024, '密码不超过 1024 个字符'),
  ssl: DatabaseSslMode,
})
export type DatabaseConnection = z.infer<typeof DatabaseConnection>

export const DatabaseSummary = z.object({
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  username: z.string(),
  passwordSet: z.boolean(),
  ssl: z.string(),
})
export type DatabaseSummary = z.infer<typeof DatabaseSummary>

export const DatabaseCheck = z.object({
  failure: DatabaseFailure.nullable(),
  role: z.object({ name: z.string(), superuser: z.boolean() }).nullable(),
  extensions: z.array(z.object({ name: DatabaseExtension, state: ExtensionState })),
  existing: ExistingData.nullable(),
  accounts: z.number().int().nullable(),
  unrelatedTables: z.number().int(),
  problems: z.array(DatabaseProblem),
  ready: z.boolean(),
})
export type DatabaseCheck = z.infer<typeof DatabaseCheck>

export const SetupStatusResponse = z.object({
  needsSetup: z.boolean(),
  database: z.object({
    state: DatabaseState,
    source: DatabaseSource.nullable(),
    failure: DatabaseFailure.nullable(),
    summary: DatabaseSummary.nullable(),
  }),
  masterKey: z.boolean(),
})
export type SetupStatusResponse = z.infer<typeof SetupStatusResponse>
export const SetupStatus = SetupStatusResponse
export type SetupStatus = SetupStatusResponse

// 首次初始化创建唯一管理员；spaceName 与 circleName 可选且忽略，兼容冒烟脚本与旧脚本调用
export const SetupRequest = z.object({
  setupCode: SetupCode,
  username: Username,
  displayName: DisplayName,
  password: Password,
  spaceName: z.string().max(64).optional(),
  circleName: z.string().max(64).optional(),
})
export type SetupRequest = z.infer<typeof SetupRequest>

export const SetupCodeRequest = z.object({ setupCode: SetupCode })
export type SetupCodeRequest = z.infer<typeof SetupCodeRequest>

export const SetupDatabaseCheckRequest = z.object({
  setupCode: SetupCode,
  connection: DatabaseConnection,
})
export type SetupDatabaseCheckRequest = z.infer<typeof SetupDatabaseCheckRequest>
export const DatabaseCheckRequest = SetupDatabaseCheckRequest
export type DatabaseCheckRequest = SetupDatabaseCheckRequest

export const SetupDatabaseCheckResponse = DatabaseCheck
export type SetupDatabaseCheckResponse = DatabaseCheck

export const SetupDatabaseApplyRequest = SetupDatabaseCheckRequest
export type SetupDatabaseApplyRequest = SetupDatabaseCheckRequest

export const DatabaseConnected = z.object({
  summary: DatabaseSummary,
  check: DatabaseCheck,
})
export type DatabaseConnected = z.infer<typeof DatabaseConnected>

export const SetupDatabaseProvisionRequest = z.object({
  setupCode: SetupCode,
  superuser: DatabaseConnection,
  role: DatabaseIdentifier,
  database: DatabaseIdentifier,
})
export type SetupDatabaseProvisionRequest = z.infer<typeof SetupDatabaseProvisionRequest>
export const DatabaseProvisionRequest = SetupDatabaseProvisionRequest
export type DatabaseProvisionRequest = SetupDatabaseProvisionRequest

export const DatabaseSetupError = z.object({
  error: z.string(),
  code: z.string().optional(),
  check: DatabaseCheck.optional(),
  failure: DatabaseFailure.optional(),
  problem: ProvisionProblem.optional(),
  extensions: z.array(DatabaseExtension).optional(),
})
export type DatabaseSetupError = z.infer<typeof DatabaseSetupError>

// ---- 数据库诊断中文文案 ----

export const DATABASE_FAILURE_NAMES: Record<DatabaseFailure, string> = {
  unreachable: '无法连接',
  host_not_found: '找不到主机',
  timeout: '连接超时',
  auth_failed: '认证失败',
  not_allowed: '服务器拒绝了此连接',
  database_missing: '库不存在',
  permission_denied: '无权连接此库',
  ssl_unsupported: '服务器不支持 SSL',
  ssl_failed: 'SSL 握手或证书校验失败',
  busy: '服务器繁忙或正在启动',
  unknown: '连接失败',
}

export const DATABASE_SOURCE_NAMES: Record<DatabaseSource, string> = {
  env: '环境变量 DATABASE_URL',
  file: '数据目录的 kioku.json',
}

export const EXTENSION_STATE_NAMES: Record<ExtensionState, string> = {
  installed: '已安装',
  available: '尚未安装',
  missing: '服务器上缺少',
}

export const EXISTING_DATA_NAMES: Record<ExistingData, string> = {
  empty: '空库',
  migrated: '空的 Kioku 库',
  kioku: '已有 Kioku 的数据',
  pre_baseline: '旧架构的库结构（不兼容当前版本）',
  newer: '更新的版本迁移过的结构',
}

export const PROVISION_PROBLEM_NAMES: Record<ProvisionProblem, string> = {
  connection: '超级用户无法连接',
  not_superuser: '该账号不是超级用户',
  role_exists: '角色已存在',
  database_exists: '库已存在',
  extension_missing: '服务器上缺少扩展',
  failed: '创建失败',
}

export const DATABASE_PROBLEM_NAMES: Record<DatabaseProblemCode, string> = {
  connection: '无法连接',
  extension_not_installed: '库里尚未安装扩展',
  extension_missing: '服务器上缺少扩展',
  pre_baseline: '库里是旧架构的结构，请清空或使用新库',
  newer: '库里有这个版本不认识的迁移',
  insufficient_privilege: '角色对库里已有的表没有权限',
  inspect_failed: '读取库的结构失败',
}

export function databaseProblemText(
  problem: DatabaseProblem,
  failure?: DatabaseFailure | null,
): string {
  if (problem.code === 'connection' && failure) return DATABASE_FAILURE_NAMES[failure]
  const name = DATABASE_PROBLEM_NAMES[problem.code]
  return problem.extension ? `${name} ${problem.extension}` : name
}
