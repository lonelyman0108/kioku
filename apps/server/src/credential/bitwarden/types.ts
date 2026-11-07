// Bitwarden 兼容服务端（官方服务、Vaultwarden）的客户端接口。凭据服务只通过这里的类型用它，
// 实现在同目录的 client.ts。值只在 VaultItem.values 里出现：错误信息、日志都不带主密码、令牌、密钥与响应正文

// 两步验证只支持验证器应用（Bitwarden 的 0）。邮件验证码要另外请求发送，几种方式并存时服务端不会自动发，
// 所以不支持；只开了别的方式（邮件、WebAuthn、Duo、YubiKey）时报 unsupported_two_factor
export type VaultTwoFactorProvider = 'authenticator'

export interface VaultLoginInput {
  // 服务器地址，例如 https://vault.example.com，末尾不带 /
  serverUrl: string
  email: string
  masterPassword: string
  // Kioku 为这个连接生成的设备 id（uuid），重新登录沿用，密码库的设备列表里按它认出 Kioku
  deviceId: string
  twoFactor?: { provider: VaultTwoFactorProvider; code: string }
}

export interface VaultAccount {
  userId: string
  email: string
}

// 登录之后要加密保存的。userKey 是解开的账户密钥，64 字节：前 32 字节加密，后 32 字节 MAC
export interface VaultSecrets {
  refreshToken: string
  userKey: Buffer
}

export type VaultLoginResult =
  | { kind: 'ok'; secrets: VaultSecrets; account: VaultAccount }
  | { kind: 'two_factor_required'; providers: VaultTwoFactorProvider[] }

// 组织里的角色。所有者与管理员看得到全部集合，凭据服务据此拒绝连接
export type VaultOrganizationRole = 'owner' | 'admin' | 'manager' | 'user' | 'custom'

export type VaultItemType = 'login' | 'note' | 'card' | 'identity' | 'ssh_key'

// 条目里的一个字段：login.username、login.password、login.totp、notes，自定义字段写成 field:<名字>
export type VaultFieldRef = string

// 条目的概况：名称与字段名解开，值不解开
export interface VaultItemSummary {
  id: string
  organizationId: string
  collectionIds: string[]
  name: string
  type: VaultItemType
  // 有值的字段
  fields: VaultFieldRef[]
  revisionDate: string
}

// 这个账号看得到什么：凭据服务用它检查个人条目与组织角色、列出条目。回收站里的不算
export interface VaultSnapshot {
  account: VaultAccount
  // allCollections：看得到组织里全部的集合（所有者、管理员，或开了「访问全部集合」的成员）
  organizations: {
    id: string
    name: string
    role: VaultOrganizationRole
    allCollections: boolean
  }[]
  collections: { id: string; organizationId: string; name: string }[]
  // 不属于组织的条目数
  personalItemCount: number
  // 只含组织里解得开的条目
  items: VaultItemSummary[]
  // 组织里解不开的条目数（格式不认识或校验不过），这些条目跳过不列
  unreadableItemCount: number
}

export interface VaultItem extends VaultItemSummary {
  // 解开的值。login.totp 是条目里的密钥（otpauth:// 地址或 base32），验证码由 totpCode 现算
  values: Record<VaultFieldRef, string>
}

export interface VaultSessionInput {
  serverUrl: string
  deviceId: string
  secrets: VaultSecrets
  // 服务端换了新的刷新令牌时调用，调用方把新的加密保存；会话自己接着用新的。保存失败时，下次换令牌再调用
  onSecretsChanged?: (secrets: VaultSecrets) => Promise<void>
  // 每次同步之后都把结果交给它：换到新的访问令牌之后、取条目遇到没见过的组织而重新同步之后，以及 snapshot()。
  // 它抛错时这次调用以同样的错误失败，这次同步的结果不用。凭据服务在这里检查个人条目与组织角色
  onSynced?: (snapshot: VaultSnapshot) => Promise<void>
}

// 一个连接的会话：访问令牌与组织密钥缓存在内存里，过期了用刷新令牌换；同时发起的几次调用只换一次
export interface VaultSession {
  snapshot(): Promise<VaultSnapshot>
  // 按 id 取一个条目并解开。不存在、被删、移出集合或看不到时抛 item_unavailable
  item(id: string): Promise<VaultItem>
  // 同步一次（照样交给 onSynced），解开所有读得到的组织条目的值：按值比对时用。解不开的条目跳过，
  // 个数照 VaultSnapshot.unreadableItemCount 算
  items(): Promise<VaultItem[]>
}

export interface VaultClient {
  login(input: VaultLoginInput): Promise<VaultLoginResult>
  session(input: VaultSessionInput): VaultSession
}

export type VaultErrorKind =
  // 邮箱或主密码不对
  | 'invalid_credentials'
  // 两步验证码不对或过期
  | 'two_factor_invalid'
  | 'unsupported_two_factor'
  // 刷新令牌失效：改了主密码、在设备列表里注销了 Kioku
  | 'reauth_required'
  | 'item_unavailable'
  // 不认识的加密格式或 KDF
  | 'unsupported_format'
  // MAC 校验失败
  | 'integrity'
  // 连不上、超时
  | 'unreachable'
  // 意外的状态码、重定向或响应格式
  | 'server_error'

export class VaultError extends Error {
  constructor(
    readonly kind: VaultErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'VaultError'
  }
}
