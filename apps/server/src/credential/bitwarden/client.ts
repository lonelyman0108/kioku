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
  CLIENT_NAME,
  formatLogged,
  prop,
  requireStr,
  str,
  unexpectedStatus,
  vaultEndpoints,
  vaultRequest,
  type HttpOptions,
  type VaultDiagnostic,
  type HttpResponse,
  type VaultEndpoints,
} from './http'
import {
  VaultError,
  type VaultAccount,
  type VaultClient,
  type VaultItem,
  type VaultItemChanges,
  type VaultLoginInput,
  type VaultNewItem,
  type VaultLoginResult,
  type VaultSession,
  type VaultSessionInput,
  type VaultSnapshot,
  type VaultTwoFactorProvider,
} from './types'
import { decodeItem, decodeSync, decodeSyncItems, type SyncedState } from './vault'
import {
  checkNewItem,
  checkType,
  newCipherBody,
  OFFICIAL_LIMITS,
  updatedCipherBody,
  VAULTWARDEN_LIMITS,
  writeValues,
  type LengthLimits,
} from './write'

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
const CLIENT_ID = CLIENT_NAME
const DEVICE_TYPE = '25'
const DEVICE_NAME = 'Kioku'
const SCOPE = 'api offline_access'

// 访问令牌提前这么久当作过期，免得请求发出去时刚好过期
const EXPIRY_MARGIN_MS = 60_000

// 缓存说集合只读时，上次同步超过这么久才重新同步再看（权限可能改过）；不到就直接按只读报，
// agent 循环重试时不会每次都下载整个密码库
const READ_ONLY_RESYNC_MS = 60_000

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

const readOnly = () => new VaultError('read_only', '集合只读：专用账号没有这个集合的编辑权限')
const conflict = () => new VaultError('item_conflict', '条目已在别处修改过，请重新读取后再改')
// 集合不在同步里（被删了、账号被移出了，或者解不开）：种类照样是 read_only，文字不让人去改权限
const collectionUnavailable = () =>
  new VaultError('read_only', '集合不可用：集合已被删除、专用账号不在这个集合里，或者无法解开它')

const JSON_BODY = { 'content-type': 'application/json; charset=utf-8' }

// 写入被拒时服务端的说明。Vaultwarden：Cipher is not write accessible、No rights to modify the collection、
// You don't have permission to ...、Invalid collection ID provided（集合被删了，或者账号被移出了集合）、
// The client copy of this cipher is out of date、Cipher doesn't exist；官方服务：You do not have permissions to edit this、
// The cipher you are updating is out of date、Cannot edit item. Update to the latest version of Bitwarden and try again
const READ_ONLY_MESSAGE = /not write accessible|no rights to modify|permission/i
const COLLECTION_GONE_MESSAGE = /invalid collection/i
const CONFLICT_MESSAGE = /out of date/i
const MISSING_MESSAGE = /doesn't exist|does not exist|not found/i
const CLIENT_TOO_OLD_MESSAGE = /update to the latest version/i
const CLIENT_TOO_OLD =
  '密码库拒绝修改这个条目：带通行密钥或条目密钥的条目要求更新的客户端版本，Kioku 需要升级'

function checkId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new VaultError('item_unavailable', '条目不可用')
  }
}

interface Access {
  token: string
  expiresAt: number
  // 最近一次同步的结果，再同步时换掉
  state: SyncedState
}

// 换到的令牌，和换令牌时那次同步的原始响应（条目的值还是密文）。原始响应不挂在会话上，只随这次换令牌的结果
// 交给等着它的调用：items() 直接用它，不再同步第二次；别的调用不理，用完就没人引用它
interface Refreshed {
  access: Access
  raw: unknown
}

class Session implements VaultSession {
  // 当前用的刷新令牌，和已经交给 onSecretsChanged 保存成功的那份分开记：保存失败时会话照样用新的，下次换令牌再试着保存
  private refreshToken: string
  private savedRefreshToken: string
  private readonly endpoints: VaultEndpoints
  private readonly userKey: SymmetricKey
  private access: Access | null = null
  // 正在进行的换令牌与同步：同时发起的调用共用这一次
  private pending: Promise<Refreshed> | null = null
  // 正在进行的保存刷新令牌
  private saving: Promise<void> | null = null
  // 这个会话新建的条目所在的集合，按条目 id：下一次同步之前取它们时用，每次同步之后清空，以同步结果为准
  private readonly createdCollections = new Map<string, string[]>()
  // 上次同步成功的时间（毫秒）
  private syncedAt = 0
  // 服务器的长度上限，第一次写入时按 /api/config 认出服务器之后记下
  private limits: LengthLimits | null = null

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
    return (await this.withAccess((access) => this.sync(access))).state.snapshot
  }

  async items(): Promise<VaultItem[]> {
    await this.saveRefreshToken()
    const { json, state } = await this.withAccess(async (access, fresh, raw) => {
      if (fresh && raw !== undefined) return { json: raw, state: access.state }
      return this.sync(access)
    })
    return formatLogged(this.http, 'sync', () => decodeSyncItems(json, state))
  }

  async item(id: string): Promise<VaultItem> {
    checkId(id)
    await this.saveRefreshToken()
    // 取条目与为它重新同步都在同一个令牌下做：哪一步遇到 401，都换一次令牌从头再来
    const { json, state } = await this.withAccess((access, fresh) =>
      this.fetchCipher(access, fresh, id),
    )
    return this.decoded(json, state)
  }

  async createItem(input: VaultNewItem): Promise<VaultItem> {
    // 字段不对时在发请求之前报错
    const values = checkNewItem(input)
    await this.saveRefreshToken()
    return this.withAccess(async (access, fresh) => {
      let state = access.state
      const find = (s: SyncedState) =>
        s.snapshot.collections.find(
          (c) => c.id === input.collectionId && c.organizationId === input.organizationId,
        )
      let collection = find(state)
      // 缓存里没有这个集合（上次同步之后才分到的），或者缓存说只读且上次同步已经过了一阵（之后可能改成了可以编辑）：
      // 重新同步一次再看。刚换令牌时已经同步过，不再同步第二次
      if (!fresh && (!collection || (collection.readOnly && this.syncStale()))) {
        const synced = await this.sync(access)
        if (!synced) return null
        state = synced.state
        collection = find(state)
      }
      if (!collection) throw collectionUnavailable()
      if (collection.readOnly) throw readOnly()
      // 同步只列出解得开的集合，组织密钥一定在
      const orgKey = state.orgKeys.get(input.organizationId)!
      const body = newCipherBody(
        input,
        values,
        orgKey,
        state.snapshot.account.userId,
        await this.lengthLimits(),
      )
      const res = await vaultRequest(this.http, `${this.endpoints.api}/ciphers/create`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access.token}`, ...JSON_BODY },
        body: JSON.stringify(body),
      })
      if (res.status === 401) return null
      if (res.status !== 200) throw this.writeRejected(res, 'cipher_create')
      const item = this.decoded(res.json, state)
      if (item.collectionIds.length === 0) item.collectionIds = [input.collectionId]
      // 下一次同步之前取这个条目时，Vaultwarden 的单个条目不带集合，同步的缓存里也还没有它
      this.createdCollections.set(item.id, item.collectionIds)
      return this.reread(access, item)
    })
  }

  async updateItem(
    id: string,
    changes: VaultItemChanges,
    expectedRevisionDate: string,
  ): Promise<VaultItem> {
    checkId(id)
    // 类型要取到条目才知道，这里先查字段的写法
    const values = writeValues(changes.values ?? {}, null)
    await this.saveRefreshToken()
    return this.withAccess(async (access, fresh) => {
      const fetched = await this.fetchCipher(access, fresh, id)
      if (!fetched) return null
      const { json } = fetched
      let { state } = fetched
      let current = this.decoded(json, state)
      if (current.revisionDate !== expectedRevisionDate) throw conflict()
      checkType(values, current.type)
      // 只按缓存的集合判成只读（服务端没给 edit）时，和新建一样，上次同步过了一阵就重新同步一次再看
      if (!this.editable(json, current, state) && typeof prop(json, 'edit') !== 'boolean') {
        if (!fresh && this.syncStale()) {
          const synced = await this.sync(access)
          if (!synced) return null
          state = synced.state
          current = this.decoded(json, state)
        }
      }
      if (!this.editable(json, current, state)) throw readOnly()
      const limits = await this.lengthLimits()
      const body = formatLogged(this.http, 'cipher', () =>
        updatedCipherBody({
          raw: json,
          name: changes.name,
          values,
          // decodeItem 解开了，组织密钥一定在
          orgKey: state.orgKeys.get(current.organizationId)!,
          userId: state.snapshot.account.userId,
          now: new Date(this.now()).toISOString(),
          limits,
          onHistorySkipped: () =>
            this.http.log({ what: 'history_skipped', endpoint: 'cipher_update' }),
        }),
      )
      // 什么都没变：不发修改，免得服务端改了修改时间
      if (!body) return current
      const res = await vaultRequest(this.http, `${this.endpoints.api}/ciphers/${id}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${access.token}`, ...JSON_BODY },
        body: JSON.stringify(body),
      })
      if (res.status === 401) return null
      if (res.status !== 200) throw this.writeRejected(res, 'cipher_update')
      // 修改不动集合：响应里没有集合时用原来的
      const item = this.decoded(res.json, state)
      if (item.collectionIds.length === 0) item.collectionIds = current.collectionIds
      return this.reread(access, item)
    })
  }

  // 写入成功之后再取一次条目，返回库里存下的那一份：Vaultwarden 用 MySQL 时修改时间存成整秒，写入响应里的
  // revisionDate 却带着小数，之后同步与取条目给的是整秒的，拿写入响应的那个去改就会被判成冲突。
  // 集合照写入时的。取不到（连不上、意外的状态、解不开）时退回写入响应的那一份，日志记一条（不带值）；
  // 401 时换一次令牌再取
  private async reread(access: Access, written: VaultItem): Promise<VaultItem> {
    let current = access
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await vaultRequest(this.http, `${this.endpoints.api}/ciphers/${written.id}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${current.token}` },
        })
        if (res.status === 401 && attempt === 0) {
          if (this.access === current) this.access = null
          current = (await this.ensureAccess()).access
          continue
        }
        if (res.status !== 200) {
          this.http.log({ what: 'reread_failed', status: res.status, endpoint: 'cipher' })
          return written
        }
        const item = this.decoded(res.json, current.state)
        if (item.collectionIds.length === 0) item.collectionIds = written.collectionIds
        return item
      } catch (err) {
        if (!(err instanceof VaultError)) throw err
        this.http.log({ what: 'reread_failed', endpoint: 'cipher', problem: err.kind })
        return written
      }
    }
    this.http.log({ what: 'reread_failed', status: 401, endpoint: 'cipher' })
    return written
  }

  private syncStale(): boolean {
    return this.now() - this.syncedAt > READ_ONLY_RESYNC_MS
  }

  // 按服务器定长度上限：/api/config 里 server 的名字是 Vaultwarden 时只查备注，官方服务（server 为空）与认不出的
  // 按官方的上限。读到了才记下；读不到时这一次按官方的上限，下次再读
  private async lengthLimits(): Promise<LengthLimits> {
    if (this.limits) return this.limits
    let res: HttpResponse
    try {
      res = await vaultRequest(this.http, `${this.endpoints.api}/config`, { method: 'GET' })
    } catch (err) {
      if (err instanceof VaultError) return OFFICIAL_LIMITS
      throw err
    }
    if (res.status !== 200) {
      this.http.log({ what: 'status', status: res.status, endpoint: 'config' })
      return OFFICIAL_LIMITS
    }
    const name = str(prop(res.json, 'server'), 'name')
    this.limits = name?.toLowerCase() === 'vaultwarden' ? VAULTWARDEN_LIMITS : OFFICIAL_LIMITS
    return this.limits
  }

  // 能不能改：以刚取到的条目的 edit 为准（缓存的集合权限可能过时）；服务端没给 edit 时看缓存里条目所在的集合，
  // 都只读才算改不了。不知道条目在哪些集合时不据此判断，交给服务端
  private editable(json: unknown, item: VaultItem, state: SyncedState): boolean {
    const edit = prop(json, 'edit')
    if (typeof edit === 'boolean') return edit
    const collections = item.collectionIds.map((cid) =>
      state.snapshot.collections.find((c) => c.id === cid),
    )
    return collections.length === 0 || !collections.every((c) => c?.readOnly === true)
  }

  // 取一个条目的原始响应；为没见过的组织重新同步。401 返回 null
  private async fetchCipher(
    access: Access,
    fresh: boolean,
    id: string,
  ): Promise<{ json: unknown; state: SyncedState } | null> {
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
      return { json: res.json, state: synced.state }
    }
    return { json: res.json, state: access.state }
  }

  // 解开条目。Vaultwarden 给非管理员的单个条目不带集合：用同步时的；同步里还没有的（这个会话刚建的）用建时记下的
  private decoded(json: unknown, state: SyncedState): VaultItem {
    const item = formatLogged(this.http, 'cipher', () => decodeItem(json, state))
    if (item.collectionIds.length === 0) {
      const synced = state.snapshot.items.find((i) => i.id === item.id)?.collectionIds ?? []
      item.collectionIds = [
        ...(synced.length ? synced : (this.createdCollections.get(item.id) ?? [])),
      ]
    }
    return item
  }

  // 写入被拒。按服务端的说明分出只读与冲突；说明只用来分类，不进错误与日志
  private writeRejected(res: HttpResponse, endpoint: string): VaultError {
    const message = str(res.json, 'message') ?? ''
    const rejected = (problem: string, err: VaultError) => {
      this.http.log({ what: 'rejected', status: res.status, endpoint, problem })
      return err
    }
    if (res.status === 400 && CONFLICT_MESSAGE.test(message))
      return rejected('conflict', conflict())
    if (res.status === 400 && CLIENT_TOO_OLD_MESSAGE.test(message)) {
      return rejected('client_version', new VaultError('server_error', CLIENT_TOO_OLD))
    }
    if (res.status === 400 && COLLECTION_GONE_MESSAGE.test(message)) {
      return rejected('collection', collectionUnavailable())
    }
    if (res.status === 403 || (res.status === 400 && READ_ONLY_MESSAGE.test(message))) {
      return rejected('read_only', readOnly())
    }
    if (
      endpoint === 'cipher_update' &&
      (res.status === 404 || (res.status === 400 && MISSING_MESSAGE.test(message)))
    ) {
      return rejected('missing', new VaultError('item_unavailable', '条目不可用'))
    }
    return unexpectedStatus(this.http, res.status)
  }

  // 带着访问令牌执行；令牌被服务端拒绝（401，fn 返回 null）时换一次令牌再试
  // fresh 为真表示这个令牌是这次调用刚换的，已经同步过，raw 是那次同步的原始响应
  private async withAccess<T>(
    fn: (access: Access, fresh: boolean, raw: unknown) => Promise<T | null>,
  ): Promise<T> {
    const first = await this.ensureAccess()
    const result = await fn(first.access, first.synced, first.raw)
    if (result !== null) return result
    if (this.access === first.access) this.access = null
    const second = await this.ensureAccess()
    const retry = await fn(second.access, second.synced, second.raw)
    if (retry === null) throw reauth()
    return retry
  }

  private async ensureAccess(): Promise<{ access: Access; synced: boolean; raw?: unknown }> {
    const current = this.access
    if (current && current.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
      return { access: current, synced: false }
    }
    this.pending ??= this.refresh().finally(() => {
      this.pending = null
    })
    const { access, raw } = await this.pending
    return { access, synced: true, raw }
  }

  // 换访问令牌、同步、交给 onSynced。任何一步失败都不留访问令牌，下一次调用从头再来，onSynced 的检查不会被跳过
  private async refresh(): Promise<Refreshed> {
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
    const synced = await this.checkedSync(grant.accessToken)
    if (!synced) throw reauth()
    const access: Access = {
      token: grant.accessToken,
      expiresAt: grant.expiresAt,
      state: synced.state,
    }
    this.access = access
    return { access, raw: synced.json }
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
  private async sync(access: Access): Promise<{ json: unknown; state: SyncedState } | null> {
    let synced: { json: unknown; state: SyncedState } | null
    try {
      synced = await this.checkedSync(access.token)
    } catch (err) {
      // onSynced 拒绝了（或者同步失败）：丢掉这个令牌，下一次调用重新换令牌、再检查一遍，不用缓存的结果取值
      if (this.access === access) this.access = null
      throw err
    }
    if (synced) access.state = synced.state
    return synced
  }

  // 同步并交给 onSynced；它抛错时以同样的错误失败，这次同步的结果不用。401 返回 null
  private async checkedSync(token: string): Promise<{ json: unknown; state: SyncedState } | null> {
    const res = await vaultRequest(this.http, `${this.endpoints.api}/sync?excludeDomains=true`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.status === 401) return null
    if (res.status !== 200) throw unexpectedStatus(this.http, res.status)
    const state = formatLogged(this.http, 'sync', () => decodeSync(res.json, this.userKey))
    await this.input.onSynced?.(state.snapshot)
    this.syncedAt = this.now()
    // 新建时记下的集合不再用：同步里有这些条目现在所在的集合（被移走的也是新的）
    this.createdCollections.clear()
    return { json: res.json, state }
  }
}
