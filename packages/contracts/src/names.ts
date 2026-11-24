import type { PersonMemoryMode, RuntimeFamily } from './auth'
import type { ActivityField, ActivityType } from './console'
import type {
  CredentialAccessReason,
  CredentialAccessResult,
  CredentialExpiry,
  PlaintextKind,
  VaultConnectionStatus,
  VaultDisabledReason,
  VaultErrorKind,
} from './credentials'
import type { DreamSuggestionKind } from './dream'
import type { BuiltinFacetKey, FacetMatchMode } from './facets'
import type { CircleKind, CredentialCapability, EntryKind, Sensitivity, StrataBand } from './memory'
import type { PiiKind, SensitiveKind } from './sensitive'
import type {
  DatabaseFailure,
  DatabaseProblem,
  DatabaseProblemCode,
  DatabaseSource,
  ExistingData,
  ExtensionState,
  ProvisionProblem,
} from './setup'

// 全局统一的中文术语表：管理界面与服务端错误文案共用同一套映射

export const CIRCLE_KIND_NAMES: Record<CircleKind, string> = {
  personal: '个人圈',
  shared: '独立圈',
}

export const ENTRY_KIND_NAMES: Record<EntryKind, string> = {
  entry: '正式记忆',
  fact: '联系人事实',
  episode: '会话摘要',
}

export const STRATA_BAND_NAMES: Record<StrataBand, string> = {
  episode: '会话摘要',
  fact: '联系人事实',
  personal: '个人圈记忆',
  'shared-away': '关联圈记忆',
  persona: '独立人格',
  primary: '主圈记忆',
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

export const PERSON_MEMORY_MODE_NAMES: Record<PersonMemoryMode, string> = {
  persona_shared: '跨群认人',
  strict: '按群隔离',
}

export const FACET_MATCH_MODE_NAMES: Record<FacetMatchMode, string> = {
  exclusive: '单选互斥',
  additive: '多选叠加',
}

export const BUILTIN_FACET_NAMES: Record<BuiltinFacetKey, string> = {
  realm: '场域',
  env: '环境与设备',
  runtime: '客户端',
  project: '项目仓库',
}

export const RUNTIME_FAMILY_NAMES: Record<RuntimeFamily, string> = {
  claudecode: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  agy: 'Antigravity',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  opencode: 'OpenCode',
  pi: 'Pi',
  dsh: 'DeepSeek Harness',
  astrbot: 'AstrBot',
  mcp: 'MCP',
  other: '其他客户端',
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

export const CREDENTIAL_ACCESS_REASON_NAMES: Record<CredentialAccessReason, string> = {
  capability: '凭据能力不足',
  scope: '读取范围不足',
  circle: '不在主圈范围',
  realm: '场域白名单不允许',
  context: '会话上下文不允许',
  client: '限定给了别的客户端',
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

export const CREDENTIAL_ROTATION_NAME = '需要轮换'
export const CREDENTIAL_HOSTED_NAME = 'Kioku 托管'

export const ACTIVITY_TYPE_NAMES: Record<ActivityType, string> = {
  create: '新建',
  import: '导入',
  sync: '同步',
  update: '修改',
  transfer_out: '迁出',
  transfer_in: '迁入',
  delete: '删除',
  restore: '恢复此版',
  undelete: '恢复',
  reactivate: '恢复生效',
  confirm: '确认来源',
  convert_credential: '转存为凭据',
  protect: '提高保护',
  redact: '抹除敏感段',
  ignore_plaintext: '忽略明文提示',
  unignore_plaintext: '取消忽略提示',
}

export const ACTIVITY_FIELD_NAMES: Record<ActivityField, string> = {
  content: '正文',
  title: '标题',
  variants: '变体',
  topics: '主题',
  disclosure: '召回说明',
  priority: '优先级',
  sensitivity: '敏感级',
  glossary: '关键词',
  validTo: '有效期',
}

export const DREAM_KIND_NAMES: Record<DreamSuggestionKind, string> = {
  merge: '合并重复记忆',
  merge_variants: '合并为多变体记忆',
  facet_tag: '补充适用条件',
  generalize: '共性记忆去条件上浮',
  distill: '事实提炼为正式记忆',
  distill_episode: '摘要沉淀重要事件',
  stale: '疑似过时失效',
  review: '待确认内容审核',
  promote: '高频记忆提权',
}

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
  provider_token: '第三方服务令牌',
  url_password: '网址内嵌密码',
  header_secret: '请求头凭据',
  wallet_key: '加密钱包私钥',
  seed_phrase: '钱包助记词',
  custom: '自定义规则命中',
}

export const PII_KIND_NAMES: Record<PiiKind, string> = {
  phone: '手机号',
  id_card: '身份证号',
  bank_card: '银行卡号',
  email: '电子邮箱',
  public_ip: '公网 IP 地址',
  mac: 'MAC 地址',
  ssn: '社会安全号 (SSN)',
  iban: '国际银行账号 (IBAN)',
  passport: '护照号',
  person: '个人姓名',
  address: '住址',
  account: '账号',
}

export const SENSITIVE_KIND_NAMES: Record<SensitiveKind, string> = {
  ...PLAINTEXT_KIND_NAMES,
  ...PII_KIND_NAMES,
}

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
  pre_baseline: '记忆圈重构之前的库结构',
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
  superuser: '角色是超级用户，会绕过行级安全',
  bypass_rls: '角色带 BYPASSRLS，会绕过行级安全',
  extension_not_installed: '库里尚未安装扩展',
  extension_missing: '服务器上缺少扩展',
  pre_baseline: '库里是记忆圈重构之前的结构',
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
