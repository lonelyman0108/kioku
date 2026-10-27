import { randomUUID } from 'node:crypto'

import {
  MAX_CREDENTIAL_FIELDS,
  type ConsoleCredential,
  type ConsoleCredentialList,
  type CreateCredentialProviderRequest,
  type CreateCredentialRequest,
  type CredentialAccess,
  type CredentialEventList,
  type CredentialField,
  type CredentialInfo,
  type CredentialProvider,
  type CredentialSourceInput,
  type CredentialSourceUpdate,
  type CredentialSummary,
  type CredentialValues,
  type KeyCredentialList,
  type PageQuery,
  type UpdateCredentialProviderRequest,
  type UpdateCredentialRequest,
} from '@kioku/contracts'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'

import {
  canManageCredentials,
  canReadCredential,
  canRevealCredential,
  type Access,
} from '../access/access'
import { decryptSecret, encryptSecret } from '../crypto/envelope'
import { isUniqueViolation, withSpace, type Db, type Tx } from '../db/client'
import {
  accounts,
  apiKeys,
  apps,
  credentialEvents,
  credentialProviders,
  credentials,
} from '../db/schema'
import { MemoryError } from '../memory/service'
import { CREDENTIAL_NOTICE, externalMethod } from './methods'

export interface CredentialContext {
  db: Db
  spaceId: string
  // 凭据按这次访问代表的成员找：管理界面是成员本人，Key 是应用主人
  access: Access
  masterKey: Buffer | null
  actor: { keyId?: string; accountId?: string }
}

// 取用经由哪里，记在访问事件里
export type CredentialVia = 'kioku_credential' | 'rest'

type CredentialRow = typeof credentials.$inferSelect
type ProviderRow = typeof credentialProviders.$inferSelect

// 写入之后的一行，以及写入时读到的凭据源：null 是托管的，undefined 是这次没动来源
interface Written {
  row: CredentialRow
  provider?: ProviderRow | null | undefined
}

// 改了凭据的哪些部分，记在修改事件里（不含任何值）
type CredentialChange =
  'name' | 'description' | 'source' | 'provider' | 'location' | 'fields' | 'values' | 'appIds'

// 一次列出的凭据上限，个人用的空间远到不了
const LIST_LIMIT = 1000
const EVENT_ID = /^\d{1,15}$/

// 托管的值整体加密，aad 绑定凭据 id：把一条凭据的密文挪到别的凭据或记忆上会解密失败
const aadOf = (id: string) => `credential:${id}`

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export class CredentialService {
  constructor(private readonly ctx: CredentialContext) {}

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
      throw err
    }
  }

  // 能不能读到凭据：读不到私人层的 Key（以及群聊、私聊、定时任务等会话上下文）一条都看不到
  private requireRead(): void {
    if (!canReadCredential(this.ctx.access, { ownerAccountId: this.owner, appIds: null })) {
      throw new MemoryError(403, '读不到凭据：需要能读私人层、最高敏感级至少 private')
    }
  }

  private requireManage(): void {
    if (!canManageCredentials(this.ctx.access)) {
      throw new MemoryError(403, '没有权限管理凭据：需要能读写私人层，并且是 secret 级')
    }
  }

  private seal(id: string, values: Record<string, string>) {
    if (!this.ctx.masterKey) {
      throw new MemoryError(400, '服务端没有配置 KIOKU_MASTER_KEY，不能保存托管的凭据')
    }
    return encryptSecret(this.ctx.masterKey, JSON.stringify(values), aadOf(id))
  }

  private open(row: CredentialRow): Record<string, string> {
    if (!row.ciphertext || !row.wrappedKey) return {}
    if (!this.ctx.masterKey) {
      throw new MemoryError(400, '服务端没有配置 KIOKU_MASTER_KEY，无法解密托管的凭据')
    }
    const text = decryptSecret(
      this.ctx.masterKey,
      { ciphertext: row.ciphertext, wrappedKey: row.wrappedKey },
      aadOf(row.id),
    )
    return JSON.parse(text) as Record<string, string>
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
      context,
    })
  }

  // ---- 读出与视图 ----

  private async providersOf(tx: Tx, rows: CredentialRow[]): Promise<Map<string, ProviderRow>> {
    const ids = [...new Set(rows.map((r) => r.providerId).filter((id): id is string => !!id))]
    if (!ids.length) return new Map()
    const found = await tx
      .select()
      .from(credentialProviders)
      .where(inArray(credentialProviders.id, ids))
    return new Map(found.map((p) => [p.id, p]))
  }

  private base(row: CredentialRow, providers: Map<string, ProviderRow>) {
    const provider = row.providerId ? providers.get(row.providerId) : undefined
    return {
      id: row.id,
      identifier: row.identifier,
      name: row.name,
      description: row.description,
      source: row.source,
      provider: provider
        ? {
            id: provider.id,
            kind: provider.kind,
            name: provider.name,
            deleted: provider.deletedAt !== null,
          }
        : null,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  private info(row: CredentialRow, providers: Map<string, ProviderRow>): CredentialInfo {
    return { ...this.base(row, providers), location: row.location, fields: row.fields }
  }

  private summary(row: CredentialRow, providers: Map<string, ProviderRow>): CredentialSummary {
    return { ...this.base(row, providers), fields: row.fields.map((f) => f.name) }
  }

  private consoleView(row: CredentialRow, providers: Map<string, ProviderRow>): ConsoleCredential {
    return {
      ...this.info(row, providers),
      appIds: row.appIds,
      deletedAt: row.deletedAt?.toISOString() ?? null,
    }
  }

  // 已经知道凭据源时直接用（写入时刚读过），否则查一次
  private async providersFor(tx: Tx, { row, provider }: Written) {
    if (provider === undefined) return this.providersOf(tx, [row])
    return new Map(provider ? [[provider.id, provider]] : [])
  }

  private async consoleViewOf(tx: Tx, written: Written): Promise<ConsoleCredential> {
    return this.consoleView(written.row, await this.providersFor(tx, written))
  }

  private async summaryOf(tx: Tx, written: Written): Promise<CredentialSummary> {
    return this.summary(written.row, await this.providersFor(tx, written))
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

  // Key：按标识找应用主人的有效凭据。不存在与看不到（包括限定给别的应用的）一律 404
  private async visibleByIdentifier(tx: Tx, identifier: string): Promise<CredentialRow> {
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
    if (!row || !canReadCredential(this.ctx.access, row)) {
      throw new MemoryError(404, `凭据不存在：${identifier}`)
    }
    return row
  }

  // ---- 来源 ----

  private async liveProvider(tx: Tx, providerId: string): Promise<ProviderRow> {
    const [row] = await tx
      .select()
      .from(credentialProviders)
      .where(
        and(
          eq(credentialProviders.id, providerId),
          eq(credentialProviders.ownerAccountId, this.owner),
          isNull(credentialProviders.deletedAt),
        ),
      )
      // 和删除凭据源互斥：删除那边锁住这一行再数绑定，这边等它提交后重新读，读到已删除就是 404
      .for('share')
    if (!row) throw new MemoryError(404, '凭据源不存在')
    return row
  }

  // 按请求算出来源相关的几列。托管的值与现有的合并：给了 null 的字段删掉，没给的不变；
  // 从外部来源改成托管时，现有的值为空，给出的就是全部字段
  private async sourceColumns(
    tx: Tx,
    id: string,
    source: CredentialSourceInput | CredentialSourceUpdate,
    before: CredentialRow | null,
  ) {
    if (source.kind === 'external') {
      const provider = await this.liveProvider(tx, source.providerId)
      return {
        columns: {
          source: 'external' as const,
          providerId: source.providerId,
          location: source.location,
          fields: source.fields,
          ciphertext: null,
          wrappedKey: null,
        },
        // 从托管改成外部时，Kioku 里存的值就删掉了，事件里要记下是哪些字段
        changedValues:
          before?.source === 'hosted' ? before.fields.map((f) => f.name).sort() : ([] as string[]),
        provider,
      }
    }
    const current = before?.source === 'hosted' ? this.open(before) : {}
    const merged: Record<string, string> = { ...current }
    for (const [name, value] of Object.entries(source.values)) {
      if (value === null) delete merged[name]
      else merged[name] = value
    }
    const names = Object.keys(merged).sort()
    if (!names.length) throw new MemoryError(400, '托管的凭据至少要有一个字段')
    if (names.length > MAX_CREDENTIAL_FIELDS) {
      throw new MemoryError(400, `一条凭据最多 ${MAX_CREDENTIAL_FIELDS} 个字段`)
    }
    const changedValues = [...new Set([...Object.keys(current), ...names])]
      .filter((name) => current[name] !== merged[name])
      .sort()
    // 值没变时沿用原来的密文，不再加密一遍
    const sealed =
      before?.source === 'hosted' && !changedValues.length
        ? { ciphertext: before.ciphertext, wrappedKey: before.wrappedKey }
        : this.seal(id, Object.fromEntries(names.map((n) => [n, merged[n]!])))
    return {
      columns: {
        source: 'hosted' as const,
        providerId: null,
        location: null,
        fields: names.map((name): CredentialField => ({ name, sourceField: null })),
        ...sealed,
      },
      changedValues,
      provider: null,
    }
  }

  // ---- 写入（管理界面与 Key 共用）----

  private async insert(
    tx: Tx,
    input: Omit<CreateCredentialRequest, 'appIds'>,
    appIds: string[] | null,
  ): Promise<Written> {
    this.requireManage()
    const id = randomUUID()
    const { columns, provider } = await this.sourceColumns(tx, id, input.source, null)
    const [row] = await tx
      .insert(credentials)
      .values({
        id,
        spaceId: this.ctx.spaceId,
        ownerAccountId: this.owner,
        identifier: input.identifier,
        name: input.name,
        description: input.description ?? null,
        ...columns,
        appIds,
      })
      .returning()
    await this.event(tx, id, 'create')
    return { row: row!, provider }
  }

  private async modify(
    tx: Tx,
    before: CredentialRow,
    input: Omit<UpdateCredentialRequest, 'appIds'> & { appIds?: string[] | null | undefined },
  ): Promise<Written> {
    this.requireManage()
    if (before.deletedAt) throw new MemoryError(409, '这条凭据已被删除，先恢复再修改')
    if (input.expectedVersion !== before.version) {
      throw new MemoryError(409, `版本已变化：当前是 ${before.version}，请先重新读取`)
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
    let provider: ProviderRow | null | undefined
    if (input.source) {
      const next = await this.sourceColumns(tx, before.id, input.source, before)
      Object.assign(set, next.columns)
      changedValues = next.changedValues
      provider = next.provider
      if (next.columns.source !== before.source) changes.push('source')
      if (next.columns.providerId !== before.providerId) changes.push('provider')
      if (next.columns.location !== before.location) changes.push('location')
      if (!sameJson(next.columns.fields, before.fields)) changes.push('fields')
      if (changedValues.length) changes.push('values')
    }
    if (input.appIds !== undefined) {
      // 被诱导的 agent 不能给自己放宽
      if (this.viaKey) throw new MemoryError(403, '限定给哪些应用只能在管理界面改')
      const appIds = input.appIds === null ? null : [...new Set(input.appIds)].sort()
      if (!sameJson(appIds, before.appIds)) {
        set.appIds = appIds
        changes.push('appIds')
      }
    }
    // 什么都没改时不升版本、不记事件：别的页面拿着同一个版本号还能接着改
    if (!changes.length) return { row: before, provider }
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
    if (!row) throw new MemoryError(409, '凭据刚被其他请求修改，请重新读取')
    await this.event(tx, before.id, 'update', {
      changes,
      ...(changedValues.length ? { fields: changedValues } : {}),
    })
    return { row, provider }
  }

  private async remove(tx: Tx, before: CredentialRow, expectedVersion?: number): Promise<void> {
    this.requireManage()
    if (before.deletedAt) throw new MemoryError(409, '这条凭据已被删除')
    if (expectedVersion !== undefined && expectedVersion !== before.version) {
      throw new MemoryError(409, `版本已变化：当前是 ${before.version}，请先重新读取`)
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
    if (!row) throw new MemoryError(409, '凭据刚被其他请求修改，请重新读取')
    await this.event(tx, before.id, 'delete')
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
    this.requireRead()
    return this.run(async (tx) => {
      const rows = await tx
        .select()
        .from(credentials)
        .where(and(eq(credentials.ownerAccountId, this.owner), where))
        .orderBy(order, asc(credentials.id))
        .limit(LIST_LIMIT + 1)
      const page = rows.slice(0, LIST_LIMIT)
      const providers = await this.providersOf(tx, page)
      return {
        items: page.map((r) => this.consoleView(r, providers)),
        truncated: rows.length > LIST_LIMIT,
      }
    })
  }

  async get(id: string): Promise<ConsoleCredential> {
    this.requireRead()
    return this.run(async (tx) => this.consoleViewOf(tx, { row: await this.ownById(tx, id) }))
  }

  async create(input: CreateCredentialRequest): Promise<ConsoleCredential> {
    return this.run(async (tx) => {
      // 在管理界面新建的默认不限定应用，由主人决定
      const appIds = input.appIds ? [...new Set(input.appIds)].sort() : null
      return this.consoleViewOf(tx, await this.insert(tx, input, appIds))
    }, `标识已被占用或不可用：${input.identifier}`)
  }

  async update(id: string, input: UpdateCredentialRequest): Promise<ConsoleCredential> {
    return this.run(async (tx) =>
      this.consoleViewOf(tx, await this.modify(tx, await this.ownById(tx, id), input)),
    )
  }

  async delete(id: string, expectedVersion?: number): Promise<void> {
    await this.run(async (tx) => this.remove(tx, await this.ownById(tx, id), expectedVersion))
  }

  // 撤销删除。同一个标识已经有一条有效的凭据时不能恢复：引用按标识解析，两条同名的有效凭据会分不清
  async undelete(id: string): Promise<ConsoleCredential> {
    return this.run(async (tx) => {
      this.requireManage()
      const before = await this.ownById(tx, id)
      if (!before.deletedAt) throw new MemoryError(409, '这条凭据没有被删除')
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
      if (!row) throw new MemoryError(409, '凭据刚被其他请求修改，请重新读取')
      await this.event(tx, id, 'undelete')
      return this.consoleViewOf(tx, { row })
    }, '同一个标识已经有一条有效的凭据，这一条不能恢复')
  }

  // 查看托管的值，记一条访问事件。和 secret 一样，目前要求是空间 owner
  async reveal(id: string): Promise<CredentialValues> {
    return this.run(async (tx) => {
      const row = await this.ownById(tx, id)
      if (!canRevealCredential(this.ctx.access, row)) {
        throw new MemoryError(403, '只有空间 owner 能查看托管的值')
      }
      if (row.deletedAt) throw new MemoryError(409, '这条凭据已被删除，先恢复再查看')
      if (row.source !== 'hosted') {
        throw new MemoryError(400, '这条凭据的值在外部凭据源里，Kioku 不保存')
      }
      const values = this.open(row)
      await this.event(tx, id, 'access', { via: 'console', fields: Object.keys(values).sort() })
      return { values }
    })
  }

  // 一条凭据的事件，最新的在前。Key 的名字和 Key 列表一样，只给应用主人与空间 owner 看
  async events(id: string, page: PageQuery): Promise<CredentialEventList> {
    this.requireRead()
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
      return {
        items: items.map((r) => ({
          id: r.event.id,
          type: r.event.eventType,
          createdAt: r.event.createdAt.toISOString(),
          actor: { accountName: r.accountName, keyName: r.keyName, appName: r.appName },
          via: typeof r.event.context.via === 'string' ? r.event.context.via : null,
          fields: list(r.event.context.fields),
          changes: list(r.event.context.changes),
        })),
        nextCursor:
          rows.length > page.limit && items.length ? String(items.at(-1)!.event.id) : null,
      }
    })
  }

  // ---- 凭据源（只在管理界面配置）----

  private liveProviders(tx: Tx): Promise<ProviderRow[]> {
    return tx
      .select()
      .from(credentialProviders)
      .where(
        and(
          eq(credentialProviders.ownerAccountId, this.owner),
          isNull(credentialProviders.deletedAt),
        ),
      )
      .orderBy(asc(credentialProviders.createdAt), asc(credentialProviders.id))
  }

  async providers(): Promise<CredentialProvider[]> {
    this.requireRead()
    return this.run(async (tx) => {
      const rows = await this.liveProviders(tx)
      if (!rows.length) return []
      const counts = await tx
        .select({ providerId: credentials.providerId, n: count() })
        .from(credentials)
        .where(
          and(
            inArray(
              credentials.providerId,
              rows.map((r) => r.id),
            ),
            isNull(credentials.deletedAt),
          ),
        )
        .groupBy(credentials.providerId)
      const bound = new Map(counts.map((c) => [c.providerId, c.n]))
      return rows.map((r) => providerView(r, bound.get(r.id) ?? 0))
    })
  }

  async createProvider(input: CreateCredentialProviderRequest): Promise<CredentialProvider> {
    this.requireManage()
    return this.run(async (tx) => {
      const [row] = await tx
        .insert(credentialProviders)
        .values({ spaceId: this.ctx.spaceId, ownerAccountId: this.owner, ...input })
        .returning()
      return providerView(row!, 0)
    })
  }

  async updateProvider(
    id: string,
    input: UpdateCredentialProviderRequest,
  ): Promise<CredentialProvider> {
    this.requireManage()
    return this.run(async (tx) => {
      const [row] = await tx
        .update(credentialProviders)
        .set({ ...input, updatedAt: new Date() })
        .where(
          and(
            eq(credentialProviders.id, id),
            eq(credentialProviders.ownerAccountId, this.owner),
            isNull(credentialProviders.deletedAt),
          ),
        )
        .returning()
      if (!row) throw new MemoryError(404, '凭据源不存在')
      return providerView(row, await this.boundCount(tx, id))
    })
  }

  // 软删除：已删除的凭据仍指向它，恢复之后显示「凭据源已删除」，要重新绑定。还有有效的凭据绑定它时不能删
  async deleteProvider(id: string): Promise<void> {
    this.requireManage()
    await this.run(async (tx) => {
      const [row] = await tx
        .select({ id: credentialProviders.id })
        .from(credentialProviders)
        .where(
          and(
            eq(credentialProviders.id, id),
            eq(credentialProviders.ownerAccountId, this.owner),
            isNull(credentialProviders.deletedAt),
          ),
        )
        // 和新建、修改凭据时的检查互斥：删除期间不会冒出新绑定到它的凭据
        .for('update')
      if (!row) throw new MemoryError(404, '凭据源不存在')
      const bound = await this.boundCount(tx, id)
      if (bound) {
        throw new MemoryError(409, `还有 ${bound} 条凭据绑定这个凭据源，先改绑或删除它们`)
      }
      await tx
        .update(credentialProviders)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(credentialProviders.id, id))
    })
  }

  private async boundCount(tx: Tx, providerId: string): Promise<number> {
    const [row] = await tx
      .select({ n: count() })
      .from(credentials)
      .where(and(eq(credentials.providerId, providerId), isNull(credentials.deletedAt)))
    return row?.n ?? 0
  }

  // ---- Key ----

  // 列出这把 Key 看得到的凭据与凭据源。不含外部条目的位置与字段对应：绑定只在取用时给，并记访问事件
  async keyList(): Promise<KeyCredentialList> {
    this.requireRead()
    return this.run(async (tx) => {
      const rows = (
        await tx
          .select()
          .from(credentials)
          .where(and(eq(credentials.ownerAccountId, this.owner), isNull(credentials.deletedAt)))
          .orderBy(asc(credentials.identifier))
      ).filter((r) => canReadCredential(this.ctx.access, r))
      const page = rows.slice(0, LIST_LIMIT)
      const providers = await this.providersOf(tx, page)
      const live = await this.liveProviders(tx)
      return {
        items: page.map((r) => this.summary(r, providers)),
        providers: live.map((p) => ({ id: p.id, kind: p.kind, name: p.name, deleted: false })),
        truncated: rows.length > LIST_LIMIT,
      }
    })
  }

  // 取用一条凭据，记一条访问事件：托管的给值（要 secret 级），外部的给凭据源、条目位置与取法
  async use(identifier: string, field: string | undefined, via: CredentialVia) {
    return this.run(async (tx): Promise<CredentialAccess> => {
      const row = await this.visibleByIdentifier(tx, identifier)
      const fields = field ? row.fields.filter((f) => f.name === field) : row.fields
      if (field && !fields.length) {
        throw new MemoryError(404, `凭据 ${identifier} 没有字段 ${field}`)
      }
      const names = fields.map((f) => f.name)
      const providers = await this.providersOf(tx, [row])
      const credential = this.info(row, providers)
      if (row.source === 'hosted') {
        if (!canRevealCredential(this.ctx.access, row)) {
          return {
            credential,
            values: null,
            provider: null,
            method:
              '值由 Kioku 托管，这把 Key 不是 secret 级，取不到；需要时请主人在管理界面查看，或换一把 secret 级的 Key。',
            notice: CREDENTIAL_NOTICE,
          }
        }
        const all = this.open(row)
        await this.event(tx, row.id, 'access', { via, fields: names })
        return {
          credential,
          values: Object.fromEntries(names.flatMap((n) => (n in all ? [[n, all[n]!]] : []))),
          provider: null,
          method: '值由 Kioku 托管，就在 values 里。',
          notice: CREDENTIAL_NOTICE,
        }
      }
      await this.event(tx, row.id, 'access', { via, fields: names })
      const provider = providers.get(row.providerId!)
      if (!provider || provider.deletedAt) {
        return {
          credential,
          values: null,
          provider: null,
          method: '这条凭据绑定的凭据源已被删除，取不到值；请主人在管理界面重新绑定。',
          notice: CREDENTIAL_NOTICE,
        }
      }
      return {
        credential,
        values: null,
        provider: { kind: provider.kind, name: provider.name, instructions: provider.instructions },
        method: externalMethod(provider.kind, row.location!, fields),
        notice: CREDENTIAL_NOTICE,
      }
    })
  }

  // 通过 Key 新建的只给这个应用用：被诱导的 agent 建的凭据不会被别的应用拿去用
  async keyCreate(input: Omit<CreateCredentialRequest, 'appIds'>): Promise<CredentialSummary> {
    return this.run(
      async (tx) => this.summaryOf(tx, await this.insert(tx, input, [this.ctx.access.appId!])),
      `标识已被占用或不可用：${input.identifier}`,
    )
  }

  async keyUpdate(
    identifier: string,
    input: Omit<UpdateCredentialRequest, 'appIds'>,
  ): Promise<CredentialSummary> {
    return this.run(async (tx) => {
      // 先确认有管理权限，再找凭据：没有权限时不论存不存在都是 403
      this.requireManage()
      const before = await this.visibleByIdentifier(tx, identifier)
      return this.summaryOf(tx, await this.modify(tx, before, input))
    })
  }

  async keyDelete(identifier: string, expectedVersion?: number): Promise<void> {
    await this.run(async (tx) => {
      this.requireManage()
      await this.remove(tx, await this.visibleByIdentifier(tx, identifier), expectedVersion)
    })
  }
}

function providerView(row: ProviderRow, credentialCount: number): CredentialProvider {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    instructions: row.instructions,
    credentialCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
