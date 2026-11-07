import type {
  CredentialAccessReason,
  CredentialAccessResult,
  VaultConnectionStatus,
  VaultDisabledReason,
} from './credentials'
import type { CredentialCapability, Layer, Sensitivity } from './memory'

// 归属、敏感级、凭据能力与密码库连接状态的中文名，管理界面和服务端的错误信息共用一份，用词才不会分叉。
// 契约只放 zod schema，这里是例外，和 bench.ts 的 isReplayStep、mayWrite 一样
export const LAYER_NAMES: Record<Layer, string> = {
  core: '通用',
  persona: '人格',
  app: '应用',
  user: '本人',
  subject: '联系人',
  episode: '会话',
}

export const SENSITIVITY_NAMES: Record<Sensitivity, string> = {
  public: '公开',
  internal: '内部',
  private: '私密',
  secret: '机密',
}

export const CREDENTIAL_CAPABILITY_NAMES: Record<CredentialCapability, string> = {
  none: '不可用',
  use: '取用',
  manage: '管理',
}

export const VAULT_CONNECTION_STATUS_NAMES: Record<VaultConnectionStatus, string> = {
  ok: '可用',
  reauth_required: '需要重新登录',
  disabled: '已停用',
  disconnected: '已断开',
}

export const VAULT_DISABLED_REASON_NAMES: Record<VaultDisabledReason, string> = {
  personal_items: '有个人条目',
  organization_role: '组织里可访问全部集合',
}

export const CREDENTIAL_ACCESS_RESULT_NAMES: Record<CredentialAccessResult, string> = {
  ok: '成功',
  denied: '被拒',
  failed: '失败',
}

// 访问记录里的原因，也是取不到值时给调用方的说法
export const CREDENTIAL_ACCESS_REASON_NAMES: Record<CredentialAccessReason, string> = {
  capability: '凭据能力不足',
  scope: '读取范围不足',
  context: '会话上下文不允许',
  app: '限定给了别的应用',
  item_unavailable: '条目不可用',
  field_missing: '条目里没有这个字段',
  reauth_required: '需要重新登录',
  disabled: '连接已停用',
  disconnected: '连接已断开',
  unreachable: '密码库无法连接',
  vault_error: '密码库返回的内容无法解开',
  master_key: '主密钥不可用',
}
