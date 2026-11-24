import { z } from 'zod'

import { Password, Username } from './auth'

export const SetupCode = z
  .string()
  .trim()
  .min(1, '请填写初始化码')
  .max(256, '初始化码不超过 256 个字符')

export const DATABASE_SOURCES = ['env', 'file'] as const
export const DatabaseSource = z.enum(DATABASE_SOURCES)
export type DatabaseSource = z.infer<typeof DatabaseSource>

// legacy：库是记忆圈重构之前的结构，等管理员在升级页就地迁移
export const DATABASE_STATES = ['missing', 'unavailable', 'legacy', 'ready'] as const
export const DatabaseState = z.enum(DATABASE_STATES)
export type DatabaseState = z.infer<typeof DatabaseState>

// 初始化建第一个管理员：默认创建其唯一个人圈，填写 circleName 时再同步创建一个共享圈
export const SetupRequest = z.object({
  setupCode: SetupCode,
  username: Username,
  displayName: z.string().min(1, '请填写显示名').max(64, '显示名不超过 64 个字符'),
  password: Password,
  circleName: z
    .string()
    .trim()
    .min(1, '请填写共享记忆圈名称')
    .max(64, '记忆圈名称不超过 64 个字符')
    .optional(),
})
export type SetupRequest = z.infer<typeof SetupRequest>

export const DATABASE_SSL_MODES = ['disable', 'require', 'verify-full'] as const
export const DatabaseSslMode = z.enum(DATABASE_SSL_MODES)
export type DatabaseSslMode = z.infer<typeof DatabaseSslMode>

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

export const DATABASE_PROBLEMS = [
  'connection',
  'superuser',
  'bypass_rls',
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

export const DatabaseCheck = z.object({
  failure: DatabaseFailure.nullable(),
  role: z
    .object({ name: z.string(), superuser: booleanSchema(), bypassRls: booleanSchema() })
    .nullable(),
  extensions: z.array(z.object({ name: DatabaseExtension, state: ExtensionState })),
  existing: ExistingData.nullable(),
  accounts: z.number().int().nullable(),
  circles: z.number().int().nullable(),
  unrelatedTables: z.number().int(),
  problems: z.array(DatabaseProblem),
  ready: z.boolean(),
})
export type DatabaseCheck = z.infer<typeof DatabaseCheck>

function booleanSchema() {
  return z.boolean()
}

export const SetupStatus = z.object({
  needsSetup: z.boolean(),
  database: z.object({
    state: DatabaseState,
    source: DatabaseSource.nullable(),
    failure: DatabaseFailure.nullable(),
  }),
  masterKey: z.boolean(),
})
export type SetupStatus = z.infer<typeof SetupStatus>

export const DatabaseInspection = z.object({
  source: DatabaseSource.nullable(),
  state: DatabaseState,
  summary: DatabaseSummary.nullable(),
  check: DatabaseCheck.nullable(),
})
export type DatabaseInspection = z.infer<typeof DatabaseInspection>

export const SetupCodeRequest = z.object({ setupCode: SetupCode })
export type SetupCodeRequest = z.infer<typeof SetupCodeRequest>

export const DatabaseCheckRequest = z.object({
  setupCode: SetupCode,
  connection: DatabaseConnection,
})
export type DatabaseCheckRequest = z.infer<typeof DatabaseCheckRequest>

export const DatabaseProvisionRequest = z.object({
  setupCode: SetupCode,
  superuser: DatabaseConnection,
  role: DatabaseIdentifier,
  database: DatabaseIdentifier,
})
export type DatabaseProvisionRequest = z.infer<typeof DatabaseProvisionRequest>

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

export const DatabaseConnected = z.object({ summary: DatabaseSummary, check: DatabaseCheck })
export type DatabaseConnected = z.infer<typeof DatabaseConnected>

export const DatabaseSetupError = z.object({
  error: z.string(),
  code: z.string().optional(),
  check: DatabaseCheck.optional(),
  failure: DatabaseFailure.optional(),
  problem: ProvisionProblem.optional(),
  extensions: z.array(DatabaseExtension).optional(),
})
export type DatabaseSetupError = z.infer<typeof DatabaseSetupError>

export const DATABASE_UNAVAILABLE_CODE = 'database_unavailable'
// 库是重构之前的结构、还没迁移：除健康检查与升级接口外的 /v1 都回 503 带这个码
export const LEGACY_DATABASE_CODE = 'legacy_database'
export const SETUP_CODE_INVALID = 'setup_code_invalid'
export const SETUP_CODE_LIMITED = 'setup_code_limited'
