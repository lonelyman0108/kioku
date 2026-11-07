import {
  decryptBytes,
  deriveMasterKey,
  kdfParams,
  masterPasswordHash,
  normalizeEmail,
  splitKey,
  stretchMasterKey,
  type SymmetricKey,
} from './crypto'
import {
  badResponse,
  prop,
  requireStr,
  str,
  unexpectedStatus,
  vaultEndpoints,
  vaultRequest,
  type HttpOptions,
  type VaultEndpoints,
} from './http'
import {
  VaultError,
  type VaultAccount,
  type VaultClient,
  type VaultItem,
  type VaultLoginInput,
  type VaultLoginResult,
  type VaultSecrets,
  type VaultSession,
  type VaultSessionInput,
  type VaultSnapshot,
  type VaultTwoFactorProvider,
} from './types'
import { decodeItem, decodeSync, type SyncedState } from './vault'

export { totpCode } from './totp'

export interface VaultClientOptions {
  fetch?: typeof fetch
  // 毫秒时间戳，判断访问令牌是否过期
  now?: () => number
  // 每个请求的时限，含读完正文
  timeoutMs?: number
}

// 身份服务认的客户端：client_id 与设备类型照官方命令行（LinuxCLI），设备名写 Kioku
const CLIENT_ID = 'cli'
const DEVICE_TYPE = '25'
const DEVICE_NAME = 'Kioku'
const SCOPE = 'api offline_access'

// 访问令牌提前这么久当作过期，免得请求发出去时刚好过期
const EXPIRY_MARGIN_MS = 60_000

const TWO_FACTOR: Record<string, VaultTwoFactorProvider> = { '0': 'authenticator', '1': 'email' }

const formBody = (fields: Record<string, string>) => new URLSearchParams(fields).toString()

const FORM = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }

// 访问令牌是 JWT，账号的 id 与邮箱取它的载荷；只用来认账号，不校验签名（令牌是刚从身份服务换来的）
function accountOf(accessToken: string): VaultAccount {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as unknown
    return { userId: requireStr(payload, 'sub'), email: requireStr(payload, 'email') }
  } catch {
    throw badResponse()
  }
}

// 400 的令牌响应里要求两步验证时带着可用的方式：TwoFactorProviders2 的键，或者 TwoFactorProviders 的数组
function twoFactorProviders(json: unknown): string[] | null {
  const map = prop(json, 'twoFactorProviders2')
  if (map && typeof map === 'object') return Object.keys(map)
  const arr = prop(json, 'twoFactorProviders')
  if (Array.isArray(arr)) return arr.map(String)
  return null
}

interface TokenGrant {
  accessToken: string
  expiresAt: number
  refreshToken: string | undefined
}

function tokenGrant(json: unknown, now: number): TokenGrant {
  const accessToken = requireStr(json, 'access_token')
  const expiresIn = prop(json, 'expires_in')
  const seconds = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600
  return {
    accessToken,
    expiresAt: now + seconds * 1000,
    refreshToken: str(json, 'refresh_token'),
  }
}

export function createVaultClient(options: VaultClientOptions = {}): VaultClient {
  const http: HttpOptions = {
    fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    timeoutMs: options.timeoutMs ?? 10_000,
  }
  const now = options.now ?? Date.now

  async function login(input: VaultLoginInput): Promise<VaultLoginResult> {
    const endpoints = vaultEndpoints(input.serverUrl)
    const email = normalizeEmail(input.email)

    const pre = await vaultRequest(http, `${endpoints.identity}/accounts/prelogin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    if (pre.status !== 200) throw unexpectedStatus(pre.status)
    const settings = prop(pre.json, 'kdfSettings')
    const kdfType = prop(pre.json, 'kdf') ?? prop(settings, 'kdfType')
    if (kdfType === undefined) throw badResponse()
    const kdf = kdfParams({
      kdf: kdfType,
      iterations: prop(pre.json, 'kdfIterations') ?? prop(settings, 'iterations'),
      memory: prop(pre.json, 'kdfMemory') ?? prop(settings, 'memory'),
      parallelism: prop(pre.json, 'kdfParallelism') ?? prop(settings, 'parallelism'),
    })
    // 新版服务端在预登录里给出盐；没有时盐就是规范化的邮箱
    const salt = str(pre.json, 'salt') || email

    // 主密钥只活在这个函数里：派生出密码哈希与拉伸密钥后就不再引用
    let stretched: SymmetricKey
    let passwordHash: string
    {
      const masterKey = await deriveMasterKey(input.masterPassword, salt, kdf)
      passwordHash = await masterPasswordHash(masterKey, input.masterPassword)
      stretched = stretchMasterKey(masterKey)
      masterKey.fill(0)
    }

    const fields: Record<string, string> = {
      grant_type: 'password',
      username: email,
      password: passwordHash,
      scope: SCOPE,
      client_id: CLIENT_ID,
      deviceType: DEVICE_TYPE,
      deviceIdentifier: input.deviceId,
      deviceName: DEVICE_NAME,
    }
    if (input.twoFactor) {
      fields.twoFactorToken = input.twoFactor.code.replace(/\s/g, '')
      fields.twoFactorProvider = input.twoFactor.provider === 'authenticator' ? '0' : '1'
      fields.twoFactorRemember = '0'
    }
    const res = await vaultRequest(http, `${endpoints.identity}/connect/token`, {
      method: 'POST',
      headers: { ...FORM, 'auth-email': Buffer.from(email).toString('base64url') },
      body: formBody(fields),
    })

    if (res.status === 400 || res.status === 401) {
      const providers = twoFactorProviders(res.json)
      if (providers) {
        if (input.twoFactor) throw new VaultError('two_factor_invalid', '两步验证码不正确或已过期')
        const supported = providers.flatMap((p) => (TWO_FACTOR[p] ? [TWO_FACTOR[p]] : []))
        if (supported.length === 0) {
          throw new VaultError('unsupported_two_factor', '密码库要求的两步验证方式不受支持')
        }
        return { kind: 'two_factor_required', providers: supported }
      }
      // 官方服务对没开两步验证的账号在新设备上另要邮件里的验证码（新设备验证），这里不支持
      if (/new device/i.test(`${str(res.json, 'error_description')} ${str(res.json, 'message')}`)) {
        throw new VaultError(
          'unsupported_two_factor',
          '密码库要求新设备验证，请为这个账号开启两步验证',
        )
      }
      // 其余的 400 都是凭据不对：官方服务回 invalid_grant，Vaultwarden 的 error 是空的、只在 message 里说明。
      // 带着验证码时主密码已经在上一步验过，验证码不对 Vaultwarden 也不再带 TwoFactorProviders
      if (res.status === 400) {
        if (input.twoFactor) throw new VaultError('two_factor_invalid', '两步验证码不正确或已过期')
        throw new VaultError('invalid_credentials', '邮箱或主密码不正确')
      }
      throw unexpectedStatus(res.status)
    }
    if (res.status !== 200) throw unexpectedStatus(res.status)

    const grant = tokenGrant(res.json, now())
    if (!grant.refreshToken) throw badResponse()
    const encUserKey = str(res.json, 'key')
    if (!encUserKey) throw badResponse()
    const userKey = decryptBytes(encUserKey, stretched)
    stretched.encKey.fill(0)
    stretched.macKey.fill(0)
    // 账户密钥必须是 64 字节（加密、MAC 各一半），旧格式的 32 字节报 unsupported_format
    splitKey(userKey)
    return {
      kind: 'ok',
      secrets: { refreshToken: grant.refreshToken, userKey },
      account: accountOf(grant.accessToken),
    }
  }

  function session(input: VaultSessionInput): VaultSession {
    return new Session(http, now, input)
  }

  return { login, session }
}

const reauth = () => new VaultError('reauth_required', '密码库的登录已失效，需要重新登录')

interface Access {
  token: string
  expiresAt: number
  // 最近一次同步的结果，再同步时换掉
  state: SyncedState
}

class Session implements VaultSession {
  private secrets: VaultSecrets
  private readonly endpoints: VaultEndpoints
  private readonly userKey: SymmetricKey
  private access: Access | null = null
  // 正在进行的换令牌与同步：同时发起的调用共用这一次
  private pending: Promise<Access> | null = null

  constructor(
    private readonly http: HttpOptions,
    private readonly now: () => number,
    private readonly input: VaultSessionInput,
  ) {
    this.secrets = input.secrets
    this.endpoints = vaultEndpoints(input.serverUrl)
    this.userKey = splitKey(Buffer.from(input.secrets.userKey))
  }

  async snapshot(): Promise<VaultSnapshot> {
    const fresh = await this.ensureAccess()
    if (fresh.synced) return fresh.access.state.snapshot
    return (await this.withAccess((access) => this.sync(access))).snapshot
  }

  async item(id: string): Promise<VaultItem> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new VaultError('item_unavailable', '条目不可用')
    }
    const { json, access } = await this.withAccess(async (access) => {
      const res = await vaultRequest(this.http, `${this.endpoints.api}/ciphers/${id}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${access.token}` },
      })
      if (res.status === 401) return null
      // 不存在、看不到（不在分给它的集合里）时 Vaultwarden 回 400，官方服务回 404
      if (res.status === 400 || res.status === 403 || res.status === 404) {
        throw new VaultError('item_unavailable', '条目不可用')
      }
      if (res.status !== 200) throw unexpectedStatus(res.status)
      return { json: res.json, access }
    })
    const orgId = str(json, 'organizationId')
    // 上次同步之后才加入的组织：重新同步一次取它的密钥
    if (orgId && !access.state.orgKeys.has(orgId)) await this.sync(access)
    const item = decodeItem(json, access.state.orgKeys)
    // Vaultwarden 给非管理员的单个条目不带集合，用同步时的
    if (item.collectionIds.length === 0) {
      item.collectionIds = access.state.snapshot.items.find((i) => i.id === id)?.collectionIds ?? []
    }
    return item
  }

  // 带着访问令牌执行；令牌被服务端拒绝（401，fn 返回 null）时换一次令牌再试
  private async withAccess<T>(fn: (access: Access) => Promise<T | null>): Promise<T> {
    const first = await this.ensureAccess()
    const result = await fn(first.access)
    if (result !== null) return result
    if (this.access === first.access) this.access = null
    const second = await this.ensureAccess()
    const retry = await fn(second.access)
    if (retry === null) throw reauth()
    return retry
  }

  private async ensureAccess(): Promise<{ access: Access; synced: boolean }> {
    const current = this.access
    if (current && current.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
      return { access: current, synced: false }
    }
    this.pending ??= this.refresh().finally(() => {
      this.pending = null
    })
    return { access: await this.pending, synced: true }
  }

  // 换访问令牌、同步、交给 onSynced。任何一步失败都不留访问令牌，下一次调用从头再来，onSynced 的检查不会被跳过
  private async refresh(): Promise<Access> {
    this.access = null
    const res = await vaultRequest(this.http, `${this.endpoints.identity}/connect/token`, {
      method: 'POST',
      headers: FORM,
      body: formBody({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: this.secrets.refreshToken,
      }),
    })
    if (res.status === 401 || (res.status === 400 && str(res.json, 'error') === 'invalid_grant')) {
      throw reauth()
    }
    if (res.status !== 200) throw unexpectedStatus(res.status)
    const grant = tokenGrant(res.json, this.now())

    if (grant.refreshToken && grant.refreshToken !== this.secrets.refreshToken) {
      // 旧的刷新令牌可能已经作废：先换成新的，保存失败时这次调用失败，下一次用新的再换
      this.secrets = { refreshToken: grant.refreshToken, userKey: this.secrets.userKey }
      await this.input.onSecretsChanged?.(this.secrets)
    }

    const state = await this.fetchSync(grant.accessToken)
    if (!state) throw reauth()
    await this.input.onSynced?.(state.snapshot)
    const access = { token: grant.accessToken, expiresAt: grant.expiresAt, state }
    this.access = access
    return access
  }

  // 再同步一次，更新这个令牌下的组织密钥与快照。401 返回 null
  private async sync(access: Access): Promise<SyncedState | null> {
    const state = await this.fetchSync(access.token)
    if (state) access.state = state
    return state
  }

  private async fetchSync(token: string): Promise<SyncedState | null> {
    const res = await vaultRequest(this.http, `${this.endpoints.api}/sync?excludeDomains=true`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.status === 401) return null
    if (res.status !== 200) throw unexpectedStatus(res.status)
    return decodeSync(res.json, this.userKey)
  }
}
