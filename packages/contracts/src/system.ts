import { z } from 'zod'

// 系统信息（只给实例管理员）：构建、运行环境、数据库、配置与后台任务，以及检查新版本。
// 后面几个函数与说法是「只放 zod 与类型」的例外：页面上显示的和服务端拼的诊断信息用同一份

export const BuildInfo = z.object({
  // 正式版是 X.Y.Z；本地构建是 git describe 的结果，镜像构建没传版本时是 dev
  version: z.string(),
  // 完整的提交 sha，不知道时为 null
  commit: z.string().nullable(),
  builtAt: z.string().nullable(),
})
export type BuildInfo = z.infer<typeof BuildInfo>

// 在不在容器里；判断不了时为 unknown
export const CONTAINER_STATES = ['yes', 'no', 'unknown'] as const
export type ContainerState = (typeof CONTAINER_STATES)[number]

export const RuntimeInfo = z.object({
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  osRelease: z.string(),
  container: z.enum(CONTAINER_STATES),
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
export type WebUiState = (typeof WEB_UI_STATES)[number]

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
  // 正在向 GitHub 请求：界面过一会儿再取一次
  checking: z.boolean(),
  // 上一次检查完成的时间；没完成过时为 null
  checkedAt: z.string().nullable(),
  // 上一次尝试的时间（不管成没成）
  attemptedAt: z.string().nullable(),
  // 上一次尝试失败了，或者没有完成（例如请求期间服务停了）。原因只进服务端日志
  failed: z.boolean(),
  // 已知的最新正式版；从未查到过正式版时为 null
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

// ---- 共用的判定与说法 ----

// 提交的 sha（短的或完整的）
export const COMMIT_SHA = /^[0-9a-f]{7,40}$/i

// 正式版的版本号：X.Y.Z，前面可以带 v。别的（dev、edge、git describe 的结果、预发布）为 null
export function releaseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

// latest 比 current 新。两边有一个不是正式版就不算
export function isNewerRelease(latest: string, current: string): boolean {
  const a = releaseVersion(latest)
  const b = releaseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

// 给人看的版本：正式版前面加 v，别的原样
export const versionLabel = (version: string) => {
  const release = releaseVersion(version)
  return release ? `v${release.join('.')}` : version
}

// 已运行多久：天、小时、分钟，最多两级
export function uptimeText(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days) return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`
  if (hours) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`
  return minutes ? `${minutes} 分钟` : '不到 1 分钟'
}

export const CONTAINER_NAMES: Record<ContainerState, string> = {
  yes: '是',
  no: '否',
  unknown: '无法判断',
}

export const WEB_UI_NAMES: Record<WebUiState, string> = {
  served: '已托管',
  missing: '未找到构建产物',
  off: '未配置目录',
}

export const configuredText = (value: boolean) => (value ? '已配置' : '未配置')
export const jobsText = (running: boolean) => (running ? '运行中' : '未运行')
export const cookieText = (secure: boolean) => (secure ? '仅 HTTPS' : '允许 HTTP')
export const trustedProxiesText = (count: number) => (count ? String(count) : '无')
export const masterKeyText = (key: ConfigInfo['masterKey']) =>
  key.configured ? (key.rotating ? '已配置，轮换中' : '已配置') : '未配置'
export const systemText = (r: Pick<RuntimeInfo, 'platform' | 'osRelease' | 'arch'>) =>
  `${r.platform} ${r.osRelease}（${r.arch}）`
export const extensionText = (version: string | null) => version ?? '未安装'
