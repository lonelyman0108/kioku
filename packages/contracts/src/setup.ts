import { z } from 'zod'

import { Password, Username } from './auth'

// 首次初始化：第一步接上数据库（没配 DATABASE_URL 时在初始化页填），第二步建第一个管理员。
// 两步都要带服务启动日志里的初始化码

export const SetupCode = z
  .string()
  .trim()
  .min(1, '请填写初始化码')
  .max(256, '初始化码不超过 256 个字符')

// 数据库从哪里来：环境变量 DATABASE_URL，或者数据目录里的 kioku.json（初始化页保存的）
export const DATABASE_SOURCES = ['env', 'file'] as const
export const DatabaseSource = z.enum(DATABASE_SOURCES)
export type DatabaseSource = z.infer<typeof DatabaseSource>

// missing：没有配置，只提供初始化；unavailable：配置了却暂时连不上，定时重试（不当作要初始化）；ready：已接上
export const DATABASE_STATES = ['missing', 'unavailable', 'ready'] as const
export const DatabaseState = z.enum(DATABASE_STATES)
export type DatabaseState = z.infer<typeof DatabaseState>

export const SetupRequest = z.object({
  setupCode: SetupCode,
  username: Username,
  displayName: z.string().min(1, '请填写显示名').max(64, '显示名不超过 64 个字符'),
  password: Password,
  spaceName: z.string().min(1, '请填写空间名').max(64, '空间名不超过 64 个字符'),
})
export type SetupRequest = z.infer<typeof SetupRequest>

// 连接的 SSL 模式，取 postgres.js 认得的几种。prefer（先试 SSL、不行再明文）不给：后台任务用的驱动不会退回明文
export const DATABASE_SSL_MODES = ['disable', 'require', 'verify-full'] as const
export const DatabaseSslMode = z.enum(DATABASE_SSL_MODES)
export type DatabaseSslMode = z.infer<typeof DatabaseSslMode>

// 主机名、IPv4 或 IPv6 地址。不收 / @ ? # , 这些会改变连接串结构的字符
const Host = z
  .string()
  .trim()
  .min(1, '请填写主机')
  .max(255, '主机不超过 255 个字符')
  .regex(/^[A-Za-z0-9._%:-]+$/, '主机只能是主机名或 IP 地址')

// 建角色、建库时用的名字：只收小写的普通标识符，写进语句时不用转义
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
  // 库名与用户名只收标识符字符：连接串里不用转义，两个驱动（postgres.js 与 pg-boss 的 node-postgres）解出来一样
  database: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,63}$/, '库名只能包含字母、数字和下划线，最多 63 位'),
  username: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,63}$/, '用户名只能包含字母、数字和下划线，最多 63 位'),
  password: z.string().max(1024, '密码不超过 1024 个字符'),
  ssl: DatabaseSslMode,
})
export type DatabaseConnection = z.infer<typeof DatabaseConnection>

// 给人看的连接信息：密码只说填没填。ssl 是连接串里写的模式，环境变量里可能是别的写法，所以不限取值
export const DatabaseSummary = z.object({
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  username: z.string(),
  passwordSet: z.boolean(),
  ssl: z.string(),
})
export type DatabaseSummary = z.infer<typeof DatabaseSummary>

// 连不上的原因，只写类别，不带驱动的说明与连接串
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

// installed：已在这个库里装好；available：服务器上有、库里没装（要超级用户 CREATE EXTENSION）；missing：服务器上没有
export const EXTENSION_STATES = ['installed', 'available', 'missing'] as const
export const ExtensionState = z.enum(EXTENSION_STATES)
export type ExtensionState = z.infer<typeof ExtensionState>

// 库里已有的东西：empty 是没有 Kioku 的表；kioku 是这个版本认得的结构；
// pre_baseline 是记忆架构改版之前的结构；newer 是更新的版本迁移过的
export const EXISTING_DATA = ['empty', 'kioku', 'pre_baseline', 'newer'] as const
export const ExistingData = z.enum(EXISTING_DATA)
export type ExistingData = z.infer<typeof ExistingData>

// 拦住接入的问题：连不上、角色绕过行级安全、库里没装或服务器上没有扩展、库的结构这个版本用不了。
// 检查只在 assess 里判断一次，服务端的日志与界面的检查行都按这份列表写
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
  // 扩展两类带上是哪个扩展
  extension: DatabaseExtension.optional(),
})
export type DatabaseProblem = z.infer<typeof DatabaseProblem>

export const DatabaseCheck = z.object({
  // 连不上时的类别，其余各项为空，problems 里只有 connection
  failure: DatabaseFailure.nullable(),
  role: z.object({ name: z.string(), superuser: z.boolean(), bypassRls: z.boolean() }).nullable(),
  extensions: z.array(z.object({ name: DatabaseExtension, state: ExtensionState })),
  existing: ExistingData.nullable(),
  // 已有 Kioku 的数据时的账号数：大于 0 时接入的是已有实例
  accounts: z.number().int().nullable(),
  // 不是 Kioku 建的表，只提醒，不拦
  unrelatedTables: z.number().int(),
  problems: z.array(DatabaseProblem),
  // problems 为空：可以保存并接入
  ready: z.boolean(),
})
export type DatabaseCheck = z.infer<typeof DatabaseCheck>

export const SetupStatus = z.object({
  // 没有任何账号、要建第一个管理员。数据库暂时连不上时为 false：不知道有没有账号，不当作要初始化
  needsSetup: z.boolean(),
  database: z.object({
    state: DatabaseState,
    source: DatabaseSource.nullable(),
    // 暂时连不上时最近一次检查的类别，其余状态为 null
    failure: DatabaseFailure.nullable(),
  }),
  // 是否配了 KIOKU_MASTER_KEY：没配时机密记忆、托管凭据等不可用
  masterKey: z.boolean(),
})
export type SetupStatus = z.infer<typeof SetupStatus>

// 当前的数据库：来自哪里、连接信息与检查结果。没有配置时三项都是 null
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

// 用超级用户代建：建应用角色（随机密码）和库，在新库里装好扩展，只保存应用角色的连接。
// superuser.database 是超级用户先连上的库（通常是 postgres）
export const DatabaseProvisionRequest = z.object({
  setupCode: SetupCode,
  superuser: DatabaseConnection,
  role: DatabaseIdentifier,
  database: DatabaseIdentifier,
})
export type DatabaseProvisionRequest = z.infer<typeof DatabaseProvisionRequest>

// 代建失败的原因：连不上（failure 里给类别）、不是超级用户、角色或库已存在、服务器上没有扩展
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

// 接入成功：保存的连接与检查结果
export const DatabaseConnected = z.object({ summary: DatabaseSummary, check: DatabaseCheck })
export type DatabaseConnected = z.infer<typeof DatabaseConnected>

// 检查没过、代建失败或接入失败时的错误体：error 是说明，另带检查结果或原因
export const DatabaseSetupError = z.object({
  error: z.string(),
  code: z.string().optional(),
  check: DatabaseCheck.optional(),
  failure: DatabaseFailure.optional(),
  problem: ProvisionProblem.optional(),
  extensions: z.array(DatabaseExtension).optional(),
})
export type DatabaseSetupError = z.infer<typeof DatabaseSetupError>

// 没接上数据库时，除初始化与健康检查之外的接口回 503，带这个 code，管理界面据此回初始化页
export const DATABASE_UNAVAILABLE_CODE = 'database_unavailable'
// 初始化码错误、失败次数过多
export const SETUP_CODE_INVALID = 'setup_code_invalid'
export const SETUP_CODE_LIMITED = 'setup_code_limited'
