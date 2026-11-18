import {
  DEFAULT_RETENTION_DAYS,
  DEPARTURE_RETENTION_DAYS,
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

import { databaseNow, errorText, withCircle, type Db, type Tx } from '../db/client'
import {
  accounts,
  circleDepartures,
  circleMembers,
  circles,
  conversations,
  conversationTurns,
  credentialEvents,
  credentials,
  dreamRuns,
  dreamSuggestions,
  entries,
  entryEvents,
  extractionRuns,
  recallEvents,
  settings,
  subjectBindings,
  subjects,
  vaultConnections,
} from '../db/schema'
import { monthStart } from '../extraction/budget'
import { ACCESS_EVENT, suggestionCurrent } from '../memory/service'
import { dropRecallEvents } from '../recall/retention'

// 保留期：删掉的、被推翻的、过期的内容与它们的历史，过了保留天数由每天一次的清理硬删除，删了就找不回来。
// 天数与暂停存在实例设置的一项里；最近一次清理的结果单独存一项，清理任务记结果不会和管理员保存设置互相覆盖
const KEY = 'retention'
const STATUS_KEY = 'retention-status'
const LOCK = 'kioku.retention'
const DAY = 86_400_000
const MAX_MESSAGE = 500

export const RETENTION_BATCH = 500
export const RETENTION_BUDGET_MS = 30 * 60_000

export interface RetentionPause {
  reason: RetentionPauseReason
  since: Date
}

export interface RetentionState {
  days: number
  storedDays: number | null
  pause: RetentionPause | null
  status: RetentionStatus
  fresh: boolean
}

const EMPTY_STATUS: RetentionStatus = { lastRun: null, lastAttempt: null, lastError: null }

const readRows = (db: Db | Tx) =>
  db
    .select()
    .from(settings)
    .where(inArray(settings.key, [KEY, STATUS_KEY]))

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

export function activePause(
  state: Pick<RetentionState, 'days' | 'pause'>,
  now: Date,
): (RetentionPause & { until: Date }) | null {
  if (!state.pause) return null
  const until = new Date(state.pause.since.getTime() + state.days * DAY)
  return until > now ? { ...state.pause, until } : null
}

export async function retentionView(db: Db, at?: Date): Promise<RetentionView> {
  const [state, now] = await Promise.all([loadRetention(db), at ?? databaseNow(db)])
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

type StoredSettings = { days?: number; pause?: { since: string; reason: RetentionPauseReason } }

function storedValue(days: number | null, pause: RetentionPause | null): StoredSettings {
  return {
    ...(days === null ? {} : { days }),
    ...(pause ? { pause: { since: pause.since.toISOString(), reason: pause.reason } } : {}),
  }
}

function firstPause(state: RetentionState, now: Date): RetentionPause | null {
  return state.fresh ? { reason: 'started', since: now } : null
}

export function deletionRetention(view: RetentionView, admin: boolean): DeletionRetention {
  return {
    days: view.days,
    paused: view.pause !== null,
    pausedUntil: admin ? (view.pause?.until ?? null) : null,
  }
}

export async function withDeletionRetention<T extends object>(
  db: Db,
  list: Promise<T>,
  admin: Promise<boolean>,
): Promise<T & { retention: DeletionRetention }> {
  const [page, isAdmin, view] = await Promise.all([list, admin, retentionView(db)])
  return { ...page, retention: deletionRetention(view, isAdmin) }
}

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

export async function saveRetentionDays(
  db: Db,
  value: RetentionSettings,
  at?: Date,
): Promise<void> {
  const now = at ?? (await databaseNow(db))
  await changeSettings(db, (state) => {
    const ongoing = activePause(state, now) ? state.pause : null
    return storedValue(value.days, firstPause(state, now) ?? ongoing)
  })
}

export async function endPause(db: Db, endedBy?: Date): Promise<RetentionState> {
  return changeSettings(db, (state) =>
    state.pause && !(endedBy && activePause(state, endedBy))
      ? storedValue(state.storedDays, null)
      : null,
  )
}

async function startIfFirst(db: Db, now: Date): Promise<void> {
  await changeSettings(db, (state) => {
    const pause = firstPause(state, now)
    return pause && storedValue(state.storedDays, pause)
  })
}

export async function markRestored(tx: Tx, at?: Date): Promise<Date> {
  const now = at ?? (await databaseNow(tx))
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

export function retentionRules(now: Date, days: number) {
  const cutoff = at(new Date(now.getTime() - days * DAY))
  return {
    deletedEntries: lt(entries.deletedAt, cutoff),
    supersededFacts: and(eq(entries.kind, 'fact'), lt(entries.validTo, cutoff))!,
    expiredEpisodes: and(eq(entries.kind, 'episode'), lt(entries.expiresAt, cutoff))!,
    extractionRuns: and(
      lt(extractionRuns.createdAt, cutoff),
      lt(extractionRuns.createdAt, monthStart(at(now))),
    )!,
    dreamRuns: and(lt(dreamRuns.createdAt, cutoff), lt(dreamRuns.createdAt, monthStart(at(now))))!,
    dreamSuggestions: and(
      lt(sql`coalesce(${dreamSuggestions.decidedAt}, ${dreamSuggestions.createdAt})`, cutoff),
      not(suggestionCurrent(dreamSuggestions.entryIds, dreamSuggestions.versions, { at: now })),
    )!,
    credentialEvents: lt(credentialEvents.createdAt, cutoff),
    accessEvents: and(eq(entryEvents.eventType, ACCESS_EVENT), lt(entryEvents.createdAt, cutoff))!,
    deletedCredentials: lt(credentials.deletedAt, cutoff),
    vaultConnections: and(
      lt(vaultConnections.disconnectedAt, cutoff),
      sql`not exists (select 1 from ${credentials} where ${credentials.vaultConnectionId} = ${vaultConnections.id})`,
    )!,
    subjectBindings: lt(
      sql`coalesce(${subjectBindings.decidedAt}, ${subjectBindings.expiresAt})`,
      cutoff,
    ),
    departedMembers: and(
      or(
        isNotNull(circleDepartures.purgeStartedAt),
        lt(circleDepartures.leftAt, at(new Date(now.getTime() - DEPARTURE_RETENTION_DAYS * DAY))),
      ),
      sql`not exists (select 1 from ${circleMembers}
        where ${circleMembers.circleId} = ${circleDepartures.circleId}
          and ${circleMembers.accountId} = ${circleDepartures.accountId})`,
    )!,
  }
}

type Rules = ReturnType<typeof retentionRules>

const LORE_IMPORT = sql`(${entryEvents.eventType} = 'import' and coalesce(${entryEvents.context} ->> 'source', '') = 'lore')`
const IMPORT_TRACE = sql`case when ${entryEvents.after} is null then null
  else jsonb_build_object('legacyUri', ${entryEvents.after} -> 'legacyUri') end`
const TRIMMED = sql`(${entryEvents.before} is null and (${entryEvents.after} is null or ${entryEvents.after} - 'legacyUri' = '{}'::jsonb))`

async function dropHistory(tx: Tx, where: SQL): Promise<{ removed: number; trimmed: number }> {
  const trimmed = await tx
    .update(entryEvents)
    .set({ entryId: null, before: null, after: IMPORT_TRACE })
    .where(and(where, LORE_IMPORT))
    .returning({ id: entryEvents.id })
  const removed = await tx
    .delete(entryEvents)
    .where(and(where, sql`not ${LORE_IMPORT}`))
    .returning({ id: entryEvents.id })
  return { removed: removed.length, trimmed: trimmed.length }
}

async function entryBatch(tx: Tx, where: SQL): Promise<number> {
  const rows = await tx
    .select({ id: entries.id })
    .from(entries)
    .where(where)
    .orderBy(asc(entries.id))
    .limit(RETENTION_BATCH)
    .for('update', { skipLocked: true })
  if (!rows.length) return 0
  const ids = rows.map((r) => r.id)
  await dropHistory(tx, inArray(entryEvents.entryId, ids))
  await tx.delete(entries).where(inArray(entries.id, ids))
  return ids.length
}

async function orphanBatch(tx: Tx) {
  const rows = await tx
    .select({ id: entryEvents.id })
    .from(entryEvents)
    .where(and(isNull(entryEvents.entryId), sql`not (${LORE_IMPORT} and ${TRIMMED})`))
    .orderBy(asc(entryEvents.id))
    .limit(RETENTION_BATCH)
  if (!rows.length) return { picked: 0, counts: {} }
  const { removed, trimmed } = await dropHistory(
    tx,
    inArray(
      entryEvents.id,
      rows.map((r) => r.id),
    ),
  )
  return { picked: rows.length, counts: { orphanEvents: removed, scrubbedSnapshots: trimmed } }
}

const UUID_TEXT = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
const TEXT_KEYS = sql`array['variants', 'content', 'title', 'disclosure', 'glossary', 'topics']`
const goneOwner = (snapshot: SQLWrapper) => {
  const owner = sql`(${snapshot} ->> 'ownerAccountId')`
  return sql`(${owner} is not null and not exists (select 1 from ${accounts}
    where ${accounts.id} = case when ${owner} ~ ${UUID_TEXT} then ${owner}::uuid end))`
}
const scrubbed = (snapshot: SQLWrapper) =>
  sql`case when ${goneOwner(snapshot)} then ${snapshot} - ${TEXT_KEYS} else ${snapshot} end`

const ownedBy = (snapshot: SQLWrapper, owner: string) =>
  sql`(${snapshot} ->> 'ownerAccountId') = ${owner}`
const scrubbedFor = (snapshot: SQLWrapper, owner: string) =>
  sql`case when ${ownedBy(snapshot, owner)} then ${snapshot} - ${TEXT_KEYS} else ${snapshot} end`

async function scrubBatch(tx: Tx): Promise<number> {
  const { before, after } = entryEvents
  const rows = await tx
    .select({ id: entryEvents.id })
    .from(entryEvents)
    .where(
      and(
        isNotNull(entryEvents.entryId),
        or(
          and(sql`${before} ?| ${TEXT_KEYS}`, goneOwner(before)),
          and(sql`${after} ?| ${TEXT_KEYS}`, goneOwner(after)),
        ),
      ),
    )
    .orderBy(asc(entryEvents.id))
    .limit(RETENTION_BATCH)
  if (!rows.length) return 0
  await tx
    .update(entryEvents)
    .set({ before: scrubbed(before), after: scrubbed(after) })
    .where(
      inArray(
        entryEvents.id,
        rows.map((r) => r.id),
      ),
    )
  return rows.length
}

async function tableBatch(tx: Tx, table: PgTable, id: PgColumn, where: SQL): Promise<number> {
  const gone = await tx.execute(sql`
    delete from ${table} where ${id} in (
      select ${id} from ${table} where ${where}
      order by ${id} limit ${RETENTION_BATCH} for update skip locked
    ) returning 1`)
  return gone.length
}

async function departureBatch(
  tx: Tx,
  rules: Rules,
  circleId: string,
): Promise<{ picked: number; counts: Partial<RetentionCounts> }> {
  const [departure] = await tx
    .select({ accountId: circleDepartures.accountId, started: circleDepartures.purgeStartedAt })
    .from(circleDepartures)
    .where(and(eq(circleDepartures.circleId, circleId), rules.departedMembers))
    .orderBy(asc(circleDepartures.accountId))
    .limit(1)
    .for('update', { skipLocked: true })
  if (!departure) return { picked: 0, counts: {} }
  const owner = departure.accountId
  const ofDeparture = and(
    eq(circleDepartures.circleId, circleId),
    eq(circleDepartures.accountId, owner),
  )
  if (!departure.started) {
    await tx
      .update(circleDepartures)
      .set({ purgeStartedAt: sql`now()` })
      .where(ofDeparture)
  }
  await dropRecallEvents(tx, eq(recallEvents.ownerAccountId, owner))
  const removed = await entryBatch(tx, eq(entries.ownerAccountId, owner))
  const [left] = await tx
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.ownerAccountId, owner))
    .limit(1)
  const entryCounts = { deletedEntries: removed }
  if (left) return { picked: removed, counts: entryCounts }
  await tx.delete(conversationTurns).where(eq(conversationTurns.ownerAccountId, owner))
  await tx.delete(conversations).where(eq(conversations.ownerAccountId, owner))
  await tx.delete(dreamSuggestions).where(eq(dreamSuggestions.ownerAccountId, owner))
  await tx.delete(credentials).where(eq(credentials.ownerAccountId, owner))
  await tx.delete(vaultConnections).where(eq(vaultConnections.ownerAccountId, owner))
  const { before, after } = entryEvents
  const trimmed = await tx
    .update(entryEvents)
    .set({ before: scrubbedFor(before, owner), after: scrubbedFor(after, owner) })
    .where(
      or(
        and(sql`${before} ?| ${TEXT_KEYS}`, ownedBy(before, owner)),
        and(sql`${after} ?| ${TEXT_KEYS}`, ownedBy(after, owner)),
      ),
    )
    .returning({ id: entryEvents.id })
  await tx.update(subjects).set({ accountId: null }).where(eq(subjects.accountId, owner))
  await tx.delete(circleDepartures).where(ofDeparture)
  return {
    picked: RETENTION_BATCH,
    counts: { ...entryCounts, scrubbedSnapshots: trimmed.length, departedMembers: 1 },
  }
}

interface Step {
  label: string
  always?: true
  batch: (
    tx: Tx,
    rules: Rules,
    circleId: string,
  ) => Promise<{ picked: number; counts: Partial<RetentionCounts> }>
}

const single =
  (kind: keyof RetentionCounts, run: (tx: Tx, rules: Rules) => Promise<number>): Step['batch'] =>
  async (tx, rules) => {
    const n = await run(tx, rules)
    return { picked: n, counts: { [kind]: n } }
  }

const STEPS: Step[] = [
  {
    label: '已删除的词条',
    batch: single('deletedEntries', (tx, r) => entryBatch(tx, r.deletedEntries)),
  },
  {
    label: '已被取代的事实',
    batch: single('supersededFacts', (tx, r) => entryBatch(tx, r.supersededFacts)),
  },
  {
    label: '过期的会话摘要',
    batch: single('expiredEpisodes', (tx, r) => entryBatch(tx, r.expiredEpisodes)),
  },
  { label: '词条已不存在的历史', always: true, batch: (tx) => orphanBatch(tx) },
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
    label: '整理的运行记录',
    batch: single('dreamRuns', (tx, r) => tableBatch(tx, dreamRuns, dreamRuns.id, r.dreamRuns)),
  },
  {
    label: '整理建议',
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
    label: '机密词条的访问记录',
    batch: single('accessEvents', (tx, r) =>
      tableBatch(tx, entryEvents, entryEvents.id, r.accessEvents),
    ),
  },
  {
    label: '已删除的凭据',
    batch: single('deletedCredentials', (tx, r) =>
      tableBatch(tx, credentials, credentials.id, r.deletedCredentials),
    ),
  },
  {
    label: '断开的密码库连接',
    batch: single('vaultConnections', (tx, r) =>
      tableBatch(tx, vaultConnections, vaultConnections.id, r.vaultConnections),
    ),
  },
  {
    label: '离开满期的成员',
    batch: departureBatch,
  },
  {
    label: '已处理的绑定记录',
    batch: single('subjectBindings', (tx, r) =>
      tableBatch(tx, subjectBindings, subjectBindings.id, r.subjectBindings),
    ),
  },
]

const emptyCounts = (): RetentionCounts => ({
  deletedEntries: 0,
  supersededFacts: 0,
  expiredEpisodes: 0,
  orphanEvents: 0,
  scrubbedSnapshots: 0,
  extractionRuns: 0,
  dreamRuns: 0,
  dreamSuggestions: 0,
  credentialEvents: 0,
  deletedCredentials: 0,
  subjectBindings: 0,
  accessEvents: 0,
  vaultConnections: 0,
  departedMembers: 0,
})

function addCounts(into: RetentionCounts, more: Partial<RetentionCounts>): RetentionCounts {
  for (const [kind, n] of Object.entries(more)) into[kind as keyof RetentionCounts] += n
  return into
}

export interface PurgeResult {
  counts: RetentionCounts
  errors: string[]
  complete: boolean
}

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
  for (const { id: circleId } of await db.select({ id: circles.id }).from(circles)) {
    for (const step of steps) {
      try {
        for (;;) {
          if (timeUp()) return { counts, errors, complete: false }
          started = true
          const done = await withCircle(db, circleId, (tx) => step.batch(tx, rules, circleId))
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

const errorRecord = (messages: string[], at: Date) => ({
  message: (messages.length > 1
    ? `${messages[0]}（另有 ${messages.length - 1} 处出错）`
    : messages[0]!
  ).slice(0, MAX_MESSAGE),
  at: at.toISOString(),
})

const utcDay = (iso: string) => iso.slice(0, 10)

export interface RetentionRun extends PurgeResult {
  paused: boolean
}

export async function retentionJob(
  db: Db,
  at?: Date,
  budgetMs = RETENTION_BUDGET_MS,
): Promise<RetentionRun | null> {
  const now = at ?? (await databaseNow(db))
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
      ? errorRecord(result.errors, now)
      : result.complete
        ? null
        : state.status.lastError,
  })
  return { ...result, paused }
}
