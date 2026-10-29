import { createHash } from 'node:crypto'

import {
  REVIEW_LAYERS,
  URI_PATTERN,
  type DreamRunEntry,
  type DreamRunList,
  type DreamSkipReason,
  type DreamSuggestionKind,
  type DreamTrigger,
} from '@kioku/contracts'
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm'

import {
  looksLikePlaintextCredential,
  maskPlaintextCredentials,
  mentionsPlaceholder,
  placeholderIdentifiers,
  scanPlaceholders,
} from '../credential/placeholders'
import type { MasterKey } from '../crypto/keyring'
import { withSpace, type Db, type Tx } from '../db/client'
import { fromMicros, microsOf } from '../db/paging'
import {
  dreamCursors,
  dreamRuns,
  dreamSuggestions,
  memories,
  memoryEmbeddings,
  spaceMembers,
  spaces,
  subjects,
} from '../db/schema'
import { loadEmbeddingModels } from '../embedding/settings'
import {
  DREAM_SCOPE_KEY,
  dreamScopeCondition,
  dreamScopeNames,
  dreamScopeOwner,
  parseDreamScope,
  type ParsedDreamScope,
} from '../memory/scopes'
import { STILL_VALID } from '../memory/service'
import { formatUri, layerForDomain } from '../memory/uri'
import { anyTermQuery, clipChars, inlineText, oneLine, searchTerms } from '../recall/recall'
import type { EndpointConfig } from '../settings/endpoint'
import { extractionUsage } from './budget'
import {
  DREAM_PARSE_ERROR,
  dreamMessages,
  parseDream,
  type DreamCandidate,
  type DreamPromptItem,
  type DreamPromptScope,
} from './dreamPrompt'
import { MAX_FACT_CHARS } from './extract'
import { openAiChatModel, type ChatModel } from './provider'
import { loadExtractionConfig } from './settings'

// Dream：按空间整理记忆，提出合并、提炼、过时与审核建议，建议进待审，成员确认后才执行（见 MemoryService.applySuggestion）。
// 这里只读记忆、请求模型、存建议，不写记忆。用抽取模型，用量计入同一份月度预算，用完就不整理。
// 每个范围（见 memory/scopes.ts）单独请求模型，只看上次以来新增或改动的记忆，再带上它们的近邻作对照

// 每次整理最多请求模型这么多次、用掉这么多 token（到了就不再开始新的一次），剩下的下次接着整理
const MAX_CALLS = 8
const MAX_TOKENS = 60_000
// 一次给模型看的：上次以来新增或改动的最多这么多条，近邻最多这么多条，正文合计最多这么多字
export const DREAM_CHANGED_PER_CALL = 20
const NEIGHBORS_PER_CALL = 20
const INPUT_CHARS = 16_000
// 正文给模型看这么多字：策展记忆更长的只给开头、标上截断，不能合并；事实本来就短
const NODE_CHARS = 1_500
const FACT_CHARS = 300
// 每条新增或改动的策展记忆找几条近邻；每个对象带几条别的事实
const NEIGHBORS_EACH = 3
const FACT_NEIGHBORS_EACH = 6
// 模型的输出：一次最多收这么多条建议；合并后的正文、提炼的草稿、理由、disclosure 的长度上限
const MAX_SUGGESTIONS = 20
const MERGED_NODE_CHARS = 6_000
const DRAFT_CHARS = 2_000
const REASON_CHARS = 200
const DISCLOSURE_CHARS = 200

// 服务端自己判断出的出错原因，不带模型接口或数据库的原文，所有成员都看得到
const PLAIN_ERRORS = new Set([DREAM_PARSE_ERROR])
const HIDDEN_ERROR = '整理出错（原因只有实例管理员看得到）'

type MemoryRow = typeof memories.$inferSelect

// 能提建议的记忆：没删除、现在有效、不是 secret（Dream 读不到 secret，连 URI 都不给模型看），并且至少有一种建议用得上：
// 策展层的策展记忆（合并、过时）；对象层抽取的事实（合并、提炼、过时、审核）；不可信来源写进对象层与情节层的（审核）
const CANDIDATE = and(
  isNull(memories.deletedAt),
  STILL_VALID,
  ne(memories.sensitivity, 'secret'),
  or(
    and(eq(memories.form, 'curated'), notInArray(memories.layer, ['subject', 'episode'])),
    and(eq(memories.form, 'extracted'), eq(memories.layer, 'subject')),
    and(eq(memories.provenance, 'untrusted'), inArray(memories.layer, REVIEW_LAYERS)),
  ),
)!

const isFact = (row: MemoryRow) => row.form === 'extracted' && row.layer === 'subject'

export interface DreamOutcome {
  // done：整理过了（可能只整理了一部分，剩下的下次接着）；skipped：没整理（原因见 reason）；
  // failed：请求模型或写入出错，原因记在运行记录里
  outcome: 'done' | 'skipped' | 'failed'
  reason: DreamSkipReason | null
}

export interface DreamOptions {
  spaceId: string
  // 同一次整理记下的几条运行记录用同一个编号；后台任务里就是任务编号
  runId: string
  trigger: DreamTrigger
  now?: Date
  // 只在测试里换成假的模型
  modelFor?: (config: EndpointConfig) => ChatModel
}

type RunFields = Omit<
  typeof dreamRuns.$inferInsert,
  'id' | 'spaceId' | 'runId' | 'trigger' | 'createdAt'
>

// 整理一个空间：没配抽取模型、本月的预算用完了、上次以来没有新增或改动的内容时不整理，记下原因。
// 否则按范围逐个请求模型，同一个范围没看完的排到后面再来，请求次数或用量到了上限就停，剩下的下次接着整理。
// 中途出了没料到的错（例如抽取模型的 Key 解不开、读库出错）也记一条运行记录写明原因：当天就算整理过，
// 每小时的检查不会接着一遍遍再排；连这一条都写不进去时，只能交给下一个小时
export async function dreamSpace(
  db: Db,
  masterKey: MasterKey | null,
  options: DreamOptions,
): Promise<DreamOutcome> {
  try {
    return await dreamOnce(db, masterKey, options)
  } catch (err) {
    await withSpace(db, options.spaceId, (tx) =>
      recordRun(tx, options, { error: `整理出错：${messageOf(err)}` }),
    ).catch(() => {})
    return { outcome: 'failed', reason: null }
  }
}

// 数据库报的错由 drizzle 包在 cause 里，外层的消息是整条 SQL 与参数，记下里面那层
function messageOf(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause
  if (cause instanceof Error) return cause.message
  return err instanceof Error ? err.message : String(err)
}

async function dreamOnce(
  db: Db,
  masterKey: MasterKey | null,
  options: DreamOptions,
): Promise<DreamOutcome> {
  const { spaceId } = options
  const now = options.now ?? new Date()
  const record = (fields: RunFields) =>
    withSpace(db, spaceId, (tx) => recordRun(tx, options, fields))
  const skip = async (reason: DreamSkipReason): Promise<DreamOutcome> => {
    await record({ skipped: reason })
    return { outcome: 'skipped', reason }
  }
  const config = await loadExtractionConfig(db, masterKey)
  if (!config) return skip('no-model')
  const model = (options.modelFor ?? openAiChatModel)(config)
  const overBudget = async () => {
    const usage = await extractionUsage(db, spaceId)
    return usage.usedTokens >= usage.monthlyTokens
  }
  if (await overBudget()) return skip('budget')
  const queue = await pendingScopes(db, spaceId)
  if (!queue.length) return skip('idle')
  const activeModel = (await loadEmbeddingModels(db)).active?.model ?? null
  let calls = 0
  let tokens = 0
  while (queue.length && calls < MAX_CALLS && tokens < MAX_TOKENS) {
    const scope = queue.shift()!
    // 第一次请求之前已经看过；之后每次都再看一眼，抽取与别的整理可能同时在花
    if (calls > 0 && (await overBudget())) {
      await record({ skipped: 'budget' })
      break
    }
    const result = await dreamScope(db, model, options, scope, { activeModel, now })
    if (!result) continue
    calls++
    tokens += result.tokens
    // 请求模型或写入出错：多半是接口或库的问题，别的范围也会一样，这次就停下
    if (result.failed) return { outcome: 'failed', reason: null }
    if (result.more) queue.push(scope)
  }
  // 要看的记忆在这期间都被删掉了：一次都没请求，也要记一条，每天的检查据此知道今天整理过
  if (!calls) return skip('idle')
  return { outcome: 'done', reason: null }
}

async function recordRun(tx: Tx, options: DreamOptions, fields: RunFields): Promise<void> {
  await tx.insert(dreamRuns).values({
    spaceId: options.spaceId,
    runId: options.runId,
    trigger: options.trigger,
    ...fields,
  })
}

interface PendingScope {
  key: string
  scope: ParsedDreamScope
  // 画像层与私人层的范围属于哪个成员
  owner: string | null
}

// 上次以来有新增或改动的范围，上次整理得早的（从没整理过的最先）排在前面
async function pendingScopes(db: Db, spaceId: string): Promise<PendingScope[]> {
  const members = new Set(
    (
      await db
        .select({ id: spaceMembers.accountId })
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, spaceId))
    ).map((m) => m.id),
  )
  // 和 loadBatch 取记忆的条件相同（见 unseen）：排在游标之后、又不是 seen 里记下的那一版
  const rows = await withSpace(db, spaceId, (tx) =>
    tx.execute<{ scope: string }>(sql`
      with live as (
        select ${DREAM_SCOPE_KEY} as scope, ${memories.updatedAt} as updated_at, ${memories.id} as id,
          ${memories.version} as version
        from ${memories} where ${CANDIDATE}
      )
      select live.scope from live
      left join ${dreamCursors} c on c.scope = live.scope
      where c.scope is null or ((live.updated_at, live.id) > (c.at, c.last_id)
        and (c.seen -> live.id::text ->> 0) is distinct from live.version::text)
      group by live.scope, c.at
      order by c.at nulls first, live.scope`),
  )
  return rows.flatMap(({ scope: key }) => {
    const scope = parseDreamScope(key)
    const owner = dreamScopeOwner(key)
    // 只整理现在还是成员的人的画像层与私人层：离开了空间的成员看不到建议，整理了也白花 token
    if (!scope || (owner && !members.has(owner))) return []
    return [{ key, scope, owner }]
  })
}

// 给模型看的一条记忆
interface Picked {
  row: MemoryRow
  // 更新时间的微秒数：游标按它记，经过 JS 的 Date 会丢掉微秒
  micros: string
  fresh: boolean
  truncated: boolean
  content: string
}

function pick(row: MemoryRow, micros: string, fresh: boolean): Picked {
  const content = row.content ?? ''
  const chars = [...content]
  const max = row.form === 'curated' ? NODE_CHARS : FACT_CHARS
  const truncated = chars.length > max
  return {
    row,
    micros,
    fresh,
    truncated,
    content: truncated ? chars.slice(0, max).join('') : content,
  }
}

const MICROS = sql<string>`${microsOf(memories.updatedAt)}::text`

// ---- 游标 ----
// 位置是（更新时间的微秒数, id），按这个顺序整理。更新时间是写入提交之前取的：时间早、提交晚的写入会排在已经整理过的位置前面，
// 所以位置最多推进到读取时刻往前 SETTLE 的那一刻（那之前更新的都已经提交，读得到），这之后整理过的记在 seen 里，
// 下次照样从位置往后取、跳过 seen 里的那一版。这样晚提交的照样看得到，整理过、没改过的也不会再给模型看
const SETTLE = sql`interval '5 minutes'`
const MIN_UUID = '00000000-0000-0000-0000-000000000000'

interface Position {
  micros: string
  id: string
}

interface Cursor extends Position {
  seen: Record<string, [number, string]>
}

const isBefore = (a: Position, b: Position) => {
  const x = BigInt(a.micros)
  const y = BigInt(b.micros)
  return x < y || (x === y && a.id < b.id)
}

// 排在游标之后、又不是 seen 里记下的那一版
function unseen(cursor: Cursor | null): SQL | undefined {
  if (!cursor) return undefined
  return sql`((${memories.updatedAt}, ${memories.id}) > (${fromMicros(cursor.micros)}, ${cursor.id}::uuid)
    and (${JSON.stringify(cursor.seen)}::jsonb -> ${memories.id}::text ->> 0) is distinct from ${memories.version}::text)`
}

// 整理完一批之后的游标：位置推进到这一批的最后一条，但不越过读取时刻往前 SETTLE 的那一刻（settled），也不往回退；
// 位置之后整理过的（以前记下的与这一批的）记进 seen
export function nextCursor(
  previous: Cursor | null,
  batch: readonly { id: string; version: number; micros: string }[],
  settled: string,
): Cursor {
  const last = batch.at(-1)!
  const cap: Position = { micros: settled, id: MIN_UUID }
  let position: Position = isBefore({ micros: last.micros, id: last.id }, cap)
    ? { micros: last.micros, id: last.id }
    : cap
  if (previous && isBefore(position, previous))
    position = { micros: previous.micros, id: previous.id }
  const seen: Cursor['seen'] = {}
  const entries: [string, number, string][] = [
    ...Object.entries(previous?.seen ?? {}).map(
      ([id, [version, micros]]) => [id, version, micros] as [string, number, string],
    ),
    ...batch.map((b) => [b.id, b.version, b.micros] as [string, number, string]),
  ]
  for (const [id, version, micros] of entries) {
    if (isBefore(position, { micros, id })) seen[id] = [version, micros]
  }
  return { ...position, seen }
}

// 这一次给模型看的记忆：游标之后新增或改动的（按更新时间与 id，正文合计不超过上限），以及它们的近邻
async function loadBatch(
  tx: Tx,
  pending: PendingScope,
  activeModel: string | null,
): Promise<{
  changed: Picked[]
  neighbors: Picked[]
  more: boolean
  cursor: Cursor | null
  settled: string
}> {
  const inScope = and(dreamScopeCondition(pending.scope), CANDIDATE)!
  const [found] = await tx
    .select({
      micros: sql<string>`${microsOf(dreamCursors.at)}::text`,
      id: dreamCursors.lastId,
      seen: dreamCursors.seen,
    })
    .from(dreamCursors)
    .where(eq(dreamCursors.scope, pending.key))
  const cursor = found ?? null
  const [clock] = await tx.execute<{ settled: string }>(
    sql`select ${microsOf(sql`now() - ${SETTLE}`)}::text as settled`,
  )
  const rows = await tx
    .select({ row: memories, micros: MICROS })
    .from(memories)
    .where(and(inScope, unseen(cursor)))
    .orderBy(asc(memories.updatedAt), asc(memories.id))
    .limit(DREAM_CHANGED_PER_CALL + 1)
  let used = 0
  const changed: Picked[] = []
  for (const { row, micros } of rows.slice(0, DREAM_CHANGED_PER_CALL)) {
    const item = pick(row, micros, true)
    if (changed.length && used + item.content.length > INPUT_CHARS) break
    used += item.content.length
    changed.push(item)
  }
  const seen = new Set(changed.map((c) => c.row.id))
  const neighbors: Picked[] = []
  const add = (found: { row: MemoryRow; micros: string }[]) => {
    for (const { row, micros } of found) {
      if (seen.has(row.id) || neighbors.length >= NEIGHBORS_PER_CALL) continue
      const item = pick(row, micros, false)
      if (used + item.content.length > INPUT_CHARS) continue
      used += item.content.length
      seen.add(row.id)
      neighbors.push(item)
    }
  }
  if (pending.scope.kind === 'talk') {
    // 事实的近邻：同一个对象别的有效事实，最近改过的在前，每个对象几条
    const subjectIds = [
      ...new Set(changed.filter((c) => isFact(c.row)).map((c) => c.row.subjectId!)),
    ]
    if (subjectIds.length) {
      const others = await tx
        .select({ row: memories, micros: MICROS })
        .from(memories)
        .where(
          and(
            inScope,
            eq(memories.form, 'extracted'),
            eq(memories.layer, 'subject'),
            inArray(memories.subjectId, subjectIds),
            notInArray(memories.id, [...seen]),
          ),
        )
        .orderBy(desc(memories.updatedAt), asc(memories.id))
        .limit(NEIGHBORS_PER_CALL * FACT_NEIGHBORS_EACH)
      for (const subjectId of subjectIds) {
        add(others.filter((o) => o.row.subjectId === subjectId).slice(0, FACT_NEIGHBORS_EACH))
      }
    }
  } else {
    // 策展记忆的近邻：向量最相近的几条（这条还没有向量时按全文）
    if (activeModel) {
      await tx.execute(sql.raw('set local hnsw.ef_search = 200'))
      await tx.execute(sql.raw('set local hnsw.iterative_scan = relaxed_order'))
    }
    for (const c of changed) {
      if (neighbors.length >= NEIGHBORS_PER_CALL) break
      add(await nearby(tx, inScope, c.row, [...seen], activeModel))
    }
  }
  return {
    changed,
    neighbors,
    more: rows.length > changed.length,
    cursor,
    settled: clock!.settled,
  }
}

async function nearby(
  tx: Tx,
  inScope: ReturnType<typeof and>,
  row: MemoryRow,
  exclude: string[],
  activeModel: string | null,
): Promise<{ row: MemoryRow; micros: string }[]> {
  if (activeModel) {
    const [own] = await tx
      .select({ vector: sql<string>`${memoryEmbeddings.embedding}::text` })
      .from(memoryEmbeddings)
      .where(and(eq(memoryEmbeddings.memoryId, row.id), eq(memoryEmbeddings.model, activeModel)))
    if (own) {
      const found = await tx
        .select({ row: memories, micros: MICROS })
        .from(memoryEmbeddings)
        .innerJoin(memories, eq(memories.id, memoryEmbeddings.memoryId))
        .where(
          and(eq(memoryEmbeddings.model, activeModel), inScope, notInArray(memories.id, exclude)),
        )
        .orderBy(sql`${memoryEmbeddings.embedding} <=> ${own.vector}::vector`)
        .limit(NEIGHBORS_EACH)
      if (found.length) return found
    }
  }
  const [lexemes] = await tx.execute<{ terms: string[] }>(
    sql`select tsvector_to_array(to_tsvector('kioku_zh', ${row.content ?? ''})) as terms`,
  )
  const terms = searchTerms(lexemes?.terms ?? []).slice(0, 32)
  if (!terms.length) return []
  const query = sql`${anyTermQuery(terms)}::tsquery`
  return tx
    .select({ row: memories, micros: MICROS })
    .from(memories)
    .where(and(inScope, sql`${memories.fts} @@ ${query}`, notInArray(memories.id, exclude)))
    .orderBy(desc(sql`ts_rank(${memories.fts}, ${query})`), asc(memories.id))
    .limit(NEIGHBORS_EACH)
}

// 范围的说明：人格、应用、群与私聊对象带上名字；画像层与私人层不写是谁的
async function scopeTitle(tx: Tx, pending: PendingScope): Promise<DreamPromptScope> {
  const scope = (await dreamScopeNames(tx, [pending.key]))(pending.key)
  const name = (value: string | null) => clipChars(inlineText(value ?? ''), 40, '…')
  switch (scope.kind) {
    case 'base':
      return { title: '全空间共用的基础规则与知识（基础层）', talk: false }
    case 'persona':
      return { title: `人格「${name(scope.name)}」的设定（人格层）`, talk: false }
    case 'app':
      return { title: `应用「${name(scope.name)}」独有的记忆（应用层）`, talk: false }
    case 'owner':
      return { title: '一位成员的画像：习惯、偏好、关系（画像层）', talk: false }
    case 'private':
      return { title: '一位成员的私人事务（私人层）', talk: false }
    case 'talk': {
      const origin = scope.origin
      const where =
        origin?.kind === 'group'
          ? `群「${name(origin.name)}」的聊天`
          : origin?.kind === 'direct'
            ? `和「${name(origin.name)}」的私聊`
            : '对话'
      return { title: `${where}里记下的事实与会话摘要`, talk: true }
    }
  }
}

interface ScopeResult {
  tokens: number
  more: boolean
  failed: boolean
}

// 整理一个范围：读出这一次的记忆，请求模型，挑出合规的建议，在一个事务里存下建议、挪动游标、记一条运行记录。
// 请求模型失败时只记原因、不挪游标（下次重来）；输出解析不了时记下原因与用量、挪动游标：
// 同样的输入多半还是解析不了，重试只会白花 token。没有要看的记忆时（期间被删掉了）返回 null
async function dreamScope(
  db: Db,
  model: ChatModel,
  options: DreamOptions,
  pending: PendingScope,
  context: { activeModel: string | null; now: Date },
): Promise<ScopeResult | null> {
  const { spaceId } = options
  const { batch, prompt, names } = await withSpace(db, spaceId, async (tx) => {
    const batch = await loadBatch(tx, pending, context.activeModel)
    const subjectIds = [
      ...new Set(
        [...batch.changed, ...batch.neighbors].flatMap((p) =>
          p.row.subjectId ? [p.row.subjectId] : [],
        ),
      ),
    ]
    const names = subjectIds.length
      ? await tx
          .select({ id: subjects.id, name: subjects.displayName })
          .from(subjects)
          .where(inArray(subjects.id, subjectIds))
      : []
    return { batch, prompt: await scopeTitle(tx, pending), names }
  })
  if (!batch.changed.length) return null
  const subjectName = new Map(names.map((n) => [n.id, n.name]))
  const picked = [...batch.changed, ...batch.neighbors]
  const byHandle = new Map(picked.map((p, i) => [`M${i + 1}`, p]))
  const items: DreamPromptItem[] = [...byHandle].map(([handle, p]) => ({
    handle,
    fresh: p.fresh,
    kind: p.row.form === 'curated' ? 'node' : isFact(p.row) ? 'fact' : 'summary',
    uri: p.row.domain && p.row.path ? formatUri(p.row.domain, p.row.path) : null,
    subject: p.row.subjectId
      ? clipChars(oneLine(subjectName.get(p.row.subjectId) ?? ''), 40, '…') || null
      : null,
    trusted: p.row.provenance !== 'untrusted',
    visibility: prompt.talk ? null : p.row.sensitivity,
    updated: p.row.updatedAt.toISOString().slice(0, 10),
    truncated: p.truncated,
    content: p.content,
  }))
  const counts = { changed: batch.changed.length, considered: picked.length }
  const owner = pending.owner
  const record = (tx: Tx, fields: RunFields) =>
    recordRun(tx, options, { scope: pending.key, ownerAccountId: owner, ...counts, ...fields })
  const next = nextCursor(
    batch.cursor,
    batch.changed.map((c) => ({ id: c.row.id, version: c.row.version, micros: c.micros })),
    batch.settled,
  )
  const position = { at: fromMicros(next.micros), lastId: next.id, seen: next.seen }
  const advance = (tx: Tx) =>
    tx
      .insert(dreamCursors)
      .values({ spaceId, scope: pending.key, ownerAccountId: owner, ...position })
      .onConflictDoUpdate({
        target: [dreamCursors.spaceId, dreamCursors.scope],
        set: { ...position, updatedAt: new Date() },
      })

  let completion
  try {
    completion = await model.complete(
      dreamMessages(prompt, items, context.now.toISOString().slice(0, 10)),
    )
  } catch (err) {
    await withSpace(db, spaceId, (tx) =>
      record(tx, { model: model.model, error: (err as Error).message }),
    )
    return { tokens: 0, more: batch.more, failed: true }
  }
  const usage = {
    model: model.model,
    promptTokens: completion.usage.promptTokens,
    completionTokens: completion.usage.completionTokens,
  }
  const tokens = usage.promptTokens + usage.completionTokens
  let candidates: (DreamCandidate | null)[]
  try {
    candidates = parseDream(completion.content)
  } catch (err) {
    await withSpace(db, spaceId, async (tx) => {
      await advance(tx)
      await record(tx, { ...usage, more: batch.more, error: (err as Error).message })
    })
    return { tokens, more: batch.more, failed: false }
  }

  let dropped = Math.max(0, candidates.length - MAX_SUGGESTIONS)
  const proposals = new Map<string, Proposal>()
  for (const candidate of candidates.slice(0, MAX_SUGGESTIONS)) {
    const proposal = validate(candidate, byHandle, prompt.talk)
    if (!proposal) dropped++
    else if (!proposals.has(proposal.fingerprint)) proposals.set(proposal.fingerprint, proposal)
  }
  const attempted = candidates.length - dropped
  try {
    await withSpace(db, spaceId, async (tx) => {
      const inserted = proposals.size
        ? await tx
            .insert(dreamSuggestions)
            .values(
              [...proposals.values()].map((p) => ({
                spaceId,
                scope: pending.key,
                ownerAccountId: owner,
                ...p,
              })),
            )
            .onConflictDoNothing({
              target: [dreamSuggestions.spaceId, dreamSuggestions.fingerprint],
            })
            .returning({ id: dreamSuggestions.id })
        : []
      await advance(tx)
      await record(tx, {
        ...usage,
        suggested: inserted.length,
        known: attempted - inserted.length,
        dropped,
        more: batch.more,
      })
    })
  } catch (err) {
    // 整个事务已经回滚：单独记下原因，游标没动，下次重来
    await withSpace(db, spaceId, (tx) =>
      record(tx, { ...usage, error: `写入失败：${(err as Error).message}` }),
    )
    return { tokens, more: batch.more, failed: true }
  }
  return { tokens, more: batch.more, failed: false }
}

// 一条合规的建议，按存进 dream_suggestions 的样子
interface Proposal {
  kind: DreamSuggestionKind
  memoryIds: string[]
  versions: number[]
  keepId: string | null
  content: string | null
  uri: string | null
  disclosure: string | null
  verdict: 'confirm' | 'delete' | null
  reason: string
  fingerprint: string
}

// 「种类 + 涉及的记忆 id 与各自的版本」：同样的建议（拒绝过的也算）不再提，涉及的记忆改过之后就不一样了
export function suggestionFingerprint(
  kind: DreamSuggestionKind,
  memories: readonly { id: string; version: number }[],
): string {
  const parts = memories.map((m) => `${m.id}:${m.version}`).sort()
  return createHash('sha256')
    .update(`${kind}\n${parts.join('\n')}`)
    .digest('hex')
}

// 像有明文凭据、或者带凭据占位符的文字：Dream 从记忆里生成的内容不能带进来
const unsafe = (text: string) => looksLikePlaintextCredential(text) || mentionsPlaceholder(text)

// 合并后的正文里的占位符只能是这几条记忆里本来就有的：Dream 不能新增凭据引用。格式不对的也不收
function placeholdersFrom(content: string, rows: readonly MemoryRow[]): boolean {
  const { refs, malformed } = scanPlaceholders(content)
  if (malformed.length) return false
  if (!refs.length) return true
  const known = new Set(rows.flatMap((r) => [...placeholderIdentifiers(r.content ?? '')]))
  return refs.every((ref) => known.has(ref.identifier))
}

// 理由压成一行、打码像明文凭据的片段、截到上限；带占位符的不收
function cleanReason(reason: string): string | null {
  const text = maskPlaintextCredentials(oneLine(reason))
  if (!text || mentionsPlaceholder(text)) return null
  return clipChars(text, REASON_CHARS, '…')
}

// 按规则检查模型给的一条建议，不合规就丢掉（返回 null）：只能引用这次给出的代号，至少涉及一条新增或改动的记忆；
// 合并要求几条的敏感级与来源作用域都相同（合并到保留的那条之后，内容不会给到更宽的可见范围），事实还要是同一个对象的，
// 正文给全了的才能合并；提炼只收事实；过时只收策展记忆与事实；审核只收不可信来源写进对象层与情节层的。
// 正文与草稿像有明文凭据、或者带了这几条记忆里没有的凭据占位符时丢掉
function validate(
  candidate: DreamCandidate | null,
  byHandle: ReadonlyMap<string, Picked>,
  talk: boolean,
): Proposal | null {
  if (!candidate) return null
  const picked: Picked[] = []
  for (const handle of candidate.memories) {
    const found = byHandle.get(handle.trim().toUpperCase())
    if (!found) return null
    if (!picked.includes(found)) picked.push(found)
  }
  if (!picked.some((p) => p.fresh)) return null
  const reason = cleanReason(candidate.reason)
  if (!reason) return null
  const rows = picked.map((p) => p.row)
  const proposal = (fields: Partial<Proposal>, ordered = rows): Proposal => ({
    kind: candidate.kind,
    memoryIds: ordered.map((r) => r.id),
    versions: ordered.map((r) => r.version),
    keepId: null,
    content: null,
    uri: null,
    disclosure: null,
    verdict: null,
    reason,
    fingerprint: suggestionFingerprint(candidate.kind, ordered),
    ...fields,
  })
  switch (candidate.kind) {
    case 'merge': {
      if (picked.length < 2 || picked.some((p) => p.truncated)) return null
      const keep = candidate.keep ? byHandle.get(candidate.keep.trim().toUpperCase()) : picked[0]
      if (!keep || !picked.includes(keep)) return null
      const ordered = [keep.row, ...rows.filter((r) => r !== keep.row)]
      // 合并到保留的那条之后，内容不能给到更宽的可见范围：敏感级与来源作用域都要相同（事实与策展记忆都是）
      if (
        new Set(rows.map((r) => r.sensitivity)).size !== 1 ||
        new Set(rows.map((r) => r.originScope)).size !== 1
      ) {
        return null
      }
      if (talk) {
        if (!rows.every(isFact) || new Set(rows.map((r) => r.subjectId)).size !== 1) return null
        const content = oneLine(candidate.content)
        if (!content || [...content].length > MAX_FACT_CHARS || unsafe(content)) return null
        return proposal({ keepId: keep.row.id, content }, ordered)
      }
      if (!rows.every((r) => r.form === 'curated')) return null
      const content = candidate.content.trim()
      if (
        !content ||
        [...content].length > MERGED_NODE_CHARS ||
        looksLikePlaintextCredential(content) ||
        !placeholdersFrom(content, rows)
      ) {
        return null
      }
      return proposal({ keepId: keep.row.id, content }, ordered)
    }
    case 'distill': {
      if (!talk || picked.length < 2 || !rows.every(isFact)) return null
      const uri = candidate.uri.trim()
      const match = URI_PATTERN.exec(uri)
      // persona:// 与 app:// 下的层由 URI 决定，草稿默认放在执行的成员自己的私人层，不收这两种
      if (!match || layerForDomain(match[1]!)) return null
      const content = candidate.content.trim()
      if (!content || [...content].length > DRAFT_CHARS || unsafe(content)) return null
      const disclosure = candidate.disclosure
        ? clipChars(oneLine(candidate.disclosure), DISCLOSURE_CHARS)
        : ''
      return proposal({
        uri,
        content,
        disclosure: disclosure && !unsafe(disclosure) ? disclosure : null,
      })
    }
    case 'stale': {
      if (picked.length !== 1) return null
      if (talk ? !isFact(rows[0]!) : rows[0]!.form !== 'curated') return null
      return proposal({})
    }
    case 'review': {
      const row = rows[0]!
      if (!talk || picked.length !== 1) return null
      if (
        row.provenance !== 'untrusted' ||
        !(REVIEW_LAYERS as readonly string[]).includes(row.layer)
      )
        return null
      return proposal({ verdict: candidate.verdict })
    }
  }
}

// ---- 定时与运行记录 ----

// 今天（UTC）还没做过定时整理的空间：每小时的检查据此排任务，每个空间每天一次。手动整理不算
export async function dreamsDue(db: Db, now = new Date()): Promise<string[]> {
  const today = sql`date_trunc('day', ${now.toISOString()}::timestamptz, 'UTC')`
  const due: string[] = []
  for (const { id } of await db.select({ id: spaces.id }).from(spaces)) {
    const [done] = await withSpace(db, id, (tx) =>
      tx
        .select({ id: dreamRuns.id })
        .from(dreamRuns)
        .where(and(eq(dreamRuns.trigger, 'scheduled'), sql`${dreamRuns.createdAt} >= ${today}`))
        .limit(1),
    )
    if (!done) due.push(id)
  }
  return due
}

// 运行记录里的一条给谁看：整次没走到范围的、共享范围的给所有成员，画像层与私人层的只给本人
const visibleRun = (accountId: string) =>
  sql`(${dreamRuns.scope} is null or (${dreamRuns.scope} not like 'owner:%' and ${dreamRuns.scope} not like 'private:%')
    or ${dreamRuns.ownerAccountId} = ${accountId})`

// 最近几次整理，新的在前。模型接口或数据库报的原文只给实例管理员看
export async function dreamRunList(
  db: Db,
  spaceId: string,
  viewer: { accountId: string; admin: boolean },
  limit = 10,
): Promise<DreamRunList> {
  return withSpace(db, spaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(dreamRuns)
      .where(visibleRun(viewer.accountId))
      .orderBy(desc(dreamRuns.createdAt), desc(dreamRuns.id))
      .limit(limit * 12)
    const named = await dreamScopeNames(
      tx,
      rows.flatMap((r) => (r.scope ? [r.scope] : [])),
    )
    const runs = new Map<string, DreamRunList['runs'][number]>()
    for (const row of rows) {
      let run = runs.get(row.runId)
      if (!run) {
        if (runs.size >= limit) continue
        run = {
          runId: row.runId,
          trigger: row.trigger as DreamTrigger,
          at: row.createdAt.toISOString(),
          entries: [],
        }
        runs.set(row.runId, run)
      }
      // 一次整理的几条按时间先后列
      run.entries.unshift(entryOf(row, named, viewer.admin))
      run.at = row.createdAt.toISOString() < run.at ? row.createdAt.toISOString() : run.at
    }
    return { runs: [...runs.values()] }
  })
}

function entryOf(
  row: typeof dreamRuns.$inferSelect,
  named: (key: string) => DreamRunEntry['scope'],
  admin: boolean,
): DreamRunEntry {
  return {
    scope: row.scope ? named(row.scope) : null,
    model: row.model,
    tokens: row.promptTokens + row.completionTokens,
    changed: row.changed,
    considered: row.considered,
    suggested: row.suggested,
    known: row.known,
    dropped: row.dropped,
    more: row.more,
    skipped: (row.skipped as DreamSkipReason | null) ?? null,
    error: !row.error || admin || PLAIN_ERRORS.has(row.error) ? row.error : HIDDEN_ERROR,
  }
}
