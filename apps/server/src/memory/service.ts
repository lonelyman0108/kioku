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
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'

import { canRead, canWrite, type Access } from '../access/access'
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
  // 当前应用使用的人格；persona 层只读得到它及其祖先
  personaId: string | null
  masterKey: Buffer | null
  actor: { keyId?: string; accountId?: string }
  // 写入提交后调用，用于安排向量更新
  onChanged?: (memoryId: string) => void
}

type MemoryRow = typeof memories.$inferSelect

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

  // URI 唯一约束冲突在这里转成 409，REST 与 MCP 都能拿到明确的提示。正常情况下 claimUri 已经用咨询锁
  // 串行化了检查与写入，这里兜住遗漏的写入路径
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

  // 按 URI 找当前调用方对应的那条：别的成员的 owner / private 记忆不在候选里；
  // 同一个 URI 既有共享节点又有自己的私人节点时，先取自己的
  private async findLive(tx: Tx, parsed: ParsedUri): Promise<MemoryRow | undefined> {
    const [row] = await tx
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.domain, parsed.domain),
          eq(memories.path, parsed.path),
          isNull(memories.deletedAt),
          or(
            isNull(memories.ownerAccountId),
            eq(memories.ownerAccountId, this.ctx.access.ownerAccountId),
          ),
        ),
      )
      .orderBy(sql`${memories.ownerAccountId} is null`)
      .limit(1)
    return row
  }

  // 一个 URI 要么是共享的，要么按成员各自占用，二者不共存：否则成员自己的私人节点会遮住同名的共享节点。
  // 所以写共享节点时与任何人的同名节点冲突，写成员节点时与共享节点和自己的同名节点冲突。
  // 检查与写入用事务级咨询锁串行化，并发写同一个 URI 时后到的拿到 409 而不是唯一约束报错。
  // 冲突的记录已失效或已过期时，不论属于谁都软删除并让出 URI（事件记在本次写入者名下，快照保留原内容），
  // 否则谁都看不见它却永远占着这个 URI。数据库触发器 memories_uri_exclusive 是同一规则的兜底
  private async claimUri(
    tx: Tx,
    parsed: ParsedUri,
    target: { ownerAccountId: string | null },
    released: string[],
  ): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${this.ctx.spaceId}|${parsed.domain}://${parsed.path}`}))`,
    )
    const rows = await tx
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.domain, parsed.domain),
          eq(memories.path, parsed.path),
          isNull(memories.deletedAt),
          target.ownerAccountId
            ? or(
                isNull(memories.ownerAccountId),
                eq(memories.ownerAccountId, target.ownerAccountId),
              )
            : undefined,
        ),
      )
    const now = new Date()
    for (const row of rows) {
      // 已失效或已过期的记录对任何人都不可见，软删除它不会暴露或丢失可见内容（事件里留有快照），
      // 所以不论归属与写权限都可以让出 URI；否则别人的过期记录会永远挡住这个 URI
      const expired = (row.validTo && row.validTo <= now) || (row.expiresAt && row.expiresAt <= now)
      // 能让出的过期记录：调用方有写权限的共享或自己的记录；以及别的成员的私人记录——它们对任何人都不可见，
      // 又只属于那个成员，不让出就会永远挡住共享 URI。共享记录调用方写不了的，照样算冲突
      const foreignPrivate =
        row.ownerAccountId !== null && row.ownerAccountId !== this.ctx.access.ownerAccountId
      const releasable = expired && (foreignPrivate || canWrite(this.ctx.access, row))
      if (!releasable) {
        // 不说明是谁的、内容是什么；URI 被占用这件事本身无法对写入方隐藏
        throw new MemoryError(409, `URI 已被占用：${formatUri(parsed.domain, parsed.path)}`)
      }
      const [gone] = await tx
        .update(memories)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(memories.id, row.id))
        .returning()
      const glossary = (await this.glossaryOf(tx, [row.id])).get(row.id) ?? []
      // 让出的是别的成员的私人记录时，事件记在本次写入者名下，快照里不放对方的正文
      const foreign =
        row.ownerAccountId !== null && row.ownerAccountId !== this.ctx.access.ownerAccountId
      const keep = (r: MemoryRow) =>
        foreign ? { ...snapshot(r, glossary), content: null } : snapshot(r, glossary)
      await this.event(tx, row.id, 'expire', keep(row), keep(gone!))
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
      if (!access.admin && row.id !== access.appId) {
        throw new MemoryError(403, '只能写本应用的应用层记忆')
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

  async create(input: CreateMemoryRequest): Promise<MemoryView> {
    const parsed = parse(input.uri)
    return this.write(async (tx, personaIds, released) => {
      const ownership = await this.resolveOwnership(tx, parsed, input.layer, personaIds)
      const sensitivity = input.sensitivity ?? DEFAULT_SENSITIVITY[ownership.layer]
      if (!canWrite(this.ctx.access, { layer: ownership.layer, sensitivity })) {
        throw new MemoryError(403, `没有权限写 ${ownership.layer} 层的 ${sensitivity} 级记忆`)
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
        })
        .returning()
      const glossary = [...new Set(input.glossary)].sort()
      if (glossary.length) {
        await tx
          .insert(memoryGlossary)
          .values(glossary.map((keyword) => ({ spaceId: this.ctx.spaceId, memoryId: id, keyword })))
      }
      await this.event(tx, id, 'create', null, snapshot(row!, glossary))
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
      if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
        throw new MemoryError(409, `版本已变化：当前是 ${before.version}，请先重新读取`)
      }
      const sensitivity = input.sensitivity ?? before.sensitivity
      for (const s of new Set([before.sensitivity, sensitivity])) {
        if (!canWrite(this.ctx.access, { layer: before.layer, sensitivity: s })) {
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
      if (!canWrite(this.ctx.access, { layer: before.layer, sensitivity: before.sensitivity })) {
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
      if (!canWrite(this.ctx.access, { layer: before.layer, sensitivity: before.sensitivity })) {
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
      const own = <T>(column: unknown) =>
        sql<T | null>`(array_agg(${column}) filter (where ${next} = ''))[1]`
      const levels = await tx
        .select({
          segment,
          below: sql<number>`count(distinct ${next}) filter (where ${next} <> '')`,
          id: own<string>(memories.id),
          layer: own<Layer>(memories.layer),
          sensitivity: own<Sensitivity>(memories.sensitivity),
          priority: own<number>(memories.priority),
          disclosure: own<string>(memories.disclosure),
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
        // 先按这一级自身记忆的 priority 排，虚拟节点在后，再截断；否则重要的节点可能被截掉
        .orderBy(sql`min(${memories.priority}) filter (where ${next} = '') nulls last`, sql`1`)
        .limit(CHILDREN_LEVEL_LIMIT)
      const children: MemorySummary[] = levels.map((level) => ({
        uri: formatUri(domain, `${prefix}${level.segment}`),
        exists: level.id !== null,
        id: level.id,
        layer: level.layer,
        sensitivity: level.sensitivity,
        priority: level.priority === null ? null : Number(level.priority),
        disclosure: level.disclosure,
        childCount: Number(level.below),
      }))
      // 有记忆的按 priority 在前，虚拟节点在后，同级按路径
      children.sort(
        (a, b) =>
          (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
          a.uri.localeCompare(b.uri),
      )
      const parentView = parent
        ? this.toView(parent, (await this.glossaryOf(tx, [parent.id])).get(parent.id) ?? [])
        : null
      // 指定了路径、它本身没有可读的记忆、下面也没有可读的内容：和不存在一样返回 404，
      // 拼错路径时不会看起来像一个空目录
      if (parsed && !parent && !children.length) {
        throw new MemoryError(404, `记忆不存在：${formatUri(parsed.domain, parsed.path)}`)
      }
      return { parent: parentView, children }
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
