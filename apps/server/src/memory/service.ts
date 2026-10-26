import { randomUUID } from 'node:crypto'

import type {
  CreateMemoryRequest,
  DomainSummary,
  Layer,
  MemoryChildren,
  MemorySummary,
  MemoryView,
  MoveMemoryRequest,
  Sensitivity,
  UpdateMemoryRequest,
} from '@kioku/contracts'
import { and, asc, count, desc, eq, gt, inArray, isNull, like, lte, or, sql } from 'drizzle-orm'

import { canRead, canWrite, canWriteApp, type Access } from '../access/access'
import type { Db, Tx } from '../db/client'
import { apps, memories, memoryEmbeddings, memoryEvents, memoryGlossary } from '../db/schema'
import { decryptSecret, encryptSecret } from '../crypto/envelope'
import { readableConditions } from './filter'
import { personaIdsBySlug, runInSpace } from './personas'
import {
  APP_DOMAIN,
  DEFAULT_SENSITIVITY,
  formatUri,
  layerForDomain,
  parseUri,
  PERSONA_DOMAIN,
  type ParsedUri,
} from './uri'

export class MemoryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message)
  }
}

export interface MemoryContext {
  db: Db
  spaceId: string
  access: Access
  // 当前应用使用的人格；persona 层只读得到它及其祖先。管理界面传 'all'，能看到全部人格
  personaId: string | null | 'all'
  masterKey: Buffer | null
  actor: { keyId?: string; accountId?: string }
  // 写入提交后调用，用于安排向量更新
  onChanged?: (memoryId: string) => void
}

type MemoryRow = typeof memories.$inferSelect

// 从别的系统导入时用：事件记成 import 并带上出处，时间沿用来源系统里的
export interface CreateMeta {
  eventType?: 'create' | 'import'
  eventContext?: Record<string, unknown>
  createdAt?: Date
  updatedAt?: Date
  // 写应用层时要求应用当前的主人是这个账号，在写入的同一个事务里锁住应用行核对：
  // 导入是一个长循环，期间应用被转给别人，也不能把记忆写进别人的应用
  requireAppOwner?: string
}

function parse(uri: string): ParsedUri {
  const parsed = parseUri(uri)
  if (!parsed) throw new MemoryError(400, `URI 格式不对：${uri}`)
  return parsed
}

// 事件快照里不放密文、数据密钥和全文检索向量（向量里有正文分词）。secret 的正文本来就是 null；
// 改成 secret 时，之前快照里的明文由 scrubHistory 统一抹掉（包括本次事件的「改前」快照）
function snapshot(row: MemoryRow, glossary: string[]) {
  const rest: Partial<MemoryRow> = { ...row }
  delete rest.ciphertext
  delete rest.wrappedKey
  delete rest.fts
  if (row.sensitivity === 'secret') rest.content = null
  return { ...rest, glossary }
}

// 浏览时一层最多列出的子节点数，按路径排序后截断，结果稳定
const CHILDREN_LEVEL_LIMIT = 500

export class MemoryService {
  constructor(private readonly ctx: MemoryContext) {}

  // URI 冲突由数据库判断（同一归属的唯一索引，以及共享与成员节点互斥的触发器，二者都按唯一约束报错），
  // 在这里转成 409，REST 与 MCP 都能拿到明确的提示
  private async run<T>(fn: (tx: Tx, personaIds: string[]) => Promise<T>): Promise<T> {
    try {
      return await runInSpace(this.ctx.db, this.ctx.spaceId, this.ctx.personaId, fn)
    } catch (err) {
      const pg = ((err as { cause?: unknown })?.cause ?? err) as {
        code?: string
        constraint_name?: string
      }
      if (pg.code === '23505' && pg.constraint_name === 'memories_uri_live_idx') {
        throw new MemoryError(409, 'URI 已被占用')
      }
      throw err
    }
  }

  private changed(ids: string[]): void {
    for (const id of ids) this.ctx.onChanged?.(id)
  }

  // 写操作：事务提交之后再通知，回滚的写入不会触发向量更新。released 收集本次顺带变更的其他记忆
  // （例如让出 URI 的过期记录），每次调用各用一份，同一个服务实例上的并发写入互不干扰
  private async write(
    fn: (tx: Tx, personaIds: string[], released: string[]) => Promise<MemoryView>,
  ): Promise<MemoryView> {
    const released: string[] = []
    const view = await this.run((tx, personaIds) => fn(tx, personaIds, released))
    this.changed([view.id, ...released])
    return view
  }

  // 按 URI 找当前调用方对应的、仍然有效的那条：别的成员的 owner / private 记忆不在候选里，
  // 已失效或已过期的也不算。数据库保证这样的记录在一个 URI 上至多一条（共享与成员节点互斥），所以不用排序
  private async findLive(tx: Tx, parsed: ParsedUri): Promise<MemoryRow | undefined> {
    const now = new Date()
    const [row] = await tx
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.domain, parsed.domain),
          eq(memories.path, parsed.path),
          isNull(memories.deletedAt),
          or(isNull(memories.validTo), gt(memories.validTo, now)),
          or(isNull(memories.expiresAt), gt(memories.expiresAt, now)),
          or(
            isNull(memories.ownerAccountId),
            eq(memories.ownerAccountId, this.ctx.access.ownerAccountId),
          ),
        ),
      )
      .limit(1)
    return row
  }

  // 一个 URI 要么是共享的，要么按成员各自占用，二者不共存：否则成员自己的私人节点会遮住同名的共享节点。
  // 冲突检查交给数据库：同一归属下的唯一索引 memories_uri_live_idx，以及共享与成员节点互斥的触发器
  // memories_uri_exclusive（它对同一个 URI 加咨询锁串行检查，不看已失效或过期的记录），冲突时 run() 转成 409。
  // 这里只做数据库做不了的一步：目标 URI 上已失效或过期、调用方又能让出的记录，软删除并让出 URI，
  // 否则同一归属下谁都看不见它，却会一直撞上唯一索引
  private async claimUri(
    tx: Tx,
    parsed: ParsedUri,
    target: { ownerAccountId: string | null },
    released: string[],
  ): Promise<void> {
    const now = new Date()
    const rows = await tx
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.domain, parsed.domain),
          eq(memories.path, parsed.path),
          isNull(memories.deletedAt),
          or(lte(memories.validTo, now), lte(memories.expiresAt, now)),
          target.ownerAccountId
            ? or(
                isNull(memories.ownerAccountId),
                eq(memories.ownerAccountId, target.ownerAccountId),
              )
            : undefined,
        ),
      )
    for (const row of rows) {
      // 能让出的：调用方有写权限的共享或自己的记录；以及别的成员的私人记录——它对任何人都不可见，
      // 又只属于那个成员，不让出就会永远挡住共享 URI。调用方写不了的共享记录留着：
      // 同一归属的写入会撞上唯一索引得到 409，成员节点则可以和它并存（它已不可见）
      const foreignPrivate =
        row.ownerAccountId !== null && row.ownerAccountId !== this.ctx.access.ownerAccountId
      if (!foreignPrivate && !canWrite(this.ctx.access, row)) continue
      const [gone] = await tx
        .update(memories)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(memories.id, row.id), isNull(memories.deletedAt)))
        .returning()
      // 并发的另一次写入已经让出了它
      if (!gone) continue
      const glossary = (await this.glossaryOf(tx, [row.id])).get(row.id) ?? []
      // 让出的是别的成员的私人记录时，事件记在本次写入者名下，快照里不放对方的正文
      const keep = (r: MemoryRow) =>
        foreignPrivate ? { ...snapshot(r, glossary), content: null } : snapshot(r, glossary)
      await this.event(tx, row.id, 'expire', keep(row), keep(gone))
      released.push(row.id)
    }
  }

  private async findReadableOrNull(
    tx: Tx,
    parsed: ParsedUri,
    personaIds: string[],
  ): Promise<MemoryRow | null> {
    const row = await this.findLive(tx, parsed)
    return row && canRead(this.ctx.access, row, { personaIds, explicit: true }) ? row : null
  }

  // 读不到和不存在对调用方一样：都是 404，不泄露「这里有一条你看不见的记忆」
  private async findReadable(tx: Tx, parsed: ParsedUri, personaIds: string[]): Promise<MemoryRow> {
    const row = await this.findReadableOrNull(tx, parsed, personaIds)
    if (!row) throw new MemoryError(404, `记忆不存在：${formatUri(parsed.domain, parsed.path)}`)
    return row
  }

  private async glossaryOf(tx: Tx, ids: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>()
    if (!ids.length) return map
    const rows = await tx
      .select()
      .from(memoryGlossary)
      .where(inArray(memoryGlossary.memoryId, ids))
      .orderBy(asc(memoryGlossary.keyword))
    for (const r of rows) map.set(r.memoryId, [...(map.get(r.memoryId) ?? []), r.keyword])
    return map
  }

  private contentOf(row: MemoryRow): string | null {
    if (row.sensitivity !== 'secret') return row.content
    if (!this.ctx.access.canReadSecret || !row.ciphertext || !row.wrappedKey) return null
    if (!this.ctx.masterKey) throw new MemoryError(400, '服务端没有配置 KIOKU_MASTER_KEY，无法解密')
    return decryptSecret(
      this.ctx.masterKey,
      { ciphertext: row.ciphertext, wrappedKey: row.wrappedKey },
      row.id,
    )
  }

  private toView(row: MemoryRow, glossary: string[]): MemoryView {
    return {
      id: row.id,
      uri: formatUri(row.domain!, row.path!),
      layer: row.layer,
      sensitivity: row.sensitivity,
      provenance: row.provenance,
      originScope: row.originScope,
      content: this.contentOf(row),
      priority: row.priority,
      disclosure: row.disclosure,
      glossary,
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo?.toISOString() ?? null,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  private async event(
    tx: Tx,
    memoryId: string,
    eventType: string,
    before: unknown,
    after: unknown,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.insert(memoryEvents).values({
      spaceId: this.ctx.spaceId,
      memoryId,
      eventType,
      actorKeyId: this.ctx.actor.keyId ?? null,
      actorAccountId: this.ctx.actor.accountId ?? null,
      provenance: this.ctx.access.writeProvenance,
      before: before ?? null,
      after: after ?? null,
      context,
    })
  }

  // 解析写入目标的层和归属；人格层只能写当前人格链上的人格，应用层只能写本应用，admin 例外
  private async resolveOwnership(
    tx: Tx,
    parsed: ParsedUri,
    requested: Layer | undefined,
    personaIds: string[],
  ): Promise<Pick<MemoryRow, 'layer' | 'ownerAccountId' | 'personaId' | 'appId'>> {
    const access = this.ctx.access
    const forced = layerForDomain(parsed.domain)
    if (forced && requested && requested !== forced) {
      throw new MemoryError(400, `${parsed.domain}:// 下的记忆只能属于 ${forced} 层`)
    }
    if (!forced && (requested === 'persona' || requested === 'app')) {
      throw new MemoryError(400, `${requested} 层的记忆要放在 ${requested}://<标识>/ 下`)
    }
    const layer = forced ?? requested ?? 'private'
    if (layer === 'subject' || layer === 'episode') {
      throw new MemoryError(400, `${layer} 层由对话抽取写入，不能直接按 URI 创建`)
    }

    const ownership = { layer, ownerAccountId: null, personaId: null, appId: null } as Pick<
      MemoryRow,
      'layer' | 'ownerAccountId' | 'personaId' | 'appId'
    >
    if (layer === 'owner' || layer === 'private') ownership.ownerAccountId = access.ownerAccountId
    if (layer === 'persona') {
      const id = (await personaIdsBySlug(tx, [parsed.namespaceSlug!])).get(parsed.namespaceSlug!)
      if (!id) throw new MemoryError(404, `人格不存在：${parsed.namespaceSlug}`)
      if (!access.admin && !personaIds.includes(id)) {
        throw new MemoryError(403, '只能写当前应用所用人格及其祖先的记忆')
      }
      ownership.personaId = id
    }
    if (layer === 'app') {
      const [row] = await tx
        .select({ id: apps.id })
        .from(apps)
        .where(eq(apps.slug, parsed.namespaceSlug!))
        .limit(1)
      if (!row) throw new MemoryError(404, `应用不存在：${parsed.namespaceSlug}`)
      if (!canWriteApp(access, row.id)) {
        throw new MemoryError(403, '没有权限写这个应用的应用层记忆')
      }
      ownership.appId = row.id
    }
    return ownership
  }

  async get(uri: string): Promise<MemoryView> {
    const parsed = parse(uri)
    return this.run(async (tx, personaIds) => {
      const row = await this.findReadable(tx, parsed, personaIds)
      return this.toView(row, (await this.glossaryOf(tx, [row.id])).get(row.id) ?? [])
    })
  }

  async create(input: CreateMemoryRequest, meta: CreateMeta = {}): Promise<MemoryView> {
    const parsed = parse(input.uri)
    return this.write(async (tx, personaIds, released) => {
      const ownership = await this.resolveOwnership(tx, parsed, input.layer, personaIds)
      const sensitivity = input.sensitivity ?? DEFAULT_SENSITIVITY[ownership.layer]
      if (!canWrite(this.ctx.access, { ...ownership, sensitivity })) {
        throw new MemoryError(403, `没有权限写 ${ownership.layer} 层的 ${sensitivity} 级记忆`)
      }
      if (meta.requireAppOwner && ownership.appId) {
        const [app] = await tx
          .select({ owner: apps.ownerAccountId })
          .from(apps)
          .where(eq(apps.id, ownership.appId))
          .for('share')
        if (app?.owner !== meta.requireAppOwner) {
          throw new MemoryError(403, '这个应用已经不属于导入者')
        }
      }
      await this.claimUri(tx, parsed, ownership, released)

      const id = randomUUID()
      const body =
        sensitivity === 'secret'
          ? { content: null, ...this.seal(input.content, id) }
          : { content: input.content, ciphertext: null, wrappedKey: null }
      const [row] = await tx
        .insert(memories)
        .values({
          id,
          spaceId: this.ctx.spaceId,
          form: 'curated',
          ...ownership,
          sensitivity,
          provenance: this.ctx.access.writeProvenance,
          originScope: this.ctx.access.writeOriginScope,
          domain: parsed.domain,
          path: parsed.path,
          ...body,
          priority: input.priority,
          disclosure: input.disclosure ?? null,
          ...(meta.createdAt ? { createdAt: meta.createdAt, validFrom: meta.createdAt } : {}),
          ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
        })
        .returning()
      const glossary = [...new Set(input.glossary)].sort()
      if (glossary.length) {
        await tx
          .insert(memoryGlossary)
          .values(glossary.map((keyword) => ({ spaceId: this.ctx.spaceId, memoryId: id, keyword })))
      }
      await this.event(
        tx,
        id,
        meta.eventType ?? 'create',
        null,
        snapshot(row!, glossary),
        meta.eventContext,
      )
      return this.toView(row!, glossary)
    })
  }

  private seal(plaintext: string, id: string) {
    if (!this.ctx.masterKey)
      throw new MemoryError(400, '服务端没有配置 KIOKU_MASTER_KEY，不能保存 secret')
    return encryptSecret(this.ctx.masterKey, plaintext, id)
  }

  async update(input: UpdateMemoryRequest): Promise<MemoryView> {
    const parsed = parse(input.uri)
    return this.write(async (tx, personaIds) => {
      const before = await this.findReadable(tx, parsed, personaIds)
      if (input.expectedId !== undefined && input.expectedId !== before.id) {
        throw new MemoryError(409, '这条记忆已被删除并重新创建，请先重新读取')
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
        throw new MemoryError(409, `版本已变化：当前是 ${before.version}，请先重新读取`)
      }
      const sensitivity = input.sensitivity ?? before.sensitivity
      for (const s of new Set([before.sensitivity, sensitivity])) {
        if (!canWrite(this.ctx.access, { ...before, sensitivity: s })) {
          throw new MemoryError(403, `没有权限改 ${before.layer} 层的 ${s} 级记忆`)
        }
      }

      // 敏感级跨过 secret 边界时，正文在明文与密文之间转换
      const plaintext = input.content ?? this.contentOf(before)
      if (plaintext === null) throw new MemoryError(403, '没有权限读取这条 secret 的正文')
      const body =
        sensitivity === 'secret'
          ? { content: null, ...this.seal(plaintext, before.id) }
          : { content: plaintext, ciphertext: null, wrappedKey: null }

      const beforeGlossary = (await this.glossaryOf(tx, [before.id])).get(before.id) ?? []
      const [row] = await tx
        .update(memories)
        .set({
          ...body,
          sensitivity,
          priority: input.priority ?? before.priority,
          disclosure: input.disclosure === undefined ? before.disclosure : input.disclosure,
          version: sql`${memories.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(memories.id, before.id), eq(memories.version, before.version)))
        .returning()
      if (!row) throw new MemoryError(409, '记忆刚被其他请求修改，请重新读取')

      if (input.glossaryRemove?.length) {
        await tx
          .delete(memoryGlossary)
          .where(
            and(
              eq(memoryGlossary.memoryId, before.id),
              inArray(memoryGlossary.keyword, input.glossaryRemove),
            ),
          )
      }
      if (input.glossaryAdd?.length) {
        await tx
          .insert(memoryGlossary)
          .values(
            [...new Set(input.glossaryAdd)].map((keyword) => ({
              spaceId: this.ctx.spaceId,
              memoryId: before.id,
              keyword,
            })),
          )
          .onConflictDoNothing()
      }
      const glossary = (await this.glossaryOf(tx, [before.id])).get(before.id) ?? []
      const becameSecret = sensitivity === 'secret' && before.sensitivity !== 'secret'
      await this.event(
        tx,
        before.id,
        'update',
        snapshot(before, beforeGlossary),
        snapshot(row, glossary),
      )
      // 改成 secret 之后，历史事件里不能再留着明文
      if (becameSecret) {
        await this.scrubHistory(tx, before.id)
        // 向量由明文生成，不能等后台任务异步清理，在同一个事务里删掉
        await tx.delete(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, before.id))
      }
      return this.toView(row, glossary)
    })
  }

  private async scrubHistory(tx: Tx, memoryId: string): Promise<void> {
    await tx
      .update(memoryEvents)
      .set({
        before: sql`case when ${memoryEvents.before} is null then null else ${memoryEvents.before} - 'content' - 'fts' end`,
        after: sql`case when ${memoryEvents.after} is null then null else ${memoryEvents.after} - 'content' - 'fts' end`,
      })
      .where(eq(memoryEvents.memoryId, memoryId))
  }

  async delete(uri: string): Promise<void> {
    const parsed = parse(uri)
    const id = await this.run(async (tx, personaIds) => {
      const before = await this.findReadable(tx, parsed, personaIds)
      if (!canWrite(this.ctx.access, before)) {
        throw new MemoryError(403, `没有权限删除 ${before.layer} 层的记忆`)
      }
      const [row] = await tx
        .update(memories)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(memories.id, before.id))
        .returning()
      const glossary = (await this.glossaryOf(tx, [before.id])).get(before.id) ?? []
      await this.event(
        tx,
        before.id,
        'delete',
        snapshot(before, glossary),
        snapshot(row!, glossary),
      )
      return before.id
    })
    this.changed([id])
  }

  // 改 URI 不能改变归属：人格层、应用层只能在同一个人格或应用的命名空间里移动
  async move(input: MoveMemoryRequest): Promise<MemoryView> {
    const from = parse(input.from)
    const to = parse(input.to)
    return this.write(async (tx, personaIds, released) => {
      const before = await this.findReadable(tx, from, personaIds)
      if (!canWrite(this.ctx.access, before)) {
        throw new MemoryError(403, `没有权限移动 ${before.layer} 层的记忆`)
      }
      const sameNamespace = from.domain === to.domain && from.namespaceSlug === to.namespaceSlug
      const namespaced = layerForDomain(from.domain) || layerForDomain(to.domain)
      if (namespaced && !sameNamespace) {
        throw new MemoryError(
          400,
          `${PERSONA_DOMAIN}:// 与 ${APP_DOMAIN}:// 下的记忆只能在同一个标识下移动`,
        )
      }
      await this.claimUri(tx, to, before, released)
      const [row] = await tx
        .update(memories)
        .set({
          domain: to.domain,
          path: to.path,
          version: sql`${memories.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(memories.id, before.id))
        .returning()
      const glossary = (await this.glossaryOf(tx, [before.id])).get(before.id) ?? []
      await this.event(tx, before.id, 'move', snapshot(before, glossary), snapshot(row!, glossary))
      return this.toView(row!, glossary)
    })
  }

  // 列出直接子节点；target 是 domain 名时列 domain 根下的第一层。
  // 子节点由调用方读得到的后代推出：某一级路径本身没有记忆时显示为虚拟节点，所以不要求父节点存在，
  // 删除或移走父节点也不会让子节点变得走不到；读不到的记忆既不出现，也不会产生虚拟节点
  async children(target: string): Promise<MemoryChildren> {
    const parsed = target.includes('://') ? parse(target) : null
    const domain = parsed?.domain ?? target
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(domain))
      throw new MemoryError(400, `domain 格式不对：${domain}`)
    return this.run(async (tx, personaIds) => {
      const parent = parsed ? await this.findReadableOrNull(tx, parsed, personaIds) : null
      const prefix = parsed ? `${parsed.path}/` : ''
      // 在 SQL 里按下一级路径聚合：每一级一行，带上这一级本身的记忆（如果有）和它下面可见的下一级数量
      // 前缀长度直接写进 SQL（整数，由我们自己算出），这样各处的 split_part 是同一个表达式，才能按它分组
      const rest = sql`substr(${memories.path}, ${sql.raw(String(prefix.length + 1))})`
      const segment = sql<string>`split_part(${rest}, '/', 1)`
      const next = sql`split_part(${rest}, '/', 2)`
      // 这一级本身的记忆：各字段打包成一个对象聚合，取同一行，按 id 排序保证结果确定
      const own = sql<{
        id: string
        layer: Layer
        sensitivity: Sensitivity
        priority: number
        disclosure: string | null
      } | null>`(array_agg(jsonb_build_object(
          'id', ${memories.id}, 'layer', ${memories.layer}, 'sensitivity', ${memories.sensitivity},
          'priority', ${memories.priority}, 'disclosure', ${memories.disclosure}
        ) order by ${memories.id}) filter (where ${next} = ''))[1]`
      const rows = await tx
        .select({
          segment,
          below: sql<number>`count(distinct ${next}) filter (where ${next} <> '')`,
          own,
        })
        .from(memories)
        .where(
          and(
            readableConditions(this.ctx.access, { personaIds }),
            eq(memories.form, 'curated'),
            eq(memories.domain, domain),
            prefix ? like(memories.path, `${escapeLike(prefix)}%`) : undefined,
          ),
        )
        .groupBy(sql`1`)
        // 有记忆的按 priority 在前，虚拟节点在后，同级按路径；排序之后再截断，否则重要的节点可能被截掉。
        // 多取一行，用来判断是否被截断
        .orderBy(sql`min(${memories.priority}) filter (where ${next} = '') nulls last`, sql`1`)
        .limit(CHILDREN_LEVEL_LIMIT + 1)
      const truncated = rows.length > CHILDREN_LEVEL_LIMIT
      const children: MemorySummary[] = rows.slice(0, CHILDREN_LEVEL_LIMIT).map((level) => ({
        uri: formatUri(domain, `${prefix}${level.segment}`),
        exists: level.own !== null,
        id: level.own?.id ?? null,
        layer: level.own?.layer ?? null,
        sensitivity: level.own?.sensitivity ?? null,
        priority: level.own?.priority ?? null,
        disclosure: level.own?.disclosure ?? null,
        childCount: Number(level.below),
      }))
      const parentView = parent
        ? this.toView(parent, (await this.glossaryOf(tx, [parent.id])).get(parent.id) ?? [])
        : null
      // 指定了路径、它本身没有可读的记忆、下面也没有可读的内容：和不存在一样返回 404，
      // 拼错路径时不会看起来像一个空目录
      if (parsed && !parent && !children.length) {
        throw new MemoryError(404, `记忆不存在：${formatUri(parsed.domain, parsed.path)}`)
      }
      return { parent: parentView, children, truncated }
    })
  }

  async domains(): Promise<DomainSummary[]> {
    return this.run(async (tx, personaIds) => {
      const rows = await tx
        .select({ domain: memories.domain, count: count() })
        .from(memories)
        .where(
          and(readableConditions(this.ctx.access, { personaIds }), eq(memories.form, 'curated')),
        )
        .groupBy(memories.domain)
        .orderBy(desc(count()), asc(memories.domain))
      return rows.map((r) => ({ domain: r.domain!, count: r.count }))
    })
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}
