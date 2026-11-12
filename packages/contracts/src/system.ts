import { z } from 'zod'

// 系统信息（只给实例管理员）：构建、运行环境、数据库、配置与后台任务，以及检查新版本

export const BuildInfo = z.object({
  // 正式版是 X.Y.Z；本地构建是 git describe 的结果，镜像构建没传版本时是 dev
  version: z.string(),
  // 完整的提交 sha，不知道时为 null
  commit: z.string().nullable(),
  builtAt: z.string().nullable(),
})
export type BuildInfo = z.infer<typeof BuildInfo>

export const RuntimeInfo = z.object({
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  osRelease: z.string(),
  // 在容器里（有 /.dockerenv、/run/.containerenv，或 cgroup 里看得出容器）
  container: z.boolean(),
  startedAt: z.string(),
  uptimeSeconds: z.number().int(),
})
export type RuntimeInfo = z.infer<typeof RuntimeInfo>

export const DatabaseInfo = z.object({
  version: z.string().nullable(),
  // 扩展的版本，没装时为 null
  pgvector: z.string().nullable(),
  zhparser: z.string().nullable(),
  // 最后一个执行过的迁移；库里的迁移这个版本不认识时是它的时间戳
  migration: z.string().nullable(),
  // 连接串里的库名与主机（不含用户名、密码）
  name: z.string().nullable(),
  host: z.string().nullable(),
})
export type DatabaseInfo = z.infer<typeof DatabaseInfo>

export const WEB_UI_STATES = ['served', 'missing', 'off'] as const

export const ConfigInfo = z.object({
  masterKey: z.object({
    configured: z.boolean(),
    // 当前主密钥的标识（哈希，推不出密钥）
    id: z.string().nullable(),
    // 配了旧主密钥，正在轮换
    rotating: z.boolean(),
  }),
  cookieSecure: z.boolean(),
  trustedProxies: z.number().int(),
  // 管理界面：served 找到了构建产物，missing 配了目录却没有产物，off 没有配置目录（只提供 API）
  webUi: z.enum(WEB_UI_STATES),
  // 后台任务队列在跑
  jobs: z.boolean(),
  embedding: z.boolean(),
  extraction: z.boolean(),
})
export type ConfigInfo = z.infer<typeof ConfigInfo>

// 有新的正式版
export const UpdateNotice = z.object({
  version: z.string(),
  url: z.string(),
})
export type UpdateNotice = z.infer<typeof UpdateNotice>

export const UpdateCheckSettings = z.object({ enabled: z.boolean() })
export type UpdateCheckSettings = z.infer<typeof UpdateCheckSettings>

export const UpdateCheckView = UpdateCheckSettings.extend({
  // 当前版本是正式版（X.Y.Z）：不是时不检查、不提示
  applicable: z.boolean(),
  // 上一次检查的时间；没检查过时为 null
  checkedAt: z.string().nullable(),
  // 上一次检查失败了（失败的原因只进服务端日志）
  failed: z.boolean(),
  // 上一次检查到的最新正式版；还没有正式版时为 null
  latest: z.string().nullable(),
  // 比当前版本新时给出
  available: UpdateNotice.nullable(),
})
export type UpdateCheckView = z.infer<typeof UpdateCheckView>

export const SystemInfo = z.object({
  build: BuildInfo,
  runtime: RuntimeInfo,
  database: DatabaseInfo,
  config: ConfigInfo,
  updates: UpdateCheckView,
  // 「复制诊断信息」复制的纯文本：不含库名、主机与主密钥标识
  diagnostics: z.string(),
})
export type SystemInfo = z.infer<typeof SystemInfo>
