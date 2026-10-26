import { randomUUID } from 'node:crypto'

import type {
  CreateMemoryRequest,
  DomainSummary,
  Layer,
  MemoryChildren,
  MemorySummary,
  MemoryView,
  MoveMemoryRequest,
  UpdateMemoryRequest,
} from '@kioku/contracts'
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'

import { canRead, canWrite, type Access } from '../access/access'
import type { Db, Tx } from '../db/client'
import { apps, memories, memoryEvents, memoryGlossary } from '../db/schema'
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

// 事件快照里不放密文、数据密钥和全文检索向量（向量里有正文分词）。
// secret 的正文本来就是 null；redact 用于改成 secret 时把改之前的明文也抹掉
function snapshot(row: MemoryRow, glossary: string[], redact = false) {
  const rest: Partial<MemoryRow> = { ...row }
  delete rest.ciphertext
  delete rest.wrappedKey
  delete rest.fts
  if (redact || row.sensitivity === 'secret') rest.content = null
  return { ...rest, glossary }
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

export class MemoryService {
  constructor(private readonly ctx: MemoryContext) {}

  private run<T>(fn: (tx: Tx, personaIds: string[]) => Promise<T>): Promise<T> {
    return runInSpace(this.ctx.db, this.ctx.spaceId, this.ctx.personaId, fn)
  }

  private changed(memoryId: string): void {
    this.ctx.onChanged?.(memoryId)
  }

  // 写操作：事务提交之后再通知，回滚的写入不会触发向量更新
  private async write(
    fn: (tx: Tx, personaIds: string[]) => Promise<MemoryView>,
  ): Promise<MemoryView> {
    const view = await this.run(fn)
    this.changed(view.id)
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

  // 唯一键冲突检查：与 memories_uri_live_idx 一致，按 (URI, 归属成员) 判断。
  // 已失效或已过期的旧记录让出 URI（软删除并记事件），否则谁都看不见它却永远占着这个 URI
  private async claimUri(tx: Tx, parsed: ParsedUri, ownerAccountId: string | null): Promise<void> {
    const [row] = await tx
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.domain, parsed.domain),
          eq(memories.path, parsed.path),
          isNull(memories.deletedAt),
          sql`coalesce(${memories.ownerAccountId}, ${NIL_UUID}::uuid) = coalesce(${ownerAccountId}::uuid, ${NIL_UUID}::uuid)`,
        ),
      )
      .limit(1)
    if (!row) return
    const now = new Date()
    if ((row.validTo && row.validTo <= now) || (row.expiresAt && row.expiresAt <= now)) {
      const [expired] = await tx
        .update(memories)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(memories.id, row.id))
        .returning()
      await this.event(tx, row.id, 'expire', snapshot(row, []), snapshot(expired!, []))
      return
    }
    // 不说明是谁的、内容是什么；共享层的 URI 被占用这件事本身无法对调用方隐藏
    throw new MemoryError(409, `URI 已被占用：${formatUri(parsed.domain, parsed.path)}`)
  }

  // 新节点的父节点必须是一条真实存在、调用方可见的记忆（persona:// 与 app:// 的标识根除外），
  // 否则树浏览走不到它。父节点要先有内容，说明下面这些子节点为什么放在一起
  private async requireParent(tx: Tx, parsed: ParsedUri, personaIds: string[]): Promise<void> {
    const segments = parsed.path.split('/')
    if (segments.length === 1) return
    if (parsed.namespaceSlug && segments.length === 2) return
    const parent = { ...parsed, path: segments.slice(0, -1).join('/') }
    const row = await this.findLive(tx, parent)
    if (!row || !canRead(this.ctx.access, row, { personaIds, explicit: true })) {
      throw new MemoryError(
        400,
        `父节点 ${formatUri(parent.domain, parent.path)} 不存在，请先创建它，或换一个 URI`,
      )
    }
  }

  // 读不到和不存在对调用方一样：都是 404，不泄露「这里有一条你看不见的记忆」
  private async findReadable(tx: Tx, parsed: ParsedUri, personaIds: string[]): Promise<MemoryRow> {
    const row = await this.findLive(tx, parsed)
    if (!row || !canRead(this.ctx.access, row, { personaIds, explicit: true })) {
      throw new MemoryError(404, `记忆不存在：${formatUri(parsed.domain, parsed.path)}`)
    }
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
    return this.write(async (tx, personaIds) => {
      const ownership = await this.resolveOwnership(tx, parsed, input.layer, personaIds)
      const sensitivity = input.sensitivity ?? DEFAULT_SENSITIVITY[ownership.layer]
      if (!canWrite(this.ctx.access, { layer: ownership.layer, sensitivity })) {
        throw new MemoryError(403, `没有权限写 ${ownership.layer} 层的 ${sensitivity} 级记忆`)
      }
      await this.requireParent(tx, parsed, personaIds)
      await this.claimUri(tx, parsed, ownership.ownerAccountId)

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
        snapshot(before, beforeGlossary, becameSecret),
        snapshot(row, glossary),
      )
      // 改成 secret 之后，历史事件里不能再留着明文
      if (becameSecret) await this.scrubHistory(tx, before.id)
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
    this.changed(id)
  }

  // 改 URI 不能改变归属：人格层、应用层只能在同一个人格或应用的命名空间里移动
  async move(input: MoveMemoryRequest): Promise<MemoryView> {
    const from = parse(input.from)
    const to = parse(input.to)
    return this.write(async (tx, personaIds) => {
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
      await this.requireParent(tx, to, personaIds)
      await this.claimUri(tx, to, before.ownerAccountId)
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

  // 列出直接子节点；target 是 domain 名时列 domain 根下的第一层
  async children(target: string): Promise<MemoryChildren> {
    const parsed = target.includes('://') ? parse(target) : null
    const domain = parsed?.domain ?? target
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(domain))
      throw new MemoryError(400, `domain 格式不对：${domain}`)
    return this.run(async (tx, personaIds) => {
      const readable = readableConditions(this.ctx.access, { personaIds })
      // persona://<标识> 与 app://<标识> 是命名空间根，本身可以没有记忆
      const namespaceRoot = Boolean(parsed?.namespaceSlug && !parsed.path.includes('/'))
      const parent = !parsed
        ? null
        : namespaceRoot
          ? await this.findLive(tx, parsed).then((row) =>
              row && canRead(this.ctx.access, row, { personaIds, explicit: true }) ? row : null,
            )
          : await this.findReadable(tx, parsed, personaIds)
      const prefix = parsed ? `${parsed.path}/` : ''
      const childPattern = parsed ? `^${escapeRegex(parsed.path)}/[^/]+$` : '^[^/]+$'
      const rows = await tx
        .select()
        .from(memories)
        .where(and(readable, eq(memories.domain, domain), sql`${memories.path} ~ ${childPattern}`))
        .orderBy(asc(memories.priority), asc(memories.path))
      const counts = await tx
        .select({ path: memories.path, n: count() })
        .from(memories)
        .where(
          and(
            readable,
            eq(memories.domain, domain),
            like(memories.path, `${escapeLike(prefix)}%/%`),
          ),
        )
        .groupBy(memories.path)
      const childCount = (path: string) =>
        counts.filter(
          (c) => c.path!.startsWith(`${path}/`) && !c.path!.slice(path.length + 1).includes('/'),
        ).length
      const summaries: MemorySummary[] = rows.map((r) => ({
        id: r.id,
        uri: formatUri(r.domain!, r.path!),
        layer: r.layer,
        sensitivity: r.sensitivity,
        priority: r.priority,
        disclosure: r.disclosure,
        childCount: childCount(r.path!),
      }))
      const parentView = parent
        ? this.toView(parent, (await this.glossaryOf(tx, [parent.id])).get(parent.id) ?? [])
        : null
      return { parent: parentView, children: summaries }
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}
