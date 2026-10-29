import {
  DEFAULT_RETENTION_DAYS,
  RetentionPauseReason,
  RetentionSettings,
  RetentionStatus,
  type RetentionCounts,
  type RetentionView,
} from '@kioku/contracts'
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import { withSpace, type Db, type Tx } from '../db/client'
import {
  accounts,
  credentialEvents,
  credentialProviders,
  credentials,
  extractionRuns,
  memories,
  memoryEvents,
  settings,
  spaces,
} from '../db/schema'
import { monthStart } from '../extraction/budget'

// 保留期：删掉的、被推翻的、过期的内容与它们的历史，过了保留天数由每天一次的清理硬删除，删了就找不回来。
// 天数与暂停存在实例设置的一项里；最近一次清理的结果单独存一项，清理任务记结果不会和管理员保存设置互相覆盖
const KEY = 'retention'
const STATUS_KEY = 'retention-status'
const DAY = 86_400_000
const MAX_MESSAGE = 500

// 一批最多处理多少行：每批一个短事务，不长时间锁着别人要写的行
export const RETENTION_BATCH = 500
// 一次清理最多做这么久，到了就不再开新批次，剩下的下一个小时接着做（清理任务一小时过期）
export const RETENTION_BUDGET_MS = 30 * 60_000

export interface RetentionPause {
  reason: RetentionPauseReason
  since: Date
}

export interface RetentionState {
  days: number
  // 暂停按天数的清理：从起点到起点加上保留天数
  pause: RetentionPause | null
  status: RetentionStatus
  // 实例上还没有任何保留期的状态（设置与清理结果都没有）：保留期第一次生效
  fresh: boolean
}

const EMPTY_STATUS: RetentionStatus = { lastRun: null, unfinished: null, lastError: null }

// 天数、暂停与最近一次清理的结果，一次查出。存的值缺了或认不出时按默认：30 天、没有暂停、还没清理过
export async function loadRetention(db: Db): Promise<RetentionState> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [KEY, STATUS_KEY]))
  const row = rows.find((r) => r.key === KEY)
  const stored = (row?.value ?? {}) as {
    days?: unknown
    pause?: { since?: unknown; reason?: unknown }
  }
  const days = RetentionSettings.shape.days.safeParse(stored.days)
  const reason = RetentionPauseReason.safeParse(stored.pause?.reason)
  const since = typeof stored.pause?.since === 'string' ? new Date(stored.pause.since) : null
  const status = RetentionStatus.safeParse(rows.find((r) => r.key === STATUS_KEY)?.value)
  return {
    days: days.success ? days.data : DEFAULT_RETENTION_DAYS,
    pause:
      reason.success && since && !Number.isNaN(since.getTime())
        ? { reason: reason.data, since }
        : null,
    status: status.success ? status.data : EMPTY_STATUS,
    fresh: rows.length === 0,
  }
}

// 还在暂停中的话，暂停到什么时候：起点加上现在的保留天数。这段时间里到期的都是起点之前删掉的，
// 等于给它们一个完整的保留期去找回。没有暂停、或者已经过了时为 null
export function activePause(
  state: Pick<RetentionState, 'days' | 'pause'>,
  now: Date,
): (RetentionPause & { until: Date }) | null {
  if (!state.pause) return null
  const until = new Date(state.pause.since.getTime() + state.days * DAY)
  return until > now ? { ...state.pause, until } : null
}

export async function retentionView(db: Db, now = new Date()): Promise<RetentionView> {
  const state = await loadRetention(db)
  const pause = activePause(state, now)
  return {
    days: state.days,
    pause: pause && {
      reason: pause.reason,
      since: pause.since.toISOString(),
      until: pause.until.toISOString(),
    },
    status: state.status,
  }
}

// ---- 设置里的天数与暂停 ----
// 存成 { days?, pause?: { since, reason } }。下面的 SQL 在语句里按存着的值判断暂停结束了没有，和别的写入同时发生也不会算错

const at = (d: Date) => sql`${d.toISOString()}::timestamptz`
// 存着的值不是对象时从头写
const stored = sql`(case when jsonb_typeof(${settings.value}) = 'object' then ${settings.value} else '{}'::jsonb end)`
const storedDays = sql`coalesce(case when jsonb_typeof(${stored} -> 'days') = 'number' then (${stored} ->> 'days')::int end, ${DEFAULT_RETENTION_DAYS}::int)`
// 按存着的天数，暂停已经结束。一天按 24 小时加（和 activePause 一样），不随数据库时区的夏令时变
const pauseEnded = (now: Date) =>
  sql`(${stored} ? 'pause' and (${stored} #>> '{pause,since}')::timestamptz + make_interval(hours => ${storedDays} * 24) <= ${at(now)})`
const pauseOf = (reason: RetentionPauseReason, since: Date) =>
  sql`jsonb_build_object('pause', jsonb_build_object('since', ${since.toISOString()}::text, 'reason', ${reason}::text))`
const hasStatus = sql`exists (select 1 from ${settings} where ${settings.key} = ${STATUS_KEY})`

// 只改天数。暂停不因此结束，结束时间跟着天数变（调大就是多留些时间找回）；按原来的天数已经结束的暂停在同一条语句里去掉，
// 免得调大天数又算出一段暂停。实例上还没有保留期的状态时，从现在起先暂停一个保留期（和第一次清理时一样）
export async function saveRetentionDays(
  db: Db,
  value: RetentionSettings,
  now = new Date(),
): Promise<void> {
  const days = sql`jsonb_build_object('days', ${value.days}::int)`
  await db
    .insert(settings)
    .values({
      key: KEY,
      value: sql`${days} || case when ${hasStatus} then '{}'::jsonb else ${pauseOf('started', now)} end`,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: sql`(case when ${pauseEnded(now)} then ${stored} - 'pause' else ${stored} end) || ${days}`,
        updatedAt: new Date(),
      },
    })
}

// 提前结束暂停
export async function resumeRetention(db: Db): Promise<void> {
  await db
    .update(settings)
    .set({ value: sql`${stored} - 'pause'`, updatedAt: new Date() })
    .where(eq(settings.key, KEY))
}

// 从备份恢复时在恢复的事务里调用：记下恢复的时间，按天数的清理暂停到它加上保留天数。上一个实例最近一次清理的结果清掉：
// 结果说的是那个实例做过什么，留着的话卡片上会显示这里没做过的一次，「今天做过没有」也会按那边的时间算。
// 返回暂停到什么时候
export async function markRestored(tx: Tx, now = new Date()): Promise<Date> {
  const [row] = await tx
    .insert(settings)
    .values({ key: KEY, value: pauseOf('restored', now) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: sql`${stored} || excluded.value`, updatedAt: new Date() },
    })
    .returning()
  await tx.delete(settings).where(eq(settings.key, STATUS_KEY))
  const days = RetentionSettings.shape.days.safeParse((row!.value as { days?: unknown }).days)
  return new Date(now.getTime() + (days.success ? days.data : DEFAULT_RETENTION_DAYS) * DAY)
}

// 保留期第一次生效：先暂停一个保留期，之前删掉的（到这个版本为止都还能撤销）有一个完整的保留期可以撤销删除。
// 已经有了设置（例如管理员刚保存了天数）时不动
async function startPause(db: Db, now: Date): Promise<void> {
  await db
    .insert(settings)
    .values({ key: KEY, value: pauseOf('started', now) })
    .onConflictDoNothing()
}

// 暂停已经结束（按存着的天数）时清掉，之后调大天数不会又算出一段暂停
async function clearEndedPause(db: Db, now: Date): Promise<void> {
  await db
    .update(settings)
    .set({ value: sql`${stored} - 'pause'`, updatedAt: new Date() })
    .where(and(eq(settings.key, KEY), pauseEnded(now)))
}

async function saveStatus(db: Db, value: RetentionStatus): Promise<void> {
  await db
    .insert(settings)
    .values({ key: STATUS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

// ---- 删什么 ----

// 到了保留期、要硬删除的都按这里判断，cutoff 是现在往前推保留天数。改这里要对照 retention.int.test.ts：
// 每一条都有到期的删掉、没到期的留着，以及不该删的那些
export function retentionRules(now: Date, days: number) {
  const cutoff = at(new Date(now.getTime() - days * DAY))
  return {
    // 已删除的记忆，不看删除时还有没有效、是哪种形态：让出 URI 时被软删除的已过期记录也算
    deletedMemories: lt(memories.deletedAt, cutoff),
    // 被新事实推翻的抽取事实。只看抽取的：策展记忆过了「有效到」、没有删除的一直留着，由人决定要不要重新生效
    supersededFacts: and(eq(memories.form, 'extracted'), lt(memories.validTo, cutoff))!,
    // 过期的会话摘要
    expiredSummaries: and(eq(memories.form, 'extracted'), lt(memories.expiresAt, cutoff))!,
    // 抽取记录。本月（UTC）的留着：抽取预算按本月抽取记录里的用量算
    extractionRuns: and(
      lt(extractionRuns.createdAt, cutoff),
      lt(extractionRuns.createdAt, monthStart(at(now))),
    )!,
    credentialEvents: lt(credentialEvents.createdAt, cutoff),
    deletedCredentials: lt(credentials.deletedAt, cutoff),
    // 已删除的凭据源：还有凭据指着它的留着，已删除、还在保留期里的凭据也算
    // （恢复之后要显示「凭据源已删除」，外键也不让删）
    deletedProviders: and(
      lt(credentialProviders.deletedAt, cutoff),
      sql`not exists (select 1 from ${credentials} where ${credentials.providerId} = ${credentialProviders.id})`,
    )!,
  }
}

type Rules = ReturnType<typeof retentionRules>

// 导入事件削成只剩写到的 URI：导入工具按导入事件去重，记忆整行不在了（memory_id 为空）也认得出
// 「导入过、后来删掉了」，不会再写回来；正文、disclosure 与关键词都不留
const IMPORT_TRACE = sql`case when ${memoryEvents.after} is null then null
  else jsonb_build_object('domain', ${memoryEvents.after} -> 'domain', 'path', ${memoryEvents.after} -> 'path') end`
// 已经削好的导入事件：除了 URI 什么都没留下。永久留着当去重记录，每天的清理不必再看它
const TRIMMED = sql`(${memoryEvents.before} is null and (${memoryEvents.after} is null or ${memoryEvents.after} - 'domain' - 'path' = '{}'::jsonb))`

// 记忆硬删除之后的历史：导入事件留下当作去重记录（memory_id 置空，快照只留 URI），别的事件都删掉。
// 返回删掉了几条、削了几条
async function dropHistory(tx: Tx, where: SQL): Promise<{ removed: number; trimmed: number }> {
  const trimmed = await tx
    .update(memoryEvents)
    .set({ memoryId: null, before: null, after: IMPORT_TRACE })
    .where(and(where, eq(memoryEvents.eventType, 'import')))
    .returning({ id: memoryEvents.id })
  const removed = await tx
    .delete(memoryEvents)
    .where(and(where, ne(memoryEvents.eventType, 'import')))
    .returning({ id: memoryEvents.id })
  return { removed: removed.length, trimmed: trimmed.length }
}

// 一批到期的记忆连同历史硬删除；向量、关键词、凭据引用、召回明细里的命中与累计统计随记忆级联删除。
// 正被别的事务锁着的（例如正在撤销删除）这次跳过、不等锁，下一次清理再看
async function memoryBatch(tx: Tx, where: SQL): Promise<number> {
  const rows = await tx
    .select({ id: memories.id })
    .from(memories)
    .where(where)
    .orderBy(asc(memories.id))
    .limit(RETENTION_BATCH)
    .for('update', { skipLocked: true })
  if (!rows.length) return 0
  const ids = rows.map((r) => r.id)
  await dropHistory(tx, inArray(memoryEvents.memoryId, ids))
  await tx.delete(memories).where(inArray(memories.id, ids))
  return ids.length
}

// 记忆整行已经不在的历史：删账号时数据库连带删掉他的画像层、私人层记忆，外键把事件的 memory_id 置空，
// 快照里的正文却留着。管理界面里看不到（历史与活动只列记忆还在的），和硬删除时一样处理
async function orphanBatch(tx: Tx) {
  const rows = await tx
    .select({ id: memoryEvents.id })
    .from(memoryEvents)
    .where(
      and(
        isNull(memoryEvents.memoryId),
        or(ne(memoryEvents.eventType, 'import'), sql`not ${TRIMMED}`),
      ),
    )
    .orderBy(asc(memoryEvents.id))
    .limit(RETENTION_BATCH)
  if (!rows.length) return { picked: 0, counts: {} }
  const { removed, trimmed } = await dropHistory(
    tx,
    inArray(
      memoryEvents.id,
      rows.map((r) => r.id),
    ),
  )
  return { picked: rows.length, counts: { orphanEvents: removed, scrubbedSnapshots: trimmed } }
}

// 快照在已经不在的账号的画像层或私人层：管理读取只给本人看，账号删了谁也看不到，里面却还有那个人写的正文
// （记忆还在：删账号之前移进了共享的层）。抹掉正文、disclosure 与关键词，事件和判断可见性的字段留着，
// 别人看得到的历史（包括「离开」的记录）不变。先按层过滤，再按 uuid 查账号（走主键）；主人不是 uuid 的也算不在
const UUID_TEXT = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
const TEXT_KEYS = sql`array['content', 'disclosure', 'glossary']`
const goneOwner = (snapshot: SQLWrapper) => {
  const owner = sql`(${snapshot} ->> 'ownerAccountId')`
  return sql`((${snapshot} ->> 'layer') in ('owner', 'private') and not exists (select 1 from ${accounts}
    where ${accounts.id} = case when ${owner} ~ ${UUID_TEXT} then ${owner}::uuid end))`
}
const scrubbed = (snapshot: SQLWrapper) =>
  sql`case when ${goneOwner(snapshot)} then ${snapshot} - ${TEXT_KEYS} else ${snapshot} end`

async function scrubBatch(tx: Tx): Promise<number> {
  const { before, after } = memoryEvents
  const rows = await tx
    .select({ id: memoryEvents.id })
    .from(memoryEvents)
    .where(
      and(
        isNotNull(memoryEvents.memoryId),
        or(
          and(sql`${before} ?| ${TEXT_KEYS}`, goneOwner(before)),
          and(sql`${after} ?| ${TEXT_KEYS}`, goneOwner(after)),
        ),
      ),
    )
    .orderBy(asc(memoryEvents.id))
    .limit(RETENTION_BATCH)
  if (!rows.length) return 0
  await tx
    .update(memoryEvents)
    .set({ before: scrubbed(before), after: scrubbed(after) })
    .where(
      inArray(
        memoryEvents.id,
        rows.map((r) => r.id),
      ),
    )
  return rows.length
}

// 一批到期的行按 id 删掉；正被别的事务锁着的跳过，下一次清理再看
async function tableBatch(tx: Tx, table: PgTable, id: PgColumn, where: SQL): Promise<number> {
  const gone = await tx.execute(sql`
    delete from ${table} where ${id} in (
      select ${id} from ${table} where ${where}
      order by ${id} limit ${RETENTION_BATCH} for update skip locked
    ) returning 1`)
  return gone.length
}

interface Step {
  label: string
  // 删账号留下的历史：谁都看不到，不用给谁时间找回，暂停期间也照常做
  always?: true
  // 一批：取到了几行（不满一批就是做完了），各类算多少
  batch: (tx: Tx, rules: Rules) => Promise<{ picked: number; counts: Partial<RetentionCounts> }>
}

const single =
  (kind: keyof RetentionCounts, run: (tx: Tx, rules: Rules) => Promise<number>): Step['batch'] =>
  async (tx, rules) => {
    const n = await run(tx, rules)
    return { picked: n, counts: { [kind]: n } }
  }

// 按这个顺序做：同时符合几类的记忆算在前面那一类；凭据在凭据源之前，同一次清理里删掉的凭据不再挡住它的凭据源
const STEPS: Step[] = [
  {
    label: '已删除的记忆',
    batch: single('deletedMemories', (tx, r) => memoryBatch(tx, r.deletedMemories)),
  },
  {
    label: '被推翻的事实',
    batch: single('supersededFacts', (tx, r) => memoryBatch(tx, r.supersededFacts)),
  },
  {
    label: '过期的会话摘要',
    batch: single('expiredSummaries', (tx, r) => memoryBatch(tx, r.expiredSummaries)),
  },
  { label: '记忆已经不在的历史', always: true, batch: (tx) => orphanBatch(tx) },
  {
    label: '已删账号的历史快照',
    always: true,
    batch: single('scrubbedSnapshots', (tx) => scrubBatch(tx)),
  },
  {
    label: '抽取记录',
    batch: single('extractionRuns', (tx, r) =>
      tableBatch(tx, extractionRuns, extractionRuns.id, r.extractionRuns),
    ),
  },
  {
    label: '凭据事件',
    batch: single('credentialEvents', (tx, r) =>
      tableBatch(tx, credentialEvents, credentialEvents.id, r.credentialEvents),
    ),
  },
  {
    label: '已删除的凭据',
    // 凭据的事件随凭据级联删除
    batch: single('deletedCredentials', (tx, r) =>
      tableBatch(tx, credentials, credentials.id, r.deletedCredentials),
    ),
  },
  {
    label: '已删除的凭据源',
    batch: single('deletedProviders', (tx, r) =>
      tableBatch(tx, credentialProviders, credentialProviders.id, r.deletedProviders),
    ),
  },
]

const emptyCounts = (): RetentionCounts => ({
  deletedMemories: 0,
  supersededFacts: 0,
  expiredSummaries: 0,
  orphanEvents: 0,
  scrubbedSnapshots: 0,
  extractionRuns: 0,
  credentialEvents: 0,
  deletedCredentials: 0,
  deletedProviders: 0,
})

function addCounts(into: RetentionCounts, more: Partial<RetentionCounts>): RetentionCounts {
  for (const [kind, n] of Object.entries(more)) into[kind as keyof RetentionCounts] += n
  return into
}

export interface PurgeResult {
  counts: RetentionCounts
  // 没删成的那几类与原因
  errors: string[]
  // 做完了：时间没用完、每一类都删到了没有剩下的（出错的那几类不算做完）
  complete: boolean
}

// 按保留期硬删除：逐个空间、一类一类分批，每批一个短事务（内容表开了 RLS，只能在 withSpace 里访问）。
// paused 时只做删账号留下的历史。一类出了错记下原因，接着做别的类与别的空间。
// 到了 deadline 就不再开新批次（第一批总会做，每次至少往前走一点）
export async function purgeExpired(
  db: Db,
  options: { days: number; now: Date; paused?: boolean; deadline?: number },
): Promise<PurgeResult> {
  const rules = retentionRules(options.now, options.days)
  const steps = options.paused ? STEPS.filter((s) => s.always) : STEPS
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY
  const counts = emptyCounts()
  const errors: string[] = []
  let started = false
  const timeUp = () => started && Date.now() >= deadline
  for (const { id: spaceId } of await db.select({ id: spaces.id }).from(spaces)) {
    for (const step of steps) {
      try {
        for (;;) {
          if (timeUp()) return { counts, errors, complete: false }
          started = true
          const done = await withSpace(db, spaceId, (tx) => step.batch(tx, rules))
          addCounts(counts, done.counts)
          if (done.picked < RETENTION_BATCH) break
        }
      } catch (err) {
        errors.push(`${step.label}：${messageOf(err)}`)
      }
    }
  }
  return { counts, errors, complete: errors.length === 0 }
}

// 数据库报的错由 drizzle 包在 cause 里，外层的消息是整条 SQL 与参数，记下里面那层
function messageOf(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause
  if (cause instanceof Error) return cause.message
  return err instanceof Error ? err.message : String(err)
}

const errorRecord = (messages: string[]) => ({
  message: (messages.length > 1
    ? `${messages[0]}（另有 ${messages.length - 1} 处出错）`
    : messages[0]!
  ).slice(0, MAX_MESSAGE),
  at: new Date().toISOString(),
})

export interface RetentionRun extends PurgeResult {
  // 这次在暂停中，只做了删账号留下的历史
  paused: boolean
}

// 每小时的定时清理里调用，保留期的清理一天（UTC）做一次：今天做完过的不做（暂停中做完的那次不挡住暂停结束之后当天的完整清理）。
// 实例上还没有保留期的状态时先暂停一个保留期；暂停已经结束的清掉。暂停期间只做删账号留下的历史。
// 时间用完或者有一类出错时不记做完，删掉的条数先记在「还没做完」里，下一个小时接着做；错误记在设置里给实例管理员看，不抛出。
// 没做时返回 null
export async function retentionJob(
  db: Db,
  now = new Date(),
  budgetMs = RETENTION_BUDGET_MS,
): Promise<RetentionRun | null> {
  let state = await loadRetention(db)
  if (state.fresh) {
    await startPause(db, now)
    state = await loadRetention(db)
  } else if (state.pause && !activePause(state, now)) {
    await clearEndedPause(db, now)
    state = await loadRetention(db)
  }
  const paused = activePause(state, now) !== null
  const last = state.status.lastRun
  if (last && last.at.slice(0, 10) === now.toISOString().slice(0, 10) && (paused || !last.paused)) {
    return null
  }
  let result: PurgeResult
  try {
    result = await purgeExpired(db, {
      days: state.days,
      now,
      paused,
      deadline: Date.now() + budgetMs,
    })
  } catch (err) {
    await saveStatus(db, { ...state.status, lastError: errorRecord([messageOf(err)]) })
    return null
  }
  const carried = state.status.unfinished
  const counts = addCounts(carried ? { ...carried.counts } : emptyCounts(), result.counts)
  await saveStatus(
    db,
    result.complete
      ? {
          lastRun: { at: now.toISOString(), days: state.days, paused, counts },
          unfinished: null,
          lastError: null,
        }
      : {
          lastRun: state.status.lastRun,
          unfinished: { since: carried?.since ?? now.toISOString(), counts },
          lastError: result.errors.length ? errorRecord(result.errors) : state.status.lastError,
        },
  )
  return { ...result, paused }
}
