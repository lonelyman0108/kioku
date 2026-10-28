import { randomUUID } from 'node:crypto'

import { PLAIN_LAYERS, PLAINTEXT_CREDENTIAL, SENSITIVITIES } from '@kioku/contracts'
import type {
  ActivityItem,
  ActivityList,
  CreateMemoryRequest,
  DeletedMemoryList,
  DomainSummary,
  EventActor,
  GlossaryIndex,
  LayerCount,
  Layer,
  MemoryChildren,
  MemoryHistory,
  MemoryList,
  MemoryListQuery,
  MemoryListSort,
  MemoryMatch,
  MemoryRecallStat,
  MemorySnapshot,
  MemorySummary,
  MemoryView,
  MoveMemoryRequest,
  NeverRecalledMemory,
  PageQuery,
  RecalledMemory,
  RecallEventList,
  RecallEventQuery,
  RecallSource,
  RecallVia,
  RestoreRequest,
  Sensitivity,
  UndeleteRequest,
  UpdateMemoryRequest,
} from '@kioku/contracts'
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm'

import {
  canRead,
  canReadCredential,
  canWrite,
  canWriteApp,
  canWritePersona,
  sensitivityRank,
  type Access,
  type WriteIntent,
} from '../access/access'
import {
  looksLikePlaintextCredential,
  mentionsPlaceholder,
  placeholderAllowed,
  placeholderIdentifiers,
  scanPlaceholders,
} from '../credential/placeholders'
import { isUniqueViolation, type Db, type Tx } from '../db/client'
import {
  decodeTimeCursor,
  encodeTimeCursor,
  escapeLike,
  fromMicros,
  INVALID_CURSOR,
  MICROS,
  microsOf,
  UUID,
} from '../db/paging'
import {
  accounts,
  apiKeys,
  apps,
  credentials,
  memories,
  memoryCredentialRefs,
  memoryEmbeddings,
  memoryEvents,
  memoryGlossary,
  memoryRecallStats,
  recallEventHits,
  recallEvents,
} from '../db/schema'
import { decryptSecret, encryptSecret } from '../crypto/envelope'
import { BOOT_ELIGIBLE, readableConditions, snapshotColumns, type MemoryColumns } from './filter'
import { personaIdsBySlug, runInSpace } from './personas'
import {
  DEFAULT_SENSITIVITY,
  formatUri,
  layerForDomain,
  parseUri,
  toParsed,
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
  // 能不能新增凭据引用；不给时按写入来源判断（见 addsCredentialRefs）。导入工具显式打开
  allowCredentialRefs?: boolean
  // 树、列表与快速匹配里是否列出 secret 记忆（只有元数据，正文仍要按 URI 显式读）。
  // 只给管理界面里能显式读 secret 的成员；接入方的 Key 不列：secret 只能按 URI 显式读取
  listSecret?: boolean
}

// 概览要的统计：成员读得到的策展记忆按层与敏感级计数，以及向量覆盖率
export interface MemoryStats {
  counts: LayerCount[]
  total: number
  missingDisclosure: number
  plaintextCredentials: number
  neverRecalled: number
  eligible: number
  embedded: number
}

type MemoryRow = typeof memories.$inferSelect

// 修改时可以改的字段（URI 与 expectedId 由调用方先核对）
type UpdateFields = Omit<UpdateMemoryRequest, 'uri' | 'expectedId'>

// 一条记忆属于谁：层，以及按层填的主人、人格或应用
type Ownership = Pick<MemoryRow, 'layer' | 'ownerAccountId' | 'personaId' | 'appId'>

// 个人的层：按成员各存一份，只有本人读得到；其余的层是共享的
const PER_MEMBER_LAYERS: readonly Layer[] = ['owner', 'private']
const perMember = (layer: Layer) => PER_MEMBER_LAYERS.includes(layer)

// 在共享的层与个人的层之间转换会改变谁看得到它（共享的记忆从别人那里消失，或个人的内容给了别人），
// 所以只能由人在管理界面里做，通过 Key 改层或移动都不行
const KEY_CROSS_OWNERSHIP = '通过 Key 不能把记忆在共享的层与个人的层之间转换，请在管理界面里改'

// Key 只能写应用当前的人格：继承来的祖先人格也被别的应用用着，群聊版的应用不能改掉主人格的设定
const PERSONA_WRITE =
  '通过 Key 只能写当前应用所用人格的记忆，别的人格（包括继承来的）请在管理界面里改'

// 含凭据占位符的记忆只能在私人层、敏感级至少 private：读得到占位符的人，正好就是读得到凭据说明的人
const PLACEHOLDER_SCOPE =
  '含凭据占位符的记忆只能在私人层、敏感级至少 private；改层、降级或移出私人层之前，先去掉正文里的 {{cred:…}} 引用'
const PLAINTEXT_DOWNGRADE =
  '正文像有明文密码或 Token，从 secret 降级之后会进历史、全文检索和向量，再也收不回来；先把值换成凭据占位符再降级'

// 这次写入之前的状态：在谁的哪一层、正文是什么（secret 的要解密，用到时才读）
interface RefBaseline {
  layer: Layer
  ownerAccountId: string | null
  content: () => string | null
}

// 占位符只能写在正文里：disclosure 与关键词会进召回与 boot 的线索，任何层的读者都看得到，
// 写在那里就绕过了「只能在私人层」的规则。只查这次写进去的：规则之前已经写着的不挡移动与撤销删除，
// 否则那样的记忆删了就撤销不了
function checkOutsideContent(
  disclosure: string | null | undefined,
  glossary: readonly string[],
): void {
  if ([disclosure ?? '', ...glossary].some(mentionsPlaceholder)) {
    throw new MemoryError(400, 'disclosure 与关键词里不能有凭据占位符，占位符只能写在正文里')
  }
}

// 在写入的同一个事务里锁住应用行，核对应用现在的主人（见 CreateMeta.requireAppOwner）
async function assertAppOwner(tx: Tx, appId: string, owner: string): Promise<void> {
  const [app] = await tx
    .select({ owner: apps.ownerAccountId })
    .from(apps)
    .where(eq(apps.id, appId))
    .for('share')
  if (app?.owner !== owner) throw new MemoryError(403, '这个应用已经不属于导入者')
}

// 抽取写下的记忆：对象层的事实挂在对象上，可以推翻同一个对象的一条旧事实；情节层的会话摘要带到期时间
export type ExtractedWrite =
  | { layer: 'subject'; subjectId: string; content: string; replaces?: string | undefined }
  | { layer: 'episode'; content: string; expiresAt: Date }

export type ExtractedOutcome = 'added' | 'updated' | 'skipped'

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

// 导入工具按来源系统同步已导入的记忆时用：事件记成 sync 并带上出处
export interface UpdateMeta {
  eventType?: 'update' | 'sync'
  eventContext?: Record<string, unknown>
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

  // 这个服务按什么权限读写；管理界面的搜索拿它去召回，不必再算一次
  get access(): Access {
    return this.ctx.access
  }

  // 这次是不是接入方通过 Key 来的：管理界面不代表某个应用，appId 为 null
  private get viaKey(): boolean {
    return this.ctx.access.appId !== null
  }

  // URI 冲突由数据库判断（同一归属的唯一索引，以及共享与成员节点互斥的触发器，二者都按唯一约束报错），
  // 在这里转成 409，REST 与 MCP 都能拿到明确的提示
  private async run<T>(fn: (tx: Tx, personaIds: string[]) => Promise<T>): Promise<T> {
    try {
      return await runInSpace(this.ctx.db, this.ctx.spaceId, this.ctx.personaId, fn)
    } catch (err) {
      if (isUniqueViolation(err, 'memories_uri_live_idx'))
        throw new MemoryError(409, 'URI 已被占用')
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

  // 写不了时报 403。能写人格层、只是人格不对的单独说明：Key 读得到继承来的祖先人格，却只能写应用当前的人格
  private assertWritable(intent: WriteIntent, message: string): void {
    if (canWrite(this.ctx.access, intent)) return
    const wrongPersona =
      intent.layer === 'persona' &&
      this.ctx.access.writeLayers.has('persona') &&
      !canWritePersona(this.ctx.access, intent.personaId)
    throw new MemoryError(403, wrongPersona ? PERSONA_WRITE : message)
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

  // 解析写入目标的层和归属；应用层只能写本应用（admin 例外），人格由调用方随后用 assertWritable 检查
  private async resolveOwnership(
    tx: Tx,
    parsed: ParsedUri,
    requested: Layer | undefined,
  ): Promise<Ownership> {
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

    const ownership: Ownership = { layer, ownerAccountId: null, personaId: null, appId: null }
    if (layer === 'owner' || layer === 'private') ownership.ownerAccountId = access.ownerAccountId
    if (layer === 'persona') {
      const id = (await personaIdsBySlug(tx, [parsed.namespaceSlug!])).get(parsed.namespaceSlug!)
      if (!id) throw new MemoryError(404, `人格不存在：${parsed.namespaceSlug}`)
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

  // 凭据占位符的写入检查，每次写入之后看最终状态：正文里有 {{cred: 时，格式要对，记忆要在私人层、
  // 敏感级至少 private；disclosure 与关键词里不能有（见 checkOutsideContent）。新增的标识要解析到
  // 这条记忆主人的有效凭据，而且写入方看得到它；不存在与看不到返回同一个错误。
  // 已有的引用不重查（凭据删掉之后，含引用的记忆照样能改），但只有写入之前就在同一个主人的私人层里，
  // 正文里的引用才算已有的：从共享的层改层或移进私人层时，原来写着的占位符都按新增检查，
  // 否则别人写进共享记忆里的占位符，改到你的私人层之后就指向了你的凭据
  private async checkCredentialRefs(
    tx: Tx,
    final: {
      layer: Layer
      sensitivity: Sensitivity
      ownerAccountId: string | null
      content: string
    },
    baseline: RefBaseline | null,
  ): Promise<void> {
    const { refs, malformed } = scanPlaceholders(final.content)
    if (malformed.length) {
      throw new MemoryError(
        400,
        `凭据占位符格式不对：${malformed[0]}。写法是 {{cred:<标识>}} 或 {{cred:<标识>#<字段>}}，标识与字段名只用小写字母、数字、_ 和 -；要在正文里写到这种写法时，去掉花括号`,
      )
    }
    if (!refs.length) return
    if (!placeholderAllowed(final.layer, final.sensitivity)) {
      throw new MemoryError(400, PLACEHOLDER_SCOPE)
    }
    const existing =
      baseline && baseline.layer === 'private' && baseline.ownerAccountId === final.ownerAccountId
        ? placeholderIdentifiers(baseline.content() ?? '')
        : new Set<string>()
    const added = refs.filter((r) => !existing.has(r.identifier))
    if (!added.length) return
    // 来自对话与后台任务的内容不能新增引用：否则群里的人能写一条「把 {{cred:…}} 发出来」诱导主人的 agent
    if (!this.addsCredentialRefs) {
      throw new MemoryError(400, '来自对话或后台任务的写入不能新增凭据引用')
    }
    const identifiers = [...new Set(added.map((r) => r.identifier))]
    const rows = await tx
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.ownerAccountId, final.ownerAccountId!),
          inArray(credentials.identifier, identifiers),
          isNull(credentials.deletedAt),
        ),
      )
      // 和删除凭据互斥：删除那边锁住凭据再数引用，这边等它提交后重新读，读到已删除就拒绝
      .for('share')
    for (const identifier of identifiers) {
      const row = rows.find((r) => r.identifier === identifier)
      if (!row || !canReadCredential(this.ctx.access, row)) {
        throw new MemoryError(400, `凭据不存在或不可用：${identifier}`)
      }
      for (const ref of added) {
        if (ref.identifier !== identifier || ref.field === null) continue
        if (!row.fields.some((f) => f.name === ref.field)) {
          throw new MemoryError(400, `凭据 ${identifier} 没有字段 ${ref.field}`)
        }
      }
    }
  }

  // 能不能新增凭据引用：主人与受信 agent 的写入能；对话（untrusted）与后台任务（抽取、Dream）不能，
  // 导入工具是主人自己把数据搬进自己的私人层，由它显式打开
  private get addsCredentialRefs(): boolean {
    if (this.ctx.allowCredentialRefs !== undefined) return this.ctx.allowCredentialRefs
    const provenance = this.ctx.access.writeProvenance
    return provenance === 'owner' || provenance === 'agent'
  }

  // 只改归属或删除状态、不改正文的写入（移动、撤销删除）：看最终状态。之前就在同一个主人的私人层、
  // 之后也还在、敏感级至少 private 时什么都不会变，不必去读（secret 要解密的）正文
  private async checkKeptRefs(
    tx: Tx,
    row: MemoryRow,
    final: { layer: Layer; ownerAccountId: string | null },
  ): Promise<void> {
    if (
      row.layer === 'private' &&
      final.layer === 'private' &&
      row.ownerAccountId === final.ownerAccountId &&
      sensitivityRank(row.sensitivity) >= sensitivityRank('private')
    ) {
      return
    }
    const content = this.contentOf(row)
    if (content === null) return
    await this.checkCredentialRefs(
      tx,
      { ...final, sensitivity: row.sensitivity, content },
      { layer: row.layer, ownerAccountId: row.ownerAccountId, content: () => content },
    )
  }

  // 引用索引按正文重写；secret 的不进索引
  private async syncCredentialRefs(
    tx: Tx,
    memoryId: string,
    sensitivity: Sensitivity,
    content: string,
  ): Promise<void> {
    await tx.delete(memoryCredentialRefs).where(eq(memoryCredentialRefs.memoryId, memoryId))
    if (sensitivity === 'secret') return
    const identifiers = [...placeholderIdentifiers(content)]
    if (!identifiers.length) return
    await tx
      .insert(memoryCredentialRefs)
      .values(
        identifiers.map((identifier) => ({ spaceId: this.ctx.spaceId, memoryId, identifier })),
      )
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
    return this.write(async (tx, _personaIds, released) => {
      const ownership = await this.resolveOwnership(tx, parsed, input.layer)
      const sensitivity = input.sensitivity ?? DEFAULT_SENSITIVITY[ownership.layer]
      this.assertWritable(
        { ...ownership, sensitivity },
        `没有权限写 ${ownership.layer} 层的 ${sensitivity} 级记忆`,
      )
      if (meta.requireAppOwner && ownership.appId) {
        await assertAppOwner(tx, ownership.appId, meta.requireAppOwner)
      }
      checkOutsideContent(input.disclosure, input.glossary)
      await this.checkCredentialRefs(
        tx,
        { ...ownership, sensitivity, content: input.content },
        null,
      )
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
      await this.syncCredentialRefs(tx, id, sensitivity, input.content)
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

  // 写下一批抽取的结果（对象层的事实与情节层的会话摘要，没有 URI、不建向量），连同调用方的收尾
  // （记抽取记录、删掉用过的缓冲）在同一个事务里：中途失败整批回滚，后台任务重试时不会重复写入。
  // 敏感级 public，来源与来源作用域按这次的会话上下文；逐条检查权限与凭据占位符（对话来的内容不能新增引用），
  // 写不进去的那条跳过。replaces 指向这次读得到、写得了、还有效的同一个对象的事实时推翻它：旧的设 valid_to
  // 保留历史，再写一条新的；找不到或写不了时当作新的事实
  async writeExtraction(
    items: readonly ExtractedWrite[],
    eventContext: Record<string, unknown>,
    finish: (tx: Tx, outcomes: ExtractedOutcome[]) => Promise<void>,
  ): Promise<ExtractedOutcome[]> {
    return this.run(async (tx) => {
      const outcomes: ExtractedOutcome[] = []
      for (const item of items) outcomes.push(await this.writeExtracted(tx, item, eventContext))
      await finish(tx, outcomes)
      return outcomes
    })
  }

  private async writeExtracted(
    tx: Tx,
    item: ExtractedWrite,
    eventContext: Record<string, unknown>,
  ): Promise<ExtractedOutcome> {
    const sensitivity = 'public' as const
    try {
      this.assertWritable(
        { layer: item.layer, sensitivity, appId: null, personaId: null },
        `没有权限写 ${item.layer} 层的记忆`,
      )
      await this.checkCredentialRefs(
        tx,
        { layer: item.layer, sensitivity, ownerAccountId: null, content: item.content },
        null,
      )
    } catch (err) {
      if (err instanceof MemoryError) return 'skipped'
      throw err
    }
    const [found] =
      item.layer === 'subject' && item.replaces
        ? await tx
            .select()
            .from(memories)
            .where(
              and(
                eq(memories.id, item.replaces),
                eq(memories.form, 'extracted'),
                eq(memories.layer, 'subject'),
                eq(memories.subjectId, item.subjectId),
                readableConditions(this.ctx.access, { personaIds: [] }),
              ),
            )
            .for('update')
        : []
    // 推翻也是改那一条：读得到但写不了时不动它，当作新的事实
    const before = found && canWrite(this.ctx.access, found) ? found : undefined
    const [row] = await tx
      .insert(memories)
      .values({
        id: randomUUID(),
        spaceId: this.ctx.spaceId,
        form: 'extracted',
        layer: item.layer,
        sensitivity,
        provenance: this.ctx.access.writeProvenance,
        originScope: this.ctx.access.writeOriginScope,
        subjectId: item.layer === 'subject' ? item.subjectId : null,
        content: item.content,
        expiresAt: item.layer === 'episode' ? item.expiresAt : null,
      })
      .returning()
    if (!before) {
      await this.event(tx, row!.id, 'create', null, snapshot(row!, []), eventContext)
      return 'added'
    }
    const [after] = await tx
      .update(memories)
      .set({ validTo: sql`now()`, version: before.version + 1, updatedAt: sql`now()` })
      .where(eq(memories.id, before.id))
      .returning()
    await this.event(tx, before.id, 'update', snapshot(before, []), snapshot(after!, []), {
      ...eventContext,
      supersededBy: row!.id,
    })
    await this.event(tx, row!.id, 'create', null, snapshot(row!, []), {
      ...eventContext,
      supersedes: before.id,
    })
    return 'updated'
  }

  private seal(plaintext: string, id: string) {
    if (!this.ctx.masterKey)
      throw new MemoryError(400, '服务端没有配置 KIOKU_MASTER_KEY，不能保存 secret')
    return encryptSecret(this.ctx.masterKey, plaintext, id)
  }

  async update(input: UpdateMemoryRequest, meta: UpdateMeta = {}): Promise<MemoryView> {
    const parsed = parse(input.uri)
    return this.write(async (tx, personaIds, released) => {
      const before = await this.findReadable(tx, parsed, personaIds)
      // 版本号由 applyUpdate 核对，恢复也走那里
      checkExpected(before, { expectedId: input.expectedId })
      if (meta.requireAppOwner && before.appId) {
        await assertAppOwner(tx, before.appId, meta.requireAppOwner)
      }
      return this.applyUpdate(tx, before, input, {
        released,
        ...(meta.eventType ? { eventType: meta.eventType } : {}),
        ...(meta.eventContext ? { eventContext: meta.eventContext } : {}),
      })
    })
  }

  // 修改与恢复共用：在已经读出的那一行上改字段，检查权限、版本与 secret 的加解密，记一条事件。
  // released 收集改层时顺带让出的过期记录（见 claimUri）
  private async applyUpdate(
    tx: Tx,
    before: MemoryRow,
    input: UpdateFields,
    meta: {
      eventType?: string
      eventContext?: Record<string, unknown>
      glossary?: string[]
      released?: string[]
      // 恢复到某一版：正文换成那一版的，那一版与现在同一归属（见 restore）
      existingRefs?: boolean
    } = {},
  ): Promise<MemoryView> {
    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
      throw new MemoryError(409, `版本已变化：当前是 ${before.version}，请先重新读取`)
    }
    // 规则会误判，留一个由人确认的出口；被诱导的 agent 不能自己确认
    if (input.allowPlaintext && this.viaKey) {
      throw new MemoryError(403, '通过 Key 不能强制降级：要在管理界面里由空间 owner 确认')
    }
    const sensitivity = input.sensitivity ?? before.sensitivity
    for (const s of new Set([before.sensitivity, sensitivity])) {
      this.assertWritable(
        { ...before, sensitivity: s },
        `没有权限改 ${before.layer} 层的 ${s} 级记忆`,
      )
    }

    // 改层只在 base、owner、private 之间：共享与按成员互转时归属跟着变，按成员的层归写入方
    const layer = input.layer ?? before.layer
    const ownerAccountId =
      layer === before.layer
        ? before.ownerAccountId
        : layer === 'base'
          ? null
          : this.ctx.access.ownerAccountId
    if (layer !== before.layer) {
      if (
        layerForDomain(before.domain!) ||
        !(PLAIN_LAYERS as readonly Layer[]).includes(before.layer)
      ) {
        throw new MemoryError(
          400,
          `${before.layer} 层的记忆不能直接改层；人格层与应用层要移动到别的命名空间`,
        )
      }
      if (this.viaKey && perMember(layer) !== perMember(before.layer)) {
        throw new MemoryError(403, KEY_CROSS_OWNERSHIP)
      }
      if (!canWrite(this.ctx.access, { layer, sensitivity, appId: null, personaId: null })) {
        throw new MemoryError(403, `没有权限把记忆改到 ${layer} 层的 ${sensitivity} 级`)
      }
      // 新归属下已失效或过期、又挡着 URI 的记录先让出；真冲突由触发器与唯一索引判断，返回 409
      await this.claimUri(
        tx,
        toParsed(before.domain!, before.path!),
        { ownerAccountId },
        meta.released ?? [],
      )
    }

    // 敏感级跨过 secret 边界时，正文在明文与密文之间转换
    const plaintext = input.content ?? this.contentOf(before)
    if (plaintext === null) throw new MemoryError(403, '没有权限读取这条 secret 的正文')
    // 恢复到某一版：版本与现在同一归属，那时就在现在这个主人的层里，正文里的引用照「之前就有」算
    await this.checkCredentialRefs(
      tx,
      { layer, sensitivity, ownerAccountId, content: plaintext },
      {
        layer: before.layer,
        ownerAccountId: before.ownerAccountId,
        content: () =>
          meta.existingRefs || input.content === undefined ? plaintext : this.contentOf(before),
      },
    )
    // 降级之后正文会进历史快照、全文检索和向量，带着明文降级就收不回来了
    if (
      before.sensitivity === 'secret' &&
      sensitivity !== 'secret' &&
      !input.allowPlaintext &&
      looksLikePlaintextCredential(plaintext)
    ) {
      throw new MemoryError(400, PLAINTEXT_DOWNGRADE)
    }
    const body =
      sensitivity === 'secret'
        ? { content: null, ...this.seal(plaintext, before.id) }
        : { content: plaintext, ciphertext: null, wrappedKey: null }

    const beforeGlossary =
      meta.glossary ?? (await this.glossaryOf(tx, [before.id])).get(before.id) ?? []
    checkOutsideContent(input.disclosure, input.glossaryAdd ?? [])
    const [row] = await tx
      .update(memories)
      .set({
        ...body,
        layer,
        ownerAccountId,
        sensitivity,
        priority: input.priority ?? before.priority,
        disclosure: input.disclosure === undefined ? before.disclosure : input.disclosure,
        version: sql`${memories.version} + 1`,
        updatedAt: new Date(),
      })
      // 读完之后被别的请求改过或删掉了，都不写：不能把修改写进一条已经删除的记忆
      .where(
        and(
          eq(memories.id, before.id),
          eq(memories.version, before.version),
          isNull(memories.deletedAt),
        ),
      )
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
    await this.syncCredentialRefs(tx, before.id, sensitivity, plaintext)
    const becameSecret = sensitivity === 'secret' && before.sensitivity !== 'secret'
    await this.event(
      tx,
      before.id,
      meta.eventType ?? 'update',
      snapshot(before, beforeGlossary),
      snapshot(row, glossary),
      meta.eventContext,
    )
    // 改成 secret 之后，历史事件里不能再留着明文
    if (becameSecret) {
      await this.scrubHistory(tx, before.id)
      // 向量由明文生成，不能等后台任务异步清理，在同一个事务里删掉
      await tx.delete(memoryEmbeddings).where(eq(memoryEmbeddings.memoryId, before.id))
    }
    return this.toView(row, glossary)
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

  async delete(
    uri: string,
    expected: { expectedId?: string | undefined; expectedVersion?: number | undefined } = {},
  ): Promise<void> {
    const parsed = parse(uri)
    const id = await this.run(async (tx, personaIds) => {
      const before = await this.findReadable(tx, parsed, personaIds)
      checkExpected(before, expected)
      this.assertWritable(before, `没有权限删除 ${before.layer} 层的记忆`)
      // 条件里带上读到的版本：检查之后、删除之前别人提交的修改不会被一起删掉，
      // 事件里的「删除前」快照也就是真正被删掉的那一版
      const [row] = await tx
        .update(memories)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(memories.id, before.id),
            eq(memories.version, before.version),
            isNull(memories.deletedAt),
          ),
        )
        .returning()
      if (!row) throw new MemoryError(409, '记忆刚被其他请求修改，请重新读取')
      const glossary = (await this.glossaryOf(tx, [before.id])).get(before.id) ?? []
      await this.event(tx, before.id, 'delete', snapshot(before, glossary), snapshot(row, glossary))
      return before.id
    })
    this.changed([id])
  }

  // 改 URI。移进、移出 persona:// 与 app://，或在不同的人格、应用之间移动时，层与归属跟着目标 URI 变：
  // 移到那里时层由 URI 决定，移出时要用 layer 指定新的层；普通 domain 之间给了 layer 就顺便改层。
  // 原来与目标两边都要有写权限
  async move(input: MoveMemoryRequest): Promise<MemoryView> {
    const from = parse(input.from)
    const to = parse(input.to)
    return this.write(async (tx, personaIds, released) => {
      const before = await this.findReadable(tx, from, personaIds)
      checkExpected(before, input)
      this.assertWritable(before, `没有权限移动 ${before.layer} 层的记忆`)
      const forced = layerForDomain(to.domain)
      if (forced && input.layer) {
        throw new MemoryError(400, `${to.domain}:// 下的层由 URI 决定，不用指定 layer`)
      }
      const sameNamespace = from.domain === to.domain && from.namespaceSlug === to.namespaceSlug
      const crossing = !sameNamespace && (layerForDomain(from.domain) !== null || forced !== null)
      let ownership: Ownership = {
        layer: before.layer,
        ownerAccountId: before.ownerAccountId,
        personaId: before.personaId,
        appId: before.appId,
      }
      if (crossing || (input.layer && input.layer !== before.layer)) {
        // 对象层与情节层来自对话，不能借移动换到别的层：不可信的内容进不了受信的层
        if (before.layer === 'subject' || before.layer === 'episode') {
          throw new MemoryError(400, `${before.layer} 层的记忆不能改层，也不能移到别的命名空间`)
        }
        if (!forced && !input.layer && layerForDomain(from.domain)) {
          throw new MemoryError(
            400,
            `移出 ${from.domain}:// 时要指定新的层（base、owner 或 private）`,
          )
        }
        ownership = await this.resolveOwnership(
          tx,
          to,
          forced ? undefined : (input.layer ?? before.layer),
        )
        if (this.viaKey && perMember(ownership.layer) !== perMember(before.layer)) {
          throw new MemoryError(403, KEY_CROSS_OWNERSHIP)
        }
        this.assertWritable(
          { ...ownership, sensitivity: before.sensitivity },
          `没有权限把记忆移到 ${ownership.layer} 层`,
        )
      }
      await this.checkKeptRefs(tx, before, ownership)
      await this.claimUri(tx, to, ownership, released)
      const [row] = await tx
        .update(memories)
        .set({
          ...ownership,
          domain: to.domain,
          path: to.path,
          version: sql`${memories.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(memories.id, before.id),
            eq(memories.version, before.version),
            isNull(memories.deletedAt),
          ),
        )
        .returning()
      if (!row) throw new MemoryError(409, '记忆刚被其他请求修改，请重新读取')
      const glossary = (await this.glossaryOf(tx, [before.id])).get(before.id) ?? []
      await this.event(tx, before.id, 'move', snapshot(before, glossary), snapshot(row, glossary))
      return this.toView(row, glossary)
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
            this.listable(personaIds),
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
        .where(and(this.listable(personaIds), eq(memories.form, 'curated')))
        .groupBy(memories.domain)
        .orderBy(desc(count()), asc(memories.domain))
      return rows.map((r) => ({ domain: r.domain!, count: r.count }))
    })
  }

  // 树、列表与快速匹配用的读权限条件：listSecret 时按显式读取算，secret 记忆也列出来（见 MemoryContext）
  private listable(personaIds: string[]): SQL {
    return readableConditions(this.ctx.access, {
      personaIds,
      explicit: this.ctx.listSecret === true,
    })
  }

  // 管理界面的记忆列表。用键集分页：排序键加上 id，在上一页最后一条之后接着取，
  // 翻页期间有记忆新建或删除也不会重复、跳过别的条目（offset 分页会）
  async list(query: MemoryListQuery): Promise<MemoryList> {
    const after = decodeCursor(query.sort, query.cursor)
    const uriText = sql`${memories.domain} || '://' || ${memories.path}`
    const contains = query.q ? `%${escapeLike(query.q)}%` : null
    return this.run(async (tx, personaIds) => {
      const rows = await tx
        .select({
          id: memories.id,
          domain: memories.domain,
          path: memories.path,
          layer: memories.layer,
          sensitivity: memories.sensitivity,
          provenance: memories.provenance,
          priority: memories.priority,
          disclosure: memories.disclosure,
          personaId: memories.personaId,
          appId: memories.appId,
          version: memories.version,
          updatedAt: memories.updatedAt,
          updatedMicros: sql<string>`${UPDATED_MICROS}::text`,
        })
        .from(memories)
        .where(
          and(
            this.listable(personaIds),
            eq(memories.form, 'curated'),
            query.domain ? eq(memories.domain, query.domain) : undefined,
            query.layer ? eq(memories.layer, query.layer) : undefined,
            query.sensitivity ? eq(memories.sensitivity, query.sensitivity) : undefined,
            query.provenance ? eq(memories.provenance, query.provenance) : undefined,
            query.personaId ? eq(memories.personaId, query.personaId) : undefined,
            query.appId ? eq(memories.appId, query.appId) : undefined,
            contains
              ? or(ilike(uriText, contains), ilike(memories.disclosure, contains))
              : undefined,
            query.missingDisclosure === 'true' ? MISSING_DISCLOSURE : undefined,
            query.missingDisclosure === 'false' ? sql`not ${MISSING_DISCLOSURE}` : undefined,
            query.plaintext === 'true' ? PLAINTEXT : undefined,
            query.plaintext === 'false' ? sql`not coalesce(${PLAINTEXT}, false)` : undefined,
            // 时间原样交给数据库换算：经过 JS 的 Date 会丢掉微秒
            query.updatedAfter
              ? sql`${memories.updatedAt} >= ${query.updatedAfter}::timestamptz`
              : undefined,
            query.updatedBefore
              ? sql`${memories.updatedAt} < ${query.updatedBefore}::timestamptz`
              : undefined,
            after ? afterCursor(query.sort, after) : undefined,
          ),
        )
        .orderBy(...LIST_ORDER[query.sort])
        .limit(query.limit + 1)
      const page = rows.slice(0, query.limit)
      const last = page.at(-1)
      return {
        items: page.map((r) => ({
          id: r.id,
          uri: formatUri(r.domain!, r.path!),
          layer: r.layer,
          sensitivity: r.sensitivity,
          provenance: r.provenance,
          priority: r.priority,
          disclosure: r.disclosure,
          personaId: r.personaId,
          appId: r.appId,
          version: r.version,
          updatedAt: r.updatedAt.toISOString(),
        })),
        nextCursor: rows.length > query.limit && last ? encodeCursor(query.sort, last) : null,
      }
    })
  }

  // 关键词 → 有这个关键词的记忆，可见范围与列表相同
  async glossaryIndex(): Promise<GlossaryIndex> {
    return this.run(async (tx, personaIds) => {
      const rows = await tx
        .select({ keyword: memoryGlossary.keyword, domain: memories.domain, path: memories.path })
        .from(memoryGlossary)
        .innerJoin(memories, eq(memories.id, memoryGlossary.memoryId))
        .where(and(this.listable(personaIds), eq(memories.form, 'curated')))
        .orderBy(asc(memoryGlossary.keyword), asc(memories.domain), asc(memories.path))
        .limit(GLOSSARY_INDEX_LIMIT + 1)
      const byKeyword = new Map<string, string[]>()
      for (const r of rows.slice(0, GLOSSARY_INDEX_LIMIT)) {
        const uris = byKeyword.get(r.keyword) ?? []
        uris.push(formatUri(r.domain!, r.path!))
        byKeyword.set(r.keyword, uris)
      }
      return {
        entries: [...byKeyword].map(([keyword, uris]) => ({ keyword, uris })),
        truncated: rows.length > GLOSSARY_INDEX_LIMIT,
      }
    })
  }

  // 快速跳转：URI 里含有查询词、或有关键词以它开头的记忆，priority 小的在前
  async matches(text: string, limit: number): Promise<MemoryMatch[]> {
    const needle = text.trim().toLowerCase()
    if (!needle) return []
    const uriText = sql`lower(${memories.domain} || '://' || ${memories.path})`
    return this.run(async (tx, personaIds) => {
      const keywordHit = exists(
        tx
          .select({ one: sql`1` })
          .from(memoryGlossary)
          .where(
            and(
              eq(memoryGlossary.memoryId, memories.id),
              like(sql`lower(${memoryGlossary.keyword})`, `${escapeLike(needle)}%`),
            ),
          ),
      )
      const rows = await tx
        .select({
          domain: memories.domain,
          path: memories.path,
          layer: memories.layer,
          sensitivity: memories.sensitivity,
          priority: memories.priority,
          disclosure: memories.disclosure,
        })
        .from(memories)
        .where(
          and(
            this.listable(personaIds),
            eq(memories.form, 'curated'),
            or(like(uriText, `%${escapeLike(needle)}%`), keywordHit),
          ),
        )
        .orderBy(asc(memories.priority), asc(memories.domain), asc(memories.path))
        .limit(limit)
      return rows.map((r) => ({
        uri: formatUri(r.domain!, r.path!),
        layer: r.layer,
        sensitivity: r.sensitivity,
        priority: r.priority,
        disclosure: r.disclosure,
      }))
    })
  }

  // 概览统计。向量覆盖率只算应当有向量的记忆：读得到、不是 secret、有正文；
  // model 为 null（还没配置嵌入模型）时已有向量记为 0
  async stats(model: string | null, recall: RecallWindow): Promise<MemoryStats> {
    return this.run(async (tx, personaIds) => {
      const [never] = await tx
        .select({ n: count() })
        .from(memories)
        .where(and(this.listable(personaIds), neverRecalled(recall)))
      const groups = await tx
        .select({
          layer: memories.layer,
          sensitivity: memories.sensitivity,
          count: count(),
          missing: sql<number>`count(*) filter (where ${MISSING_DISCLOSURE})`.mapWith(Number),
          plaintext: sql<number>`count(*) filter (where ${PLAINTEXT})`.mapWith(Number),
        })
        .from(memories)
        .where(and(this.listable(personaIds), eq(memories.form, 'curated')))
        .groupBy(memories.layer, memories.sensitivity)
        .orderBy(asc(memories.layer), asc(memories.sensitivity))
      // 每条记忆在一个模型下至多一条向量（主键），左连接计数不会重复；没配置模型时一条也连不上
      const [coverage] = await tx
        .select({ eligible: count(), embedded: count(memoryEmbeddings.memoryId) })
        .from(memories)
        .leftJoin(
          memoryEmbeddings,
          and(eq(memoryEmbeddings.memoryId, memories.id), eq(memoryEmbeddings.model, model ?? '')),
        )
        .where(
          and(
            readableConditions(this.ctx.access, { personaIds }),
            eq(memories.form, 'curated'),
            HAS_CONTENT,
          ),
        )
      return {
        counts: groups.map(({ layer, sensitivity, count }) => ({ layer, sensitivity, count })),
        total: groups.reduce((sum, g) => sum + g.count, 0),
        missingDisclosure: groups.reduce((sum, g) => sum + g.missing, 0),
        plaintextCredentials: groups.reduce((sum, g) => sum + g.plaintext, 0),
        neverRecalled: never?.n ?? 0,
        eligible: coverage?.eligible ?? 0,
        embedded: coverage?.embedded ?? 0,
      }
    })
  }
  // ---- 召回统计（管理界面）----
  // 记忆按成员在管理界面里看得到的算，累计次数跟着记忆的可见性走。
  // 次数 = 还留着的明细里的命中次数 + 清理明细时并入的累计

  // 被召回次数最多的，与从没被召回的（规则见 neverRecalled，和概览的提醒是同一个口径）
  async recallRanking(
    limits: { top: number; never: number },
    recall: RecallWindow,
  ): Promise<{ top: RecalledMemory[]; never: NeverRecalledMemory[]; neverTotal: number }> {
    return this.run(async (tx, personaIds) => {
      const visible = and(this.listable(personaIds), eq(memories.form, 'curated'))
      const top = await tx.execute<{
        id: string
        domain: string
        path: string
        layer: Layer
        sensitivity: Sensitivity
        recent: number
        total: number
        last: string | null
      }>(sql`
        with recent as (
          select h.memory_id, count(*)::int as hits, max(e.created_at) as last
          from ${recallEventHits} h join ${recallEvents} e on e.id = h.event_id
          group by h.memory_id
        )
        select ${memories.id} as id, ${memories.domain} as domain, ${memories.path} as path,
          ${memories.layer} as layer, ${memories.sensitivity} as sensitivity,
          coalesce(r.hits, 0) as recent, coalesce(r.hits, 0) + coalesce(s.count, 0) as total,
          greatest(r.last, s.last_recalled_at) as last
        from ${memories}
        left join recent r on r.memory_id = ${memories.id}
        left join ${memoryRecallStats} s on s.memory_id = ${memories.id}
        where ${visible} and (r.hits is not null or s.count is not null)
        order by total desc, last desc, ${memories.id}
        limit ${limits.top}`)
      const neverWhere = and(visible, neverRecalled(recall))
      const [never, [total]] = await Promise.all([
        tx
          .select({
            id: memories.id,
            domain: memories.domain,
            path: memories.path,
            layer: memories.layer,
            sensitivity: memories.sensitivity,
            createdAt: memories.createdAt,
          })
          .from(memories)
          .where(neverWhere)
          .orderBy(asc(memories.createdAt), asc(memories.id))
          .limit(limits.never),
        tx.select({ n: count() }).from(memories).where(neverWhere),
      ])
      return {
        top: top.map((r) => ({
          id: r.id,
          uri: formatUri(r.domain, r.path),
          layer: r.layer,
          sensitivity: r.sensitivity,
          recent: Number(r.recent),
          total: Number(r.total),
          lastRecalledAt: r.last ? new Date(r.last).toISOString() : null,
        })),
        never: never.map((r) => ({
          id: r.id,
          uri: formatUri(r.domain!, r.path!),
          layer: r.layer,
          sensitivity: r.sensitivity,
          createdAt: r.createdAt.toISOString(),
        })),
        neverTotal: total?.n ?? 0,
      }
    })
  }

  // 一条记忆被召回的次数；管理读取读不到时和不存在一样是 404
  async recallStat(memoryId: string): Promise<MemoryRecallStat> {
    return this.run(async (tx) => {
      await this.findManageable(tx, memoryId)
      const [recent] = await tx
        .select({ n: count(), last: sql<string | null>`max(${recallEvents.createdAt})` })
        .from(recallEventHits)
        .innerJoin(recallEvents, eq(recallEvents.id, recallEventHits.eventId))
        .where(eq(recallEventHits.memoryId, memoryId))
      const [merged] = await tx
        .select()
        .from(memoryRecallStats)
        .where(eq(memoryRecallStats.memoryId, memoryId))
      const times = [recent?.last ? new Date(recent.last) : null, merged?.lastRecalledAt ?? null]
        .filter((t): t is Date => t !== null)
        .map((t) => t.getTime())
      return {
        recent: recent?.n ?? 0,
        total: (recent?.n ?? 0) + (merged?.count ?? 0),
        lastRecalledAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      }
    })
  }

  // 召回事件的明细只给事件发生时的应用主人：按这位成员是事件里记下的主人过滤。
  // 命中的记忆现在按管理读取看不到的（例如被移进了别的成员的私人层），不给 URI
  async recallEvents(query: RecallEventQuery, limit: number): Promise<RecallEventList> {
    return this.run(async (tx) => {
      const keyVisible = this.ctx.access.admin
        ? sql`true`
        : sql`${apps.ownerAccountId} = ${this.ctx.access.ownerAccountId}`
      const rows = await tx
        .select({
          event: recallEvents,
          appName: apps.name,
          keyName: sql<string | null>`case when ${keyVisible} then ${apiKeys.name} end`,
        })
        .from(recallEvents)
        .leftJoin(apps, eq(apps.id, recallEvents.appId))
        .leftJoin(apiKeys, eq(apiKeys.id, recallEvents.keyId))
        .where(
          and(
            eq(recallEvents.ownerAccountId, this.ctx.access.ownerAccountId),
            query.appId ? eq(recallEvents.appId, query.appId) : undefined,
            query.cursor ? lt(recallEvents.id, Number(query.cursor)) : undefined,
          ),
        )
        .orderBy(desc(recallEvents.id))
        .limit(limit + 1)
      const items = rows.slice(0, limit)
      const ids = items.map((r) => r.event.id)
      const hits = ids.length
        ? await tx
            .select({
              eventId: recallEventHits.eventId,
              rank: recallEventHits.rank,
              score: recallEventHits.score,
              via: recallEventHits.via,
              domain: memories.domain,
              path: memories.path,
              shown: sql<boolean>`coalesce(${this.manageable()}, false)`,
            })
            .from(recallEventHits)
            .leftJoin(memories, eq(memories.id, recallEventHits.memoryId))
            .where(inArray(recallEventHits.eventId, ids))
            .orderBy(asc(recallEventHits.eventId), asc(recallEventHits.rank))
        : []
      return {
        items: items.map((r) => ({
          id: r.event.id,
          appId: r.event.appId,
          appName: r.appName,
          keyName: r.keyName,
          source: r.event.source as RecallSource,
          query: r.event.query,
          createdAt: r.event.createdAt.toISOString(),
          hits: hits
            .filter((h) => h.eventId === r.event.id)
            .map((h) => ({
              uri: h.shown && h.domain && h.path ? formatUri(h.domain, h.path) : null,
              rank: h.rank,
              score: Math.round(h.score * 100) / 100,
              via: h.via as RecallVia[],
            })),
        })),
        nextCursor: rows.length > limit && items.length ? String(items.at(-1)!.event.id) : null,
      }
    })
  }

  // ---- 历史、撤销删除与恢复（管理界面）----
  // 可见性都用管理读取判断：读的规则去掉有效期与删除状态，人格不限（见 canRead 的 management）

  private manageable(cols?: MemoryColumns): SQL {
    return readableConditions(this.ctx.access, { personaIds: [], management: true }, cols)
  }

  // 管理读取下看得到这个快照；快照为空，或字段缺失（判断结果为 NULL）时都算看不到
  private snapshotShown(snapshot: SQLWrapper): SQL {
    return sql`(${snapshot} is not null and coalesce((${this.manageable(snapshotColumns(snapshot))}), false))`
  }

  // 事件的前后快照各按管理读取判断，有一边看不到就整条不显示；为空的一边（新建事件没有「改前」）不参与
  private visibleEvent(): SQL {
    const { before, after } = memoryEvents
    return sql`((${before} is null or ${this.snapshotShown(before)}) and (${after} is null or ${this.snapshotShown(after)}))`
  }

  // 「离开」：改前看得到、改后看不到，例如被别的成员改进了他的私人层，或改成了 secret。
  // 对改前看得到的人保留这条记录，只给改前的版本、时间与操作者，改后的一概不给，也不能拿来恢复：
  // 否则共享的记忆被人拿走之后，谁拿走的、什么时候拿走的，连空间 owner 都查不到
  private departureEvent(): SQL {
    const { before, after } = memoryEvents
    return sql`(${this.snapshotShown(before)} and ${after} is not null and not ${this.snapshotShown(after)})`
  }

  // 按 id 找一条管理读取读得到的策展记忆，已删除的也算；读不到和不存在一样是 404
  private async findManageable(tx: Tx, memoryId: string): Promise<MemoryRow> {
    const [row] = await tx
      .select()
      .from(memories)
      .where(and(eq(memories.id, memoryId), eq(memories.form, 'curated'), this.manageable()))
    if (!row) throw new MemoryError(404, '记忆不存在')
    return row
  }

  // 事件连同操作者一起取出：看得到的事件，加上「离开」的事件（left 为 true，见 departureEvent）；
  // 记忆整行已经不在的事件不列出。Key 的名字和 Key 列表一样，
  // 只给应用主人与空间 owner（管理界面里 admin 就是空间 owner）看，别人只看到应用名。
  // checkMemory 为 true 时普通事件只列记忆现在读得到的（活动流）；历史已经先查过这条记忆，不必每行再判断。
  // 「离开」的事件不看记忆现在的状态：离开之后，原来看得到它的人本来就读不到了。
  // 只列策展记忆的事件：抽取的记忆没有 URI，活动流与历史都按 URI 展示，它们另在对象页里看
  private eventRows(
    tx: Tx,
    where: SQL | undefined,
    order: SQL[],
    limit: number,
    checkMemory = true,
  ) {
    const keyVisible = this.ctx.access.admin
      ? sql`true`
      : sql`${apps.ownerAccountId} = ${this.ctx.access.ownerAccountId}`
    const departure = this.departureEvent()
    return tx
      .select({
        event: memoryEvents,
        createdMicros: sql<string>`${microsOf(memoryEvents.createdAt)}::text`,
        domain: memories.domain,
        path: memories.path,
        memoryDeleted: sql<boolean>`(${memories.deletedAt} is not null)`,
        accountName: accounts.displayName,
        keyName: sql<string | null>`case when ${keyVisible} then ${apiKeys.name} end`,
        appName: apps.name,
        left: sql<boolean>`${departure}`,
      })
      .from(memoryEvents)
      .innerJoin(memories, eq(memories.id, memoryEvents.memoryId))
      .leftJoin(accounts, eq(accounts.id, memoryEvents.actorAccountId))
      .leftJoin(apiKeys, eq(apiKeys.id, memoryEvents.actorKeyId))
      .leftJoin(apps, eq(apps.id, apiKeys.appId))
      .where(
        and(
          where,
          eq(memories.form, 'curated'),
          or(and(checkMemory ? this.manageable() : undefined, this.visibleEvent()), departure),
        ),
      )
      .orderBy(...order)
      .limit(limit)
  }

  // 一条记忆的历史，从早到晚
  async history(memoryId: string): Promise<MemoryHistory> {
    return this.run(async (tx) => {
      const row = await this.findManageable(tx, memoryId)
      // 太多时保留最近的：最新的几版才是最常要看、要恢复的
      const latest = await this.eventRows(
        tx,
        eq(memoryEvents.memoryId, memoryId),
        [desc(memoryEvents.id)],
        HISTORY_LIMIT + 1,
        false,
      )
      const rows = latest.slice(0, HISTORY_LIMIT).reverse()
      return {
        memory: {
          id: row.id,
          uri: formatUri(row.domain!, row.path!),
          layer: row.layer,
          sensitivity: row.sensitivity,
          version: row.version,
          deletedAt: row.deletedAt?.toISOString() ?? null,
        },
        events: rows.map((r) => ({
          id: r.event.id,
          type: r.event.eventType,
          provenance: r.event.provenance,
          createdAt: r.event.createdAt.toISOString(),
          actor: actorOf(r),
          before: toSnapshot(r.event.before),
          after: r.left ? null : toSnapshot(r.event.after),
          left: r.left,
        })),
        truncated: latest.length > HISTORY_LIMIT,
      }
    })
  }

  // 已删除的记忆，最近删除的在前。按删除前的最后一版（就是这一行本身）判断可见性；
  // 已经过期或失效的不列：撤销删除之后也看不到（例如让出 URI 时被软删除的过期记录）
  async deleted(query: PageQuery): Promise<DeletedMemoryList> {
    const after = timeCursor(query.cursor, UUID)
    return this.run(async (tx) => {
      const rows = await tx
        .select({
          row: memories,
          deletedMicros: sql<string>`${DELETED_MICROS}::text`,
        })
        .from(memories)
        .where(
          and(
            isNotNull(memories.deletedAt),
            eq(memories.form, 'curated'),
            STILL_VALID,
            this.manageable(),
            after
              ? sql`(${DELETED_MICROS}, ${memories.id}) < (${after[0]}::bigint, ${after[1]}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(memories.deletedAt), desc(memories.id))
        .limit(query.limit + 1)
      const page = rows.slice(0, query.limit)
      const last = page.at(-1)
      return {
        items: page.map(({ row }) => ({
          id: row.id,
          uri: formatUri(row.domain!, row.path!),
          layer: row.layer,
          sensitivity: row.sensitivity,
          priority: row.priority,
          disclosure: row.disclosure,
          version: row.version,
          deletedAt: row.deletedAt!.toISOString(),
        })),
        nextCursor:
          rows.length > query.limit && last
            ? encodeTimeCursor(last.deletedMicros, last.row.id)
            : null,
      }
    })
  }

  // 空间的活动流，最新的在前。按时间排序走 (space_id, created_at) 索引，不必扫别的空间的事件；
  // 同一个事务里的事件时间相同，再按 id 排。游标是上一页最后一条的时间与 id
  async activity(query: PageQuery): Promise<ActivityList> {
    const after = timeCursor(query.cursor, EVENT_ID)
    return this.run(async (tx) => {
      const rows = await this.eventRows(
        tx,
        after
          ? sql`(${memoryEvents.createdAt} < ${fromMicros(after[0])} or (${memoryEvents.createdAt} = ${fromMicros(after[0])} and ${memoryEvents.id} < ${after[1]}::bigint))`
          : undefined,
        [desc(memoryEvents.createdAt), desc(memoryEvents.id)],
        query.limit + 1,
      )
      const page = rows.slice(0, query.limit)
      return {
        items: page.map((r): ActivityItem => ({
          id: r.event.id,
          type: r.event.eventType,
          memoryId: r.event.memoryId!,
          // 离开了可见范围的，只给改前的 URI：记忆现在的 URI 在别人那里
          uri: r.left ? toSnapshot(r.event.before)!.uri : formatUri(r.domain!, r.path!),
          createdAt: r.event.createdAt.toISOString(),
          actor: actorOf(r),
          changes: r.left
            ? []
            : changedFields(toSnapshot(r.event.before), toSnapshot(r.event.after)),
          left: r.left,
          // 离开了可见范围的，不透露它在别人那里现在是什么状态
          deleted: !r.left && r.memoryDeleted,
        })),
        nextCursor:
          rows.length > query.limit && page.length
            ? encodeTimeCursor(page.at(-1)!.createdMicros, String(page.at(-1)!.event.id))
            : null,
      }
    })
  }

  // 恢复到某个事件之后的那一版：只改正文、disclosure、priority 与关键词，不改 URI、层、主人、敏感级与有效期。
  // 快照里没有正文（secret 的快照，或改成 secret 时被抹掉正文的旧快照）时正文保持不变。
  // 只用和现在同一归属（层、主人、人格、应用）、敏感级不高于现在的版本：恢复不能把内容带到更宽的可见范围里
  async restore(input: RestoreRequest): Promise<MemoryView> {
    return this.write(async (tx) => {
      const current = await this.findManageable(tx, input.memoryId)
      if (current.deletedAt) throw new MemoryError(409, '这条记忆已被删除，先撤销删除再恢复')
      const [found] = await tx
        .select({ after: memoryEvents.after })
        .from(memoryEvents)
        .where(
          and(
            eq(memoryEvents.id, input.eventId),
            eq(memoryEvents.memoryId, input.memoryId),
            this.visibleEvent(),
          ),
        )
      const target = found?.after as Record<string, unknown> | null | undefined
      if (!target) throw new MemoryError(404, '这一版不存在')
      if (target.deletedAt != null) {
        throw new MemoryError(400, '这一版是删除之后的状态，要恢复删除请用撤销删除')
      }
      const sameOwner =
        target.layer === current.layer &&
        (target.ownerAccountId ?? null) === current.ownerAccountId &&
        (target.personaId ?? null) === current.personaId &&
        (target.appId ?? null) === current.appId
      if (!sameOwner) {
        throw new MemoryError(400, '这一版和现在不在同一层或不属于同一方，先把层改回去再恢复')
      }
      const targetSensitivity = target.sensitivity as Sensitivity
      if (
        !SENSITIVITIES.includes(targetSensitivity) ||
        sensitivityRank(targetSensitivity) > sensitivityRank(current.sensitivity)
      ) {
        throw new MemoryError(
          400,
          '这一版的敏感级比现在高，恢复会把内容放到更宽的可见范围里；先把敏感级调回去再恢复',
        )
      }
      const glossaryNow = (await this.glossaryOf(tx, [current.id])).get(current.id) ?? []
      const wanted = stringList(target.glossary)
      return this.applyUpdate(
        tx,
        current,
        {
          expectedVersion: input.expectedVersion,
          ...(typeof target.content === 'string' ? { content: target.content } : {}),
          disclosure: typeof target.disclosure === 'string' ? target.disclosure : null,
          ...(typeof target.priority === 'number' ? { priority: target.priority } : {}),
          glossaryAdd: wanted.filter((k) => !glossaryNow.includes(k)),
          glossaryRemove: glossaryNow.filter((k) => !wanted.includes(k)),
        },
        {
          eventType: 'restore',
          eventContext: { fromEventId: input.eventId },
          glossary: glossaryNow,
          existingRefs: true,
        },
      )
    })
  }

  // 撤销删除：清掉删除标记，这一行原样留下（secret 的密文也还在），不从快照重建。
  // URI 已被别的记忆占用时返回 409；提交后重新排队生成向量
  async undelete(input: UndeleteRequest): Promise<MemoryView> {
    return this.write(async (tx, _personaIds, released) => {
      const row = await this.findManageable(tx, input.memoryId)
      if (!row.deletedAt) throw new MemoryError(409, '这条记忆没有被删除')
      this.assertWritable(row, `没有权限恢复 ${row.layer} 层的记忆`)
      // 正文不变，归属也不变，不算新增引用；引用索引的那几行一直留着，撤销之后照常算数
      await this.checkKeptRefs(tx, row, row)
      await this.claimUri(tx, toParsed(row.domain!, row.path!), row, released)
      const [restored] = await tx
        .update(memories)
        .set({ deletedAt: null, version: sql`${memories.version} + 1`, updatedAt: new Date() })
        .where(
          and(
            eq(memories.id, row.id),
            eq(memories.version, row.version),
            isNotNull(memories.deletedAt),
            STILL_VALID,
          ),
        )
        .returning()
      if (!restored) {
        const [stale] = await tx
          .select({ id: memories.id })
          .from(memories)
          .where(and(eq(memories.id, row.id), sql`not ${STILL_VALID}`))
        throw new MemoryError(
          409,
          stale ? '这条记忆已经过期，撤销删除之后也看不到' : '记忆刚被其他请求修改，请重新读取',
        )
      }
      const glossary = (await this.glossaryOf(tx, [row.id])).get(row.id) ?? []
      await this.event(
        tx,
        row.id,
        'undelete',
        snapshot(row, glossary),
        snapshot(restored, glossary),
      )
      return this.toView(restored, glossary)
    })
  }
}

// 一条记忆的历史最多列这么多个事件
const HISTORY_LIMIT = 500

// 调用方带着读到的 id 与版本号时核对。删除后在同一个 URI 重建的记忆版本号从 1 重新开始，只看版本号分不出来
function checkExpected(
  before: MemoryRow,
  expected: { expectedId?: string | undefined; expectedVersion?: number | undefined },
) {
  if (expected.expectedId !== undefined && expected.expectedId !== before.id) {
    throw new MemoryError(409, '这条记忆已被删除并重新创建，请先重新读取')
  }
  if (expected.expectedVersion !== undefined && expected.expectedVersion !== before.version) {
    throw new MemoryError(409, `版本已变化：当前是 ${before.version}，请先重新读取`)
  }
}

// 关键词索引最多给这么多条（关键词 × 记忆），个人用的空间远到不了
const GLOSSARY_INDEX_LIMIT = 5000

const DELETED_MICROS = microsOf(memories.deletedAt)
// 事件 id 不超过 JS 能精确表示的整数
const EVENT_ID = /^\d{1,15}$/

// 还没有失效或过期
export const STILL_VALID = sql`((${memories.validTo} is null or ${memories.validTo} > now()) and (${memories.expiresAt} is null or ${memories.expiresAt} > now()))`

// 「时间 + id」的游标，解不开时报 400
function timeCursor(cursor: string | undefined, id: RegExp): [string, string] | null {
  const after = decodeTimeCursor(cursor, id)
  if (after === 'invalid') throw new MemoryError(400, INVALID_CURSOR)
  return after
}

function actorOf(r: {
  accountName: string | null
  keyName: string | null
  appName: string | null
}): EventActor {
  return { accountName: r.accountName, keyName: r.keyName, appName: r.appName }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

// 快照里界面要用的部分；快照是写入事件时记下的整行（不含密文），secret 的没有正文
function toSnapshot(raw: unknown): MemorySnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const text = (key: string) => (typeof s[key] === 'string' ? (s[key] as string) : null)
  return {
    uri: formatUri(text('domain') ?? '', text('path') ?? ''),
    layer: s.layer as Layer,
    sensitivity: s.sensitivity as Sensitivity,
    priority: typeof s.priority === 'number' ? s.priority : 0,
    disclosure: text('disclosure'),
    glossary: stringList(s.glossary),
    content: text('content'),
    version: typeof s.version === 'number' ? s.version : 0,
    deleted: s.deletedAt != null,
  }
}

// 前后两版之间改了哪些字段；正文两边都没有（secret）时看不出改没改，不算
function changedFields(before: MemorySnapshot | null, after: MemorySnapshot | null): string[] {
  if (!before || !after) return []
  const changes: string[] = []
  if (before.uri !== after.uri) changes.push('uri')
  if (before.layer !== after.layer) changes.push('layer')
  if (before.sensitivity !== after.sensitivity) changes.push('sensitivity')
  if (before.priority !== after.priority) changes.push('priority')
  if (before.disclosure !== after.disclosure) changes.push('disclosure')
  if (before.glossary.join('\n') !== after.glossary.join('\n')) changes.push('glossary')
  if (before.content !== after.content && (before.content !== null || after.content !== null)) {
    changes.push('content')
  }
  return changes
}

// 有正文：与向量任务的口径一致，空字符串也不生成向量
const HAS_CONTENT = sql`(${memories.content} is not null and ${memories.content} <> '')`

// 没写 disclosure：为空或只有空白
const MISSING_DISCLOSURE = sql`(${memories.disclosure} is null or btrim(${memories.disclosure}) = '')`

// 召回事件的保留天数与开始记录的时间（没有记录时为 null），判断「从没被召回」用
export interface RecallWindow {
  retentionDays: number
  recordingSince: Date
}

// 从没被召回过：策展记忆里，保留期内的明细里没有、清理时也没并入过累计的。不算的：secret 本来就不进召回；
// 会进启动上下文的节点每次会话开始都注入，只是不记成召回；建了、或开始记录召回事件，都还不到保留天数的，
// 还没来得及被用到（从 Lore 导入的记忆保留原来的建立时间，升级之后不会一下子全算进来）
function neverRecalled(recall: RecallWindow): SQL {
  const settled = sql`now() - make_interval(days => ${recall.retentionDays}::int)`
  const since = recall.recordingSince.toISOString()
  return sql`(${memories.form} = 'curated' and ${memories.sensitivity} <> 'secret'
    and not (${BOOT_ELIGIBLE})
    and greatest(${memories.createdAt}, ${since}::timestamptz) <= ${settled}
    and not exists (select 1 from ${recallEventHits} h where h.memory_id = ${memories.id})
    and not exists (select 1 from ${memoryRecallStats} s where s.memory_id = ${memories.id}))`
}

// 正文像有明文密码或 Token：与界面、导入工具同一条规则（PLAINTEXT_CREDENTIAL），PostgreSQL 的正则照原样能用，
// ~* 不区分大小写，对应它的 i 标记。secret 的正文是密文（content 为空），结果为 NULL，不算
const PLAINTEXT = sql`(${memories.content} ~* ${PLAINTEXT_CREDENTIAL.source})`

const UPDATED_MICROS = microsOf(memories.updatedAt)

// 各种排序的排序键，最后都加上 id，保证顺序确定
const LIST_ORDER: Record<MemoryListSort, SQL[]> = {
  updated: [desc(memories.updatedAt), desc(memories.id)],
  priority: [asc(memories.priority), asc(memories.domain), asc(memories.path), asc(memories.id)],
  uri: [asc(memories.domain), asc(memories.path), asc(memories.id)],
}

interface CursorRow {
  id: string
  domain: string | null
  path: string | null
  priority: number
  updatedMicros: string
}

// 游标是上一页最后一条的排序键，按排序方式各取所需的几项
type Cursor = (string | number)[]

function encodeCursor(sort: MemoryListSort, row: CursorRow): string {
  const values: Cursor =
    sort === 'updated'
      ? [row.updatedMicros, row.id]
      : sort === 'priority'
        ? [row.priority, row.domain!, row.path!, row.id]
        : [row.domain!, row.path!, row.id]
  return Buffer.from(JSON.stringify(values)).toString('base64url')
}

// URI_PATTERN 允许的最长路径：16 段，每段 64 个字符，加 15 个分隔符
const MAX_PATH_LENGTH = 16 * 64 + 15
const isDomain = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(v)
const isPath = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_PATH_LENGTH

function decodeCursor(sort: MemoryListSort, cursor: string | undefined): Cursor | null {
  if (!cursor) return null
  const invalid = new MemoryError(400, INVALID_CURSOR)
  let values: unknown
  try {
    values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid
  }
  if (!Array.isArray(values)) throw invalid
  const id = values.at(-1)
  if (typeof id !== 'string' || !UUID.test(id)) throw invalid
  const ok =
    sort === 'updated'
      ? values.length === 2 && typeof values[0] === 'string' && MICROS.test(values[0])
      : sort === 'priority'
        ? values.length === 4 &&
          Number.isInteger(values[0]) &&
          (values[0] as number) >= 0 &&
          (values[0] as number) <= 2_147_483_647 &&
          isDomain(values[1]) &&
          isPath(values[2])
        : values.length === 3 && isDomain(values[0]) && isPath(values[1])
  if (!ok) throw invalid
  return values as Cursor
}

// 接在游标之后的条件，比较方向与 LIST_ORDER 一致
function afterCursor(sort: MemoryListSort, c: Cursor): SQL {
  if (sort === 'updated') {
    return sql`(${UPDATED_MICROS}, ${memories.id}) < (${c[0]}::bigint, ${c[1]}::uuid)`
  }
  if (sort === 'priority') {
    return sql`(${memories.priority}, ${memories.domain}, ${memories.path}, ${memories.id}) > (${c[0]}, ${c[1]}, ${c[2]}, ${c[3]}::uuid)`
  }
  return sql`(${memories.domain}, ${memories.path}, ${memories.id}) > (${c[0]}, ${c[1]}, ${c[2]}::uuid)`
}
