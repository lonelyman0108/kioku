import {
  DEFAULT_CROSS_MEMORY_INTERVAL_HOURS,
  DEFAULT_DREAM_INTERVAL_HOURS,
  DEFAULT_TIDY_INTERVAL_HOURS,
  DREAM_INTERVAL_HOURS_MAX,
  DreamRunParams,
  normalizeDreamRunParams,
  REASONING_EFFORTS,
  type DreamFailedItem,
  type DreamOutcome,
  type DreamProgress,
  type DreamRunSummary,
  type DreamState,
  type ModelEndpointConfig,
  type ModelEndpointInput,
  type QueuedDreamTask,
  type ReasoningEffort,
  type TaskReasoningEffort,
  type UpdateDreamSettingsInput,
} from '@kioku/contracts'
import { eq, inArray, sql } from 'drizzle-orm'

import { decryptSecret, encryptSecret, type Sealed } from '../crypto/envelope'
import { decryptionKey, encryptionKey, type MasterKey } from '../crypto/keyring'
import type { Db, Tx } from '../db/client'
import { settings } from '../db/schema'
import { MemoryError } from '../memory/errors'
import { clearReasoningFallbackCache } from './client'

export const EMBEDDING_SETTING_KEY = 'embedding'
export const CHAT_LLM_SETTING_KEY = 'chat_llm'
export const DREAM_STATE_SETTING_KEY = 'dream_state'
export const TIDY_CHECKED_SETTING_KEY = 'tidy_checked_versions'

const RECENT_RUNS_LIMIT = 20

export interface SealedJson {
  ciphertext: string
  wrappedKey: string
  keyId?: string | null
}

const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORTS)

export interface StoredModelEndpoint {
  baseUrl: string
  model: string
  enabled: boolean
  apiKey?: SealedJson | null
  reasoningEffort?: ReasoningEffort | undefined
  taskReasoningEffort?: TaskReasoningEffort | undefined
}

export interface ResolvedModelEndpoint {
  baseUrl: string
  model: string
  enabled: boolean
  apiKey: string | null
  reasoningEffort?: ReasoningEffort | undefined
  taskReasoningEffort?: TaskReasoningEffort | undefined
}

export interface StoredModeSchedule {
  enabled: boolean
  intervalHours: number
  lastRunAt: string | null
}

export interface StoredDreamState {
  enabled: boolean
  intervalHours: number
  configuredByUser?: boolean | undefined
  schedules: {
    standard: StoredModeSchedule
    crossMemory: StoredModeSchedule
    tidy: StoredModeSchedule
  }
  lastRunAt: string | null
  lastOutcome: DreamOutcome | null
  lastError: string | null
  recentRuns: DreamRunSummary[]
}

const DEFAULT_DREAM_STATE: StoredDreamState = {
  enabled: false,
  intervalHours: DEFAULT_DREAM_INTERVAL_HOURS,
  schedules: {
    standard: {
      enabled: false,
      intervalHours: DEFAULT_DREAM_INTERVAL_HOURS,
      lastRunAt: null,
    },
    crossMemory: {
      enabled: false,
      intervalHours: DEFAULT_CROSS_MEMORY_INTERVAL_HOURS,
      lastRunAt: null,
    },
    tidy: {
      enabled: false,
      intervalHours: DEFAULT_TIDY_INTERVAL_HOURS,
      lastRunAt: null,
    },
  },
  lastRunAt: null,
  lastOutcome: null,
  lastError: null,
  recentRuns: [],
}

export function modelSettingAad(key: string): string {
  return `settings:${key}`
}

function isSealedJson(value: unknown): value is SealedJson {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  return typeof rec.ciphertext === 'string' && typeof rec.wrappedKey === 'string'
}

export function toSealedBuffer(sealed: SealedJson): Sealed {
  return {
    ciphertext: Buffer.from(sealed.ciphertext, 'base64'),
    wrappedKey: Buffer.from(sealed.wrappedKey, 'base64'),
  }
}

export function fromSealedBuffer(sealed: Sealed, keyId: string): SealedJson {
  return {
    ciphertext: sealed.ciphertext.toString('base64'),
    wrappedKey: sealed.wrappedKey.toString('base64'),
    keyId,
  }
}

function sealApiKey(masterKey: MasterKey | null, plaintext: string, aad: string): SealedJson {
  if (!masterKey) {
    throw new MemoryError(400, '尚未配置 KIOKU_MASTER_KEY，无法加密保存模型 API Key')
  }
  const { key, id } = encryptionKey(masterKey)
  return fromSealedBuffer(encryptSecret(key, plaintext, aad), id)
}

function openApiKey(masterKey: MasterKey | null, sealed: SealedJson, aad: string): string {
  if (!masterKey) {
    throw new MemoryError(500, '缺少 KIOKU_MASTER_KEY，无法解密模型 API Key')
  }
  let key: Buffer
  try {
    key = decryptionKey(masterKey, sealed.keyId ?? null)
  } catch {
    throw new MemoryError(500, '无法识别加密该 API Key 的主密钥')
  }
  return decryptSecret(key, toSealedBuffer(sealed), aad)
}

function parseReasoningEffort(raw: unknown): ReasoningEffort | undefined {
  return typeof raw === 'string' && REASONING_EFFORT_SET.has(raw)
    ? (raw as ReasoningEffort)
    : undefined
}

function parseTaskReasoningEffort(raw: unknown): TaskReasoningEffort | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const fast = parseReasoningEffort(rec.fast)
  const organize = parseReasoningEffort(rec.organize)
  if (fast === undefined && organize === undefined) return undefined
  return {
    ...(fast !== undefined ? { fast } : {}),
    ...(organize !== undefined ? { organize } : {}),
  }
}

function parseStoredEndpoint(raw: unknown): StoredModelEndpoint | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.baseUrl !== 'string' || typeof r.model !== 'string') return null
  const reasoningEffort = parseReasoningEffort(r.reasoningEffort)
  const taskReasoningEffort = parseTaskReasoningEffort(r.taskReasoningEffort)
  return {
    baseUrl: r.baseUrl,
    model: r.model,
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    apiKey: isSealedJson(r.apiKey) ? r.apiKey : null,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(taskReasoningEffort !== undefined ? { taskReasoningEffort } : {}),
  }
}

export function toPublicModelEndpoint(
  stored: StoredModelEndpoint | null,
): ModelEndpointConfig | null {
  if (!stored) return null
  return {
    baseUrl: stored.baseUrl,
    model: stored.model,
    hasApiKey: Boolean(stored.apiKey),
    enabled: stored.enabled,
    ...(stored.reasoningEffort !== undefined ? { reasoningEffort: stored.reasoningEffort } : {}),
    ...(stored.taskReasoningEffort !== undefined
      ? { taskReasoningEffort: stored.taskReasoningEffort }
      : {}),
  }
}

export async function loadStoredModel(
  db: Db | Tx,
  key: typeof EMBEDDING_SETTING_KEY | typeof CHAT_LLM_SETTING_KEY,
): Promise<StoredModelEndpoint | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
  return parseStoredEndpoint(row?.value)
}

export async function loadResolvedModel(
  db: Db | Tx,
  masterKey: MasterKey | null,
  key: typeof EMBEDDING_SETTING_KEY | typeof CHAT_LLM_SETTING_KEY,
): Promise<ResolvedModelEndpoint | null> {
  const stored = await loadStoredModel(db, key)
  if (!stored || !stored.enabled) return null
  const apiKey = stored.apiKey ? openApiKey(masterKey, stored.apiKey, modelSettingAad(key)) : null
  return {
    baseUrl: stored.baseUrl,
    model: stored.model,
    enabled: stored.enabled,
    apiKey,
    ...(stored.reasoningEffort !== undefined ? { reasoningEffort: stored.reasoningEffort } : {}),
    ...(stored.taskReasoningEffort !== undefined
      ? { taskReasoningEffort: stored.taskReasoningEffort }
      : {}),
  }
}

export async function loadSavedModelApiKey(
  db: Db | Tx,
  masterKey: MasterKey | null,
  key: typeof EMBEDDING_SETTING_KEY | typeof CHAT_LLM_SETTING_KEY,
): Promise<string | null> {
  const stored = await loadStoredModel(db, key)
  if (!stored?.apiKey) return null
  return openApiKey(masterKey, stored.apiKey, modelSettingAad(key))
}

export async function saveModelEndpoint(
  db: Db | Tx,
  masterKey: MasterKey | null,
  key: typeof EMBEDDING_SETTING_KEY | typeof CHAT_LLM_SETTING_KEY,
  input: ModelEndpointInput | null,
): Promise<{ previous: StoredModelEndpoint | null; next: StoredModelEndpoint | null }> {
  const previous = await loadStoredModel(db, key)
  if (input === null) {
    await db.delete(settings).where(eq(settings.key, key))
    if (key === CHAT_LLM_SETTING_KEY) clearReasoningFallbackCache()
    return { previous, next: null }
  }

  let nextApiKey: SealedJson | null = previous?.apiKey ?? null
  if (input.apiKey !== undefined) {
    if (input.apiKey === null || input.apiKey === '') {
      nextApiKey = null
    } else {
      nextApiKey = sealApiKey(masterKey, input.apiKey, modelSettingAad(key))
    }
  }

  let nextReasoningEffort: ReasoningEffort | undefined
  let nextTaskReasoningEffort: TaskReasoningEffort | undefined
  if (key === CHAT_LLM_SETTING_KEY) {
    nextReasoningEffort =
      input.reasoningEffort !== undefined ? input.reasoningEffort : previous?.reasoningEffort
    if (input.taskReasoningEffort === null) {
      nextTaskReasoningEffort = undefined
    } else if (input.taskReasoningEffort !== undefined) {
      nextTaskReasoningEffort = parseTaskReasoningEffort(input.taskReasoningEffort)
    } else {
      nextTaskReasoningEffort = previous?.taskReasoningEffort
    }
  }

  const next: StoredModelEndpoint = {
    baseUrl: input.baseUrl,
    model: input.model,
    enabled: input.enabled,
    apiKey: nextApiKey,
    ...(nextReasoningEffort !== undefined ? { reasoningEffort: nextReasoningEffort } : {}),
    ...(nextTaskReasoningEffort !== undefined
      ? { taskReasoningEffort: nextTaskReasoningEffort }
      : {}),
  }

  await db
    .insert(settings)
    .values({ key, value: next, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: next, updatedAt: sql`now()` },
    })

  if (key === CHAT_LLM_SETTING_KEY) clearReasoningFallbackCache()

  return { previous, next }
}

export async function loadModelFlags(
  db: Db | Tx,
): Promise<{ hasEmbeddingModel: boolean; hasChatModel: boolean }> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [EMBEDDING_SETTING_KEY, CHAT_LLM_SETTING_KEY]))
  const emb = parseStoredEndpoint(rows.find((r) => r.key === EMBEDDING_SETTING_KEY)?.value)
  const chat = parseStoredEndpoint(rows.find((r) => r.key === CHAT_LLM_SETTING_KEY)?.value)
  return {
    hasEmbeddingModel: Boolean(emb?.enabled),
    hasChatModel: Boolean(chat?.enabled),
  }
}

// ---- Dream 配置与近期运行状态（统一保存在 settings.dream_state）----

function parseFailedItems(raw: unknown): DreamFailedItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: DreamFailedItem[] = []
  for (const item of raw) {
    if (out.length >= 50) break
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (
      typeof rec.shortId === 'string' &&
      typeof rec.title === 'string' &&
      typeof rec.kind === 'string' &&
      typeof rec.reason === 'string'
    ) {
      out.push({
        shortId: rec.shortId,
        title: rec.title,
        kind: rec.kind,
        reason: rec.reason,
      })
    }
  }
  return out
}

function parseDreamRunParams(raw: unknown): DreamRunParams | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const parsed = DreamRunParams.safeParse(raw)
  if (!parsed.success) return undefined
  return normalizeDreamRunParams(parsed.data)
}

function parseDreamRunSummary(raw: unknown): DreamRunSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (
    typeof r.id !== 'string' ||
    (r.trigger !== 'scheduled' && r.trigger !== 'manual') ||
    (r.outcome !== 'ok' &&
      r.outcome !== 'partial' &&
      r.outcome !== 'skipped' &&
      r.outcome !== 'cancelled' &&
      r.outcome !== 'failed') ||
    typeof r.considered !== 'number' ||
    typeof r.suggested !== 'number' ||
    typeof r.createdAt !== 'string'
  ) {
    return null
  }
  const failedItems = parseFailedItems(r.failedItems)
  const mode =
    r.mode === 'standard' || r.mode === 'tidy' || r.mode === 'cross_memory' ? r.mode : undefined
  const retriedCount =
    typeof r.retriedCount === 'number' && Number.isInteger(r.retriedCount) && r.retriedCount >= 0
      ? r.retriedCount
      : undefined
  const abortedReason =
    typeof r.abortedReason === 'string'
      ? r.abortedReason
      : r.abortedReason === null
        ? null
        : undefined
  const params = parseDreamRunParams(r.params)
  const retriedByRunId =
    typeof r.retriedByRunId === 'string' && r.retriedByRunId.trim()
      ? r.retriedByRunId.trim()
      : undefined
  return {
    id: r.id,
    trigger: r.trigger,
    ...(mode !== undefined ? { mode } : {}),
    outcome: r.outcome,
    considered: r.considered,
    suggested: r.suggested,
    error: typeof r.error === 'string' ? r.error : null,
    ...(failedItems !== undefined ? { failedItems } : {}),
    ...(retriedCount !== undefined ? { retriedCount } : {}),
    ...(abortedReason !== undefined ? { abortedReason } : {}),
    ...(params !== undefined ? { params } : {}),
    ...(retriedByRunId !== undefined ? { retriedByRunId } : {}),
    createdAt: r.createdAt,
  }
}

function parseIntervalHours(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1
    ? Math.min(DREAM_INTERVAL_HOURS_MAX, raw)
    : fallback
}

function parseModeSchedule(raw: unknown, fallback: StoredModeSchedule): StoredModeSchedule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback }
  const rec = raw as Record<string, unknown>
  return {
    enabled: typeof rec.enabled === 'boolean' ? rec.enabled : fallback.enabled,
    intervalHours: parseIntervalHours(rec.intervalHours, fallback.intervalHours),
    lastRunAt: typeof rec.lastRunAt === 'string' ? rec.lastRunAt : fallback.lastRunAt,
  }
}

function parseStoredDreamState(raw: unknown): StoredDreamState {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_DREAM_STATE,
      schedules: {
        standard: { ...DEFAULT_DREAM_STATE.schedules.standard },
        crossMemory: { ...DEFAULT_DREAM_STATE.schedules.crossMemory },
        tidy: { ...DEFAULT_DREAM_STATE.schedules.tidy },
      },
      recentRuns: [],
    }
  }
  const r = raw as Record<string, unknown>
  const enabled = typeof r.enabled === 'boolean' ? r.enabled : false
  const interval = parseIntervalHours(r.intervalHours, DEFAULT_DREAM_INTERVAL_HOURS)
  const lastRunAt = typeof r.lastRunAt === 'string' ? r.lastRunAt : null
  const recentRuns = Array.isArray(r.recentRuns)
    ? r.recentRuns
        .map(parseDreamRunSummary)
        .filter((x): x is DreamRunSummary => x !== null)
        .slice(0, RECENT_RUNS_LIMIT)
    : []
  const rawSchedules =
    r.schedules && typeof r.schedules === 'object' && !Array.isArray(r.schedules)
      ? (r.schedules as Record<string, unknown>)
      : null
  const standardSchedule = parseModeSchedule(rawSchedules?.standard, {
    enabled,
    intervalHours: interval,
    lastRunAt,
  })
  // 顶层 enabled/intervalHours 与 standard 定时保持严格一致，确保旧客户端读法兼容
  standardSchedule.enabled = enabled
  standardSchedule.intervalHours = interval
  const crossMemorySchedule = parseModeSchedule(rawSchedules?.crossMemory, {
    ...DEFAULT_DREAM_STATE.schedules.crossMemory,
  })
  const tidySchedule = parseModeSchedule(rawSchedules?.tidy, {
    ...DEFAULT_DREAM_STATE.schedules.tidy,
  })
  const configuredByUser = typeof r.configuredByUser === 'boolean' ? r.configuredByUser : undefined
  return {
    enabled,
    intervalHours: interval,
    ...(configuredByUser !== undefined ? { configuredByUser } : {}),
    schedules: {
      standard: standardSchedule,
      crossMemory: crossMemorySchedule,
      tidy: tidySchedule,
    },
    lastRunAt,
    lastOutcome:
      r.lastOutcome === 'ok' ||
      r.lastOutcome === 'partial' ||
      r.lastOutcome === 'skipped' ||
      r.lastOutcome === 'cancelled' ||
      r.lastOutcome === 'failed'
        ? r.lastOutcome
        : null,
    lastError: typeof r.lastError === 'string' ? r.lastError : null,
    recentRuns,
  }
}

// 判断首次启用对话模型时是否应联动开启默认增量整理（兼容老库无 configuredByUser 标记的既有配置）
export async function shouldAutoEnableDream(
  db: Db | Tx,
  hadPreviousChatLlm: boolean,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, DREAM_STATE_SETTING_KEY))
    .limit(1)
  if (!row) return true
  const stored = parseStoredDreamState(row.value)
  if (stored.configuredByUser === true) return false
  const hasNonDefaultSchedule =
    stored.enabled ||
    stored.intervalHours !== DEFAULT_DREAM_INTERVAL_HOURS ||
    stored.schedules.crossMemory.enabled ||
    stored.schedules.crossMemory.intervalHours !== DEFAULT_CROSS_MEMORY_INTERVAL_HOURS ||
    stored.schedules.tidy.enabled ||
    stored.schedules.tidy.intervalHours !== DEFAULT_TIDY_INTERVAL_HOURS
  if (hasNonDefaultSchedule || stored.lastRunAt !== null || stored.recentRuns.length > 0) {
    return false
  }
  // 老库若同时已有历史 chat_llm 与历史 dream_state 行，视为旧版已保存过定时整理设置，不覆写用户意愿
  return !hadPreviousChatLlm
}

export interface DreamRuntimeMeta {
  activeJobId?: string | null | undefined
  activeTask?: QueuedDreamTask | null | undefined
  queued?: QueuedDreamTask[] | undefined
  queueLimit?: number | undefined
}

export async function loadDreamState(
  db: Db | Tx,
  running = false,
  progress: DreamProgress | null = null,
  runtime?: DreamRuntimeMeta,
): Promise<DreamState> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, DREAM_STATE_SETTING_KEY))
    .limit(1)
  const stored = parseStoredDreamState(row?.value)
  return {
    enabled: stored.enabled,
    intervalHours: stored.intervalHours,
    schedules: stored.schedules,
    lastRunAt: stored.lastRunAt,
    lastOutcome: stored.lastOutcome,
    lastError: stored.lastError,
    recentRuns: stored.recentRuns,
    running,
    progress: running ? progress : null,
    ...(runtime?.activeJobId !== undefined ? { activeJobId: runtime.activeJobId } : {}),
    ...(runtime?.activeTask !== undefined ? { activeTask: runtime.activeTask } : {}),
    ...(runtime?.queued !== undefined ? { queued: runtime.queued } : {}),
    ...(runtime?.queueLimit !== undefined ? { queueLimit: runtime.queueLimit } : {}),
  }
}

export async function updateDreamConfig(
  db: Db | Tx,
  patch: UpdateDreamSettingsInput,
  options: { markConfiguredByUser?: boolean | undefined } = {},
): Promise<StoredDreamState> {
  const current = parseStoredDreamState(
    (await db.select().from(settings).where(eq(settings.key, DREAM_STATE_SETTING_KEY)).limit(1))[0]
      ?.value,
  )
  const nextEnabled = patch.enabled !== undefined ? patch.enabled : current.enabled
  const nextInterval =
    patch.intervalHours !== undefined ? patch.intervalHours : current.intervalHours
  const nextConfiguredByUser =
    options.markConfiguredByUser === false ? current.configuredByUser : true
  const next: StoredDreamState = {
    ...current,
    enabled: nextEnabled,
    intervalHours: nextInterval,
    ...(nextConfiguredByUser !== undefined ? { configuredByUser: nextConfiguredByUser } : {}),
    schedules: {
      standard: {
        ...current.schedules.standard,
        enabled: nextEnabled,
        intervalHours: nextInterval,
      },
      crossMemory: {
        ...current.schedules.crossMemory,
        ...(patch.crossMemory?.enabled !== undefined ? { enabled: patch.crossMemory.enabled } : {}),
        ...(patch.crossMemory?.intervalHours !== undefined
          ? { intervalHours: patch.crossMemory.intervalHours }
          : {}),
      },
      tidy: {
        ...current.schedules.tidy,
        ...(patch.tidy?.enabled !== undefined ? { enabled: patch.tidy.enabled } : {}),
        ...(patch.tidy?.intervalHours !== undefined
          ? { intervalHours: patch.tidy.intervalHours }
          : {}),
      },
    },
  }
  await db
    .insert(settings)
    .values({ key: DREAM_STATE_SETTING_KEY, value: next, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: next, updatedAt: sql`now()` },
    })
  return next
}

async function updateDreamStateRow(
  db: Db | Tx,
  mutate: (current: StoredDreamState) => StoredDreamState | null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    let [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, DREAM_STATE_SETTING_KEY))
      .for('update')
    if (!row) {
      await tx
        .insert(settings)
        .values({ key: DREAM_STATE_SETTING_KEY, value: DEFAULT_DREAM_STATE, updatedAt: sql`now()` })
        .onConflictDoNothing()
      ;[row] = await tx
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, DREAM_STATE_SETTING_KEY))
        .for('update')
    }
    const current = parseStoredDreamState(row?.value)
    const next = mutate(current)
    if (!next) return false
    await tx
      .update(settings)
      .set({ value: next, updatedAt: sql`now()` })
      .where(eq(settings.key, DREAM_STATE_SETTING_KEY))
    return true
  })
}

export async function recordDreamRun(
  db: Db | Tx,
  summary: DreamRunSummary,
  options: { preserveLastOutcome?: boolean | undefined } = {},
): Promise<void> {
  await updateDreamStateRow(db, (current) => {
    const runMode = summary.mode ?? 'standard'
    const nextSchedules = {
      standard: { ...current.schedules.standard },
      crossMemory: { ...current.schedules.crossMemory },
      tidy: { ...current.schedules.tidy },
    }
    if (summary.outcome !== 'cancelled') {
      if (runMode === 'cross_memory') {
        nextSchedules.crossMemory.lastRunAt = summary.createdAt
      } else if (runMode === 'tidy') {
        nextSchedules.tidy.lastRunAt = summary.createdAt
      } else {
        nextSchedules.standard.lastRunAt = summary.createdAt
      }
    }
    return {
      ...current,
      schedules: nextSchedules,
      lastRunAt: options.preserveLastOutcome
        ? (current.lastRunAt ?? summary.createdAt)
        : summary.createdAt,
      lastOutcome: options.preserveLastOutcome ? current.lastOutcome : summary.outcome,
      lastError: options.preserveLastOutcome ? current.lastError : summary.error,
      recentRuns: [summary, ...current.recentRuns].slice(0, RECENT_RUNS_LIMIT),
    }
  })
}

export async function markDreamRunRetried(
  db: Db | Tx,
  runId: string,
  retriedByRunId: string,
): Promise<boolean> {
  return updateDreamStateRow(db, (current) => {
    let matched = false
    const nextRuns = current.recentRuns.map((run) => {
      if (run.id !== runId) return run
      matched = true
      return { ...run, retriedByRunId }
    })
    if (!matched) return null
    return {
      ...current,
      recentRuns: nextRuns,
    }
  })
}

export interface TidyCheckedVersionTransition {
  id: string
  fromVersion: number
  toVersion: number
}

function parseTidyCheckedVersions(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) out[k] = v
  }
  return out
}

export function applyTidyCheckedVersionTransitions(
  current: Readonly<Record<string, number>>,
  transitions: readonly TidyCheckedVersionTransition[],
): { next: Record<string, number>; changed: boolean } {
  const next: Record<string, number> = { ...current }
  let changed = false
  for (const item of transitions) {
    if (
      !Number.isInteger(item.fromVersion) ||
      item.fromVersion < 1 ||
      !Number.isInteger(item.toVersion) ||
      item.toVersion <= item.fromVersion
    ) {
      continue
    }
    if (next[item.id] === item.fromVersion) {
      next[item.id] = item.toVersion
      changed = true
    }
  }
  return { next, changed }
}

export function applyTidyCheckedVersionMerge(
  current: Readonly<Record<string, number>>,
  updates: ReadonlyMap<string, number>,
  pruneIds?: ReadonlySet<string>,
): { next: Record<string, number>; changed: boolean } {
  const next: Record<string, number> = { ...current }
  let changed = false

  if (pruneIds) {
    for (const id of pruneIds) {
      const incoming = updates.get(id)
      if (incoming !== undefined && Number.isInteger(incoming) && incoming >= 1) continue
      if (Object.prototype.hasOwnProperty.call(next, id)) {
        delete next[id]
        changed = true
      }
    }
  }

  for (const [id, ver] of updates) {
    if (!Number.isInteger(ver) || ver < 1) continue
    const merged = Math.max(next[id] ?? 0, ver)
    if (next[id] !== merged) {
      next[id] = merged
      changed = true
    }
  }

  return { next, changed }
}

export async function loadTidyCheckedVersions(db: Db | Tx): Promise<Record<string, number>> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
    .limit(1)
  return parseTidyCheckedVersions(row?.value)
}

export async function saveTidyCheckedVersions(
  db: Db | Tx,
  versions: Record<string, number>,
): Promise<void> {
  await db
    .insert(settings)
    .values({ key: TIDY_CHECKED_SETTING_KEY, value: versions, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: versions, updatedAt: sql`now()` },
    })
}

// 在行锁保护下将批量规范新登记水位按单调最大值合并落库，并仅清理显式指定且不在本次更新集内的失效键
export async function mergeTidyCheckedVersions(
  db: Db | Tx,
  updates: ReadonlyMap<string, number>,
  pruneIds?: ReadonlySet<string>,
): Promise<void> {
  const validUpdates = new Map<string, number>()
  for (const [id, ver] of updates) {
    if (Number.isInteger(ver) && ver >= 1) {
      validUpdates.set(id, Math.max(validUpdates.get(id) ?? 0, ver))
    }
  }
  const hasPrunes = Boolean(pruneIds && pruneIds.size > 0)
  if (validUpdates.size === 0 && !hasPrunes) return

  await db.transaction(async (tx) => {
    let [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
      .for('update')
    if (!row) {
      if (validUpdates.size === 0) return
      await tx
        .insert(settings)
        .values({ key: TIDY_CHECKED_SETTING_KEY, value: {}, updatedAt: sql`now()` })
        .onConflictDoNothing()
      ;[row] = await tx
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
        .for('update')
    }
    const current = parseTidyCheckedVersions(row?.value)
    const { next, changed } = applyTidyCheckedVersionMerge(current, validUpdates, pruneIds)
    if (!changed) return
    await tx
      .update(settings)
      .set({ value: next, updatedAt: sql`now()` })
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
  })
}

// 幂等登记单条词条已完成规范检查的版本水位（单调递增，行锁避免并发覆盖）
export async function markTidyCheckedVersion(
  db: Db | Tx,
  entryId: string,
  version: number,
): Promise<void> {
  if (!Number.isInteger(version) || version < 1) return
  await db.transaction(async (tx) => {
    let [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
      .for('update')
    if (!row) {
      await tx
        .insert(settings)
        .values({ key: TIDY_CHECKED_SETTING_KEY, value: {}, updatedAt: sql`now()` })
        .onConflictDoNothing()
      ;[row] = await tx
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
        .for('update')
    }
    const versions = parseTidyCheckedVersions(row?.value)
    const nextVersion = Math.max(versions[entryId] ?? 0, version)
    if (versions[entryId] === nextVersion) return
    versions[entryId] = nextVersion
    await tx
      .update(settings)
      .set({ value: versions, updatedAt: sql`now()` })
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
  })
}

// 对纯派生维护或仅改元信息的版本递进顺延已登记的规范水位；无项命中时不写表
export async function carryForwardTidyCheckedVersions(
  db: Db | Tx,
  transitions: readonly TidyCheckedVersionTransition[],
): Promise<void> {
  const valid = transitions.filter(
    (item) =>
      Number.isInteger(item.fromVersion) &&
      item.fromVersion >= 1 &&
      Number.isInteger(item.toVersion) &&
      item.toVersion > item.fromVersion,
  )
  if (!valid.length) return

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
      .for('update')
    if (!row) return
    const current = parseTidyCheckedVersions(row.value)
    const { next, changed } = applyTidyCheckedVersionTransitions(current, valid)
    if (!changed) return
    await tx
      .update(settings)
      .set({ value: next, updatedAt: sql`now()` })
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
  })
}

// ---- 供主密钥启动校验与同步重封读取加密设置项 ----

export interface SealedSettingEntry {
  key: typeof EMBEDDING_SETTING_KEY | typeof CHAT_LLM_SETTING_KEY
  label: string
  aad: string
  sealed: Sealed
  keyId: string | null
}

const SEALED_MODEL_KEYS = [
  { key: EMBEDDING_SETTING_KEY, label: '嵌入模型 API Key' },
  { key: CHAT_LLM_SETTING_KEY, label: '对话模型 API Key' },
] as const

export async function listSealedModelSettings(db: Db): Promise<SealedSettingEntry[]> {
  const out: SealedSettingEntry[] = []
  for (const item of SEALED_MODEL_KEYS) {
    const stored = await loadStoredModel(db, item.key)
    if (!stored?.apiKey) continue
    out.push({
      key: item.key,
      label: item.label,
      aad: modelSettingAad(item.key),
      sealed: toSealedBuffer(stored.apiKey),
      keyId: stored.apiKey.keyId ?? null,
    })
  }
  return out
}

export async function updateSealedModelSetting(
  db: Db,
  key: typeof EMBEDDING_SETTING_KEY | typeof CHAT_LLM_SETTING_KEY,
  nextSealed: SealedJson,
): Promise<void> {
  const stored = await loadStoredModel(db, key)
  if (!stored) return
  await db
    .update(settings)
    .set({ value: { ...stored, apiKey: nextSealed }, updatedAt: sql`now()` })
    .where(eq(settings.key, key))
}
