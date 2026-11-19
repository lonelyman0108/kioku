import { z } from 'zod'

// 旧版就地升级：库是记忆圈重构之前的结构时，管理员在升级页用旧实例的管理员账号确认身份，
// 先预览（整套迁移跑完再回滚）再执行。旧对象移进 LEGACY_SCHEMA 保留，不删
export const LEGACY_SCHEMA = 'kioku_legacy'

// 带升级前的访问密钥来请求：401 带这个码，客户端据此提示重新接入
export const LEGACY_KEY_CODE = 'legacy_key'
export const LEGACY_ADMIN_INVALID = 'legacy_admin_invalid'
export const LEGACY_ADMIN_LIMITED = 'legacy_admin_limited'

export const LegacyUpgradeRequest = z.object({
  username: z.string().trim().toLowerCase().min(1, '请填写用户名').max(64),
  password: z.string().min(1, '请填写密码').max(256),
})
export type LegacyUpgradeRequest = z.infer<typeof LegacyUpgradeRequest>

export const LegacyUpgradeStatus = z.object({
  // 当前还是不是待迁移的状态；迁移完成、切换到完整服务后这个接口就不在了
  pending: z.boolean(),
  masterKey: z.boolean(),
})
export type LegacyUpgradeStatus = z.infer<typeof LegacyUpgradeStatus>

export const LegacyUpgradeSummary = z.object({
  accounts: z.number().int(),
  sharedCircles: z.array(z.object({ name: z.string(), memberCount: z.number().int() })),
  personas: z.number().int(),
  personaTraits: z.number().int(),
  clients: z.number().int(),
  groupRules: z.number().int(),
  subjects: z.number().int(),
  conversations: z.number().int(),
  vaultConnections: z.number().int(),
  credentials: z.number().int(),
  entries: z.object({
    entry: z.number().int(),
    fact: z.number().int(),
    episode: z.number().int(),
    secret: z.number().int(),
  }),
  legacyUris: z.number().int(),
  settings: z.number().int(),
  legacyKeys: z.number().int(),
  skippedDeletedMemories: z.number().int(),
  skippedDeletedCredentials: z.number().int(),
  warnings: z.array(z.string()),
})
export type LegacyUpgradeSummary = z.infer<typeof LegacyUpgradeSummary>

export const LegacyUpgradeResult = z.object({
  applied: z.boolean(),
  summary: LegacyUpgradeSummary,
})
export type LegacyUpgradeResult = z.infer<typeof LegacyUpgradeResult>
