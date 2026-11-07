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
import { loggableError } from '../../db/client'
import {
  badResponse,
  formatLogged,
  prop,
  requireStr,
  str,
  unexpectedStatus,
  vaultEndpoints,
  vaultRequest,
  type HttpOptions,
  type VaultDiagnostic,
  type VaultEndpoints,
} from './http'
import {
  VaultError,
  type VaultAccount,
  type VaultClient,
  type VaultItem,
  type VaultLoginInput,
  type VaultLoginResult,
  type VaultSession,
  type VaultSessionInput,
  type VaultSnapshot,
  type VaultTwoFactorProvider,
} from './types'
import { decodeItem, decodeSync, type SyncedState } from './vault'

export type { VaultDiagnostic } from './http'

export interface VaultClientOptions {
  fetch?: typeof fetch
  // 毫秒时间戳，判断访问令牌是否过期
  now?: () => number
  // 每个请求的时限，含读完正文
  timeoutMs?: number
  // 内部日志：连接错误的代码、意外的状态码这类细节只记在这里，不进给调用方的错误文字。默认打到标准错误
  log?: (diagnostic: VaultDiagnostic) => void
}

const defaultLog = (diagnostic: VaultDiagnostic) => console.warn('密码库请求', diagnostic)

// 身份服务认的客户端：client_id 与设备类型照官方命令行（LinuxCLI），设备名写 Kioku
const CLIENT_ID = 'cli'
const DEVICE_TYPE = '25'
const DEVICE_NAME = 'Kioku'
const SCOPE = 'api offline_access'

// 访问令牌提前这么久当作过期，免得请求发出去时刚好过期
const EXPIRY_MARGIN_MS = 60_000

// 两步验证的方式里只认验证器应用（0）
const AUTHENTICATOR = '0'
const NEEDS_AUTHENTICATOR = '密码库要求的两步验证方式不受支持：专用账号请改用验证器应用做两步验证'
const NEW_DEVICE = '官方服务要求验证新设备：给专用账号开启验证器应用的两步验证后再连接'

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
    throw badResponse('access token payload')
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
    log: options.log ?? defaultLog,
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
    if (pre.status !== 200) throw unexpectedStatus(http, pre.status)
    const kdf = formatLogged(http, 'prelogin', () => {
      const settings = prop(pre.json, 'kdfSettings')
      const kdfType = prop(pre.json, 'kdf') ?? prop(settings, 'kdfType')
      if (kdfType === undefined) throw badResponse('missing kdf')
      return kdfParams({
        kdf: kdfType,
        iterations: prop(pre.json, 'kdfIterations') ?? prop(settings, 'iterations'),
        memory: prop(pre.json, 'kdfMemory') ?? prop(settings, 'memory'),
        parallelism: prop(pre.json, 'kdfParallelism') ?? prop(settings, 'parallelism'),
      })
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
      fields.twoFactorProvider = AUTHENTICATOR
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
        if (!providers.includes(AUTHENTICATOR)) {
          throw new VaultError('unsupported_two_factor', NEEDS_AUTHENTICATOR)
        }
        const supported: VaultTwoFactorProvider[] = ['authenticator']
        return { kind: 'two_factor_required', providers: supported }
      }
      // 官方服务对没开两步验证的账号在新设备上另要邮件里的验证码（新设备验证），这里不支持
      if (/new device/i.test(`${str(res.json, 'error_description')} ${str(res.json, 'message')}`)) {
        throw new VaultError('unsupported_two_factor', NEW_DEVICE)
      }
      // 其余的 400 都是凭据不对：官方服务回 invalid_grant，Vaultwarden 的 error 是空的、只在 message 里说明。
      // 带着验证码时主密码已经在上一步验过，验证码不对 Vaultwarden 也不再带 TwoFactorProviders
      if (res.status === 400) {
        if (input.twoFactor) throw new VaultError('two_factor_invalid', '两步验证码不正确或已过期')
        throw new VaultError('invalid_credentials', '邮箱或主密码不正确')
      }
      throw unexpectedStatus(http, res.status)
    }
    if (res.status !== 200) throw unexpectedStatus(http, res.status)

    const { refreshToken, encUserKey, account } = formatLogged(http, 'token', () => {
      const grant = tokenGrant(res.json, now())
      if (!grant.refreshToken) throw badResponse('missing refresh_token')
      const encUserKey = str(res.json, 'key')
      if (!encUserKey) throw badResponse('missing key')
      return {
        refreshToken: grant.refreshToken,
        encUserKey,
        account: accountOf(grant.accessToken),
      }
    })
    const userKey = decryptBytes(encUserKey, stretched)
    stretched.encKey.fill(0)
    stretched.macKey.fill(0)
    // 账户密钥必须是 64 字节（加密、MAC 各一半），旧格式的 32 字节报 unsupported_format
    splitKey(userKey)
    return { kind: 'ok', secrets: { refreshToken, userKey }, account }
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
  // 当前用的刷新令牌，和已经交给 onSecretsChanged 保存成功的那份分开记：保存失败时会话照样用新的，下次换令牌再试着保存
  private refreshToken: string
  private savedRefreshToken: string
  private readonly endpoints: VaultEndpoints
  private readonly userKey: SymmetricKey
  private access: Access | null = null
  // 正在进行的换令牌与同步：同时发起的调用共用这一次
  private pending: Promise<Access> | null = null
  // 正在进行的保存刷新令牌
  private saving: Promise<void> | null = null

  constructor(
    private readonly http: HttpOptions,
    private readonly now: () => number,
    private readonly input: VaultSessionInput,
  ) {
    this.refreshToken = input.secrets.refreshToken
    this.savedRefreshToken = input.secrets.refreshToken
    this.endpoints = vaultEndpoints(input.serverUrl)
    this.userKey = splitKey(Buffer.from(input.secrets.userKey))
  }

  async snapshot(): Promise<VaultSnapshot> {
    await this.saveRefreshToken()
    const fresh = await this.ensureAccess()
    if (fresh.synced) return fresh.access.state.snapshot
    return (await this.withAccess((access) => this.sync(access))).snapshot
  }

  async item(id: string): Promise<VaultItem> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new VaultError('item_unavailable', '条目不可用')
    }
    await this.saveRefreshToken()
    // 取条目与为它重新同步都在同一个令牌下做：哪一步遇到 401，都换一次令牌从头再来
    const { json, state } = await this.withAccess(async (access, fresh) => {
      const res = await vaultRequest(this.http, `${this.endpoints.api}/ciphers/${id}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${access.token}` },
      })
      if (res.status === 401) return null
      // 不存在、看不到（不在分给它的集合里）时 Vaultwarden 回 400，官方服务回 404
      if (res.status === 400 || res.status === 403 || res.status === 404) {
        throw new VaultError('item_unavailable', '条目不可用')
      }
      if (res.status !== 200) throw unexpectedStatus(this.http, res.status)
      const orgId = str(res.json, 'organizationId')
      // 上次同步之后才加入的组织：重新同步一次取它的密钥。刚换令牌时已经同步过，不再同步第二次，按不可用处理
      if (
        !fresh &&
        orgId &&
        !access.state.orgKeys.has(orgId) &&
        !access.state.orgKeyErrors.has(orgId)
      ) {
        const synced = await this.sync(access)
        if (!synced) return null
        return { json: res.json, state: synced }
      }
      return { json: res.json, state: access.state }
    })
    const item = formatLogged(this.http, 'cipher', () => decodeItem(json, state))
    // Vaultwarden 给非管理员的单个条目不带集合，用同步时的
    if (item.collectionIds.length === 0) {
      item.collectionIds = state.snapshot.items.find((i) => i.id === id)?.collectionIds ?? []
    }
    return item
  }

  // 带着访问令牌执行；令牌被服务端拒绝（401，fn 返回 null）时换一次令牌再试
  // fresh 为真表示这个令牌是这次调用刚换的，已经同步过
  private async withAccess<T>(
    fn: (access: Access, fresh: boolean) => Promise<T | null>,
  ): Promise<T> {
    const first = await this.ensureAccess()
    const result = await fn(first.access, first.synced)
    if (result !== null) return result
    if (this.access === first.access) this.access = null
    const second = await this.ensureAccess()
    const retry = await fn(second.access, second.synced)
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
        refresh_token: this.refreshToken,
      }),
    })
    if (res.status === 401 || (res.status === 400 && str(res.json, 'error') === 'invalid_grant')) {
      throw reauth()
    }
    if (res.status !== 200) throw unexpectedStatus(this.http, res.status)
    const grant = formatLogged(this.http, 'token', () => tokenGrant(res.json, this.now()))
    // 旧的刷新令牌可能已经作废，马上换成新的
    if (grant.refreshToken) this.refreshToken = grant.refreshToken
    await this.saveRefreshToken()

    // 刚换到的令牌就被拒绝：按需要重新登录算
    const state = await this.checkedSync(grant.accessToken)
    if (!state) throw reauth()
    const access: Access = { token: grant.accessToken, expiresAt: grant.expiresAt, state }
    this.access = access
    return access
  }

  // 当前的刷新令牌和保存成功的不同时交给 onSecretsChanged：换令牌之后，以及每次 item()、snapshot() 开始时。
  // 它失败了不影响这次调用：会话接着用新的，记下原因，下一次调用再试。同时来的几次调用共用一次保存
  private async saveRefreshToken(): Promise<void> {
    while (this.saving) await this.saving
    const token = this.refreshToken
    const save = this.input.onSecretsChanged
    if (token === this.savedRefreshToken || !save) return
    this.saving = (async () => {
      try {
        await save({ refreshToken: token, userKey: this.input.secrets.userKey })
        this.savedRefreshToken = token
      } catch (err) {
        this.http.log({ what: 'secrets_not_saved', error: loggableError(err) })
      }
    })()
    try {
      await this.saving
    } finally {
      this.saving = null
    }
  }

  // 用这个令牌再同步一次，结果交给 onSynced 之后换掉内存里的快照与组织密钥。401 返回 null
  private async sync(access: Access): Promise<SyncedState | null> {
    let state: SyncedState | null
    try {
      state = await this.checkedSync(access.token)
    } catch (err) {
      // onSynced 拒绝了（或者同步失败）：丢掉这个令牌，下一次调用重新换令牌、再检查一遍，不用缓存的结果取值
      if (this.access === access) this.access = null
      throw err
    }
    if (state) access.state = state
    return state
  }

  // 同步并交给 onSynced；它抛错时以同样的错误失败，这次同步的结果不用。401 返回 null
  private async checkedSync(token: string): Promise<SyncedState | null> {
    const res = await vaultRequest(this.http, `${this.endpoints.api}/sync?excludeDomains=true`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.status === 401) return null
    if (res.status !== 200) throw unexpectedStatus(this.http, res.status)
    const state = formatLogged(this.http, 'sync', () => decodeSync(res.json, this.userKey))
    await this.input.onSynced?.(state.snapshot)
    return state
  }
}
