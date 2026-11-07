import type {
  CredentialAccessReason,
  CredentialAccessResult,
  CredentialExpiry,
  PlaintextKind,
  VaultConnectionStatus,
  VaultDisabledReason,
  VaultErrorKind,
} from './credentials'
import type { CredentialCapability, Layer, Sensitivity } from './memory'

// 归属、敏感级、凭据能力、密码库连接状态与错误、凭据的到期与轮换、疑似明文类别的中文名，管理界面和服务端的错误信息共用一份，用词才不会分叉。
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

// 和密码库通信失败的类别：连接的最近错误，也是写回失败（新建、修改条目）时给调用方的说法。
// read_only、item_conflict 与 value_too_long 只在写回时出现：前两种服务端回 409，item_conflict 要先重新读取凭据再改；
// value_too_long 回 400，可以改成托管或缩短值。
// read_only 也用在集合不在同步结果里、组织密钥解不开时，所以说法两种情况都读得通
export const VAULT_ERROR_KIND_NAMES: Record<VaultErrorKind, string> = {
  invalid_credentials: '邮箱或主密码错误',
  two_factor_invalid: '验证码错误',
  unsupported_two_factor: '不支持此两步验证方式',
  reauth_required: '登录已失效',
  item_unavailable: '条目不可用',
  read_only: '集合只读或不可用',
  item_conflict: '条目已在别处修改',
  value_too_long: '值超出密码库的长度上限',
  unsupported_format: '无法识别的加密格式',
  integrity: '内容校验失败',
  unreachable: '无法连接服务器',
  server_error: '服务器返回错误',
}

export const CREDENTIAL_EXPIRY_NAMES: Record<CredentialExpiry, string> = {
  expiring: '快到期',
  expired: '已到期',
}

// 凭据上「需要轮换」的标记，待处理与凭据详情共用
export const CREDENTIAL_ROTATION_NAME = '需要轮换'

// 新建凭据时值写到了哪里（CredentialStoredIn）：托管写「Kioku 托管」，密码库写集合的名称
export const CREDENTIAL_HOSTED_NAME = 'Kioku 托管'

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
