import { randomUUID } from 'node:crypto'

import {
  ConvertibleValue,
  CREDENTIAL_ACCESS_REASON_NAMES,
  CREDENTIAL_EXPIRING_DAYS,
  defaultCredentialFields,
  MAX_CREDENTIAL_FIELDS,
  VAULT_DISABLED_REASON_NAMES,
  VAULT_ERROR_KIND_NAMES,
  VAULT_LOGIN_FIELD_NAMES,
  type ConsoleCredential,
  type ConsoleCredentialList,
  type ConvertTarget,
  type CreateCredentialRequest,
  type CreatedCredential,
  type CredentialAccess,
  type CredentialAccessReason,
  type CredentialAccessResult,
  type CredentialEventList,
  type CredentialEventQuery,
  type CredentialExpiry,
  type CredentialField,
  type CredentialFieldRef,
  type CredentialListQuery,
  type CredentialReferenceList,
  type CredentialStoredIn,
  type CredentialSummary,
  type CredentialValueMatches,
  type CredentialValues,
  type KeyCreateCredentialRequest,
  type KeyCreatedCredential,
  type KeyCredentialList,
  type KeyUpdateCredentialRequest,
  type OrphanVaultItem,
  type ResolvedCredentials,
  type UpdateCredentialRequest,
} from '@kioku/contracts'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm'

import { canUseCredential, credentialDenial, type Access } from '../access/access'
import { decryptSecret, encryptSecret } from '../crypto/envelope'
import { decryptionKey, encryptionKey, type MasterKey } from '../crypto/keyring'
import { isUniqueViolation, logInternalError, withSpace, type Db, type Tx } from '../db/client'
import {
  accounts,
  apiKeys,
  apps,
  credentialEvents,
  credentials,
  memories,
  memoryCredentialRefs,
  vaultConnections,
} from '../db/schema'
import { STILL_VALID } from '../memory/filter'
import { hasMaskedText } from '../memory/masked'
import { benchMarkReader, MemoryError, versionConflict } from '../memory/service'
import { formatUri } from '../memory/uri'
import { inlineText } from '../recall/text'
import {
  VaultError,
  type VaultClient,
  type VaultItem,
  type VaultNewItem,
  type VaultSession,
  type VaultSnapshot,
} from './bitwarden/types'
import { CREDENTIAL_NOTICE } from './methods'
import { totpCode } from './bitwarden/totp'
import {
  isNewerRevision,
  observeRevisions,
  VaultConnections,
  reasonStatus,
  VaultDisabledError,
  vaultReason,
  type ConnectionRow,
  type VaultOutcome,
} from './vault'
import { unavailableVaultClient } from './vaultClient'

export interface CredentialContext {
  db: Db
  spaceId: string
  // 凭据按这次访问代表的成员找：管理界面是成员本人，Key 是应用所有者
  access: Access
  masterKey: MasterKey | null
  vault?: VaultClient | undefined
  actor: { keyId?: string; accountId?: string }
  // 通过 Key 来的会话上下文（不带的是 none），记进访问事件；管理界面为 undefined
  chatType?: string
  // 测试台：取用一律不给值、不记访问，也不向密码库请求。结果会显示在界面上、导出成场景，也会发给接入的模型
  bench?: boolean
  // 这次写下的事件都带上这些 context：测试台的标记（bench: { account, run }）
  eventContext?: Record<string, unknown>
}

// 测试台里读到的是占位文字，照抄回来就成了新的值，而事件不留旧值，找不回来
const MASKED_TEXT_WRITTEN = '值含测试台的占位文字，并非真实内容。如需修改，请到凭据页操作。'

// 取用经由哪里，记在访问事件里
export type CredentialVia = 'kioku_credential' | 'rest' | 'run' | 'console' | 'space_export'

// kioku_get 末尾列出的一条凭据：只说能不能取用，不给值，也不记访问
export interface PlaceholderCredential {
  identifier: string
  // usable 能取用；unavailable 无权查看或不存在；其余是取用时会以它失败的原因：
  // 没配主密钥（托管的与密码库的都解不开），或者密码库连接的状态
  state: 'usable' | 'unavailable' | 'master_key' | 'disconnected' | 'reauth_required' | 'disabled'
  // 看得到这条凭据时给名称
  name: string | null
}

type CredentialRow = typeof credentials.$inferSelect

// 改了凭据的哪些部分，记在修改事件里（不含任何值）
type CredentialChange =
  'name' | 'description' | 'values' | 'fields' | 'appIds' | 'expiresAt' | 'needsRotation'

const DAY_MS = 24 * 60 * 60 * 1000

// 到期的状态（CredentialExpiry）：到期时间那一刻起算已到期，离到期不到 7 天（含正好 7 天）算快到期。
// SQL 的一份是 CREDENTIAL_ATTENTION 里的到期部分，两边由 credentialExpiry.int.test.ts 比对
export function credentialExpiry(expiresAt: Date | null, now: number): CredentialExpiry | null {
  if (!expiresAt) return null
  const left = expiresAt.getTime() - now
  if (left <= 0) return 'expired'
  return left <= CREDENTIAL_EXPIRING_DAYS * DAY_MS ? 'expiring' : null
}

// 待处理的「凭据」一类：快到期、已到期或标了需要轮换。调用方另外限定所有者与没删除
export const CREDENTIAL_ATTENTION: SQL = sql`(${credentials.rotationRequestedAt} is not null or ${credentials.expiresAt} <= now() + interval '${sql.raw(String(CREDENTIAL_EXPIRING_DAYS))} days')`

// 交出值时记下的值版本：托管的是值版本号，密码库的是读到的条目修改时间
type ValueRevision = { valueVersion: number } | { itemRevision: string }

// 修改凭据的请求：管理界面的整个请求，Key 的少了字段对应、限定的应用与需要轮换
type ModifyInput = Omit<UpdateCredentialRequest, 'appIds'> & {
  appIds?: string[] | null | undefined
}

// 一次列出的凭据上限，个人用的空间远到不了
const LIST_LIMIT = 1000
// 凭据详情里最多列出这么多条引用它的记忆
const REFERENCE_LIMIT = 200

// 算数的引用：凭据所有者本人的记忆里没删除、不是 secret、仍有效的（索引按正文重写，状态在这里判断）
const effectiveRef = (ownerAccountId: string) =>
  and(
    eq(memories.id, memoryCredentialRefs.memoryId),
    eq(memories.ownerAccountId, ownerAccountId),
    eq(memories.layer, 'user'),
    isNull(memories.deletedAt),
    ne(memories.sensitivity, 'secret'),
    STILL_VALID,
  )
const EVENT_ID = /^\d{1,15}$/

// 托管的值整体加密，aad 绑定凭据 id：把一条凭据的密文挪到别的凭据或记忆上会解密失败
export const credentialAad = (id: string) => `credential:${id}`

// 托管的值：各字段整体写成一个 JSON 对象加密。服务与空间的导入导出共用
export function sealCredentialValues(
  masterKey: MasterKey,
  id: string,
  values: Record<string, string>,
): { ciphertext: Buffer; wrappedKey: Buffer; keyId: string } {
  const { key, id: keyId } = encryptionKey(masterKey)
  return { ...encryptSecret(key, JSON.stringify(values), credentialAad(id)), keyId }
}

export function openCredentialValues(
  masterKey: MasterKey,
  row: { id: string; ciphertext: Buffer; wrappedKey: Buffer; keyId: string | null },
): Record<string, string> {
  const text = decryptSecret(
    decryptionKey(masterKey, row.keyId),
    { ciphertext: row.ciphertext, wrappedKey: row.wrappedKey },
    credentialAad(row.id),
  )
  return JSON.parse(text) as Record<string, string>
}

// 从解开的条目里取出凭据的字段。totp 给现算的验证码，密钥本身不出 Kioku。条目里没有的字段报 field_missing
export function itemValues(
  item: VaultItem,
  fields: readonly CredentialField[],
  now: number = Date.now(),
): Record<string, string> | CredentialAccessReason {
  const values: Record<string, string> = {}
  for (const f of fields) {
    const value = f.itemField ? item.values[f.itemField] : undefined
    if (value === undefined || value === '') return 'field_missing'
    if (f.itemField === 'login.totp') {
      try {
        values[f.name] = totpCode(value, now)
      } catch (err) {
        if (err instanceof VaultError && err.kind === 'unsupported_format') return 'vault_error'
        throw err
      }
    } else {
      values[f.name] = value
    }
  }
  return values
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// 被拒的说法：能力、范围与会话上下文不看凭据存不存在，一律 403；限定给别的应用的和不存在一样是 404
function denialError(
  reason: CredentialAccessReason,
  need: 'use' | 'manage',
  identifier: string,
  viaKey = true,
) {
  switch (reason) {
    case 'capability':
      if (!viaKey) return new MemoryError(403, '仅空间所有者可管理凭据与密码库连接')
      return new MemoryError(
        403,
        need === 'use'
          ? '访问密钥的凭据能力不足：取用凭据需要「取用」或「管理」'
          : '访问密钥的凭据能力不足：新建、修改、删除凭据需要「管理」',
      )
    case 'scope':
      return new MemoryError(
        403,
        need === 'use'
          ? '凭据需要可读本人（user）、敏感级上限不低于私密（private）的访问密钥'
          : '管理凭据需要可读写本人（user）、敏感级上限不低于私密（private）的访问密钥',
      )
    case 'context':
      return new MemoryError(403, '带会话上下文（群聊、私聊、定时任务、子 agent）时不能使用凭据')
    default:
      return new MemoryError(404, `凭据不存在：${identifier}`)
  }
}

// 取不到值的说法：连接与条目的状态问题 409，密码库连不上或内容认不出 502，主密钥的问题 400
function failureError(
  reason: CredentialAccessReason,
  identifier: string,
  detail?: string,
): MemoryError {
  const text = `取不到 ${identifier} 的值：${CREDENTIAL_ACCESS_REASON_NAMES[reason]}${detail ? `（${detail}）` : ''}`
  return new MemoryError(reasonStatus(reason), text)
}

// 一次取几个字段时，错误写出是哪一项（标识#字段），不带任何值
const refText = (ref: CredentialFieldRef) => `${ref.identifier}#${ref.field}`
// 取不到值时写在哪：某个字段缺失时写「标识#字段」，整条凭据的失败只写标识
const failedAt = (identifier: string, field: string | undefined) =>
  field ? `${identifier}#${field}` : identifier

// 准备过的一个密码库会话
type PreparedSession = { connection: ConnectionRow; session: VaultSession }
const refError = (ref: CredentialFieldRef, err: MemoryError) =>
  new MemoryError(err.status, `${refText(ref)}：${err.message}`)

// 取用前对一条凭据的检查：通过时给出要取的字段；被拒（app 的说法和不存在一样）、不存在、没有这个字段
type UseCheck =
  | { kind: 'ok'; row: CredentialRow; fields: CredentialField[] }
  | { kind: 'denied'; reason: CredentialAccessReason }
  | { kind: 'not_found' }
  | { kind: 'no_field'; field: string }

interface AccessRecord {
  via: CredentialVia
  fields: string[]
  purpose: string | undefined
  result: CredentialAccessResult
  reason: CredentialAccessReason | null
  // 交出值时这个值的版本（见 CredentialEvent.sinceValueChange）
  revision?: ValueRevision
}

// 取值第一段的结果：已经有值（托管的）、要向密码库取（密码库的），或者失败（已记好事件，提交之后抛出）
type Prepared =
  | { kind: 'values'; values: Record<string, string> | null }
  | { kind: 'vault'; connection: ConnectionRow; session: VaultSession }
  // 失败：错误的文字由抛出的地方组装；field 是引起失败的字段（缺值的那个），整条凭据的失败没有
  | { kind: 'error'; reason: CredentialAccessReason; detail?: string; field?: string }

// 第二段向密码库取条目的结果，第三段按它记访问事件、更新连接。
// unexpected 不是密码库报的错（解不开重读的密文、保存新令牌时的数据库错误等），记一条失败后原样抛出
interface VaultCall<T> {
  connection: ConnectionRow
  used: VaultSession
  outcome: VaultOutcome | null
  value: T | undefined
  error: unknown
}

interface Fetched {
  connection: ConnectionRow
  // 这次真正用的会话：重试时换成新建的那个，record 按它判断要删哪个缓存
  used: VaultSession
  outcome: VaultOutcome | null
  result: Record<string, string> | CredentialAccessReason
  // result 为 field_missing 时，条目里缺的是哪个字段
  missing?: string
  // 取到了条目时它的 id 与修改时间：记进访问事件，也按它看条目有没有在别处改过
  item?: { id: string; revisionDate: string }
  unexpected: unknown
}

export class CredentialService {
  readonly vault: VaultConnections

  constructor(private readonly ctx: CredentialContext) {
    this.vault = new VaultConnections({
      db: ctx.db,
      spaceId: ctx.spaceId,
      ownerAccountId: ctx.access.ownerAccountId,
      masterKey: ctx.masterKey,
      client: ctx.vault ?? FALLBACK_CLIENT,
    })
  }

  // 这次是不是接入方通过 Key 来的：管理界面不代表某个应用，appId 为 null
  private get viaKey(): boolean {
    return this.ctx.access.appId !== null
  }

  private get owner(): string {
    return this.ctx.access.ownerAccountId
  }

  // 标识冲突由唯一索引判断（同一成员的有效凭据里唯一），在这里转成 409
  private async run<T>(fn: (tx: Tx) => Promise<T>, conflict?: string): Promise<T> {
    try {
      return await withSpace(this.ctx.db, this.ctx.spaceId, fn)
    } catch (err) {
      if (isUniqueViolation(err, 'credentials_identifier_live_idx')) {
        throw new MemoryError(409, conflict ?? '标识已被占用或不可用')
      }
      if (isUniqueViolation(err, 'credentials_vault_item_live_idx')) {
        throw new MemoryError(409, '这个条目已经起过标识，一个条目只对应一条有效凭据')
      }
      throw err
    }
  }

  // 列出、取用：凭据能力至少是取用。不看凭据存不存在，没有权限时一律 403
  requireUse(): void {
    const denial = credentialDenial(this.ctx.access, { appIds: null }, 'use')
    if (denial) throw denialError(denial, 'use', '', this.viaKey)
  }

  // 新建、修改、删除凭据，连接密码库，管理界面里查看值：凭据能力是管理
  requireManage(): void {
    const denial = credentialDenial(this.ctx.access, { appIds: null }, 'manage')
    if (denial) throw denialError(denial, 'manage', '', this.viaKey)
  }

  private seal(id: string, values: Record<string, string>) {
    if (!this.ctx.masterKey) {
      throw new MemoryError(400, '服务端未配置 KIOKU_MASTER_KEY，无法保存托管的凭据')
    }
    return sealCredentialValues(this.ctx.masterKey, id, values)
  }

  private open(row: CredentialRow): Record<string, string> {
    if (!row.ciphertext || !row.wrappedKey) return {}
    if (!this.ctx.masterKey) {
      throw new MemoryError(400, '服务端未配置 KIOKU_MASTER_KEY，无法解密托管的凭据')
    }
    return openCredentialValues(this.ctx.masterKey, {
      ...row,
      ciphertext: row.ciphertext,
      wrappedKey: row.wrappedKey,
    })
  }

  private async event(
    tx: Tx,
    credentialId: string,
    eventType: 'create' | 'update' | 'delete' | 'undelete' | 'access',
    context: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.insert(credentialEvents).values({
      spaceId: this.ctx.spaceId,
      credentialId,
      eventType,
      actorKeyId: this.ctx.actor.keyId ?? null,
      actorAccountId: this.ctx.actor.accountId ?? null,
      context: { ...this.ctx.eventContext, ...context },
    })
  }

  // 访问事件：交出值、被拒或失败才记。测试台不记
  private async accessEvent(tx: Tx, credentialId: string, record: AccessRecord): Promise<void> {
    if (this.ctx.bench) return
    await this.event(tx, credentialId, 'access', {
      via: record.via,
      fields: record.fields,
      ...(record.purpose ? { purpose: record.purpose } : {}),
      result: record.result,
      ...(record.reason ? { reason: record.reason } : {}),
      ...(this.ctx.chatType ? { chatType: this.ctx.chatType } : {}),
      ...record.revision,
    })
  }

  // ---- 读出与视图 ----

  private base(row: CredentialRow) {
    return {
      id: row.id,
      identifier: row.identifier,
      name: row.name,
      description: row.description,
      source: row.source,
      version: row.version,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expiry: credentialExpiry(row.expiresAt, Date.now()),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  private summary(row: CredentialRow): CredentialSummary {
    return { ...this.base(row), fields: row.fields.map((f) => f.name) }
  }

  private consoleView(row: CredentialRow, references: Map<string, number>): ConsoleCredential {
    return {
      ...this.base(row),
      fields: row.fields,
      vault:
        row.source === 'vault'
          ? { connectionId: row.vaultConnectionId!, itemId: row.vaultItemId! }
          : null,
      appIds: row.appIds,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      // 引用按标识解析到有效的那一条；已删除的这条不算被谁引用（同名的有效凭据可能正被引用着）
      referenceCount: row.deletedAt ? 0 : (references.get(row.identifier) ?? 0),
      rotationRequestedAt: row.rotationRequestedAt?.toISOString() ?? null,
      valueChangedAt: row.valueChangedAt?.toISOString() ?? null,
    }
  }

  // 各标识被多少条记忆引用（只算 effectiveRef 的）
  private async referenceCounts(tx: Tx, identifiers: string[]): Promise<Map<string, number>> {
    if (!identifiers.length) return new Map()
    const rows = await tx
      .select({ identifier: memoryCredentialRefs.identifier, n: count() })
      .from(memoryCredentialRefs)
      .innerJoin(memories, effectiveRef(this.owner))
      .where(inArray(memoryCredentialRefs.identifier, [...new Set(identifiers)]))
      .groupBy(memoryCredentialRefs.identifier)
    return new Map(rows.map((r) => [r.identifier, r.n]))
  }

  private async consoleViewOf(tx: Tx, row: CredentialRow): Promise<ConsoleCredential> {
    return this.consoleView(row, await this.referenceCounts(tx, [row.identifier]))
  }

  // 管理界面：按 id 找成员自己的凭据，已删除的也算；不是自己的和不存在一样是 404
  private async ownById(tx: Tx, id: string): Promise<CredentialRow> {
    const [row] = await tx
      .select()
      .from(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.ownerAccountId, this.owner)))
    if (!row) throw new MemoryError(404, '凭据不存在')
    return row
  }

  private async liveByIdentifier(tx: Tx, identifier: string): Promise<CredentialRow | undefined> {
    const [row] = await tx
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.ownerAccountId, this.owner),
          eq(credentials.identifier, identifier),
          isNull(credentials.deletedAt),
        ),
      )
    return row
  }

  // Key 管理凭据：按标识找应用所有者的有效凭据。不存在与限定给别的应用的一律 404
  private async manageableByIdentifier(tx: Tx, identifier: string): Promise<CredentialRow> {
    const row = await this.liveByIdentifier(tx, identifier)
    if (!row || !canUseCredential(this.ctx.access, row)) {
      throw new MemoryError(404, `凭据不存在：${identifier}`)
    }
    return row
  }

  // 测试台里读到的是占位文字，照抄回来就成了新的值
  private rejectMaskedText(values: Record<string, string | null> | undefined): void {
    if (!this.ctx.bench || !values) return
    if (Object.values(values).some((v) => v !== null && hasMaskedText(v))) {
      throw new MemoryError(400, MASKED_TEXT_WRITTEN)
    }
  }

  // 托管的值与现有的合并：给了 null 的字段删掉，没给的不变
  private hostedColumns(
    id: string,
    values: Record<string, string | null>,
    before: CredentialRow | null,
  ) {
    this.rejectMaskedText(values)
    const current = before ? this.open(before) : {}
    const merged: Record<string, string> = { ...current }
    for (const [name, value] of Object.entries(values)) {
      if (value === null) delete merged[name]
      else merged[name] = value
    }
    const names = Object.keys(merged).sort()
    if (!names.length) throw new MemoryError(400, '托管的凭据至少需要一个字段')
    if (names.length > MAX_CREDENTIAL_FIELDS) {
      throw new MemoryError(400, `一条凭据最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)
    }
    const changedValues = [...new Set([...Object.keys(current), ...names])]
      .filter((name) => current[name] !== merged[name])
      .sort()
    // 值没变时不动密文这几列：不再加密一遍，也不把读到的旧值写回去（轮换主密钥可能刚换过它们的包装）
    const sealed =
      before && !changedValues.length
        ? {}
        : this.seal(id, Object.fromEntries(names.map((n) => [n, merged[n]!])))
    return {
      columns: {
        fields: names.map((name): CredentialField => ({ name, itemField: null })),
        ...sealed,
      },
      changedValues,
    }
  }

  // ---- 写入（管理界面与 Key 共用）----

  private async insertHosted(
    tx: Tx,
    input: Pick<KeyCreateCredentialRequest, 'identifier' | 'name' | 'description' | 'values'> & {
      expiresAt?: string | null | undefined
    },
    appIds: string[] | null,
  ): Promise<CredentialRow> {
    this.requireManage()
    const id = randomUUID()
    const { columns } = this.hostedColumns(id, input.values, null)
    const [row] = await tx
      .insert(credentials)
      .values({
        id,
        spaceId: this.ctx.spaceId,
        ownerAccountId: this.owner,
        identifier: input.identifier,
        name: input.name,
        description: input.description ?? null,
        source: 'hosted',
        ...columns,
        appIds,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        valueChangedAt: new Date(),
      })
      .returning()
    await this.event(tx, id, 'create', { storedIn: 'hosted' })
    return row!
  }

  // 修改之前的检查，写回密码库之前也先做一遍（写进去之后才发现不能改就晚了）
  private checkModify(before: CredentialRow, input: ModifyInput): void {
    this.requireManage()
    if (before.deletedAt) throw new MemoryError(409, '这条凭据已删除。请先恢复，再修改。')
    if (input.expectedVersion !== before.version) {
      throw versionConflict(`版本已变化：当前是 ${before.version}，请先重新读取`)
    }
    if (input.fields !== undefined && before.source !== 'vault') {
      throw new MemoryError(400, '字段对应只用于密码库的凭据；托管的凭据改 values')
    }
    if (input.fields !== undefined && input.values !== undefined) {
      throw new MemoryError(400, '字段对应与值请分两次修改')
    }
    // 被诱导的 agent 不能给自己放宽，也不能替所有者清掉提醒
    if (input.appIds !== undefined && this.viaKey) {
      throw new MemoryError(403, '限定的应用只能在管理界面修改')
    }
    if (input.needsRotation !== undefined && this.viaKey) {
      throw new MemoryError(403, '「需要轮换」只能在管理界面修改')
    }
  }

  // 改凭据这一行。托管的 values 在这里加密；密码库的 values 已经写回了条目，written 是写回之后的条目、
  // 改了的字段与发给密码库的期望修改时间
  private async modify(
    tx: Tx,
    before: CredentialRow,
    input: ModifyInput,
    written?: Written,
  ): Promise<CredentialRow> {
    this.checkModify(before, input)
    const hasValues = input.values !== undefined && Object.keys(input.values).length > 0
    if (hasValues && before.source !== 'hosted' && !written) {
      throw new MemoryError(400, '密码库凭据的值要写回密码库')
    }
    const changes: CredentialChange[] = []
    const set: Partial<typeof credentials.$inferInsert> = {}
    if (input.name !== undefined && input.name !== before.name) {
      set.name = input.name
      changes.push('name')
    }
    if (input.description !== undefined && input.description !== before.description) {
      set.description = input.description
      changes.push('description')
    }
    let changedValues: string[] = []
    if (input.values !== undefined && before.source === 'hosted') {
      const next = this.hostedColumns(before.id, input.values, before)
      changedValues = next.changedValues
      if (changedValues.length) {
        Object.assign(set, next.columns)
        changes.push('values')
        if (!sameJson(next.columns.fields, before.fields)) changes.push('fields')
      }
    }
    if (input.fields !== undefined && !sameJson(input.fields, before.fields)) {
      set.fields = input.fields
      changes.push('fields')
    }
    if (input.appIds !== undefined) {
      const appIds = input.appIds === null ? null : [...new Set(input.appIds)].sort()
      if (!sameJson(appIds, before.appIds)) {
        set.appIds = appIds
        changes.push('appIds')
      }
    }
    if (input.expiresAt !== undefined) {
      const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt)
      if (expiresAt?.getTime() !== before.expiresAt?.getTime()) {
        set.expiresAt = expiresAt
        changes.push('expiresAt')
      }
    }
    if (input.needsRotation !== undefined && input.needsRotation !== !!before.rotationRequestedAt) {
      set.rotationRequestedAt = input.needsRotation ? new Date() : null
      changes.push('needsRotation')
    }
    // 值变了：托管的记下新的值版本，密码库的记下写回之后的条目修改时间；「需要轮换」一并清掉
    if (changedValues.length) {
      set.valueVersion = before.version + 1
      set.valueChangedAt = new Date()
      set.rotationRequestedAt = null
    }
    // 写回之后条目的修改时间没变：值都和原来相同，客户端没发修改，不算改了值（不清需要轮换）
    if (written && written.item.revisionDate !== written.expected) {
      changedValues = written.fields
      Object.assign(set, writtenRevision(before, written))
      set.rotationRequestedAt = null
      changes.push('values')
    }
    // 什么都没改时不升版本、不记事件：别的页面拿着同一个版本号还能接着改
    if (!changes.length) return before
    const [row] = await tx
      .update(credentials)
      .set({ ...set, version: sql`${credentials.version} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(credentials.id, before.id),
          eq(credentials.version, before.version),
          isNull(credentials.deletedAt),
        ),
      )
      .returning()
    if (!row) throw await this.raced(tx, before.id)
    await this.event(tx, before.id, 'update', {
      changes,
      ...(changedValues.length ? { fields: changedValues } : {}),
    })
    return row
  }

  // 读完之后、写入之前被别的请求改了：告诉调用方现在的版本号，接着改的时候带上它
  private async raced(tx: Tx, id: string): Promise<MemoryError> {
    const [now] = await tx
      .select({ version: credentials.version, deletedAt: credentials.deletedAt })
      .from(credentials)
      .where(eq(credentials.id, id))
    if (!now || now.deletedAt) return new MemoryError(409, '凭据刚被其他请求删除')
    return versionConflict(`版本已变化：当前是 ${now.version}，请先重新读取`)
  }

  private async remove(tx: Tx, before: CredentialRow, expectedVersion?: number): Promise<void> {
    this.requireManage()
    if (before.deletedAt) throw new MemoryError(409, '这条凭据已删除')
    if (expectedVersion !== undefined && expectedVersion !== before.version) {
      throw versionConflict(`版本已变化：当前是 ${before.version}，请先重新读取`)
    }
    // 先锁住凭据再数引用：和写入记忆时新增引用的检查互斥（那边以共享锁读凭据），
    // 删除期间不会冒出新的引用。已删除与 secret 的记忆不挡删除
    await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(eq(credentials.id, before.id))
      .for('update')
    const used = (await this.referenceCounts(tx, [before.identifier])).get(before.identifier) ?? 0
    if (used) {
      throw new MemoryError(409, `仍有 ${used} 条记忆引用此凭据。请先修改这些引用，再删除。`)
    }
    const [row] = await tx
      .update(credentials)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(credentials.id, before.id),
          eq(credentials.version, before.version),
          isNull(credentials.deletedAt),
        ),
      )
      .returning({ id: credentials.id })
    if (!row) throw await this.raced(tx, before.id)
    await this.event(tx, before.id, 'delete')
  }

  // ---- 取值 ----

  // 第一段，在调用方的事务里：托管的解开（并记访问事件），密码库的读连接、看状态、解开令牌与密钥。
  // 失败时访问事件已经记好，错误由调用方在事务提交之后抛出
  private async prepare(
    tx: Tx,
    row: CredentialRow,
    fields: CredentialField[],
    via: CredentialVia,
    purpose: string | undefined,
    // 托管的先不记交出：一次取几条时，后面的取不到就一个都不给，交出由调用方在最后记
    deferOk = false,
  ): Promise<Prepared> {
    const names = fields.map((f) => f.name)
    const record = (
      result: CredentialAccessResult,
      reason: CredentialAccessReason | null,
      revision?: ValueRevision,
    ) =>
      this.accessEvent(tx, row.id, {
        via,
        fields: names,
        purpose,
        result,
        reason,
        ...(revision ? { revision } : {}),
      })
    const fail = async (
      reason: CredentialAccessReason,
      detail?: string,
      field?: string,
    ): Promise<Prepared> => {
      await record('failed', reason)
      return { kind: 'error', reason, ...(detail ? { detail } : {}), ...(field ? { field } : {}) }
    }
    if (this.ctx.bench) return { kind: 'values', values: null }
    if (row.source === 'hosted') {
      let all: Record<string, string>
      try {
        if (!this.ctx.masterKey) return await fail('master_key')
        all = this.open(row)
      } catch (err) {
        if (err instanceof MemoryError) throw err
        return fail('master_key')
      }
      // 声明了字段却没有存值：和密码库的条目里缺字段一样算失败
      const lost = names.find((n) => all[n] === undefined)
      if (lost !== undefined) return fail('field_missing', undefined, lost)
      if (!deferOk) await record('ok', null, { valueVersion: row.valueVersion })
      return { kind: 'values', values: Object.fromEntries(names.map((n) => [n, all[n]!])) }
    }
    const connection = await this.vault.load(tx, row.vaultConnectionId!)
    // 连接不能用了（断开、需要重新登录、停用、被保留期删掉）：缓存里这个连接的会话一并删掉。
    // 断开与并发的取用交错时，会话可能在断开提交之后才放回缓存，靠这里清掉
    if (!connection || connection.status !== 'ok' || !connection.ciphertext) {
      this.vault.forget(row.vaultConnectionId!)
    }
    if (!connection || connection.status === 'disconnected' || !connection.ciphertext) {
      return fail('disconnected')
    }
    if (connection.status === 'disabled') {
      return fail(
        'disabled',
        connection.disabledReason
          ? VAULT_DISABLED_REASON_NAMES[connection.disabledReason]
          : undefined,
      )
    }
    if (connection.status === 'reauth_required') return fail('reauth_required')
    if (!this.ctx.masterKey) return fail('master_key')
    try {
      return { kind: 'vault', connection, session: this.vault.session(connection) }
    } catch (err) {
      if (err instanceof MemoryError) throw err
      return fail('master_key')
    }
  }

  // 交出一条凭据的值：第一段在 first 的事务里做完（prepare），第二段在事务外向密码库取条目，
  // 第三段另开一个短事务记访问事件、更新连接的状态。不在事务里请求外部服务
  private async deliver(
    row: CredentialRow,
    fields: CredentialField[],
    via: CredentialVia,
    purpose: string | undefined,
    prepared: Prepared,
  ): Promise<Record<string, string> | null> {
    if (prepared.kind === 'error') {
      throw failureError(prepared.reason, failedAt(row.identifier, prepared.field), prepared.detail)
    }
    if (prepared.kind === 'values') return prepared.values
    const fetched = await this.fetchItem(row, fields, prepared)
    const { result } = fetched
    const where = failedAt(row.identifier, fetched.missing)
    if (fetched.unexpected !== null) {
      // 记失败本身也可能出错（例如数据库连不上）：记进日志，抛出原来的错误
      await this.run((tx) => this.settle(tx, row, fields, via, purpose, fetched)).catch(
        (err: unknown) => logInternalError('凭据取用失败之后记访问事件出错', err),
      )
      // 解不开令牌和 prepare 里一样给出「主密钥不可用」；别的意外原样抛出，按内部错误处理
      if (result === 'master_key') throw failureError(result, where)
      throw fetched.unexpected
    }
    await this.run((tx) => this.settle(tx, row, fields, via, purpose, fetched))
    if (typeof result === 'string') throw failureError(result, where)
    return result
  }

  // 在事务外向密码库请求一次（取条目、取全部条目）。刷新令牌失效之前先重读一次：别的进程可能刚换过令牌（密文变了），
  // 用新的建会话再试一次，还是失败才算需要重新登录。不抛错：结果、这次真正用的会话与对连接的结论交给调用方，
  // 调用方都要接着在事务里 vault.record。error 为 null 表示成功
  private async vaultCall<T>(
    prepared: PreparedSession,
    fn: (session: VaultSession) => Promise<T>,
  ): Promise<VaultCall<T>> {
    let connection = prepared.connection
    let used = prepared.session
    try {
      let value: T
      try {
        value = await fn(used)
      } catch (err) {
        if (!(err instanceof VaultError) || err.kind !== 'reauth_required') throw err
        const fresh = await this.run((tx) => this.vault.load(tx, connection.id))
        if (
          !fresh ||
          fresh.status !== 'ok' ||
          !fresh.ciphertext ||
          fresh.ciphertext.equals(connection.ciphertext!)
        ) {
          throw err
        }
        connection = fresh
        try {
          used = this.vault.session(fresh)
        } catch (openErr) {
          throw new SecretsUnreadable(openErr)
        }
        value = await fn(used)
      }
      return { connection, used, outcome: { kind: 'ok' }, value, error: null }
    } catch (err) {
      // 不是密码库报的错（解不开重读的密文、数据库错误等）不改连接的状态
      const outcome: VaultOutcome | null =
        err instanceof VaultDisabledError
          ? { kind: 'disabled' }
          : err instanceof VaultError
            ? { kind: 'error', error: err.kind }
            : null
      return { connection, used, outcome, value: undefined, error: err }
    }
  }

  // 第二段：在事务外向密码库取条目，取出要的字段。不抛错，结果交给 settle 记下
  private async fetchItem(
    row: CredentialRow,
    fields: CredentialField[],
    prepared: Extract<Prepared, { kind: 'vault' }>,
  ): Promise<Fetched> {
    const call = await this.vaultCall(prepared, (session) => session.item(row.vaultItemId!))
    const { connection, used, outcome } = call
    let result: Record<string, string> | CredentialAccessReason
    let missing: string | undefined
    let seen: Fetched['item']
    let unexpected: unknown = null
    const err = call.error
    if (err === null) {
      const item = call.value!
      seen = { id: item.id, revisionDate: item.revisionDate }
      try {
        result = itemValues(item, fields)
        if (result === 'field_missing') {
          missing = fields.find((f) => itemValues(item, [f]) === 'field_missing')?.name
        }
      } catch (valueErr) {
        result = 'internal_error'
        unexpected = valueErr
      }
    } else if (err instanceof VaultDisabledError) {
      result = 'disabled'
    } else if (err instanceof VaultError) {
      result = vaultReason(err.kind)
    } else {
      // 和 prepare 里解不开令牌一样记成主密钥的问题；别的意外（数据库错误等）记成 Kioku 内部出错，
      // 不说成密码库的问题。连接的状态不改
      result = err instanceof SecretsUnreadable ? 'master_key' : 'internal_error'
      unexpected = err
    }
    return {
      connection,
      used,
      outcome,
      result,
      ...(missing ? { missing } : {}),
      ...(seen ? { item: seen } : {}),
      unexpected,
    }
  }

  // 第三段：按取条目的结果更新连接，记一条访问事件（record 为 false 时只更新连接）。
  // 出了意外的照样确认连接还能不能用，不能用就把缓存里的会话删掉
  private async settle(
    tx: Tx,
    row: CredentialRow,
    fields: CredentialField[],
    via: CredentialVia,
    purpose: string | undefined,
    fetched: Fetched,
    record = true,
  ): Promise<void> {
    await this.vault.record(tx, fetched.connection, fetched.outcome, fetched.used)
    // 读到了条目：修改时间变了就是值在别处改过（版本号加一、清掉需要轮换）
    if (fetched.item) await observeRevisions(tx, fetched.connection.id, [fetched.item])
    if (!record) return
    const failed = typeof fetched.result === 'string'
    await this.accessEvent(tx, row.id, {
      via,
      fields: fields.map((f) => f.name),
      purpose,
      result: failed ? 'failed' : 'ok',
      reason: failed ? (fetched.result as CredentialAccessReason) : null,
      ...(!failed && fetched.item ? { revision: { itemRevision: fetched.item.revisionDate } } : {}),
    })
  }

  // ---- 管理界面 ----

  // attention：只列待处理的「凭据」一类（快到期、已到期、需要轮换），和待处理的条数同一个条件
  async list(query: CredentialListQuery = {}): Promise<ConsoleCredentialList> {
    return this.listWhere(
      and(isNull(credentials.deletedAt), query.attention ? CREDENTIAL_ATTENTION : undefined)!,
      asc(credentials.identifier),
    )
  }

  // 已删除的，最近删除的在前
  async listDeleted(): Promise<ConsoleCredentialList> {
    return this.listWhere(isNotNull(credentials.deletedAt), desc(credentials.deletedAt))
  }

  private async listWhere(
    where: SQL,
    order: ReturnType<typeof asc>,
  ): Promise<ConsoleCredentialList> {
    this.requireUse()
    return this.run(async (tx) => {
      const rows = await tx
        .select()
        .from(credentials)
        .where(and(eq(credentials.ownerAccountId, this.owner), where))
        .orderBy(order, asc(credentials.id))
        .limit(LIST_LIMIT + 1)
      const page = rows.slice(0, LIST_LIMIT)
      const references = await this.referenceCounts(
        tx,
        page.map((r) => r.identifier),
      )
      return {
        items: page.map((r) => this.consoleView(r, references)),
        truncated: rows.length > LIST_LIMIT,
      }
    })
  }

  async get(id: string): Promise<ConsoleCredential> {
    this.requireUse()
    return this.run(async (tx) => this.consoleViewOf(tx, await this.ownById(tx, id)))
  }

  async create(input: CreateCredentialRequest): Promise<CreatedCredential> {
    this.requireManage()
    // 在管理界面新建的默认不限定应用，由所有者决定
    const appIds = input.appIds ? [...new Set(input.appIds)].sort() : null
    const { source } = input
    if (source.kind === 'new') {
      const created = await this.createNew(
        {
          identifier: input.identifier,
          name: input.name,
          description: input.description ?? null,
          values: source.values,
          url: source.url,
          expiresAt: input.expiresAt,
        },
        appIds,
      )
      const view = await this.run((tx) => this.consoleViewOf(tx, created.row))
      return { ...view, storedIn: created.storedIn }
    }
    // 给密码库的条目起标识（两个唯一索引的冲突由 insertVault 转成 409）：先同步一次找到这个条目，
    // 确认读得到、字段对得上，再写库。用同步而不是只取这个条目：响应要写明条目所在集合的名称
    const connection = await this.run((tx) => this.vault.load(tx, source.connectionId))
    if (!connection) throw new MemoryError(404, '密码库连接不存在')
    if (connection.status !== 'ok') {
      throw new MemoryError(409, '密码库连接不可用，请先在密码库里重新检查或重新登录')
    }
    let item: VaultItem
    let collectionName: string
    try {
      const session = this.vault.session(connection)
      item = await session.item(source.itemId)
      // 集合的名称取会话最近一次同步读到的（取条目时新会话会先同步一次）；没有，或者条目所在的集合
      // 有缓存里没有的（条目刚被移进新建的集合）时再同步一次
      const cached = this.vault.collectionsOf(session)
      const collections =
        cached && item.collectionIds.every((id) => cached.some((c) => c.id === id))
          ? cached
          : (await session.snapshot()).collections
      collectionName = itemCollectionName(item.collectionIds, collections, connection)
    } catch (err) {
      if (err instanceof VaultDisabledError) {
        throw new MemoryError(409, `密码库连接已停用：${VAULT_DISABLED_REASON_NAMES[err.reason]}`)
      }
      if (!(err instanceof VaultError)) throw err
      await this.run((tx) => this.vault.record(tx, connection, { kind: 'error', error: err.kind }))
      const reason = vaultReason(err.kind)
      throw new MemoryError(
        reasonStatus(reason),
        `无法读取这个条目：${CREDENTIAL_ACCESS_REASON_NAMES[reason]}`,
      )
    }
    const fields = source.fields ?? defaultCredentialFields(item.fields)
    if (!fields.length) throw new MemoryError(400, '这个条目里没有能用的字段')
    if (fields.length > MAX_CREDENTIAL_FIELDS) {
      throw new MemoryError(
        400,
        `条目里的字段超过 ${MAX_CREDENTIAL_FIELDS} 个，请给出字段对应，只选要用的字段`,
      )
    }
    const missing = fields.find((f) => !item.fields.includes(f.itemField!))
    if (missing) throw new MemoryError(400, `条目里没有字段 ${missing.itemField}`)
    return this.run(async (tx) => {
      const id = await this.insertVault(
        tx,
        {
          identifier: input.identifier,
          name: input.name,
          description: input.description ?? null,
          connectionId: connection.id,
          itemId: source.itemId,
          fields,
          revision: item.revisionDate,
          expiresAt: input.expiresAt ?? null,
        },
        appIds,
        ITEM_BOUND_CREATE,
      )
      // 刚才那次取条目是成功的：和插入放在一个事务里更新连接
      await this.vault.record(tx, connection, { kind: 'ok' })
      const view = await this.consoleViewOf(tx, await this.ownById(tx, id))
      // 起标识：值本来就在这个条目里，写明条目所在的集合
      return { ...view, storedIn: { kind: 'vault', collectionName } }
    })
  }

  // 在调用方的事务里新建一条托管的凭据，返回 id（转存为凭据：和改记忆放在一个事务里）。
  // 标识冲突在这里转成 409：调用方的事务随这个错误整个回滚
  async createHostedIn(tx: Tx, input: NewCredentialInput): Promise<string> {
    try {
      return (await this.insertHosted(tx, input, null)).id
    } catch (err) {
      if (isUniqueViolation(err, 'credentials_identifier_live_idx')) {
        throw new MemoryError(409, `标识已被占用或不可用：${input.identifier}`)
      }
      throw err
    }
  }

  // ---- 新建带值的凭据：有去处写进密码库，没有时托管 ----

  // 新建（管理界面的 new、Key 的新建）：先在事务外写好条目（planNew），再在一个事务里建凭据。
  // 写进密码库之后建凭据失败时，条目留在集合里，错误带上它（orphaned）
  private async createNew(
    input: NewCredentialInput,
    appIds: string[] | null,
  ): Promise<{ row: CredentialRow; storedIn: CredentialStoredIn }> {
    const plan = await this.planNew(input)
    if (plan.kind === 'hosted') {
      const row = await this.run(
        (tx) => this.insertHosted(tx, input, appIds),
        `标识已被占用或不可用：${input.identifier}`,
      )
      return { row, storedIn: { kind: 'hosted', bench: plan.bench } }
    }
    try {
      const row = await this.run(async (tx) =>
        this.ownById(tx, await plan.insert(tx, appIds, ITEM_BOUND_CREATE)),
      )
      return { row, storedIn: plan.storedIn }
    } catch (err) {
      throw this.orphaned(err, plan.orphan)
    }
  }

  // 新凭据写到哪里：测试台与没设去处的托管；设了去处的，三段写进密码库：
  // 短事务读去处与连接、检查标识没被占用、准备会话 → 事务外新建条目 → 短事务按结果更新连接。
  // 返回在建凭据的事务里要做的一步。去处不可用时整次失败，不退回托管
  // beforeWrite：解析出密码库的去处之后、写条目之前调用（转存用它先查记忆），托管时不调用
  private async planNew(
    input: NewCredentialInput,
    beforeWrite?: () => Promise<void>,
  ): Promise<NewPlan> {
    this.requireManage()
    this.rejectMaskedText(input.values)
    if (this.ctx.bench) return { kind: 'hosted', bench: true }
    const sessions: PreparedSession[] = []
    const first = await this.run(async (tx) => {
      // 写进密码库之前先查一次标识：撞上了就不往集合里留一个没人用的条目。建凭据时唯一索引再判断一次
      if (await this.liveByIdentifier(tx, input.identifier)) {
        throw new MemoryError(409, `标识已被占用或不可用：${input.identifier}`)
      }
      const connection = await this.vault.destination(tx)
      if (!connection) return null
      const problem = destinationProblem(connection)
      if (problem) {
        this.vault.forget(connection.id)
        throw new MemoryError(problem.status, `${DESTINATION_UNAVAILABLE}${problem.text}`)
      }
      if (!this.ctx.masterKey) {
        throw new MemoryError(
          400,
          `${DESTINATION_UNAVAILABLE}${CREDENTIAL_ACCESS_REASON_NAMES.master_key}`,
        )
      }
      const prepared = { connection, session: this.openSession(connection) }
      sessions.push(prepared)
      return prepared
    }).catch(this.releasingOnError(sessions))
    if (!first) return { kind: 'hosted', bench: false }
    const { connection } = first
    if (beforeWrite) await beforeWrite().catch(this.releasingOnError([first]))
    const { item: newItem, fields } = newVaultItem(connection, input)
    const call = await this.vaultCall(first, (session) => session.createItem(newItem))
    const touched = [{ connection: call.connection, session: call.used }]
    const record = () =>
      this.run((tx) => this.vault.record(tx, call.connection, call.outcome, call.used))
    if (call.error !== null) {
      await record().catch(this.releasingOnError(touched))
      throw writeFailure(call.error, 'create')
    }
    const item = call.value!
    const collectionName = connection.defaultCollectionName!
    const orphan: OrphanVaultItem = {
      connectionId: connection.id,
      itemId: item.id,
      itemName: item.name,
      collectionName,
    }
    // 条目已经写进去了：之后哪一步失败都按留下的条目报，免得调用方重试又建一个
    try {
      await record()
    } catch (err) {
      await this.releaseSessions(touched)
      throw this.orphaned(err, orphan)
    }
    return {
      kind: 'vault',
      storedIn: { kind: 'vault', collectionName },
      orphan,
      insert: (tx, appIds, boundText) =>
        this.insertVault(
          tx,
          {
            identifier: input.identifier,
            name: input.name,
            description: input.description ?? null,
            connectionId: connection.id,
            itemId: item.id,
            fields,
            revision: item.revisionDate,
            expiresAt: input.expiresAt ?? null,
            storedIn: 'vault',
          },
          appIds,
          boundText,
        ),
    }
  }

  // 写进密码库之后 Kioku 这边失败了：条目留在集合里。管理界面的错误体带上它，Key 只在文字里写明；
  // 原来的错误带着原因（例如版本冲突）时照样带上
  private orphaned(err: unknown, orphan: OrphanVaultItem): MemoryError {
    if (!(err instanceof MemoryError)) logInternalError('写进密码库之后建凭据出错', err)
    const status = err instanceof MemoryError ? err.status : 500
    const text = err instanceof MemoryError ? err.message.replace(/[。.]$/, '') : '服务内部错误'
    const reason = err instanceof MemoryError ? err.write?.reason : undefined
    return new MemoryError(
      status,
      // 条目与集合的名称是密码库里的明文，经 MCP 会交给模型：压成单行
      `${text}。条目「${inlineText(orphan.itemName)}」已写进集合「${inlineText(orphan.collectionName)}」，未建成凭据：` +
        (this.viaKey
          ? '请所有者在管理界面给它起标识，或到密码库里删除，不要原样重试。'
          : '可以在凭据页给它起标识，或到密码库里删除。'),
      undefined,
      {
        ...(reason ? { reason } : {}),
        ...(this.viaKey ? {} : { vaultItem: orphan }),
      },
    )
  }

  // ---- 写回密码库凭据的值 ----

  // 改密码库凭据的值：三段。短事务里读凭据、做修改的检查、把值对应到条目的字段、准备会话 →
  // 事务外改条目（期望的修改时间是 Kioku 最近看到的；还没看到过时先读一次）→ 短事务更新连接、改凭据这一行。
  // 条目在别处改过（item_conflict）时，事务外再读一次条目，记下它现在的修改时间（版本号随之加一），返回 409：
  // 调用方重新读取、拿到新版本号再改就能成功，浏览器那边的改动不会被盖掉
  private async writeBack(
    find: (tx: Tx) => Promise<CredentialRow>,
    input: ModifyInput & { values: Record<string, string | null> },
  ): Promise<CredentialRow> {
    const sessions: PreparedSession[] = []
    const first = await this.run(async (tx) => {
      const before = await find(tx)
      this.checkModify(before, input)
      if (this.ctx.bench) throw new MemoryError(400, BENCH_VAULT_WRITE)
      this.rejectMaskedText(input.values)
      const changes = vaultChanges(before, input.values)
      const connection = await this.usableConnection(tx, before.vaultConnectionId!)
      if (!this.ctx.masterKey) {
        throw new MemoryError(400, `无法写入密码库：${CREDENTIAL_ACCESS_REASON_NAMES.master_key}`)
      }
      const prepared = { connection, session: this.openSession(connection) }
      sessions.push(prepared)
      return { before, changes, prepared }
    }).catch(this.releasingOnError(sessions))
    const { before, changes, prepared } = first
    const itemId = before.vaultItemId!
    // 发给密码库的期望修改时间：值有没有真的改，按写回之后的修改时间和它比
    let expected = before.vaultRevision
    const call = await this.vaultCall(prepared, async (session) => {
      expected ??= (await session.item(itemId)).revisionDate
      return session.updateItem(itemId, { values: changes.values }, expected)
    })
    // 冲突：读一次条目现在的修改时间，记下来之后调用方重新读取就能接着改。
    // 这次重读也是一次通信（可能换了会话），和写入一样交给 vault.record
    const reread =
      call.error instanceof VaultError && call.error.kind === 'item_conflict'
        ? await this.vaultCall({ connection: call.connection, session: call.used }, (session) =>
            session.item(itemId),
          )
        : null
    const touched = [
      { connection: call.connection, session: call.used },
      ...(reread ? [{ connection: reread.connection, session: reread.used }] : []),
    ]
    const outcome = await this.run(async (tx) => {
      // 写入本身的错误（只读、冲突、值太长）不在 CONNECTION_ERRORS 里，record 不改连接
      await this.vault.record(tx, call.connection, call.outcome, call.used)
      // 为了期望的修改时间第一次读到的条目：照「第一次看到」的规则记下，写入成不成功都记，下次不用再读
      if (before.vaultRevision === null && expected !== null) {
        await observeRevisions(tx, call.connection.id, [{ id: itemId, revisionDate: expected }])
      }
      if (reread) {
        await this.vault.record(tx, reread.connection, reread.outcome, reread.used)
        if (reread.error === null) await observeRevisions(tx, call.connection.id, [reread.value!])
      }
      if (call.error !== null) return null
      return this.recordWriteBack(tx, before, input, {
        item: call.value!,
        fields: changes.names,
        expected: expected!,
      })
    }).catch(this.releasingOnError(touched))
    if (!outcome) throw writeFailure(call.error, 'update')
    if (outcome.error) throw outcome.error
    return outcome.row
  }

  // 写回已经落进密码库：值不能再因为版本失败。锁住这一行重读：
  // - 版本从第一段起没变、也没被删：照这次请求整个改（值与名称这些别的改动）；
  // - 版本变过（两段之间别人改了名、收窄了限定的应用、标了轮换，或者取用看到了新的修改时间）：
  //   只记下写进去的值，别的改动不保存，提交之后返回 409（reason: version），免得盖掉别人的改动；
  // - 凭据在这期间被删了：照样在那一行记下这次写入（恢复之后状态才对），返回 409（reason: deleted）。
  // 错误要在事务提交之后再抛，所以这里返回它，不在事务里抛
  private async recordWriteBack(
    tx: Tx,
    before: CredentialRow,
    input: ModifyInput,
    written: Written,
  ): Promise<{ row: CredentialRow; error?: MemoryError }> {
    const [current] = await tx
      .select()
      .from(credentials)
      .where(eq(credentials.id, before.id))
      .for('update')
    if (!current) return { row: before, error: new MemoryError(409, WRITTEN_BUT_GONE) }
    if (!current.deletedAt && current.version === before.version) {
      return { row: await this.modify(tx, current, input, written) }
    }
    const row = await this.recordWrittenValues(tx, current, written)
    return current.deletedAt
      ? {
          row,
          error: new MemoryError(409, WRITTEN_BUT_DELETED, undefined, { reason: 'deleted' }),
        }
      : { row, error: versionConflict(WRITTEN_BUT_STALE) }
  }

  // 只记下写回的值（别的改动不动）：版本加一、清掉需要轮换、记一条 values 事件，修改时间照不往回改的规则。
  // 已删除的行也记。值都和原来相同（修改时间没变）时什么都不记
  private async recordWrittenValues(
    tx: Tx,
    current: CredentialRow,
    written: Written,
  ): Promise<CredentialRow> {
    if (written.item.revisionDate === written.expected) return current
    const [row] = await tx
      .update(credentials)
      .set({
        ...writtenRevision(current, written),
        rotationRequestedAt: null,
        version: sql`${credentials.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(credentials.id, current.id))
      .returning()
    await this.event(tx, current.id, 'update', { changes: ['values'], fields: written.fields })
    return row!
  }

  // ---- 按值比对（管理界面：按值查找、转存、Lore 导入）----

  // 当前账号的有效凭据与密码库条目现在的值，只在服务端里比对，不交给调用方，也不记访问事件（没有把值交给谁）。
  // 第一段在事务里读凭据与连接、解开托管的值、准备会话；第二段在事务外向密码库取全部条目；
  // 第三段另开事务按结果更新连接（vault.record）。scope 为 all 时取每个可用的连接，bound 只取有凭据指着的
  private async collectValues(scope: 'all' | 'bound'): Promise<CollectedValues> {
    this.requireManage()
    const sessions: PreparedSession[] = []
    const { rows, hosted, unavailable, unreadable } = await this.run(async (tx) => {
      const rows = await tx
        .select()
        .from(credentials)
        .where(and(eq(credentials.ownerAccountId, this.owner), isNull(credentials.deletedAt)))
        .orderBy(asc(credentials.identifier))
      const hosted = new Map<string, Record<string, string>>()
      // 读不到值的托管凭据（没配主密钥、解不开）不比，数出来交给调用方：不说的话会被当成没有同值的
      let unreadable = 0
      for (const row of rows) {
        if (row.source !== 'hosted') continue
        if (!this.ctx.masterKey) {
          unreadable++
          continue
        }
        try {
          hosted.set(row.id, this.open(row))
        } catch (err) {
          unreadable++
          if (!(err instanceof MemoryError)) logInternalError('按值比对时托管的凭据解不开', err)
        }
      }
      const bound = new Set(rows.flatMap((r) => (r.vaultConnectionId ? [r.vaultConnectionId] : [])))
      const connections = await tx
        .select()
        .from(vaultConnections)
        .where(eq(vaultConnections.ownerAccountId, this.owner))
        .orderBy(asc(vaultConnections.createdAt), asc(vaultConnections.id))
      let unavailable = 0
      for (const connection of connections) {
        // 断开了又没有凭据指着的连接已经不用了，不算读不了
        const relevant =
          scope === 'all'
            ? connection.status !== 'disconnected' || bound.has(connection.id)
            : bound.has(connection.id)
        if (!relevant) continue
        if (connection.status !== 'ok' || !connection.ciphertext || !this.ctx.masterKey) {
          if (connection.status !== 'ok' || !connection.ciphertext) this.vault.forget(connection.id)
          unavailable++
          continue
        }
        try {
          sessions.push({ connection, session: this.vault.session(connection) })
        } catch (err) {
          if (err instanceof MemoryError) throw err
          unavailable++
        }
      }
      return { rows, hosted, unavailable, unreadable }
    }).catch(this.releasingOnError(sessions))

    // 各连接并行取：vaultCall 不抛错，一个失败不影响别的，每个会话下面都照样 record
    const calls = await Promise.all(
      sessions.map((prepared) => this.vaultCall(prepared, (session) => session.items())),
    )
    const touched = calls.map((c) => ({ connection: c.connection, session: c.used }))
    await this.run(async (tx) => {
      for (const call of calls) {
        await this.vault.record(tx, call.connection, call.outcome, call.used)
        if (call.error === null) await observeRevisions(tx, call.connection.id, call.value!)
      }
    }).catch(this.releasingOnError(touched))
    // 不是密码库报的错（数据库错误等）照常抛出，连接已经在上面确认过
    const unexpected = calls.find(
      (c) =>
        c.error !== null &&
        !(c.error instanceof VaultError || c.error instanceof VaultDisabledError) &&
        !(c.error instanceof SecretsUnreadable),
    )
    if (unexpected) throw unexpected.error
    const items = new Map<string, VaultItem[]>()
    for (const [i, call] of calls.entries()) {
      if (call.error === null)
        items.set(sessions[i]!.connection.id, [...call.value!].sort(byItemName))
    }
    return {
      rows,
      hosted,
      items,
      unavailableConnections: unavailable + calls.length - items.size,
      unreadableCredentials: unreadable,
    }
  }

  // 按值查找：每个值和当前账号的托管凭据、可用的密码库连接里的条目逐个字段比，按字面比较。
  // TOTP 的密钥不参与：凭据的 totp 字段给的是验证码，绑过去意思就变了
  async matchValues(values: string[]): Promise<CredentialValueMatches> {
    const collected = await this.collectValues('all')
    const boundItem = new Map<string, CredentialRow>()
    for (const row of collected.rows) {
      if (row.source === 'vault') boundItem.set(`${row.vaultConnectionId}/${row.vaultItemId}`, row)
    }
    const entries = credentialEntries(collected)
    // 条目在 collectValues 里排好了，字段在这里排一次，不随每个值重排
    const fieldsOf = new Map<VaultItem, [string, string][]>()
    for (const items of collected.items.values()) {
      for (const item of items) {
        fieldsOf.set(
          item,
          Object.entries(item.values).sort(([a], [b]) => a.localeCompare(b)),
        )
      }
    }
    return {
      items: values.map((value) => {
        const matched = entries.filter((e) => e.value === value)
        const vaultItems: CredentialValueMatches['items'][number]['vaultItems'] = []
        for (const [connectionId, items] of collected.items) {
          for (const item of items) {
            const bound = boundItem.get(`${connectionId}/${item.id}`)
            for (const [itemField, itemValue] of fieldsOf.get(item)!) {
              if (itemField === TOTP_FIELD || itemValue !== value) continue
              // 已经对应到凭据字段的只列在 credentials 里
              if (bound?.fields.some((f) => f.itemField === itemField)) continue
              vaultItems.push({
                connectionId,
                itemId: item.id,
                itemName: item.name,
                itemField,
                credential: bound ? { id: bound.id, identifier: bound.identifier } : null,
              })
            }
          }
        }
        return {
          credentials: matched.map(({ id, identifier, name, field }) => ({
            id,
            identifier,
            name,
            field,
          })),
          vaultItems,
        }
      }),
      unavailableConnections: collected.unavailableConnections,
      unreadableCredentials: collected.unreadableCredentials,
    }
  }

  // 当前账号有效凭据各字段现在的值（Lore 导入用）：托管的解开，密码库的只取有凭据指着的连接。
  // 只留能用来按值替换的值（ConvertibleValue：太短的会换掉正文里别的内容），不能用的列进 unconvertible。
  // 读不到值的凭据列进 unresolved（原因见 UnresolvedReason）。条目读到了、字段空了或没了的不算读不到：
  // 和凭据删了一样，是这个字段现在没有值
  async knownValues(): Promise<KnownCredentialValues> {
    const collected = await this.collectValues('bound')
    const all = credentialEntries(collected)
    const unresolved = new Map<string, UnresolvedReason>()
    for (const row of collected.rows) {
      if (!this.ctx.masterKey) unresolved.set(row.identifier, 'master_key')
      else if (row.source === 'hosted') {
        if (!collected.hosted.has(row.id)) unresolved.set(row.identifier, 'hosted')
      } else if (
        !collected.items.get(row.vaultConnectionId!)?.some((i) => i.id === row.vaultItemId)
      ) {
        unresolved.set(row.identifier, 'vault')
      }
    }
    return {
      entries: all.filter((e) => isConvertibleValue(e.value)),
      unconvertible: new Set(
        all.filter((e) => !isConvertibleValue(e.value)).map((e) => `${e.identifier}#${e.field}`),
      ),
      unresolved,
      unavailableConnections: collected.unavailableConnections,
      unreadableCredentials: collected.unreadableCredentials,
    }
  }

  // 转存的去处（memory 服务的 convertToCredential 用）：credential 与 vault 先在事务外核对这个字段现在的值
  // 确实等于 value，不等时 400（文字不带值）；核对时取条目用的会话照常 vault.record。
  // 返回占位符要用的标识与字段，以及在转存的事务里要做的一步：hosted 与 vault 建凭据，credential 锁住那条凭据。
  // precheck：新建要写进密码库时，写条目之前调用它先查一遍记忆，查不过就不留下条目
  async convertTarget(
    target: ConvertTarget,
    value: string,
    precheck?: (placeholder: { identifier: string; field: string }) => Promise<void>,
  ): Promise<ConvertSink> {
    this.requireManage()
    switch (target.kind) {
      case 'new':
        return this.newTarget(
          target,
          value,
          precheck && (() => precheck({ identifier: target.identifier, field: target.field })),
        )
      case 'credential':
        return this.existingTarget(target.credentialId, target.field, value)
      case 'vault':
        return this.vaultTarget(target, value)
    }
  }

  // 转存到新建的凭据：和新建一样，设了去处的先在事务外写进密码库（planNew），转存的事务里只建凭据。
  // 转存的事务失败时条目留在集合里，sink.orphan 交给调用方放进错误
  private async newTarget(
    target: Extract<ConvertTarget, { kind: 'new' }>,
    value: string,
    beforeWrite?: () => Promise<void>,
  ): Promise<ConvertSink> {
    const input: NewCredentialInput = {
      identifier: target.identifier,
      name: target.name,
      description: target.description ?? null,
      values: { [target.field]: value },
      url: target.url,
      expiresAt: target.expiresAt,
    }
    const plan = await this.planNew(input, beforeWrite)
    const base = { identifier: target.identifier, field: target.field, created: true }
    if (plan.kind === 'hosted') {
      return {
        ...base,
        storedIn: { kind: 'hosted', bench: plan.bench },
        apply: (tx) => this.createHostedIn(tx, input),
      }
    }
    return {
      ...base,
      storedIn: plan.storedIn,
      orphan: plan.orphan,
      apply: async (tx) => {
        try {
          return await plan.insert(tx, null, ITEM_BOUND_CREATE)
        } catch (err) {
          if (isUniqueViolation(err, 'credentials_identifier_live_idx')) {
            throw new MemoryError(409, `标识已被占用或不可用：${target.identifier}`)
          }
          throw err
        }
      },
    }
  }

  // 转存失败之后包上留在密码库里的条目（转存的事务在 memory 服务里，失败时由路由调用）
  orphanedConvert(err: unknown, sink: ConvertSink): unknown {
    return sink.orphan ? this.orphaned(err, sink.orphan) : err
  }

  private async existingTarget(
    credentialId: string,
    fieldName: string,
    value: string,
  ): Promise<ConvertSink> {
    const sessions: PreparedSession[] = []
    const first = await this.run(async (tx) => {
      const row = await this.ownById(tx, credentialId)
      if (row.deletedAt) throw new MemoryError(409, '这条凭据已删除。请先恢复，再转存。')
      const field = row.fields.find((f) => f.name === fieldName)
      if (!field) throw new MemoryError(400, `凭据 ${row.identifier} 没有字段 ${fieldName}`)
      if (field.itemField === TOTP_FIELD) throw new MemoryError(400, CONVERT_TOTP)
      if (row.identifier.includes(value)) throw new MemoryError(400, CONVERT_TEXT_HAS_VALUE)
      if (row.source === 'hosted') return { row, field, actual: this.open(row)[field.name] }
      const connection = await this.usableConnection(tx, row.vaultConnectionId!)
      const prepared = { connection, session: this.openSession(connection) }
      sessions.push(prepared)
      return { row, field, prepared }
    }).catch(this.releasingOnError(sessions))
    const { row, field } = first
    const actual =
      'prepared' in first
        ? (await this.readVaultItem(first.prepared, row.vaultItemId!)).values[field.itemField!]
        : first.actual
    if (actual !== value) throw new MemoryError(400, CONVERT_MISMATCH)
    return {
      identifier: row.identifier,
      field: field.name,
      created: false,
      storedIn: null,
      // 锁住这条凭据，确认核对之后没有被改过或删掉：转存的事务提交之前也删不掉它（删除要先锁住、再数引用）
      apply: async (tx) => {
        const [locked] = await tx
          .select({ id: credentials.id })
          .from(credentials)
          .where(
            and(
              eq(credentials.id, row.id),
              eq(credentials.version, row.version),
              isNull(credentials.deletedAt),
            ),
          )
          .for('share')
        if (!locked) throw versionConflict('凭据在核对之后被修改或删除，请重新转存')
        return row.id
      },
    }
  }

  private async vaultTarget(
    target: Extract<ConvertTarget, { kind: 'vault' }>,
    value: string,
  ): Promise<ConvertSink> {
    if (target.itemField === TOTP_FIELD) throw new MemoryError(400, CONVERT_TOTP)
    const sessions: PreparedSession[] = []
    const prepared = await this.run(async (tx) => {
      const connection = await this.usableConnection(tx, target.connectionId)
      const [bound] = await tx
        .select({ identifier: credentials.identifier })
        .from(credentials)
        .where(
          and(
            eq(credentials.vaultConnectionId, connection.id),
            eq(credentials.vaultItemId, target.itemId),
            isNull(credentials.deletedAt),
          ),
        )
      if (bound) throw new MemoryError(409, `${ITEM_BOUND}（${bound.identifier}）`)
      const p = { connection, session: this.openSession(connection) }
      sessions.push(p)
      return p
    }).catch(this.releasingOnError(sessions))
    const item = await this.readVaultItem(prepared, target.itemId)
    if (!item.fields.includes(target.itemField)) {
      throw new MemoryError(400, `条目里没有字段 ${target.itemField}`)
    }
    const fields = target.fields ?? defaultCredentialFields(item.fields)
    if (fields.length > MAX_CREDENTIAL_FIELDS) {
      throw new MemoryError(
        400,
        `条目里的字段超过 ${MAX_CREDENTIAL_FIELDS} 个，请给出字段对应，只选要用的字段`,
      )
    }
    const missing = fields.find((f) => !item.fields.includes(f.itemField!))
    if (missing) throw new MemoryError(400, `条目里没有字段 ${missing.itemField}`)
    const mapped = fields.find((f) => f.itemField === target.itemField)
    if (!mapped) {
      throw new MemoryError(400, `按条目推出的字段对应里没有 ${target.itemField}，请给出字段对应`)
    }
    if (item.values[target.itemField] !== value) throw new MemoryError(400, CONVERT_MISMATCH)
    // 名称不给时用条目的名称，截到名称的上限；它和推出的字段名都没经过请求的校验，这里再查一次
    const name = target.name ?? Array.from(item.name.trim()).slice(0, 100).join('')
    if (!name) throw new MemoryError(400, '条目没有名称，请填写凭据的名称')
    if ([name, ...fields.map((f) => f.name)].some((t) => t.includes(value))) {
      throw new MemoryError(400, CONVERT_TEXT_HAS_VALUE)
    }
    return {
      identifier: target.identifier,
      field: mapped.name,
      created: true,
      storedIn: null,
      apply: (tx) =>
        this.insertVault(
          tx,
          {
            identifier: target.identifier,
            name,
            description: target.description ?? null,
            connectionId: prepared.connection.id,
            itemId: target.itemId,
            fields,
            revision: item.revisionDate,
          },
          null,
          ITEM_BOUND,
        ),
    }
  }

  // 转存时要用的连接：自己的、可用的
  private async usableConnection(tx: Tx, id: string): Promise<ConnectionRow> {
    const connection = await this.vault.load(tx, id)
    if (!connection) throw new MemoryError(404, '密码库连接不存在')
    if (connection.status !== 'ok' || !connection.ciphertext) {
      this.vault.forget(id)
      throw new MemoryError(409, '密码库连接不可用，请先在密码库里重新检查或重新登录')
    }
    return connection
  }

  private openSession(connection: ConnectionRow): VaultSession {
    try {
      return this.vault.session(connection)
    } catch (err) {
      if (err instanceof MemoryError) throw err
      throw new MemoryError(400, `无法读取这个条目：${CREDENTIAL_ACCESS_REASON_NAMES.master_key}`)
    }
  }

  // 在事务外取一个条目，再另开事务按结果更新连接。取不到时说明原因，不带值
  private async readVaultItem(prepared: PreparedSession, itemId: string): Promise<VaultItem> {
    const call = await this.vaultCall(prepared, (session) => session.item(itemId))
    await this.run((tx) => this.vault.record(tx, call.connection, call.outcome, call.used)).catch(
      this.releasingOnError([{ connection: call.connection, session: call.used }]),
    )
    const err = call.error
    if (err === null) return call.value!
    if (err instanceof VaultDisabledError) {
      throw new MemoryError(409, `密码库连接已停用：${VAULT_DISABLED_REASON_NAMES[err.reason]}`)
    }
    const reason =
      err instanceof VaultError
        ? vaultReason(err.kind)
        : err instanceof SecretsUnreadable
          ? 'master_key'
          : null
    if (!reason) throw err
    throw new MemoryError(
      reasonStatus(reason),
      `无法读取这个条目：${CREDENTIAL_ACCESS_REASON_NAMES[reason]}`,
    )
  }

  // 给密码库的条目起标识（新建与转存共用）。标识冲突与同一个条目已有凭据都转成 409：
  // 在转存的事务里出错时，调用方的事务随这个错误整个回滚
  private async insertVault(
    tx: Tx,
    input: {
      identifier: string
      name: string
      description: string | null
      connectionId: string
      itemId: string
      fields: CredentialField[]
      // 读到或写下这个条目时它的修改时间
      revision: string
      expiresAt?: string | null
      // 新建时写进了密码库（记进新建事件）；给已有的条目起标识时不给
      storedIn?: 'vault'
    },
    appIds: string[] | null,
    // 同一个条目已有有效凭据时的说法：新建与转存给的下一步不同
    boundText: string,
  ): Promise<string> {
    const id = randomUUID()
    try {
      await tx.insert(credentials).values({
        id,
        spaceId: this.ctx.spaceId,
        ownerAccountId: this.owner,
        identifier: input.identifier,
        name: input.name,
        description: input.description,
        source: 'vault',
        vaultConnectionId: input.connectionId,
        vaultItemId: input.itemId,
        fields: input.fields,
        appIds,
        vaultRevision: input.revision,
        valueChangedAt: revisionDate(input.revision),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
    } catch (err) {
      if (isUniqueViolation(err, 'credentials_identifier_live_idx')) {
        throw new MemoryError(409, `标识已被占用或不可用：${input.identifier}`)
      }
      if (isUniqueViolation(err, 'credentials_vault_item_live_idx')) {
        throw new MemoryError(409, boundText)
      }
      throw err
    }
    await this.event(tx, id, 'create', input.storedIn ? { storedIn: input.storedIn } : {})
    return id
  }

  // 在调用方的事务里读一条自己的凭据：引用的条数要算上这个事务刚写的
  async viewIn(tx: Tx, id: string): Promise<ConsoleCredential> {
    return this.consoleViewOf(tx, await this.ownById(tx, id))
  }

  async update(id: string, input: UpdateCredentialRequest): Promise<ConsoleCredential> {
    const row = await this.change((tx) => this.ownById(tx, id), input)
    return this.run((tx) => this.consoleViewOf(tx, row))
  }

  // 修改（管理界面与 Key 共用）：密码库凭据的值要写回条目（writeBack，三段），别的在一个事务里改
  private async change(
    find: (tx: Tx) => Promise<CredentialRow>,
    input: ModifyInput,
  ): Promise<CredentialRow> {
    const { values } = input
    if (values !== undefined && Object.keys(values).length) {
      const before = await this.run(find)
      if (before.source === 'vault') return this.writeBack(find, { ...input, values })
    }
    return this.run(async (tx) => {
      const before = await find(tx)
      // 读到时还是托管、现在却是密码库的不会发生（来源不能改），这里照样拦下
      if (before.source === 'vault' && values !== undefined && Object.keys(values).length) {
        throw new MemoryError(409, '凭据刚被修改，请重新读取')
      }
      return this.modify(tx, before, input)
    })
  }

  async delete(id: string, expectedVersion?: number): Promise<void> {
    await this.run(async (tx) => this.remove(tx, await this.ownById(tx, id), expectedVersion))
  }

  // 撤销删除。同一个标识已经有一条有效的凭据时不能恢复：引用按标识解析，两条同名的有效凭据会分不清；
  // 同一个条目已经有有效的凭据时也不能（唯一索引，见 run）
  async undelete(id: string): Promise<ConsoleCredential> {
    return this.run(async (tx) => {
      this.requireManage()
      const before = await this.ownById(tx, id)
      if (!before.deletedAt) throw new MemoryError(409, '这条凭据未被删除')
      const [row] = await tx
        .update(credentials)
        .set({ deletedAt: null, version: sql`${credentials.version} + 1`, updatedAt: new Date() })
        .where(
          and(
            eq(credentials.id, id),
            eq(credentials.version, before.version),
            isNotNull(credentials.deletedAt),
          ),
        )
        .returning()
      if (!row) {
        // 检查之后被别的请求改了：说清楚是已经被恢复了，还是又被改过（给出现在的版本号）
        const [now] = await tx
          .select({ version: credentials.version, deletedAt: credentials.deletedAt })
          .from(credentials)
          .where(eq(credentials.id, id))
        throw new MemoryError(
          409,
          now && !now.deletedAt
            ? '这条凭据刚被其他请求恢复'
            : `版本已变化：当前是 ${now?.version ?? before.version}，请先重新读取`,
        )
      }
      await this.event(tx, id, 'undelete')
      return this.consoleViewOf(tx, row)
    }, '同一标识已有有效凭据，无法恢复此凭据')
  }

  // 引用这条凭据的记忆，最近改过的在前
  async references(id: string): Promise<CredentialReferenceList> {
    this.requireUse()
    return this.run(async (tx) => {
      const row = await this.ownById(tx, id)
      // 已删除的凭据不算被引用：同一个标识的引用解析到有效的那一条（见 consoleView）
      if (row.deletedAt) return { items: [], truncated: false }
      const rows = await tx
        .select({
          id: memories.id,
          domain: memories.domain,
          path: memories.path,
          title: memories.title,
          sensitivity: memories.sensitivity,
          updatedAt: memories.updatedAt,
        })
        .from(memoryCredentialRefs)
        .innerJoin(memories, effectiveRef(this.owner))
        .where(eq(memoryCredentialRefs.identifier, row.identifier))
        .orderBy(desc(memories.updatedAt), asc(memories.id))
        .limit(REFERENCE_LIMIT + 1)
      return {
        items: rows.slice(0, REFERENCE_LIMIT).map((r) => ({
          id: r.id,
          uri: formatUri(r.domain!, r.path!),
          title: r.title!,
          sensitivity: r.sensitivity,
          updatedAt: r.updatedAt.toISOString(),
        })),
        truncated: rows.length > REFERENCE_LIMIT,
      }
    })
  }

  // 管理界面查看值：托管的与密码库的都给（totp 给验证码），记一条访问事件。和 secret 一样，目前要求是空间 owner
  async reveal(id: string): Promise<CredentialValues> {
    this.requireManage()
    const sessions: PreparedSession[] = []
    const { row, prepared } = await this.run(async (tx) => {
      const row = await this.ownById(tx, id)
      if (row.deletedAt) throw new MemoryError(409, '这条凭据已删除。请先恢复，再查看。')
      const prepared = await this.prepare(tx, row, row.fields, 'console', undefined)
      if (prepared.kind === 'vault') sessions.push(prepared)
      return { row, prepared }
    }).catch(this.releasingOnError(sessions))
    return { values: (await this.deliver(row, row.fields, 'console', undefined, prepared)) ?? {} }
  }

  // 一条凭据的事件，最新的在前。Key 的名字和 Key 列表一样，只给应用所有者与空间 owner 看
  // sinceValueChange：只列上次改值以来交出的（交出的值版本等于现在的，见 sinceValueChangeOf）
  async events(id: string, page: CredentialEventQuery): Promise<CredentialEventList> {
    this.requireUse()
    if (page.cursor !== undefined && !EVENT_ID.test(page.cursor)) {
      throw new MemoryError(400, '翻页参数无效，请从第一页重新开始')
    }
    return this.run(async (tx) => {
      const credential = await this.ownById(tx, id)
      const current = currentValueRevision(credential)
      const keyVisible = this.ctx.access.admin
        ? sql`true`
        : sql`${apps.ownerAccountId} = ${this.owner}`
      const rows = await tx
        .select({
          event: credentialEvents,
          accountName: accounts.displayName,
          keyName: sql<string | null>`case when ${keyVisible} then ${apiKeys.name} end`,
          appName: apps.name,
        })
        .from(credentialEvents)
        .leftJoin(accounts, eq(accounts.id, credentialEvents.actorAccountId))
        .leftJoin(apiKeys, eq(apiKeys.id, credentialEvents.actorKeyId))
        .leftJoin(apps, eq(apps.id, apiKeys.appId))
        .where(
          and(
            eq(credentialEvents.credentialId, id),
            page.cursor ? lt(credentialEvents.id, Number(page.cursor)) : undefined,
            page.sinceValueChange ? deliveredRevision(current) : undefined,
          ),
        )
        .orderBy(desc(credentialEvents.id))
        .limit(page.limit + 1)
      const items = rows.slice(0, page.limit)
      const list = (value: unknown) =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
      const text = (value: unknown) => (typeof value === 'string' ? value : null)
      const benchMark = await benchMarkReader(
        tx,
        items.map((r) => r.event.context),
      )
      return {
        items: items.map((r) => {
          const c = r.event.context
          const result = text(c.result)
          const reason = text(c.reason)
          return {
            id: r.event.id,
            type: r.event.eventType,
            createdAt: r.event.createdAt.toISOString(),
            actor: { accountName: r.accountName, keyName: r.keyName, appName: r.appName },
            via: text(c.via),
            fields: list(c.fields),
            purpose: text(c.purpose),
            result: ACCESS_RESULTS.has(result) ? (result as CredentialAccessResult) : null,
            reason: ACCESS_REASONS.has(reason) ? (reason as CredentialAccessReason) : null,
            chatType: text(c.chatType),
            changes: list(c.changes),
            sinceValueChange: sinceValueChangeOf(r.event.eventType, c, current),
            bench: benchMark(c),
          }
        }),
        nextCursor:
          rows.length > page.limit && items.length ? String(items.at(-1)!.event.id) : null,
      }
    })
  }

  // ---- Key ----

  // 列出这把 Key 能取用的凭据，不含值与条目
  async keyList(): Promise<KeyCredentialList> {
    this.requireUse()
    return this.run(async (tx) => {
      const rows = (
        await tx
          .select()
          .from(credentials)
          .where(and(eq(credentials.ownerAccountId, this.owner), isNull(credentials.deletedAt)))
          .orderBy(asc(credentials.identifier))
      ).filter((r) => canUseCredential(this.ctx.access, r))
      return {
        items: rows.slice(0, LIST_LIMIT).map((r) => this.summary(r)),
        truncated: rows.length > LIST_LIMIT,
      }
    })
  }

  // 取用前检查一条凭据（use 与 resolve 共用）：能力、范围、会话上下文与限定的应用，存不存在，有没有这些字段。
  // 凭据存在、取用被拒的记一条被拒；不存在的没有可记的地方，没有这个字段的不记。fieldNames 为 null 时取全部字段
  private async checkUse(
    tx: Tx,
    row: CredentialRow | undefined,
    fieldNames: string[] | null,
    via: CredentialVia,
    purpose: string | undefined,
  ): Promise<UseCheck> {
    // 同一个字段要了几次（kioku run 里几个变量取同一个字段）只算一次
    fieldNames = fieldNames && [...new Set(fieldNames)]
    const denial = credentialDenial(this.ctx.access, row ?? { appIds: null }, 'use')
    if (denial) {
      if (row) {
        await this.accessEvent(tx, row.id, {
          via,
          fields: fieldNames ?? row.fields.map((f) => f.name),
          purpose,
          result: 'denied',
          reason: denial,
        })
      }
      return { kind: 'denied', reason: denial }
    }
    if (!row) return { kind: 'not_found' }
    if (!fieldNames) return { kind: 'ok', row, fields: row.fields }
    const fields: CredentialField[] = []
    for (const name of fieldNames) {
      const field = row.fields.find((f) => f.name === name)
      if (!field) return { kind: 'no_field', field: name }
      fields.push(field)
    }
    return { kind: 'ok', row, fields }
  }

  // 取用一条凭据：给值（测试台里为 null）与提醒。交出值、被拒或失败时各记一条访问事件
  async use(
    identifier: string,
    field: string | undefined,
    via: CredentialVia,
    purpose?: string,
  ): Promise<CredentialAccess> {
    const sessions: PreparedSession[] = []
    const first = await this.run(async (tx) => {
      const check = await this.checkUse(
        tx,
        await this.liveByIdentifier(tx, identifier),
        field ? [field] : null,
        via,
        purpose,
      )
      // 说法不看存不存在
      switch (check.kind) {
        case 'denied':
          return { error: denialError(check.reason, 'use', identifier) }
        case 'not_found':
          return { error: new MemoryError(404, `凭据不存在：${identifier}`) }
        case 'no_field':
          return { error: new MemoryError(404, `凭据 ${identifier} 没有字段 ${check.field}`) }
      }
      const { row, fields } = check
      const prepared = await this.prepare(tx, row, fields, via, purpose)
      if (prepared.kind === 'vault') sessions.push(prepared)
      return { row, fields, prepared }
    }).catch(this.releasingOnError(sessions))
    if ('error' in first) throw first.error
    const values = await this.deliver(first.row, first.fields, via, purpose, first.prepared)
    return {
      credential: this.summary(first.row),
      values,
      notice: expiredNotice(first.row) + CREDENTIAL_NOTICE,
    }
  }

  // 准备过的密码库凭据都要经过 vault.record（没有取条目的传 null，只确认连接还能不能用）：
  // 断开与准备交错时，会话可能在断开提交之后才放回缓存，靠它清掉。出错只记日志，不盖过原来的错误
  // 同一个连接加同一个会话只确认一次
  private async recordSessions(tx: Tx, sessions: PreparedSession[]): Promise<void> {
    const seen = new Map<string, Set<VaultSession>>()
    for (const { connection, session } of sessions) {
      const done = seen.get(connection.id) ?? new Set<VaultSession>()
      if (done.has(session)) continue
      done.add(session)
      seen.set(connection.id, done)
      await this.vault.record(tx, connection, null, session)
    }
  }

  private async releaseSessions(sessions: PreparedSession[]): Promise<void> {
    if (!sessions.length) return
    await this.run((tx) => this.recordSessions(tx, sessions)).catch((err: unknown) =>
      logInternalError('凭据取用失败之后确认连接状态出错', err),
    )
  }

  // 事务失败回滚时，里面的 vault.record 也跟着回滚了：另开一个事务放掉会话，再抛出原来的错误
  private releasingOnError(sessions: PreparedSession[]) {
    return async (err: unknown): Promise<never> => {
      await this.releaseSessions(sessions)
      throw err
    }
  }

  // kioku run 一次取几个字段，要么全给，要么一个都不给。第一段在一个事务里做完全部的权限与存在性检查，
  // 都通过了才解开托管的值、确认连接可用；第二段向密码库取条目，同一条凭据只取一次；
  // 第三段在一个事务里给每条凭据记一条交出（字段合在一起）。被拒与失败的照 use 记，没轮到的不记。
  // 整条凭据的失败（连接断开、密码库连不上等）只写标识，某个字段缺值时写「标识#字段」
  async resolve(
    refs: CredentialFieldRef[],
    via: CredentialVia,
    purpose?: string,
  ): Promise<ResolvedCredentials> {
    // 测试台里取用不给值，这个接口不在测试台里
    if (this.ctx.bench) throw new MemoryError(400, '测试台不支持 kioku run 的取值接口')
    // 按凭据分组，组的顺序是标识第一次出现的顺序；index 是这一项在 refs 里的位置
    const groups = new Map<string, { ref: CredentialFieldRef; index: number }[]>()
    refs.forEach((ref, index) => {
      const group = groups.get(ref.identifier)
      if (group) group.push({ ref, index })
      else groups.set(ref.identifier, [{ ref, index }])
    })
    type Planned = { row: CredentialRow; fields: CredentialField[] }
    // 第一段里准备好的密码库会话：没走完的也要 releaseSessions
    const sessions: PreparedSession[] = []

    const first = await this.run(async (tx) => {
      const rows = new Map(
        (
          await tx
            .select()
            .from(credentials)
            .where(
              and(
                eq(credentials.ownerAccountId, this.owner),
                inArray(credentials.identifier, [...groups.keys()]),
                isNull(credentials.deletedAt),
              ),
            )
        ).map((r) => [r.identifier, r]),
      )
      // 报 refs 里最靠前的那一项
      let worst: { index: number; error: MemoryError } | undefined
      const fail = (index: number, error: MemoryError) => {
        if (!worst || index < worst.index) worst = { index, error }
      }
      const planned: Planned[] = []
      for (const [identifier, group] of groups) {
        const head = group[0]!
        const check = await this.checkUse(
          tx,
          rows.get(identifier),
          group.map((g) => g.ref.field),
          via,
          purpose,
        )
        switch (check.kind) {
          case 'denied':
            fail(
              head.index,
              check.reason === 'app'
                ? new MemoryError(404, `${refText(head.ref)}：凭据不存在`)
                : refError(head.ref, denialError(check.reason, 'use', identifier)),
            )
            break
          case 'not_found':
            fail(head.index, new MemoryError(404, `${refText(head.ref)}：凭据不存在`))
            break
          case 'no_field': {
            const missing = group.find((g) => g.ref.field === check.field)!
            fail(missing.index, new MemoryError(404, `${refText(missing.ref)}：凭据没有这个字段`))
            break
          }
          default:
            planned.push({ row: check.row, fields: check.fields })
        }
      }
      if (worst) return { error: worst.error }

      // 都通过了：托管的解开（先不记交出），密码库的确认连接可用。失败的那条已记好事件
      const prepared: Prepared[] = []
      for (const { row, fields } of planned) {
        const p = await this.prepare(tx, row, fields, via, purpose, true)
        if (p.kind === 'error') {
          return { error: failureError(p.reason, failedAt(row.identifier, p.field), p.detail) }
        }
        if (p.kind === 'vault') sessions.push(p)
        prepared.push(p)
      }
      return { planned, prepared }
    }).catch(this.releasingOnError(sessions))
    if ('error' in first) {
      await this.releaseSessions(sessions)
      throw first.error
    }
    const { planned, prepared } = first

    // 第二段：依次向密码库取条目，取不到就停
    const fetched = new Map<number, Fetched>()
    let failed: number | null = null
    for (const [i, p] of prepared.entries()) {
      if (p.kind !== 'vault') continue
      const f = await this.fetchItem(planned[i]!.row, planned[i]!.fields, p)
      fetched.set(i, f)
      if (typeof f.result === 'string') {
        failed = i
        break
      }
    }
    // 没轮到取条目的会话；取过的用这次真正用的会话（重试时换过）
    const unfetched: PreparedSession[] = prepared.flatMap((p, i) =>
      p.kind === 'vault' && !fetched.has(i) ? [p] : [],
    )
    const touched: PreparedSession[] = [
      ...[...fetched.values()].map((f) => ({ connection: f.connection, session: f.used })),
      ...unfetched,
    ]
    // 取过的都更新连接。有取不到的时只给它记失败，取到了却没交出的不记；没轮到取的只确认连接状态
    const settleFetched = async (tx: Tx) => {
      for (const [i, f] of fetched) {
        const { row, fields } = planned[i]!
        await this.settle(tx, row, fields, via, purpose, f, failed === null || i === failed)
      }
      await this.recordSessions(tx, unfetched)
    }
    if (failed !== null) {
      const f = fetched.get(failed)!
      const { row } = planned[failed]!
      const reason = f.result as CredentialAccessReason
      const where = failedAt(row.identifier, f.missing)
      if (f.unexpected !== null) {
        await this.run(settleFetched).catch(async (err: unknown) => {
          logInternalError('凭据取用失败之后记访问事件出错', err)
          await this.releaseSessions(touched)
        })
        if (reason === 'master_key') throw failureError(reason, where)
        throw f.unexpected
      }
      await this.run(settleFetched).catch(this.releasingOnError(touched))
      throw failureError(reason, where)
    }

    // 第三段：都取到了，一起记交出（密码库的在 settleFetched 里记）。失败回滚时另开事务放掉会话
    await this.run(async (tx) => {
      await settleFetched(tx)
      for (const [i, { row, fields }] of planned.entries()) {
        if (fetched.has(i)) continue
        await this.accessEvent(tx, row.id, {
          via,
          fields: fields.map((f) => f.name),
          purpose,
          result: 'ok',
          reason: null,
          revision: { valueVersion: row.valueVersion },
        })
      }
    }).catch(this.releasingOnError(touched))
    const values = new Map<string, Record<string, string>>()
    for (const [i, { row }] of planned.entries()) {
      const p = prepared[i]!
      const got =
        p.kind === 'values' ? p.values : (fetched.get(i)!.result as Record<string, string>)
      values.set(row.identifier, got ?? {})
    }
    const now = Date.now()
    return {
      values: refs.map((ref) => ({
        identifier: ref.identifier,
        field: ref.field,
        value: values.get(ref.identifier)![ref.field]!,
      })),
      // 已到期的照常给值，注明是哪几条（planned 的顺序就是标识第一次出现的顺序）
      expired: planned.flatMap(({ row }) =>
        credentialExpiry(row.expiresAt, now) === 'expired'
          ? [{ identifier: row.identifier, expiresAt: row.expiresAt!.toISOString() }]
          : [],
      ),
    }
  }

  // kioku_get 读到含占位符的记忆时，末尾列出这些凭据能不能取用：不给值，也不记访问
  async forPlaceholders(identifiers: string[]): Promise<PlaceholderCredential[]> {
    const wanted = [...new Set(identifiers)]
    const unavailable = (identifier: string): PlaceholderCredential => ({
      identifier,
      state: 'unavailable',
      name: null,
    })
    if (!wanted.length || credentialDenial(this.ctx.access, { appIds: null }, 'use')) {
      return wanted.map(unavailable)
    }
    // 密码库的凭据连上连接的状态：不请求密码库，连不上这类要到取用时才知道
    const rows = await this.run((tx) =>
      tx
        .select({ row: credentials, status: vaultConnections.status })
        .from(credentials)
        .leftJoin(vaultConnections, eq(vaultConnections.id, credentials.vaultConnectionId))
        .where(
          and(
            eq(credentials.ownerAccountId, this.owner),
            inArray(credentials.identifier, wanted),
            isNull(credentials.deletedAt),
          ),
        ),
    )
    return wanted.map((identifier) => {
      const found = rows.find((r) => r.row.identifier === identifier)
      if (!found || !canUseCredential(this.ctx.access, found.row)) return unavailable(identifier)
      const status = found.row.source === 'vault' ? (found.status ?? 'disconnected') : 'ok'
      const state = !this.ctx.masterKey ? 'master_key' : status === 'ok' ? 'usable' : status
      return { identifier, state, name: found.row.name }
    })
  }

  // 通过 Key 新建的只给这个应用用：被诱导的 agent 建的凭据不会被别的应用拿去用。
  // 写到哪里由成员的去处决定（有去处写进密码库，没有时托管）
  async keyCreate(input: KeyCreateCredentialRequest): Promise<KeyCreatedCredential> {
    this.requireManage()
    const { row, storedIn } = await this.createNew(input, [this.ctx.access.appId!])
    return { ...this.summary(row), storedIn }
  }

  async keyUpdate(
    identifier: string,
    input: Omit<KeyUpdateCredentialRequest, 'identifier'>,
  ): Promise<CredentialSummary> {
    // 先确认有管理权限，再找凭据：没有权限时不论存不存在都是 403
    this.requireManage()
    return this.summary(
      await this.change((tx) => this.manageableByIdentifier(tx, identifier), input),
    )
  }

  async keyDelete(identifier: string, expectedVersion?: number): Promise<void> {
    this.requireManage()
    await this.run(async (tx) => {
      await this.remove(tx, await this.manageableByIdentifier(tx, identifier), expectedVersion)
    })
  }
}

const FALLBACK_CLIENT = unavailableVaultClient()

// 条目里 TOTP 的密钥：凭据的 totp 字段给的是现算的验证码，不是密钥本身，按值比对与转存都不用它
const TOTP_FIELD = 'login.totp'
const CONVERT_TOTP = '验证码字段给出的是现算的验证码，不是条目里的密钥，不能用来转存'
const CONVERT_MISMATCH = '所选字段现在的值与要转存的值不同，未做任何修改。请确认选对了凭据与字段'
const CONVERT_TEXT_HAS_VALUE = '标识、名称、说明与字段名不能包含要转存的值'
const ITEM_BOUND = '这个条目已经起过标识，请改用这条凭据转存'
const ITEM_BOUND_CREATE = '这个条目已经起过标识，一个条目只对应一条有效凭据'

interface CollectedValues {
  // 当前账号的有效凭据，按标识排序
  rows: CredentialRow[]
  // 解开了的托管凭据：凭据 id → 各字段的值
  hosted: Map<string, Record<string, string>>
  // 取到了条目的连接：连接 id → 全部条目
  items: Map<string, VaultItem[]>
  unavailableConnections: number
  // 读不到值的托管凭据条数
  unreadableCredentials: number
}

// 托管的这条解开了（只是声明的字段没有存值，不算读不到）
// 读不到值的原因：master_key 是没配主密钥（托管的解不开、密码库的连接都打不开），hosted 是托管的解不开，
// vault 是密码库的连接或条目不可用
export type UnresolvedReason = 'master_key' | 'hosted' | 'vault'

// 能按值替换的值：和转存的请求同一个规则（ConvertibleValue）
export const isConvertibleValue = (value: string) => ConvertibleValue.safeParse(value).success

// 一条凭据的一个字段现在的值。只在服务端里比对用
export interface CredentialValueEntry {
  id: string
  identifier: string
  name: string
  field: string
  value: string
}

export interface KnownCredentialValues {
  // 按标识、字段排序：同一个值对上几条时取第一条。只有满足 ConvertibleValue 的值
  entries: CredentialValueEntry[]
  // 值读到了、却不能用来按值替换的字段（标识#字段）
  unconvertible: ReadonlySet<string>
  // 读不到值的凭据：标识 → 原因
  unresolved: ReadonlyMap<string, UnresolvedReason>
  unavailableConnections: number
  unreadableCredentials: number
}

// 转存的去处准备好了：占位符写成 {{cred:<identifier>#<field>}}，apply 在转存的事务里执行，返回凭据 id。
// storedIn：新建的凭据写到了哪里（起标识与已有的为 null）；orphan：已经写进密码库的条目，转存失败时要带进错误
export interface ConvertSink {
  identifier: string
  field: string
  created: boolean
  storedIn: CredentialStoredIn | null
  orphan?: OrphanVaultItem
  apply: (tx: Tx) => Promise<string>
}

// 各凭据字段现在的值：托管的取解开的，密码库的按字段对应取条目里的；TOTP 的密钥不算。读不到的不列
function credentialEntries(collected: CollectedValues): CredentialValueEntry[] {
  const entries: CredentialValueEntry[] = []
  for (const row of collected.rows) {
    const base = { id: row.id, identifier: row.identifier, name: row.name }
    if (row.source === 'hosted') {
      const values = collected.hosted.get(row.id)
      if (!values) continue
      for (const f of row.fields) {
        const value = values[f.name]
        if (value !== undefined) entries.push({ ...base, field: f.name, value })
      }
      continue
    }
    const item = collected.items.get(row.vaultConnectionId!)?.find((i) => i.id === row.vaultItemId)
    if (!item) continue
    for (const f of row.fields) {
      const value = f.itemField ? item.values[f.itemField] : undefined
      if (f.itemField === TOTP_FIELD || value === undefined || value === '') continue
      entries.push({ ...base, field: f.name, value })
    }
  }
  return entries.sort(
    (a, b) => a.identifier.localeCompare(b.identifier) || a.field.localeCompare(b.field),
  )
}

const byItemName = (a: VaultItem, b: VaultItem) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

// 重读的密文解不开：记成主密钥的问题
class SecretsUnreadable extends Error {
  constructor(readonly original: unknown) {
    super('密码库连接保存的令牌解不开')
  }
}
const ACCESS_RESULTS = new Set<string | null>(['ok', 'denied', 'failed'])
const ACCESS_REASONS = new Set<string | null>(Object.keys(CREDENTIAL_ACCESS_REASON_NAMES))

// 新建带值的凭据（管理界面、Key、转存共用）
type NewCredentialInput = {
  identifier: string
  name: string
  description?: string | null | undefined
  values: Record<string, string>
  url?: string | undefined
  expiresAt?: string | null | undefined
}

// planNew 的结果：托管（没设去处，或者在测试台里），或者已经写进密码库、在事务里建凭据的一步
type NewPlan =
  | { kind: 'hosted'; bench: boolean }
  | {
      kind: 'vault'
      storedIn: CredentialStoredIn
      orphan: OrphanVaultItem
      insert: (tx: Tx, appIds: string[] | null, boundText: string) => Promise<string>
    }

export const BENCH_VAULT_WRITE =
  '测试台不改密码库里的值：回滚模式撤不回密码库里的写入。请到凭据页修改。'
const DESTINATION_UNAVAILABLE = '新凭据的去处不可用：'

// 去处所在的连接现在能不能写：不能时给出说法（断开、要重新登录、停用都是 409）
function destinationProblem(connection: ConnectionRow): { status: 409; text: string } | null {
  if (connection.status === 'disconnected' || !connection.ciphertext) {
    return { status: 409, text: '连接已断开。请重新登录，或清除去处。' }
  }
  if (connection.status === 'reauth_required') {
    return { status: 409, text: '连接需要重新登录。' }
  }
  if (connection.status === 'disabled') {
    const why = connection.disabledReason
      ? `（${VAULT_DISABLED_REASON_NAMES[connection.disabledReason]}）`
      : ''
    return { status: 409, text: `连接已停用${why}。` }
  }
  return null
}

// 新条目怎么写：username、password 写成登录条目的用户名与密码，别的字段写成隐藏的自定义字段。
// 有用户名或密码的是登录类，网址按主机加端口匹配自动填充；否则是令牌类：给了网址时照样记下（登录条目才有网址），
// 但不参与匹配，没给时写成安全笔记。凭据的字段对应按同一个规则给出
export function newVaultItem(
  connection: Pick<ConnectionRow, 'defaultCollectionId' | 'defaultOrganizationId'>,
  input: Pick<NewCredentialInput, 'name' | 'values' | 'url'>,
): { item: VaultNewItem; fields: CredentialField[] } {
  const loginFields: Record<string, string> = VAULT_LOGIN_FIELD_NAMES
  const names = Object.keys(input.values).sort()
  const fields = names.map((name): CredentialField => ({
    name,
    itemField: Object.hasOwn(loginFields, name) ? loginFields[name]! : `field:${name}`,
  }))
  const login = names.some((n) => Object.hasOwn(loginFields, n))
  const values = Object.fromEntries(fields.map((f) => [f.itemField!, input.values[f.name]!]))
  return {
    item: {
      organizationId: connection.defaultOrganizationId!,
      collectionId: connection.defaultCollectionId!,
      type: login || input.url ? 'login' : 'note',
      name: input.name,
      values,
      ...(input.url ? { uris: [{ uri: input.url, autofill: login }] } : {}),
    },
    fields,
  }
}

// 写回的值对应到条目的字段：只能改字段对应里已有的字段，不能删字段、不能改 TOTP 的密钥。
// 在调客户端之前拦下：客户端遇到不认识的字段会以 unsupported_format 失败，不能让它走到调用方
export function vaultChanges(
  row: Pick<CredentialRow, 'identifier' | 'fields'>,
  values: Record<string, string | null>,
): { values: Record<string, string>; names: string[] } {
  const out: Record<string, string> = {}
  const names: string[] = []
  for (const [name, value] of Object.entries(values)) {
    if (value === null) {
      throw new MemoryError(400, `密码库的凭据不能删字段（${name}），请到密码库里修改`)
    }
    const field = row.fields.find((f) => f.name === name)
    if (!field?.itemField) {
      throw new MemoryError(
        400,
        `凭据 ${row.identifier} 没有字段 ${name}：密码库的凭据只能改字段对应里已有的字段`,
      )
    }
    if (field.itemField === TOTP_FIELD) {
      throw new MemoryError(400, 'TOTP 的密钥不由 Kioku 写入，请到密码库里修改')
    }
    if (Object.hasOwn(out, field.itemField) && out[field.itemField] !== value) {
      throw new MemoryError(400, `字段 ${name} 与别的字段对应同一个条目字段，值不能不同`)
    }
    out[field.itemField] = value
    names.push(name)
  }
  return { values: out, names: names.sort() }
}

// 写进密码库失败的说法，不带值：新建（去处的集合）与写回（原条目）的开头不同
export function writeFailure(err: unknown, action: 'create' | 'update'): unknown {
  const head = action === 'create' ? '无法写进新凭据的去处：' : '无法写回密码库：'
  if (err instanceof VaultDisabledError) {
    return new MemoryError(409, `${head}连接已停用（${VAULT_DISABLED_REASON_NAMES[err.reason]}）`)
  }
  if (err instanceof SecretsUnreadable) {
    return new MemoryError(400, `${head}${CREDENTIAL_ACCESS_REASON_NAMES.master_key}`)
  }
  if (!(err instanceof VaultError)) return err
  const kind: string = err.kind
  switch (kind) {
    case 'item_conflict':
      return new MemoryError(
        409,
        `${head}${VAULT_ERROR_KIND_NAMES.item_conflict}。请先重新读取凭据，再带新的版本号修改`,
        undefined,
        { reason: 'item_conflict' },
      )
    case 'read_only':
      return new MemoryError(
        409,
        `${head}${VAULT_ERROR_KIND_NAMES.read_only}：专用账号要有这个集合的编辑权限`,
        undefined,
        { reason: 'read_only' },
      )
    case 'value_too_long':
      return new MemoryError(
        400,
        action === 'create'
          ? `${head}${VAULT_ERROR_KIND_NAMES.value_too_long}。请缩短值，或清除去处、改由 Kioku 托管`
          : `${head}${VAULT_ERROR_KIND_NAMES.value_too_long}，请缩短值`,
        undefined,
        { reason: 'value_too_long' },
      )
  }
  const reason = vaultReason(err.kind)
  return new MemoryError(reasonStatus(reason), `${head}${CREDENTIAL_ACCESS_REASON_NAMES[reason]}`)
}

const revisionDate = (revision: string): Date | null => {
  const at = new Date(revision)
  return Number.isNaN(at.getTime()) ? null : at
}

// 凭据现在的值版本：托管的是值版本号，密码库的是最近看到的条目修改时间（还没看到过时为 null）
function currentValueRevision(row: CredentialRow): ValueRevision | null {
  if (row.source === 'hosted') return { valueVersion: row.valueVersion }
  return row.vaultRevision === null ? null : { itemRevision: row.vaultRevision }
}

// 访问事件交出的是不是现在的值（CredentialEvent.sinceValueChange）：交出了值、记下了值版本时比较，别的为 null。
// SQL 的一份是 deliveredRevision，两边由 credentialRotation.int.test.ts 比对
export function sinceValueChangeOf(
  eventType: string,
  context: Record<string, unknown>,
  current: ValueRevision | null,
): boolean | null {
  if (eventType !== 'access' || context.result !== 'ok') return null
  if (typeof context.valueVersion === 'number') {
    return !!current && 'valueVersion' in current && context.valueVersion === current.valueVersion
  }
  if (typeof context.itemRevision === 'string') {
    return !!current && 'itemRevision' in current && context.itemRevision === current.itemRevision
  }
  return null
}

function deliveredRevision(current: ValueRevision | null): SQL {
  if (!current) return sql`false`
  const ok = sql`${credentialEvents.eventType} = 'access' and ${credentialEvents.context} ->> 'result' = 'ok'`
  return 'valueVersion' in current
    ? sql`(${ok} and jsonb_typeof(${credentialEvents.context} -> 'valueVersion') = 'number' and ${credentialEvents.context} ->> 'valueVersion' = ${String(current.valueVersion)})`
    : sql`(${ok} and jsonb_typeof(${credentialEvents.context} -> 'itemRevision') = 'string' and ${credentialEvents.context} ->> 'itemRevision' = ${current.itemRevision})`
}

// 已到期的照常给值，结果里注明
function expiredNotice(row: CredentialRow): string {
  return credentialExpiry(row.expiresAt, Date.now()) === 'expired'
    ? `注意：这条凭据已于 ${row.expiresAt!.toISOString()} 到期，值可能已失效。`
    : ''
}

// 条目所在集合的名称（起标识的响应用）：在几个集合里时，去处的那个集合优先，否则按名称排在最前的那个
function itemCollectionName(
  collectionIds: readonly string[],
  collections: VaultSnapshot['collections'],
  connection: Pick<ConnectionRow, 'defaultCollectionId'>,
): string {
  const names = collections.filter((c) => collectionIds.includes(c.id))
  const preferred = names.find((c) => c.id === connection.defaultCollectionId)
  return (preferred ?? [...names].sort((a, b) => a.name.localeCompare(b.name))[0])?.name ?? ''
}

// 写回的结果：写回之后的条目、改了的字段与发给密码库的期望修改时间
type Written = { item: VaultItem; fields: string[]; expected: string }

// 写回之后要记下的修改时间：和 observeRevisions 一样不往回改，库里已经是更新的（并发的取用看到了别处的又一次修改）就不动
function writtenRevision(
  current: Pick<CredentialRow, 'vaultRevision'>,
  written: Written,
): { vaultRevision?: string; valueChangedAt?: Date } {
  const revision = written.item.revisionDate
  if (current.vaultRevision !== null && !isNewerRevision(revision, current.vaultRevision)) return {}
  return { vaultRevision: revision, valueChangedAt: revisionDate(revision) ?? new Date() }
}

const WRITTEN_BUT_STALE = '值已写进密码库，其余改动因凭据已在别处修改而没有保存，请重新读取后再改'
const WRITTEN_BUT_DELETED = '值已写进密码库，但凭据在此期间被删除'
const WRITTEN_BUT_GONE = '值已写进密码库，但凭据在此期间被永久清除'
