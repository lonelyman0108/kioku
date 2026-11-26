import {
  DEFAULT_DREAM_INTERVAL_HOURS,
  type DreamOutcome,
  type DreamRunSummary,
  type DreamSettingsConfig,
  type DreamState,
  type ModelEndpointConfig,
  type ModelEndpointInput,
} from '@kioku/contracts'
import { eq, inArray, sql } from 'drizzle-orm'

import { decryptSecret, encryptSecret, type Sealed } from '../crypto/envelope'
import { decryptionKey, encryptionKey, type MasterKey } from '../crypto/keyring'
import type { Db, Tx } from '../db/client'
import { settings } from '../db/schema'
import { MemoryError } from '../memory/errors'

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

export interface StoredModelEndpoint {
  baseUrl: string
  model: string
  enabled: boolean
  apiKey?: SealedJson | null
}

export interface ResolvedModelEndpoint {
  baseUrl: string
  model: string
  enabled: boolean
  apiKey: string | null
}

export interface StoredDreamState {
  enabled: boolean
  intervalHours: number
  lastRunAt: string | null
  lastOutcome: DreamOutcome | null
  lastError: string | null
  recentRuns: DreamRunSummary[]
}

const DEFAULT_DREAM_STATE: StoredDreamState = {
  enabled: false,
  intervalHours: DEFAULT_DREAM_INTERVAL_HOURS,
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

function parseStoredEndpoint(raw: unknown): StoredModelEndpoint | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.baseUrl !== 'string' || typeof r.model !== 'string') return null
  return {
    baseUrl: r.baseUrl,
    model: r.model,
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    apiKey: isSealedJson(r.apiKey) ? r.apiKey : null,
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

  const next: StoredModelEndpoint = {
    baseUrl: input.baseUrl,
    model: input.model,
    enabled: input.enabled,
    apiKey: nextApiKey,
  }

  await db
    .insert(settings)
    .values({ key, value: next, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: next, updatedAt: sql`now()` },
    })

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

function parseStoredDreamState(raw: unknown): StoredDreamState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DREAM_STATE, recentRuns: [] }
  const r = raw as Record<string, unknown>
  const interval =
    typeof r.intervalHours === 'number' && Number.isInteger(r.intervalHours) && r.intervalHours >= 1
      ? Math.min(168, r.intervalHours)
      : DEFAULT_DREAM_INTERVAL_HOURS
  const recentRuns = Array.isArray(r.recentRuns)
    ? (r.recentRuns as DreamRunSummary[]).slice(0, RECENT_RUNS_LIMIT)
    : []
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : false,
    intervalHours: interval,
    lastRunAt: typeof r.lastRunAt === 'string' ? r.lastRunAt : null,
    lastOutcome:
      r.lastOutcome === 'ok' || r.lastOutcome === 'skipped' || r.lastOutcome === 'failed'
        ? r.lastOutcome
        : null,
    lastError: typeof r.lastError === 'string' ? r.lastError : null,
    recentRuns,
  }
}

export async function loadDreamState(db: Db | Tx, running = false): Promise<DreamState> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, DREAM_STATE_SETTING_KEY))
    .limit(1)
  return { ...parseStoredDreamState(row?.value), running }
}

export async function updateDreamConfig(
  db: Db | Tx,
  patch: {
    enabled?: DreamSettingsConfig['enabled'] | undefined
    intervalHours?: DreamSettingsConfig['intervalHours'] | undefined
  },
): Promise<StoredDreamState> {
  const current = parseStoredDreamState(
    (await db.select().from(settings).where(eq(settings.key, DREAM_STATE_SETTING_KEY)).limit(1))[0]
      ?.value,
  )
  const next: StoredDreamState = {
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.intervalHours !== undefined ? { intervalHours: patch.intervalHours } : {}),
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

export async function recordDreamRun(db: Db | Tx, summary: DreamRunSummary): Promise<void> {
  const current = parseStoredDreamState(
    (await db.select().from(settings).where(eq(settings.key, DREAM_STATE_SETTING_KEY)).limit(1))[0]
      ?.value,
  )
  const next: StoredDreamState = {
    ...current,
    lastRunAt: summary.createdAt,
    lastOutcome: summary.outcome,
    lastError: summary.error,
    recentRuns: [summary, ...current.recentRuns].slice(0, RECENT_RUNS_LIMIT),
  }
  await db
    .insert(settings)
    .values({ key: DREAM_STATE_SETTING_KEY, value: next, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: next, updatedAt: sql`now()` },
    })
}

export async function loadTidyCheckedVersions(db: Db | Tx): Promise<Record<string, number>> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
    .limit(1)
  const raw = row?.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) out[k] = v
  }
  return out
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
