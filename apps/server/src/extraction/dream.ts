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

import { maskPlaintextCredentials, mentionsPlaceholder } from '../credential/placeholders'
import type { MasterKey } from '../crypto/keyring'
import { withSpace, type Db, type Tx } from '../db/client'
import {
  dreamMarks,
  dreamRuns,
  dreamSuggestions,
  memories,
  memoryEmbeddings,
  spaceMembers,
  spaces,
  subjects,
} from '../db/schema'
import { loadEmbeddingModels } from '../embedding/settings'
import { STILL_VALID } from '../memory/filter'
import {
  DREAM_SCOPE_KEY,
  dreamScopeCondition,
  dreamScopeNames,
  dreamScopeOwner,
  parseDreamScope,
  type ParsedDreamScope,
} from '../memory/scopes'
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
import {
  DISCLOSURE_CHARS,
  disclosureProblem,
  draftProblem,
  factProblem,
  mergedNodeProblem,
} from './dreamText'
import { openAiChatModel, type ChatModel } from './provider'
import { loadExtractionConfig } from './settings'

// Dream：按空间整理记忆，提出合并、提炼、过时与审核建议，建议进待审，成员确认后才执行（见 MemoryService.applySuggestion）。
// 这里只读记忆、请求模型、存建议，不写记忆。用抽取模型，用量计入同一份月度预算，用完就不整理。
// 每个范围（见 memory/scopes.ts）单独请求模型，只看上次以来新增或改动的记忆，再带上它们的近邻作对照

// 每次整理最多请求模型这么多次、用掉这么多 token（到了就不再开始新的一次），剩下的下次接着整理。
// 共享的范围先用，画像层与私人层用剩下的（见 dreamOnce）
export const DREAM_MAX_CALLS = 8
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
// 模型的输出：一次最多收这么多条建议；理由的长度上限（要写进记忆的文字的规则见 dreamText.ts）
const MAX_SUGGESTIONS = 20
const REASON_CHARS = 200

// 共享部分的汇总里的出错：共享的范围请求模型或写入出错，这一次就停下了
const SHARED_FAILED = '共享的范围出错，这次停下了（原因见出错的那个范围）'
// 服务端自己判断出的出错原因，不带模型接口或数据库的原文，所有成员都看得到
const PLAIN_ERRORS = new Set([DREAM_PARSE_ERROR, SHARED_FAILED])
const HIDDEN_ERROR = '整理出错（原因只有实例管理员看得到）'

type MemoryRow = typeof memories.$inferSelect

// 能提建议的记忆：没删除、现在有效、不是 secret（Dream 读不到 secret，连 URI 都不给模型看），并且至少有一种建议用得上：
// 策展层的策展记忆（合并、过时）；对象层抽取的事实（合并、提炼、过时、审核）；不可信来源写进对象层与情节层的（审核）。
// 画像层与私人层的还要主人允许，见 candidate
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

// 让 Dream 整理自己的画像层与私人层的成员：现在还是成员，开关（space_members.dream_private，默认开）开着。
// 离开了空间的成员看不到建议，整理了也白花 token；关掉了的不发给模型，也就不记整理标记，再打开时接着看。
// 选范围时读一次，每次请求模型之前再读一次（见 dreamScope），不在每条记忆上去查成员表；只问一个成员时给 owner
async function allowedOwners(db: Db | Tx, spaceId: string, owner?: string): Promise<string[]> {
  const rows = await db
    .select({ id: spaceMembers.accountId })
    .from(spaceMembers)
    .where(
      and(
        eq(spaceMembers.spaceId, spaceId),
        eq(spaceMembers.dreamPrivate, true),
        owner ? eq(spaceMembers.accountId, owner) : undefined,
      ),
    )
  return rows.map((m) => m.id)
}

// 写结果之前锁住这一组的主人在成员表里的那一行（FOR SHARE），看他现在的开关；不再是成员时为 null。
// 同时改开关的请求要等写结果的事务提交，存下的结果不会和关掉交错：关掉在前就不存，存在前就算关掉之前整理的
async function lockedSwitch(tx: Tx, spaceId: string, owner: string): Promise<boolean | null> {
  const [row] = await tx
    .select({ on: spaceMembers.dreamPrivate })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.accountId, owner)))
    .for('share')
  return row ? row.on : null
}

// 能提建议的记忆里，画像层与私人层的只收名单里的主人的（名单见 allowedOwners）
const candidate = (owners: readonly string[]) =>
  and(
    CANDIDATE,
    sql`(${memories.layer} not in ('owner', 'private') or ${memories.ownerAccountId} = any(${sql.param(owners)}::uuid[]))`,
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
  // 只在测试里用：读完一个范围这一次的记忆之后、请求模型之前调用
  afterBatch?: (scope: string) => Promise<void>
}

type RunFields = Omit<
  typeof dreamRuns.$inferInsert,
  'id' | 'spaceId' | 'runId' | 'trigger' | 'createdAt'
>

// 整理到哪儿了：共享部分的汇总写下了没有，正在整理哪个范围
interface Progress {
  summarized: boolean
  scope: PendingScope | null
}

// 整理一个空间：没配抽取模型、本月的预算用完了、上次以来没有新增或改动的内容时不整理，记下原因。
// 否则分两段：先把共享的范围整理完，记一条共享部分的汇总，再整理各人的画像层与私人层（见 dreamOnce）。
// 中途出了没料到的错（例如抽取模型的 Key 解不开、读库出错）也记一条运行记录写明原因：当天就算整理过，
// 每小时的检查不会接着一遍遍再排。汇总还没写下时出的错，这一条就是汇总；之后出的错记在当时那个画像层或私人层的
// 范围上，只给本人看。连这一条都写不进去时，两个错误都记进日志，原来的错误照样抛出去，由后台任务记下这次失败；
// 没有运行记录，下一个小时会再排
export async function dreamSpace(
  db: Db,
  masterKey: MasterKey | null,
  options: DreamOptions,
): Promise<DreamOutcome> {
  const progress: Progress = { summarized: false, scope: null }
  try {
    return await dreamOnce(db, masterKey, options, progress)
  } catch (err) {
    const error = `整理出错：${messageOf(err)}`
    const at = progress.scope
    // 汇总写下之后、又不在哪个范围里：不再记一条范围为空的（那就成了第二条汇总），只记日志
    if (progress.summarized && !at) {
      console.error('Dream 整理出错', err)
      return { outcome: 'failed', reason: null }
    }
    try {
      await withSpace(db, options.spaceId, (tx) =>
        recordRun(
          tx,
          options,
          progress.summarized && at
            ? { scope: at.key, ownerAccountId: at.owner, error }
            : { error },
        ),
      )
    } catch (recordErr) {
      console.error('Dream 整理出错', err)
      console.error('Dream 的运行记录也写不进去', recordErr)
      throw err
    }
    return { outcome: 'failed', reason: null }
  }
}

// 数据库报的错由 drizzle 包在 cause 里，外层的消息是整条 SQL 与参数，记下里面那层
function messageOf(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause
  if (cause instanceof Error) return cause.message
  return err instanceof Error ? err.message : String(err)
}

// 别的成员看到的列表与状态只按共享部分的汇总与他自己的画像层、私人层算（见 dreamRunOutcome），
// 所以分两段整理，共享的那一段不受任何人的画像层与私人层影响：
// 1. 先把共享的范围整理完，没看完的接着看，都在画像层与私人层之前；每次整理的请求次数与用量上限先给这一段用。
//    出错就停下：多半是接口或库的问题，别的范围也会一样；
// 2. 接着记一条共享部分的汇总（范围为空）：出错了、整理过了（还有没看完的）、没有要整理的。
//    整次没走到范围时（没配模型、预算用完、什么都没有要整理的）记的那一条也是汇总；
// 3. 再整理画像层与私人层，用剩下的请求次数与用量。结果、出错与用量只记在各自的范围上，
//    一个范围出错不耽误别人的范围，接着整理下一个
async function dreamOnce(
  db: Db,
  masterKey: MasterKey | null,
  options: DreamOptions,
  progress: Progress,
): Promise<DreamOutcome> {
  const { spaceId } = options
  const now = options.now ?? new Date()
  const record = (fields: RunFields) =>
    withSpace(db, spaceId, (tx) => recordRun(tx, options, fields))
  const summarize = async (fields: RunFields) => {
    await record(fields)
    progress.summarized = true
  }
  const skip = async (reason: DreamSkipReason): Promise<DreamOutcome> => {
    await summarize({ skipped: reason })
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
  const spent = { calls: 0, tokens: 0 }

  // 整理一段：没看完的排到这一段的后面接着看。请求次数或用量到了上限、本月预算用完就停，
  // 预算用完记在没整理的那个范围上。返回这一段请求了几次、有没有出错、还有没有没看完的
  const runSegment = async (scopes: PendingScope[], stopOnFailure: boolean) => {
    const pending = [...scopes]
    let calls = 0
    let failed = false
    while (pending.length && spent.calls < DREAM_MAX_CALLS && spent.tokens < MAX_TOKENS) {
      const scope = pending[0]!
      progress.scope = scope
      // 第一次请求之前已经看过；之后每次都再看一眼，抽取与别的整理可能同时在花
      if (spent.calls > 0 && (await overBudget())) {
        await record({ scope: scope.key, ownerAccountId: scope.owner, skipped: 'budget' })
        break
      }
      pending.shift()
      const result = await dreamScope(db, model, options, scope, { activeModel, now })
      progress.scope = null
      if (!result) continue
      calls++
      spent.calls++
      spent.tokens += result.tokens
      if (result.failed) {
        failed = true
        if (stopOnFailure) break
        continue
      }
      if (result.more) pending.push(scope)
    }
    progress.scope = null
    return { calls, failed, more: pending.length > 0 }
  }

  // 范围已经按 pendingScopes 排好，共享的在前：开头没有主人的那些是第一段，从第一个画像层或私人层的范围起是第二段
  const cut = queue.findIndex((s) => s.owner !== null)
  const shared = await runSegment(cut < 0 ? queue : queue.slice(0, cut), true)
  // 共享的范围要看的记忆在这期间都被删掉了也算没有要整理的。一次都没请求时也有这一条，每天的检查据此知道今天整理过
  await summarize(
    shared.failed
      ? { error: SHARED_FAILED }
      : shared.calls
        ? { more: shared.more }
        : { skipped: 'idle' },
  )
  if (shared.failed) return { outcome: 'failed', reason: null }
  const personal = await runSegment(cut < 0 ? [] : queue.slice(cut), false)
  if (personal.failed) return { outcome: 'failed', reason: null }
  if (!shared.calls && !personal.calls) return { outcome: 'skipped', reason: 'idle' }
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

// 这次要看的记忆：没整理过的，或者整理之后改过的（标记记着整理时的版本，和现在的不一样）。不看更新时间：
// 导入的记忆带着原来的更新时间，写了很久才提交的写入更新时间也早，按时间推进的位置会把它们漏掉
const UNMARKED = sql`not exists (
  select 1 from ${dreamMarks}
  where ${dreamMarks.memoryId} = ${memories.id} and ${dreamMarks.version} = ${memories.version})`

// 范围是某个成员的画像层或私人层（owner:<成员>、private:<成员>，见 memory/scopes.ts 的 DREAM_SCOPE_KEY）
const personalScope = (scope: SQL) => sql`(${scope} like 'owner:%' or ${scope} like 'private:%')`

// 有要看的记忆的范围，顺序只在这里定：共享的在前、画像层与私人层的在后（见 dreamOnce）；再按上次整理的时间，
// 整理得早的（从没整理过、记录已经清掉的最先）排在前面，没整理成的（预算用完、主人关掉了）不算整理过。
// 画像层与私人层的范围只有主人允许时才有（见 allowedOwners）
async function pendingScopes(db: Db, spaceId: string): Promise<PendingScope[]> {
  const rows = await withSpace(db, spaceId, async (tx) => {
    const owners = await allowedOwners(tx, spaceId)
    return tx.execute<{ scope: string }>(sql`
      with pending as (
        select distinct ${DREAM_SCOPE_KEY} as scope from ${memories}
        where ${candidate(owners)} and ${UNMARKED}
      ), last as (
        select ${dreamRuns.scope} as scope, max(${dreamRuns.createdAt}) as at from ${dreamRuns}
        where ${dreamRuns.scope} is not null and ${dreamRuns.skipped} is null group by ${dreamRuns.scope}
      )
      select pending.scope from pending
      left join last on last.scope = pending.scope
      order by ${personalScope(sql`pending.scope`)}, last.at nulls first, pending.scope`)
  })
  return rows.flatMap(({ scope: key }) => {
    const scope = parseDreamScope(key)
    return scope ? [{ key, scope, owner: dreamScopeOwner(key) }] : []
  })
}

// 给模型看的一条记忆
interface Picked {
  row: MemoryRow
  fresh: boolean
  truncated: boolean
  content: string
}

function pick(row: MemoryRow, fresh: boolean): Picked {
  const content = row.content ?? ''
  const chars = [...content]
  const max = row.form === 'curated' ? NODE_CHARS : FACT_CHARS
  const truncated = chars.length > max
  return { row, fresh, truncated, content: truncated ? chars.slice(0, max).join('') : content }
}

// 这一次给模型看的记忆：没整理过或整理之后改过的（按更新时间与 id，正文合计不超过上限），以及它们的近邻。
// owners 是这时允许整理画像层与私人层的成员（见 allowedOwners），近邻也只从这些里找
async function loadBatch(
  tx: Tx,
  pending: PendingScope,
  activeModel: string | null,
  owners: readonly string[],
): Promise<{ changed: Picked[]; neighbors: Picked[]; more: boolean }> {
  const inScope = and(dreamScopeCondition(pending.scope), candidate(owners))!
  const rows = await tx
    .select()
    .from(memories)
    .where(and(inScope, UNMARKED))
    .orderBy(asc(memories.updatedAt), asc(memories.id))
    .limit(DREAM_CHANGED_PER_CALL + 1)
  let used = 0
  const changed: Picked[] = []
  for (const row of rows.slice(0, DREAM_CHANGED_PER_CALL)) {
    const item = pick(row, true)
    if (changed.length && used + item.content.length > INPUT_CHARS) break
    used += item.content.length
    changed.push(item)
  }
  const seen = new Set(changed.map((c) => c.row.id))
  const neighbors: Picked[] = []
  const add = (found: MemoryRow[]) => {
    for (const row of found) {
      if (seen.has(row.id) || neighbors.length >= NEIGHBORS_PER_CALL) continue
      const item = pick(row, false)
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
        .select()
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
        add(others.filter((o) => o.subjectId === subjectId).slice(0, FACT_NEIGHBORS_EACH))
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
  return { changed, neighbors, more: rows.length > changed.length }
}

async function nearby(
  tx: Tx,
  inScope: ReturnType<typeof and>,
  row: MemoryRow,
  exclude: string[],
  activeModel: string | null,
): Promise<MemoryRow[]> {
  if (activeModel) {
    const [own] = await tx
      .select({ vector: sql<string>`${memoryEmbeddings.embedding}::text` })
      .from(memoryEmbeddings)
      .where(and(eq(memoryEmbeddings.memoryId, row.id), eq(memoryEmbeddings.model, activeModel)))
    if (own) {
      const found = await tx
        .select({ row: memories })
        .from(memoryEmbeddings)
        .innerJoin(memories, eq(memories.id, memoryEmbeddings.memoryId))
        .where(
          and(eq(memoryEmbeddings.model, activeModel), inScope, notInArray(memories.id, exclude)),
        )
        .orderBy(sql`${memoryEmbeddings.embedding} <=> ${own.vector}::vector`)
        .limit(NEIGHBORS_EACH)
      if (found.length) return found.map((f) => f.row)
    }
  }
  const [lexemes] = await tx.execute<{ terms: string[] }>(
    sql`select tsvector_to_array(to_tsvector('kioku_zh', ${row.content ?? ''})) as terms`,
  )
  const terms = searchTerms(lexemes?.terms ?? []).slice(0, 32)
  if (!terms.length) return []
  const query = sql`${anyTermQuery(terms)}::tsquery`
  return tx
    .select()
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

// 整理一个范围：读出这一次的记忆，请求模型，挑出合规的建议，在一个事务里存下建议、给这一批记下整理过的版本、记一条运行记录。
// 请求模型失败时只记原因、不记整理过（下次重来）；输出解析不了时记下原因与用量、记下整理过：
// 同样的输入多半还是解析不了，重试只会白花 token。没有要看的记忆时（期间被删掉了，或者主人关掉了整理）返回 null。
// 画像层与私人层的范围看三次主人的开关：读这一批时按允许的名单取；读完之后、请求模型之前再看一眼，这之间关掉的不发；
// 写结果的事务里锁住成员那一行再看一眼，请求模型期间关掉的，这一次的建议与整理标记都不存，只记下用掉的 token；
// 请求期间不再是成员的，什么都不存也不记。已经发给模型的那一次收不回来
async function dreamScope(
  db: Db,
  model: ChatModel,
  options: DreamOptions,
  pending: PendingScope,
  context: { activeModel: string | null; now: Date },
): Promise<ScopeResult | null> {
  const { spaceId } = options
  const owner = pending.owner
  const { batch, prompt, names } = await withSpace(db, spaceId, async (tx) => {
    const owners = await allowedOwners(tx, spaceId)
    const batch = await loadBatch(tx, pending, context.activeModel, owners)
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
  await options.afterBatch?.(pending.key)
  // 读这一批的事务已经提交：请求模型之前再看一眼，这之间关掉的不发
  if (owner && !(await allowedOwners(db, spaceId, owner)).length) return null
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
  const record = (tx: Tx, fields: RunFields) =>
    recordRun(tx, options, { scope: pending.key, ownerAccountId: owner, ...counts, ...fields })
  // 这一批整理过了：记下每条当时的版本，之后没改过的不再给模型看。近邻只是对照，不记
  const mark = (tx: Tx) =>
    tx
      .insert(dreamMarks)
      .values(batch.changed.map((c) => ({ spaceId, memoryId: c.row.id, version: c.row.version })))
      .onConflictDoUpdate({ target: dreamMarks.memoryId, set: { version: sql`excluded.version` } })

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
  let candidates: (DreamCandidate | null)[] = []
  let unparsed: string | null = null
  try {
    candidates = parseDream(completion.content)
  } catch (err) {
    unparsed = (err as Error).message
  }

  let dropped = Math.max(0, candidates.length - MAX_SUGGESTIONS)
  const proposals = new Map<string, Proposal>()
  for (const candidate of candidates.slice(0, MAX_SUGGESTIONS)) {
    const proposal = validate(candidate, byHandle, prompt.talk)
    if (!proposal) dropped++
    else if (!proposals.has(proposal.fingerprint)) proposals.set(proposal.fingerprint, proposal)
  }
  const attempted = candidates.length - dropped
  let saved: boolean
  try {
    saved = await withSpace(db, spaceId, async (tx) => {
      if (owner) {
        const on = await lockedSwitch(tx, spaceId, owner)
        // 请求模型期间不再是成员了：结果不存，也不给他记（他看不到了，也说不上是他关掉的）
        if (on === null) return false
        // 请求模型期间关掉了：建议与整理标记都不存，只记下用掉的 token
        if (!on) {
          await record(tx, { ...usage, skipped: 'opted-out' })
          return false
        }
      }
      if (unparsed) {
        await mark(tx)
        await record(tx, { ...usage, more: batch.more, error: unparsed })
        return true
      }
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
      await mark(tx)
      await record(tx, {
        ...usage,
        suggested: inserted.length,
        known: attempted - inserted.length,
        dropped,
        more: batch.more,
      })
      return true
    })
  } catch (err) {
    // 整个事务已经回滚：单独记下原因，这一批没记成整理过，下次重来
    await withSpace(db, spaceId, (tx) =>
      record(tx, { ...usage, error: `写入失败：${(err as Error).message}` }),
    )
    return { tokens, more: batch.more, failed: true }
  }
  // 结果没存（主人关掉了、不再是成员）：这个范围这次不再接着整理
  return { tokens, more: saved && batch.more, failed: false }
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

// 理由压成一行、打码像明文凭据的片段、截到上限；带占位符的不收
function cleanReason(reason: string): string | null {
  const text = maskPlaintextCredentials(oneLine(reason))
  if (!text || mentionsPlaceholder(text)) return null
  return clipChars(text, REASON_CHARS, '…')
}

// 按规则检查模型给的一条建议，不合规就丢掉（返回 null）：只能引用这次给出的代号，至少涉及一条新增或改动的记忆；
// 合并要求几条的敏感级与来源作用域都相同（合并到保留的那条之后，内容不会给到更宽的可见范围），事实还要是同一个对象的，
// 正文给全了的才能合并；提炼只收事实；过时只收策展记忆与事实；审核只收不可信来源写进对象层与情节层的。
// 要写进记忆的文字和执行时过同一套检查（见 dreamText.ts），不合规就丢掉；disclosure 先截到上限，不合规的只去掉它
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
        if (factProblem(content)) return null
        return proposal({ keepId: keep.row.id, content }, ordered)
      }
      if (!rows.every((r) => r.form === 'curated')) return null
      const content = candidate.content.trim()
      if (
        mergedNodeProblem(
          content,
          rows.map((r) => r.content),
        )
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
      if (draftProblem(content)) return null
      const disclosure = candidate.disclosure
        ? clipChars(oneLine(candidate.disclosure), DISCLOSURE_CHARS)
        : ''
      return proposal({
        uri,
        content,
        disclosure: disclosure && !disclosureProblem(disclosure) ? disclosure : null,
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

// 运行记录里的一条给谁看：共享部分的汇总（范围为空）与共享范围的给所有成员，画像层与私人层的只给本人。
// 共享范围的记录都在汇总之前写下（见 dreamOnce），内容与时间都和任何人的画像层、私人层无关
const visibleRun = (accountId: string) =>
  sql`(${dreamRuns.scope} is null or not ${personalScope(sql`${dreamRuns.scope}`)}
    or ${dreamRuns.ownerAccountId} = ${accountId})`

// 一次整理在一个成员看来的结果：只看共享部分的汇总（范围为空的那一条）与他自己的画像层、私人层的记录，
// 别的成员的画像层与私人层整理了没有、出没出错、花了多久都不影响。有出错的就是出错，有整理过的（汇总说整理过了，
// 或者自己的范围整理过）就是整理过，否则是没整理，原因先取「没有要整理的」以外的；模型的输出解析不了的那一批
// 记了整理过（见 dreamScope），不算出错。汇总还没写下时为 null：共享的那一段还在整理，或者没写下汇总就停了
export async function dreamRunOutcome(
  db: Db,
  spaceId: string,
  runId: string,
  accountId: string,
): Promise<DreamOutcome | null> {
  const rows = await withSpace(db, spaceId, (tx) =>
    tx
      .select({ scope: dreamRuns.scope, skipped: dreamRuns.skipped, error: dreamRuns.error })
      .from(dreamRuns)
      .where(
        and(
          eq(dreamRuns.runId, runId),
          or(isNull(dreamRuns.scope), eq(dreamRuns.ownerAccountId, accountId)),
        ),
      ),
  )
  if (!rows.some((r) => r.scope === null)) return null
  if (rows.some((r) => r.error && r.error !== DREAM_PARSE_ERROR)) {
    return { outcome: 'failed', reason: null }
  }
  if (rows.some((r) => !r.skipped)) return { outcome: 'done', reason: null }
  const reasons = rows.map((r) => r.skipped as DreamSkipReason)
  return { outcome: 'skipped', reason: reasons.find((r) => r !== 'idle') ?? 'idle' }
}

// 最近几次整理，新的在前，每次列出查看者看得到的记录（见 visibleRun）。模型接口或数据库报的原文只给实例管理员看
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
