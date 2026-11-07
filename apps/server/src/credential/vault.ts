import { randomUUID } from 'node:crypto'

import {
  CREDENTIAL_ACCESS_REASON_NAMES,
  isNewerRevision,
  VAULT_DISABLED_REASON_NAMES,
  type ConnectVaultRequest,
  type CredentialAccessReason,
  type ReconnectVaultRequest,
  type VaultConnection,
  type VaultConnectionList,
  type VaultCheckResult,
  type VaultCollection,
  type VaultConnectResult,
  type VaultDisabledReason,
  type VaultErrorKind,
  type VaultItemList,
} from '@kioku/contracts'
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'

import { decryptSecret, encryptSecret } from '../crypto/envelope'
import { decryptionKey, encryptionKey, type MasterKey } from '../crypto/keyring'
import { isUniqueViolation, withSpace, type Db, type Tx } from '../db/client'
import { credentials, vaultConnections } from '../db/schema'
import { MemoryError } from '../memory/service'
import { serverUrlProblem } from './bitwarden/http'
import {
  VaultError,
  type VaultClient,
  type VaultLoginInput,
  type VaultSecrets,
  type VaultSession,
  type VaultSnapshot,
} from './bitwarden/types'

export type ConnectionRow = typeof vaultConnections.$inferSelect

// 刷新令牌与账户密钥整体加密，aad 绑定连接 id：把一个连接的密文挪到别的连接上会解密失败
export const vaultAad = (id: string) => `vault-connection:${id}`

export function sealVaultSecrets(
  masterKey: MasterKey,
  id: string,
  secrets: VaultSecrets,
): { ciphertext: Buffer; wrappedKey: Buffer; keyId: string } {
  const { key, id: keyId } = encryptionKey(masterKey)
  const text = JSON.stringify({
    refreshToken: secrets.refreshToken,
    userKey: secrets.userKey.toString('base64'),
  })
  return { ...encryptSecret(key, text, vaultAad(id)), keyId }
}

export function openVaultSecrets(
  masterKey: MasterKey,
  row: { id: string; ciphertext: Buffer; wrappedKey: Buffer; keyId: string | null },
): VaultSecrets {
  const text = decryptSecret(
    decryptionKey(masterKey, row.keyId),
    { ciphertext: row.ciphertext, wrappedKey: row.wrappedKey },
    vaultAad(row.id),
  )
  const parsed = JSON.parse(text) as { refreshToken: string; userKey: string }
  return { refreshToken: parsed.refreshToken, userKey: Buffer.from(parsed.userKey, 'base64') }
}

// 专用账号的检查：有不属于组织的条目，或在某个组织里可访问全部集合时不能用。可访问全部集合的不只是所有者、管理员，
// Vaultwarden 还有开了「访问全部集合」的普通成员，所以以 allCollections 为准，角色只作兜底
export function snapshotViolation(snapshot: VaultSnapshot): VaultDisabledReason | null {
  if (snapshot.personalItemCount > 0) return 'personal_items'
  if (
    snapshot.organizations.some((o) => o.allCollections || o.role === 'owner' || o.role === 'admin')
  ) {
    return 'organization_role'
  }
  return null
}

const VIOLATION_TEXT: Record<VaultDisabledReason, string> = {
  personal_items:
    '账号中有个人条目（不属于组织的条目）。Kioku 只接受专用账号：将要给 Agent 用的条目移进组织的集合、清空个人条目后再连接。',
  organization_role:
    '账号在组织中可访问全部集合（所有者、管理员，或开了「访问全部集合」）。Kioku 只接受专用账号：将它的角色改为用户、关掉「访问全部集合」，只分配给 Agent 用的集合。',
}

// 同步时发现违规、连接刚被停用：这次调用以「连接已停用」失败
export class VaultDisabledError extends Error {
  constructor(readonly reason: VaultDisabledReason) {
    super(VAULT_DISABLED_REASON_NAMES[reason])
    this.name = 'VaultDisabledError'
  }
}

// 密码库的错误对应的取用原因
export function vaultReason(kind: VaultErrorKind): CredentialAccessReason {
  switch (kind) {
    case 'reauth_required':
    case 'item_unavailable':
    case 'unreachable':
      return kind
    default:
      return 'vault_error'
  }
}

// 取不到值的原因对应的状态：密码库连不上或返回的内容认不出是 502，主密钥的问题 400，连接与条目的状态问题 409
export function reasonStatus(reason: CredentialAccessReason): 400 | 409 | 502 {
  if (reason === 'unreachable' || reason === 'vault_error') return 502
  return reason === 'master_key' ? 400 : 409
}

// 这几种是连接本身的问题，记进连接的最近错误；条目不可用说明通信是好的。
// 写入本身的错误（read_only、item_conflict、value_too_long）不在这里：它们说的是这次写入，不改连接的状态。
// 字段和条目的类型对不上（VaultFieldError，kind 也是 unsupported_format）也是写入本身的错误，
// 写入那边先把它换掉（service 的 writeOutcome）
const CONNECTION_ERRORS = new Set<VaultErrorKind>([
  'unreachable',
  'server_error',
  'unsupported_format',
  'integrity',
])

// 一次和密码库通信的结果，按它更新连接：成功（或只是条目不可用）清掉最近的错误并记下检查时间；
// 刷新令牌失效改成需要重新登录；连不上与认不出的内容记进最近的错误，状态不变
export type VaultOutcome =
  { kind: 'ok' } | { kind: 'disabled' } | { kind: 'error'; error: VaultErrorKind }

function loginFailure(err: unknown): never {
  if (!(err instanceof VaultError)) throw err
  switch (err.kind) {
    case 'invalid_credentials':
      throw new MemoryError(400, '邮箱或主密码不正确')
    case 'two_factor_invalid':
      throw new MemoryError(400, '两步验证码不正确或已过期')
    case 'unsupported_two_factor':
      throw new MemoryError(400, '账号的两步验证方式不受支持：只支持验证器应用')
    case 'unreachable':
      throw new MemoryError(502, '密码库无法连接，请检查服务器地址后重试')
    default:
      throw new MemoryError(502, '密码库返回的内容无法识别')
  }
}

const SYNC_ACTION_TEXT = {
  check: '重新检查失败：',
  items: '无法列出条目：',
  destination: '无法设置去处：',
} as const

// 同步之后的错误，开头说是哪个动作。这次同步本身失败（failed，连接本身的问题）时按它说；
// 否则停用、需要重新登录按连接的状态说，其余按最近的错误说
function syncFailure(
  action: keyof typeof SYNC_ACTION_TEXT,
  row: ConnectionRow,
  failed: VaultErrorKind | null,
): MemoryError {
  const reason: CredentialAccessReason = failed
    ? failed === 'unreachable'
      ? 'unreachable'
      : 'vault_error'
    : row.status === 'disabled'
      ? 'disabled'
      : row.status === 'reauth_required'
        ? 'reauth_required'
        : row.lastErrorKind === 'unreachable'
          ? 'unreachable'
          : 'vault_error'
  const detail = failed
    ? ''
    : row.disabledReason !== null
      ? `：${VAULT_DISABLED_REASON_NAMES[row.disabledReason]}`
      : reason === 'reauth_required'
        ? '，请重新登录'
        : ''
  return new MemoryError(
    reasonStatus(reason),
    `${SYNC_ACTION_TEXT[action]}${CREDENTIAL_ACCESS_REASON_NAMES[reason]}${detail}`,
  )
}

// 缓存的会话记着建它时（或它最近一次保存的）密文：密文变了就是重新登录或换过令牌，换一个会话
interface CachedSession {
  ciphertext: Buffer
  session: VaultSession
  // 这个会话最近一次同步读到的集合：起标识的响应要写集合的名称，有了就不再为它同步一次
  collections?: VaultSnapshot['collections']
}

// 会话按连接缓存在进程里（访问令牌与组织密钥在会话的内存里），按客户端分开：测试里每个用例一个假客户端
const SESSIONS = new WeakMap<VaultClient, Map<string, CachedSession>>()
// 会话对象对应的缓存项：record 按这次用的会话判断要不要删，会话保存过新令牌时也拿得到最新的密文
const ENTRIES = new WeakMap<VaultSession, CachedSession>()

// 正在连接或重新登录的成员（空间 + 成员）。密钥派生可能很慢、在进程里排队一次只跑一个，
// 同一个成员重复提交会排出很长的队，所以同时只收一个，后来的直接 409。只记在内存里，请求结束就释放
const LOGINS_IN_FLIGHT = new Set<string>()

function sessionsOf(client: VaultClient): Map<string, CachedSession> {
  let map = SESSIONS.get(client)
  if (!map) {
    map = new Map()
    SESSIONS.set(client, map)
  }
  return map
}

export interface VaultContext {
  db: Db
  spaceId: string
  ownerAccountId: string
  masterKey: MasterKey | null
  client: VaultClient
}

// 一个成员的密码库连接。权限由调用方（CredentialService）先判断，这里只按所有者找连接，别人的和不存在一样是 404。
// 不在事务里请求密码库：先在短事务里读，事务外请求，再开短事务写结果
export class VaultConnections {
  constructor(private readonly ctx: VaultContext) {}

  private run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withSpace(this.ctx.db, this.ctx.spaceId, fn)
  }

  private get cache(): Map<string, CachedSession> {
    return sessionsOf(this.ctx.client)
  }

  private requireMasterKey(): MasterKey {
    if (!this.ctx.masterKey) {
      throw new MemoryError(400, '服务端未配置 KIOKU_MASTER_KEY，无法连接密码库')
    }
    return this.ctx.masterKey
  }

  private async own(tx: Tx, id: string): Promise<ConnectionRow> {
    const row = await this.load(tx, id)
    if (!row) throw new MemoryError(404, '密码库连接不存在')
    return row
  }

  // 连接不能用了（断开、需要重新登录、停用、被删掉）：缓存里这个连接的会话带着解开的令牌与账户密钥，不再留着
  forget(id: string): void {
    this.cache.delete(id)
  }

  // 按 id 读一个连接（含密文），取用凭据时用
  async load(tx: Tx, id: string): Promise<ConnectionRow | undefined> {
    const [row] = await tx
      .select()
      .from(vaultConnections)
      .where(
        and(
          eq(vaultConnections.id, id),
          eq(vaultConnections.ownerAccountId, this.ctx.ownerAccountId),
        ),
      )
    return row
  }

  private async counts(tx: Tx, ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map()
    const rows = await tx
      .select({ id: credentials.vaultConnectionId, n: count() })
      .from(credentials)
      .where(and(inArray(credentials.vaultConnectionId, ids), isNull(credentials.deletedAt)))
      .groupBy(credentials.vaultConnectionId)
    return new Map(rows.map((r) => [r.id!, r.n]))
  }

  private view(row: ConnectionRow, credentialCount: number): VaultConnection {
    return {
      id: row.id,
      serverUrl: row.serverUrl,
      email: row.email,
      status: row.status,
      disabledReason: row.disabledReason,
      lastError:
        row.lastErrorKind && row.lastErrorAt
          ? { kind: row.lastErrorKind, at: row.lastErrorAt.toISOString() }
          : null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
      credentialCount,
      destination:
        row.defaultCollectionId && row.defaultOrganizationId && row.defaultCollectionName !== null
          ? {
              collectionId: row.defaultCollectionId,
              organizationId: row.defaultOrganizationId,
              collectionName: row.defaultCollectionName,
            }
          : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  private async viewOf(tx: Tx, row: ConnectionRow): Promise<VaultConnection> {
    return this.view(row, (await this.counts(tx, [row.id])).get(row.id) ?? 0)
  }

  async list(): Promise<VaultConnectionList> {
    return this.run(async (tx) => {
      const rows = await tx
        .select()
        .from(vaultConnections)
        .where(eq(vaultConnections.ownerAccountId, this.ctx.ownerAccountId))
        .orderBy(asc(vaultConnections.createdAt), asc(vaultConnections.id))
      const counts = await this.counts(
        tx,
        rows.map((r) => r.id),
      )
      return { items: rows.map((r) => this.view(r, counts.get(r.id) ?? 0)) }
    })
  }

  // 连接一个账号。同一个账号（同一服务器上的账号 id）已经有连接时（包括已断开的）复用那一行
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const key = `${this.ctx.spaceId}/${this.ctx.ownerAccountId}`
    if (LOGINS_IN_FLIGHT.has(key)) {
      throw new MemoryError(409, '正在处理上一次的连接请求，请等它结束后再试')
    }
    LOGINS_IN_FLIGHT.add(key)
    try {
      return await fn()
    } finally {
      LOGINS_IN_FLIGHT.delete(key)
    }
  }

  async connect(input: ConnectVaultRequest): Promise<VaultConnectResult> {
    return this.exclusive(() => this.connectOnce(input))
  }

  async reconnect(id: string, input: ReconnectVaultRequest): Promise<VaultConnectResult> {
    return this.exclusive(() => this.reconnectOnce(id, input))
  }

  private async connectOnce(input: ConnectVaultRequest): Promise<VaultConnectResult> {
    this.requireMasterKey()
    // 同一个邮箱连过就沿用设备 id，密码库的设备列表里不会多出一台 Kioku
    const [known] = await this.run((tx) =>
      tx
        .select({ deviceId: vaultConnections.deviceId })
        .from(vaultConnections)
        .where(
          and(
            eq(vaultConnections.ownerAccountId, this.ctx.ownerAccountId),
            eq(vaultConnections.serverUrl, input.serverUrl),
            sql`lower(${vaultConnections.email}) = lower(${input.email})`,
          ),
        )
        .limit(1),
    )
    return this.login(
      {
        serverUrl: input.serverUrl,
        email: input.email,
        masterPassword: input.masterPassword,
        deviceId: known?.deviceId ?? randomUUID(),
        ...(input.twoFactor ? { twoFactor: input.twoFactor } : {}),
      },
      null,
    )
  }

  // 重新登录：服务器与账号不变，登录到别的账号时拒绝
  private async reconnectOnce(
    id: string,
    input: ReconnectVaultRequest,
  ): Promise<VaultConnectResult> {
    this.requireMasterKey()
    const row = await this.run((tx) => this.own(tx, id))
    return this.login(
      {
        serverUrl: row.serverUrl,
        email: input.email ?? row.email,
        masterPassword: input.masterPassword,
        deviceId: row.deviceId,
        ...(input.twoFactor ? { twoFactor: input.twoFactor } : {}),
      },
      row,
    )
  }

  private async login(
    input: VaultLoginInput,
    expected: ConnectionRow | null,
  ): Promise<VaultConnectResult> {
    const masterKey = this.requireMasterKey()
    // 地址不合规则时客户端报的是连不上，这里先用它的判断查一遍，说明地址的规则
    const urlProblem = serverUrlProblem(input.serverUrl)
    if (urlProblem) throw new MemoryError(400, urlProblem)
    const result = await this.ctx.client.login(input).catch(loginFailure)
    if (result.kind === 'two_factor_required') {
      return { kind: 'two_factor_required', providers: result.providers }
    }
    if (expected && result.account.userId !== expected.vaultUserId) {
      throw new MemoryError(
        409,
        '登录的账号与这个连接不同。要连接别的账号，请新建连接，再给条目起标识。',
      )
    }
    let id = expected?.id ?? ''
    // 保存之前会话换了刷新令牌的话，存新的；保存之后由 persist 写库
    let secrets = result.secrets
    let persist: ((next: VaultSecrets) => Promise<void>) | null = null
    let entry: CachedSession | null = null
    const session = this.ctx.client.session({
      serverUrl: input.serverUrl,
      deviceId: input.deviceId,
      secrets,
      onSecretsChanged: async (next) => {
        secrets = next
        if (persist) await persist(next)
      },
      onSynced: async (snapshot) => {
        if (entry) {
          await this.synced(id, snapshot)
          // 违规检查通过之后再存：被拒的那份同步结果不进缓存
          entry.collections = snapshot.collections
        }
      },
    })
    const snapshot = await session.snapshot().catch(loginFailure)
    const violation = snapshotViolation(snapshot)
    if (violation) throw new MemoryError(400, VIOLATION_TEXT[violation])

    const saved = await this.run(async (tx) => {
      const [same] = await tx
        .select()
        .from(vaultConnections)
        .where(
          and(
            eq(vaultConnections.ownerAccountId, this.ctx.ownerAccountId),
            eq(vaultConnections.serverUrl, input.serverUrl),
            eq(vaultConnections.vaultUserId, result.account.userId),
          ),
        )
        .for('update')
      id = same?.id ?? randomUUID()
      const now = new Date()
      // 最近检查时间和节流的比较（record）用同一个时钟：数据库的 now()
      const columns = {
        email: result.account.email,
        deviceId: input.deviceId,
        ...sealVaultSecrets(masterKey, id, secrets),
        status: 'ok' as const,
        disabledReason: null,
        lastErrorKind: null,
        lastErrorAt: null,
        lastCheckedAt: sql`now()`,
        disconnectedAt: null,
        updatedAt: now,
      }
      const [row] = same
        ? await tx
            .update(vaultConnections)
            .set(columns)
            .where(eq(vaultConnections.id, id))
            .returning()
        : await tx
            .insert(vaultConnections)
            .values({
              id,
              spaceId: this.ctx.spaceId,
              ownerAccountId: this.ctx.ownerAccountId,
              serverUrl: input.serverUrl,
              vaultUserId: result.account.userId,
              ...columns,
            })
            .returning()
      return { row: row!, view: await this.viewOf(tx, row!) }
    })
    entry = { ciphertext: saved.row.ciphertext!, session, collections: snapshot.collections }
    const cached = entry
    ENTRIES.set(session, cached)
    persist = (next) => this.saveSecrets(id, cached, next)
    this.cache.set(id, cached)
    return { kind: 'connected', connection: saved.view }
  }

  // 会话换了刷新令牌：密文没被别的请求换掉（重新登录、断开）时才写，写了就跟着更新缓存里记的密文
  private async saveSecrets(id: string, entry: CachedSession, next: VaultSecrets): Promise<void> {
    const masterKey = this.requireMasterKey()
    const sealed = sealVaultSecrets(masterKey, id, next)
    const [row] = await this.run((tx) =>
      tx
        .update(vaultConnections)
        .set({ ...sealed, updatedAt: new Date() })
        .where(
          and(
            eq(vaultConnections.id, id),
            eq(vaultConnections.ciphertext, entry.ciphertext),
            ne(vaultConnections.status, 'disconnected'),
          ),
        )
        .returning({ ciphertext: vaultConnections.ciphertext }),
    )
    if (row?.ciphertext) {
      entry.ciphertext = row.ciphertext
    } else if (this.cache.get(id) === entry) {
      this.cache.delete(id)
    }
  }

  // 每次换到新的访问令牌之后的同步：违规就停用连接，这次调用以「连接已停用」失败。恢复只在 check 与列出条目时做
  private async synced(id: string, snapshot: VaultSnapshot): Promise<void> {
    const violation = snapshotViolation(snapshot)
    if (!violation) return
    await this.run((tx) =>
      tx
        .update(vaultConnections)
        .set({ status: 'disabled', disabledReason: violation, updatedAt: new Date() })
        .where(and(eq(vaultConnections.id, id), ne(vaultConnections.status, 'disconnected'))),
    )
    throw new VaultDisabledError(violation)
  }

  // 会话最近一次同步读到的集合；还没同步过（或不是缓存里的会话）时为 undefined
  collectionsOf(session: VaultSession): VaultSnapshot['collections'] | undefined {
    return ENTRIES.get(session)?.collections
  }

  // 连接的会话：缓存里有、密文也没变就用它，否则解开密文新建一个。调用方先确认连接没有断开
  session(row: ConnectionRow): VaultSession {
    const ciphertext = row.ciphertext!
    const cached = this.cache.get(row.id)
    if (cached && cached.ciphertext.equals(ciphertext)) return cached.session
    const masterKey = this.requireMasterKey()
    const secrets = openVaultSecrets(masterKey, {
      id: row.id,
      ciphertext,
      wrappedKey: row.wrappedKey!,
      keyId: row.keyId,
    })
    const entry: CachedSession = {
      ciphertext,
      session: this.ctx.client.session({
        serverUrl: row.serverUrl,
        deviceId: row.deviceId,
        secrets,
        onSecretsChanged: (next) => this.saveSecrets(row.id, entry, next),
        onSynced: async (snapshot) => {
          await this.synced(row.id, snapshot)
          entry.collections = snapshot.collections
        },
      }),
    }
    ENTRIES.set(entry.session, entry)
    this.cache.set(row.id, entry)
    return entry.session
  }

  // 按 id 的顺序锁住几个连接这一行。锁的顺序：先连接、再这个连接下的凭据（按凭据 id），凭据只在锁着它的连接时才锁；
  // 一个事务要动几个连接（kioku run 跨连接取值、按值比对）时先用它一次锁全，连接按 id 排就不会互相等待成死锁
  async lock(tx: Tx, ids: readonly string[]): Promise<void> {
    if (!ids.length) return
    await tx
      .select({ id: vaultConnections.id })
      .from(vaultConnections)
      .where(inArray(vaultConnections.id, [...new Set(ids)]))
      .orderBy(asc(vaultConnections.id))
      .for('no key update')
  }

  // 按一次通信的结果更新连接，在调用方的事务里，取用的每一次第一段（prepare）之后都跟着它。
  // session 是这次用的会话：刷新令牌失效时只删它（所有者可能刚重新登录，缓存里已经是新的），
  // 改状态的条件用它最近一次保存的密文（这次调用里换过令牌时，和开始时读到的不同）。
  // 最后确认这一行现在还能不能用：断开、停用、需要重新登录或被删掉了，就把缓存里的会话删掉。
  // 并发的取用在断开提交之前读到可用、提交之后才建会话放回缓存的，在这里清掉。outcome 为 null 表示不改连接
  async record(
    tx: Tx,
    row: ConnectionRow,
    outcome: VaultOutcome | null,
    session?: VaultSession,
  ): Promise<void> {
    // 不管下面要不要改这一行都先锁住它：只在要改时才锁的话，没改的那次就没锁，调用方接着锁凭据
    // （observeRevisions、写回），之后同一个事务里再改连接，就成了先凭据、后连接，和同步互相等待成死锁
    await this.lock(tx, [row.id])
    const live = and(eq(vaultConnections.id, row.id), ne(vaultConnections.status, 'disconnected'))
    const entry = session ? ENTRIES.get(session) : undefined
    if (
      outcome?.kind === 'ok' ||
      (outcome?.kind === 'error' && outcome.error === 'item_unavailable')
    ) {
      // 每次取用都成功的话不必每次都写这一行：有最近的错误要清，或者上次检查已经过了一分钟才写。
      // 写入与比较都用数据库的时钟
      await tx
        .update(vaultConnections)
        .set({ lastErrorKind: null, lastErrorAt: null, lastCheckedAt: sql`now()` })
        .where(
          and(
            live,
            or(
              isNotNull(vaultConnections.lastErrorKind),
              isNull(vaultConnections.lastCheckedAt),
              lt(vaultConnections.lastCheckedAt, sql`now() - interval '1 minute'`),
            ),
          ),
        )
    } else if (outcome?.kind === 'error' && outcome.error === 'reauth_required') {
      if (entry ? this.cache.get(row.id) === entry : false) this.cache.delete(row.id)
      const used = entry?.ciphertext ?? row.ciphertext
      await tx
        .update(vaultConnections)
        .set({ status: 'reauth_required', disabledReason: null, updatedAt: new Date() })
        .where(and(live, used ? eq(vaultConnections.ciphertext, used) : undefined))
    } else if (outcome?.kind === 'error' && CONNECTION_ERRORS.has(outcome.error)) {
      await tx
        .update(vaultConnections)
        .set({ lastErrorKind: outcome.error, lastErrorAt: sql`now()` })
        .where(live)
    }
    const [now] = await tx
      .select({ status: vaultConnections.status, ciphertext: vaultConnections.ciphertext })
      .from(vaultConnections)
      .where(eq(vaultConnections.id, row.id))
    if (!now || now.status !== 'ok' || !now.ciphertext) this.forget(row.id)
  }

  // 同步一次：停用的原因消失了就恢复成可用，没消失就照旧停用。出错时更新状态，快照为 null；
  // failed 是这次同步本身失败的原因（连接本身的问题，已记进最近的错误），别的情况为 null
  private async sync(row: ConnectionRow): Promise<{
    snapshot: VaultSnapshot | null
    row: ConnectionRow
    failed: VaultErrorKind | null
  }> {
    if (row.status === 'disconnected') {
      throw new MemoryError(409, '连接已断开，请重新登录')
    }
    // 刷新令牌已经失效，同步也是同样的结果，不再请求密码库
    if (row.status === 'reauth_required') return { snapshot: null, row, failed: null }
    let snapshot: VaultSnapshot | null = null
    let outcome: VaultOutcome
    const session = this.session(row)
    try {
      snapshot = await session.snapshot()
      outcome = { kind: 'ok' }
    } catch (err) {
      if (err instanceof VaultDisabledError) outcome = { kind: 'disabled' }
      else if (err instanceof VaultError) outcome = { kind: 'error', error: err.kind }
      else throw err
    }
    const updated = await this.run(async (tx) => {
      // 拿到快照之后自己再查一遍，不只靠客户端在 onSynced 里抛错：换一个客户端、或者 snapshot() 走了别的路径，
      // 违规的连接也不会被恢复。判断与 onSynced 是同一个 snapshotViolation
      // 锁的顺序：先连接、再凭据（凭据按 id）。取用、写回与按值比对都是 record 先锁连接、再看修改时间，
      // 这里也先锁连接这一行（改连接的条件不成立时 UPDATE 不加锁），再 observeRevisions，否则两边并发会互相等待成死锁
      await this.lock(tx, [row.id])
      if (snapshot) {
        const violation = snapshotViolation(snapshot)
        await tx
          .update(vaultConnections)
          .set({
            status: violation ? 'disabled' : 'ok',
            disabledReason: violation,
            lastErrorKind: null,
            lastErrorAt: null,
            lastCheckedAt: sql`now()`,
            updatedAt: new Date(),
          })
          .where(and(eq(vaultConnections.id, row.id), ne(vaultConnections.status, 'disconnected')))
        await refreshDestinationName(tx, row, snapshot)
        await observeRevisions(tx, row.id, snapshot.items)
        if (violation) this.forget(row.id)
      } else if (outcome.kind === 'disabled') {
        await tx
          .update(vaultConnections)
          .set({ lastErrorKind: null, lastErrorAt: null, lastCheckedAt: sql`now()` })
          .where(eq(vaultConnections.id, row.id))
        this.forget(row.id)
      } else {
        await this.record(tx, row, outcome, session)
      }
      return this.own(tx, row.id)
    })
    const failed =
      outcome.kind === 'error' && CONNECTION_ERRORS.has(outcome.error) ? outcome.error : null
    return { snapshot, row: updated, failed }
  }

  // 这次同步本身失败（连不上、意外的响应、认不出的内容、校验不过）时记下最近的错误之后报错，停用的连接也一样；
  // 别的结果（停用、需要重新登录、条目不可用、别的请求刚换过令牌）照常返回连接
  // 结果带上这次同步读到的集合（选去处用）；没同步成（需要重新登录）时为空
  async check(id: string): Promise<VaultCheckResult> {
    const row = await this.run((tx) => this.own(tx, id))
    const { snapshot, row: updated, failed } = await this.sync(row)
    if (failed) throw syncFailure('check', updated, failed)
    return {
      connection: await this.run((tx) => this.viewOf(tx, updated)),
      collections: snapshot ? collectionsOf(snapshot) : [],
    }
  }

  // 设去处：连接要可用，先同步一次（事务外），集合要在这个账号读得到的集合里、不是只读。
  // 写库时先清掉这个成员别的连接上的去处，再设这一个；并发时由唯一索引挡下（409）
  async setDestination(id: string, collectionId: string): Promise<VaultConnectionList> {
    const row = await this.run((tx) => this.own(tx, id))
    if (row.status !== 'ok' || !row.ciphertext) {
      throw new MemoryError(409, '密码库连接不可用，请先重新检查或重新登录')
    }
    const { snapshot, row: updated, failed } = await this.sync(row)
    if (!snapshot || updated.status !== 'ok') throw syncFailure('destination', updated, failed)
    const collection = snapshot.collections.find((c) => c.id === collectionId)
    if (!collection) throw new MemoryError(400, '集合不存在或不可用')
    if (collection.readOnly) throw new MemoryError(400, '集合只读，请选择可以编辑的集合')
    try {
      await this.run(async (tx) => {
        await tx
          .update(vaultConnections)
          .set(NO_DESTINATION)
          .where(
            and(
              eq(vaultConnections.ownerAccountId, this.ctx.ownerAccountId),
              ne(vaultConnections.id, id),
              isNotNull(vaultConnections.defaultCollectionId),
            ),
          )
        await tx
          .update(vaultConnections)
          .set({
            defaultCollectionId: collection.id,
            defaultOrganizationId: collection.organizationId,
            defaultCollectionName: collection.name,
          })
          .where(eq(vaultConnections.id, id))
      })
    } catch (err) {
      if (isUniqueViolation(err, 'vault_connections_destination_idx')) {
        throw new MemoryError(409, '另一个请求刚设了去处，请刷新后重试')
      }
      throw err
    }
    return this.list()
  }

  // 清除去处：没设也照常返回列表
  async clearDestination(id: string): Promise<VaultConnectionList> {
    await this.run(async (tx) => {
      await this.own(tx, id)
      await tx.update(vaultConnections).set(NO_DESTINATION).where(eq(vaultConnections.id, id))
    })
    return this.list()
  }

  // 成员的去处所在的连接（新建凭据用）：没设时为 undefined
  async destination(tx: Tx): Promise<ConnectionRow | undefined> {
    const [row] = await tx
      .select()
      .from(vaultConnections)
      .where(
        and(
          eq(vaultConnections.ownerAccountId, this.ctx.ownerAccountId),
          isNotNull(vaultConnections.defaultCollectionId),
        ),
      )
    return row
  }

  // 列出连接读得到的条目，顺带同步一次。停用、需要重新登录或出错时说明原因
  async items(id: string): Promise<VaultItemList> {
    const row = await this.run((tx) => this.own(tx, id))
    const { snapshot, row: updated, failed } = await this.sync(row)
    if (!snapshot || updated.status !== 'ok') throw syncFailure('items', updated, failed)
    const bound = await this.run((tx) =>
      tx
        .select({
          id: credentials.id,
          identifier: credentials.identifier,
          itemId: credentials.vaultItemId,
        })
        .from(credentials)
        .where(and(eq(credentials.vaultConnectionId, id), isNull(credentials.deletedAt))),
    )
    const byItem = new Map(bound.map((b) => [b.itemId!, { id: b.id, identifier: b.identifier }]))
    return {
      items: [...snapshot.items]
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map((item) => ({
          id: item.id,
          organizationId: item.organizationId,
          collectionIds: item.collectionIds,
          name: item.name,
          type: item.type,
          fields: item.fields,
          revisionDate: item.revisionDate,
          credential: byItem.get(item.id) ?? null,
        })),
      unreadableCount: snapshot.unreadableItemCount,
      collections: collectionsOf(snapshot),
      organizations: snapshot.organizations.map((o) => ({ id: o.id, name: o.name })),
    }
  }

  // 断开：立即清掉令牌与密钥，这一行与指着它的凭据留着。要让 Kioku 手里的旧令牌立即失效，在密码库的设备列表里注销它
  async disconnect(id: string): Promise<VaultConnection> {
    this.forget(id)
    const view = await this.run(async (tx) => {
      const row = await this.own(tx, id)
      if (row.status === 'disconnected') return this.viewOf(tx, row)
      const now = new Date()
      const [updated] = await tx
        .update(vaultConnections)
        .set({
          ciphertext: null,
          wrappedKey: null,
          keyId: null,
          status: 'disconnected',
          disabledReason: null,
          disconnectedAt: now,
          updatedAt: now,
        })
        .where(eq(vaultConnections.id, id))
        .returning()
      return this.viewOf(tx, updated!)
    })
    // 提交之前并发的取用可能读到还连着、又建了会话放回缓存：提交之后再清一次。
    // 提交之后才读到的取用看到已断开，会自己清掉（CredentialService 的 prepare）
    this.forget(id)
    return view
  }
}

const NO_DESTINATION = {
  defaultCollectionId: null,
  defaultOrganizationId: null,
  defaultCollectionName: null,
} as const

function collectionsOf(snapshot: VaultSnapshot): VaultCollection[] {
  return [...snapshot.collections]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      organizationId: c.organizationId,
      name: c.name,
      readOnly: c.readOnly,
    }))
}

// 同步时集合改了名：去处跟着记新的名称。集合不见了的照旧留着，新建时按密码库的错误失败
async function refreshDestinationName(
  tx: Tx,
  row: ConnectionRow,
  snapshot: VaultSnapshot,
): Promise<void> {
  if (!row.defaultCollectionId) return
  const collection = snapshot.collections.find((c) => c.id === row.defaultCollectionId)
  if (!collection) return
  await tx
    .update(vaultConnections)
    .set({ defaultCollectionName: collection.name })
    .where(
      and(
        eq(vaultConnections.id, row.id),
        eq(vaultConnections.defaultCollectionId, collection.id),
        ne(vaultConnections.defaultCollectionName, collection.name),
      ),
    )
}

// 条目的修改时间原样记下；能解析成时间的也写进上次改值的时间
const revisionTime = (revision: string): Date | null => {
  const at = new Date(revision)
  return Number.isNaN(at.getTime()) ? null : at
}

// Kioku 看到了条目现在的修改时间（取用、列条目、重新检查、按值比对、写回冲突之后）：比记下的晚 1 秒以上
// （isNewerRevision）就是值在别处改过，记下新的修改时间与上次改值的时间，版本号加一（带着旧版本号的修改返回 409，
// 要先重新读取），清掉「需要轮换」。相差不到 1 秒的算同一个，更早的不记：并发的读取可能晚一步带回更早的修改时间。
// 还没记下过修改时间的（刚起标识、迁移之前的）只记下，不算改过值。已删除的凭据不动，恢复之后下一次看到时再比。
// 锁的顺序：调用方先锁连接（vault.record、vault.lock、sync 里改连接那一行），这里再按凭据 id 锁凭据
export async function observeRevisions(
  tx: Tx,
  connectionId: string,
  items: readonly { id: string; revisionDate: string }[],
): Promise<void> {
  if (!items.length) return
  const bound = await tx
    .select({
      id: credentials.id,
      itemId: credentials.vaultItemId,
      seen: credentials.vaultRevision,
    })
    .from(credentials)
    // 只读这几个条目对应的凭据：取用时只看到一个条目，完整同步时调用方传全部条目
    .where(
      and(
        eq(credentials.vaultConnectionId, connectionId),
        inArray(
          credentials.vaultItemId,
          items.map((i) => i.id),
        ),
        isNull(credentials.deletedAt),
      ),
    )
  const revisions = new Map(items.map((i) => [i.id, i.revisionDate]))
  // 按 id 排序加锁，和别的批量写入一样
  for (const b of [...bound].sort((x, y) => x.id.localeCompare(y.id))) {
    const revision = revisions.get(b.itemId!)
    if (revision === undefined) continue
    if (b.seen !== null && !isNewerRevision(revision, b.seen)) continue
    const changed = b.seen !== null
    await tx
      .update(credentials)
      .set({
        vaultRevision: revision,
        valueChangedAt: revisionTime(revision),
        ...(changed
          ? {
              version: sql`${credentials.version} + 1`,
              rotationRequestedAt: null,
              updatedAt: new Date(),
            }
          : {}),
      })
      .where(
        and(
          eq(credentials.id, b.id),
          isNull(credentials.deletedAt),
          // 读到之后被别的请求记下了同一个或更新的修改时间：照它们的，不重复加版本
          b.seen === null
            ? isNull(credentials.vaultRevision)
            : eq(credentials.vaultRevision, b.seen),
        ),
      )
  }
}
