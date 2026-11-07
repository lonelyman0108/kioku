import { randomUUID } from 'node:crypto'

import {
  CREDENTIAL_ACCESS_REASON_NAMES,
  defaultCredentialFields,
  MAX_CREDENTIAL_FIELDS,
  VAULT_DISABLED_REASON_NAMES,
  type ConsoleCredential,
  type ConsoleCredentialList,
  type CreateCredentialRequest,
  type CredentialAccess,
  type CredentialAccessReason,
  type CredentialAccessResult,
  type CredentialEventList,
  type CredentialField,
  type CredentialFieldRef,
  type CredentialReferenceList,
  type CredentialSummary,
  type CredentialValues,
  type KeyCreateCredentialRequest,
  type KeyCredentialList,
  type PageQuery,
  type ResolvedCredentials,
  type UpdateCredentialRequest,
} from '@kioku/contracts'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'

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
import { benchMarkReader, MemoryError } from '../memory/service'
import { formatUri } from '../memory/uri'
import { VaultError, type VaultClient, type VaultItem, type VaultSession } from './bitwarden/types'
import { CREDENTIAL_NOTICE } from './methods'
import { totpCode } from './bitwarden/totp'
import {
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
type CredentialChange = 'name' | 'description' | 'values' | 'fields' | 'appIds'

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
}

// 取值第一段的结果：已经有值（托管的）、要向密码库取（密码库的），或者失败（已记好事件，提交之后抛出）
type Prepared =
  | { kind: 'values'; values: Record<string, string> | null }
  | { kind: 'vault'; connection: ConnectionRow; session: VaultSession }
  // 失败：错误的文字由抛出的地方组装；field 是引起失败的字段（缺值的那个），整条凭据的失败没有
  | { kind: 'error'; reason: CredentialAccessReason; detail?: string; field?: string }

// 第二段向密码库取条目的结果，第三段按它记访问事件、更新连接。
// unexpected 不是密码库报的错（解不开重读的密文、保存新令牌时的数据库错误等），记一条失败后原样抛出
interface Fetched {
  connection: ConnectionRow
  // 这次真正用的会话：重试时换成新建的那个，record 按它判断要删哪个缓存
  used: VaultSession
  outcome: VaultOutcome | null
  result: Record<string, string> | CredentialAccessReason
  // result 为 field_missing 时，条目里缺的是哪个字段
  missing?: string
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
    input: KeyCreateCredentialRequest,
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
      })
      .returning()
    await this.event(tx, id, 'create')
    return row!
  }

  private async modify(
    tx: Tx,
    before: CredentialRow,
    input: Omit<UpdateCredentialRequest, 'appIds'> & { appIds?: string[] | null | undefined },
  ): Promise<CredentialRow> {
    this.requireManage()
    if (before.deletedAt) throw new MemoryError(409, '这条凭据已删除。请先恢复，再修改。')
    if (input.expectedVersion !== before.version) {
      throw new MemoryError(409, `版本已变化：当前是 ${before.version}，请先重新读取`)
    }
    if (input.values !== undefined && before.source !== 'hosted') {
      throw new MemoryError(400, '这条凭据的值在密码库里，Kioku 不保存，到密码库里修改')
    }
    if (input.fields !== undefined && before.source !== 'vault') {
      throw new MemoryError(400, '字段对应只用于密码库的凭据；托管的凭据改 values')
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
    if (input.values !== undefined) {
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
      // 被诱导的 agent 不能给自己放宽
      if (this.viaKey) throw new MemoryError(403, '限定的应用只能在管理界面修改')
      const appIds = input.appIds === null ? null : [...new Set(input.appIds)].sort()
      if (!sameJson(appIds, before.appIds)) {
        set.appIds = appIds
        changes.push('appIds')
      }
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
    return new MemoryError(409, `版本已变化：当前是 ${now.version}，请先重新读取`)
  }

  private async remove(tx: Tx, before: CredentialRow, expectedVersion?: number): Promise<void> {
    this.requireManage()
    if (before.deletedAt) throw new MemoryError(409, '这条凭据已删除')
    if (expectedVersion !== undefined && expectedVersion !== before.version) {
      throw new MemoryError(409, `版本已变化：当前是 ${before.version}，请先重新读取`)
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
    const record = (result: CredentialAccessResult, reason: CredentialAccessReason | null) =>
      this.accessEvent(tx, row.id, { via, fields: names, purpose, result, reason })
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
      if (!deferOk) await record('ok', null)
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
      throw failureError(prepared.reason, row.identifier, prepared.detail)
    }
    if (prepared.kind === 'values') return prepared.values
    const fetched = await this.fetchItem(row, fields, prepared)
    const { result } = fetched
    if (fetched.unexpected !== null) {
      // 记失败本身也可能出错（例如数据库连不上）：记进日志，抛出原来的错误
      await this.run((tx) => this.settle(tx, row, fields, via, purpose, fetched)).catch(
        (err: unknown) => logInternalError('凭据取用失败之后记访问事件出错', err),
      )
      // 解不开令牌和 prepare 里一样给出「主密钥不可用」；别的意外原样抛出，按内部错误处理
      if (result === 'master_key') throw failureError(result, row.identifier)
      throw fetched.unexpected
    }
    await this.run((tx) => this.settle(tx, row, fields, via, purpose, fetched))
    if (typeof result === 'string') throw failureError(result, row.identifier)
    return result
  }

  // 第二段：在事务外向密码库取条目，取出要的字段。不抛错，结果交给 settle 记下
  private async fetchItem(
    row: CredentialRow,
    fields: CredentialField[],
    prepared: Extract<Prepared, { kind: 'vault' }>,
  ): Promise<Fetched> {
    let outcome: VaultOutcome | null
    let result: Record<string, string> | CredentialAccessReason
    let missing: string | undefined
    let unexpected: unknown = null
    let connection = prepared.connection
    let used = prepared.session
    try {
      let item: VaultItem
      try {
        item = await prepared.session.item(row.vaultItemId!)
      } catch (err) {
        // 刷新令牌失效之前先重读一次：别的进程可能刚换过令牌（密文变了），用新的建会话再试一次，
        // 还是失败才算需要重新登录
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
        let session: VaultSession
        try {
          session = this.vault.session(fresh)
        } catch (openErr) {
          throw new SecretsUnreadable(openErr)
        }
        used = session
        item = await session.item(row.vaultItemId!)
      }
      outcome = { kind: 'ok' }
      result = itemValues(item, fields)
      if (result === 'field_missing') {
        missing = fields.find((f) => itemValues(item, [f]) === 'field_missing')?.name
      }
    } catch (err) {
      if (err instanceof VaultDisabledError) {
        outcome = { kind: 'disabled' }
        result = 'disabled'
      } else if (err instanceof VaultError) {
        outcome = { kind: 'error', error: err.kind }
        result = vaultReason(err.kind)
      } else {
        // 和 prepare 里解不开令牌一样记成主密钥的问题；别的意外（数据库错误等）记成 Kioku 内部出错，
        // 不说成密码库的问题。连接的状态不改
        outcome = null
        result = err instanceof SecretsUnreadable ? 'master_key' : 'internal_error'
        unexpected = err
      }
    }
    return { connection, used, outcome, result, ...(missing ? { missing } : {}), unexpected }
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
    if (!record) return
    const failed = typeof fetched.result === 'string'
    await this.accessEvent(tx, row.id, {
      via,
      fields: fields.map((f) => f.name),
      purpose,
      result: failed ? 'failed' : 'ok',
      reason: failed ? (fetched.result as CredentialAccessReason) : null,
    })
  }

  // ---- 管理界面 ----

  async list(): Promise<ConsoleCredentialList> {
    return this.listWhere(isNull(credentials.deletedAt), asc(credentials.identifier))
  }

  // 已删除的，最近删除的在前
  async listDeleted(): Promise<ConsoleCredentialList> {
    return this.listWhere(isNotNull(credentials.deletedAt), desc(credentials.deletedAt))
  }

  private async listWhere(
    where: ReturnType<typeof isNull>,
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

  async create(input: CreateCredentialRequest): Promise<ConsoleCredential> {
    this.requireManage()
    // 在管理界面新建的默认不限定应用，由所有者决定
    const appIds = input.appIds ? [...new Set(input.appIds)].sort() : null
    const conflict = `标识已被占用或不可用：${input.identifier}`
    const { source } = input
    if (source.kind === 'hosted') {
      return this.run(
        async (tx) =>
          this.consoleViewOf(
            tx,
            await this.insertHosted(tx, { ...input, values: source.values }, appIds),
          ),
        conflict,
      )
    }
    // 给密码库的条目起标识：先向密码库取这个条目，确认读得到、字段对得上，再写库
    const connection = await this.run((tx) => this.vault.load(tx, source.connectionId))
    if (!connection) throw new MemoryError(404, '密码库连接不存在')
    if (connection.status !== 'ok') {
      throw new MemoryError(409, '密码库连接不可用，请先在密码库里重新检查或重新登录')
    }
    let item: VaultItem
    try {
      item = await this.vault.session(connection).item(source.itemId)
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
      const id = randomUUID()
      const [row] = await tx
        .insert(credentials)
        .values({
          id,
          spaceId: this.ctx.spaceId,
          ownerAccountId: this.owner,
          identifier: input.identifier,
          name: input.name,
          description: input.description ?? null,
          source: 'vault',
          vaultConnectionId: connection.id,
          vaultItemId: source.itemId,
          fields,
          appIds,
        })
        .returning()
      await this.event(tx, id, 'create')
      // 刚才那次取条目是成功的：和插入放在一个事务里更新连接
      await this.vault.record(tx, connection, { kind: 'ok' })
      return this.consoleViewOf(tx, row!)
    }, conflict)
  }

  // 在调用方的事务里新建一条托管的凭据，返回 id（转存为凭据：和改记忆放在一个事务里）。
  // 标识冲突在这里转成 409：调用方的事务随这个错误整个回滚
  async createHostedIn(
    tx: Tx,
    input: Pick<CreateCredentialRequest, 'identifier' | 'name' | 'description'> & {
      values: Record<string, string>
    },
  ): Promise<string> {
    try {
      return (await this.insertHosted(tx, input, null)).id
    } catch (err) {
      if (isUniqueViolation(err, 'credentials_identifier_live_idx')) {
        throw new MemoryError(409, `标识已被占用或不可用：${input.identifier}`)
      }
      throw err
    }
  }

  // 在调用方的事务里读一条自己的凭据：引用的条数要算上这个事务刚写的
  async viewIn(tx: Tx, id: string): Promise<ConsoleCredential> {
    return this.consoleViewOf(tx, await this.ownById(tx, id))
  }

  async update(id: string, input: UpdateCredentialRequest): Promise<ConsoleCredential> {
    return this.run(async (tx) =>
      this.consoleViewOf(tx, await this.modify(tx, await this.ownById(tx, id), input)),
    )
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
    const { row, prepared } = await this.run(async (tx) => {
      const row = await this.ownById(tx, id)
      if (row.deletedAt) throw new MemoryError(409, '这条凭据已删除。请先恢复，再查看。')
      return { row, prepared: await this.prepare(tx, row, row.fields, 'console', undefined) }
    })
    return { values: (await this.deliver(row, row.fields, 'console', undefined, prepared)) ?? {} }
  }

  // 一条凭据的事件，最新的在前。Key 的名字和 Key 列表一样，只给应用所有者与空间 owner 看
  async events(id: string, page: PageQuery): Promise<CredentialEventList> {
    this.requireUse()
    if (page.cursor !== undefined && !EVENT_ID.test(page.cursor)) {
      throw new MemoryError(400, '翻页参数无效，请从第一页重新开始')
    }
    return this.run(async (tx) => {
      await this.ownById(tx, id)
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
      return { row, fields, prepared: await this.prepare(tx, row, fields, via, purpose) }
    })
    if ('error' in first) throw first.error
    const values = await this.deliver(first.row, first.fields, via, purpose, first.prepared)
    return {
      credential: this.summary(first.row),
      values,
      notice: CREDENTIAL_NOTICE,
    }
  }

  // 准备过的密码库凭据都要经过 vault.record（没有取条目的传 null，只确认连接还能不能用）：
  // 断开与准备交错时，会话可能在断开提交之后才放回缓存，靠它清掉。出错只记日志，不盖过原来的错误
  private async releaseSessions(
    sessions: { connection: ConnectionRow; session: VaultSession }[],
  ): Promise<void> {
    if (!sessions.length) return
    await this.run(async (tx) => {
      for (const { connection, session } of sessions) {
        await this.vault.record(tx, connection, null, session)
      }
    }).catch((err: unknown) => logInternalError('凭据取用失败之后确认连接状态出错', err))
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
    const sessions: { connection: ConnectionRow; session: VaultSession }[] = []

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
      const worst: { index: number; error: MemoryError | null } = { index: Infinity, error: null }
      const fail = (index: number, error: MemoryError) => {
        if (index < worst.index) Object.assign(worst, { index, error })
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
      if (worst.error) return { error: worst.error }

      // 都通过了：托管的解开（先不记交出），密码库的确认连接可用。失败的那条已记好事件
      const prepared: Prepared[] = []
      for (const { row, fields } of planned) {
        const p = await this.prepare(tx, row, fields, via, purpose, true)
        if (p.kind === 'error') {
          const where = p.field ? `${row.identifier}#${p.field}` : row.identifier
          return { error: failureError(p.reason, where, p.detail) }
        }
        if (p.kind === 'vault') sessions.push({ connection: p.connection, session: p.session })
        prepared.push(p)
      }
      return { planned, prepared }
    }).catch(async (err: unknown) => {
      await this.releaseSessions(sessions)
      throw err
    })
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
    // 取过的都更新连接。有取不到的时只给它记失败，取到了却没交出的不记；没轮到取的只确认连接状态
    const settleFetched = async (tx: Tx) => {
      for (const [i, f] of fetched) {
        const { row, fields } = planned[i]!
        await this.settle(tx, row, fields, via, purpose, f, failed === null || i === failed)
      }
      for (const [i, p] of prepared.entries()) {
        if (p.kind === 'vault' && !fetched.has(i)) {
          await this.vault.record(tx, p.connection, null, p.session)
        }
      }
    }
    if (failed !== null) {
      const f = fetched.get(failed)!
      const { row } = planned[failed]!
      const reason = f.result as CredentialAccessReason
      const where = f.missing ? `${row.identifier}#${f.missing}` : row.identifier
      if (f.unexpected !== null) {
        await this.run(settleFetched).catch((err: unknown) =>
          logInternalError('凭据取用失败之后记访问事件出错', err),
        )
        if (reason === 'master_key') throw failureError(reason, where)
        throw f.unexpected
      }
      await this.run(settleFetched)
      throw failureError(reason, where)
    }

    // 第三段：都取到了，一起记交出（密码库的在 settleFetched 里记）
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
        })
      }
    })
    const values = new Map<string, Record<string, string>>()
    for (const [i, { row }] of planned.entries()) {
      const p = prepared[i]!
      const got =
        p.kind === 'values' ? p.values : (fetched.get(i)!.result as Record<string, string>)
      values.set(row.identifier, got ?? {})
    }
    return {
      values: refs.map((ref) => ({
        identifier: ref.identifier,
        field: ref.field,
        value: values.get(ref.identifier)![ref.field]!,
      })),
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

  // 通过 Key 新建的只给这个应用用：被诱导的 agent 建的凭据不会被别的应用拿去用。只收托管的值
  async keyCreate(input: KeyCreateCredentialRequest): Promise<CredentialSummary> {
    this.requireManage()
    return this.run(
      async (tx) => this.summary(await this.insertHosted(tx, input, [this.ctx.access.appId!])),
      `标识已被占用或不可用：${input.identifier}`,
    )
  }

  async keyUpdate(
    identifier: string,
    input: Omit<UpdateCredentialRequest, 'appIds' | 'fields'>,
  ): Promise<CredentialSummary> {
    // 先确认有管理权限，再找凭据：没有权限时不论存不存在都是 403
    this.requireManage()
    return this.run(async (tx) => {
      const before = await this.manageableByIdentifier(tx, identifier)
      return this.summary(await this.modify(tx, before, input))
    })
  }

  async keyDelete(identifier: string, expectedVersion?: number): Promise<void> {
    this.requireManage()
    await this.run(async (tx) => {
      await this.remove(tx, await this.manageableByIdentifier(tx, identifier), expectedVersion)
    })
  }
}

const FALLBACK_CLIENT = unavailableVaultClient()

// 重读的密文解不开：记成主密钥的问题
class SecretsUnreadable extends Error {
  constructor(readonly original: unknown) {
    super('密码库连接保存的令牌解不开')
  }
}
const ACCESS_RESULTS = new Set<string | null>(['ok', 'denied', 'failed'])
const ACCESS_REASONS = new Set<string | null>(Object.keys(CREDENTIAL_ACCESS_REASON_NAMES))
