import type {
  CredentialAccessReason,
  CredentialAccessResult,
  PlaintextKind,
  VaultConnectionStatus,
  VaultDisabledReason,
} from './credentials'
import type { CredentialCapability, Layer, Sensitivity } from './memory'

// 归属、敏感级、凭据能力、密码库连接状态与疑似明文类别的中文名，管理界面和服务端的错误信息共用一份，用词才不会分叉。
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
  internal_error: 'Kioku 内部出错',
}

// 疑似明文的类别：写入被拒时的说明与管理界面逐处处理时用
export const PLAINTEXT_KIND_NAMES: Record<PlaintextKind, string> = {
  label: '标注的密码或令牌',
  sk: 'sk- 开头的密钥',
  github: 'GitHub 令牌',
  gitlab: 'GitLab 令牌',
  slack: 'Slack 令牌',
  aws: 'AWS 密钥 ID',
  jwt: 'JWT',
  private_key: '私钥',
  kioku: 'Kioku 访问密钥',
}
