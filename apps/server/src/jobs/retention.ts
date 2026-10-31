import {
  DEFAULT_RETENTION_DAYS,
  RETENTION_DAILY_TRIES,
  RetentionPauseReason,
  RetentionSettings,
  RetentionStatus,
  type DeletionRetention,
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
  not,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import { errorText, withSpace, type Db, type Tx } from '../db/client'
import {
  accounts,
  credentialEvents,
  credentialProviders,
  credentials,
  dreamRuns,
  dreamSuggestions,
  extractionRuns,
  memories,
  memoryEvents,
  settings,
  spaces,
  subjectBindings,
} from '../db/schema'
import { monthStart } from '../extraction/budget'
import { suggestionCurrent } from '../memory/service'

// 保留期：删掉的、被推翻的、过期的内容与它们的历史，过了保留天数由每天一次的清理硬删除，删了就找不回来。
// 天数与暂停存在实例设置的一项里；最近一次清理的结果单独存一项，清理任务记结果不会和管理员保存设置互相覆盖
const KEY = 'retention'
const STATUS_KEY = 'retention-status'
// 改天数与暂停时在事务里拿这把咨询锁：设置那一行还不存在（第一次生效）时也串得起来，读出、算好、写回之间不会插进别的写入
const LOCK = 'kioku.retention'
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
  // 设置里存着的天数；没存过（按默认）时为 null，写回时不替它记下默认值
  storedDays: number | null
  // 暂停按天数的清理：从起点到起点加上保留天数
  pause: RetentionPause | null
  status: RetentionStatus
  // 实例上还没有任何保留期的状态（设置与清理结果都没有）
  fresh: boolean
}

const EMPTY_STATUS: RetentionStatus = { lastRun: null, lastAttempt: null, lastError: null }

const readRows = (db: Db | Tx) =>
  db
    .select()
    .from(settings)
    .where(inArray(settings.key, [KEY, STATUS_KEY]))

// 天数、暂停与最近一次清理的结果，读和改都按这一套解析。存的值缺了或认不出（例如手改过）时按默认：
// 30 天、没有暂停、还没清理过
function parseRetention(rows: { key: string; value: unknown }[]): RetentionState {
  const record = (value: unknown) =>
    (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const stored = record(rows.find((r) => r.key === KEY)?.value)
  const days = RetentionSettings.shape.days.safeParse(stored.days)
  const pause = record(stored.pause)
  const reason = RetentionPauseReason.safeParse(pause.reason)
  const since = typeof pause.since === 'string' ? new Date(pause.since) : null
  const status = RetentionStatus.safeParse(rows.find((r) => r.key === STATUS_KEY)?.value)
  return {
    days: days.success ? days.data : DEFAULT_RETENTION_DAYS,
    storedDays: days.success ? days.data : null,
    pause:
      reason.success && since && !Number.isNaN(since.getTime())
        ? { reason: reason.data, since }
        : null,
    status: status.success ? status.data : EMPTY_STATUS,
    fresh: rows.length === 0,
  }
}

export async function loadRetention(db: Db): Promise<RetentionState> {
  return parseRetention(await readRows(db))
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

type StoredSettings = { days?: number; pause?: { since: string; reason: RetentionPauseReason } }

// 写进设置的值：存过的天数与暂停。暂停的 JSON 只在这里拼
function storedValue(days: number | null, pause: RetentionPause | null): StoredSettings {
  return {
    ...(days === null ? {} : { days }),
    ...(pause ? { pause: { since: pause.since.toISOString(), reason: pause.reason } } : {}),
  }
}

// 保留期第一次生效（实例上还没有保留期的设置与清理结果）：第一次清理、第一次保存天数都从这时起先暂停一个保留期，
// 之前删掉的（到这个版本为止都还能撤销）有一个完整的保留期可以撤销删除。不是第一次时为 null
function firstPause(state: RetentionState, now: Date): RetentionPause | null {
  return state.fresh ? { reason: 'started', since: now } : null
}

// 已删除列表上的提示，按实例设置里看到的保留期（retentionView）算。保留天数与是不是在暂停给所有成员：
// 删掉的还能撤销多久不该只有管理员知道，暂停期间也不该让人以为马上就要清除。暂停到什么时候只给实例管理员：
// 减去天数就是实例从备份恢复的时间，和保留期的设置一样不给别人看
export function deletionRetention(view: RetentionView, admin: boolean): DeletionRetention {
  return {
    days: view.days,
    paused: view.pause !== null,
    pausedUntil: admin ? (view.pause?.until ?? null) : null,
  }
}

// 会被永久清除的列表（已删除的记忆、凭据与凭据源，已过期里让出了 URI 的记忆）带上 deletionRetention，
// 和列表本身、「是不是实例管理员」一起读出
export async function withDeletionRetention<T extends object>(
  db: Db,
  list: Promise<T>,
  admin: Promise<boolean>,
): Promise<T & { retention: DeletionRetention }> {
  const [page, isAdmin, view] = await Promise.all([list, admin, retentionView(db)])
  return { ...page, retention: deletionRetention(view, isAdmin) }
}

// 改天数与暂停：在事务里拿住锁，按 parseRetention 读出现在的状态，算出新的值整个写回（change 返回 null 时不改）。
// 返回改完之后的状态
async function changeSettings(
  db: Db | Tx,
  change: (state: RetentionState) => StoredSettings | null,
): Promise<RetentionState> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LOCK}))`)
    const state = parseRetention(await readRows(tx))
    const next = change(state)
    if (!next) return state
    await tx
      .insert(settings)
      .values({ key: KEY, value: next })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
    return parseRetention(await readRows(tx))
  })
}

// 只改天数。暂停不因此结束，结束时间跟着天数变（调大就是多留些时间找回）；按原来的天数已经结束的暂停一并去掉，
// 免得调大天数又算出一段暂停。保留期第一次生效时从现在起先暂停一个保留期
export async function saveRetentionDays(
  db: Db,
  value: RetentionSettings,
  now = new Date(),
): Promise<void> {
  await changeSettings(db, (state) => {
    const ongoing = activePause(state, now) ? state.pause : null
    return storedValue(value.days, firstPause(state, now) ?? ongoing)
  })
}

// 结束暂停：给了 endedBy 时只去掉到那时已经结束了的（定时清理时），不给时提前结束（管理员点了「现在开始清理」）。
// 返回之后的状态
export async function endPause(db: Db, endedBy?: Date): Promise<RetentionState> {
  return changeSettings(db, (state) =>
    state.pause && !(endedBy && activePause(state, endedBy))
      ? storedValue(state.storedDays, null)
      : null,
  )
}

// 保留期第一次生效时从现在起先暂停一个保留期（见 firstPause）
async function startIfFirst(db: Db, now: Date): Promise<void> {
  await changeSettings(db, (state) => {
    const pause = firstPause(state, now)
    return pause && storedValue(state.storedDays, pause)
  })
}

// 从备份恢复时在恢复的事务里调用：记下恢复的时间，按天数的清理暂停到它加上保留天数。上一个实例最近一次清理的结果清掉：
// 结果说的是那个实例做过什么，留着的话卡片上会显示这里没做过的一次，「今天做过没有」也会按那边的时间算。
// 返回暂停到什么时候
export async function markRestored(tx: Tx, now = new Date()): Promise<Date> {
  const state = await changeSettings(tx, (s) =>
    storedValue(s.storedDays, { reason: 'restored', since: now }),
  )
  await tx.delete(settings).where(eq(settings.key, STATUS_KEY))
  return new Date(now.getTime() + state.days * DAY)
}

async function saveStatus(db: Db, value: RetentionStatus): Promise<void> {
  await db
    .insert(settings)
    .values({ key: STATUS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}

const at = (d: Date) => sql`${d.toISOString()}::timestamptz`

// ---- 删什么 ----

// 指着这个凭据源的凭据，已删除的也算
const PROVIDER_CREDENTIALS = sql`from ${credentials} where ${credentials.providerId} = ${credentialProviders.id}`

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
    // Dream 的运行记录：和抽取记录一样，本月的留着（用量计入同一份预算）
    dreamRuns: and(lt(dreamRuns.createdAt, cutoff), lt(dreamRuns.createdAt, monthStart(at(now))))!,
    // Dream 的建议：处理之后（没处理的从提出时算）过了保留期，并且已经作废的——涉及的记忆有一条改过（版本不对）、
    // 删掉、过期或者不在了。还作数的留着：拒绝过的指纹靠它们挡住同样的建议，没处理的还在待审里等着
    dreamSuggestions: and(
      lt(sql`coalesce(${dreamSuggestions.decidedAt}, ${dreamSuggestions.createdAt})`, cutoff),
      not(suggestionCurrent(dreamSuggestions.memoryIds, dreamSuggestions.versions, { at: now })),
    )!,
    credentialEvents: lt(credentialEvents.createdAt, cutoff),
    deletedCredentials: lt(credentials.deletedAt, cutoff),
    // 已删除的凭据源：还有凭据指着它的留着，已删除、还在保留期里的凭据也算
    // （恢复之后要显示「凭据源已删除」，外键也不让删）
    deletedProviders: and(
      lt(credentialProviders.deletedAt, cutoff),
      sql`not exists (select 1 ${PROVIDER_CREDENTIALS})`,
    )!,
    // 处理完的绑定记录：合并、确认、拒绝或作废的按处理的时间，过了确认期限没处理的按期限。还在等确认的不删
    subjectBindings: lt(
      sql`coalesce(${subjectBindings.decidedAt}, ${subjectBindings.expiresAt})`,
      cutoff,
    ),
  }
}

type Rules = ReturnType<typeof retentionRules>

// 已删除的凭据源从什么时候起算保留期，照 retentionRules 的两条：每次清理先删到期的凭据（STEPS 里凭据在凭据源之前），
// 再删没有凭据指着的凭据源。所以只有已删除的凭据指着它时，等其中最晚删除的那条到期之后一起清除，取它和自己的删除时间里晚的；
// 还有没删除的凭据指着它时（凭据恢复之后没改绑）为 null，改绑或删掉那些凭据之前不会清除。凭据页的已删除列表按它算还剩几天，
// 是 timestamptz，取出来时按凭据源的 deletedAt 列转换。每次给一个新的 SQL 对象：mapWith 改的是对象本身
export const providerRetentionFrom = () => sql`(case
  when exists (select 1 ${PROVIDER_CREDENTIALS} and ${credentials.deletedAt} is null) then null
  else greatest(${credentialProviders.deletedAt}, (select max(${credentials.deletedAt}) ${PROVIDER_CREDENTIALS}))
end)`

// Lore 导入工具写下的导入事件（context 里的出处 source 是 lore）：它按这些事件去重（见 importer/lore.ts），
// 记忆硬删除之后也要留下。别的导入事件没人拿来去重（例如按空间导入的，出处是 space-export），
// 和普通事件一样删掉：留着只会一直攒下去，私人层的 URI 也一直留在库里。没有出处的也不算，条件不会是 NULL
const LORE_IMPORT = sql`(${memoryEvents.eventType} = 'import' and coalesce(${memoryEvents.context} ->> 'source', '') = 'lore')`
// Lore 的导入事件削成只剩写到的 URI：记忆整行不在了（memory_id 为空）导入工具也认得出
// 「导入过、后来删掉了」，不会再写回来；正文、disclosure 与关键词都不留
const IMPORT_TRACE = sql`case when ${memoryEvents.after} is null then null
  else jsonb_build_object('domain', ${memoryEvents.after} -> 'domain', 'path', ${memoryEvents.after} -> 'path') end`
// 已经削好的导入事件：除了 URI 什么都没留下。Lore 的永久留着当去重记录，每天的清理不必再看它
const TRIMMED = sql`(${memoryEvents.before} is null and (${memoryEvents.after} is null or ${memoryEvents.after} - 'domain' - 'path' = '{}'::jsonb))`

// 记忆硬删除之后的历史：Lore 的导入事件留下当作去重记录（memory_id 置空，快照只留 URI），别的事件都删掉。
// 返回删掉了几条、削了几条
async function dropHistory(tx: Tx, where: SQL): Promise<{ removed: number; trimmed: number }> {
  const trimmed = await tx
    .update(memoryEvents)
    .set({ memoryId: null, before: null, after: IMPORT_TRACE })
    .where(and(where, LORE_IMPORT))
    .returning({ id: memoryEvents.id })
  const removed = await tx
    .delete(memoryEvents)
    .where(and(where, sql`not ${LORE_IMPORT}`))
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
// 快照里的正文却留着。管理界面里看不到（历史与活动只列记忆还在的），和硬删除时一样处理。
// 只跳过已经削好的 Lore 导入事件；别的导入事件削好了也删（之前的清理把它们也削成了 URI 留着）
async function orphanBatch(tx: Tx) {
  const rows = await tx
    .select({ id: memoryEvents.id })
    .from(memoryEvents)
    .where(and(isNull(memoryEvents.memoryId), sql`not (${LORE_IMPORT} and ${TRIMMED})`))
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
    label: 'Dream 的运行记录',
    batch: single('dreamRuns', (tx, r) => tableBatch(tx, dreamRuns, dreamRuns.id, r.dreamRuns)),
  },
  {
    label: 'Dream 的建议',
    batch: single('dreamSuggestions', (tx, r) =>
      tableBatch(tx, dreamSuggestions, dreamSuggestions.id, r.dreamSuggestions),
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
  {
    label: '处理完的绑定记录',
    batch: single('subjectBindings', (tx, r) =>
      tableBatch(tx, subjectBindings, subjectBindings.id, r.subjectBindings),
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
  dreamRuns: 0,
  dreamSuggestions: 0,
  credentialEvents: 0,
  deletedCredentials: 0,
  deletedProviders: 0,
  subjectBindings: 0,
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
        errors.push(`${step.label}：${errorText(err)}`)
      }
    }
  }
  return { counts, errors, complete: errors.length === 0 }
}

const errorRecord = (messages: string[]) => ({
  message: (messages.length > 1
    ? `${messages[0]}（另有 ${messages.length - 1} 处出错）`
    : messages[0]!
  ).slice(0, MAX_MESSAGE),
  at: new Date().toISOString(),
})

const utcDay = (iso: string) => iso.slice(0, 10)

export interface RetentionRun extends PurgeResult {
  // 这次在暂停中，只做了删账号留下的历史
  paused: boolean
}

// 每小时的定时清理里调用，保留期的清理一天（UTC）做一次。保留期第一次生效时先暂停一个保留期；暂停已经结束的去掉；
// 暂停期间只做删账号留下的历史。今天已经完整做完的不做（暂停中做完的那次不挡住暂停结束、提前开始之后当天的完整清理）；
// 没做完（有一类出错，或者到了时间）时下一个小时再试，同一天同一种最多试 RETENTION_DAILY_TRIES 次，第二天再来。
// 每次尝试只记它自己做了什么；全部做完才记成最近一次完整的清理。错误记在设置里给实例管理员看，不抛出。没做时返回 null
export async function retentionJob(
  db: Db,
  now = new Date(),
  budgetMs = RETENTION_BUDGET_MS,
): Promise<RetentionRun | null> {
  await startIfFirst(db, now)
  const state = await endPause(db, now)
  const paused = activePause(state, now) !== null
  const today = utcDay(now.toISOString())
  const { lastRun, lastAttempt } = state.status
  if (lastRun && utcDay(lastRun.at) === today && (paused || !lastRun.paused)) return null
  const tries =
    lastAttempt &&
    !lastAttempt.complete &&
    lastAttempt.paused === paused &&
    utcDay(lastAttempt.at) === today
      ? lastAttempt.tries
      : 0
  if (tries >= RETENTION_DAILY_TRIES) return null

  let result: PurgeResult
  try {
    result = await purgeExpired(db, {
      days: state.days,
      now,
      paused,
      deadline: Date.now() + budgetMs,
    })
  } catch (err) {
    // 整次都没做成（例如读不出空间）：和有一类出错一样算一次没做完的尝试
    result = { counts: emptyCounts(), errors: [errorText(err)], complete: false }
  }
  const startedAt = now.toISOString()
  await saveStatus(db, {
    lastRun: result.complete
      ? { at: startedAt, days: state.days, paused, counts: result.counts }
      : lastRun,
    lastAttempt: {
      at: startedAt,
      paused,
      complete: result.complete,
      counts: result.counts,
      tries: tries + 1,
    },
    lastError: result.errors.length
      ? errorRecord(result.errors)
      : result.complete
        ? null
        : state.status.lastError,
  })
  return { ...result, paused }
}
